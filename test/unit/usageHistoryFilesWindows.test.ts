import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { HistoryFileError, createHistory, currentHistory, publishHistory, resolveHistory, type Pointer } from '../../src/usage/historyFiles';
import type { UsageWorkerRequest, UsageWorkerResponse } from '../../src/usage/protocol';
import { SCHEMA_VERSION, UsageStore, loadSqlite } from '../../src/usage/store';
import { WorkerHost } from '../../src/workerHost';

const FIXTURE_ROOT = path.join(__dirname, '..', '..', '..', 'test', 'fixtures', 'claude-config');
/** The worker as the extension ships it. */
const WORKER = path.join(__dirname, '..', '..', '..', 'out', 'usageWorker.js');
const sqlite = loadSqlite();

/** The fs module historyFiles.ts and store.ts call into, as they see it. */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const shared = require('fs') as Record<string, unknown>;

type Call = (...args: unknown[]) => unknown;

/** `work`, with `name` on the shared fs module replaced for its length. */
function patched<T>(name: string, replacement: (original: Call) => Call, work: () => T): T {
    const original = shared[name] as Call;
    shared[name] = replacement(original);
    try {
        return work();
    } finally {
        shared[name] = original;
    }
}

/** `work`, with both ways of removing a file replaced. */
function removalsPatched<T>(replacement: (original: Call) => Call, work: () => T): T {
    return patched('rmSync', replacement, () => patched('unlinkSync', replacement, work));
}

/** `work` as Windows runs it, as far as process.platform tells. */
function asWindows<T>(work: () => T): T {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
        return work();
    } finally {
        Object.defineProperty(process, 'platform', platform);
    }
}

const refused = (code: string) => Object.assign(new Error(`${code}: refused by the test`), { code });

suite('usage history files, where Windows refuses a file for a moment', () => {
    let folder: string;
    let pointer: string;
    let lock: string;

    setup(() => {
        folder = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'llm-tokenizer-windows-')), 'claude-code-usage');
        pointer = path.join(folder, 'usage.current');
        lock = path.join(folder, 'usage.current.lock');
    });

    teardown(() => {
        fs.rmSync(path.dirname(folder), { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    });

    /** A history in use, and the pointer as a window that found it corrupt read it. */
    function inUse(): Pointer {
        const first = createHistory(folder);
        publishHistory(folder, first, resolveHistory(folder).pointer);
        return { kind: 'name', name: path.basename(first) };
    }

    test('a lock another window has just let go of, still delete pending, is waited for: its EPERM is no failure', () => {
        const found = inUse();
        const next = createHistory(folder);
        let refusals = 0;
        const used = asWindows(() =>
            patched(
                'openSync',
                original =>
                    (...args) => {
                        if (args[0] === lock && args[1] === 'wx' && refusals < 2) {
                            refusals++;
                            throw refused('EPERM');
                        }
                        return original(...args);
                    },
                () => publishHistory(folder, next, found, { lockWaitMs: 1_000 }),
            ),
        );
        assert.strictEqual(refusals, 2);
        assert.strictEqual(used, next);
        assert.strictEqual(currentHistory(folder), next);
    });

    test('a lock that cannot be removed afterwards leaves the publish done, and is taken over once stale', function () {
        this.timeout(10_000);
        const found = inUse();
        const next = createHistory(folder);
        const used = asWindows(() =>
            removalsPatched(
                original =>
                    (...args) => {
                        if (args[0] === lock) {
                            throw refused('EPERM');
                        }
                        return original(...args);
                    },
                () => publishHistory(folder, next, found),
            ),
        );
        assert.strictEqual(used, next, 'a publish the pointer shows was reported as failed');
        assert.strictEqual(fs.readFileSync(pointer, 'utf8'), path.basename(next));
        assert.ok(fs.statSync(next).isFile());
        // Left behind, it is taken over once older than any window holds it.
        assert.ok(fs.existsSync(lock));
        const old = (Date.now() - 60_000) / 1000;
        fs.utimesSync(lock, old, old);
        const after = createHistory(folder);
        assert.strictEqual(publishHistory(folder, after, { kind: 'name', name: path.basename(next) }, { lockWaitMs: 50 }), after);
    });

    test('a temporary file that cannot be removed leaves the first publish done, and is swept once old', function () {
        this.timeout(10_000);
        const first = createHistory(folder);
        const used = asWindows(() =>
            removalsPatched(
                original =>
                    (...args) => {
                        if (/usage\.current\.[0-9a-f]{12}$/.test(String(args[0]))) {
                            throw refused('EBUSY');
                        }
                        return original(...args);
                    },
                () => publishHistory(folder, first, resolveHistory(folder).pointer),
            ),
        );
        assert.strictEqual(used, first);
        assert.strictEqual(currentHistory(folder), first);
        const [left] = fs.readdirSync(folder).filter(name => /^usage\.current\.[0-9a-f]{12}$/.test(name));
        assert.ok(left, 'the refused temporary file was not left, as the test means it to be');
        // Another window's, in flight, is never touched; one long left is swept by the next publish.
        const inFlight = path.join(folder, 'usage.current.0123456789ab');
        fs.writeFileSync(inFlight, '');
        const old = (Date.now() - 120_000) / 1000;
        fs.utimesSync(path.join(folder, left), old, old);
        publishHistory(folder, createHistory(folder), { kind: 'name', name: path.basename(first) });
        assert.deepStrictEqual(
            fs.readdirSync(folder).filter(name => /^usage\.current\.[0-9a-f]{12}$/.test(name)),
            ['usage.current.0123456789ab'],
        );
    });

    test("a link refused for a moment is tried again, and never replaces another window's pointer", () => {
        const a = createHistory(folder);
        const b = createHistory(folder);
        const fresh = resolveHistory(folder).pointer;
        assert.strictEqual(publishHistory(folder, a, fresh), a);
        let refusals = 0;
        const used = asWindows(() =>
            patched(
                'linkSync',
                original =>
                    (...args) => {
                        if (refusals < 1) {
                            refusals++;
                            throw refused('EBUSY');
                        }
                        return original(...args);
                    },
                () => publishHistory(folder, b, fresh),
            ),
        );
        assert.strictEqual(used, a, 'the second window kept a history of its own');
        assert.strictEqual(currentHistory(folder), a);
    });

    test('a lock that cannot be looked at is waited on, then given up, never spun on', () => {
        const found = inUse();
        fs.writeFileSync(lock, '');
        const next = createHistory(folder);
        let looks = 0;
        const blind = (original: Call) => (...args: unknown[]) => {
            if (args[0] === lock) {
                looks++;
                throw refused('ENOENT');
            }
            return original(...args);
        };
        // Past this many looks in 50 ms the loop is spinning: the create then
        // says so, as an error nothing in the loop takes for a held lock.
        const bounded = (original: Call) => (...args: unknown[]) => {
            if (args[0] === lock && looks > 20_000) {
                throw refused('ESPUN');
            }
            return original(...args);
        };
        assert.throws(
            () =>
                patched('openSync', bounded, () =>
                    patched('statSync', blind, () => patched('lstatSync', blind, () => publishHistory(folder, next, found, { lockWaitMs: 50 }))),
                ),
            (error: unknown) => error instanceof HistoryFileError && error.code === 'EBUSY',
        );
        assert.ok(looks < 20_000, `${looks} looks in 50 ms`);
    });

    test('a stale lock another window took over meanwhile is not removed under it', () => {
        const found = inUse();
        fs.writeFileSync(lock, 'left by a window that died');
        const old = (Date.now() - 60_000) / 1000;
        fs.utimesSync(lock, old, old);
        const next = createHistory(folder);
        // Just after this window finds it stale, another window does too,
        // removes it and holds a lock of its own.
        let swapped = false;
        const late = (original: Call) => (...args: unknown[]) => {
            const result = original(...args);
            if (args[0] === lock && !swapped) {
                swapped = true;
                fs.unlinkSync(lock);
                fs.writeFileSync(lock, 'the other window holds it');
            }
            return result;
        };
        assert.throws(
            () => patched('statSync', late, () => patched('lstatSync', late, () => publishHistory(folder, next, found, { lockWaitMs: 50 }))),
            (error: unknown) => error instanceof HistoryFileError && error.code === 'EBUSY',
        );
        assert.strictEqual(fs.readFileSync(lock, 'utf8'), 'the other window holds it');
        assert.strictEqual(fs.readFileSync(pointer, 'utf8'), found.kind === 'name' ? found.name : '');
    });

    test('a lock taken over while this window holds it: the pointer is left to the window that took it, and so is its lock', () => {
        const found = inUse();
        const next = createHistory(folder);
        // Inside this window's hold, before it replaces the pointer, another
        // window that found the lock stale removes it and makes its own.
        let armed = true;
        const takenOver = (original: Call) => (...args: unknown[]) => {
            if (armed && args[0] === pointer && fs.existsSync(lock)) {
                armed = false;
                fs.unlinkSync(lock);
                fs.writeFileSync(lock, 'the other window holds it');
            }
            return original(...args);
        };
        assert.throws(
            () => patched('lstatSync', takenOver, () => publishHistory(folder, next, found, { lockWaitMs: 50 })),
            (error: unknown) => error instanceof HistoryFileError && error.code === 'EBUSY',
        );
        assert.ok(!armed, 'the lock was never taken over, as the test means it to be');
        assert.strictEqual(fs.readFileSync(pointer, 'utf8'), found.kind === 'name' ? found.name : '');
        assert.strictEqual(fs.readFileSync(lock, 'utf8'), 'the other window holds it');
    });

    test('a rename Windows refuses for 600 ms is waited out, not given up after 280', function () {
        this.timeout(10_000);
        const found = inUse();
        const next = createHistory(folder);
        const until = Date.now() + 600;
        const used = asWindows(() =>
            patched(
                'renameSync',
                original =>
                    (...args) => {
                        if (args[1] === pointer && Date.now() < until) {
                            throw refused('EPERM');
                        }
                        return original(...args);
                    },
                () => publishHistory(folder, next, found),
            ),
        );
        assert.strictEqual(used, next);
        assert.strictEqual(currentHistory(folder), next);
    });
});

suite('usage history copies, where the folder cannot be listed for a moment', () => {
    let tmp: string;
    const opened: UsageStore[] = [];

    setup(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-tokenizer-windows-store-'));
    });

    teardown(() => {
        for (const store of opened.splice(0)) {
            store.close();
        }
        fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    });

    function store(): { store: UsageStore; copy: string } {
        assert.ok(sqlite, 'this runtime has no node:sqlite');
        const result = UsageStore.open(sqlite, path.join(tmp, 'usage.sqlite'));
        assert.strictEqual(result.status, 'ready');
        opened.push(result.store);
        const copy = path.join(tmp, 'usage.sqlite.corrupt-1');
        fs.writeFileSync(copy, 'a copy of the history an earlier build set aside');
        return { store: result.store, copy };
    }

    const listingRefusedOnce = (original: Call) => {
        let refusals = 0;
        return (...args: unknown[]) => {
            if (refusals++ < 1) {
                throw refused('EPERM');
            }
            return original(...args);
        };
    };

    test('a Clear that cannot list the copies beside the history fails, rather than leave one it says is gone', () => {
        const { store: history, copy } = store();
        assert.throws(() => patched('readdirSync', listingRefusedOnce, () => history.clear()), HistoryFileError);
        assert.ok(fs.existsSync(copy));
        assert.deepStrictEqual(history.clear(), { settled: true, copiesLeft: 0 });
        assert.ok(!fs.existsSync(copy), 'the copy outlived a Clear');
    });

    test('a Clear left to finish keeps every copy it listed while the folder cannot be listed', () => {
        const { store: history, copy } = store();
        // Open in another window, say: not removable at the Clear.
        const outcome = removalsPatched(
            original =>
                (...args) => {
                    if (args[0] === copy) {
                        throw refused('EBUSY');
                    }
                    return original(...args);
                },
            () => history.clear(),
        );
        assert.strictEqual(outcome.copiesLeft, 1);
        patched('readdirSync', listingRefusedOnce, () => history.finishClear());
        assert.deepStrictEqual(history.finishClear(), { settled: true, copiesLeft: 0 });
        assert.ok(!fs.existsSync(copy), 'the copy was dropped from the Clear while the folder could not be listed');
    });

    test('a new history is created whole: no other window ever finds it at a version between', () => {
        assert.ok(sqlite, 'this runtime has no node:sqlite');
        const file = path.join(tmp, 'new.sqlite');
        const prototype = sqlite.DatabaseSync.prototype as unknown as { exec: (this: unknown, sql: string) => void };
        const exec = prototype.exec;
        const seen: number[] = [];
        prototype.exec = function (this: unknown, sql: string) {
            exec.call(this, sql);
            if (sql === 'COMMIT') {
                // What another window opening it now reads.
                const other = new sqlite.DatabaseSync(file, { readOnly: true });
                seen.push(Number((other.prepare('PRAGMA user_version').get() as { user_version: number }).user_version));
                other.close();
            }
        };
        let result;
        try {
            result = UsageStore.open(sqlite, file);
        } finally {
            prototype.exec = exec;
        }
        assert.strictEqual(result.status, 'ready');
        if (result.status === 'ready') {
            opened.push(result.store);
        }
        assert.deepStrictEqual(seen, [SCHEMA_VERSION]);
        assert.deepStrictEqual(fs.readdirSync(tmp).filter(name => name.includes('.bak-v')), []);
    });
});

suite('usage worker, where Windows refuses a step after the pointer is replaced', () => {
    let tmp: string;
    const hosts: WorkerHost<UsageWorkerRequest, UsageWorkerResponse>[] = [];

    setup(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-tokenizer-windows-worker-'));
    });

    teardown(async () => {
        await Promise.all(hosts.splice(0).map(h => h.dispose()));
        fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    });

    test('a publish that throws once the pointer names the new history keeps that history, and uses it', async () => {
        const folder = path.join(tmp, 'store');
        fs.mkdirSync(folder, { recursive: true });
        const corrupt = `usage-${(Date.now() - 60_000).toString(36)}0123456789ab.sqlite`;
        fs.writeFileSync(path.join(folder, corrupt), 'this is not a database, '.repeat(400));
        fs.writeFileSync(path.join(folder, 'usage.current'), corrupt);
        // The shipped worker, with the rename onto the pointer done, then reported as failed.
        const injected = path.join(tmp, 'injected-worker.js');
        fs.writeFileSync(
            injected,
            `const fs = require('fs');
const path = require('path');
const rename = fs.renameSync;
let once = false;
fs.renameSync = function (from, to) {
    rename.call(this, from, to);
    if (!once && path.basename(String(to)) === 'usage.current') {
        once = true;
        throw Object.assign(new Error('EPERM: refused by the test'), { code: 'EPERM' });
    }
};
require(${JSON.stringify(WORKER)});
`,
        );
        const host = new WorkerHost<UsageWorkerRequest, UsageWorkerResponse>(injected, {
            name: 'usage',
            fallback: 'showing nothing',
            log: { error: () => undefined, warn: () => undefined },
        });
        hosts.push(host);
        const answer = await host.send({ type: 'import', id: 0, storeFile: path.join(folder, 'usage.sqlite'), roots: [FIXTURE_ROOT] });
        const named = fs.readFileSync(path.join(folder, 'usage.current'), 'utf8');
        assert.notStrictEqual(named, corrupt);
        assert.ok(fs.existsSync(path.join(folder, named)), 'the history the pointer names was removed');
        assert.ok(answer.type === 'imported' && answer.summary?.read === 4, JSON.stringify(answer).slice(0, 200));
    });
});
