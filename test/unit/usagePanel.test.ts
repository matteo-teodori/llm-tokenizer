import * as assert from 'assert';
import * as vscode from 'vscode';

import { emptyTotals } from '../../src/usage/aggregate';
import type { ImportSummary } from '../../src/usage/importer';
import { UsagePanel } from '../../src/usage/panel';
import type { PanelFragments } from '../../src/usage/render';
import { buildReport, type UsageReport } from '../../src/usage/report';
import type { UsageService } from '../../src/usage/usageService';

/** A history of three requests, none of them in the range shown. */
function quietReport(overrides: Partial<UsageReport> = {}): UsageReport {
    return {
        ...buildReport(
            { sums: [], sessions: [], compactions: [], limitHits: [], coverage: { start: null, newest: null, requests: 3, files: 1, oversizeLines: 0, malformedLines: 0 } },
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
    return { panel, pages, posted, setVisible, send: (message: unknown) => messages.fire(message) };
}

/** The service as the panel uses it; `counts` records each use. */
function fakeService() {
    const counts = { holds: 0, releases: 0, refreshes: 0 };
    const fake = {
        status: 'ready',
        roots: undefined,
        lastImport: undefined,
        missingSqlite: undefined,
        recoveredFrom: undefined,
        onDidChange: new vscode.EventEmitter<void>().event,
        /** What the next refresh returns: a summary when a pass ran. */
        passes: undefined as ImportSummary | undefined,
        report: quietReport(),
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
        onDidChange: fake.onDidChange,
        hold: () => {
            counts.holds++;
            return new vscode.Disposable(() => counts.releases++);
        },
        refresh: () => {
            counts.refreshes++;
            return Promise.resolve(fake.passes);
        },
        report: () => Promise.resolve(fake.report),
    };
    return { service: service as unknown as UsageService, counts, fake };
}

const context = {
    globalState: { get: () => undefined, update: () => Promise.resolve() },
    extension: { packageJSON: { version: '2.2.0' } },
} as unknown as vscode.ExtensionContext;

const warnings: string[] = [];
const log = { warn: (m: string) => warnings.push(m), show: () => undefined } as unknown as vscode.LogOutputChannel;

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
        warnings.length = 0;
        create = vscode.window.createWebviewPanel.bind(vscode.window);
        (vscode.window as unknown as { createWebviewPanel: unknown }).createWebviewPanel = () => page.panel;
    });

    teardown(() => {
        (vscode.window as unknown as { createWebviewPanel: unknown }).createWebviewPanel = create;
        page.panel.dispose();
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
});
