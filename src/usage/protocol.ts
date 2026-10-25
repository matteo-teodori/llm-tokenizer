/**
 * The messages between the extension host and the usage worker.
 *
 * Only small aggregates cross: in platform M7 configuration 4, doing the
 * SQLite writes on the host thread stalled it for up to 132 ms. And nothing
 * derived from a record's bytes crosses as text: a failure is a category, an
 * error's `name` and, when SQLite raised it, SQLite's result code and its
 * fixed text for that code, never the error's message.
 */

import type { ImportSummary } from './importer';
import type { RangeKey, UsageReport } from './report';
import type { LatestRequest } from './store';
import type { Compaction } from './types';

/** A session id becomes part of a file name, so only what Claude Code's ids are made of. */
export const SESSION_ID = /^[A-Za-z0-9_-]{1,200}$/;

export type UsageWorkerRequest =
    /**
     * With `paths`, only those transcripts: the ones a watcher reported
     * changed. `holder` names the window, so that a worker it restarts is
     * the same holder of the import lease as the one that died. `crashed`:
     * the window saw its last worker crash, so a read it left unfinished
     * counts as a crash of that file.
     */
    | { type: 'import'; id: number; storeFile: string; roots: string[]; paths?: string[]; holder?: string; crashed?: boolean }
    /**
     * `workspaceFolders` null reports every project. `progress`: with how
     * many files the running pass has to go through, which takes a walk of
     * every root; asked only once the page says how far a pass has gone.
     */
    | { type: 'query'; id: number; storeFile: string; range: RangeKey; zone: string; workspaceFolders: string[] | null; progress?: boolean }
    /** Bring one session's main transcript up to date, then read its latest request and compactions. */
    | { type: 'liveContext'; id: number; storeFile: string; roots: string[]; sessionId: string; holder?: string; crashed?: boolean }
    | { type: 'clear'; id: number; storeFile: string }
    | { type: 'close'; id: number };

/**
 * Why the worker could not do what it was asked, as fixed strings.
 * `outdated`: a newer LLM Tokenizer, in another window, writes this history.
 */
export type UsageFailure = 'store-busy' | 'store-io' | 'store-read-only' | 'outdated' | 'import-failed' | 'bad-request' | 'unknown';

/** How far a pass has gone: the files it has gone through, of how many when that was asked for. */
export interface ImportProgress {
    files: number;
    of?: number;
}

/**
 * The result code of a failure SQLite raised, extended, and SQLite's own
 * text for that code ("database is locked"), which depends on the code
 * alone: never the error's message, which can name what a statement held.
 */
export interface SqliteResult {
    code: number;
    text?: string;
}

/**
 * `recovered`, on the first answer after it happened: the name of a corrupt
 * history this worker set aside, left where it was, when it started a new
 * one. A report's `aside` names the one set aside while its file is there,
 * so every window, and every reload, says so until Clear removes it. Its
 * `reading`, while this worker's own pass runs, says how far that has gone:
 * the report holds only what the pass has read so far.
 */
export type UsageWorkerResponse =
    | { type: 'imported'; id: number; summary: ImportSummary; leaseHeldElsewhere: false; recovered?: string }
    | { type: 'imported'; id: number; summary: null; leaseHeldElsewhere: true; recovered?: string }
    | { type: 'report'; id: number; report: UsageReport; aside?: string; recovered?: string; reading?: ImportProgress }
    /** `compactions` newest first, at most 20. */
    | { type: 'liveContext'; id: number; latest: LatestRequest | null; compactions: Compaction[]; recovered?: string }
    /**
     * `settled`: false while another window's read keeps what was deleted in
     * the file; `copiesLeft`: copies of the history not removed yet. Either
     * is finished by a later request, in whichever window uses the history.
     */
    | { type: 'cleared'; id: number; generation: number; settled: boolean; copiesLeft: number }
    | { type: 'closed'; id: number }
    /** This runtime has no `node:sqlite` binding. */
    | { type: 'unavailable'; id: number; node: string; electron: string | null }
    | { type: 'failed'; id: number; failure: UsageFailure; errorName: string; sqlite?: SqliteResult }
    /**
     * Sent every few seconds while the worker works, with an id no request
     * has: the host gives up on a worker that sends nothing for two minutes,
     * and a first import can take longer than that.
     */
    | { type: 'progress'; id: 0 };
