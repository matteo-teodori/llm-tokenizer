import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import type { UsageWorkerRequest, UsageWorkerResponse } from '../../src/usage/protocol';
import {
    FIRST_IMPORT_MAX_WAIT_MS,
    HINT_CEILING_MS,
    HINT_DEBOUNCE_MS,
    HOURLY_MS,
    IDLE_MS,
    LEASE_RETRY_MS,
    MAX_HINT_PATHS,
    UsageService,
    type Clock,
    type UsageHost,
    type UsageServiceDeps,
    type UsageSettings,
} from '../../src/usage/usageService';
import { WorkerHost } from '../../src/workerHost';

const FIXTURE_ROOT = path.join(__dirname, '..', '..', '..', 'test', 'fixtures', 'claude-config');
const WORKER = path.join(__dirname, '..', '..', '..', 'out', 'usageWorker.js');

/** Timers that run only when the test advances them. */
class FakeClock implements Clock {
    private time = 1_000_000;
    private nextHandle = 1;
    private readonly timers = new Map<number, { at: number; callback: () => void }>();

    setTimeout(callback: () => void, ms: number): unknown {
        const handle = this.nextHandle++;
        this.timers.set(handle, { at: this.time + ms, callback });
        return handle;
    }

    clearTimeout(handle: unknown): void {
        this.timers.delete(handle as number);
    }

    now(): number {
        return this.time;
    }

    get pending(): number {
        return this.timers.size;
    }

    /** Move time on by `ms`, running every timer that falls due, in order. */
    async advance(ms: number): Promise<void> {
        const until = this.time + ms;
        for (;;) {
            const due = [...this.timers].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
            if (!due) {
                break;
            }
            this.timers.delete(due[0]);
            this.time = due[1].at;
            due[1].callback();
            await settle();
        }
        this.time = until;
        await settle();
    }
}

/** Let promise chains and worker replies run. */
async function settle(): Promise<void> {
    for (let i = 0; i < 5; i++) {
        await new Promise<void>(resolve => setImmediate(resolve));
    }
}

/** Resolves when `service` next fires, or rejects after a real-time wait. */
function changeOf(service: UsageService, ms = 5_000): Promise<void> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no change')), ms);
        const listener = service.onDidChange(() => {
            clearTimeout(timer);
            listener.dispose();
            resolve();
        });
    });
}

/** A recording stand-in for the worker host. */
class FakeHost implements UsageHost {
    readonly sent: UsageWorkerRequest['type'][] = [];
    /** Each import's named paths, or 'all' for a full pass. */
    readonly imports: (string[] | 'all')[] = [];
    /** Each import's `crashed` flag. */
    readonly crashFlags: boolean[] = [];
    /** What the service gave as its crash callback. */
    onCrash: () => void = () => undefined;
    stopped = 0;
    running = false;
    /** Answers each request; an import can be held open by the test. */
    answer: (request: UsageWorkerRequest) => Promise<UsageWorkerResponse> = request => Promise.resolve(defaultAnswer(request));

    send(request: UsageWorkerRequest): Promise<UsageWorkerResponse> {
        this.running = true;
        this.sent.push(request.type);
        if (request.type === 'import') {
            this.imports.push(request.paths ? [...request.paths].sort() : 'all');
            this.crashFlags.push(request.crashed === true);
        }
        return this.answer(request);
    }

    stop(): void {
        this.stopped++;
        this.running = false;
    }

    dispose(): void {
        this.running = false;
    }
}

function summaryOf(read: number): Extract<UsageWorkerResponse, { type: 'imported'; leaseHeldElsewhere: false }>['summary'] {
    return {
        roots: 1, files: 4, read, unchanged: 4 - read, restarted: 0, records: read, skipped: {}, malformed: {}, oversizeLines: 0,
        synthetic: 0, apiErrors: 0, symlinkedFolders: 0, unreadableFolders: 0, journals: 0, missingProjects: 0, cancelled: false,
        elapsedMs: 1,
    };
}

function defaultAnswer(request: UsageWorkerRequest): UsageWorkerResponse {
    switch (request.type) {
        case 'import':
            return { type: 'imported', id: request.id, summary: summaryOf(1), leaseHeldElsewhere: false };
        case 'clear':
            return { type: 'cleared', id: request.id, generation: 1 };
        case 'close':
            return { type: 'closed', id: request.id };
        case 'query':
            return { type: 'failed', id: request.id, failure: 'unknown', errorName: 'Error' };
        case 'liveContext':
            return { type: 'liveContext', id: request.id, latest: null, compactions: [] };
    }
}

suite('usage service', () => {
    let tmp: string;
    const services: UsageService[] = [];

    setup(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-tokenizer-service-'));
    });

    teardown(() => {
        for (const service of services.splice(0)) {
            service.dispose();
        }
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    /** A service over fakes; `calls` counts every touch of the machine. */
    function make(overrides: Partial<UsageServiceDeps> & { settings?: Partial<UsageSettings> } = {}) {
        const clock = new FakeClock();
        const host = new FakeHost();
        const calls = { hosts: 0, roots: 0, watchers: 0, watching: 0 };
        const hints: ((file: string) => void)[] = [];
        let settings: UsageSettings = { enabled: true, dataDirectory: '', editorEnvironment: undefined, ...overrides.settings };
        const service = new UsageService({
            log: { info: () => undefined, warn: () => undefined, debug: () => undefined },
            storeFile: path.join(tmp, 'store', 'usage.sqlite'),
            readSettings: () => settings,
            rootInputs: () => {
                calls.roots++;
                return { env: { CLAUDE_CONFIG_DIR: FIXTURE_ROOT }, home: path.join(tmp, 'home'), platform: process.platform };
            },
            createHost: onCrash => {
                calls.hosts++;
                host.onCrash = onCrash;
                return host;
            },
            watch: (_folder, onHint) => {
                calls.watchers++;
                calls.watching++;
                hints.push(onHint);
                return new vscode.Disposable(() => calls.watching--);
            },
            startupSettled: Promise.resolve(),
            clock,
            ...overrides,
        });
        services.push(service);
        const set = (next: Partial<UsageSettings>) => {
            settings = { ...settings, ...next };
            service.settingsChanged();
        };
        return { service, clock, host, calls, hints, set };
    }

    test('off, it touches nothing: no worker, no root, no watcher, no timer', async () => {
        // KC1. Held as the panel and the status item would hold it.
        const { service, clock, calls } = make({ settings: { enabled: false } });
        const held = service.hold();
        await clock.advance(2 * HOURLY_MS);
        assert.strictEqual(await service.refresh(), undefined);
        assert.strictEqual(await service.report('today', 'UTC', null), undefined);
        held.dispose();
        assert.deepStrictEqual(calls, { hosts: 0, roots: 0, watchers: 0, watching: 0 });
        assert.strictEqual(clock.pending, 0);
        assert.strictEqual(service.status, 'off');
    });

    test('on, the first import waits for the startup scan, or 30 s at most', async () => {
        let settled!: () => void;
        const { host } = make({ startupSettled: new Promise<void>(resolve => (settled = resolve)) });
        await settle();
        assert.deepStrictEqual(host.sent, [], 'imported before the startup scan settled');
        settled();
        await settle();
        assert.deepStrictEqual(host.sent, ['import']);

        // A scan that never settles waits out the ceiling instead.
        const late = make({ startupSettled: new Promise<void>(() => undefined) });
        await late.clock.advance(FIRST_IMPORT_MAX_WAIT_MS - 1);
        assert.deepStrictEqual(late.host.sent, []);
        await late.clock.advance(1);
        assert.deepStrictEqual(late.host.sent, ['import']);
    });

    test('then hourly, whatever is shown, so a closed panel loses nothing', async () => {
        const { clock, host } = make();
        await settle();
        await clock.advance(HOURLY_MS);
        await clock.advance(HOURLY_MS);
        assert.deepStrictEqual(host.sent.filter(t => t === 'import').length, 3);
    });

    test('a refresh during an import runs one more pass after it, not one per call', async () => {
        const { service, host } = make();
        let release!: () => void;
        host.answer = request =>
            request.type === 'import'
                ? new Promise(resolve => (release = () => resolve(defaultAnswer(request))))
                : Promise.resolve(defaultAnswer(request));
        await settle();
        const calls = [service.refresh(), service.refresh(), service.refresh()];
        release();
        await settle();
        release();
        await Promise.all(calls);
        assert.deepStrictEqual(host.sent, ['import', 'import']);
    });

    test('a pass refused because another window holds the lease is tried again, for the same files', async () => {
        const { service, clock, host, hints } = make();
        await settle();
        const held = service.hold();
        let refusals = 1;
        host.answer = request =>
            request.type === 'import' && refusals-- > 0
                ? Promise.resolve({ type: 'imported', id: request.id, summary: null, leaseHeldElsewhere: true })
                : Promise.resolve(defaultAnswer(request));
        host.imports.length = 0;
        hints[0]('/r/projects/p/a.jsonl');
        await clock.advance(HINT_DEBOUNCE_MS);
        assert.ok(service.updatingElsewhere);
        await clock.advance(LEASE_RETRY_MS);
        assert.deepStrictEqual(host.imports, [['/r/projects/p/a.jsonl'], ['/r/projects/p/a.jsonl']]);
        assert.ok(!service.updatingElsewhere);
        held.dispose();
    });

    test('hints never put the hourly full pass off', async () => {
        // A hint's pass covers only its files: were it to re-arm the hourly
        // timer, steady hints would mean no full pass at all.
        const { service, clock, host, hints } = make();
        await settle();
        const held = service.hold();
        host.imports.length = 0;
        for (let minute = 0; minute < 3 * 60; minute += 30) {
            hints[0]('/r/projects/p/a.jsonl');
            await clock.advance(30 * 60_000);
        }
        assert.ok(host.imports.filter(i => i === 'all').length >= 2, JSON.stringify(host.imports));
        held.dispose();
    });

    test("an older window, outdated by a newer one's parser, shows the history read-only", async () => {
        const { service, host } = make();
        host.answer = request =>
            Promise.resolve(request.type === 'import' ? { type: 'failed', id: request.id, failure: 'outdated', errorName: 'StoreError' } : defaultAnswer(request));
        await settle();
        assert.strictEqual(service.status, 'read-only');
    });

    test('after a crash the next import says so, and only until one goes through', async () => {
        // A read the crashed worker left unfinished then counts against that
        // file; a worker stopped by its window counts against nothing.
        const { service, host } = make();
        await settle();
        host.onCrash();
        await service.refresh();
        await service.refresh();
        assert.deepStrictEqual(host.crashFlags, [false, true, false]);
    });

    test('an idle worker is let go after 10 minutes, its history closed first', async () => {
        const { clock, host } = make();
        await settle();
        assert.ok(host.running);
        await clock.advance(IDLE_MS - 1);
        assert.strictEqual(host.stopped, 0);
        await clock.advance(1);
        assert.deepStrictEqual([host.sent.at(-1), host.stopped], ['close', 1]);
    });

    test('held, it stays resident and imports on watcher hints, a burst coalesced', async () => {
        const { service, clock, host, calls, hints } = make();
        await settle();
        const held = service.hold();
        assert.strictEqual(calls.watching, 1);
        await clock.advance(IDLE_MS * 2);
        assert.strictEqual(host.stopped, 0, 'a held worker was let go');

        const before = host.sent.length;
        for (let i = 0; i < 20; i++) {
            hints[0](`/r/projects/p/s${i % 2}.jsonl`);
            await clock.advance(HINT_DEBOUNCE_MS / 2);
        }
        // Twenty hints over 10 s, each sooner than the debounce: one import, at
        // the ceiling, rather than none until the burst ends, or twenty.
        assert.strictEqual(20 * (HINT_DEBOUNCE_MS / 2), HINT_CEILING_MS);
        const imports = () => host.sent.slice(before).filter(t => t === 'import').length;
        assert.strictEqual(imports(), 1, 'nothing was imported by the ceiling');
        await clock.advance(HINT_DEBOUNCE_MS);
        assert.strictEqual(imports(), 1);

        held.dispose();
        assert.strictEqual(calls.watching, 0, 'the watcher outlived the hold');
    });

    test('a hint imports the files it names, not every file, and a burst names each once', async () => {
        const { service, clock, host, hints } = make();
        await settle();
        const held = service.hold();
        host.imports.length = 0;
        for (const file of ['/r/projects/p/a.jsonl', '/r/projects/p/b.jsonl', '/r/projects/p/a.jsonl']) {
            hints[0](file);
        }
        await clock.advance(HINT_DEBOUNCE_MS);
        assert.deepStrictEqual(host.imports, [['/r/projects/p/a.jsonl', '/r/projects/p/b.jsonl']]);

        // More than the cap: one full pass is cheaper than naming each.
        for (let i = 0; i <= MAX_HINT_PATHS; i++) {
            hints[0](`/r/projects/p/s${i}.jsonl`);
        }
        await clock.advance(HINT_DEBOUNCE_MS);
        assert.deepStrictEqual(host.imports.at(-1), 'all');
        held.dispose();
    });

    test('a hint during a full pass is imported by name after it, not by another full pass', async () => {
        const { service, clock, host, hints } = make();
        await settle();
        const held = service.hold();
        let release!: () => void;
        host.answer = request =>
            request.type === 'import' && !request.paths
                ? new Promise(resolve => (release = () => resolve(defaultAnswer(request))))
                : Promise.resolve(defaultAnswer(request));
        host.imports.length = 0;
        const full = service.refresh();
        await settle();
        hints[0]('/r/projects/p/a.jsonl');
        await clock.advance(HINT_DEBOUNCE_MS);
        release();
        await full;
        await settle();
        assert.deepStrictEqual(host.imports, ['all', ['/r/projects/p/a.jsonl']]);
        held.dispose();
    });

    test('turned off, it stops its timers, watchers and worker; the history stays', async () => {
        const { service, clock, host, calls, set } = make();
        await settle();
        const held = service.hold();
        set({ enabled: false });
        assert.deepStrictEqual([service.status, calls.watching, host.stopped], ['off', 0, 1]);
        const sent = host.sent.length;
        await clock.advance(2 * HOURLY_MS);
        assert.strictEqual(host.sent.length, sent, 'it went on importing while off');
        assert.ok(!host.sent.includes('clear'));

        // Turned on again while held: watching again, and importing.
        set({ enabled: true });
        await settle();
        assert.strictEqual(calls.watching, 1);
        assert.strictEqual(host.sent.at(-1), 'import');
        held.dispose();
    });

    test('Clear works while off, and lets the worker go at once', async () => {
        const { service, host, clock } = make({ settings: { enabled: false } });
        assert.strictEqual(await service.clear(), true);
        await clock.advance(0);
        assert.deepStrictEqual(host.sent, ['clear', 'close']);
        assert.strictEqual(host.stopped, 1);
    });

    test('no node:sqlite, a newer history and a dead worker each become a status', async () => {
        for (const [answer, status] of [
            [{ type: 'unavailable', id: 0, node: '22.19.0', electron: '37.6.0' }, 'no-sqlite'],
            [{ type: 'failed', id: 0, failure: 'store-read-only', errorName: 'StoreError' }, 'read-only'],
            [{ type: 'failed', id: 0, failure: 'import-failed', errorName: 'Error' }, 'failing'],
        ] as const) {
            const { service, host } = make();
            host.answer = () => Promise.resolve(answer);
            await settle();
            assert.strictEqual(service.status, status, answer.type);
        }
        const { service, host } = make();
        host.answer = () => Promise.reject(new Error('worker exited'));
        await settle();
        assert.strictEqual(service.status, 'failing');
    });

    test('with no root to read, it says so, and reads nothing', async () => {
        const { service, host } = make({
            rootInputs: () => ({ env: {}, home: path.join(tmp, 'nowhere'), platform: process.platform }),
        });
        await settle();
        assert.deepStrictEqual([service.status, host.sent], ['no-roots', []]);
        assert.ok(service.roots?.candidates.some(c => c.source === 'default' && !c.exists));
    });

    test('through the real worker: the fixtures imported, reported, cleared and read again', async () => {
        const log = { info: () => undefined, warn: () => undefined, debug: () => undefined, error: () => undefined };
        const service = new UsageService({
            log,
            storeFile: path.join(tmp, 'store', 'usage.sqlite'),
            readSettings: () => ({ enabled: true, dataDirectory: '', editorEnvironment: undefined }),
            rootInputs: () => ({ env: { CLAUDE_CONFIG_DIR: FIXTURE_ROOT }, home: path.join(tmp, 'home'), platform: process.platform }),
            createHost: () => new WorkerHost<UsageWorkerRequest, UsageWorkerResponse>(WORKER, { name: 'usage', fallback: 'nothing', log }),
            watch: () => new vscode.Disposable(() => undefined),
            startupSettled: Promise.resolve(),
        });
        services.push(service);

        const first = changeOf(service);
        await first;
        const summary = await service.refresh();
        assert.strictEqual(summary?.unchanged, 4, 'the first import did not finish before the second');
        const report = await service.report('coverage', 'Europe/Rome', null);
        assert.strictEqual(report?.totals.processed, 1_278);

        // F15: no ghost rows after Clear, and what is still on disk comes back.
        assert.ok(await service.clear());
        assert.strictEqual((await service.report('coverage', 'Europe/Rome', null))?.totals.processed, 0);
        assert.strictEqual((await service.refresh())?.read, 4);
        assert.strictEqual((await service.report('coverage', 'Europe/Rome', null))?.totals.processed, 1_278);
    });
});
