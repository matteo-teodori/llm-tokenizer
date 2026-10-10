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
    /**
     * With `paths`, only those transcripts: the ones a watcher reported
     * changed. `holder` names the window, so that a worker it restarts is
     * the same holder of the import lease as the one that died. `crashed`:
     * the window saw its last worker crash, so a read it left unfinished
     * counts as a crash of that file.
     */
    | { type: 'import'; id: number; storeFile: string; roots: string[]; paths?: string[]; holder?: string; crashed?: boolean }
    /** `workspaceFolders` null reports every project. */
    | { type: 'query'; id: number; storeFile: string; range: RangeKey; zone: string; workspaceFolders: string[] | null }
    /** Bring one session's main transcript up to date, then read its latest request and compactions. */
    | { type: 'liveContext'; id: number; storeFile: string; roots: string[]; sessionId: string; holder?: string; crashed?: boolean }
    | { type: 'clear'; id: number; storeFile: string }
    | { type: 'close'; id: number };

/**
 * Why the worker could not do what it was asked, as fixed strings.
 * `outdated`: a newer LLM Tokenizer, in another window, writes this history.
 */
export type UsageFailure = 'store-busy' | 'store-io' | 'store-read-only' | 'outdated' | 'import-failed' | 'bad-request' | 'unknown';

/**
 * `recovered`, on the first answer after it happened: the file a corrupt
 * history was moved to, its name only, before a new one was started. A
 * report's `aside` names the newest such file while one is there, so every
 * window, and every reload, says so until Clear removes it.
 */
export type UsageWorkerResponse =
    | { type: 'imported'; id: number; summary: ImportSummary; leaseHeldElsewhere: false; recovered?: string }
    | { type: 'imported'; id: number; summary: null; leaseHeldElsewhere: true; recovered?: string }
    | { type: 'report'; id: number; report: UsageReport; aside?: string; recovered?: string }
    /** `compactions` newest first, at most 20. */
    | { type: 'liveContext'; id: number; latest: LatestRequest | null; compactions: Compaction[]; recovered?: string }
    /**
     * `settled`: false while another window's read keeps what was deleted in
     * the file, until a later request finishes it; `copiesLeft`: copies set
     * aside that could not be removed.
     */
    | { type: 'cleared'; id: number; generation: number; settled: boolean; copiesLeft: number }
    | { type: 'closed'; id: number }
    /** This runtime has no `node:sqlite` binding. */
    | { type: 'unavailable'; id: number; node: string; electron: string | null }
    | { type: 'failed'; id: number; failure: UsageFailure; errorName: string }
    /**
     * Sent every few seconds while the worker works, with an id no request
     * has: the host gives up on a worker that sends nothing for two minutes,
     * and a first import can take longer than that.
     */
    | { type: 'progress'; id: 0 };
