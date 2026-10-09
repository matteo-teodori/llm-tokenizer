import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { dedupe } from '../../src/usage/accounting';
import { totalsOf } from '../../src/usage/aggregate';
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

suite('usage history store', () => {
    let dir: string;
    let file: string;
    const opened: UsageStore[] = [];

    function open(options = {}): OpenResult {
        assert.ok(sqlite, 'this runtime has no node:sqlite');
        const result = UsageStore.open(sqlite, file, options);
        if (result.status !== 'failed') {
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
        assert.strictEqual(SCHEMA_VERSION, 1);
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

    test('a corrupt history is set aside, not deleted, and a new one starts', () => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, 'this is not a database, '.repeat(400));

        const result = open({ now: () => 1_791_000_000_000 });
        const store = ready(result);
        assert.strictEqual(result.status === 'ready' && result.recoveredFrom, `${file}.corrupt-1791000000000`);
        assert.ok(fs.existsSync(`${file}.corrupt-1791000000000`), 'the corrupt file is gone');
        assert.strictEqual(store.generation(), 0);
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

        store.releaseLease('import', 'window-c');
        assert.ok(store.acquireLease('import', 'window-b', 1), 'a released lease stayed held');
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
            const migrate = (UsageStore as unknown as { migrate: (db: unknown, file: string, from: number) => void }).migrate;
            assert.doesNotThrow(() => migrate(db, file, 0));
            assert.strictEqual((db.prepare('SELECT count(*) AS n FROM meta').get() as { n: number }).n, 2, 'the second window wrote its own meta rows');
        } finally {
            db.close();
        }
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
