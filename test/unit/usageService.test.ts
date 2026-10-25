import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import type { UsageWorkerRequest, UsageWorkerResponse } from '../../src/usage/protocol';
import type { UsageReport } from '../../src/usage/report';
import {
    CLOSE_GRACE_MS,
    FIRST_IMPORT_MAX_WAIT_MS,
    HINT_CEILING_MS,
    HINT_DEBOUNCE_MS,
    HOURLY_MS,
    IDLE_MS,
    LEASE_RETRY_MS,
    MAX_HINT_PATHS,
    READING_SHOWN_MS,
    READING_UPDATE_MS,
    RETRY_MS,
    UsageService,
    clearedMessage,
    readUsageSettings,
    refreshMessage,
    statusItemShown,
    type Clock,
    type UsageHost,
    type UsageServiceDeps,
    type UsageSettings,
} from '../../src/usage/usageService';
import { currentHistory } from '../../src/usage/historyFiles';
import { USAGE_SETTINGS } from '../../src/usage/settings';
import { loadSqlite } from '../../src/usage/store';
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
    disposed = 0;
    running = false;
    /** Answers each request; an import can be held open by the test. */
    answer: (request: UsageWorkerRequest) => Promise<UsageWorkerResponse> = request => Promise.resolve(defaultAnswer(request));

    /** What a stop fails, as the real host fails every request still waiting. */
    private readonly waiting = new Set<(error: Error) => void>();

    send(request: UsageWorkerRequest): Promise<UsageWorkerResponse> {
        this.running = true;
        this.sent.push(request.type);
        if (request.type === 'import') {
            this.imports.push(request.paths ? [...request.paths].sort() : 'all');
            this.crashFlags.push(request.crashed === true);
        }
        return new Promise((resolve, reject) => {
            this.waiting.add(reject);
            this.answer(request)
                .then(resolve, reject)
                .finally(() => this.waiting.delete(reject));
        });
    }

    stop(): Promise<void> {
        this.stopped++;
        this.running = false;
        for (const fail of this.waiting) {
            fail(new Error('shut down'));
        }
        this.waiting.clear();
        return Promise.resolve();
    }

    dispose(): Promise<void> {
        this.disposed++;
        this.running = false;
        return Promise.resolve();
    }
}

function summaryOf(read: number): Extract<UsageWorkerResponse, { type: 'imported'; leaseHeldElsewhere: false }>['summary'] {
    return {
        roots: 1, files: 4, read, unchanged: 4 - read, restarted: 0, records: read, skipped: {}, malformed: {}, oversizeLines: 0,
        synthetic: 0, apiErrors: 0, symlinkedFolders: 0, unreadableFolders: 0, journals: 0, missingProjects: 0, cancelled: false,
        interrupted: 0, elapsedMs: 1,
    };
}

function defaultAnswer(request: UsageWorkerRequest): UsageWorkerResponse {
    switch (request.type) {
        case 'import':
            return { type: 'imported', id: request.id, summary: summaryOf(1), leaseHeldElsewhere: false };
        case 'clear':
            return { type: 'cleared', id: request.id, generation: 1, settled: true, copiesLeft: 0 };
        case 'close':
            return { type: 'closed', id: request.id };
        case 'query':
            return { type: 'failed', id: request.id, failure: 'unknown', errorName: 'Error' };
        case 'liveContext':
            return { type: 'liveContext', id: request.id, latest: null, compactions: [] };
    }
}

/** What the worker answers when another window holds the history's write lock past the busy timeout. */
function busy(request: Pick<UsageWorkerRequest, 'id'>): UsageWorkerResponse {
    return { type: 'failed', id: request.id, failure: 'store-busy', errorName: 'Error', sqlite: { code: 5, text: 'database is locked' } };
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
        // Windows lets a folder go only once nothing in it is open.
        fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
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
        let answerClose!: () => void;
        host.answer = request =>
            request.type === 'close'
                ? new Promise(resolve => (answerClose = () => resolve(defaultAnswer(request))))
                : Promise.resolve(defaultAnswer(request));
        assert.ok(host.running);
        await clock.advance(IDLE_MS - 1);
        assert.strictEqual(host.stopped, 0);
        await clock.advance(1);
        assert.deepStrictEqual([host.sent.at(-1), host.stopped], ['close', 0], 'ended before its history was closed');
        answerClose();
        await settle();
        assert.strictEqual(host.stopped, 1);
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
        // The history closed first, the thread ended after: ended inside a
        // SQLite call, it would be ended mid-write.
        assert.deepStrictEqual([service.status, calls.watching, host.sent.at(-1), host.stopped], ['off', 0, 'close', 0]);
        await settle();
        assert.strictEqual(host.stopped, 1);
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

    /** An import that answers only when the test says, with what it says. */
    function heldImport(host: FakeHost): (answer?: Partial<UsageWorkerResponse>) => void {
        let answer!: (extra?: Partial<UsageWorkerResponse>) => void;
        host.answer = request =>
            request.type === 'import'
                ? new Promise(resolve => (answer = extra => resolve({ ...defaultAnswer(request), ...extra } as UsageWorkerResponse)))
                : Promise.resolve(defaultAnswer(request));
        return extra => answer(extra);
    }

    test('turned off during an import, its answer coming after changes nothing', async () => {
        const { service, host, set } = make();
        const answer = heldImport(host);
        await settle();
        let changes = 0;
        service.onDidChange(() => changes++);
        set({ enabled: false });
        answer();
        await settle();
        assert.deepStrictEqual([service.status, service.lastImport, changes > 1], ['off', undefined, false]);
    });

    test('a refused pass answered after turning off, or after dispose, arms no retry and reads nothing', async () => {
        for (const end of ['off', 'dispose'] as const) {
            const { service, host, clock, calls, set } = make();
            const answer = heldImport(host);
            await settle();
            if (end === 'off') {
                set({ enabled: false });
            } else {
                service.dispose();
            }
            answer({ summary: null, leaseHeldElsewhere: true });
            await settle();
            const [roots, sent] = [calls.roots, host.sent.length];
            await clock.advance(LEASE_RETRY_MS * 2);
            assert.deepStrictEqual([calls.roots, host.sent.length, service.updatingElsewhere], [roots, sent, false], end);
        }
    });

    test('a request the worker refuses as malformed leaves the status as it is', async () => {
        const { service, host } = make();
        await settle();
        host.answer = request => Promise.resolve({ type: 'failed', id: request.id, failure: 'bad-request', errorName: 'RangeError' });
        assert.strictEqual(await service.liveContext('s1'), undefined);
        assert.strictEqual(service.status, 'ready');
    });

    test('a Clear that fails while off leaves the status off', async () => {
        const { service, host } = make({ settings: { enabled: false } });
        host.answer = request => Promise.resolve({ type: 'failed', id: request.id, failure: 'store-io', errorName: 'StoreError' });
        assert.strictEqual(await service.clear(), undefined);
        assert.strictEqual(service.status, 'off');
    });

    test('turned off and on before the pass answered, the new start imports, and hourly after', async () => {
        const { host, clock, set } = make();
        const answer = heldImport(host);
        await settle();
        set({ enabled: false });
        set({ enabled: true });
        host.answer = request => Promise.resolve(defaultAnswer(request));
        answer();
        await settle();
        assert.deepStrictEqual(host.imports, ['all', 'all'], 'the new start did not import');
        await clock.advance(HOURLY_MS);
        assert.deepStrictEqual(host.imports, ['all', 'all', 'all'], 'no hourly pass after it');
    });

    test('a Clear sent just after turning off is answered, and the worker ends after it', async () => {
        const { service, host, clock, set } = make();
        await settle();
        // As the worker's queue has it: the close first, the Clear after it.
        let answerClose!: () => void;
        const closed = new Promise<void>(resolve => (answerClose = resolve));
        host.answer = request =>
            request.type === 'close'
                ? closed.then(() => defaultAnswer(request))
                : request.type === 'clear'
                  ? closed.then(() => new Promise<UsageWorkerResponse>(resolve => setImmediate(() => resolve(defaultAnswer(request)))))
                  : Promise.resolve(defaultAnswer(request));
        set({ enabled: false });
        const cleared = service.clear();
        answerClose();
        assert.deepStrictEqual(await cleared, { settled: true, copiesLeft: 0 }, 'the Clear was cut off by the stop');
        await clock.advance(0);
        assert.ok(host.stopped >= 1 && !host.running, 'the worker was kept');
    });

    test('a crash is reported to the worker until a pass has counted the read it left unfinished', async () => {
        const { service, host, clock, hints } = make();
        await settle();
        const held = service.hold();
        const flags: string[] = [];
        let interrupted = 0;
        host.answer = request => {
            if (request.type === 'liveContext') {
                flags.push(`live:${request.crashed === true}`);
            }
            if (request.type === 'import') {
                flags.push(`${request.paths ? 'hint' : 'full'}:${request.crashed === true}`);
                return Promise.resolve({
                    type: 'imported',
                    id: request.id,
                    summary: { ...summaryOf(1), interrupted: request.paths ? 0 : interrupted },
                    leaseHeldElsewhere: false,
                });
            }
            return Promise.resolve(defaultAnswer(request));
        };
        host.onCrash();
        // Another session's file, then a hint naming another file: neither
        // met the read the crash left unfinished.
        await service.liveContext('s1');
        hints[0]('/r/projects/p/other.jsonl');
        await clock.advance(HINT_DEBOUNCE_MS);
        // A full pass meets it and counts it; after that the flag is spent.
        interrupted = 1;
        await service.refresh();
        await service.refresh();
        assert.deepStrictEqual(flags, ['live:true', 'hint:true', 'full:true', 'full:false']);
        held.dispose();
    });

    test("a Refresh whose own pass is refused says nothing was read, not what the pass before it read", async () => {
        // A hint's pass is running when Refresh is clicked; another window
        // takes the lease between the two.
        const { service, host, clock, hints } = make();
        await settle();
        const held = service.hold();
        let answerHint!: () => void;
        host.answer = request =>
            request.type !== 'import'
                ? Promise.resolve(defaultAnswer(request))
                : request.paths
                  ? new Promise(resolve => (answerHint = () => resolve(defaultAnswer(request))))
                  : Promise.resolve({ type: 'imported', id: request.id, summary: null, leaseHeldElsewhere: true });
        hints[0]('/r/projects/p/a.jsonl');
        await clock.advance(HINT_DEBOUNCE_MS);
        const refreshed = service.refresh();
        answerHint();
        assert.strictEqual(await refreshed, undefined, 'Refresh was answered with the hint pass');
        assert.ok(service.updatingElsewhere);
        held.dispose();
    });

    test('a retry that fails drops the other-window note, so Refresh says what went wrong', async () => {
        const { service, host } = make();
        await settle();
        let refusals = 1;
        host.answer = request =>
            request.type !== 'import'
                ? Promise.resolve(defaultAnswer(request))
                : refusals-- > 0
                  ? Promise.resolve({ type: 'imported', id: request.id, summary: null, leaseHeldElsewhere: true })
                  : Promise.resolve({ type: 'failed', id: request.id, failure: 'store-io', errorName: 'StoreError' });
        await service.refresh();
        assert.ok(service.updatingElsewhere);
        await service.refresh();
        // Failed once: tried again soon, and not yet a warning.
        assert.deepStrictEqual([service.updatingElsewhere, service.status, service.retrying], [false, 'ready', true]);
        assert.deepStrictEqual(refreshMessage(undefined, service), {
            kind: 'info',
            text: 'LLM Tokenizer: Claude Code usage could not be refreshed just now; it is tried again in a few seconds.',
        });
        await service.refresh();
        assert.deepStrictEqual([service.status, refreshMessage(undefined, service)?.kind], ['failing', 'warning']);
    });

    test('off, a held service still lets its worker go after a Clear', async () => {
        // The panel holds it while visible, the feature off or not.
        const { service, host, clock } = make({ settings: { enabled: false } });
        const held = service.hold();
        assert.ok(await service.clear());
        await clock.advance(0);
        assert.deepStrictEqual([host.sent, host.stopped], [['clear', 'close'], 1]);
        held.dispose();
    });

    test('a worker that does not answer the close is ended all the same, soon after', async () => {
        const { clock, host, set } = make();
        await settle();
        host.answer = request => (request.type === 'close' ? new Promise(() => undefined) : Promise.resolve(defaultAnswer(request)));
        set({ enabled: false });
        await clock.advance(CLOSE_GRACE_MS - 1);
        assert.strictEqual(host.stopped, 0);
        await clock.advance(1);
        assert.strictEqual(host.stopped, 1);
    });

    test('turned on again before the close is answered, the worker is kept for the new start', async () => {
        const { host, set } = make();
        await settle();
        let answerClose!: () => void;
        host.answer = request =>
            request.type === 'close'
                ? new Promise(resolve => (answerClose = () => resolve(defaultAnswer(request))))
                : Promise.resolve(defaultAnswer(request));
        set({ enabled: false });
        set({ enabled: true });
        answerClose();
        await settle();
        assert.deepStrictEqual([host.stopped, host.sent.at(-1)], [0, 'import']);
    });

    test('disposed, it closes the history, then ends the worker for good', async () => {
        const { service, host } = make();
        await settle();
        service.dispose();
        assert.deepStrictEqual([host.sent.at(-1), host.disposed], ['close', 0]);
        await settle();
        assert.strictEqual(host.disposed, 1);
    });

    test('its start opens once the startup scan settles, or after 30 s, and the status item waits on it too', async () => {
        const { service, clock } = make({ startupSettled: new Promise<void>(() => undefined) });
        let started = false;
        void service.whenStarted().then(() => (started = true));
        await clock.advance(FIRST_IMPORT_MAX_WAIT_MS - 1);
        assert.ok(!started);
        await clock.advance(1);
        assert.ok(started);
        // One gate for the first import and the item alike.
        assert.strictEqual(service.whenStarted(), service.whenStarted());
    });

    test('Clear works while off, and lets the worker go at once', async () => {
        const { service, host, clock } = make({ settings: { enabled: false } });
        assert.deepStrictEqual(await service.clear(), { settled: true, copiesLeft: 0 });
        await clock.advance(0);
        assert.deepStrictEqual(host.sent, ['clear', 'close']);
        assert.strictEqual(host.stopped, 1);
    });

    test('no node:sqlite and a newer history each become a status, at once, and are not tried again before the hourly pass', async () => {
        for (const [answer, status] of [
            [{ type: 'unavailable', id: 0, node: '22.19.0', electron: '37.6.0' }, 'no-sqlite'],
            [{ type: 'failed', id: 0, failure: 'store-read-only', errorName: 'StoreError' }, 'read-only'],
            [{ type: 'failed', id: 0, failure: 'outdated', errorName: 'StoreError' }, 'read-only'],
        ] as const) {
            const { service, clock, host } = make();
            host.answer = () => Promise.resolve(answer);
            await settle();
            assert.strictEqual(service.status, status, answer.type);
            // Neither clears by itself: a reload, or another editor, does.
            await clock.advance(RETRY_MS.reduce((sum, ms) => sum + ms, 0));
            assert.deepStrictEqual([host.imports.length, service.retrying], [1, false], status);
        }
    });

    test('an import that threw, or a worker that died, is tried again after 5 s, and shows as failing only once that fails too', async () => {
        // T-2: what clears by itself must not stay "could not be read" for an hour.
        for (const fail of [
            (request: UsageWorkerRequest) => Promise.resolve<UsageWorkerResponse>({ type: 'failed', id: request.id, failure: 'import-failed', errorName: 'Error' }),
            () => Promise.reject(new Error('worker exited')),
        ]) {
            const { service, clock, host } = make();
            host.answer = request => (request.type === 'import' ? fail(request) : Promise.resolve(defaultAnswer(request)));
            await settle();
            assert.deepStrictEqual([host.imports.length, service.status, service.retrying], [1, 'ready', true]);
            await clock.advance(RETRY_MS[0] - 1);
            assert.strictEqual(host.imports.length, 1);
            await clock.advance(1);
            assert.deepStrictEqual([host.imports.length, service.status, service.retrying], [2, 'failing', false]);
        }
    });

    test('a failed pass is tried again after 5 s, 30 s, 2 and 10 minutes, then by the hourly pass', async () => {
        const { clock, host } = make();
        host.answer = request => Promise.resolve(request.type === 'import' ? busy(request) : defaultAnswer(request));
        await settle();
        for (const [i, wait] of [...RETRY_MS, HOURLY_MS].entries()) {
            await clock.advance(wait - 1);
            assert.strictEqual(host.imports.length, i + 1, `tried again before ${wait} ms`);
            await clock.advance(1);
            assert.strictEqual(host.imports.length, i + 2, `not tried again after ${wait} ms`);
        }
    });

    test('once a pass goes through, the next failure is a first again: unshown, and tried again after 5 s', async () => {
        const { service, clock, host } = make();
        let failing = true;
        host.answer = request => Promise.resolve(request.type === 'import' && failing ? busy(request) : defaultAnswer(request));
        await settle();
        await clock.advance(RETRY_MS[0]);
        assert.strictEqual(service.status, 'failing');
        failing = false;
        await clock.advance(RETRY_MS[1]);
        assert.deepStrictEqual([service.status, service.retrying], ['ready', false]);
        failing = true;
        await service.refresh();
        assert.deepStrictEqual([service.status, service.retrying], ['ready', true]);
        const tries = host.imports.length;
        await clock.advance(RETRY_MS[0]);
        assert.strictEqual(host.imports.length, tries + 1, 'the backing off was not started over');
    });

    test("watcher hints wait for a failed pass's retry, and are read by it", async () => {
        const { service, clock, host, hints } = make();
        const held = service.hold();
        let failing = true;
        host.answer = request => Promise.resolve(request.type === 'import' && failing ? busy(request) : defaultAnswer(request));
        await settle();
        // Claude Code writes on: a pass a second would undo the backing off.
        hints[0]('/r/projects/p/a.jsonl');
        await clock.advance(HINT_DEBOUNCE_MS);
        assert.strictEqual(host.imports.length, 1, 'a hint ran a pass while the failed one waited');
        failing = false;
        await clock.advance(RETRY_MS[0] - HINT_DEBOUNCE_MS);
        assert.deepStrictEqual(host.imports, ['all', 'all']);
        held.dispose();
    });

    test("the log names SQLite's result code and its own text for it, and when the pass is tried again", async () => {
        const warnings: string[] = [];
        const { host } = make({ log: { info: () => undefined, warn: m => warnings.push(m), debug: () => undefined } });
        host.answer = request => Promise.resolve(request.type === 'import' ? busy(request) : defaultAnswer(request));
        await settle();
        assert.deepStrictEqual(warnings, ['Claude Code usage: store-busy (Error, SQLite 5: database is locked); tried again in 5 s']);
    });

    test('a look that fails is looked at again after 5 s, and shows as failing only if that fails too', async () => {
        const { service, clock, host } = make();
        await settle();
        let changes = 0;
        service.onDidChange(() => changes++);
        host.answer = request =>
            Promise.resolve(request.type === 'query' ? { type: 'failed', id: request.id, failure: 'store-io', errorName: 'StoreError' } : defaultAnswer(request));
        assert.strictEqual(await service.report('today', 'UTC', null), undefined);
        assert.deepStrictEqual([service.status, changes], ['ready', 0]);
        // The panel and the status item look again when told something changed.
        await clock.advance(RETRY_MS[0]);
        assert.strictEqual(changes, 1, 'nothing was told to look again');
        await service.report('today', 'UTC', null);
        assert.strictEqual(service.status, 'failing');
        host.answer = request => Promise.resolve(request.type === 'query' ? { type: 'report', id: request.id, report: {} as UsageReport } : defaultAnswer(request));
        await service.report('today', 'UTC', null);
        assert.strictEqual(service.status, 'ready');
    });

    test('a pass that runs past a second says it reads, tells the page every 2 s, and once when done; a shorter one says nothing', async () => {
        const { service, clock, host } = make();
        const answer = heldImport(host);
        await settle();
        let changes = 0;
        service.onDidChange(() => changes++);
        await clock.advance(READING_SHOWN_MS - 1);
        assert.deepStrictEqual([service.reading, changes], [undefined, 0]);
        await clock.advance(1);
        assert.deepStrictEqual([service.reading, changes], [{ by: 'this window' }, 1]);
        await clock.advance(READING_UPDATE_MS);
        assert.strictEqual(changes, 2, 'not told again while it read');
        answer();
        await settle();
        assert.deepStrictEqual([service.reading, changes], [undefined, 3], 'told more than once that it was done, or not at all');

        // A hint's pass, or a full one over unchanged files: over before the page could say so.
        const quick = heldImport(host);
        void service.refresh();
        await clock.advance(READING_SHOWN_MS - 1);
        quick();
        await settle();
        await clock.advance(5 * READING_SHOWN_MS);
        // Told once, of the file it read.
        assert.deepStrictEqual([service.reading, changes], [undefined, 4]);
    });

    test('a long pass that fails goes on saying it reads until it is tried again, and stops if that fails too', async () => {
        const { service, clock, host } = make();
        let answer!: (response: UsageWorkerResponse) => void;
        host.answer = request => (request.type === 'import' ? new Promise(resolve => (answer = resolve)) : Promise.resolve(defaultAnswer(request)));
        await settle();
        await clock.advance(READING_SHOWN_MS);
        answer(busy({ id: 0 }));
        await settle();
        assert.deepStrictEqual([service.reading, service.status], [{ by: 'this window' }, 'ready'], 'it stopped saying it reads, though it is tried again');
        await clock.advance(RETRY_MS[0]);
        assert.ok(service.reading);
        answer(busy({ id: 0 }));
        await settle();
        assert.deepStrictEqual([service.reading, service.status], [undefined, 'failing']);
    });

    test("another window's pass is said to be reading only once it still is, a retry later", async () => {
        const { service, clock, host } = make();
        let refusals = 2;
        host.answer = request =>
            Promise.resolve(
                request.type === 'import' && refusals-- > 0 ? { type: 'imported', id: request.id, summary: null, leaseHeldElsewhere: true } : defaultAnswer(request),
            );
        await settle();
        // Refused once: that window's pass can have been a hint's, over at once.
        assert.deepStrictEqual([service.updatingElsewhere, service.reading], [true, undefined]);
        await clock.advance(LEASE_RETRY_MS);
        assert.deepStrictEqual(service.reading, { by: 'another window' });
        let changes = 0;
        service.onDidChange(() => changes++);
        await clock.advance(READING_UPDATE_MS);
        assert.strictEqual(changes, 1, 'what it writes was not shown as it goes');
        await clock.advance(LEASE_RETRY_MS);
        assert.deepStrictEqual([service.updatingElsewhere, service.reading], [false, undefined]);

        // Refused once, and through at the retry: never said.
        const quick = make();
        let once = 1;
        const seen: unknown[] = [];
        quick.host.answer = request =>
            Promise.resolve(request.type === 'import' && once-- > 0 ? { type: 'imported', id: request.id, summary: null, leaseHeldElsewhere: true } : defaultAnswer(request));
        quick.service.onDidChange(() => seen.push(quick.service.reading));
        await settle();
        await quick.clock.advance(LEASE_RETRY_MS);
        assert.ok(seen.length > 0 && seen.every(r => r === undefined), JSON.stringify(seen));
    });

    test('a report asks how many files the pass has only once its reading shows, and passes on how far it has gone', async () => {
        const { service, clock, host } = make();
        await settle();
        const asked: (boolean | undefined)[] = [];
        const answer = heldImport(host);
        const imports = host.answer;
        host.answer = request => {
            if (request.type !== 'query') {
                return imports(request);
            }
            asked.push(request.progress);
            return Promise.resolve({ type: 'report', id: request.id, report: {} as UsageReport, reading: request.progress ? { files: 120, of: 3_880 } : { files: 3 } });
        };
        void service.refresh();
        await settle();
        // Asked as the panel opens, the pass a moment old: a walk of every root is not worth it yet.
        await service.report('7d', 'UTC', null);
        await clock.advance(READING_SHOWN_MS);
        assert.deepStrictEqual(service.reading, { by: 'this window', files: 3 });
        await service.report('7d', 'UTC', null);
        assert.deepStrictEqual([asked, service.reading], [[undefined, true], { by: 'this window', files: 120, of: 3_880 }]);
        answer();
        await settle();
        assert.strictEqual(service.reading, undefined);
    });

    test('before any pass has gone through, a report waits for the one under way, to its end or its first second', async () => {
        // accounting-1: the panel opened as the feature turned on showed a
        // first import's first files, 5.2M of 309.6M, as the whole history.
        const { service, clock, host } = make();
        let answer = heldImport(host);
        const imports = host.answer;
        const queried: number[] = [];
        const reportsFrom = (pass: typeof host.answer) => (request: UsageWorkerRequest) =>
            request.type === 'query'
                ? (queried.push(clock.now()), Promise.resolve<UsageWorkerResponse>({ type: 'report', id: request.id, report: {} as UsageReport }))
                : pass(request);
        host.answer = reportsFrom(imports);
        await settle();
        const started = clock.now();
        let answered = false;
        void service.report('7d', 'UTC', null).then(() => (answered = true));
        await clock.advance(READING_SHOWN_MS - 1);
        assert.deepStrictEqual([queried, answered], [[], false], "a pass's first files were read as the whole history");
        await clock.advance(1);
        assert.deepStrictEqual([queried, answered], [[started + READING_SHOWN_MS], true]);
        answer();
        await settle();

        // After a Clear, the next pass is a first import again: its end, sooner than a second, is waited for.
        assert.ok(await service.clear());
        answer = heldImport(host);
        host.answer = reportsFrom(host.answer);
        void service.refresh();
        await settle();
        answered = false;
        void service.report('7d', 'UTC', null).then(() => (answered = true));
        await clock.advance(READING_SHOWN_MS / 2);
        assert.strictEqual(answered, false);
        answer();
        await settle();
        assert.strictEqual(answered, true);
        assert.strictEqual(queried.at(-1), started + READING_SHOWN_MS + READING_SHOWN_MS / 2);

        // Once one has gone through, a report is answered at once, a pass under way or not.
        answer = heldImport(host);
        host.answer = reportsFrom(host.answer);
        void service.refresh();
        await settle();
        const before = queried.length;
        await service.report('7d', 'UTC', null);
        assert.strictEqual(queried.length, before + 1);
        answer();
    });

    test("a hint's pass that went through first does not count as the whole history read", async () => {
        // The first full pass waits for the startup scan; a watcher hint does not.
        const { service, clock, host, hints } = make({ startupSettled: new Promise<void>(() => undefined) });
        const held = service.hold();
        let answered = false;
        hints[0]('/r/projects/p/a.jsonl');
        await clock.advance(HINT_DEBOUNCE_MS);
        assert.deepStrictEqual(host.imports, [['/r/projects/p/a.jsonl']]);
        const answer = heldImport(host);
        const imports = host.answer;
        host.answer = request =>
            request.type === 'query' ? Promise.resolve({ type: 'report', id: request.id, report: {} as UsageReport }) : imports(request);
        // To the startup scan's ceiling, and the full pass's first moment.
        await clock.advance(FIRST_IMPORT_MAX_WAIT_MS - HINT_DEBOUNCE_MS);
        assert.deepStrictEqual(host.imports.at(-1), 'all');
        void service.report('7d', 'UTC', null).then(() => (answered = true));
        await settle();
        assert.strictEqual(answered, false, "the first full pass's first files were read as the whole history");
        answer();
        await settle();
        assert.strictEqual(answered, true);
        held.dispose();
    });

    test('a history set aside is logged and kept on show, until Clear removes it', async () => {
        const warnings: string[] = [];
        const { service, host } = make({ log: { info: () => undefined, warn: m => warnings.push(m), debug: () => undefined } });
        host.answer = request =>
            Promise.resolve(
                request.type === 'import'
                    ? { type: 'imported', id: request.id, summary: summaryOf(1), leaseHeldElsewhere: false, recovered: 'usage.sqlite.corrupt-1791000000000' }
                    : defaultAnswer(request),
            );
        await settle();
        assert.strictEqual(service.recoveredFrom, 'usage.sqlite.corrupt-1791000000000');
        assert.deepStrictEqual(warnings.filter(w => w.includes('set aside as usage.sqlite.corrupt-1791000000000')).length, 1);
        assert.ok(await service.clear());
        assert.strictEqual(service.recoveredFrom, undefined);
    });

    test('a Clear another window held off, or that left copies, says so in the log and in its message', async () => {
        const logged: string[] = [];
        const { service, host } = make({ log: { info: m => logged.push(m), warn: m => logged.push(m), debug: () => undefined } });
        host.answer = request =>
            Promise.resolve(request.type === 'clear' ? { type: 'cleared', id: request.id, generation: 2, settled: false, copiesLeft: 2 } : defaultAnswer(request));
        const outcome = await service.clear();
        assert.deepStrictEqual(outcome, { settled: false, copiesLeft: 2 });
        assert.ok(logged.some(l => l.includes('once that read ends')), logged.join(' | '));
        assert.ok(logged.some(l => l.includes('2 copies of the history could not be removed yet')), logged.join(' | '));
        // A copy still readable is never called cleared without a word.
        assert.strictEqual(clearedMessage({ settled: true, copiesLeft: 0 }), 'LLM Tokenizer: Claude Code usage history cleared.');
        assert.strictEqual(
            clearedMessage({ settled: true, copiesLeft: 1 }),
            'LLM Tokenizer: Claude Code usage history cleared, but one copy of it could not be removed yet, perhaps because another window has it open. It is removed as soon as it can be.',
        );
        assert.ok(clearedMessage({ settled: true, copiesLeft: 2 }).includes('2 copies of it could not be removed yet'));
    });

    test('Refresh says what it read, that another window reads, or why it could not; with no data folder, that', () => {
        const at = (status: Parameters<typeof refreshMessage>[1]['status'], updatingElsewhere = false) =>
            refreshMessage(undefined, { status, updatingElsewhere, retrying: false });
        assert.deepStrictEqual(refreshMessage(summaryOf(3), { status: 'ready', updatingElsewhere: false, retrying: false })?.kind, 'info');
        assert.deepStrictEqual(at('ready', true)?.text, 'LLM Tokenizer: another window is updating the Claude Code usage history; this one shows it as it goes.');
        // The log says this once, when the folder goes: Refresh says it each time.
        assert.deepStrictEqual(at('no-roots'), {
            kind: 'warning',
            text: 'LLM Tokenizer: no Claude Code data folder was found. Show Claude Code Usage lists the places looked at.',
        });
        assert.deepStrictEqual(at('failing')?.text, 'LLM Tokenizer: Claude Code usage could not be refreshed; see the log.');
        assert.strictEqual(at('ready'), undefined);
    });

    test('the set-aside notice follows what is beside the history: shown while a copy is there', async () => {
        const { service, host } = make();
        let aside: string | undefined = 'usage.sqlite.corrupt-1791000000000';
        host.answer = request =>
            Promise.resolve(request.type === 'query' ? { type: 'report', id: request.id, report: {} as UsageReport, aside } : defaultAnswer(request));
        await service.report('today', 'UTC', null);
        assert.strictEqual(service.recoveredFrom, 'usage.sqlite.corrupt-1791000000000');
        aside = undefined;
        await service.report('today', 'UTC', null);
        assert.strictEqual(service.recoveredFrom, undefined);
    });

    test('with no root to read, it says so, and reads nothing', async () => {
        const { service, host } = make({
            rootInputs: () => ({ env: {}, home: path.join(tmp, 'nowhere'), platform: process.platform }),
        });
        await settle();
        assert.deepStrictEqual([service.status, host.sent], ['no-roots', []]);
        assert.ok(service.roots?.candidates.some(c => c.source === 'default' && !c.exists));
    });

    test('a hold whose watchers fail to start holds nothing, so the worker is still let go', async () => {
        // T-5: a hold counted before its watchers threw kept the worker for
        // good, and the next panel watched nothing.
        let failing = true;
        const { service, clock, host } = make({
            watch: () => {
                if (failing) {
                    throw new TypeError('inputs.setting.trim is not a function');
                }
                return new vscode.Disposable(() => undefined);
            },
        });
        await settle();
        assert.throws(() => service.hold(), TypeError);
        failing = false;
        service.hold().dispose();
        await clock.advance(IDLE_MS);
        assert.strictEqual(host.sent.at(-1), 'close', 'the hold that threw kept the worker');
    });

    test('through the real worker: the fixtures imported, reported, cleared and read again', async () => {
        const log = { info: () => undefined, warn: () => undefined, debug: () => undefined, error: () => undefined };
        const storeFile = path.join(tmp, 'store', 'usage.sqlite');
        let worker: WorkerHost<UsageWorkerRequest, UsageWorkerResponse> | undefined;
        const service = new UsageService({
            log,
            storeFile,
            readSettings: () => ({ enabled: true, dataDirectory: '', editorEnvironment: undefined }),
            rootInputs: () => ({ env: { CLAUDE_CONFIG_DIR: FIXTURE_ROOT }, home: path.join(tmp, 'home'), platform: process.platform }),
            createHost: () => (worker = new WorkerHost<UsageWorkerRequest, UsageWorkerResponse>(WORKER, { name: 'usage', fallback: 'nothing', log })),
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

        // Once its thread has ended, nothing of the history is open: what
        // Windows needs before the folder can go. (The order, close then end,
        // is the fake host's to show: the end closes the file too.)
        services.splice(services.indexOf(service), 1);
        service.dispose();
        for (let i = 0; i < 200 && worker?.running; i++) {
            await settle();
        }
        await worker?.dispose();
        assert.ok(!fs.existsSync(`${currentHistory(path.dirname(storeFile)) ?? storeFile}-wal`), 'the history was still open after its thread ended');
    });
});

suite('usage settings', () => {
    test("Claude Code's environment is taken at the user level only, never from a repository", () => {
        const configuration = (section: string) => ({
            get: <T>(key: string, fallback?: T): T | undefined =>
                section === 'claudeCode' ? ({ environmentVariables: 'workspace' } as Record<string, unknown>)[key] as T : fallback,
            inspect: <T>(key: string) =>
                section === 'claudeCode' && key === 'environmentVariables'
                    ? ({ key, globalValue: 'user', workspaceValue: 'workspace', workspaceFolderValue: 'folder' } as unknown as { key: string; globalValue?: T })
                    : undefined,
        });
        assert.deepStrictEqual(readUsageSettings(configuration as never), { enabled: false, dataDirectory: '', editorEnvironment: 'user' });
    });

    /** This extension's settings as settings.json holds them, of any type: get() checks none. */
    const written = (values: Record<string, unknown>) => (section: string) => ({
        get: <T>(key: string) => (section === 'llm-tokenizer' ? values[key] : undefined) as T,
        inspect: () => undefined,
    });

    test('only true turns the feature on: "false" written as a string, or 1, does not', () => {
        // T-4: "false" turned the reading of Claude Code's records on.
        for (const value of ['false', 'true', 1, 'no', null]) {
            assert.strictEqual(readUsageSettings(written({ enableClaudeCodeUsage: value }) as never).enabled, false, JSON.stringify(value));
            const both = written({ enableClaudeCodeUsage: value, showClaudeCodeUsageInStatusBar: true })('llm-tokenizer');
            assert.strictEqual(statusItemShown(both), false, JSON.stringify(value));
            assert.strictEqual(statusItemShown(written({ enableClaudeCodeUsage: true, showClaudeCodeUsageInStatusBar: value })('llm-tokenizer')), false);
        }
        assert.strictEqual(readUsageSettings(written({ enableClaudeCodeUsage: true }) as never).enabled, true);
        assert.strictEqual(statusItemShown(written({ enableClaudeCodeUsage: true, showClaudeCodeUsageInStatusBar: true })('llm-tokenizer')), true);
    });

    test('a data folder written as anything but a string reads as unset', () => {
        // T-5: null, a number or a list made every look at the roots throw.
        for (const value of [null, 42, ['/x'], { path: '/x' }]) {
            assert.strictEqual(readUsageSettings(written({ claudeCodeDataDirectory: value }) as never).dataDirectory, '', JSON.stringify(value));
        }
        assert.strictEqual(readUsageSettings(written({ claudeCodeDataDirectory: '~/claude' }) as never).dataDirectory, '~/claude');
    });

    test('the settings say what is kept as the README does, and every place the data folder is looked for', () => {
        const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8')) as {
            contributes: { configuration: { properties: Record<string, { description?: string }> } };
        };
        const properties = manifest.contributes.configuration.properties;
        // Where a person consents: each thing the history keeps, the window's process id included.
        const enable = properties['llm-tokenizer.enableClaudeCodeUsage']?.description ?? '';
        for (const kept of ['effort, speed, where it ran, time', "each transcript's path, size, file id and how far it was read", "the window's process id and this machine's name"]) {
            assert.ok(enable.includes(kept), kept);
        }
        // resolveRoots' order, the organization's managed settings included.
        assert.ok(
            properties['llm-tokenizer.claudeCodeDataDirectory']?.description?.includes(
                "CLAUDE_CONFIG_DIR, the one in the organization's managed settings, the one in ~/.claude/settings.json, then ~/.claude",
            ),
        );
    });

    test('every setting of the feature is a machine setting, so no workspace can turn it on or point it elsewhere', () => {
        const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8')) as {
            contributes: { configuration: { properties: Record<string, { scope?: string }> } | { properties: Record<string, { scope?: string }> }[] };
        };
        const sections = ([] as { properties: Record<string, { scope?: string }> }[]).concat(manifest.contributes.configuration);
        const properties = Object.assign({}, ...sections.map(c => c.properties)) as Record<string, { scope?: string }>;
        for (const key of USAGE_SETTINGS) {
            assert.strictEqual(properties[`llm-tokenizer.${key}`]?.scope, 'machine', key);
        }
    });
});

suite('usage worker: what it says while it imports, and when SQLite is busy', () => {
    let tmp: string;
    const hosts: WorkerHost<UsageWorkerRequest, UsageWorkerResponse>[] = [];
    const sqlite = loadSqlite();

    setup(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-tokenizer-worker-'));
    });

    teardown(async () => {
        await Promise.all(hosts.splice(0).map(h => h.dispose()));
        // Windows lets a folder go only once nothing in it is open.
        fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    });

    function worker(workerData?: unknown): WorkerHost<UsageWorkerRequest, UsageWorkerResponse> {
        const host = new WorkerHost<UsageWorkerRequest, UsageWorkerResponse>(WORKER, {
            name: 'usage',
            fallback: 'nothing',
            log: { error: () => undefined, warn: () => undefined },
            workerData,
        });
        hosts.push(host);
        return host;
    }

    /** A root of `n` sessions of one request each: a pass over it yields a dozen times. */
    function manySessions(n: number): string {
        const project = path.join(tmp, 'root', 'projects', '-repo');
        fs.mkdirSync(project, { recursive: true });
        for (let i = 0; i < n; i++) {
            const record = (fields: object) => JSON.stringify({ sessionId: `sess-${i}`, timestamp: '2026-10-09T10:00:00.000Z', ...fields }) + '\n';
            fs.writeFileSync(
                path.join(project, `sess-${i}.jsonl`),
                record({ type: 'user', uuid: `u${i}`, cwd: '/repo', message: { role: 'user', content: 'x' } }) +
                    record({
                        type: 'assistant',
                        uuid: `a${i}`,
                        message: { model: 'claude-opus-5-5', id: `m${i}`, usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } },
                    }),
            );
        }
        return path.join(tmp, 'root');
    }

    test('a report read while a pass runs says how far it has gone, and of how many files once asked', async () => {
        // T-3: a first import's totals showed as the whole history, unmarked, until it ended.
        const host = worker();
        const storeFile = path.join(tmp, 'store', 'usage.sqlite');
        const root = manySessions(600);
        const query = (progress?: boolean) =>
            host.send({ type: 'query', id: 0, storeFile, range: 'coverage', zone: 'UTC', workspaceFolders: null, ...(progress ? { progress } : {}) });
        const pass = host.send({ type: 'import', id: 0, storeFile, roots: [root] });
        const [first, asked] = await Promise.all([query(), query(true)]);
        assert.ok(first.type === 'report' && asked.type === 'report', `${first.type}, ${asked.type}`);
        assert.ok(first.reading && first.reading.files > 0 && first.reading.files < 600 && first.reading.of === undefined, JSON.stringify(first.reading));
        assert.strictEqual(asked.reading?.of, 600);
        assert.strictEqual((await pass).type, 'imported');
        const after = await query(true);
        assert.ok(after.type === 'report' && after.reading === undefined && after.report.coverage.requests === 600, JSON.stringify(after).slice(0, 300));
    });

    test("a write lock held past the busy timeout fails as store-busy, with SQLite's result code and its text", async () => {
        // T-2: it was "import-failed (Error)", node:sqlite's errors all being named Error.
        assert.ok(sqlite, 'this runtime has no node:sqlite');
        const host = worker({ busyTimeoutMs: 50 });
        const storeFile = path.join(tmp, 'store', 'usage.sqlite');
        assert.strictEqual((await host.send({ type: 'import', id: 0, storeFile, roots: [FIXTURE_ROOT] })).type, 'imported');
        // Another window, in the middle of a write.
        const other = new sqlite.DatabaseSync(currentHistory(path.dirname(storeFile)) ?? storeFile);
        other.exec('BEGIN IMMEDIATE');
        try {
            const refused = await host.send({ type: 'import', id: 0, storeFile, roots: [FIXTURE_ROOT] });
            assert.deepStrictEqual(
                refused.type === 'failed' && [refused.failure, (refused.sqlite?.code ?? 0) & 0xff, refused.sqlite?.text],
                ['store-busy', 5, 'database is locked'],
                JSON.stringify(refused),
            );
        } finally {
            other.exec('ROLLBACK');
            other.close();
        }
    });
});
