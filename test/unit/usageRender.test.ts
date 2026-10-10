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
                compactions: [{ uuid: 'c', sessionId: HOSTILE, kind: 'main', timestamp: 0, trigger: HOSTILE, preTokens: 160_000, postTokens: 12_000 }],
            },
        ],
        dayModels: [{ date: '2026-10-09', model: '=cmd|"/c calc"!A1', variant: null, totals: t }],
        limitWindows: [{ limitType: HOSTILE, resetsAt: 1791561600, hits: 2, firstTs: Date.UTC(2026, 9, 9, 10, 6), date: '2026-10-09' }],
        omitted: { sessions: 0, projects: 0, models: 0, efforts: 0, dayModels: 0, limitWindows: 0 },
        coverage: { start: Date.UTC(2026, 9, 1), newest: Date.UTC(2026, 9, 9, 11), requests: 3, ahead: 0, files: 4, oversizeLines: 0, malformedLines: 0 },
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
        recoveredFrom: undefined,
        extensionVersion: '2.2.0',
        refreshedAt: Date.UTC(2026, 9, 9, 12),
        formatTime: ms => new Date(ms).toISOString().slice(0, 16).replace('T', ' '),
        formatDate: ms => new Date(ms).toISOString().slice(0, 10),
        ...overrides,
    };
}

const text = (f: PanelFragments) => f.controls + f.body + f.diagnostics;

/** A sortable table as the page's script sees it: rows carry their sort keys, headers their buttons. */
function fakeTable(id: string, initial: string, keys: string[], rows: Record<string, string>[]) {
    const tbody = {
        rows: rows.map(values => ({ values, getAttribute: (name: string) => values[name.replace(/^data-k-/, '')] ?? null })),
        appendChild(row: unknown) {
            this.rows.splice(this.rows.indexOf(row as (typeof this.rows)[number]), 1);
            this.rows.push(row as (typeof this.rows)[number]);
        },
    };
    const headers = keys.map(key => {
        const attributes: Record<string, string> = {};
        return { key, attributes, querySelector: () => ({ dataset: { sortKey: key } }), setAttribute: (name: string, value: string) => (attributes[name] = value) };
    });
    const table = {
        id,
        dataset: { sort: initial },
        tBodies: [tbody],
        querySelectorAll: () => headers,
        /** Row labels, in the order shown. */
        order: () => tbody.rows.map(r => r.values.label),
        sortOf: (key: string) => headers.find(h => h.key === key)?.attributes['aria-sort'],
        /** A click on a header's sort button. */
        button: (key: string) => ({ dataset: { sortKey: key }, closest: () => table }),
    };
    return table;
}

/** The page's script over a DOM that holds `tables`, swapped for new ones by each update. */
function livePage(fragments: PanelFragments, firstTables: ReturnType<typeof fakeTable>[]) {
    const html = renderUsagePage('n0nce', "default-src 'none'", fragments);
    const script = /<script nonce="n0nce">([\s\S]*)<\/script>/.exec(html)?.[1];
    assert.ok(script);
    const posted: { type: string; text?: string }[] = [];
    const listeners: Record<string, (e: unknown) => void> = {};
    let tables = firstTables;
    let nextTables = firstTables;
    const details = { current: { open: false } as { open: boolean } | null };
    const focused: string[] = [];
    const document = {
        activeElement: null as unknown,
        getElementById: (id: string) =>
            id === 'diagnostics'
                ? details.current
                : {
                      set innerHTML(_html: string) {
                          // The update writes the slots; what it wrote is the new DOM.
                          if (id === 'diagnostics-slot') {
                              details.current = { open: false };
                          }
                          tables = nextTables;
                      },
                  },
        querySelectorAll: (selector: string) => (selector === 'table[data-sort]' ? tables : []),
        querySelector: (selector: string) => ({ focus: () => focused.push(selector) }),
        addEventListener: (name: string, fn: (e: unknown) => void) => (listeners[name] = fn),
    };
    vm.runInNewContext(script, {
        acquireVsCodeApi: () => ({ postMessage: (m: { type: string }) => posted.push(m) }),
        document,
        window: { origin: ORIGIN, addEventListener: (name: string, fn: (e: unknown) => void) => (listeners[`window:${name}`] = fn) },
        Intl,
    });
    return {
        posted,
        focused,
        details,
        document,
        click: (target: unknown) => listeners.click({ target: { closest: () => target } }),
        update: (next: PanelFragments, newTables: ReturnType<typeof fakeTable>[]) => {
            nextTables = newTables;
            listeners['window:message']({ origin: ORIGIN, data: { type: 'data', fragments: next } });
        },
    };
}

/** The page's script, run as the webview would, with only what it uses. */
/** The page's origin, as the editor's webview gives it. */
const ORIGIN = 'vscode-webview://0123abcd';

function runPage(fragments: PanelFragments): {
    posted: { type: string; text?: string }[];
    click(action: string): string;
    message(origin: string, fragments: PanelFragments): void;
} {
    const html = renderUsagePage('n0nce', "default-src 'none'", fragments);
    const script = /<script nonce="n0nce">([\s\S]*)<\/script>/.exec(html)?.[1];
    assert.ok(script);
    const posted: { type: string; text?: string }[] = [];
    const listeners: Record<string, (e: unknown) => void> = {};
    const element = () => ({ innerHTML: '', open: false });
    vm.runInNewContext(script, {
        acquireVsCodeApi: () => ({ postMessage: (m: { type: string }) => posted.push(m) }),
        document: {
            getElementById: element,
            querySelectorAll: () => [],
            addEventListener: (name: string, fn: (e: unknown) => void) => (listeners[name] = fn),
            activeElement: null,
        },
        window: { origin: ORIGIN, addEventListener: (name: string, fn: (e: unknown) => void) => (listeners[`window:${name}`] = fn) },
        Intl,
    });
    return {
        posted,
        message: (origin: string, fragments: PanelFragments) => listeners['window:message']({ origin, data: { type: 'data', fragments } }),
        click: action => {
            listeners.click({ target: { closest: () => ({ dataset: { action } }) } });
            return posted.at(-1)?.text ?? '';
        },
    };
}

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
        const capped = renderFragments(view({ report: report({ omitted: { sessions: 7, projects: 2, models: 0, efforts: 0, dayModels: 0, limitWindows: 0 } }) }));
        assert.ok(capped.body.includes('7 smaller sessions') && capped.body.includes('2 smaller projects'));
        assert.ok(capped.copy.notes.some(n => n.includes('7 smaller sessions')));
    });

    test('every capped list says how many rows it left out', () => {
        const capped = renderFragments(
            view({ report: report({ omitted: { sessions: 0, projects: 0, models: 3, efforts: 2, dayModels: 5, limitWindows: 4 } }) }),
        );
        assert.ok(capped.body.includes('…and 3 smaller models, counted in the totals'));
        assert.ok(capped.body.includes('…and 2 smaller effort levels, counted in the totals'));
        assert.ok(capped.body.includes('…and 4 earlier ones, not listed.'));
        assert.ok(capped.csv.notes.includes('5 older day-and-model rows are counted in the totals but not listed'));
        const whole = renderFragments(view());
        assert.ok(!whole.body.includes('…and') && !whole.csv.notes.some(n => n.includes('not listed')));
    });

    test('past 400 days, the newest are drawn, and the note says the rest are in the totals', () => {
        const t = totals(5);
        const long = report({
            range: 'coverage',
            from: '2025-01-01',
            to: '2026-10-09',
            days: [{ date: '2025-01-01', totals: t }, { date: '2025-09-04', totals: t }, { date: '2026-10-09', totals: t }],
        });
        const body = renderFragments(view({ report: long })).body;
        assert.strictEqual((body.match(/class="column"/g) ?? []).length, 400);
        // 400 days back from the 9th of October, inclusive.
        assert.ok(body.includes('<span>2025-09-05</span><span>2026-10-09</span>'), 'not the newest 400 days');
        assert.ok(body.includes('The newest 400 are drawn; 2 earlier days with requests are in the totals.'));
        assert.ok(!renderFragments(view()).body.includes('The newest'));
    });

    test('a day later than today, from a clock ahead, is no column: the note counts it', () => {
        const t = totals(5);
        const ahead = report({ days: [{ date: '2026-10-09', totals: t }, { date: '2026-10-10', totals: t }] });
        const body = renderFragments(view({ report: ahead })).body;
        assert.ok(body.includes('<span>2026-10-07</span><span>2026-10-09</span>'), 'the columns went past the range');
        assert.ok(body.includes('A later day, from a clock ahead of this one, is in the totals.'));
    });

    test('requests dated more than a day ahead are said to be kept, and counted once this clock reaches them', () => {
        assert.ok(!renderFragments(view()).diagnostics.includes('Dated ahead'));
        const one = renderFragments(view({ report: report({ coverage: { ...report().coverage, ahead: 1 } }) })).diagnostics;
        assert.ok(one.includes("1 request dated more than a day after this machine's clock, kept and counted once it reaches it"), one);
        const two = renderFragments(view({ report: report({ coverage: { ...report().coverage, ahead: 2 } }) })).diagnostics;
        assert.ok(two.includes('2 requests dated more than a day after'), two);
    });

    test('lines too long to read are called that, whatever made them so', () => {
        const long = report({ coverage: { ...report().coverage, oversizeLines: 2 } });
        assert.ok(renderFragments(view({ report: long })).diagnostics.includes('0 malformed, 2 too long to read'));
    });

    test('with its data folder gone, a kept history is still shown, under a banner that says so', () => {
        const gone = { roots: [{ path: '~/.claude', source: 'the default', exists: false }] };
        const kept = text(renderFragments(view({ status: 'no-roots', ...gone })));
        assert.ok(kept.includes('No Claude Code data folder is found now, so this is the history kept so far.'));
        assert.ok(kept.includes('data-action="chooseFolder"') && kept.includes('By model'), 'the history was not shown');
        const none = text(renderFragments(view({ status: 'no-roots', ...gone, report: report({ coverage: { ...report().coverage, requests: 0 } }) })));
        assert.ok(none.includes('No Claude Code data folder found') && !none.includes('By model'));
    });

    test('a history set aside is named, on the page and in the diagnostics', () => {
        const moved = renderFragments(view({ recoveredFrom: `usage.sqlite.corrupt-${HOSTILE}` }));
        assert.ok(moved.body.includes('The history could not be read, so it was set aside as usage.sqlite.corrupt-&lt;img'));
        assert.ok(/<dt>Set aside<\/dt><dd>usage\.sqlite\.corrupt-&lt;img/.test(moved.diagnostics), moved.diagnostics.slice(0, 400));
        assert.ok(!text(moved).includes(`corrupt-${HOSTILE}`));
        assert.ok(!text(renderFragments(view())).includes('set aside'));
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
        const page = runPage(renderFragments(view()));
        assert.deepStrictEqual(page.posted[0]?.type, 'ready');

        const csv = page.click('export');
        const lines = csv.split('\n');
        assert.ok(lines[0].startsWith('# extension: LLM Tokenizer 2.2.0'));
        assert.ok(lines.includes('"date","model","variant","requests","input_tokens","cache_creation_input_tokens","cache_creation_5m","cache_creation_1h","cache_read_input_tokens","output_tokens","thinking_tokens","web_search_requests","web_fetch_requests","complete"'));
        assert.ok(csv.includes(`"'=cmd|""/c calc""!A1"`), 'a model id was left able to run as a formula');

        const copied = page.click('copy');
        assert.ok(copied.split('\n').some(l => l.split('\t').length === 5 && l.includes(HOSTILE)), 'a session row lost its columns');
    });

    test('Copy guards formulas as the CSV does: pasted, a cell is read the same way', () => {
        const formula = '=HYPERLINK("https://example.com/?"&A1)';
        const session = { ...report().sessions[0], label: formula, sessionId: '+1' };
        const copied = runPage(renderFragments(view({ report: report({ sessions: [session] }) }))).click('copy');
        const row = copied.split('\n').find(l => l.includes('HYPERLINK'))?.split('\t');
        assert.deepStrictEqual(row?.slice(1, 3), [`'${formula}`, "'+1"]);
    });

    test("the page takes data only from the editor, whose messages come from the page's own origin", () => {
        const page = runPage(renderFragments(view()));
        const forged = renderFragments(view({ report: report({ sessions: [{ ...report().sessions[0], label: 'forged', sessionId: 'forged' }] }) }));
        // Another frame in the window, a site in Simple Browser say.
        page.message('https://evil.example', forged);
        assert.ok(!page.click('copy').includes('forged'), 'a message from another frame was shown');
        page.message(ORIGIN, forged);
        assert.ok(page.click('copy').includes('forged'));
    });

    test("an export's notes cannot split into columns: tabs are spaces there too", () => {
        const fragments = renderFragments(view());
        fragments.copy.notes.push('a\tnote');
        assert.ok(runPage(fragments).click('copy').split('\n').includes('# a note'));
    });

    test('an export is stamped when it is made, not when the page last had data', async () => {
        const fragments = renderFragments(view());
        await new Promise(resolve => setTimeout(resolve, 5));
        // Nothing in the data moves with the clock, so data unchanged is not posted again.
        assert.deepStrictEqual(renderFragments(view()), fragments);
        const page = runPage(fragments);
        const stamp = (text: string) => /^# exported: (.+)$/m.exec(text)?.[1];
        const clicked = Date.now();
        const csv = stamp(page.click('export'));
        assert.ok(csv && Date.parse(csv) >= clicked, `stamped ${csv}, clicked ${new Date(clicked).toISOString()}`);
        assert.ok(stamp(page.click('copy')));
    });

    test('the page carries the nonce and a strict policy, and its data cannot close the script', () => {
        const html = renderUsagePage('abc', "default-src 'none'; script-src 'nonce-abc'", renderFragments(view({ report: report({ dayModels: [{ date: '2026-10-09', model: '</script><script>alert(1)</script>', variant: null, totals: totals(1) }] }) })));
        assert.ok(html.includes(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-abc'">`));
        assert.strictEqual((html.match(/<\/script>/g) ?? []).length, 1);
    });

    test("a header's button sorts its table, numbers as numbers, and says which way", () => {
        const sessions = fakeTable('sessions', 'processed', ['label', 'processed'], [
            { label: 'b', processed: '9' },
            { label: 'a', processed: '100' },
            { label: 'c', processed: '20' },
        ]);
        const page = livePage(renderFragments(view()), [sessions]);
        // Largest first on load: 100 above 20 above 9, never "9" above "20".
        assert.deepStrictEqual(sessions.order(), ['a', 'c', 'b']);
        assert.deepStrictEqual([sessions.sortOf('processed'), sessions.sortOf('label')], ['descending', 'none']);
        // Names start A to Z; a second click turns it round.
        page.click(sessions.button('label'));
        assert.deepStrictEqual([sessions.order(), sessions.sortOf('label'), sessions.sortOf('processed')], [['a', 'b', 'c'], 'ascending', 'none']);
        page.click(sessions.button('label'));
        assert.deepStrictEqual([sessions.order(), sessions.sortOf('label')], [['c', 'b', 'a'], 'descending']);
    });

    test('an update keeps each table\'s sort, the diagnostics as they were, and the focus where it was', () => {
        const rows = [
            { label: 'b', processed: '9' },
            { label: 'a', processed: '100' },
        ];
        const before = fakeTable('sessions', 'processed', ['label', 'processed'], rows);
        const page = livePage(renderFragments(view()), [before]);
        page.click(before.button('label'));
        page.details.current = { open: true };
        page.document.activeElement = { matches: () => true, getAttribute: (name: string) => (name === 'data-range' ? '30d' : null) };

        const after = fakeTable('sessions', 'processed', ['label', 'processed'], [...rows, { label: 'c', processed: '50' }]);
        const next = renderFragments(view({ report: report({ sessions: [{ ...report().sessions[0], label: 'moved', sessionId: 'next' }] }) }));
        page.update(next, [after]);
        assert.deepStrictEqual([after.order(), after.sortOf('label')], [['a', 'b', 'c'], 'ascending']);
        assert.strictEqual(page.details.current?.open, true, 'the diagnostics closed on an update');
        assert.deepStrictEqual(page.focused, ['button[data-range="30d"]']);
        // And the exports are the update's.
        page.click({ dataset: { action: 'copy' } });
        assert.ok(page.posted.at(-1)?.text?.includes('next'));
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
