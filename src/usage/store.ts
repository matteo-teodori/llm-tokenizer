/**
 * The usage history: one SQLite database, through `node:sqlite`, owned by the
 * usage worker.
 *
 * It is the only long-term copy of the history: Claude Code deletes its own
 * session records after `cleanupPeriodDays` (30 by default), so nothing here
 * may be treated as a cache that can be thrown away and rebuilt. Hence
 * forward-only migrations with a backup before each, a read-only mode for a
 * database a newer version created, and, for a corrupt file, a rename rather
 * than a delete.
 *
 * Measured, on the stand-in schema: a full import of about 4 GB of records in
 * 6.49 s on the engines floor's runtime, a 9.5 MB database for about 133,000
 * requests, a day-by-model GROUP BY in 65 ms.
 *
 * Only the API of Node 22.19, the floor's runtime, is used: no `limits`,
 * `serialize`, `createTagStore`, `enableDefensive` or `setAuthorizer`.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';

import { BUCKET_MS } from './aggregate';
import { copiesBeside } from './historyFiles';
import { isComplete } from './provenance';
import type {
    BucketSums,
    Compaction,
    LimitHit,
    SessionSighting,
    StoreCoverage,
    TranscriptKind,
    UsageProvider,
    UsageRequest,
} from './types';

/** `PRAGMA user_version` of the schema this code writes. */
export const SCHEMA_VERSION = 1;

/** How old a lease's heartbeat must be before another window may take it. */
export const LEASE_TAKEOVER_MS = 20_000;

type Sqlite = typeof import('node:sqlite');

/** SQLite's primary result codes this module tells apart. */
const SQLITE_BUSY = 5;
const SQLITE_READONLY = 8;
const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;

/**
 * `node:sqlite`, or undefined when this runtime has no binding for it.
 *
 * Required here, never at the top level of a bundle: esbuild leaves it
 * external, and a host without it would fail to load the whole worker.
 */
export function loadSqlite(): Sqlite | undefined {
    installSqliteWarningFilter();
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return require('node:sqlite') as Sqlite;
    } catch {
        return undefined;
    }
}

let filtering = false;

/**
 * Drop the ExperimentalWarning that `node:sqlite` emits on Node 22, once per
 * worker, and nothing else: on the floor's runtime three sequential workers
 * printed it three times.
 */
export function installSqliteWarningFilter(): void {
    if (filtering) {
        return;
    }
    filtering = true;
    const emit = process.emitWarning.bind(process) as (...args: unknown[]) => void;
    process.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
        const type = typeof rest[0] === 'string' ? rest[0] : (rest[0] as { type?: string } | undefined)?.type;
        const name = warning instanceof Error ? warning.name : type;
        const text = warning instanceof Error ? warning.message : String(warning);
        if (name === 'ExperimentalWarning' && /sqlite/i.test(text)) {
            return;
        }
        emit(warning, ...rest);
    });
}

/**
 * What opening the history gave. `corrupt`: the file is not a database, or
 * fails its check; it is left as it is, for the caller to start another
 * history beside it (historyFiles.ts says why it is never renamed).
 */
export type OpenResult =
    | { status: 'ready'; store: UsageStore; journal: 'wal' | 'delete' }
    | { status: 'read-only'; store: UsageStore; reason: 'newer-schema'; schema: number }
    | { status: 'corrupt' }
    | { status: 'failed'; category: 'busy' | 'io' | 'unknown' };

export interface OpenOptions {
    /** The wall clock, for lease heartbeats shared between windows. */
    now?: () => number;
    /** Attempts at opening and initialising before giving up on SQLITE_BUSY. */
    attempts?: number;
    /** Treat the file as being on a network filesystem (tests). */
    forceRollbackJournal?: boolean;
    /** Whether a lease holder's process still runs (tests). */
    isAlive?: (pid: number) => boolean;
    /** How long a statement waits on another window's lock, in ms; tests shorten it. */
    busyTimeoutMs?: number;
}

/** A file's checkpoint: how far it has been read, and what it was. */
export interface FileCheckpoint {
    provider: UsageProvider;
    path: string;
    root: string;
    kind: TranscriptKind;
    sessionId: string | null;
    runId: string | null;
    agentId: string | null;
    projectDir: string;
    /** Decimal text: an NTFS file id passes 2^53 (see `FileState`). */
    dev: string | null;
    ino: string | null;
    size: number;
    mtimeMs: number;
    /** The byte after the last newline read. */
    offset: number;
    /** A hash of the 64 bytes before `offset`, to notice a rewritten file. */
    tailHash: string | null;
    parserVersion: number;
    oversizeLines: number;
    malformedLines: number;
    newestVersion: string | null;
}

/** What `latestMainRequest` returns: when, on which model, and the three input counters. */
export interface LatestRequest {
    timestamp: number;
    model: string;
    variant: string | null;
    input: number | null;
    cacheCreation: number | null;
    cacheRead: number | null;
}

/**
 * A large file's read in progress, and how often reading it never finished.
 * Kept apart from its checkpoint, which only a finished read writes.
 */
export interface ReadGuard {
    provider: UsageProvider;
    path: string;
    inProgress: boolean;
    crashCount: number;
    /** Wall-clock milliseconds of the last crash counted. */
    lastCrash: number | null;
}

const SCHEMA = `
CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
) STRICT;

CREATE TABLE files (
    provider TEXT NOT NULL DEFAULT 'claude-code',
    path TEXT NOT NULL,
    root TEXT NOT NULL,
    kind TEXT NOT NULL,
    session_id TEXT,
    run_id TEXT,
    agent_id TEXT,
    project_dir TEXT NOT NULL,
    dev TEXT,
    ino TEXT,
    size INTEGER NOT NULL,
    mtime_ms INTEGER NOT NULL,
    offset INTEGER NOT NULL,
    tail_hash TEXT,
    parser_version INTEGER NOT NULL,
    oversize_lines INTEGER NOT NULL DEFAULT 0,
    malformed_lines INTEGER NOT NULL DEFAULT 0,
    newest_version TEXT,
    PRIMARY KEY (provider, path)
) STRICT;

CREATE TABLE read_guards (
    provider TEXT NOT NULL DEFAULT 'claude-code',
    path TEXT NOT NULL,
    in_progress INTEGER NOT NULL,
    crash_count INTEGER NOT NULL,
    last_crash INTEGER,
    PRIMARY KEY (provider, path)
) STRICT;

CREATE TABLE requests (
    provider TEXT NOT NULL DEFAULT 'claude-code',
    message_id TEXT NOT NULL,
    parser_version INTEGER NOT NULL,
    file TEXT NOT NULL,
    byte_offset INTEGER NOT NULL,
    is_main INTEGER NOT NULL,
    complete INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    model TEXT NOT NULL,
    variant TEXT,
    input INTEGER,
    cache_creation INTEGER,
    cache_read INTEGER,
    output INTEGER,
    cache_5m INTEGER,
    cache_1h INTEGER,
    thinking INTEGER,
    effort TEXT,
    web_search INTEGER,
    web_fetch INTEGER,
    request_id TEXT,
    claude_code_version TEXT,
    agent_id TEXT,
    run_id TEXT,
    PRIMARY KEY (provider, message_id)
) STRICT;
CREATE INDEX requests_ts ON requests (ts);
CREATE INDEX requests_session ON requests (session_id);
CREATE INDEX requests_request_id ON requests (request_id);
CREATE INDEX requests_file ON requests (file);

CREATE TABLE sessions (
    provider TEXT NOT NULL DEFAULT 'claude-code',
    session_id TEXT NOT NULL,
    root TEXT NOT NULL,
    cwd TEXT,
    cwd_ts INTEGER,
    project_dir TEXT NOT NULL,
    first_ts INTEGER,
    last_ts INTEGER,
    PRIMARY KEY (provider, session_id)
) STRICT;

CREATE TABLE compactions (
    provider TEXT NOT NULL DEFAULT 'claude-code',
    uuid TEXT NOT NULL,
    session_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    ts INTEGER NOT NULL,
    trigger TEXT,
    pre_tokens INTEGER,
    post_tokens INTEGER,
    PRIMARY KEY (provider, uuid)
) STRICT;

CREATE TABLE limit_hits (
    provider TEXT NOT NULL DEFAULT 'claude-code',
    uuid TEXT NOT NULL,
    session_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    limit_type TEXT NOT NULL,
    resets_at INTEGER,
    PRIMARY KEY (provider, uuid)
) STRICT;

CREATE TABLE lease (
    role TEXT PRIMARY KEY,
    holder TEXT NOT NULL,
    host TEXT NOT NULL,
    pid INTEGER NOT NULL,
    parser_version INTEGER NOT NULL,
    heartbeat INTEGER NOT NULL
) STRICT;
`;

/** Tables that hold history, and the bookkeeping of reading it: everything Clear empties. */
const DATA_TABLES = ['files', 'read_guards', 'requests', 'sessions', 'compactions', 'limit_hits'];

/**
 * Migrations by the version they produce. Forward-only and additive, each in
 * one transaction after a backup. Version 1 creates the schema.
 */
const MIGRATIONS: Record<number, (db: DatabaseSync) => void> = {
    1: db => db.exec(SCHEMA),
};

/**
 * The comparator of `accounting.ts`, as the upsert's condition: the incoming
 * record replaces the stored one only when it would represent the request
 * instead. Text compares as UTF-8 bytes (BINARY collation), as the
 * JavaScript side does.
 */
const UPSERT_REQUEST = `
INSERT INTO requests (
    provider, message_id, parser_version, file, byte_offset, is_main, complete, ts,
    session_id, kind, model, variant, input, cache_creation, cache_read, output,
    cache_5m, cache_1h, thinking, effort, web_search, web_fetch, request_id,
    claude_code_version, agent_id, run_id
) VALUES (
    :provider, :messageId, :parserVersion, :file, :byteOffset, :isMain, :complete, :ts,
    :sessionId, :kind, :model, :variant, :input, :cacheCreation, :cacheRead, :output,
    :cache5m, :cache1h, :thinking, :effort, :webSearch, :webFetch, :requestId,
    :claudeCodeVersion, :agentId, :runId
)
ON CONFLICT (provider, message_id) DO UPDATE SET
    (parser_version, file, byte_offset, is_main, complete, ts, session_id, kind, model,
     variant, input, cache_creation, cache_read, output, cache_5m, cache_1h, thinking,
     effort, web_search, web_fetch, request_id, claude_code_version, agent_id, run_id)
  = (excluded.parser_version, excluded.file, excluded.byte_offset, excluded.is_main,
     excluded.complete, excluded.ts, excluded.session_id, excluded.kind, excluded.model,
     excluded.variant, excluded.input, excluded.cache_creation, excluded.cache_read,
     excluded.output, excluded.cache_5m, excluded.cache_1h, excluded.thinking,
     excluded.effort, excluded.web_search, excluded.web_fetch, excluded.request_id,
     excluded.claude_code_version, excluded.agent_id, excluded.run_id)
WHERE excluded.parser_version > requests.parser_version
   OR (excluded.parser_version = requests.parser_version AND (
        (excluded.is_main, excluded.complete, coalesce(excluded.output, -1))
          > (requests.is_main, requests.complete, coalesce(requests.output, -1))
     OR ((excluded.is_main, excluded.complete, coalesce(excluded.output, -1))
          = (requests.is_main, requests.complete, coalesce(requests.output, -1))
         AND (excluded.file, excluded.byte_offset) < (requests.file, requests.byte_offset))))
`;

export class UsageStore {
    private readonly upsertStatement: StatementSync;

    private constructor(
        private readonly db: DatabaseSync,
        readonly file: string,
        readonly readOnly: boolean,
        private readonly now: () => number,
        private readonly isAlive: (pid: number) => boolean,
    ) {
        this.upsertStatement = db.prepare(UPSERT_REQUEST);
    }

    /**
     * Open, or create, the history at `file`, through `sqlite`.
     *
     * Retries on SQLITE_BUSY, because two windows initialising one new store
     * at once hit it in 2 of 8 trials even with a 5 s busy timeout.
     */
    static open(sqlite: Sqlite, file: string, options: OpenOptions = {}): OpenResult {
        const now = options.now ?? Date.now;
        const attempts = options.attempts ?? 10;
        fs.mkdirSync(path.dirname(file), { recursive: true });

        for (let attempt = 1; ; attempt++) {
            try {
                return UsageStore.openOnce(sqlite, file, now, options);
            } catch (error) {
                const code = primaryCode(error);
                if (code === SQLITE_BUSY && attempt < attempts) {
                    sleep(25 * attempt);
                    continue;
                }
                if (code === SQLITE_CORRUPT || code === SQLITE_NOTADB) {
                    return { status: 'corrupt' };
                }
                return { status: 'failed', category: code === SQLITE_BUSY ? 'busy' : code === undefined ? 'unknown' : 'io' };
            }
        }
    }

    private static openOnce(sqlite: Sqlite, file: string, now: () => number, options: OpenOptions): OpenResult {
        const busyTimeout = `PRAGMA busy_timeout = ${Math.max(0, Math.floor(options.busyTimeoutMs ?? 5000))}`;
        let db = new sqlite.DatabaseSync(file);
        try {
            db.exec(busyTimeout);
            const schema = userVersion(db);

            // A newer extension created it: read it, never write or migrate it.
            if (schema > SCHEMA_VERSION) {
                db.close();
                db = new sqlite.DatabaseSync(file, { readOnly: true });
                db.exec(busyTimeout);
                return { status: 'read-only', store: new UsageStore(db, file, true, now, alive(options)), reason: 'newer-schema', schema };
            }

            if (schema > 0) {
                const check = (db.prepare('PRAGMA quick_check').get() as { quick_check: string }).quick_check;
                if (check !== 'ok') {
                    throw Object.assign(new Error('quick_check failed'), { errcode: SQLITE_CORRUPT });
                }
            }

            const journal = UsageStore.configure(db, file, options);
            UsageStore.migrate(db, file, schema);
            return { status: 'ready', store: new UsageStore(db, file, false, now, alive(options)), journal };
        } catch (error) {
            db.close();
            throw error;
        }
    }

    /**
     * Pragmas, all set explicitly: a worker's resourceLimits cap the V8 heap
     * only, not SQLite's own memory or a memory-mapped file.
     */
    private static configure(db: DatabaseSync, file: string, options: OpenOptions): 'wal' | 'delete' {
        db.exec('PRAGMA synchronous = NORMAL; PRAGMA cache_size = -8192; PRAGMA mmap_size = 0');
        // WAL needs shared memory that network filesystems do not provide;
        // there, one window writes (the lease holder) under a rollback journal.
        if (options.forceRollbackJournal || onNetworkFilesystem(path.dirname(file))) {
            db.exec('PRAGMA journal_mode = DELETE');
            return 'delete';
        }
        const mode = (db.prepare('PRAGMA journal_mode = WAL').get() as { journal_mode: string }).journal_mode;
        if (mode !== 'wal') {
            db.exec('PRAGMA journal_mode = DELETE');
            return 'delete';
        }
        return 'wal';
    }

    /**
     * Bring the schema to SCHEMA_VERSION, one version per transaction.
     *
     * Two windows can open one new store at once: both read user_version 0,
     * and the second's CREATE TABLE then failed on the first one's tables
     * ("table meta already exists"), in about 1 in 5 openings on the
     * editors' runtimes (measured on VS Code 1.105 and 1.141, Electron 37.6
     * and 43.7; never on Node 26.3 in 60). So the version is
     * read again once the write lock is held, and one already applied is
     * skipped.
     */
    private static migrate(db: DatabaseSync, file: string, from: number): void {
        for (let version = from + 1; version <= SCHEMA_VERSION; version++) {
            // The first migration creates the schema; there is nothing to keep.
            if (from > 0) {
                backUp(db, `${file}.bak-v${version - 1}`);
            }
            db.exec('BEGIN IMMEDIATE');
            try {
                if (userVersion(db) >= version) {
                    db.exec('COMMIT');
                    continue;
                }
                MIGRATIONS[version](db);
                if (version === 1) {
                    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
                    db.prepare("INSERT INTO meta (key, value) VALUES ('store_id', ?), ('store_generation', '0')").run(id);
                }
                db.exec(`PRAGMA user_version = ${version}`);
                db.exec('COMMIT');
            } catch (error) {
                db.exec('ROLLBACK');
                throw error;
            }
        }
    }

    close(): void {
        this.db.close();
    }

    /** Run `work` in one write transaction, rolled back if it throws. */
    transaction<T>(work: () => T): T {
        this.assertWritable();
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const result = work();
            this.db.exec('COMMIT');
            return result;
        } catch (error) {
            if (this.db.isTransaction) {
                this.db.exec('ROLLBACK');
            }
            throw error;
        }
    }

    /**
     * Store `requests`, each replacing the stored row for its `messageId`
     * only when the comparator prefers it. Call inside `transaction`.
     */
    upsertRequests(requests: Iterable<UsageRequest>): void {
        this.assertWritable();
        for (const r of requests) {
            this.upsertStatement.run({
                provider: r.provider,
                messageId: r.messageId,
                parserVersion: r.parserVersion,
                file: r.file,
                byteOffset: r.byteOffset,
                isMain: r.isMain ? 1 : 0,
                complete: isComplete(r) ? 1 : 0,
                ts: r.timestamp,
                sessionId: r.sessionId,
                kind: r.kind,
                model: r.model,
                variant: r.variant,
                input: r.input,
                cacheCreation: r.cacheCreation,
                cacheRead: r.cacheRead,
                output: r.output,
                cache5m: r.cacheWrite5m,
                cache1h: r.cacheWrite1h,
                thinking: r.thinking,
                effort: r.effort,
                webSearch: r.webSearchRequests,
                webFetch: r.webFetchRequests,
                requestId: r.requestId,
                claudeCodeVersion: r.claudeCodeVersion,
                agentId: r.agentId,
                runId: r.runId,
            });
        }
    }

    /** Store compactions; each is one record, so a second sighting changes nothing. */
    insertCompactions(provider: UsageProvider, compactions: Iterable<Compaction>): void {
        this.assertWritable();
        const insert = this.db.prepare(
            `INSERT OR IGNORE INTO compactions (provider, uuid, session_id, kind, ts, trigger, pre_tokens, post_tokens)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const c of compactions) {
            insert.run(provider, c.uuid, c.sessionId, c.kind, c.timestamp, c.trigger, c.preTokens, c.postTokens);
        }
    }

    /** Store limit hits; each is one record, so a second sighting changes nothing. */
    insertLimitHits(provider: UsageProvider, hits: Iterable<LimitHit>): void {
        this.assertWritable();
        const insert = this.db.prepare(
            `INSERT OR IGNORE INTO limit_hits (provider, uuid, session_id, ts, limit_type, resets_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
        );
        for (const h of hits) {
            insert.run(provider, h.uuid, h.sessionId, h.timestamp, h.limitType, h.resetsAt);
        }
    }

    /**
     * Merge what an import saw of a session. Its cwd is the earliest one seen,
     * by record time and then by text, so the order files are read in never
     * matters; its span only ever widens.
     */
    upsertSession(provider: UsageProvider, s: SessionSighting): void {
        this.assertWritable();
        const earlier = `excluded.cwd IS NOT NULL AND (sessions.cwd IS NULL
            OR (excluded.cwd_ts IS NOT NULL AND (sessions.cwd_ts IS NULL OR excluded.cwd_ts < sessions.cwd_ts))
            OR (excluded.cwd_ts IS sessions.cwd_ts AND excluded.cwd < sessions.cwd))`;
        this.db
            .prepare(
                `INSERT INTO sessions (provider, session_id, root, cwd, cwd_ts, project_dir, first_ts, last_ts)
                 VALUES (:provider, :sessionId, :root, :cwd, :cwdTs, :projectDir, :firstTs, :lastTs)
                 ON CONFLICT (provider, session_id) DO UPDATE SET
                     cwd = CASE WHEN ${earlier} THEN excluded.cwd ELSE sessions.cwd END,
                     cwd_ts = CASE WHEN ${earlier} THEN excluded.cwd_ts ELSE sessions.cwd_ts END,
                     first_ts = CASE WHEN sessions.first_ts IS NULL OR excluded.first_ts < sessions.first_ts
                                     THEN coalesce(excluded.first_ts, sessions.first_ts) ELSE sessions.first_ts END,
                     last_ts = CASE WHEN sessions.last_ts IS NULL OR excluded.last_ts > sessions.last_ts
                                    THEN coalesce(excluded.last_ts, sessions.last_ts) ELSE sessions.last_ts END`,
            )
            .run({ provider, ...s });
    }

    /** Every stored session, for the queries and the tests. */
    sessions(): (SessionSighting & { provider: UsageProvider })[] {
        return this.db
            .prepare('SELECT provider, session_id, root, cwd, cwd_ts, project_dir, first_ts, last_ts FROM sessions ORDER BY session_id')
            .all()
            .map(row => ({
                provider: row.provider as UsageProvider,
                sessionId: row.session_id as string,
                root: row.root as string,
                cwd: row.cwd as string | null,
                cwdTs: row.cwd_ts as number | null,
                projectDir: row.project_dir as string,
                firstTs: row.first_ts as number | null,
                lastTs: row.last_ts as number | null,
            }));
    }

    /**
     * Request sums by 15-minute UTC bucket, session, model, variant, kind and
     * effort, from `sinceMs` on. Every current UTC offset is a multiple of 15
     * minutes, so no bucket straddles a local midnight, and the caller folds
     * them into days in any zone exactly.
     */
    bucketSums(sinceMs: number): BucketSums[] {
        return this.db
            .prepare(
                `SELECT ts / ${BUCKET_MS} AS bucket, session_id, model, variant, kind, effort,
                        count(*) AS requests, sum(complete) AS complete, min(ts) AS first_ts, max(ts) AS last_ts,
                        coalesce(sum(input), 0) AS input, coalesce(sum(cache_creation), 0) AS cache_creation,
                        coalesce(sum(cache_read), 0) AS cache_read, coalesce(sum(output), 0) AS output,
                        coalesce(sum(cache_5m), 0) AS cache_5m, coalesce(sum(cache_1h), 0) AS cache_1h,
                        coalesce(sum(thinking), 0) AS thinking, coalesce(sum(web_search), 0) AS web_search,
                        coalesce(sum(web_fetch), 0) AS web_fetch
                 FROM requests
                 WHERE ts >= ?
                 GROUP BY bucket, session_id, model, variant, kind, effort`,
            )
            .all(sinceMs)
            .map(row => ({
                bucket: row.bucket as number,
                sessionId: row.session_id as string,
                model: row.model as string,
                variant: row.variant as string | null,
                kind: row.kind as TranscriptKind,
                effort: row.effort as string | null,
                requests: row.requests as number,
                completeRequests: row.complete as number,
                firstTs: row.first_ts as number,
                lastTs: row.last_ts as number,
                input: row.input as number,
                cacheCreation: row.cache_creation as number,
                cacheRead: row.cache_read as number,
                output: row.output as number,
                cacheWrite5m: row.cache_5m as number,
                cacheWrite1h: row.cache_1h as number,
                thinking: row.thinking as number,
                webSearchRequests: row.web_search as number,
                webFetchRequests: row.web_fetch as number,
            }));
    }

    /** A session's latest request in its main conversation: what its context held then. */
    latestMainRequest(sessionId: string): LatestRequest | undefined {
        const row = this.db
            .prepare(
                `SELECT ts, model, variant, input, cache_creation, cache_read FROM requests
                 WHERE session_id = ? AND kind = 'main' AND is_main = 1
                 ORDER BY ts DESC, byte_offset DESC LIMIT 1`,
            )
            .get(sessionId);
        return row
            ? {
                  timestamp: row.ts as number,
                  model: row.model as string,
                  variant: row.variant as string | null,
                  input: row.input as number | null,
                  cacheCreation: row.cache_creation as number | null,
                  cacheRead: row.cache_read as number | null,
              }
            : undefined;
    }

    /** A session's compactions of its main conversation, newest first. */
    sessionCompactions(sessionId: string): Compaction[] {
        return this.db
            .prepare(
                `SELECT uuid, session_id, kind, ts, trigger, pre_tokens, post_tokens FROM compactions
                 WHERE session_id = ? AND kind = 'main' ORDER BY ts DESC, uuid`,
            )
            .all(sessionId)
            .map(row => ({
                uuid: row.uuid as string,
                sessionId: row.session_id as string,
                kind: row.kind as TranscriptKind,
                timestamp: row.ts as number,
                trigger: row.trigger as string | null,
                preTokens: row.pre_tokens as number | null,
                postTokens: row.post_tokens as number | null,
            }));
    }

    /** The span and size of the whole history, whatever range is shown. */
    coverage(): StoreCoverage {
        const requests = this.db.prepare('SELECT min(ts) AS start, max(ts) AS newest, count(*) AS n FROM requests').get() as {
            start: number | null;
            newest: number | null;
            n: number;
        };
        const files = this.db
            .prepare('SELECT count(*) AS n, coalesce(sum(oversize_lines), 0) AS oversize, coalesce(sum(malformed_lines), 0) AS malformed FROM files')
            .get() as { n: number; oversize: number; malformed: number };
        return {
            start: requests.start,
            newest: requests.newest,
            requests: requests.n,
            files: files.n,
            oversizeLines: files.oversize,
            malformedLines: files.malformed,
        };
    }

    compactions(sinceMs = 0): Compaction[] {
        return this.db
            .prepare('SELECT uuid, session_id, kind, ts, trigger, pre_tokens, post_tokens FROM compactions WHERE ts >= ? ORDER BY ts, uuid')
            .all(sinceMs)
            .map(row => ({
                uuid: row.uuid as string,
                sessionId: row.session_id as string,
                kind: row.kind as TranscriptKind,
                timestamp: row.ts as number,
                trigger: row.trigger as string | null,
                preTokens: row.pre_tokens as number | null,
                postTokens: row.post_tokens as number | null,
            }));
    }

    limitHits(sinceMs = 0): LimitHit[] {
        return this.db
            .prepare('SELECT uuid, session_id, ts, limit_type, resets_at FROM limit_hits WHERE ts >= ? ORDER BY ts, uuid')
            .all(sinceMs)
            .map(row => ({
                uuid: row.uuid as string,
                sessionId: row.session_id as string,
                timestamp: row.ts as number,
                limitType: row.limit_type as string,
                resetsAt: row.resets_at as number | null,
            }));
    }

    /**
     * Drop the rows read from `file` before re-reading it with a newer parser,
     * so that a change of key cannot leave its old rows behind as doubles.
     */
    deleteRequestsFromFile(provider: UsageProvider, file: string): void {
        this.assertWritable();
        this.db.prepare('DELETE FROM requests WHERE provider = ? AND file = ?').run(provider, file);
    }

    /** Every stored request, for the queries and the tests. */
    *requests(): IterableIterator<UsageRequest> {
        for (const row of this.db.prepare('SELECT * FROM requests ORDER BY provider, message_id').iterate()) {
            yield toRequest(row);
        }
    }

    getFile(provider: UsageProvider, filePath: string): FileCheckpoint | undefined {
        const row = this.db.prepare('SELECT * FROM files WHERE provider = ? AND path = ?').get(provider, filePath);
        return row ? toCheckpoint(row) : undefined;
    }

    /** Record how far `checkpoint.path` was read. Call in the same transaction as its rows. */
    putFile(checkpoint: FileCheckpoint): void {
        this.assertWritable();
        this.db
            .prepare(
                `INSERT OR REPLACE INTO files (
                    provider, path, root, kind, session_id, run_id, agent_id, project_dir, dev, ino,
                    size, mtime_ms, offset, tail_hash, parser_version, oversize_lines, malformed_lines,
                    newest_version
                ) VALUES (
                    :provider, :path, :root, :kind, :sessionId, :runId, :agentId, :projectDir, :dev, :ino,
                    :size, :mtimeMs, :offset, :tailHash, :parserVersion, :oversizeLines, :malformedLines,
                    :newestVersion
                )`,
            )
            .run({ ...checkpoint });
    }

    getReadGuard(provider: UsageProvider, filePath: string): ReadGuard | undefined {
        const row = this.db.prepare('SELECT * FROM read_guards WHERE provider = ? AND path = ?').get(provider, filePath);
        return row
            ? {
                  provider: row.provider as UsageProvider,
                  path: row.path as string,
                  inProgress: row.in_progress === 1,
                  crashCount: row.crash_count as number,
                  lastCrash: row.last_crash as number | null,
              }
            : undefined;
    }

    putReadGuard(guard: ReadGuard): void {
        this.assertWritable();
        this.db
            .prepare(
                `INSERT OR REPLACE INTO read_guards (provider, path, in_progress, crash_count, last_crash)
                 VALUES (:provider, :path, :inProgress, :crashCount, :lastCrash)`,
            )
            .run({ ...guard, inProgress: guard.inProgress ? 1 : 0 });
    }

    deleteReadGuard(provider: UsageProvider, filePath: string): void {
        this.assertWritable();
        this.db.prepare('DELETE FROM read_guards WHERE provider = ? AND path = ?').run(provider, filePath);
    }

    /** Bumped by every Clear, so a worker holding caches knows to drop them. */
    generation(): number {
        const row = this.db.prepare("SELECT value FROM meta WHERE key = 'store_generation'").get() as { value: string } | undefined;
        return row ? Number(row.value) : 0;
    }

    storeId(): string {
        return (this.db.prepare("SELECT value FROM meta WHERE key = 'store_id'").get() as { value: string }).value;
    }

    /**
     * Delete the history, in SQL on the connection every window shares.
     *
     * The file itself is never unlinked: on POSIX another window would go on
     * writing to the unlinked file, and Windows refuses to delete one that is
     * open. Nothing of the history is left readable on disk either: deleted
     * rows are overwritten (secure_delete), VACUUM returns the space when no
     * other window is busy with the database, and the write-ahead log, which
     * holds every page written since the last checkpoint, is folded into the
     * file and emptied.
     *
     * @returns `settled`: false while another window's read holds the
     * checkpoint off, for `checkpoint()` to finish later; `copiesLeft`: the
     * copies beside it that could not be removed (one that another process
     * holds open, on Windows).
     */
    clear(): { settled: boolean; copiesLeft: number } {
        const secure = (this.db.prepare('PRAGMA secure_delete').get() as { secure_delete: number }).secure_delete;
        this.db.exec('PRAGMA secure_delete = ON');
        try {
            this.transaction(() => {
                for (const table of DATA_TABLES) {
                    this.db.exec(`DELETE FROM ${table}`);
                }
                this.db.exec("UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'store_generation'");
            });
        } finally {
            this.db.exec(`PRAGMA secure_delete = ${secure === 2 ? 'FAST' : secure === 1 ? 'ON' : 'OFF'}`);
        }
        try {
            this.db.exec('VACUUM');
        } catch (error) {
            if (primaryCode(error) !== SQLITE_BUSY) {
                throw error;
            }
        }
        const settled = this.checkpoint();
        // The copies set aside beside it hold the same history: a corrupt
        // file moved away, and the backup each migration starts from. Clear
        // means all of it, as far as it can be removed.
        let copiesLeft = 0;
        for (const name of copiesBeside(this.file)) {
            try {
                fs.rmSync(path.join(path.dirname(this.file), name), { force: true });
            } catch {
                copiesLeft++;
            }
        }
        return { settled, copiesLeft };
    }

    /**
     * Fold the write-ahead log into the file and empty it. False while
     * another window's read holds it off: until then, the pages the last
     * Clear replaced are still in the file and the log.
     */
    checkpoint(): boolean {
        const result = this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy: number } | undefined;
        return result?.busy !== 1;
    }

    /**
     * Record the history this one replaced, a corrupt one set aside, by its
     * name: every window, and every reload, says so while its file is there,
     * until Clear removes it.
     */
    markSetAside(name: string): void {
        this.assertWritable();
        this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('set_aside', ?)").run(name);
    }

    /** The history this one replaced, while its file is still beside it. */
    setAside(): string | undefined {
        const row = this.db.prepare("SELECT value FROM meta WHERE key = 'set_aside'").get() as { value: string } | undefined;
        return row && copiesBeside(this.file).includes(row.value) ? row.value : undefined;
    }

    /** Run `work` as one read, on one snapshot, whatever other windows commit meanwhile. */
    read<T>(work: () => T): T {
        this.db.exec('BEGIN');
        try {
            const result = work();
            this.db.exec('COMMIT');
            return result;
        } catch (error) {
            if (this.db.isTransaction) {
                this.db.exec('ROLLBACK');
            }
            throw error;
        }
    }

    /**
     * Hold `role` (one importing window at a time), or keep holding it.
     *
     * Taken when it is free, when its heartbeat is older than
     * LEASE_TAKEOVER_MS, when its holder's process has exited on this host
     * (a pid means nothing on another one, as with a home on a network
     * filesystem), or when its holder runs an older parser.
     *
     * Never taken by an older parser than one that has held it before: a
     * window not reloaded after an update would otherwise read every file
     * again, its way, and the two windows would take turns undoing each
     * other's rows. See `outdated`.
     *
     * @returns whether `holder` now holds it.
     */
    acquireLease(role: string, holder: string, parserVersion: number): boolean {
        return this.transaction(() => {
            const newest = this.maxParserVersion();
            if (parserVersion < newest) {
                return false;
            }
            const now = this.now();
            const current = this.db.prepare('SELECT holder, host, pid, parser_version, heartbeat FROM lease WHERE role = ?').get(role) as
                | { holder: string; host: string; pid: number; parser_version: number; heartbeat: number }
                | undefined;
            const mine = current?.holder === holder;
            const free =
                !current ||
                now - current.heartbeat > LEASE_TAKEOVER_MS ||
                current.parser_version < parserVersion ||
                (current.host === os.hostname() && !this.isAlive(current.pid));
            if (!mine && !free) {
                return false;
            }
            this.db
                .prepare('INSERT OR REPLACE INTO lease (role, holder, host, pid, parser_version, heartbeat) VALUES (?, ?, ?, ?, ?, ?)')
                .run(role, holder, os.hostname(), process.pid, parserVersion, now);
            if (parserVersion > newest) {
                this.db
                    .prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('max_parser_version', ?)")
                    .run(String(parserVersion));
            }
            return true;
        });
    }

    /** Whether a newer parser than `parserVersion` has written this history: then this one must not. */
    outdated(parserVersion: number): boolean {
        return parserVersion < this.maxParserVersion();
    }

    private maxParserVersion(): number {
        const row = this.db.prepare("SELECT value FROM meta WHERE key = 'max_parser_version'").get() as { value: string } | undefined;
        return row ? Number(row.value) : 0;
    }

    releaseLease(role: string, holder: string): void {
        this.transaction(() => {
            this.db.prepare('DELETE FROM lease WHERE role = ? AND holder = ?').run(role, holder);
        });
    }

    private assertWritable(): void {
        if (this.readOnly) {
            throw Object.assign(new Error('The usage history was created by a newer LLM Tokenizer and is read-only here'), {
                errcode: SQLITE_READONLY,
            });
        }
    }
}

function toRequest(row: Record<string, unknown>): UsageRequest {
    return {
        provider: row.provider as UsageProvider,
        messageId: row.message_id as string,
        requestId: row.request_id as string | null,
        sessionId: row.session_id as string,
        kind: row.kind as TranscriptKind,
        isMain: row.is_main === 1,
        timestamp: row.ts as number,
        model: row.model as string,
        variant: row.variant as string | null,
        input: row.input as number | null,
        cacheCreation: row.cache_creation as number | null,
        cacheRead: row.cache_read as number | null,
        output: row.output as number | null,
        cacheWrite5m: row.cache_5m as number | null,
        cacheWrite1h: row.cache_1h as number | null,
        thinking: row.thinking as number | null,
        effort: row.effort as string | null,
        webSearchRequests: row.web_search as number | null,
        webFetchRequests: row.web_fetch as number | null,
        claudeCodeVersion: row.claude_code_version as string | null,
        agentId: row.agent_id as string | null,
        runId: row.run_id as string | null,
        file: row.file as string,
        byteOffset: row.byte_offset as number,
        parserVersion: row.parser_version as number,
    };
}

function toCheckpoint(row: Record<string, unknown>): FileCheckpoint {
    return {
        provider: row.provider as UsageProvider,
        path: row.path as string,
        root: row.root as string,
        kind: row.kind as TranscriptKind,
        sessionId: row.session_id as string | null,
        runId: row.run_id as string | null,
        agentId: row.agent_id as string | null,
        projectDir: row.project_dir as string,
        dev: row.dev as string | null,
        ino: row.ino as string | null,
        size: row.size as number,
        mtimeMs: row.mtime_ms as number,
        offset: row.offset as number,
        tailHash: row.tail_hash as string | null,
        parserVersion: row.parser_version as number,
        oversizeLines: row.oversize_lines as number,
        malformedLines: row.malformed_lines as number,
        newestVersion: row.newest_version as string | null,
    };
}

function alive(options: OpenOptions): (pid: number) => boolean {
    return options.isAlive ?? processAlive;
}

/** Whether `pid` runs on this machine: signal 0 checks without signalling. */
function processAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        // It exists, but belongs to someone else.
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
}

/** SQLite's primary result code from an error `node:sqlite` threw, if any. */
function primaryCode(error: unknown): number | undefined {
    const code = (error as { errcode?: unknown } | null)?.errcode;
    return typeof code === 'number' ? code & 0xff : undefined;
}

/** Linux's magic numbers for the filesystems WAL cannot be trusted on. */
const NETWORK_FILESYSTEMS = new Set([
    0x6969, // NFS
    0x517b, // SMB
    0xff534d42, // CIFS
    0xfe534d42, // SMB2
]);

function onNetworkFilesystem(directory: string): boolean {
    if (process.platform !== 'linux') {
        return false;
    }
    try {
        return NETWORK_FILESYSTEMS.has(fs.statfsSync(directory).type);
    } catch {
        return false;
    }
}

function userVersion(db: DatabaseSync): number {
    return Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
}

/**
 * The copy of the store a migration starts from. VACUUM INTO refuses a file
 * that exists, so a second window migrating at the same moment finds the
 * first one's copy, and that copy is the backup.
 */
function backUp(db: DatabaseSync, target: string): void {
    try {
        db.exec(`VACUUM INTO ${sqlString(target)}`);
    } catch (error) {
        if (!fs.existsSync(target)) {
            throw error;
        }
    }
}

function sqlString(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

/** A short synchronous wait, which a worker thread may afford. */
function sleep(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
