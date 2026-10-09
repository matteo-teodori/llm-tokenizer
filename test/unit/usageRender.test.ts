import * as assert from 'assert';
import * as vm from 'vm';

import { emptyTotals, type UsageTotals } from '../../src/usage/aggregate';
import { parsePanelMessage } from '../../src/usage/panel';
import { renderFragments, renderUsagePage, type PanelFragments, type PanelView } from '../../src/usage/render';
import type { UsageReport } from '../../src/usage/report';

/** Every way a transcript string could carry markup, in one. */
const HOSTILE = '<img src=x onerror=alert(1)>"\'&';

function totals(processed: number, partial = false): UsageTotals {
    const t = emptyTotals();
    t.input = processed;
    t.processed = processed;
    t.provenance = partial ? 'partial' : 'reported';
    t.coverage = { start: Date.UTC(2026, 9, 9, 10), newest: Date.UTC(2026, 9, 9, 11), requests: 3, incompleteRequests: partial ? 1 : 0 };
    return t;
}

function report(overrides: Partial<UsageReport> = {}): UsageReport {
    const t = totals(1_278);
    return {
        range: '7d',
        from: '2026-10-07',
        to: '2026-10-09',
        zone: 'Europe/Rome',
        scope: 'all',
        totals: t,
        days: [{ date: '2026-10-09', totals: t }],
        models: [{ model: HOSTILE, variant: '1m', totals: t }],
        kinds: [{ kind: 'main', totals: t }],
        efforts: [{ effort: HOSTILE, totals: t }],
        projects: [{ project: { kind: 'root', path: `/repo/${HOSTILE}` }, label: HOSTILE, sessions: 1, totals: t, models: [] }],
        sessions: [
            {
                sessionId: HOSTILE,
                project: { kind: 'root', path: `/repo/${HOSTILE}` },
                label: HOSTILE,
                firstTs: Date.UTC(2026, 9, 9, 10),
                lastTs: Date.UTC(2026, 9, 9, 11, 30),
                totals: t,
                models: [],
                compactions: [{ uuid: 'c', sessionId: HOSTILE, timestamp: 0, trigger: HOSTILE, preTokens: 160_000, postTokens: 12_000 }],
            },
        ],
        dayModels: [{ date: '2026-10-09', model: '=cmd|"/c calc"!A1', variant: null, totals: t }],
        limitWindows: [{ limitType: HOSTILE, resetsAt: 1791561600, hits: 2, firstTs: Date.UTC(2026, 9, 9, 10, 6), date: '2026-10-09' }],
        omitted: { sessions: 0, projects: 0 },
        coverage: { start: Date.UTC(2026, 9, 1), newest: Date.UTC(2026, 9, 9, 11), requests: 3, files: 4, oversizeLines: 0, malformedLines: 0 },
        ...overrides,
    };
}

function view(overrides: Partial<PanelView> = {}): PanelView {
    return {
        status: 'ready',
        range: '7d',
        scope: 'all',
        zone: 'Europe/Rome',
        where: '',
        remote: false,
        report: report(),
        modelLabel: id => id,
        roots: [{ path: `~/${HOSTILE}`, source: 'default', exists: true }],
        historyDisabled: false,
        lastImport: undefined,
        sqliteRuntime: undefined,
        extensionVersion: '2.2.0',
        refreshedAt: Date.UTC(2026, 9, 9, 12),
        formatTime: ms => new Date(ms).toISOString().slice(0, 16).replace('T', ' '),
        formatDate: ms => new Date(ms).toISOString().slice(0, 10),
        ...overrides,
    };
}

const text = (f: PanelFragments) => f.controls + f.body + f.diagnostics;

suite('usage page', () => {
    test('every empty state says why, and what would change it', () => {
        const off = text(renderFragments(view({ status: 'off', report: undefined })));
        assert.ok(off.includes('Claude Code usage is off'));
        assert.ok(off.includes('Nothing is sent anywhere'));
        assert.ok(off.includes('Never kept: prompts, responses, thinking, tool inputs or results'));
        assert.ok(off.includes('data-action="openSettings"'));
        assert.ok(!off.includes('Remote settings'));
        assert.ok(text(renderFragments(view({ status: 'off', report: undefined, remote: true, where: 'on box (ssh-remote)' }))).includes('Remote settings'));

        const noRoots = text(
            renderFragments(view({ status: 'no-roots', report: undefined, roots: [{ path: '~/.claude', source: 'the default', exists: false }] })),
        );
        assert.ok(noRoots.includes('~/.claude') && noRoots.includes('not found') && noRoots.includes('data-action="chooseFolder"'));

        const noSqlite = text(renderFragments(view({ status: 'no-sqlite', report: undefined, sqliteRuntime: { node: '20.18.0', electron: '34.5.0' } })));
        assert.ok(noSqlite.includes('node:sqlite') && noSqlite.includes('Node 20.18.0') && noSqlite.includes('Electron 34.5.0'));

        const failing = text(renderFragments(view({ status: 'failing' })));
        assert.ok(failing.includes('The last import failed') && failing.includes('data-action="showLog"'));
        assert.ok(text(renderFragments(view({ status: 'read-only' }))).includes('written by a newer LLM Tokenizer'));
        assert.ok(text(renderFragments(view({ historyDisabled: true }))).includes('CLAUDE_CODE_SKIP_PROMPT_HISTORY'));

        const nothing = report({ totals: emptyTotals(), days: [], models: [], kinds: [], efforts: [], projects: [], sessions: [] });
        assert.ok(text(renderFragments(view({ report: { ...nothing, coverage: { ...nothing.coverage, requests: 0 } } }))).includes('No Claude Code requests have been read yet'));
        assert.ok(text(renderFragments(view({ scope: 'workspace', report: nothing }))).includes('started in a folder of this workspace'));
    });

    test('transcript text is escaped everywhere it appears', () => {
        const all = text(renderFragments(view()));
        assert.ok(!all.includes('<img'), 'markup from a record reached the page');
        assert.ok(!/onerror=alert\(1\)>"/.test(all));
        assert.ok(all.includes('&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;'));
        // In the sort keys too: an attribute value cannot be closed early.
        assert.ok(!all.includes(`data-k-label="${HOSTILE}`));
    });

    test('a lower bound is marked ≥, and nothing is marked ≈', () => {
        const partial = totals(1_278, true);
        const all = text(renderFragments(view({ report: report({ totals: partial, projects: [], sessions: [] }) })));
        assert.ok(all.includes('≥1.3K'), 'the hero total is not marked a lower bound');
        assert.ok(all.includes('did not report every counter'));
        assert.ok(!text(renderFragments(view())).includes('≥'));
        assert.ok(!all.includes('≈'), '≈ is for estimates, and nothing here is one');
    });

    test('processed, never used, and cache reads explained', () => {
        const all = text(renderFragments(view())).toLowerCase();
        assert.ok(all.includes('tokens processed'));
        assert.ok(!/tokens used|used tokens/.test(all));
        assert.ok(all.includes('read from the cache'));
    });

    test('the cap is disclosed on the page and in the export', () => {
        const capped = renderFragments(view({ report: report({ omitted: { sessions: 7, projects: 2 } }) }));
        assert.ok(capped.body.includes('7 smaller sessions') && capped.body.includes('2 smaller projects'));
        assert.ok(capped.copy.notes.some(n => n.includes('7 smaller sessions')));
    });

    test('a day with nothing still gets a column, so a gap reads as a gap', () => {
        const all = renderFragments(view()).body;
        assert.strictEqual((all.match(/class="column"/g) ?? []).length, 3, 'three days from the 7th to the 9th');
    });

    test('the CSV holds every input of a hand-made cost calculation, and no price', () => {
        const { csv } = renderFragments(view());
        for (const column of ['input_tokens', 'cache_creation_5m', 'cache_creation_1h', 'cache_read_input_tokens', 'output_tokens', 'web_search_requests', 'web_fetch_requests', 'model', 'variant']) {
            assert.ok(csv.header.includes(column), column);
        }
        assert.ok(!csv.header.some(h => /cost|price|usd|\$/i.test(h)));
        assert.ok(csv.notes.some(n => n.startsWith('time zone: Europe/Rome')));
        assert.ok(csv.notes.some(n => n.includes('largest output per message.id')));
    });

    test("the page's own exports quote, guard formulas, and open with their notes", () => {
        // The page's script, run as the webview would, with only what it uses.
        const fragments = renderFragments(view());
        const html = renderUsagePage('n0nce', "default-src 'none'", fragments);
        const script = /<script nonce="n0nce">([\s\S]*)<\/script>/.exec(html)?.[1];
        assert.ok(script);
        const posted: { type: string; text?: string }[] = [];
        const listeners: Record<string, (e: unknown) => void> = {};
        const element = () => ({ innerHTML: '', open: false });
        const context = {
            acquireVsCodeApi: () => ({ postMessage: (m: { type: string }) => posted.push(m) }),
            document: {
                getElementById: element,
                querySelectorAll: () => [],
                addEventListener: (name: string, fn: (e: unknown) => void) => (listeners[name] = fn),
                activeElement: null,
            },
            window: { addEventListener: (name: string, fn: (e: unknown) => void) => (listeners[`window:${name}`] = fn) },
            Intl,
        };
        vm.runInNewContext(script, context);
        assert.deepStrictEqual(posted[0]?.type, 'ready');

        const click = (action: string) => listeners.click({ target: { closest: () => ({ dataset: { action } }) } });
        click('export');
        const csv = posted.at(-1)?.text ?? '';
        const lines = csv.split('\n');
        assert.ok(lines[0].startsWith('# extension: LLM Tokenizer 2.2.0'));
        assert.ok(lines.includes('"date","model","variant","requests","input_tokens","cache_creation_input_tokens","cache_creation_5m","cache_creation_1h","cache_read_input_tokens","output_tokens","thinking_tokens","web_search_requests","web_fetch_requests","complete"'));
        assert.ok(csv.includes(`"'=cmd|""/c calc""!A1"`), 'a model id was left able to run as a formula');

        click('copy');
        const copied = posted.at(-1)?.text ?? '';
        assert.ok(copied.split('\n').some(l => l.split('\t').length === 5 && l.includes(HOSTILE)), 'a session row lost its columns');
    });

    test('the page carries the nonce and a strict policy, and its data cannot close the script', () => {
        const html = renderUsagePage('abc', "default-src 'none'; script-src 'nonce-abc'", renderFragments(view({ report: report({ dayModels: [{ date: '2026-10-09', model: '</script><script>alert(1)</script>', variant: null, totals: totals(1) }] }) })));
        assert.ok(html.includes(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-abc'">`));
        assert.strictEqual((html.match(/<\/script>/g) ?? []).length, 1);
    });

    test('sorting and every action work from the keyboard, as buttons', () => {
        const all = text(renderFragments(view()));
        assert.ok(/<th[^>]*aria-sort="descending"><button type="button" data-sort-key="processed">/.test(all));
        for (const action of ['refresh', 'copy', 'export', 'clear', 'showLog']) {
            assert.ok(all.includes(`<button type="button" data-action="${action}"`), action);
        }
        assert.ok(all.includes('aria-pressed="true">7 days'));
    });
});

suite('usage panel messages', () => {
    test('only the expected messages, with checked fields, are taken', () => {
        assert.deepStrictEqual(parsePanelMessage({ type: 'ready', zone: 'Europe/Rome' }), { type: 'ready', zone: 'Europe/Rome' });
        assert.deepStrictEqual(parsePanelMessage({ type: 'setRange', range: '30d' }), { type: 'setRange', range: '30d' });
        assert.deepStrictEqual(parsePanelMessage({ type: 'setScope', scope: 'workspace' }), { type: 'setScope', scope: 'workspace' });
        assert.deepStrictEqual(parsePanelMessage({ type: 'clear', extra: 1 }), { type: 'clear' });
        for (const bad of [
            null,
            'clear',
            { type: 'ready', zone: 'Mars/Olympus' },
            { type: 'ready' },
            { type: 'setRange', range: 'forever' },
            { type: 'setScope', scope: 'everything' },
            { type: 'copy', text: 42 },
            { type: 'export', text: 'x'.repeat((16 << 20) + 1) },
            { type: 'openFile', path: '/etc/passwd' },
            { type: '__proto__' },
        ]) {
            assert.strictEqual(parsePanelMessage(bad), undefined, JSON.stringify(bad)?.slice(0, 80));
        }
    });
});
