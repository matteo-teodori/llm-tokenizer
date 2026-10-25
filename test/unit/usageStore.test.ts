import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { StatementSync } from 'node:sqlite';

import { dedupe } from '../../src/usage/accounting';
import { totalsOf } from '../../src/usage/aggregate';
import { createHistory, publishHistory, resolveHistory } from '../../src/usage/historyFiles';
import { LEASE_TAKEOVER_MS, SCHEMA_VERSION, UsageStore, loadSqlite, type FileCheckpoint, type OpenResult } from '../../src/usage/store';
import type { UsageRequest } from '../../src/usage/types';

const sqlite = loadSqlite();

function req(overrides: Partial<UsageRequest> = {}): UsageRequest {
    return {
        provider: 'claude-code',
        messageId: 'msg_1',
        requestId: 'req_1',
        sessionId: 'session-a',
        kind: 'main',
        isMain: true,
        timestamp: Date.UTC(2026, 9, 9, 10, 0),
        model: 'claude-opus-5-5',
        variant: null,
        speed: null,
        inferenceGeo: null,
        input: 0,
        cacheCreation: 0,
        cacheRead: 0,
        output: 0,
        cacheWrite5m: null,
        cacheWrite1h: null,
        thinking: null,
        effort: null,
        webSearchRequests: null,
        webFetchRequests: null,
        claudeCodeVersion: '2.1.292',
        agentId: null,
        runId: null,
        file: '/root/projects/p/session-a.jsonl',
        byteOffset: 0,
        parserVersion: 1,
        ...overrides,
    };
}

function seeded(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function ready(result: OpenResult): UsageStore {
    assert.strictEqual(result.status, 'ready', JSON.stringify(result));
    return result.store;
}

/**
 * Turn the history at `file`, made by this build, into one as a build at
 * `schema` left it, every row kept: each request with its transcript's path
 * in full, under the four indexes it had, and at schema 1 without its speed
 * or where it ran. The newest parser to hold the lease is where those builds
 * kept it.
 */
function asSchema(file: string, schema: 1 | 2): void {
    assert.ok(sqlite, 'this runtime has no node:sqlite');
    const db = new sqlite.DatabaseSync(file);
    try {
        db.exec(`
            BEGIN;
            DROP TRIGGER clear_paths;
            CREATE TABLE old_requests (
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
            INSERT INTO old_requests
            SELECT r.provider, r.message_id, r.parser_version, p.path, r.byte_offset, r.is_main, r.complete, r.ts,
                   r.session_id, r.kind, r.model, r.variant, r.input, r.cache_creation, r.cache_read, r.output,
                   r.cache_5m, r.cache_1h, r.thinking, r.effort, r.web_search, r.web_fetch, r.request_id,
                   r.claude_code_version, r.agent_id, r.run_id
            FROM requests r JOIN paths p ON p.id = r.file;
            ${
                schema === 2
                    ? `ALTER TABLE old_requests ADD COLUMN speed TEXT;
                       ALTER TABLE old_requests ADD COLUMN inference_geo TEXT;
                       UPDATE old_requests SET (speed, inference_geo) = (
                           SELECT speed, inference_geo FROM requests r
                           WHERE r.provider = old_requests.provider AND r.message_id = old_requests.message_id);`
                    : ''
            }
            DROP TABLE requests;
            DROP TABLE paths;
            ALTER TABLE old_requests RENAME TO requests;
            CREATE INDEX requests_ts ON requests (ts);
            CREATE INDEX requests_session ON requests (session_id);
            CREATE INDEX requests_request_id ON requests (request_id);
            CREATE INDEX requests_file ON requests (file);
            DELETE FROM meta WHERE key = 'max_parser_version';
            UPDATE meta SET key = 'max_parser_version' WHERE key = 'newest_parser';
            PRAGMA user_version = ${schema};
            COMMIT;
        `);
    } finally {
        db.close();
    }
}

/**
 * `node:sqlite`, but right after the first read of a history's version,
 * `meanwhile` runs, as another window would between this one's read and the
 * write lock it then takes.
 */
function racing(meanwhile: () => void): { sqlite: NonNullable<typeof sqlite>; raced: () => boolean } {
    assert.ok(sqlite, 'this runtime has no node:sqlite');
    let raced = false;
    class Racing extends sqlite.DatabaseSync {
        override prepare(sql: string): StatementSync {
            const statement = super.prepare(sql);
            if (raced || sql !== 'PRAGMA user_version') {
                return statement;
            }
            raced = true;
            const read = statement.get();
            meanwhile();
            return { get: () => read } as unknown as StatementSync;
        }
    }
    return { sqlite: { ...sqlite, DatabaseSync: Racing }, raced: () => raced };
}

suite('usage history store', () => {
    let dir: string;
    let file: string;
    const opened: UsageStore[] = [];

    function open(options = {}): OpenResult {
        assert.ok(sqlite, 'this runtime has no node:sqlite');
        const result = UsageStore.open(sqlite, file, options);
        if (result.status !== 'failed' && result.status !== 'corrupt') {
            opened.push(result.store);
        }
        return result;
    }

    setup(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-tokenizer-usage-'));
        file = path.join(dir, 'claude-code-usage', 'usage.sqlite');
    });

    teardown(() => {
        for (const store of opened.splice(0)) {
            try {
                store.close();
            } catch {
                // Already closed by the test.
            }
        }
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('a new history opens in WAL mode at the current schema', () => {
        const result = open();
        const store = ready(result);
        assert.strictEqual(result.status === 'ready' && result.journal, 'wal');
        assert.strictEqual(store.generation(), 0);
        assert.match(store.storeId(), /^[0-9a-z]+-[0-9a-z]+$/);
        assert.ok(fs.existsSync(file));
        assert.strictEqual(SCHEMA_VERSION, 3);
    });

    test("a transcript's path is kept once, not in every request read from it", () => {
        // In every row and again in the index on it, the path was half the
        // history: 771 bytes a request on one heavy user's transcripts.
        const store = ready(open());
        const marker = 'Path-Marker-0xFACADE';
        const transcript = `/root/projects/-Users-someone-${marker}/session-a.jsonl`;
        store.transaction(() =>
            store.upsertRequests(Array.from({ length: 300 }, (_, i) => req({ messageId: `m${i}`, requestId: `r${i}`, file: transcript, byteOffset: i * 1000 }))),
        );
        assert.ok(store.checkpoint());
        const bytes = fs.readFileSync(file);
        let copies = 0;
        for (let at = bytes.indexOf(marker); at !== -1; at = bytes.indexOf(marker, at + 1)) {
            copies++;
        }
        // Its row in paths, and that row's entry in the index on them.
        assert.strictEqual(copies, 2);
        assert.ok([...store.requests()].every(r => r.file === transcript));
    });

    test('the upsert keeps the record the comparator prefers, in any order', () => {
        // The SQL twin of accounting.ts, against the JavaScript one. Paths
        // include a BMP and an astral character, which UTF-16 and UTF-8 order
        // differently.
        const store = ready(open());
        const random = seeded(4242);
        const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];

        const everything: UsageRequest[] = [];
        for (let round = 0; round < 150; round++) {
            const batch = Array.from({ length: 6 }, () =>
                req({
                    messageId: `m${round}-${pick([1, 2, 3])}`,
                    parserVersion: pick([1, 1, 2]),
                    isMain: pick([true, false]),
                    cacheRead: pick([0, 5, null]),
                    output: pick([null, 0, 7, 7, 30]),
                    file: pick(['/r/a.jsonl', '/r/b.jsonl', '/r/\uffff.jsonl', '/r/\u{10000}.jsonl']),
                    byteOffset: pick([0, 10, 20]),
                }),
            );
            everything.push(...batch);
            store.transaction(() => store.upsertRequests(batch));
        }

        const byId = (a: UsageRequest, b: UsageRequest) => (a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : 0);
        const expected = [...dedupe(everything).values()].sort(byId);
        assert.ok(expected.length > 100);
        assert.deepStrictEqual([...store.requests()].sort(byId), expected);
    });

    test('the oracle survives the store, re-imported and reordered', () => {
        const store = ready(open());
        const oracle = [
            req({ messageId: 'R1', input: 120, cacheRead: 800, cacheCreation: 50, output: 20, byteOffset: 0 }),
            req({ messageId: 'R1', input: 120, cacheRead: 800, cacheCreation: 50, output: 60, byteOffset: 900 }),
            req({ messageId: 'R2', input: 70, cacheRead: 100, cacheCreation: 10, output: 30, byteOffset: 1800 }),
        ];
        store.transaction(() => store.upsertRequests([...oracle].reverse()));
        store.transaction(() => store.upsertRequests(oracle));
        const totals = totalsOf(store.requests());
        assert.deepStrictEqual(
            [totals.input, totals.cacheRead, totals.cacheCreation, totals.output, totals.processed, totals.coverage.requests],
            [190, 900, 60, 90, 1_240, 2],
        );
    });

    test('an unknown counter stays unknown, not zero', () => {
        const store = ready(open());
        store.transaction(() => store.upsertRequests([req({ cacheRead: null, thinking: null, output: 4 })]));
        const [row] = [...store.requests()];
        assert.strictEqual(row.cacheRead, null);
        assert.strictEqual(row.thinking, null);
        assert.strictEqual(totalsOf([row]).provenance, 'partial');
    });

    test('a newer parser replaces older rows, and an older one never replaces newer', () => {
        const store = ready(open());
        store.transaction(() => store.upsertRequests([req({ parserVersion: 2, output: 1 })]));
        store.transaction(() => store.upsertRequests([req({ parserVersion: 1, output: 999 })]));
        assert.strictEqual([...store.requests()][0].output, 1, 'an older parser overwrote a newer row');

        // A bump re-reads a file: its old rows go first, so a changed key
        // cannot leave doubles behind.
        store.transaction(() => {
            store.deleteRequestsFromFile('claude-code', req().file);
            store.upsertRequests([req({ messageId: 'msg_1b', parserVersion: 3, output: 5 })]);
        });
        assert.deepStrictEqual([...store.requests()].map(r => r.messageId), ['msg_1b']);
    });

    test('a checkpoint reads back as written, a 64-bit file id included', () => {
        const store = ready(open());
        const checkpoint: FileCheckpoint = {
            provider: 'claude-code',
            path: '/root/projects/p/session-a.jsonl',
            root: '/root',
            kind: 'main',
            sessionId: 'session-a',
            runId: null,
            agentId: null,
            projectDir: 'p',
            dev: '16777220',
            // Past 2^63: as a number, SQLite refused it, and anything past
            // 2^53 could not be read back.
            ino: '18446744073709551557',
            size: 2048,
            mtimeMs: 1_791_000_000_000,
            offset: 2000,
            tailHash: 'abc123',
            parserVersion: 1,
            oversizeLines: 1,
            malformedLines: 2,
            newestVersion: '2.1.292',
        };
        store.transaction(() => store.putFile(checkpoint));
        assert.deepStrictEqual(store.getFile('claude-code', checkpoint.path), checkpoint);
        assert.strictEqual(store.getFile('claude-code', '/elsewhere.jsonl'), undefined);
    });

    test('Clear empties the history, bumps the generation, and keeps the file', () => {
        const store = ready(open());
        store.transaction(() => {
            store.upsertRequests([req()]);
            store.putFile({
                provider: 'claude-code', path: '/f', root: '/r', kind: 'main', sessionId: 's', runId: null, agentId: null,
                projectDir: 'p', dev: null, ino: null, size: 1, mtimeMs: 1, offset: 1, tailHash: null, parserVersion: 1,
                oversizeLines: 0, malformedLines: 0, newestVersion: null,
            });
            store.putReadGuard({ provider: 'claude-code', path: '/f', inProgress: true, crashCount: 1, lastCrash: 1 });
        });
        const id = store.storeId();
        store.clear();
        assert.strictEqual([...store.requests()].length, 0);
        assert.strictEqual(store.getFile('claude-code', '/f'), undefined);
        assert.strictEqual(store.getReadGuard('claude-code', '/f'), undefined);
        assert.strictEqual(store.generation(), 1);
        assert.strictEqual(store.storeId(), id, 'Clear made a new store rather than emptying this one');
        assert.ok(fs.existsSync(file), 'the database file was removed');
    });

    test('Clear removes the copies set aside beside the history too, and nothing else', () => {
        const store = ready(open());
        // A history set aside with its journal, an older version's corrupt
        // copy, and a migration's backup.
        const folder = path.dirname(file);
        const copies = [path.join(folder, 'usage-0a1b2c3d4e.sqlite'), path.join(folder, 'usage-0a1b2c3d4e.sqlite-wal'), `${file}.corrupt-1791000000000`, `${file}.bak-v0`];
        const others = [`${file}.notes`, path.join(folder, 'other.sqlite.corrupt-1'), path.join(folder, 'usage.current'), path.join(dir, 'usage.sqlite.bak-v0')];
        for (const f of [...copies, ...others]) {
            // The pointer names this history.
            fs.writeFileSync(f, f.endsWith('usage.current') ? 'usage.sqlite' : 'x');
        }
        assert.ok(copies.every(f => fs.existsSync(f)));
        store.clear();
        assert.deepStrictEqual(copies.filter(f => fs.existsSync(f)), [], 'a copy of the history was kept');
        assert.deepStrictEqual(others.filter(f => !fs.existsSync(f)), [], 'a file that is not a copy was removed');
        // Its own journal is not a copy: the history still works.
        store.transaction(() => store.upsertRequests([req()]));
        assert.strictEqual([...store.requests()].length, 1);
    });

    test('Clear never removes the history another window has just started in its place', () => {
        const store = ready(open());
        const folder = path.dirname(file);
        // Started after this window found its history, before its Clear removed the copies.
        const theirs = createHistory(folder);
        assert.strictEqual(publishHistory(folder, theirs, resolveHistory(folder).pointer), theirs);
        fs.writeFileSync(`${file}.bak-v0`, 'x');
        assert.deepStrictEqual(store.clear(), { settled: true, copiesLeft: 0 });
        assert.deepStrictEqual([fs.existsSync(theirs), fs.existsSync(`${file}.bak-v0`)], [true, false]);
    });

    /** Files in the history's folder whose bytes hold `marker`. */
    function holding(marker: string): string[] {
        const folder = path.dirname(file);
        return fs.readdirSync(folder).filter(name => fs.statSync(path.join(folder, name)).isFile() && fs.readFileSync(path.join(folder, name)).includes(marker));
    }

    /** `n` requests whose model id and transcript carry `marker`, as text a recovery tool would find. */
    const marked = (marker: string, n: number) =>
        Array.from({ length: n }, (_, i) => req({ messageId: `m${i}`, requestId: `r${i}`, model: `${marker}-${i}`, file: `/root/projects/-${marker}/s${i % 4}.jsonl` }));

    test('Clear leaves nothing of the history readable on disk, while the history stays open', () => {
        // Another window's worker has it open too, idle, as a status item keeps it.
        const store = ready(open());
        const other = ready(open());
        store.transaction(() => store.upsertRequests(marked('Secret-Client-0xC0FFEE', 400)));
        assert.ok(holding('Secret-Client-0xC0FFEE').length > 0);
        assert.deepStrictEqual(store.clear(), { settled: true, copiesLeft: 0 });
        assert.deepStrictEqual(holding('Secret-Client-0xC0FFEE'), [], 'the deleted history is still on disk');
        assert.strictEqual([...other.requests()].length, 0);
    });

    test('a Clear in a build before this schema, which knows nothing of paths, leaves none of them on disk', () => {
        // A window not reloaded since the update, its history open since
        // before the migration: its Clear, as 2.2.0 runs it, empties the
        // tables it knows of, and bumps the generation.
        const store = ready(open());
        store.transaction(() => store.upsertRequests(marked('Secret-Project-0xD1CE', 40)));
        assert.ok(holding('Secret-Project-0xD1CE').length > 0);
        assert.ok(sqlite, 'this runtime has no node:sqlite');
        const old = new sqlite.DatabaseSync(file);
        try {
            old.exec('PRAGMA busy_timeout = 5000; PRAGMA secure_delete = ON; BEGIN IMMEDIATE');
            for (const table of ['files', 'read_guards', 'requests', 'sessions', 'compactions', 'limit_hits']) {
                old.exec(`DELETE FROM ${table}`);
            }
            old.exec("DELETE FROM lease; UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'store_generation'");
            old.exec('COMMIT');
            old.exec('VACUUM');
            old.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
        } finally {
            old.close();
        }
        assert.deepStrictEqual(holding('Secret-Project-0xD1CE'), [], "a transcript's path is still on disk");
        store.transaction(() => store.upsertRequests([req()]));
        assert.deepStrictEqual([...store.requests()].map(r => r.file), [req().file]);
    });

    test("a Clear another window's read holds off is finished, once that read ends, by whichever window comes next", () => {
        const store = ready(open({ busyTimeoutMs: 50 }));
        const reader = ready(open({ busyTimeoutMs: 50 }));
        store.transaction(() => store.upsertRequests(marked('Secret-Client-0xBEEF', 400)));
        reader.read(() => {
            // The read has begun: its snapshot holds the old pages.
            assert.strictEqual([...reader.requests()].length, 400);
            assert.strictEqual(store.clear().settled, false);
        });
        // The other window's own next request: it was told nothing, the history was.
        assert.deepStrictEqual(reader.finishClear(), { settled: true, copiesLeft: 0 });
        assert.deepStrictEqual(holding('Secret-Client-0xBEEF'), []);
        // Finished: nothing is left to do, in either window.
        assert.deepStrictEqual(store.finishClear(), { settled: true, copiesLeft: 0 });
    });

    test('a copy beside the history that cannot be removed leaves the Clear done; it is counted, and removed later', () => {
        const store = ready(open());
        store.transaction(() => store.upsertRequests([req()]));
        // A folder where a file was expected stands in for one held open elsewhere.
        fs.mkdirSync(`${file}.corrupt-1/inside`, { recursive: true });
        assert.deepStrictEqual(store.clear(), { settled: true, copiesLeft: 1 });
        assert.strictEqual([...store.requests()].length, 0);
        assert.deepStrictEqual(store.finishClear(), { settled: true, copiesLeft: 1 }, 'tried again, and counted again');
        // Let go of; and a copy set aside after the Clear, which is not the Clear's to remove.
        fs.rmSync(`${file}.corrupt-1`, { recursive: true });
        fs.writeFileSync(`${file}.corrupt-1`, 'x');
        fs.writeFileSync(`${file}.corrupt-2`, 'y');
        assert.deepStrictEqual(store.finishClear(), { settled: true, copiesLeft: 0 });
        assert.deepStrictEqual([fs.existsSync(`${file}.corrupt-1`), fs.existsSync(`${file}.corrupt-2`)], [false, true]);
        fs.writeFileSync(`${file}.corrupt-1`, 'x');
        store.finishClear();
        assert.ok(fs.existsSync(`${file}.corrupt-1`), 'a finished Clear went on removing files');
    });

    test('a copy an earlier build set aside by renaming it is named, the newest first, until Clear removes it', () => {
        const store = ready(open());
        assert.strictEqual(store.setAside(), undefined);
        fs.writeFileSync(`${file}.corrupt-1790000000000`, 'old');
        fs.writeFileSync(`${file}.corrupt-1791000000000`, 'older history, newer copy');
        assert.strictEqual(store.setAside(), 'usage.sqlite.corrupt-1791000000000');
        store.clear();
        assert.strictEqual(store.setAside(), undefined);
    });

    test("the latest main request, and what the session shows of its window, on that model alone", () => {
        const store = ready(open());
        const at = (minute: number) => Date.UTC(2026, 9, 9, 10) + minute * 60_000;
        let n = 0;
        const sent = (model: string, minute: number, context: number, extra: Partial<UsageRequest> = {}) => {
            n++;
            return req({ messageId: `m${n}`, requestId: `r${n}`, byteOffset: n, model, timestamp: at(minute), input: context, ...extra });
        };
        const latest = () => {
            const l = store.latestMainRequest('session-a');
            return [l?.model, l?.variant, l?.input, l?.largestContext];
        };
        store.transaction(() =>
            store.upsertRequests([
                // Sonnet 4.6 in its larger window first, far past 200K.
                sent('claude-sonnet-4-6', 0, 300_000, { variant: '1m' }),
                // Then Opus 4.6: one record names [1m], the latest does not.
                sent('claude-opus-4-6', 1, 120_000, { variant: '1m' }),
                sent('claude-opus-4-6', 2, 90_000),
                // A subagent's, in the main file: its own context, never the session's.
                sent('claude-opus-4-6', 3, 400_000, { isMain: false }),
            ]),
        );
        assert.deepStrictEqual(latest(), ['claude-opus-4-6', '1m', 90_000, 120_000]);
        // Back on Sonnet, with no record naming [1m]: nothing from before Opus counts.
        store.transaction(() => store.upsertRequests([sent('claude-sonnet-4-6', 4, 50_000)]));
        assert.deepStrictEqual(latest(), ['claude-sonnet-4-6', null, 50_000, 50_000]);
        // A compaction's size before, since then, is a context the window held;
        // one while Opus ran says nothing of Sonnet's.
        const compaction = (uuid: string, minute: number, preTokens: number) => ({ uuid, sessionId: 'session-a', kind: 'main' as const, timestamp: at(minute), trigger: 'auto', preTokens, postTokens: 1 });
        store.transaction(() => store.insertCompactions('claude-code', [compaction('on-opus', 1.5, 500_000), compaction('since', 5, 230_000)]));
        assert.deepStrictEqual(latest(), ['claude-sonnet-4-6', null, 50_000, 230_000]);
    });

    /** What the backup at `name` holds: its version, and each request's id and transcript. */
    function backedUp(name: string): unknown[] {
        assert.ok(sqlite, 'this runtime has no node:sqlite');
        const backup = new sqlite.DatabaseSync(name, { readOnly: true });
        try {
            return [
                (backup.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
                backup.prepare('SELECT message_id, file FROM requests ORDER BY message_id').all().map(r => [r.message_id, r.file]),
            ];
        } finally {
            backup.close();
        }
    }

    test('a version 1 history gains the speed and where each request ran, then keeps each path once, after a backup at each step, and keeps every row', () => {
        // Only development builds made one.
        const store = ready(open());
        store.transaction(() => store.upsertRequests([req({ messageId: 'kept', input: 5 })]));
        store.close();
        opened.length = 0;
        asSchema(file, 1);

        const migrated = ready(open());
        assert.deepStrictEqual([...migrated.requests()].map(r => [r.messageId, r.input, r.speed, r.inferenceGeo, r.file]), [['kept', 5, null, null, req().file]]);
        migrated.transaction(() => migrated.upsertRequests([req({ messageId: 'new', requestId: 'req_2', speed: 'fast', inferenceGeo: 'us' })]));
        assert.deepStrictEqual([...migrated.requests()].map(r => [r.messageId, r.speed, r.inferenceGeo]).sort(), [['kept', null, null], ['new', 'fast', 'us']]);
        // Each backup is the history as that step found it.
        assert.deepStrictEqual(backedUp(`${file}.bak-v1`), [1, [['kept', req().file]]]);
        assert.deepStrictEqual(backedUp(`${file}.bak-v2`), [2, [['kept', req().file]]]);
    });

    test("a migration's backup is made whole or not at all: a copy cut short is never taken for it", () => {
        // VACUUM INTO wrote the backup under its own name, and one that a full
        // disk cut short was trusted as the backup at the next attempt.
        const store = ready(open());
        store.transaction(() => store.upsertRequests([req({ messageId: 'kept' })]));
        store.close();
        opened.length = 0;
        asSchema(file, 2);
        assert.ok(sqlite, 'this runtime has no node:sqlite');
        const prototype = sqlite.DatabaseSync.prototype as unknown as { exec: (this: unknown, sql: string) => void };
        const exec = prototype.exec;
        prototype.exec = function (this: unknown, sql: string) {
            exec.call(this, sql);
            const copy = /^VACUUM INTO '(.*)'$/.exec(sql)?.[1]?.replace(/''/g, "'");
            if (copy) {
                // Half written, then the disk was full.
                fs.truncateSync(copy, Math.floor(fs.statSync(copy).size / 2));
                throw Object.assign(new Error('database or disk is full'), { errcode: 13 });
            }
        };
        try {
            assert.strictEqual(open().status, 'failed');
        } finally {
            prototype.exec = exec;
        }
        const backups = () => fs.readdirSync(path.dirname(file)).filter(name => name.includes('.bak-v'));
        assert.deepStrictEqual(backups(), [], 'a copy cut short was left, or taken for the backup');
        // The next attempt makes it whole, and migrates.
        const migrated = ready(open());
        assert.deepStrictEqual([...migrated.requests()].map(r => r.messageId), ['kept']);
        assert.deepStrictEqual(backups(), [`${path.basename(file)}.bak-v2`]);
        const backup = new sqlite.DatabaseSync(`${file}.bak-v2`, { readOnly: true });
        try {
            assert.deepStrictEqual({ ...backup.prepare('PRAGMA quick_check').get() }, { quick_check: 'ok' });
            assert.deepStrictEqual(backup.prepare('SELECT message_id FROM requests').all().map(r => ({ ...r })), [{ message_id: 'kept' }]);
        } finally {
            backup.close();
        }
    });

    test('a version 2 history keeps every row, and each path once, after a backup; the file shrinks by what the paths took', () => {
        // As 2.2.0 left it. Paths whose order as bytes is not the order they
        // were first stored in, so that ids cannot stand in for them.
        const store = ready(open());
        const paths = ['/r/b.jsonl', '/r/a.jsonl', '/r/\u{10000}.jsonl', '/r/\uffff.jsonl'].map(p => `/Users/someone/.claude/projects/-Users-someone-dev-project${p}`);
        store.transaction(() =>
            store.upsertRequests(
                Array.from({ length: 2_000 }, (_, i) =>
                    req({ messageId: `m${i}`, requestId: `r${i}`, file: paths[i % 4], byteOffset: i, speed: i % 2 ? 'fast' : null, inferenceGeo: i % 3 ? 'us' : null }),
                ),
            ),
        );
        assert.ok(store.acquireLease('import', 'window-a', 7));
        const rows = [...store.requests()];
        store.close();
        opened.length = 0;
        asSchema(file, 2);
        assert.ok(sqlite, 'this runtime has no node:sqlite');
        const vacuumed = new sqlite.DatabaseSync(file);
        vacuumed.exec('VACUUM');
        vacuumed.close();
        const before = fs.statSync(file).size;

        const migrated = ready(open());
        assert.deepStrictEqual([...migrated.requests()], rows);
        const raw = new sqlite.DatabaseSync(file, { readOnly: true });
        try {
            const one = (sql: string) => Object.values(raw.prepare(sql).get() ?? {})[0];
            assert.strictEqual(one('SELECT count(*) FROM paths'), 4);
            assert.strictEqual(one("SELECT count(*) FROM requests WHERE typeof(file) != 'integer'"), 0);
            // Nothing looked a request up by its request id.
            assert.deepStrictEqual(
                raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'requests' AND sql IS NOT NULL ORDER BY name").all().map(r => r.name),
                ['requests_file', 'requests_session', 'requests_ts'],
            );
        } finally {
            raw.close();
        }
        // Compacted: the old table's pages given back, and the log emptied.
        const after = fs.statSync(file).size + (fs.existsSync(`${file}-wal`) ? fs.statSync(`${file}-wal`).size : 0);
        assert.ok(after < before * 0.7, `${after} bytes after migrating, ${before} before`);

        // The tie-break still goes by the path, as UTF-8 bytes: of two
        // records alike, the one whose path comes first, whatever its id.
        // This one is stored last, under the largest id.
        const first = '/Users/someone/.claude/projects/-Users-someone-dev-project/r/0.jsonl';
        migrated.transaction(() => migrated.upsertRequests([req({ messageId: 'm0', requestId: 'r0', file: first, byteOffset: 9 })]));
        migrated.transaction(() => migrated.upsertRequests([req({ messageId: 'm2', requestId: 'r2', file: paths[3], byteOffset: 0 })]));
        assert.deepStrictEqual(
            [...migrated.requests()].filter(r => r.messageId === 'm0' || r.messageId === 'm2').map(r => [r.messageId, r.file, r.byteOffset]),
            [['m0', first, 9], ['m2', paths[3], 0]],
        );
        // The newest parser to hold the lease still keeps an older one out.
        assert.deepStrictEqual([migrated.outdated(6), migrated.outdated(7)], [true, false]);
        // The backup is the history as it was.
        const backup = backedUp(`${file}.bak-v2`) as [number, string[][]];
        assert.deepStrictEqual([backup[0], backup[1].length, backup[1].find(r => r[0] === 'm1')], [2, 2_000, ['m1', paths[1]]]);
    });

    test("a migration's log that another window's read holds on to is emptied at the next request", () => {
        // The table built anew passes through the log, as large as the table.
        const store = ready(open());
        store.transaction(() => store.upsertRequests(marked('Migrated-0xABBA', 2_000)));
        store.close();
        opened.length = 0;
        asSchema(file, 2);
        assert.ok(sqlite, 'this runtime has no node:sqlite');
        const reader = new sqlite.DatabaseSync(file);
        let migrated: UsageStore;
        try {
            reader.exec('BEGIN');
            reader.prepare('SELECT count(*) FROM requests').get();
            migrated = ready(open({ busyTimeoutMs: 50 }));
        } finally {
            reader.exec('COMMIT');
            reader.close();
        }
        assert.ok(fs.statSync(`${file}-wal`).size > 0, 'the premise: the log was held');
        assert.deepStrictEqual(migrated.finishClear(), { settled: true, copiesLeft: 0 });
        assert.strictEqual(fs.statSync(`${file}-wal`).size, 0, 'the log was left as large as the table');
        assert.ok(fs.existsSync(`${file}.bak-v2`), "the migration's backup went with it");
    });

    test('a build before this schema that had the history open as it was migrated stops writing, and says to reload', () => {
        // A window not reloaded since the update. 2.2.0 takes itself for
        // outdated, as when a newer parser has held the lease, once its
        // parser is older than `max_parser_version`; and its upsert would
        // write a path where an id now goes.
        const store = ready(open());
        store.transaction(() => store.upsertRequests([req()]));
        store.close();
        opened.length = 0;
        asSchema(file, 2);
        assert.ok(sqlite, 'this runtime has no node:sqlite');
        const old = new sqlite.DatabaseSync(file);
        try {
            const newest = () => Number((old.prepare("SELECT value FROM meta WHERE key = 'max_parser_version'").get() as { value: string } | undefined)?.value ?? 0);
            assert.strictEqual(newest(), 0);
            const migrated = ready(open());
            for (const parser of [2, 1_000]) {
                assert.ok(parser < newest(), `a build at parser ${parser} would go on importing`);
            }
            const write = old.prepare(
                `INSERT INTO requests (provider, message_id, parser_version, file, byte_offset, is_main, complete, ts, session_id, kind, model)
                 VALUES ('claude-code', 'msg_2', 2, '/root/projects/p/session-a.jsonl', 0, 1, 1, 0, 'session-a', 'main', 'm')`,
            );
            assert.throws(() => write.run(), /TEXT value in INTEGER column/);
            // This build is not outdated by it.
            assert.ok(!migrated.outdated(2));
            assert.ok(migrated.acquireLease('import', 'window-a', 2));
        } finally {
            old.close();
        }
    });

    test("a request's more complete record replaces its speed and where it ran with the rest of it", () => {
        const store = ready(open());
        store.transaction(() => store.upsertRequests([req({ messageId: 'm', output: 1 })]));
        store.transaction(() => store.upsertRequests([req({ messageId: 'm', output: 50, byteOffset: 10, speed: 'fast', inferenceGeo: 'us' })]));
        assert.deepStrictEqual([...store.requests()].map(r => [r.output, r.speed, r.inferenceGeo]), [[50, 'fast', 'us']]);
    });

    test('request sums are apart by speed, where the requests ran, and their prompt size past 100,000 and 200,000', () => {
        const store = ready(open());
        let n = 0;
        const sent = (input: number, extra: Partial<UsageRequest> = {}) =>
            req({ messageId: `m${++n}`, requestId: `r${n}`, input, cacheCreation: 0, cacheRead: 0, output: 1, ...extra });
        store.transaction(() =>
            store.upsertRequests([
                // Input, cache writes and cache reads together: 100,000, 100,001, 200,000 and 200,001.
                sent(100_000),
                sent(60_000, { cacheRead: 40_001 }),
                sent(200_000),
                sent(100_000, { cacheCreation: 100_001 }),
                sent(10, { speed: 'fast' }),
                sent(10, { inferenceGeo: 'us' }),
                // A counter missing: its size is unknown.
                sent(10, { cacheRead: null }),
            ]),
        );
        const sums = store.bucketSums(0).map(s => [s.promptSize, s.speed, s.inferenceGeo, s.requests]);
        assert.deepStrictEqual(sums.sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)), [
            ['100k-to-200k', null, null, 2],
            ['over-200k', null, null, 1],
            ['up-to-100k', 'fast', null, 1],
            ['up-to-100k', null, 'us', 1],
            ['up-to-100k', null, null, 1],
            [null, null, null, 1],
        ]);
    });

    test('a read sees one snapshot, whatever another window commits during it', () => {
        const store = ready(open());
        const other = ready(open());
        store.transaction(() => store.upsertRequests([req()]));
        const seen = store.read(() => {
            const before = [...store.requests()].length;
            other.transaction(() => other.upsertRequests([req({ messageId: 'msg_2', requestId: 'req_2' })]));
            return [before, [...store.requests()].length];
        });
        assert.deepStrictEqual(seen, [1, 1]);
        assert.strictEqual([...store.requests()].length, 2);
        assert.throws(() => store.read(() => { throw new Error('inside'); }), /inside/);
        assert.strictEqual(store.read(() => [...store.requests()].length), 2, 'a failed read left its transaction open');
    });

    test('a history created by a newer version opens read-only', () => {
        const first = ready(open());
        first.close();
        opened.length = 0;
        assert.ok(sqlite);
        const raw = new sqlite.DatabaseSync(file);
        raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
        raw.close();

        const result = open();
        assert.strictEqual(result.status, 'read-only');
        const store = result.store;
        assert.strictEqual([...store.requests()].length, 0, 'it should still be readable');
        assert.throws(() => store.transaction(() => store.upsertRequests([req()])), /newer LLM Tokenizer/);
    });

    test('a history a newer version created opens read-only, even without a column this version writes', () => {
        // As schema 3 had to keep the path's column, for the builds before it.
        ready(open()).close();
        opened.length = 0;
        assert.ok(sqlite, 'this runtime has no node:sqlite');
        const raw = new sqlite.DatabaseSync(file);
        raw.exec(`ALTER TABLE requests DROP COLUMN request_id; PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
        raw.close();
        const result = open();
        assert.strictEqual(result.status, 'read-only', JSON.stringify(result));
        assert.strictEqual(result.store.coverage().requests, 0);
    });

    for (const [what, schema] of [
        ['creates', 0],
        ['migrates', 2],
    ] as const) {
        test(`a history a newer build ${what} at the moment this one opens it opens read-only`, () => {
            // Both windows read the old version; the newer build has given it
            // its own by the time this one holds the write lock.
            assert.ok(sqlite, 'this runtime has no node:sqlite');
            const base = sqlite;
            if (schema > 0) {
                ready(open()).close();
                opened.length = 0;
                asSchema(file, 2);
            }
            const race = racing(() => {
                if (schema === 0) {
                    ready(UsageStore.open(base, file)).close();
                }
                const newer = new base.DatabaseSync(file);
                newer.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
                newer.close();
            });
            const result = UsageStore.open(race.sqlite, file);
            assert.ok(race.raced(), 'nothing ran between the two reads');
            if (result.status === 'ready' || result.status === 'read-only') {
                opened.push(result.store);
            }
            assert.strictEqual(result.status, 'read-only', JSON.stringify(result));
            assert.strictEqual(result.schema, SCHEMA_VERSION + 1);
            const store = result.store;
            assert.strictEqual(store.coverage().requests, 0);
            assert.throws(() => store.transaction(() => store.upsertRequests([req()])), /newer LLM Tokenizer/);
        });
    }

    test('a corrupt history opens as corrupt, and is left exactly as it is', () => {
        // Not renamed, not rewritten: a window may still have it open, and
        // it is the only copy of what the records on disk no longer hold.
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const bytes = Buffer.from('this is not a database, '.repeat(400));
        fs.writeFileSync(file, bytes);
        assert.deepStrictEqual(open(), { status: 'corrupt' });
        assert.ok(fs.readFileSync(file).equals(bytes), 'the corrupt file was touched');
    });

    test('a rollback journal is used where WAL cannot be trusted', () => {
        const result = open({ forceRollbackJournal: true });
        ready(result);
        assert.strictEqual(result.status === 'ready' && result.journal, 'delete');
    });

    test('one window holds the import lease until it goes quiet or is outdated', () => {
        let now = 1_000_000;
        const store = ready(open({ now: () => now }));

        assert.ok(store.acquireLease('import', 'window-a', 1));
        assert.ok(!store.acquireLease('import', 'window-b', 1), 'a fresh lease was taken over');
        now += 1_000;
        assert.ok(store.acquireLease('import', 'window-a', 1), 'its holder could not renew it');

        now += LEASE_TAKEOVER_MS + 1;
        assert.ok(store.acquireLease('import', 'window-b', 1), 'a stale lease was not released');
        assert.ok(!store.acquireLease('import', 'window-a', 1));

        // A window still running an older parser yields to a newer one at once.
        assert.ok(store.acquireLease('import', 'window-c', 2));
        assert.ok(!store.acquireLease('import', 'window-b', 1));

        // Released, it is free, for that parser or a newer one: not for the older.
        store.releaseLease('import', 'window-c');
        assert.ok(!store.acquireLease('import', 'window-b', 1), 'an older parser took the lease back');
        assert.ok(store.acquireLease('import', 'window-d', 2), 'a released lease stayed held');
    });

    test('a window that read an old version while another migrated skips what is already applied', () => {
        // Two windows opening one new store both read user_version 0; the
        // second gets the write lock after the first committed. Measured on
        // the editors' runtimes, its CREATE TABLE then failed in 1 opening in 5.
        ready(open()).close();
        opened.length = 0;
        assert.ok(sqlite, 'this runtime has no node:sqlite');
        const db = new sqlite.DatabaseSync(file);
        try {
            // A static that uses no `this`, called as a second window would.
            const migrate = (UsageStore as unknown as { migrate: (db: unknown, file: string, from: number) => number }).migrate;
            const meta = () => db.prepare('SELECT key, value FROM meta ORDER BY key').all().map(row => ({ ...row }));
            const before = meta();
            assert.strictEqual(migrate(db, file, 0), SCHEMA_VERSION);
            assert.deepStrictEqual(meta(), before, 'the second window wrote its own meta rows');
        } finally {
            db.close();
        }
    });

    test("a holder's pid is judged only on its own host", () => {
        // On a home shared over a network filesystem, another machine's pid
        // looks dead here; its lease must stand until its heartbeat ages.
        let now = 1_000_000;
        const store = ready(open({ now: () => now, isAlive: () => false }));
        assert.ok(sqlite);
        const raw = new sqlite.DatabaseSync(file);
        try {
            raw.prepare('INSERT OR REPLACE INTO lease (role, holder, host, pid, parser_version, heartbeat) VALUES (?, ?, ?, ?, ?, ?)')
                .run('import', 'remote-window', 'some-other-host', 4242, 1, now);
        } finally {
            raw.close();
        }
        assert.ok(!store.acquireLease('import', 'this-window', 1), "another host's lease was taken on a local pid check");
        now += LEASE_TAKEOVER_MS + 1;
        assert.ok(store.acquireLease('import', 'this-window', 1), 'a stale remote lease was never released');
    });

    test('Clear leaves no lease behind: one an import cut short left names this machine and a pid', () => {
        const store = ready(open());
        assert.ok(store.acquireLease('import', 'Holder-Marker-0xBEEF', 1));
        assert.deepStrictEqual(store.clear(), { settled: true, copiesLeft: 0 });
        assert.ok(sqlite, 'this runtime has no node:sqlite');
        const raw = new sqlite.DatabaseSync(file);
        try {
            assert.deepStrictEqual({ ...raw.prepare('SELECT count(*) AS n FROM lease').get() }, { n: 0 });
        } finally {
            raw.close();
        }
        assert.deepStrictEqual(holding('Holder-Marker-0xBEEF'), [], "the lease's holder is still on disk");
        // Another window takes it at once.
        assert.ok(store.acquireLease('import', 'next-window', 1));
    });

    test('once a newer parser has held the lease, an older one never takes it again, Clear or not', () => {
        let now = 1_000_000;
        const store = ready(open({ now: () => now }));
        assert.ok(store.acquireLease('import', 'reloaded-window', 2));
        store.releaseLease('import', 'reloaded-window');
        assert.ok(!store.acquireLease('import', 'old-window', 1), 'the older parser took a free lease');
        now += LEASE_TAKEOVER_MS * 10;
        assert.ok(!store.acquireLease('import', 'old-window', 1), 'the older parser took it once the heartbeat aged');
        assert.deepStrictEqual([store.outdated(1), store.outdated(2)], [true, false]);
        store.clear();
        assert.ok(store.outdated(1), 'Clear let the older parser back in');
    });

    test('a lease whose holder has exited is taken over at once', () => {
        // A window closed mid-import, or a test run that ended: no need to
        // wait out the heartbeat.
        let holderAlive = true;
        const store = ready(open({ isAlive: () => holderAlive }));
        assert.ok(store.acquireLease('import', 'window-a', 1));
        assert.ok(!store.acquireLease('import', 'window-b', 1));
        holderAlive = false;
        assert.ok(store.acquireLease('import', 'window-b', 1), 'a dead holder kept the lease');
    });
});
