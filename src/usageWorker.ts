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

import { parentPort } from 'worker_threads';

import { isTimeZone } from './usage/aggregate';
import { importUnderLease } from './usage/importer';
import { queryReport } from './usage/queries';
import { RANGE_KEYS } from './usage/report';
import { UsageStore, loadSqlite, type OpenResult } from './usage/store';
import type { UsageFailure, UsageWorkerRequest, UsageWorkerResponse } from './usage/protocol';

if (!parentPort) {
    throw new Error('usageWorker.ts must be run as a worker thread');
}
const port = parentPort;

/** Identifies this worker in the import lease, unique per thread. */
const holder = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const sqlite = loadSqlite();
let opened: { file: string; result: OpenResult } | undefined;

function reply(response: UsageWorkerResponse): void {
    port.postMessage(response);
}

/** The store at `file`, opened once and kept for the worker's lifetime. */
function storeAt(file: string): OpenResult {
    if (!sqlite) {
        throw new Error('unreachable: checked by the caller');
    }
    if (opened?.file !== file) {
        if (opened && opened.result.status !== 'failed') {
            opened.result.store.close();
        }
        opened = { file, result: UsageStore.open(sqlite, file) };
    }
    return opened.result;
}

function failure(result: OpenResult): UsageFailure {
    return result.status === 'failed' ? (result.category === 'busy' ? 'store-busy' : 'store-io') : 'store-read-only';
}

async function handle(request: UsageWorkerRequest, isCancelled: () => boolean): Promise<void> {
    if (request.type === 'close') {
        if (opened && opened.result.status !== 'failed') {
            opened.result.store.close();
        }
        opened = undefined;
        reply({ type: 'closed', id: request.id });
        return;
    }
    if (!sqlite) {
        reply({ type: 'unavailable', id: request.id, node: process.versions.node, electron: process.versions.electron ?? null });
        return;
    }

    const result = storeAt(request.storeFile);
    // A history a newer version created can still be read.
    const readable = result.status === 'ready' || (result.status === 'read-only' && request.type === 'query');
    if (!readable) {
        reply({ type: 'failed', id: request.id, failure: failure(result), errorName: 'StoreError' });
        return;
    }
    const store = result.store;

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
            reply({ type: 'report', id: request.id, report });
            return;
        }
        case 'import': {
            const summary = await importUnderLease(store, request.roots, holder, { isCancelled });
            reply(
                summary
                    ? { type: 'imported', id: request.id, summary, leaseHeldElsewhere: false }
                    : { type: 'imported', id: request.id, summary: null, leaseHeldElsewhere: true },
            );
            return;
        }
        case 'clear':
            store.clear();
            reply({ type: 'cleared', id: request.id, generation: store.generation() });
            return;
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
