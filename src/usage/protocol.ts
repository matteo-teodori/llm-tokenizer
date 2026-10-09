/**
 * The messages between the extension host and the usage worker.
 *
 * Only small aggregates cross: in platform M7 configuration 4, doing the
 * SQLite writes on the host thread stalled it for up to 132 ms. And nothing
 * derived from a record's bytes crosses as text: a failure is a category and
 * an error's `name`, never its message.
 */

import type { ImportSummary } from './importer';
import type { RangeKey, UsageReport } from './report';
import type { LatestRequest } from './store';
import type { Compaction } from './types';

export type UsageWorkerRequest =
    /** With `paths`, only those transcripts: the ones a watcher reported changed. */
    | { type: 'import'; id: number; storeFile: string; roots: string[]; paths?: string[] }
    /** `workspaceFolders` null reports every project. */
    | { type: 'query'; id: number; storeFile: string; range: RangeKey; zone: string; workspaceFolders: string[] | null }
    /** Bring one session's main transcript up to date, then read its latest request and compactions. */
    | { type: 'liveContext'; id: number; storeFile: string; roots: string[]; sessionId: string }
    | { type: 'clear'; id: number; storeFile: string }
    | { type: 'close'; id: number };

/** Why the worker could not do what it was asked, as fixed strings. */
export type UsageFailure = 'store-busy' | 'store-io' | 'store-read-only' | 'import-failed' | 'bad-request' | 'unknown';

export type UsageWorkerResponse =
    | { type: 'imported'; id: number; summary: ImportSummary; leaseHeldElsewhere: false }
    | { type: 'imported'; id: number; summary: null; leaseHeldElsewhere: true }
    | { type: 'report'; id: number; report: UsageReport }
    /** `compactions` newest first, at most 20. */
    | { type: 'liveContext'; id: number; latest: LatestRequest | null; compactions: Compaction[] }
    | { type: 'cleared'; id: number; generation: number }
    | { type: 'closed'; id: number }
    /** This runtime has no `node:sqlite` binding. */
    | { type: 'unavailable'; id: number; node: string; electron: string | null }
    | { type: 'failed'; id: number; failure: UsageFailure; errorName: string };
