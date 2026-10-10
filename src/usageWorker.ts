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
 * after the whole import; meanwhile it reads the history the import writes,
 * even when another window has started a new one.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parentPort, workerData } from 'worker_threads';

import { isTimeZone } from './usage/aggregate';
import { importUnderLease } from './usage/importer';
import { queryReport } from './usage/queries';
import { RANGE_KEYS, rangeUntil } from './usage/report';
import { PARSER_VERSION, sessionTranscripts } from './usage/transcripts';
import { HistoryFileError, createHistory, publishHistory, removeHistory, resolveHistory, type Pointer } from './usage/historyFiles';
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
const storeOptions = { busyTimeoutMs: knob(knobs.busyTimeoutMs, 5_000) };

interface Opened {
    /** The folder as the request named it. */
    folder: string;
    /** The history in it. */
    file: string;
    result: OpenResult;
    /** That file's device and inode when it was opened. */
    identity: string | undefined;
}

/** The history open now. */
let opened: Opened | undefined;
/** Imports reading into `opened` now: it is not switched for another under them. */
let holding = 0;
/** A corrupt history this worker set aside, until an answer has said so. */
let recovered: string | undefined;

/** The name of the history set aside, once. */
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
 * then the one in use is opened instead, unless an import is reading into
 * this one, which is switched once it is done. A corrupt history is left
 * where it is, and a new one started beside it under a name of its own.
 */
function storeAt(storeFile: string): OpenResult {
    const folder = path.dirname(storeFile);
    if (opened && holding > 0 && opened.folder === folder) {
        // Closed under the import, it would fail at its next file.
        return opened.result;
    }
    let history: ReturnType<typeof resolveHistory>;
    try {
        history = resolveHistory(folder);
    } catch (error) {
        if (error instanceof HistoryFileError) {
            // Which history is in use cannot be told: nothing is changed.
            return { status: 'failed', category: 'io' };
        }
        throw error;
    }
    if (opened && (opened.folder !== folder || opened.file !== history.file || identityOf(opened.file) !== opened.identity)) {
        closeOpened();
    }
    if (!opened) {
        opened = openHistory(folder, history.file, history.pointer);
    }
    const result = opened.result;
    // A failure is not kept: a store busy or briefly unreachable at the first
    // request would otherwise fail every request after it, and a corrupt
    // one is set aside at the next.
    if (result.status === 'failed' || result.status === 'corrupt') {
        opened = undefined;
    }
    return result;
}

/** Open the history in use, or start one when there is none or it is corrupt. */
function openHistory(folder: string, file: string | undefined, pointer: Pointer): Opened {
    if (!sqlite) {
        throw new Error('unreachable: checked by the caller');
    }
    if (file !== undefined) {
        const result = UsageStore.open(sqlite, file, storeOptions);
        if (result.status !== 'corrupt') {
            return { folder, file, result, identity: identityOf(file) };
        }
    }
    const corrupt = file === undefined ? undefined : path.basename(file);
    let started: string;
    try {
        started = createHistory(folder);
    } catch {
        // The folder cannot hold one: a file in its place, say.
        return { folder, file: folder, result: { status: 'failed', category: 'io' }, identity: undefined };
    }
    const result = UsageStore.open(sqlite, started, storeOptions);
    let used: string | undefined;
    if (result.status === 'ready') {
        if (corrupt) {
            // Named before it is published: every window that follows the pointer is told.
            mark(result.store, corrupt);
        }
        try {
            used = publishHistory(folder, started, pointer);
        } catch {
            used = undefined;
        }
    }
    if (used === started && result.status === 'ready') {
        recovered = corrupt;
        return { folder, file: started, result, identity: identityOf(started) };
    }
    // Not published: no window is pointed at it.
    if (result.status === 'ready' || result.status === 'read-only') {
        result.store.close();
    }
    removeHistory(started);
    if (used === undefined) {
        return { folder, file: started, result: { status: 'failed', category: result.status === 'failed' ? result.category : 'io' }, identity: undefined };
    }
    // Another window started one first: that one is the history.
    const theirs = UsageStore.open(sqlite, used, storeOptions);
    if (corrupt && theirs.status === 'ready') {
        mark(theirs.store, corrupt);
        recovered = corrupt;
    }
    return { folder, file: used, result: theirs, identity: identityOf(used) };
}

/** Name the corrupt history set aside in `store`. Only a notice: a store too busy to take it is used all the same. */
function mark(store: UsageStore, corrupt: string): void {
    try {
        store.markSetAside(corrupt);
    } catch {
        // This window is still told once, by `recovered`.
    }
}

function closeOpened(): void {
    if (opened?.result.status === 'ready' || opened?.result.status === 'read-only') {
        if (opened.result.status === 'ready') {
            finishClear(opened.result.store);
        }
        opened.result.store.close();
    }
    opened = undefined;
}

/**
 * Finish a Clear that another window's read held off, or that left a copy
 * another window had open: at every request and at the close, in whichever
 * window uses the history, until it is done. A failure here waits for the
 * next one; the request goes on.
 */
function finishClear(store: UsageStore): void {
    try {
        store.finishClear();
    } catch {
        // Busy, say: tried again at the next request.
    }
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
    if (result.status === 'ready') {
        finishClear(store);
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
            const summary = await holdingStore(() =>
                importUnderLease(store, request.roots, holderOf(request), { isCancelled, countCrashes: request.crashed === true, progress: beat }, paths),
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
                await holdingStore(() =>
                    importUnderLease(store, request.roots, holderOf(request), { isCancelled, countCrashes: request.crashed === true, progress: beat }, paths),
                );
            }
            reply({
                type: 'liveContext',
                id: request.id,
                latest: store.latestMainRequest(request.sessionId, rangeUntil(Date.now())) ?? null,
                compactions: store.sessionCompactions(request.sessionId, rangeUntil(Date.now())).slice(0, 20),
                ...takeRecovered(),
            });
            return;
        }
        case 'clear': {
            // What it cannot finish now is finished by a later request, here or in another window.
            const { settled, copiesLeft } = store.clear();
            // A copy this worker set aside is one the Clear removed.
            recovered = undefined;
            reply({ type: 'cleared', id: request.id, generation: store.generation(), settled, copiesLeft });
            return;
        }
    }
}

/** Run an import that reads into the open history, which no query switches meanwhile. */
async function holdingStore<T>(work: () => Promise<T>): Promise<T> {
    holding++;
    try {
        return await work();
    } finally {
        holding--;
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
