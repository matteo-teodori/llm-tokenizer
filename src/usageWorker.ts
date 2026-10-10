/**
 * The usage worker: the only thread that touches the usage history or reads
 * Claude Code's session records.
 *
 * Built only from `node:` built-ins, so it inlines no package; `node:sqlite`
 * stays external and is required at run time, so a host without it still
 * loads the worker and is told why there is nothing to show.
 *
 * Imports, Clears and closes are handled one at a time, in order: an import
 * yields between files, and a Clear or a close handled in one of those yields
 * would have emptied or closed the store under it. Instead each cancels the
 * imports queued ahead of it, which stop at their next file. A query only
 * reads, so it is answered at once, between an import's files, rather than
 * after the whole import.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parentPort, workerData } from 'worker_threads';

import { isTimeZone } from './usage/aggregate';
import { importUnderLease } from './usage/importer';
import { queryReport } from './usage/queries';
import { RANGE_KEYS } from './usage/report';
import { PARSER_VERSION, sessionTranscripts } from './usage/transcripts';
import { currentHistory, startHistory } from './usage/historyFiles';
import { UsageStore, loadSqlite, type OpenResult } from './usage/store';
import { SESSION_ID, type UsageFailure, type UsageWorkerRequest, type UsageWorkerResponse } from './usage/protocol';

if (!parentPort) {
    throw new Error('usageWorker.ts must be run as a worker thread');
}
const port = parentPort;

/** More named paths than this are a full pass's job. */
const MAX_PATHS = 1000;


/** Holds the import lease when the window does not name itself; unique per thread. */
const ownHolder = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

function holderOf(request: { holder?: unknown }): string {
    return typeof request.holder === 'string' && request.holder.length > 0 && request.holder.length <= 100 ? request.holder : ownHolder;
}

/**
 * Timings a test may shorten, through the worker's `workerData`; the
 * extension passes none.
 */
const knobs = (workerData ?? {}) as { beatMs?: unknown; busyTimeoutMs?: unknown };
const knob = (value: unknown, fallback: number) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback);

const sqlite = loadSqlite();
/**
 * The history open now: `folder` as the request named it, `file` the
 * history in it, `identity` that file's device and inode when it was opened.
 */
let opened: { folder: string; file: string; result: OpenResult; identity: string | undefined } | undefined;
/** A history whose last Clear left pages another window's read held on to. */
let unsettled: string | undefined;
/** A corrupt history this worker set aside, until an answer has said so. */
let recovered: string | undefined;

/** The moved file's name, once. */
function takeRecovered(): { recovered?: string } {
    const name = recovered;
    recovered = undefined;
    return name ? { recovered: name } : {};
}

function reply(response: UsageWorkerResponse): void {
    port.postMessage(response);
}

/** The longest the worker goes without a word while it works. */
const BEAT_MS = knob(knobs.beatMs, 5_000);
let lastBeat = -BEAT_MS;

/** Tell the host this worker is still at work, at most every BEAT_MS. */
function beat(): void {
    const now = performance.now();
    if (now - lastBeat >= BEAT_MS) {
        lastBeat = now;
        reply({ type: 'progress', id: 0 });
    }
}

/** Which file is at `file` now: its device and inode, or undefined when there is none. */
function identityOf(file: string): string | undefined {
    try {
        const stat = fs.statSync(file, { bigint: true });
        return `${stat.dev}:${stat.ino}`;
    } catch {
        return undefined;
    }
}

/**
 * The history in the folder of `storeFile`, opened once and kept while it is
 * the one in use there. Another window may have started a new one, setting a
 * corrupt one aside, or the history may have been deleted under this worker,
 * as 2.1.2's Clear Downloaded Tokenizers deletes the extension's storage:
 * then the one in use is opened instead. A corrupt history is left where it
 * is, and a new one started beside it under a name of its own.
 */
function storeAt(storeFile: string): OpenResult {
    if (!sqlite) {
        throw new Error('unreachable: checked by the caller');
    }
    const folder = path.dirname(storeFile);
    const current = currentHistory(folder);
    if (opened && (opened.folder !== folder || opened.file !== current || identityOf(opened.file) !== opened.identity)) {
        closeOpened();
    }
    if (!opened) {
        const options = { busyTimeoutMs: knob(knobs.busyTimeoutMs, 5_000) };
        let file = current ?? startHistory(folder);
        let result = UsageStore.open(sqlite, file, options);
        if (result.status === 'corrupt') {
            const corrupt = path.basename(file);
            file = startHistory(folder);
            result = UsageStore.open(sqlite, file, options);
            if (result.status === 'ready') {
                result.store.markSetAside(corrupt);
                recovered = corrupt;
            }
        }
        opened = { folder, file, result, identity: identityOf(file) };
    }
    const result = opened.result;
    // A failure is not kept: a store busy or briefly unreachable at the first
    // request would otherwise fail every request after it.
    if (result.status === 'failed') {
        opened = undefined;
    }
    return result;
}

function closeOpened(): void {
    if (opened && opened.result.status !== 'failed' && opened.result.status !== 'corrupt') {
        if (unsettled === opened.file && opened.result.status === 'ready') {
            opened.result.store.checkpoint();
        }
        opened.result.store.close();
    }
    opened = undefined;
    unsettled = undefined;
}

function failure(result: OpenResult): UsageFailure {
    switch (result.status) {
        case 'failed':
            return result.category === 'busy' ? 'store-busy' : 'store-io';
        case 'read-only':
            return 'store-read-only';
        default:
            // Corrupt twice over, the new history too: nothing to read from.
            return 'store-io';
    }
}

async function handle(request: UsageWorkerRequest, isCancelled: () => boolean): Promise<void> {
    if (request.type === 'close') {
        closeOpened();
        reply({ type: 'closed', id: request.id });
        return;
    }
    if (!sqlite) {
        reply({ type: 'unavailable', id: request.id, node: process.versions.node, electron: process.versions.electron ?? null });
        return;
    }

    const result = storeAt(request.storeFile);
    // A history a newer version created can still be read.
    const readable = result.status === 'ready' || (result.status === 'read-only' && (request.type === 'query' || request.type === 'liveContext'));
    if (!readable) {
        reply({ type: 'failed', id: request.id, failure: failure(result), errorName: 'StoreError' });
        return;
    }
    const store = result.store;
    // A Clear's checkpoint another window held off, tried again until done.
    if (unsettled === request.storeFile && result.status === 'ready' && store.checkpoint()) {
        unsettled = undefined;
    }

    switch (request.type) {
        case 'query': {
            if (!RANGE_KEYS.includes(request.range) || !isTimeZone(request.zone)) {
                reply({ type: 'failed', id: request.id, failure: 'bad-request', errorName: 'RangeError' });
                return;
            }
            const report = queryReport(store, {
                range: request.range,
                zone: request.zone,
                workspaceFolders: request.workspaceFolders,
                now: Date.now(),
                platform: process.platform,
            });
            reply({ type: 'report', id: request.id, report, aside: store.setAside(), ...takeRecovered() });
            return;
        }
        case 'import': {
            const paths = request.paths;
            if (paths !== undefined && !(Array.isArray(paths) && paths.length <= MAX_PATHS && paths.every(p => typeof p === 'string' && p.length <= 4096))) {
                reply({ type: 'failed', id: request.id, failure: 'bad-request', errorName: 'RangeError' });
                return;
            }
            if (store.outdated(PARSER_VERSION)) {
                reply({ type: 'failed', id: request.id, failure: 'outdated', errorName: 'StoreError' });
                return;
            }
            const summary = await importUnderLease(
                store,
                request.roots,
                holderOf(request),
                { isCancelled, countCrashes: request.crashed === true, progress: beat },
                paths,
            );
            reply(
                summary
                    ? { type: 'imported', id: request.id, summary, leaseHeldElsewhere: false, ...takeRecovered() }
                    : { type: 'imported', id: request.id, summary: null, leaseHeldElsewhere: true, ...takeRecovered() },
            );
            return;
        }
        case 'liveContext': {
            if (typeof request.sessionId !== 'string' || !SESSION_ID.test(request.sessionId)) {
                reply({ type: 'failed', id: request.id, failure: 'bad-request', errorName: 'RangeError' });
                return;
            }
            const paths = request.roots.flatMap(root => sessionTranscripts(root, request.sessionId));
            // A read-only history is read as it is.
            if (paths.length > 0 && result.status === 'ready' && !store.outdated(PARSER_VERSION)) {
                // Null when another window holds the lease: what is stored is read all the same.
                await importUnderLease(store, request.roots, holderOf(request), { isCancelled, countCrashes: request.crashed === true, progress: beat }, paths);
            }
            reply({
                type: 'liveContext',
                id: request.id,
                latest: store.latestMainRequest(request.sessionId) ?? null,
                compactions: store.sessionCompactions(request.sessionId).slice(0, 20),
                ...takeRecovered(),
            });
            return;
        }
        case 'clear': {
            const { settled, copiesLeft } = store.clear();
            unsettled = settled ? undefined : request.storeFile;
            // A copy this worker set aside is one the Clear removed.
            recovered = undefined;
            reply({ type: 'cleared', id: request.id, generation: store.generation(), settled, copiesLeft });
            return;
        }
    }
}

let queue = Promise.resolve();
let received = 0;
/** Imports received before this one are cancelled. */
let cancelBefore = 0;

port.on('message', (request: UsageWorkerRequest) => {
    const sequence = ++received;
    if (request.type === 'clear' || request.type === 'close') {
        cancelBefore = sequence;
    }
    const run = () =>
        handle(request, () => sequence < cancelBefore).catch((error: unknown) => {
            // The name only: a message from anything that touched a record
            // could quote its bytes.
            reply({
                type: 'failed',
                id: request.id,
                failure: request.type === 'import' ? 'import-failed' : 'unknown',
                errorName: error instanceof Error ? error.name : 'Error',
            });
        });
    if (request.type === 'query') {
        void run();
    } else {
        queue = queue.then(run);
    }
});
