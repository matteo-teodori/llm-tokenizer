/**
 * One import pass: every transcript under the given roots, read from its
 * checkpoint into the store.
 *
 * Each file is deduplicated in memory with the comparator before it is
 * written, about 100 files go in each transaction, and every checkpoint is
 * written in the same transaction as the rows it covers, so a crash or a
 * cancel at any point leaves the store as if the pass had stopped at a file
 * boundary; the next pass carries on from there. The pass is idempotent:
 * running it twice changes nothing, and an unchanged file is never opened.
 *
 * Measured on the stand-in schema, platform M7 configuration 3: a full
 * import of about 4 GB in 6.49 s on Node 22.19, with 100 files a transaction
 * and a yield every 50 files.
 */

import * as fs from 'fs';

import { dedupe } from './accounting';
import {
    LARGE_FILE_BYTES,
    PARSER_VERSION,
    fileState,
    isUnchanged,
    readTranscript,
    walkProjects,
    type FileState,
    type MalformedCategory,
    type ReadResult,
    type TranscriptFile,
} from './transcripts';
import type { FileCheckpoint, ReadGuard, UsageStore } from './store';
import type { SessionSighting } from './types';

const PROVIDER = 'claude-code';

/** Why a file was not read this pass. */
export type SkipReason = 'missing' | 'unreadable' | 'busy' | 'crashed' | 'error';

export interface ImportSummary {
    roots: number;
    files: number;
    read: number;
    unchanged: number;
    restarted: number;
    /** Records written, before the store's upsert decided which to keep. */
    records: number;
    skipped: Partial<Record<SkipReason, number>>;
    malformed: Partial<Record<MalformedCategory, number>>;
    oversizeLines: number;
    synthetic: number;
    apiErrors: number;
    symlinkedFolders: number;
    unreadableFolders: number;
    journals: number;
    /** Projects folders missing under a root. */
    missingProjects: number;
    cancelled: boolean;
    elapsedMs: number;
}

export interface ImportOptions {
    filesPerTransaction?: number;
    /** Files between yields, so the worker can take a cancel. */
    filesPerYield?: number;
    pause?: () => Promise<void>;
    isCancelled?: () => boolean;
    /** Files over this are guarded while read (tests). */
    largeFileBytes?: number;
    /** The wall clock, for when a crash was counted. */
    now?: () => number;
}

/**
 * After this many crashes while reading the same large file, it is skipped
 * for CRASH_RETRY_MS, then read once more. Never for good: Claude Code deletes
 * its records after 30 days, and a file still skipped then would be lost.
 */
const MAX_FILE_CRASHES = 2;
const CRASH_RETRY_MS = 24 * 60 * 60 * 1000;

const yieldToEvents = () => new Promise<void>(resolve => setImmediate(resolve));

export async function importRoots(store: UsageStore, roots: string[], options: ImportOptions = {}): Promise<ImportSummary> {
    const started = performance.now();
    const filesPerTransaction = options.filesPerTransaction ?? 100;
    const filesPerYield = options.filesPerYield ?? 50;
    const pause = options.pause ?? yieldToEvents;
    const largeFileBytes = options.largeFileBytes ?? LARGE_FILE_BYTES;
    const now = options.now ?? Date.now;
    const summary: ImportSummary = {
        roots: roots.length,
        files: 0,
        read: 0,
        unchanged: 0,
        restarted: 0,
        records: 0,
        skipped: {},
        malformed: {},
        oversizeLines: 0,
        synthetic: 0,
        apiErrors: 0,
        symlinkedFolders: 0,
        unreadableFolders: 0,
        journals: 0,
        missingProjects: 0,
        cancelled: false,
        elapsedMs: 0,
    };

    let batch: { file: TranscriptFile; result: ReadResult; previous: FileCheckpoint | undefined; guarded: boolean }[] = [];
    const flush = () => {
        if (batch.length === 0) {
            return;
        }
        const pending = batch;
        batch = [];
        store.transaction(() => {
            for (const { file, result, previous, guarded } of pending) {
                write(store, file, result, previous);
                if (guarded) {
                    store.deleteReadGuard(PROVIDER, file.path);
                }
            }
        });
    };

    let sinceYield = 0;
    for (const root of roots) {
        const walk = walkProjects(root);
        if (walk.projects === null) {
            summary.missingProjects++;
            continue;
        }
        summary.symlinkedFolders += walk.symlinkedFolders;
        summary.unreadableFolders += walk.unreadableFolders;
        summary.journals += walk.journals;

        // A fixed order, so that equal records always resolve the same way.
        const files = [...walk.files].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
        for (const file of files) {
            if (options.isCancelled?.()) {
                summary.cancelled = true;
                break;
            }
            summary.files++;
            const previous = store.getFile(PROVIDER, file.path);

            let state: FileState;
            try {
                state = fileState(fs.statSync(file.path, { bigint: true }));
            } catch (error) {
                increment(summary.skipped, skipReason(error));
                continue;
            }
            if (isUnchanged(previous, state)) {
                summary.unchanged++;
                continue;
            }

            let guard: ReadGuard | undefined;
            if (state.size > largeFileBytes) {
                flush();
                guard = guardRead(store, file.path, now());
                if (!guard) {
                    increment(summary.skipped, 'crashed');
                    continue;
                }
            }

            let result: ReadResult;
            try {
                result = readTranscript(file, previous);
            } catch (error) {
                if (guard) {
                    // A failure the reader caught is not a crash.
                    settleGuard(store, guard);
                }
                increment(summary.skipped, skipReason(error));
                continue;
            }
            if (result.unchanged) {
                if (guard) {
                    settleGuard(store, guard);
                }
                summary.unchanged++;
                continue;
            }

            summary.read++;
            if (result.restarted !== null && result.restarted !== 'new') {
                summary.restarted++;
            }
            summary.records += result.requests.length;
            summary.oversizeLines += result.oversize;
            summary.synthetic += result.synthetic;
            summary.apiErrors += result.apiErrors;
            for (const [category, n] of result.malformed) {
                summary.malformed[category] = (summary.malformed[category] ?? 0) + n;
            }

            batch.push({ file, result, previous, guarded: guard !== undefined });
            // A guarded read is written at once, so that a crash in a later
            // file is never blamed on it.
            if (guard || batch.length >= filesPerTransaction) {
                flush();
            }
            if (++sinceYield >= filesPerYield) {
                sinceYield = 0;
                flush();
                await pause();
            }
        }
        if (summary.cancelled) {
            break;
        }
    }
    flush();

    summary.elapsedMs = Math.round(performance.now() - started);
    return summary;
}

/**
 * One pass under the import lease: none at all while another window holds it,
 * and a stop at the next yield if it is lost, renewing it at every yield,
 * since a first import can outlast LEASE_TAKEOVER_MS.
 *
 * @returns null when another window holds the lease.
 */
export async function importUnderLease(
    store: UsageStore,
    roots: string[],
    holder: string,
    options: ImportOptions = {},
): Promise<ImportSummary | null> {
    if (!store.acquireLease('import', holder, PARSER_VERSION)) {
        return null;
    }
    const pause = options.pause ?? yieldToEvents;
    let lost = false;
    return importRoots(store, roots, {
        ...options,
        pause: async () => {
            await pause();
            lost ||= !store.acquireLease('import', holder, PARSER_VERSION);
        },
        isCancelled: () => lost || (options.isCancelled?.() ?? false),
    });
}

/**
 * Before a large file is read: its guard, committed so that a crash during
 * the read is counted by the next pass, or undefined to skip the file.
 */
function guardRead(store: UsageStore, filePath: string, now: number): ReadGuard | undefined {
    const previous = store.getReadGuard(PROVIDER, filePath);
    // A read that never finished counts as a crash of this file.
    const crashed = previous?.inProgress === true;
    const guard: ReadGuard = {
        provider: PROVIDER,
        path: filePath,
        inProgress: true,
        crashCount: (previous?.crashCount ?? 0) + (crashed ? 1 : 0),
        lastCrash: crashed ? now : (previous?.lastCrash ?? null),
    };
    if (guard.crashCount >= MAX_FILE_CRASHES && guard.lastCrash !== null && now - guard.lastCrash < CRASH_RETRY_MS) {
        if (crashed) {
            settleGuard(store, guard);
        }
        return undefined;
    }
    store.transaction(() => store.putReadGuard(guard));
    return guard;
}

/** Record that a guarded read ended without crashing, keeping its count. */
function settleGuard(store: UsageStore, guard: ReadGuard): void {
    store.transaction(() =>
        guard.crashCount === 0
            ? store.deleteReadGuard(PROVIDER, guard.path)
            : store.putReadGuard({ ...guard, inProgress: false }),
    );
}

/** One file's rows, sightings and checkpoint. Runs inside the batch's transaction. */
function write(store: UsageStore, file: TranscriptFile, result: ReadResult, previous: FileCheckpoint | undefined): void {
    // A newer parser re-reads the file whole: its old rows go first, so a
    // change of key cannot leave doubles behind.
    if (result.restarted === 'parser') {
        store.deleteRequestsFromFile(PROVIDER, file.path);
    }
    const requests = [...dedupe(result.requests).values()];
    store.upsertRequests(requests);
    store.insertCompactions(PROVIDER, result.compactions);
    store.insertLimitHits(PROVIDER, result.limitHits);

    // Every session the file's requests name is sighted, not only the file's
    // own: a resumed or forked transcript can hold records copied from an
    // earlier session, and each request needs its session's row.
    const sessionId = file.sessionId ?? result.sessionId;
    const spans = new Map<string, { firstTs: number | null; lastTs: number | null }>();
    if (sessionId) {
        spans.set(sessionId, { firstTs: null, lastTs: null });
    }
    for (const r of requests) {
        const span = spans.get(r.sessionId) ?? { firstTs: null, lastTs: null };
        spans.set(r.sessionId, {
            firstTs: span.firstTs === null ? r.timestamp : Math.min(span.firstTs, r.timestamp),
            lastTs: span.lastTs === null ? r.timestamp : Math.max(span.lastTs, r.timestamp),
        });
    }
    for (const [id, span] of spans) {
        // The cwd is the file's own session's, and only a main transcript
        // says where a session started.
        const own = id === sessionId && file.kind === 'main';
        const sighting: SessionSighting = {
            sessionId: id,
            root: file.root,
            cwd: own ? result.firstCwd : null,
            cwdTs: own ? result.firstCwdTs : null,
            projectDir: file.projectDir,
            ...span,
        };
        store.upsertSession(PROVIDER, sighting);
    }

    // Restarted reads count their lines afresh; a continued read adds to them.
    const carried = result.restarted === null && previous ? previous : undefined;
    let malformed = 0;
    for (const [category, n] of result.malformed) {
        if (category !== 'oversize') {
            malformed += n;
        }
    }
    store.putFile({
        provider: PROVIDER,
        path: file.path,
        root: file.root,
        kind: file.kind,
        sessionId,
        runId: file.runId,
        agentId: file.agentId,
        projectDir: file.projectDir,
        dev: result.checkpoint.dev,
        ino: result.checkpoint.ino,
        size: result.checkpoint.size,
        mtimeMs: result.checkpoint.mtimeMs,
        offset: result.checkpoint.offset,
        tailHash: result.checkpoint.tailHash,
        parserVersion: PARSER_VERSION,
        oversizeLines: (carried?.oversizeLines ?? 0) + result.oversize,
        malformedLines: (carried?.malformedLines ?? 0) + malformed,
        newestVersion: result.newestVersion ?? carried?.newestVersion ?? null,
    });
}

function skipReason(error: unknown): SkipReason {
    switch ((error as NodeJS.ErrnoException | null)?.code) {
        case 'ENOENT':
            return 'missing';
        case 'EACCES':
        case 'EPERM':
            return 'unreadable';
        case 'EBUSY':
            return 'busy';
        default:
            return 'error';
    }
}

function increment<K extends string>(counts: Partial<Record<K, number>>, key: K): void {
    counts[key] = (counts[key] ?? 0) + 1;
}
