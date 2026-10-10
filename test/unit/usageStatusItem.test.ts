import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { modelById } from '../../src/tokenizer/registry';
import { RECENT_MS, parseLiveSession, readLiveSessions, type LiveSession } from '../../src/usage/liveSessions';
import type { UsageWorkerRequest, UsageWorkerResponse } from '../../src/usage/protocol';
import type { ResolvedRoots } from '../../src/usage/roots';
import { UsageStatusItem, contextWindow, describeLive, type LiveInput, type StatusItemService } from '../../src/usage/statusItem';
import type { LatestRequest } from '../../src/usage/store';
import { WorkerHost } from '../../src/workerHost';

const FIXTURE_ROOT = path.join(__dirname, '..', '..', '..', 'test', 'fixtures', 'claude-config');
const WORKER = path.join(__dirname, '..', '..', '..', 'out', 'usageWorker.js');

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
        // Truncated, never rounded up past a threshold not crossed.
        assert.strictEqual(at(799_999).status, 'ok');
        assert.ok(at(799_999).text.endsWith('79%'));
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

        const over = describeLive(live({ latest: latest({ model: 'claude-opus-4-6', input: 250_000, cacheCreation: 0, cacheRead: 0 }) }));
        assert.deepStrictEqual([over.text, over.status], ['$(comment-discussion) 250.0K ?', undefined]);
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
        // Another domain's pid means nothing here: the file is taken at its word.
        assert.ok(parseLiveSession(record({ pidDomain: 'linux' }), () => false, 'darwin', later));
        for (const bad of [record({ cwd: 'relative' }), record({ sessionId: 7 }), record({ cwd: '' }), '[1]', 'not json']) {
            assert.strictEqual(parseLiveSession(bad, alive, 'darwin', later), undefined, bad.slice(0, 40));
        }
    });

    test('a session updated in the last 15 minutes is live whatever its pid says here', () => {
        // A Flatpak editor, or a container's ~/.claude: the pid is another
        // namespace's, and names no process here while the session runs.
        const updated = 1_791_000_000_000;
        assert.ok(parseLiveSession(record({}), () => false, 'darwin', updated + RECENT_MS));
        assert.strictEqual(parseLiveSession(record({}), () => false, 'darwin', updated + RECENT_MS + 1), undefined);
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

        const sessions = await readLiveSessions([tmp], { isAlive: () => true, platform: 'darwin' });
        assert.deepStrictEqual(sessions.map(s => [s.sessionId, s.updatedAt]), [['newer', 3], ['older', 1]]);
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
        options: { shown?: boolean; sessions?: LiveSession[]; context?: Awaited<ReturnType<StatusItemService['liveContext']>>; started?: Promise<void> } = {},
    ) {
        const calls = { readLive: 0, holds: 0, released: 0, liveContext: 0 };
        const emitter = new vscode.EventEmitter<void>();
        const resolved: ResolvedRoots = { candidates: [], roots: [{ path: '/claude', source: 'default', exists: true }], refused: [], historyDisabled: false, largeContextDisabled: false };
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
            report: () => Promise.resolve(undefined),
            whenStarted: () => options.started ?? Promise.resolve(),
        };
        let shown = options.shown ?? true;
        const items: ReturnType<typeof fakeItem>[] = [];
        const statusItem = new UsageStatusItem(service, {
            shown: () => shown,
            readLive: () => {
                calls.readLive++;
                return Promise.resolve(options.sessions ?? []);
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

        for (const sessionId of ['../../etc/passwd', 'a/b', '', 'x'.repeat(201)]) {
            const refused = await host.send({ type: 'liveContext', id: 0, storeFile, roots: [FIXTURE_ROOT], sessionId });
            assert.deepStrictEqual(refused.type === 'failed' && refused.failure, 'bad-request', sessionId.slice(0, 20));
        }
    });
});
