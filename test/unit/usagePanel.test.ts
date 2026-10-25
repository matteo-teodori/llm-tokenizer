import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { logoIcon } from '../../src/logo';
import { emptyTotals } from '../../src/usage/aggregate';
import type { ImportSummary } from '../../src/usage/importer';
import { UsagePanel, openUsageSettings } from '../../src/usage/panel';
import type { PanelFragments } from '../../src/usage/render';
import { buildReport, type RangeKey, type UsageReport } from '../../src/usage/report';
import type { Reading, UsageService } from '../../src/usage/usageService';

/** A history of three requests, none of them in the range shown. */
function quietReport(overrides: Partial<UsageReport> = {}): UsageReport {
    return {
        ...buildReport(
            { sums: [], sessions: [], compactions: [], limitHits: [], coverage: { start: null, newest: null, requests: 3, ahead: 0, files: 1, oversizeLines: 0, malformedLines: 0 } },
            { range: '7d', zone: 'UTC', now: Date.UTC(2026, 9, 10, 12), scope: 'all' },
        ),
        ...overrides,
    };
}

/** A webview panel that records what is done to it, hidden and shown by the test. */
function fakePanel() {
    const viewState = new vscode.EventEmitter<vscode.WebviewPanelOnDidChangeViewStateEvent>();
    const disposed = new vscode.EventEmitter<void>();
    const messages = new vscode.EventEmitter<unknown>();
    const pages: string[] = [];
    const posted: PanelFragments[] = [];
    let gone = false;
    const panel = {
        visible: true,
        webview: {
            get html(): string {
                return pages.at(-1) ?? '';
            },
            set html(value: string) {
                pages.push(value);
            },
            postMessage: (message: { type: string; fragments: PanelFragments }) => {
                posted.push(message.fragments);
                return Promise.resolve(true);
            },
            onDidReceiveMessage: messages.event,
        },
        onDidChangeViewState: viewState.event,
        onDidDispose: disposed.event,
        reveal: () => setVisible(true),
        dispose: () => {
            if (!gone) {
                gone = true;
                disposed.fire();
            }
        },
    };
    const setVisible = (visible: boolean) => {
        panel.visible = visible;
        viewState.fire({ webviewPanel: panel as unknown as vscode.WebviewPanel });
    };
    return { panel, pages, posted, setVisible, send: (message: unknown) => messages.fire(message), disposed: () => gone };
}

/** The service as the panel uses it; `counts` records each use. */
function fakeService() {
    const counts = { holds: 0, releases: 0, refreshes: 0 };
    const changed = new vscode.EventEmitter<void>();
    const fake = {
        status: 'ready',
        roots: undefined,
        lastImport: undefined,
        missingSqlite: undefined,
        recoveredFrom: undefined,
        onDidChange: changed.event,
        /** What the next refresh returns: a summary when a pass ran. */
        passes: undefined as ImportSummary | undefined,
        report: quietReport(),
        /** In place of `report`, a report per range, as it comes. */
        reportFor: undefined as ((range: RangeKey) => Promise<UsageReport>) | undefined,
        reading: undefined as Reading | undefined,
        /** A hold that throws, as one did whose watchers could not start. */
        holdThrows: false,
    };
    const service = {
        get status() {
            return fake.status;
        },
        get roots() {
            return fake.roots;
        },
        get lastImport() {
            return fake.lastImport;
        },
        get missingSqlite() {
            return fake.missingSqlite;
        },
        get recoveredFrom() {
            return fake.recoveredFrom;
        },
        get reading() {
            return fake.reading;
        },
        onDidChange: fake.onDidChange,
        hold: () => {
            if (fake.holdThrows) {
                throw new TypeError("Cannot read properties of null (reading 'trim')");
            }
            counts.holds++;
            return new vscode.Disposable(() => counts.releases++);
        },
        refresh: () => {
            counts.refreshes++;
            return Promise.resolve(fake.passes);
        },
        report: (range: RangeKey) => (fake.reportFor ? fake.reportFor(range) : Promise.resolve(fake.report)),
    };
    return { service: service as unknown as UsageService, counts, fake, changed: () => changed.fire() };
}

/** An extension context whose global state is kept, as the editor keeps it between sessions. */
function fakeContext(): vscode.ExtensionContext {
    const state = new Map<string, unknown>();
    return {
        globalState: {
            get: (key: string) => state.get(key),
            update: (key: string, value: unknown) => (state.set(key, value), Promise.resolve()),
        },
        extension: { packageJSON: { version: '2.2.0' } },
        extensionUri: vscode.Uri.file(path.join(os.tmpdir(), 'llm-tokenizer-extension')),
    } as unknown as vscode.ExtensionContext;
}

let context = fakeContext();
const warnings: string[] = [];
let logShown = 0;
const log = { warn: (m: string) => warnings.push(m), show: () => logShown++ } as unknown as vscode.LogOutputChannel;

async function until(condition: () => boolean, ms = 2_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!condition() && Date.now() < deadline) {
        await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.ok(condition(), 'timed out');
}

/** Let the panel's promise chains run. */
async function settle(): Promise<void> {
    for (let i = 0; i < 10; i++) {
        await new Promise<void>(resolve => setImmediate(resolve));
    }
}

suite('usage panel', () => {
    let page: ReturnType<typeof fakePanel>;
    let create: typeof vscode.window.createWebviewPanel;

    setup(() => {
        page = fakePanel();
        context = fakeContext();
        warnings.length = 0;
        logShown = 0;
        create = vscode.window.createWebviewPanel.bind(vscode.window);
        (vscode.window as unknown as { createWebviewPanel: unknown }).createWebviewPanel = () => page.panel;
    });

    teardown(() => {
        (vscode.window as unknown as { createWebviewPanel: unknown }).createWebviewPanel = create;
        page.panel.dispose();
    });

    test("its tab shows the logo's T", () => {
        const { service } = fakeService();
        UsagePanel.show(context, service, log);
        assert.deepStrictEqual((page.panel as { iconPath?: unknown }).iconPath, logoIcon(context.extensionUri));
    });

    test('brought back from hidden, it holds the service again and looks at once', async () => {
        const { service, counts } = fakeService();
        UsagePanel.show(context, service, log);
        await settle();
        assert.deepStrictEqual(counts, { holds: 1, releases: 0, refreshes: 1 });

        page.setVisible(false);
        assert.deepStrictEqual(counts, { holds: 1, releases: 1, refreshes: 1 });
        // Its tab clicked, not the command: nothing else would look.
        page.setVisible(true);
        await settle();
        assert.deepStrictEqual(counts, { holds: 2, releases: 1, refreshes: 2 });
    });

    test('hidden, its page is rebuilt from the latest data, so it comes back showing that', async () => {
        const { service } = fakeService();
        UsagePanel.show(context, service, log);
        await until(() => page.posted.length > 0);
        assert.ok(page.panel.webview.html.includes('Reading Claude Code'), 'the first page should wait for data');

        page.setVisible(false);
        assert.ok(page.panel.webview.html.includes('No requests fall in this range.'), 'the hidden page is still the empty one');
    });

    test('what changes while it is hidden is in the page it comes back from', async () => {
        const { service, fake, changed } = fakeService();
        UsagePanel.show(context, service, log);
        await until(() => page.posted.length > 0);
        page.setVisible(false);
        const posts = page.posted.length;
        fake.report = quietReport({ coverage: { ...quietReport().coverage, requests: 0 } });
        changed();
        await until(() => page.panel.webview.html.includes('No Claude Code requests have been read yet'));
        assert.strictEqual(page.posted.length, posts, 'posted to a hidden page, which drops it');
    });

    test('the refreshed time is shown only after a pass that ran', async () => {
        const { service, fake } = fakeService();
        // Another window holds the import, or it failed: no pass ran here.
        UsagePanel.show(context, service, log);
        await until(() => page.posted.length > 0);
        assert.ok(!page.posted.at(-1)?.controls.includes('refreshed '), 'stamped though no pass ran');

        fake.passes = {} as ImportSummary;
        page.send({ type: 'refresh' });
        await until(() => page.posted.at(-1)?.controls.includes('refreshed ') === true);
    });

    test('a time its zone cannot place is a dash, and the update still goes out', async () => {
        const { service, fake } = fakeService();
        const session = {
            sessionId: 's',
            project: { kind: 'root' as const, path: '/repo' },
            label: 'repo',
            firstTs: 9e15,
            lastTs: 9e15,
            totals: emptyTotals(),
            models: [],
            compactions: [],
        };
        fake.report = quietReport({ sessions: [session] });
        UsagePanel.show(context, service, log);
        await until(() => page.posted.length > 0 || warnings.length > 0);
        assert.deepStrictEqual(warnings, []);
        assert.strictEqual(page.posted.at(-1)?.copy.rows[0]?.[0], '—');
    });

    test("the page brought back is always answered; otherwise only what changed is sent", async () => {
        const { service, fake, changed } = fakeService();
        UsagePanel.show(context, service, log);
        // The zone first, so that the next ready changes nothing.
        page.send({ type: 'ready', zone: 'Asia/Tokyo' });
        await until(() => page.posted.length > 0);
        await settle();
        const sent = page.posted.length;
        // Nothing new: nothing sent.
        changed();
        await settle();
        assert.strictEqual(page.posted.length, sent);
        // A page brought back from hidden starts empty, so it is answered all the same.
        page.send({ type: 'ready', zone: 'Asia/Tokyo' });
        await until(() => page.posted.length === sent + 1);
        // New data is sent.
        fake.report = quietReport({ coverage: { ...quietReport().coverage, requests: 4 } });
        changed();
        await until(() => page.posted.length === sent + 2);
    });

    test('its range, scope and the reader\'s zone are kept for the next time it opens', async () => {
        const { service } = fakeService();
        UsagePanel.show(context, service, log);
        page.send({ type: 'ready', zone: 'Asia/Tokyo' });
        page.send({ type: 'setRange', range: '30d' });
        page.send({ type: 'setScope', scope: 'workspace' });
        await settle();
        page.panel.dispose();

        page = fakePanel();
        const reopened: { range?: string; scope?: string; zone?: string }[] = [];
        UsagePanel.show(context, { ...service, report: (range: string, zone: string, folders: string[] | null) => (reopened.push({ range, zone, scope: folders ? 'workspace' : 'all' }), Promise.resolve(undefined)) } as unknown as UsageService, log);
        await until(() => reopened.length > 0);
        assert.deepStrictEqual(reopened[0], { range: '30d', zone: 'Asia/Tokyo', scope: 'workspace' });
    });

    test('each action the page can ask for does what it says, and nothing else', async () => {
        // Copy and Export write the clipboard, which the editor does not let a
        // test replace, and which is the developer's own: their messages are
        // checked by parsePanelMessage's test instead.
        const { service } = fakeService();
        const ran: unknown[][] = [];
        const original = vscode.commands.executeCommand;
        (vscode.commands as unknown as Record<string, unknown>).executeCommand = (...args: unknown[]) => (ran.push(args), Promise.resolve(undefined));
        try {
            UsagePanel.show(context, service, log);
            page.send({ type: 'openSettings' });
            page.send({ type: 'clear' });
            page.send({ type: 'showLog' });
            page.send({ type: 'openFile', path: '/etc/passwd' });
            await settle();
            assert.deepStrictEqual(ran, [
                ['workbench.action.openSettings', { query: 'llm-tokenizer.enableClaudeCodeUsage' }],
                ['llm-tokenizer.clearClaudeCodeUsageHistory'],
            ]);
            assert.strictEqual(logShown, 1);
        } finally {
            (vscode.commands as unknown as Record<string, unknown>).executeCommand = original;
        }
    });

    test('a range chosen while a report is fetched is never shown pressed over that report', async () => {
        // Found capturing the README's GIF: the page could say 30 days, pressed,
        // over the 7 days' figures fetched just before the click, until the
        // next post came.
        const { service, fake } = fakeService();
        const requestsIn: Record<RangeKey, number> = { today: 1, '7d': 7, '30d': 30, coverage: 99 };
        let release!: () => void;
        const held = new Promise<void>(resolve => (release = resolve));
        let calls = 0;
        fake.reportFor = async range => {
            if (calls++ === 0) {
                await held;
            }
            const totals = emptyTotals();
            totals.input = totals.processed = requestsIn[range] * 1_000;
            totals.coverage = { start: Date.UTC(2026, 9, 10, 9), newest: Date.UTC(2026, 9, 10, 10), requests: requestsIn[range], incompleteRequests: 0 };
            return quietReport({ range, totals });
        };
        UsagePanel.show(context, service, log);
        page.send({ type: 'ready', zone: 'UTC' });
        await settle();
        // The first update waits for its report, 7 days', when 30 days is chosen.
        page.send({ type: 'setRange', range: '30d' });
        await settle();
        release();
        await until(() => page.posted.some(p => p.controls.includes('data-range="30d" aria-pressed="true"')));
        await settle();
        for (const post of page.posted) {
            const pressed = (/data-range="([^"]+)" aria-pressed="true"/.exec(post.controls)?.[1] ?? '') as RangeKey;
            assert.ok(post.body.includes(`${requestsIn[pressed]} requests`), `${pressed} shown pressed over another range's report`);
        }
    });

    test('Turn On, on the off page, turns the feature on at the user level, and nothing else', async () => {
        // In a remote window VS Code writes a machine setting given for the
        // user to the host's own settings, where it applies.
        const { service, fake } = fakeService();
        fake.status = 'off';
        const updates: unknown[][] = [];
        const errors: unknown[][] = [];
        const workspace = vscode.workspace as unknown as Record<string, unknown>;
        const window = vscode.window as unknown as Record<string, unknown>;
        const originals = { getConfiguration: workspace.getConfiguration, showErrorMessage: window.showErrorMessage };
        workspace.getConfiguration = (section: string) => ({
            update: (key: string, value: unknown, target: unknown) => (updates.push([section, key, value, target]), Promise.resolve()),
        });
        window.showErrorMessage = (...args: unknown[]) => (errors.push(args), Promise.resolve(undefined));
        try {
            UsagePanel.show(context, service, log);
            page.send({ type: 'turnOn' });
            await until(() => updates.length > 0);
            await settle();
            assert.deepStrictEqual(updates, [['llm-tokenizer', 'enableClaudeCodeUsage', true, vscode.ConfigurationTarget.Global]]);
            // Turned on, it says nothing: the page that follows shows it.
            assert.deepStrictEqual(errors, []);
        } finally {
            Object.assign(workspace, { getConfiguration: originals.getConfiguration });
            Object.assign(window, { showErrorMessage: originals.showErrorMessage });
        }
    });

    test('a Turn On the settings refuse says so, and offers the Settings editor, which says why', async () => {
        const { service, fake } = fakeService();
        fake.status = 'off';
        const errors: unknown[][] = [];
        const ran: unknown[][] = [];
        const workspace = vscode.workspace as unknown as Record<string, unknown>;
        const window = vscode.window as unknown as Record<string, unknown>;
        const commands = vscode.commands as unknown as Record<string, unknown>;
        const originals = { getConfiguration: workspace.getConfiguration, showErrorMessage: window.showErrorMessage, executeCommand: commands.executeCommand };
        workspace.getConfiguration = () => ({ update: () => Promise.reject(new Error('Unable to write into user settings.')) });
        window.showErrorMessage = (...args: unknown[]) => (errors.push(args), Promise.resolve('Open Settings'));
        commands.executeCommand = (...args: unknown[]) => (ran.push(args), Promise.resolve(undefined));
        try {
            UsagePanel.show(context, service, log);
            page.send({ type: 'turnOn' });
            await until(() => ran.length > 0);
            assert.deepStrictEqual(errors, [['LLM Tokenizer: Claude Code usage could not be turned on here.', 'Open Settings']]);
            assert.deepStrictEqual(ran, [['workbench.action.openSettings', { query: 'llm-tokenizer.enableClaudeCodeUsage' }]]);
        } finally {
            Object.assign(workspace, { getConfiguration: originals.getConfiguration });
            Object.assign(window, { showErrorMessage: originals.showErrorMessage });
            Object.assign(commands, { executeCommand: originals.executeCommand });
        }
    });

    test('what is being read reaches the page, and a Refresh clicked meanwhile waits for it rather than queue another', async () => {
        const { service, counts, fake } = fakeService();
        fake.reading = { by: 'this window', files: 10, of: 100 };
        UsagePanel.show(context, service, log);
        await until(() => page.posted.length > 0);
        assert.ok(page.posted.at(-1)?.body.includes('Still reading Claude Code&#39;s records: 10 of 100 files.'), page.posted.at(-1)?.body.slice(0, 300));
        await settle();
        page.send({ type: 'refresh' });
        await settle();
        assert.strictEqual(counts.refreshes, 1, 'a Refresh ran during the pass: only the panel opening should have');
        fake.reading = undefined;
        page.send({ type: 'refresh' });
        await until(() => counts.refreshes === 2);
    });

    test('a panel that cannot be built leaves no empty tab, and no hold, and the next one opens', async () => {
        // T-5: the editor title showed the raw TypeError, an empty tab stayed
        // open, and the next panel waited on "Reading…" for good.
        const { service, fake, counts } = fakeService();
        const shown: string[] = [];
        const window = vscode.window as unknown as Record<string, unknown>;
        const originalError = window.showErrorMessage;
        window.showErrorMessage = (message: string) => (shown.push(message), Promise.resolve(undefined));
        try {
            fake.holdThrows = true;
            assert.doesNotThrow(() => UsagePanel.show(context, service, log));
            assert.ok(page.disposed(), 'the empty tab was left open');
            assert.deepStrictEqual(warnings, ['Claude Code usage panel: could not be opened (TypeError)']);
            assert.deepStrictEqual(shown, ['LLM Tokenizer: the Claude Code Usage panel could not be opened; see the log.']);
            fake.holdThrows = false;
            page = fakePanel();
            UsagePanel.show(context, service, log);
            await until(() => page.posted.length > 0);
            assert.deepStrictEqual([counts.holds, page.disposed()], [1, false]);
        } finally {
            window.showErrorMessage = originalError;
        }
    });

    test('in a remote window, Open Settings opens the remote settings, the only ones that apply there', async () => {
        const ran: unknown[][] = [];
        const original = vscode.commands.executeCommand;
        (vscode.commands as unknown as Record<string, unknown>).executeCommand = (...args: unknown[]) => (ran.push(args), Promise.resolve(undefined));
        try {
            await openUsageSettings('ssh-remote');
            await openUsageSettings(undefined);
        } finally {
            (vscode.commands as unknown as Record<string, unknown>).executeCommand = original;
        }
        const query = { query: 'llm-tokenizer.enableClaudeCodeUsage' };
        assert.deepStrictEqual(ran, [
            ['workbench.action.openRemoteSettings', query],
            ['workbench.action.openSettings', query],
        ]);
    });

    test("Choose Folder sets the data folder for the user, and a projects folder picked means its parent", async () => {
        const { service } = fakeService();
        const config = () => vscode.workspace.getConfiguration('llm-tokenizer');
        const before = config().inspect('claudeCodeDataDirectory')?.globalValue;
        const picked = path.join(os.tmpdir(), 'claude-elsewhere', 'projects');
        const originalDialog = vscode.window.showOpenDialog;
        (vscode.window as unknown as Record<string, unknown>).showOpenDialog = () => Promise.resolve([vscode.Uri.file(picked)]);
        try {
            UsagePanel.show(context, service, log);
            page.send({ type: 'chooseFolder' });
            // As the editor gives it back: on Windows, with a lower-case drive letter.
            const expected = vscode.Uri.file(path.dirname(picked)).fsPath;
            await until(() => config().inspect('claudeCodeDataDirectory')?.globalValue === expected, 5_000);
            assert.strictEqual(config().inspect('claudeCodeDataDirectory')?.workspaceValue, undefined);
        } finally {
            (vscode.window as unknown as Record<string, unknown>).showOpenDialog = originalDialog;
            await config().update('claudeCodeDataDirectory', before, vscode.ConfigurationTarget.Global);
        }
    });
});
