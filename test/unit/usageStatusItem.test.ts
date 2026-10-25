import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { modelById } from '../../src/tokenizer/registry';
import { CLOCK_SKEW_MS, RECENT_MS, parseLiveSession, readLiveSessions, type LiveSession } from '../../src/usage/liveSessions';
import type { UsageWorkerRequest, UsageWorkerResponse } from '../../src/usage/protocol';
import type { UsageReport } from '../../src/usage/report';
import type { ResolvedRoots } from '../../src/usage/roots';
import { UsageStatusItem, contextWindow, describeLive, type LiveInput, type StatusItemService } from '../../src/usage/statusItem';
import { currentHistory } from '../../src/usage/historyFiles';
import { SCHEMA_VERSION, loadSqlite, type LatestRequest } from '../../src/usage/store';
import { WorkerHost } from '../../src/workerHost';

const FIXTURE_ROOT = path.join(__dirname, '..', '..', '..', 'test', 'fixtures', 'claude-config');
const WORKER = path.join(__dirname, '..', '..', '..', 'out', 'usageWorker.js');
const sqlite = loadSqlite();

function latest(overrides: Partial<LatestRequest> = {}): LatestRequest {
    return { timestamp: Date.UTC(2026, 9, 9, 10), model: 'claude-opus-5-5', variant: null, input: 1_000, cacheCreation: 9_000, cacheRead: 840_000, ...overrides };
}

function live(overrides: Partial<LiveInput> = {}): LiveInput {
    return {
        latest: latest(),
        compactions: [],
        largeContextDisabled: false,
        todayProcessed: undefined,
        formatTime: ms => new Date(ms).toISOString().slice(0, 16).replace('T', ' '),
        ...overrides,
    };
}

suite('usage status item: the window and what is shown', () => {
    test("the window is Claude Code's: the variant chooses it where a model has two", () => {
        const opus46 = modelById('claude-opus-4-6');
        assert.strictEqual(contextWindow(opus46, null, false), 200_000);
        assert.strictEqual(contextWindow(opus46, '1m', false), 1_000_000);
        assert.strictEqual(contextWindow(modelById('claude-opus-5-5'), null, false), 1_000_000);
        assert.strictEqual(contextWindow(modelById('claude-opus-5-5'), '1m', false), 1_000_000);
        assert.strictEqual(contextWindow(modelById('claude-haiku-4-5'), '1m', false), 200_000);
        // CLAUDE_CODE_DISABLE_1M_CONTEXT holds every model to 200K.
        assert.strictEqual(contextWindow(modelById('claude-opus-5-5'), null, true), 200_000);
        assert.strictEqual(contextWindow(undefined, null, false), undefined);
    });

    test('a share, and its colours, at 80 % and 100 % of the window', () => {
        // The colour test: below, at the warning threshold, and full.
        const at = (occupied: number) => describeLive(live({ latest: latest({ input: occupied, cacheCreation: 0, cacheRead: 0 }) }));
        assert.deepStrictEqual([at(500_000).status, at(500_000).text], ['ok', '$(comment-discussion) 500.0K · 50%']);
        assert.deepStrictEqual([at(800_000).status, at(800_000).text], ['warning', '$(warning) 800.0K · 80%']);
        assert.deepStrictEqual([at(1_000_000).status, at(1_000_000).text], ['error', '$(error) 1.0M · 100%']);
        // Truncated, never rounded up past a threshold not crossed, the figure as the share.
        assert.strictEqual(at(799_999).status, 'ok');
        assert.strictEqual(at(799_999).text, '$(comment-discussion) 799.9K · 79%');
        const full = describeLive(live({ latest: latest({ model: 'claude-opus-4-6', input: 199_999, cacheCreation: 0, cacheRead: 0 }) }));
        assert.strictEqual(full.text, '$(warning) 199.9K · 99%');
    });

    test('a compaction after the latest request shows what it left', () => {
        const compacted = describeLive(
            live({ compactions: [{ uuid: 'c', sessionId: 's', kind: 'main', timestamp: Date.UTC(2026, 9, 9, 11), trigger: 'auto', preTokens: 160_000, postTokens: 12_000 }] }),
        );
        assert.strictEqual(compacted.text, '$(comment-discussion) 12.0K · 1%');
        assert.ok(compacted.tooltip.some(l => l.includes('12,000 of 1,000,000 tokens') && l.includes('after compacting')));

        const before = describeLive(
            live({ compactions: [{ uuid: 'c', sessionId: 's', kind: 'main', timestamp: Date.UTC(2026, 9, 9, 9), trigger: 'manual', preTokens: 100_000, postTokens: 9_000 }] }),
        );
        assert.strictEqual(before.text, '$(comment-discussion) 850.0K · 85%'.replace('$(comment-discussion)', '$(warning)'));
        assert.ok(before.tooltip.some(l => l.startsWith('Compactions: 1, the last 100,000 → 9,000')));
    });

    test('an unknown model, or more than its window, shows the figure alone, with ?, and no colour', () => {
        const unknown = describeLive(live({ latest: latest({ model: '[x](https://example.com) not-a-model' }) }));
        assert.deepStrictEqual([unknown.text, unknown.status], ['$(comment-discussion) 850.0K ?', undefined]);
        // Shown as written, in a plain-text tooltip.
        assert.ok(unknown.tooltip.includes('Model: [x](https://example.com) not-a-model'));

        // Past the only window a model is known to have: that window is wrong, and no share is made up.
        const over = describeLive(live({ latest: latest({ model: 'claude-haiku-4-5', input: 250_000, cacheCreation: 0, cacheRead: 0 }) }));
        assert.deepStrictEqual([over.text, over.status], ['$(comment-discussion) 250.0K ?', undefined]);
    });

    test('a model with two windows ran in the larger once the session held more than the smaller, named or not', () => {
        // Few records name [1m]: a context only the larger window takes says it too.
        const opus46 = (occupied: number, largestContext?: number, largeContextDisabled = false) =>
            describeLive(
                live({
                    latest: latest({ model: 'claude-opus-4-6', input: occupied, cacheCreation: 0, cacheRead: 0, ...(largestContext === undefined ? {} : { largestContext }) }),
                    largeContextDisabled,
                }),
            ).text;
        assert.strictEqual(opus46(150_000), '$(comment-discussion) 150.0K · 75%');
        assert.strictEqual(opus46(150_000, 199_999), '$(comment-discussion) 150.0K · 75%');
        assert.strictEqual(opus46(150_000, 250_000), '$(comment-discussion) 150.0K · 15%');
        // The latest request is evidence of its own.
        assert.strictEqual(opus46(250_000), '$(comment-discussion) 250.0K · 25%');
        // CLAUDE_CODE_DISABLE_1M_CONTEXT still holds it to 200K.
        assert.strictEqual(opus46(150_000, 250_000, true), '$(comment-discussion) 150.0K · 75%');
    });

    test("the tooltip adds today's tokens in this workspace, marked when a lower bound", () => {
        const today = (partial: boolean) => describeLive(live({ todayProcessed: { tokens: 1_234_567, partial } })).tooltip;
        assert.ok(today(false).includes('Today in this workspace: 1.2M processed'), today(false).join('|'));
        assert.ok(today(true).includes('Today in this workspace: ≥1.2M processed'));
        assert.ok(!describeLive(live()).tooltip.some(l => l.startsWith('Today')));
    });

    test('a request that missed a counter, or nothing yet, shows a dash', () => {
        assert.strictEqual(describeLive(live({ latest: latest({ cacheRead: null }) })).text, '$(comment-discussion) —');
        assert.strictEqual(describeLive(live({ latest: null })).text, '$(comment-discussion) —');
    });
});

suite('usage status item: running sessions', () => {
    let tmp: string;

    setup(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-tokenizer-live-'));
    });

    teardown(() => {
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    const record = (fields: Record<string, unknown>) =>
        JSON.stringify({
            pid: 4242,
            pidDomain: 'darwin',
            sessionId: 'abc-123',
            cwd: '/repo',
            status: 'busy',
            updatedAt: 1_791_000_000_000,
            messagingSocketPath: '/tmp/secret.sock',
            ...fields,
        });

    test('only the fields it needs are kept, and a dead local process is no live session', () => {
        const alive = () => true;
        // Long after the record's own update.
        const later = 1_791_000_000_000 + RECENT_MS + 1;
        assert.deepStrictEqual(parseLiveSession(record({}), alive, 'darwin', later), {
            sessionId: 'abc-123',
            cwd: '/repo',
            status: 'busy',
            updatedAt: 1_791_000_000_000,
        });
        assert.strictEqual(parseLiveSession(record({}), () => false, 'darwin', later), undefined, 'a dead pid read as live');
        assert.strictEqual(parseLiveSession(record({ updatedAt: undefined }), () => false, 'darwin', later), undefined);
        // Another domain's pid means nothing here: only a recent update says it runs.
        assert.ok(parseLiveSession(record({ pidDomain: 'linux' }), () => false, 'darwin', 1_791_000_000_000 + 60_000));
        assert.strictEqual(parseLiveSession(record({ pidDomain: 'linux' }), () => false, 'darwin', later), undefined);
        // An id the worker would refuse would make every look fail.
        for (const bad of [record({ cwd: 'relative' }), record({ sessionId: 7 }), record({ sessionId: 'not.a.uuid' }), record({ cwd: '' }), '[1]', 'not json']) {
            assert.strictEqual(parseLiveSession(bad, alive, 'darwin', later), undefined, bad.slice(0, 40));
        }
    });

    test('on Linux a session updated in the last 15 minutes is live whatever its pid says; elsewhere a dead pid is a leftover', () => {
        // A Flatpak editor, or a container's ~/.claude: the pid is another
        // namespace's, and names no process here while the session runs.
        const updated = 1_791_000_000_000;
        const linux = (fields: Record<string, unknown>, now: number) => parseLiveSession(record({ pidDomain: 'linux', ...fields }), () => false, 'linux', now);
        assert.ok(linux({}, updated + RECENT_MS));
        assert.strictEqual(linux({}, updated + RECENT_MS + 1), undefined);
        // An update ahead of this clock by more than a skew is no evidence.
        assert.ok(linux({}, updated - CLOCK_SKEW_MS));
        assert.strictEqual(linux({}, updated - CLOCK_SKEW_MS - 1), undefined);
        // macOS and Windows have no PID namespaces: a dead pid is final.
        assert.strictEqual(parseLiveSession(record({}), () => false, 'darwin', updated + 1), undefined);
    });

    test('only <pid>.json files are read, newest session first, one entry per session', async () => {
        const dir = path.join(tmp, 'sessions');
        fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, '1.json'), record({ sessionId: 'older', updatedAt: 1 }));
        fs.writeFileSync(path.join(dir, '2.json'), record({ sessionId: 'newer', updatedAt: 2 }));
        fs.writeFileSync(path.join(dir, '3.json'), record({ sessionId: 'newer', updatedAt: 3 }));
        // Never opened: a key file, a name that is not a pid, and a folder.
        fs.writeFileSync(path.join(dir, '1.key'), record({ sessionId: 'from-a-key-file' }));
        fs.writeFileSync(path.join(dir, 'x.json'), record({ sessionId: 'not-a-pid' }));
        fs.mkdirSync(path.join(dir, '9.json'));
        // Valid, but larger than any real one: only the size cap keeps it out.
        fs.writeFileSync(path.join(dir, '4.json'), record({ sessionId: 'huge', updatedAt: 9, pad: 'x'.repeat(64 << 10) }));

        // A second root, whose session is newer still: each is told which root named it,
        // so that a root's own settings hold its sessions only.
        const other = path.join(tmp, 'other-root');
        fs.mkdirSync(path.join(other, 'sessions'), { recursive: true });
        fs.writeFileSync(path.join(other, 'sessions', '5.json'), record({ sessionId: 'elsewhere', updatedAt: 5 }));

        const sessions = await readLiveSessions([tmp, other], { isAlive: () => true, platform: 'darwin' });
        assert.deepStrictEqual(sessions.map(s => [s.sessionId, s.updatedAt, s.root]), [['elsewhere', 5, other], ['newer', 3, tmp], ['older', 1, tmp]]);
    });

    test('a leftover file dated far ahead, whose pid still answers, never outranks the running session', async () => {
        const dir = path.join(tmp, 'sessions');
        fs.mkdirSync(dir);
        const now = 1_791_000_000_000;
        fs.writeFileSync(path.join(dir, '1.json'), record({ sessionId: 'leftover-pid1', pid: 1, updatedAt: Number.MAX_SAFE_INTEGER }));
        fs.writeFileSync(path.join(dir, '2.json'), record({ sessionId: 'leftover-reused', pid: 2, updatedAt: now + 6 * 60 * 60_000 }));
        fs.writeFileSync(path.join(dir, '3.json'), record({ sessionId: 'running-now', pid: 3, updatedAt: now - 1_000 }));
        // Within the skew, an update time is believed, and ranks.
        fs.writeFileSync(path.join(dir, '4.json'), record({ sessionId: 'skewed', pid: 4, updatedAt: now + CLOCK_SKEW_MS }));
        const sessions = await readLiveSessions([tmp], { isAlive: () => true, platform: 'darwin', now });
        assert.deepStrictEqual(sessions.slice(0, 2).map(s => [s.sessionId, s.updatedAt]), [['skewed', now + CLOCK_SKEW_MS], ['running-now', now - 1_000]]);
        assert.deepStrictEqual(sessions.slice(2).map(s => [s.sessionId, s.updatedAt]).sort(), [['leftover-pid1', null], ['leftover-reused', null]]);
    });
});

suite('usage status item: the item', () => {
    /** An item that records what it was told. */
    function fakeItem() {
        const item = { text: '', tooltip: '' as unknown, name: '', command: '', color: undefined, backgroundColor: undefined as unknown, visible: false, disposed: false };
        return Object.assign(item, {
            show: () => (item.visible = true),
            hide: () => (item.visible = false),
            dispose: () => (item.disposed = true),
        });
    }

    function harness(
        options: {
            shown?: boolean;
            sessions?: LiveSession[];
            readLive?: () => Promise<LiveSession[]>;
            context?: Awaited<ReturnType<StatusItemService['liveContext']>>;
            started?: Promise<void>;
            largeContextDisabledRoots?: string[];
            /** Today's tokens in the workspace, as its report gives them. */
            today?: number;
            reading?: StatusItemService['reading'];
        } = {},
    ) {
        const calls = { readLive: 0, holds: 0, released: 0, liveContext: 0 };
        const emitter = new vscode.EventEmitter<void>();
        const resolved: ResolvedRoots = {
            candidates: [],
            roots: [{ path: '/claude', source: 'default', exists: true }],
            refused: [],
            historyDisabled: false,
            largeContextDisabled: false,
            largeContextDisabledRoots: options.largeContextDisabledRoots ?? [],
        };
        const service: StatusItemService = {
            roots: resolved,
            onDidChange: emitter.event,
            hold: () => {
                calls.holds++;
                return new vscode.Disposable(() => calls.released++);
            },
            liveContext: () => {
                calls.liveContext++;
                return Promise.resolve('context' in options ? options.context : { latest: latest(), compactions: [] });
            },
            report: () =>
                Promise.resolve(options.today === undefined ? undefined : ({ totals: { processed: options.today, provenance: 'reported' } } as UsageReport)),
            whenStarted: () => options.started ?? Promise.resolve(),
            reading: options.reading,
        };
        let shown = options.shown ?? true;
        const items: ReturnType<typeof fakeItem>[] = [];
        const statusItem = new UsageStatusItem(service, {
            shown: () => shown,
            readLive: () => {
                calls.readLive++;
                return options.readLive ? options.readLive() : Promise.resolve(options.sessions ?? []);
            },
            workspaceFolders: () => ['/work/repo'],
            platform: 'linux',
            zone: () => 'UTC',
            formatTime: ms => String(ms),
            createItem: () => {
                const item = fakeItem();
                items.push(item);
                return item as unknown as vscode.StatusBarItem;
            },
        });
        return { statusItem, calls, items, emitter, setShown: (value: boolean) => ((shown = value), statusItem.settingsChanged()) };
    }

    const session = (cwd: string): LiveSession => ({ sessionId: 's1', cwd, status: 'busy', updatedAt: 1 });

    /** Let the item's start and its first look run. */
    const settle = async () => {
        for (let i = 0; i < 5; i++) {
            await new Promise<void>(resolve => setImmediate(resolve));
        }
    };

    test('a look that never ends holds no later item: turned off and on, the new one looks', async () => {
        // A read of a sessions file that never returns, as a FIFO's did.
        let first = true;
        const { statusItem, calls, items, setShown } = harness({
            readLive: () => (first ? ((first = false), new Promise<LiveSession[]>(() => undefined)) : Promise.resolve([session('/work/repo')])),
        });
        await settle();
        setShown(false);
        setShown(true);
        await settle();
        assert.deepStrictEqual([calls.readLive, items.at(-1)?.visible], [2, true], 'the new item never looked');
        statusItem.dispose();
    });

    test('nothing is held, read or shown before the service has started', async () => {
        // It starts once the startup project scan has settled: never in the
        // activation tick, where the item is created.
        let start!: () => void;
        const started = new Promise<void>(resolve => (start = resolve));
        const { statusItem, calls, items, emitter } = harness({ sessions: [session('/work/repo')], started });
        emitter.fire();
        await statusItem.refresh();
        await settle();
        assert.deepStrictEqual([calls.holds, calls.readLive, calls.liveContext, items[0]?.visible], [0, 0, 0, false]);
        start();
        await settle();
        assert.deepStrictEqual([calls.holds, calls.readLive, calls.liveContext, items[0]?.visible], [1, 1, 1, true]);
        statusItem.dispose();
    });

    test('off, it creates nothing and reads nothing', async () => {
        const { statusItem, calls, items, emitter } = harness({ shown: false, sessions: [session('/work/repo')] });
        emitter.fire();
        await statusItem.refresh();
        assert.deepStrictEqual([calls, items.length], [{ readLive: 0, holds: 0, released: 0, liveContext: 0 }, 0]);
        statusItem.dispose();
    });

    test('a session running in this workspace is shown, and one elsewhere is not', async () => {
        const here = harness({ sessions: [session('/work/repo/.claude/worktrees/feat')] });
        await settle();
        await here.statusItem.refresh();
        assert.ok(here.items[0].visible);
        assert.strictEqual(here.items[0].text, '$(warning) 850.0K · 85%');
        assert.strictEqual(here.items[0].command, 'llm-tokenizer.showClaudeCodeUsage');
        // Plain text: a Markdown tooltip would render a record's text as links.
        assert.strictEqual(typeof here.items[0].tooltip, 'string');
        here.statusItem.dispose();

        const elsewhere = harness({ sessions: [session('/work/other')] });
        await settle();
        await elsewhere.statusItem.refresh();
        assert.deepStrictEqual([elsewhere.items[0].visible, elsewhere.calls.liveContext], [false, 0]);
        elsewhere.statusItem.dispose();
    });

    test("a data folder's own CLAUDE_CODE_DISABLE_1M_CONTEXT holds the sessions it names, and no other folder's", async () => {
        const shownFor = async (root: string) => {
            const h = harness({ sessions: [{ ...session('/work/repo'), root }], largeContextDisabledRoots: ['/claude-work'] });
            await settle();
            await h.statusItem.refresh();
            const text = h.items[0].text;
            h.statusItem.dispose();
            return text;
        };
        // 850K on Opus 5.5: past the 200K the flag holds it to, so no share.
        assert.strictEqual(await shownFor('/claude-work'), '$(comment-discussion) 850.0K ?');
        assert.strictEqual(await shownFor('/claude'), '$(warning) 850.0K · 85%');
    });

    test("while the history is read, the tooltip says the figure can be behind, and today's total is a lower bound", async () => {
        const look = async (reading: StatusItemService['reading']) => {
            const h = harness({ sessions: [session('/work/repo')], context: { latest: null, compactions: [] }, today: 1_234_567, reading });
            await settle();
            await h.statusItem.refresh();
            const tooltip = String(h.items[0].tooltip);
            h.statusItem.dispose();
            return tooltip;
        };
        const reading = await look({ by: 'this window', files: 10, of: 100 });
        for (const said of ['Context: not read yet.', "Still reading Claude Code's records, so this can be behind.", 'Today in this workspace: ≥1.2M processed']) {
            assert.ok(reading.includes(said), `${said} | ${reading}`);
        }
        const done = await look(undefined);
        assert.ok(done.includes('Context: not reported yet.') && !done.includes('Still reading') && done.includes('Today in this workspace: 1.2M processed'), done);
    });

    test('a failure shows a neutral dash; turned off, the item goes and the hold with it', async () => {
        const { statusItem, items, calls, setShown } = harness({ sessions: [session('/work/repo')], context: undefined });
        await settle();
        await statusItem.refresh();
        assert.deepStrictEqual([items[0].text, items[0].backgroundColor, items[0].visible], ['$(comment-discussion) —', undefined, true]);
        setShown(false);
        assert.deepStrictEqual([items[0].disposed, calls.holds, calls.released], [true, 1, 1]);
        statusItem.dispose();
    });
});

suite('usage status item: through the worker', () => {
    let tmp: string;
    const hosts: WorkerHost<UsageWorkerRequest, UsageWorkerResponse>[] = [];

    setup(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-tokenizer-live-worker-'));
    });

    teardown(async () => {
        await Promise.all(hosts.splice(0).map(h => h.dispose()));
        // Windows lets a folder go only once nothing in it is open.
        fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    });

    test("one session's transcript is read, then its latest main request and compactions; an unsafe id is refused", async () => {
        const host = new WorkerHost<UsageWorkerRequest, UsageWorkerResponse>(WORKER, {
            name: 'usage',
            fallback: 'nothing',
            log: { error: () => undefined, warn: () => undefined },
        });
        hosts.push(host);
        const storeFile = path.join(tmp, 'store', 'usage.sqlite');
        // Everything first, so the session's later Task and workflow requests
        // (10:10 and 23:30) are in the history beside its main conversation.
        assert.strictEqual((await host.send({ type: 'import', id: 0, storeFile, roots: [FIXTURE_ROOT] })).type, 'imported');
        const response = await host.send({ type: 'liveContext', id: 0, storeFile, roots: [FIXTURE_ROOT], sessionId: 'sess-main-1' });
        assert.strictEqual(response.type, 'liveContext', JSON.stringify(response).slice(0, 200));
        if (response.type !== 'liveContext') {
            return;
        }
        // R2, the last request of the main conversation: subagents and the
        // workflow agent do not count, and the refused placeholder is no request.
        assert.deepStrictEqual(
            [response.latest?.timestamp, response.latest?.variant, response.latest?.input, response.latest?.cacheCreation, response.latest?.cacheRead],
            [Date.parse('2026-10-09T10:05:00.000Z'), '1m', 70, 10, 100],
        );
        assert.deepStrictEqual(response.compactions.map(c => [c.trigger, c.postTokens]), [['auto', 12_000]]);
        // So the item shows what the compaction left, the compaction being the newer.
        assert.strictEqual(describeLive(live({ latest: response.latest, compactions: response.compactions })).text, '$(comment-discussion) 12.0K · 1%');

        // A subagent compacts its own context: never the main conversation's figure.
        const subagent = path.join(tmp, 'sub-root', 'projects', 'p');
        fs.mkdirSync(path.join(subagent, 'sess-x', 'subagents'), { recursive: true });
        const record = (fields: object) => JSON.stringify({ sessionId: 'sess-x', timestamp: '2026-10-09T10:00:00.000Z', ...fields }) + '\n';
        fs.writeFileSync(
            path.join(subagent, 'sess-x.jsonl'),
            record({ type: 'user', uuid: 'u', cwd: '/x', message: { role: 'user', content: 'x' } }) +
                record({ type: 'assistant', uuid: 'a', message: { model: 'claude-opus-5-5', id: 'mx', usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } }),
        );
        fs.writeFileSync(
            path.join(subagent, 'sess-x', 'subagents', 'agent-1.jsonl'),
            record({ type: 'system', subtype: 'compact_boundary', uuid: 'sub-compaction', compactMetadata: { trigger: 'auto', preTokens: 9, postTokens: 1 } }),
        );
        assert.strictEqual((await host.send({ type: 'import', id: 0, storeFile, roots: [path.join(tmp, 'sub-root')] })).type, 'imported');
        const sub = await host.send({ type: 'liveContext', id: 0, storeFile, roots: [path.join(tmp, 'sub-root')], sessionId: 'sess-x' });
        assert.deepStrictEqual(sub.type === 'liveContext' && sub.compactions, []);
        const report = await host.send({ type: 'query', id: 0, storeFile, range: 'coverage', zone: 'UTC', workspaceFolders: null });
        assert.ok(report.type === 'report');
        assert.deepStrictEqual(report.report.sessions.find(x => x.sessionId === 'sess-x')?.compactions, []);

        // A history a newer version wrote is read-only here, and still read.
        await host.send({ type: 'close', id: 0 });
        assert.ok(sqlite, 'this runtime has no node:sqlite');
        const raw = new sqlite.DatabaseSync(currentHistory(path.dirname(storeFile)) ?? storeFile);
        raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
        raw.close();
        const readOnly = await host.send({ type: 'liveContext', id: 0, storeFile, roots: [FIXTURE_ROOT], sessionId: 'sess-main-1' });
        assert.ok(readOnly.type === 'liveContext' && readOnly.latest?.input === 70, JSON.stringify(readOnly).slice(0, 200));

        for (const sessionId of ['../../etc/passwd', 'a/b', '', 'x'.repeat(201)]) {
            const refused = await host.send({ type: 'liveContext', id: 0, storeFile, roots: [FIXTURE_ROOT], sessionId });
            assert.deepStrictEqual(refused.type === 'failed' && refused.failure, 'bad-request', sessionId.slice(0, 20));
        }
    });

    test('a look behind a full pass reads what is stored, at once, and the next one reads the session', async () => {
        // The item stayed hidden through a whole first import, its look
        // queued behind it: 24 s for 10,000 transcripts.
        const host = new WorkerHost<UsageWorkerRequest, UsageWorkerResponse>(WORKER, {
            name: 'usage',
            fallback: 'nothing',
            log: { error: () => undefined, warn: () => undefined },
        });
        hosts.push(host);
        const storeFile = path.join(tmp, 'store', 'usage.sqlite');
        const root = path.join(tmp, 'root');
        const project = path.join(root, 'projects', '-repo');
        fs.mkdirSync(project, { recursive: true });
        const transcript = (sessionId: string, input: number) => {
            const record = (fields: object) => JSON.stringify({ sessionId, timestamp: '2026-10-09T10:00:00.000Z', ...fields }) + '\n';
            fs.writeFileSync(
                path.join(project, `${sessionId}.jsonl`),
                record({ type: 'user', uuid: `u-${sessionId}`, cwd: '/repo', message: { role: 'user', content: 'x' } }) +
                    record({
                        type: 'assistant',
                        uuid: `a-${sessionId}`,
                        message: { model: 'claude-opus-5-5', id: `m-${sessionId}`, usage: { input_tokens: input, cache_creation_input_tokens: 3, cache_read_input_tokens: 11, output_tokens: 1 } },
                    }),
            );
        };
        for (let i = 0; i < 600; i++) {
            transcript(`sess-${i}`, 1);
        }
        // Last in the pass's order, so not read yet when the look is answered.
        transcript('zzz-live', 7);
        const order: string[] = [];
        const pass = host.send({ type: 'import', id: 0, storeFile, roots: [root] }).then(r => (order.push('pass'), r));
        const look = host.send({ type: 'liveContext', id: 0, storeFile, roots: [root], sessionId: 'zzz-live' }).then(r => (order.push('look'), r));
        const [, early] = await Promise.all([pass, look]);
        assert.deepStrictEqual(order, ['look', 'pass'], 'the look waited for the whole pass');
        assert.ok(early.type === 'liveContext' && early.latest === null, JSON.stringify(early).slice(0, 200));
        const later = await host.send({ type: 'liveContext', id: 0, storeFile, roots: [root], sessionId: 'zzz-live' });
        assert.ok(later.type === 'liveContext' && later.latest?.input === 7, JSON.stringify(later).slice(0, 200));
    });
});
