import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Worker } from 'worker_threads';

import {
    HistoryFileError,
    copiesBeside,
    createHistory,
    currentHistory,
    publishHistory,
    resolveHistory,
    type Pointer,
} from '../../src/usage/historyFiles';
import { UsageStore, loadSqlite, type OpenResult } from '../../src/usage/store';
import type { UsageRequest } from '../../src/usage/types';

const sqlite = loadSqlite();

function request(messageId: string): UsageRequest {
    return {
        provider: 'claude-code', messageId, requestId: null, sessionId: 's', kind: 'main', isMain: true, timestamp: Date.UTC(2026, 9, 9, 12),
        model: 'claude-opus-5-5', variant: null, speed: null, inferenceGeo: null, input: 1, cacheCreation: 0, cacheRead: 0, output: 1, cacheWrite5m: null, cacheWrite1h: null,
        thinking: null, effort: null, webSearchRequests: null, webFetchRequests: null, claudeCodeVersion: null, agentId: null, runId: null,
        file: '/f.jsonl', byteOffset: 0, parserVersion: 1,
    };
}

/** Permissions hold here: not on Windows, and not for root. */
const permissionsHold = process.platform !== 'win32' && process.getuid?.() !== 0;

suite('usage history files', () => {
    let folder: string;
    let pointer: string;
    const opened: UsageStore[] = [];

    function open(file: string): UsageStore {
        assert.ok(sqlite, 'this runtime has no node:sqlite');
        const result: OpenResult = UsageStore.open(sqlite, file);
        assert.strictEqual(result.status, 'ready');
        opened.push(result.store);
        return result.store;
    }

    /** A new history, published over the pointer as it is now: what a window starting one does. */
    function start(): string {
        const file = createHistory(folder);
        return publishHistory(folder, file, resolveHistory(folder).pointer);
    }

    setup(() => {
        folder = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'llm-tokenizer-histories-')), 'claude-code-usage');
        pointer = path.join(folder, 'usage.current');
    });

    teardown(() => {
        for (const store of opened.splice(0)) {
            try {
                store.close();
            } catch {
                // Closed by the test.
            }
        }
        if (fs.existsSync(pointer)) {
            fs.chmodSync(pointer, 0o600);
        }
        fs.rmSync(path.dirname(folder), { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    });

    test('a new history gets a name no history has had, and is in use once the pointer names it', () => {
        assert.strictEqual(currentHistory(folder), undefined);
        const first = start();
        const second = start();
        assert.notStrictEqual(first, second);
        assert.match(path.basename(second), /^usage-[0-9a-z]+\.sqlite$/);
        assert.strictEqual(fs.readFileSync(pointer, 'utf8'), path.basename(second));
        assert.strictEqual(currentHistory(folder), second);
        // Its file is there before its name is published: a window that follows the pointer finds it.
        assert.ok(fs.statSync(second).isFile());
    });

    test('without a pointer the old name is in use; a pointer whose history is gone falls back on the newest there', () => {
        const legacy = path.join(folder, 'usage.sqlite');
        open(legacy).close();
        assert.strictEqual(currentHistory(folder), legacy);
        const older = start();
        const newer = start();
        assert.strictEqual(currentHistory(folder), newer);
        // Deleted by hand, say: the newest still there is used, never a new,
        // empty one, nor the legacy one it replaced.
        fs.rmSync(newer);
        assert.strictEqual(currentHistory(folder), older);
        // No pointer at all: the legacy name is in use, while it is there.
        fs.rmSync(pointer);
        assert.strictEqual(currentHistory(folder), legacy);
        fs.rmSync(legacy);
        assert.strictEqual(currentHistory(folder), older);
    });

    test('a pointer that cannot be read fails, and changes nothing', function () {
        if (!permissionsHold) {
            this.skip();
        }
        const history = start();
        fs.chmodSync(pointer, 0o000);
        assert.throws(() => resolveHistory(folder), HistoryFileError);
        fs.chmodSync(pointer, 0o600);
        assert.strictEqual(currentHistory(folder), history);
        assert.strictEqual(fs.readFileSync(pointer, 'utf8'), path.basename(history));
    });

    test('a pointer this version cannot read as a name is never followed and never replaced', () => {
        const older = start();
        const newest = createHistory(folder);
        const outside = path.join(path.dirname(folder), 'outside.sqlite');
        fs.writeFileSync(outside, 'not a history of this folder');
        const writes: [string, () => void][] = [
            ['a path out of the folder', () => fs.writeFileSync(pointer, '../outside.sqlite')],
            ['another name', () => fs.writeFileSync(pointer, 'other.db')],
            ['a journal', () => fs.writeFileSync(pointer, `${path.basename(older)}-wal`)],
            ['nothing', () => fs.writeFileSync(pointer, '')],
            ['a later layout', () => fs.writeFileSync(pointer, 'v3:usage-2.db')],
            ['too large to be a name', () => fs.writeFileSync(pointer, `${path.basename(older)}\n${'x'.repeat(1000)}`)],
            ['a folder', () => fs.mkdirSync(pointer)],
        ];
        if (process.platform !== 'win32') {
            writes.push(['a link to a name', () => fs.symlinkSync(path.basename(older), pointer)]);
            writes.push(['a FIFO', () => execFileSync('mkfifo', [pointer])]);
        }
        for (const [what, write] of writes) {
            fs.rmSync(pointer, { recursive: true, force: true });
            write();
            const before = fs.lstatSync(pointer);
            const resolved = resolveHistory(folder);
            assert.deepStrictEqual(resolved.pointer, { kind: 'unknown' } satisfies Pointer, what);
            // The newest history there is the one in use, and one started now is not published over it.
            assert.strictEqual(resolved.file, newest, what);
            const another = createHistory(folder);
            assert.strictEqual(publishHistory(folder, another, resolved.pointer), another, what);
            const after = fs.lstatSync(pointer);
            assert.deepStrictEqual([after.ino, after.size, after.mtimeMs], [before.ino, before.size, before.mtimeMs], `${what} was replaced`);
            fs.rmSync(another);
        }
    });

    test('nothing but a regular file is taken for a history', () => {
        const history = start();
        fs.writeFileSync(path.join(path.dirname(folder), 'elsewhere.sqlite'), '');
        const named = (name: string) => fs.writeFileSync(pointer, name);
        // Names of this layout, started after the history: each would be the newest.
        const started = Date.now();
        while (Date.now() === started) {
            // A millisecond later than the history.
        }
        const later = (hex: string) => `usage-${Date.now().toString(36)}${hex.repeat(12)}.sqlite`;
        // A folder where the pointer's history should be, and newer than any history.
        const folderName = later('f');
        fs.mkdirSync(path.join(folder, folderName));
        named(folderName);
        assert.strictEqual(currentHistory(folder), history);
        if (process.platform !== 'win32') {
            // A link named like a history, dangling or not: never followed out of the folder.
            const link = later('e');
            const dangling = later('d');
            fs.symlinkSync(path.join(path.dirname(folder), 'elsewhere.sqlite'), path.join(folder, link));
            fs.symlinkSync(path.join(path.dirname(folder), 'nowhere.sqlite'), path.join(folder, dangling));
            named(link);
            assert.strictEqual(currentHistory(folder), history);
            named(dangling);
            assert.strictEqual(currentHistory(folder), history);
            fs.rmSync(pointer);
            fs.symlinkSync(path.join(path.dirname(folder), 'elsewhere.sqlite'), path.join(folder, 'usage.sqlite'));
            assert.strictEqual(currentHistory(folder), history, 'a link as the legacy history was followed');
        }
    });

    test('the newest history is one this version started, never one dated after this clock', () => {
        const history = start();
        // No pointer and no legacy history: the newest is the one in use.
        fs.rmSync(pointer);
        const year = 365 * 24 * 60 * 60 * 1000;
        fs.writeFileSync(path.join(folder, `usage-${(Date.now() + year).toString(36)}0123456789ab.sqlite`), '');
        fs.writeFileSync(path.join(folder, 'usage-zzzzzzzzzzzzzzzzzzzzzzzzzzzz.sqlite'), '');
        fs.writeFileSync(path.join(folder, `usage-${(Date.now() - year).toString(36)}0123456789ab.sqlite`), '');
        assert.strictEqual(currentHistory(folder), history);
    });

    test('two windows starting a history at once both use the one published first', () => {
        // The first history in a fresh folder: the second window finds the first's pointer.
        const a = createHistory(folder);
        const b = createHistory(folder);
        const fresh = resolveHistory(folder).pointer;
        assert.strictEqual(publishHistory(folder, a, fresh), a);
        assert.strictEqual(publishHistory(folder, b, fresh), a);
        // Both found that history corrupt: the second follows the first's replacement.
        const found: Pointer = { kind: 'name', name: path.basename(a) };
        const c = createHistory(folder);
        const d = createHistory(folder);
        assert.strictEqual(publishHistory(folder, c, found), c);
        assert.strictEqual(publishHistory(folder, d, found), c);
        assert.strictEqual(currentHistory(folder), c);
        // No temporary file is left beside the pointer.
        assert.deepStrictEqual(fs.readdirSync(folder).filter(name => name.startsWith('usage.current.')), []);
    });

    test('one window at a time replaces the pointer: one that comes while another does waits, then follows it', () => {
        // Both found the history corrupt. Read, compared and renamed with no
        // lock, the second passed the compare while the first was between its
        // compare and its rename: both renamed, and each kept its own history.
        const a = start();
        const found: Pointer = { kind: 'name', name: path.basename(a) };
        const c = createHistory(folder);
        const d = createHistory(folder);
        // The module itself, as historyFiles.ts sees it, not this file's view of it.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const shared = require('fs') as { renameSync: typeof fs.renameSync };
        const original = shared.renameSync;
        let meanwhile: unknown;
        let entered = false;
        shared.renameSync = (from: fs.PathLike, to: fs.PathLike) => {
            if (to === pointer && !entered) {
                // The second window, while the first is about to rename.
                entered = true;
                try {
                    meanwhile = publishHistory(folder, d, found, { lockWaitMs: 50 });
                } catch (error) {
                    meanwhile = error;
                }
            }
            original(from, to);
        };
        try {
            assert.strictEqual(publishHistory(folder, c, found), c);
        } finally {
            shared.renameSync = original;
        }
        assert.ok(meanwhile instanceof HistoryFileError && meanwhile.code === 'EBUSY', `the second window got in: ${String(meanwhile)}`);
        // At its next request it follows the first, and the lock is gone.
        assert.strictEqual(publishHistory(folder, d, found), c);
        assert.strictEqual(currentHistory(folder), c);
        assert.deepStrictEqual(fs.readdirSync(folder).filter(name => name.startsWith('usage.current.')), []);
    });

    test('a lock another window holds is waited on, then given up; one left by a window that died is taken over', () => {
        const a = start();
        const found: Pointer = { kind: 'name', name: path.basename(a) };
        const lock = path.join(folder, 'usage.current.lock');
        fs.writeFileSync(lock, '');
        const c = createHistory(folder);
        assert.throws(
            () => publishHistory(folder, c, found, { lockWaitMs: 50 }),
            (error: unknown) => error instanceof HistoryFileError && error.code === 'EBUSY',
        );
        // The request fails and changes nothing: not the pointer, not the other window's lock.
        assert.strictEqual(fs.readFileSync(pointer, 'utf8'), path.basename(a));
        assert.ok(fs.existsSync(lock), "another window's lock was removed");
        // Older than any window holds it: left by one that died holding it.
        const old = (Date.now() - 60_000) / 1000;
        fs.utimesSync(lock, old, old);
        assert.strictEqual(publishHistory(folder, c, found, { lockWaitMs: 50 }), c);
        assert.strictEqual(fs.readFileSync(pointer, 'utf8'), path.basename(c));
        assert.deepStrictEqual(fs.readdirSync(folder).filter(name => name.startsWith('usage.current.')), []);
    });

    test('a window that finds the lock held waits for it to be let go, then goes on', async () => {
        const a = start();
        const found: Pointer = { kind: 'name', name: path.basename(a) };
        const lock = path.join(folder, 'usage.current.lock');
        fs.writeFileSync(lock, '');
        // Another window lets go of it while this one waits, well before it would count as left.
        const other = new Worker(`setTimeout(() => require('fs').rmSync(${JSON.stringify(lock)}), 100)`, { eval: true });
        const c = createHistory(folder);
        try {
            assert.strictEqual(publishHistory(folder, c, found, { lockWaitMs: 2_000 }), c);
        } finally {
            await other.terminate();
        }
        assert.strictEqual(currentHistory(folder), c);
    });

    test("copies are every history file beside the current one but the current one's own", () => {
        const current = start();
        open(current);
        const names = [
            'usage.sqlite',
            'usage.sqlite-wal',
            'usage.sqlite-journal',
            'usage-0a1b2c3d4e.sqlite',
            'usage-0a1b2c3d4e.sqlite-shm',
            'usage-0a1b2c3d4e.sqlite-journal',
            'usage.sqlite.corrupt-1',
            `${path.basename(current)}.bak-v0`,
        ];
        for (const name of [...names, 'usage.current', `${path.basename(current)}-journal`, 'notes.txt', 'other.sqlite']) {
            fs.writeFileSync(path.join(folder, name), 'x');
        }
        assert.deepStrictEqual(copiesBeside(current).sort(), [...names].sort());
    });

    test("a window still holding the history set aside lets it go without touching the new one's journal", () => {
        // Window A has the old history open; window B finds it corrupt and
        // starts a new one beside it, writes to it, and keeps it open.
        const a = open(path.join(folder, 'usage.sqlite'));
        a.transaction(() => a.upsertRequests([request('a')]));
        const next = start();
        const b = open(next);
        b.transaction(() => b.upsertRequests([request('b')]));
        assert.ok(fs.existsSync(`${next}-wal`));
        // A lets go: SQLite deletes the -wal and -shm of A's file by name.
        a.close();
        assert.ok(fs.existsSync(`${next}-wal`) && fs.existsSync(`${next}-shm`), "the new history's journal files were deleted");
        assert.deepStrictEqual([...open(next).requests()].map(r => r.messageId), ['b']);
    });
});
