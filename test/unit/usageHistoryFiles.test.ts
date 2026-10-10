import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { copiesBeside, currentHistory, startHistory } from '../../src/usage/historyFiles';
import { UsageStore, loadSqlite, type OpenResult } from '../../src/usage/store';
import type { UsageRequest } from '../../src/usage/types';

const sqlite = loadSqlite();

function request(messageId: string): UsageRequest {
    return {
        provider: 'claude-code', messageId, requestId: null, sessionId: 's', kind: 'main', isMain: true, timestamp: Date.UTC(2026, 9, 9, 12),
        model: 'claude-opus-5-5', variant: null, input: 1, cacheCreation: 0, cacheRead: 0, output: 1, cacheWrite5m: null, cacheWrite1h: null,
        thinking: null, effort: null, webSearchRequests: null, webFetchRequests: null, claudeCodeVersion: null, agentId: null, runId: null,
        file: '/f.jsonl', byteOffset: 0, parserVersion: 1,
    };
}

suite('usage history files', () => {
    let folder: string;
    const opened: UsageStore[] = [];

    function open(file: string): UsageStore {
        assert.ok(sqlite, 'this runtime has no node:sqlite');
        const result: OpenResult = UsageStore.open(sqlite, file);
        assert.strictEqual(result.status, 'ready');
        opened.push(result.store);
        return result.store;
    }

    setup(() => {
        folder = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'llm-tokenizer-histories-')), 'claude-code-usage');
    });

    teardown(() => {
        for (const store of opened.splice(0)) {
            try {
                store.close();
            } catch {
                // Closed by the test.
            }
        }
        fs.rmSync(path.dirname(folder), { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    });

    test('a new history gets a name no history has had, and the pointer names it', () => {
        assert.strictEqual(currentHistory(folder), undefined);
        const first = startHistory(folder);
        const second = startHistory(folder);
        assert.notStrictEqual(first, second);
        assert.match(path.basename(second), /^usage-[0-9a-z]+\.sqlite$/);
        assert.strictEqual(currentHistory(folder), undefined, 'a history that has no file yet is not in use');
        open(second);
        assert.strictEqual(currentHistory(folder), second);
    });

    test('without a pointer the old name is in use; a pointer at a file that is gone names none', () => {
        const legacy = path.join(folder, 'usage.sqlite');
        open(legacy);
        assert.strictEqual(currentHistory(folder), legacy);
        // Deleted by hand, say: started again under a new name, never under the old one.
        const named = startHistory(folder);
        assert.strictEqual(currentHistory(folder), undefined);
        open(named);
        assert.strictEqual(currentHistory(folder), named);
    });

    test('a pointer naming anything but a history is not followed', () => {
        const legacy = path.join(folder, 'usage.sqlite');
        open(legacy);
        for (const name of ['../../escape.sqlite', 'other.db', 'usage-x.sqlite-wal', '']) {
            fs.writeFileSync(path.join(folder, 'usage.current'), name);
            assert.strictEqual(currentHistory(folder), legacy, JSON.stringify(name));
        }
    });

    test("copies are every history file beside the current one but the current one's own", () => {
        const current = startHistory(folder);
        open(current);
        const names = ['usage.sqlite', 'usage.sqlite-wal', 'usage-0a1b2c3d4e.sqlite', 'usage-0a1b2c3d4e.sqlite-shm', 'usage.sqlite.corrupt-1', `${path.basename(current)}.bak-v0`];
        for (const name of [...names, 'usage.current', 'notes.txt', 'other.sqlite']) {
            fs.writeFileSync(path.join(folder, name), 'x');
        }
        assert.deepStrictEqual(copiesBeside(current).sort(), [...names].sort());
    });

    test("a window still holding the history set aside lets it go without touching the new one's journal", () => {
        // Window A has the old history open; window B finds it corrupt and
        // starts a new one beside it, writes to it, and keeps it open.
        const a = open(path.join(folder, 'usage.sqlite'));
        a.transaction(() => a.upsertRequests([request('a')]));
        const next = startHistory(folder);
        const b = open(next);
        b.transaction(() => b.upsertRequests([request('b')]));
        assert.ok(fs.existsSync(`${next}-wal`));
        // A lets go: SQLite deletes the -wal and -shm of A's file by name.
        a.close();
        assert.ok(fs.existsSync(`${next}-wal`) && fs.existsSync(`${next}-shm`), "the new history's journal files were deleted");
        assert.deepStrictEqual([...open(next).requests()].map(r => r.messageId), ['b']);
    });
});
