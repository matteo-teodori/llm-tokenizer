import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

import { escapeHtml } from '../../src/html';
import { emptyTotals, type UsageTotals } from '../../src/usage/aggregate';
import { parsePanelMessage } from '../../src/usage/panel';
import { cutPercent, renderFragments, renderUsagePage, type PanelFragments, type PanelView } from '../../src/usage/render';
import type { UsageReport } from '../../src/usage/report';

/** Every way a transcript string could carry markup, in one. */
const HOSTILE = '<img src=x onerror=alert(1)>"\'&';
const HOSTILE_ESCAPED = escapeHtml(HOSTILE);

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
        account: 'all',
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
                account: 'none',
                firstTs: Date.UTC(2026, 9, 9, 10),
                lastTs: Date.UTC(2026, 9, 9, 11, 30),
                activeMs: 47 * 60_000,
                totals: t,
                models: [],
                compactions: [{ uuid: 'c', sessionId: HOSTILE, kind: 'main', timestamp: 0, trigger: HOSTILE, preTokens: 160_000, postTokens: 12_000 }],
            },
        ],
        dayModels: [{ date: '2026-10-09', model: '=cmd|"/c calc"!A1', variant: null, speed: null, inferenceGeo: null, promptSize: null, totals: t }],
        accounts: [{ key: 'none', owner: null, sessions: 1, totals: t, models: [], projects: [HOSTILE] }],
        accountsSeen: [{ key: 'none', owner: null, sessions: 1, firstTs: Date.UTC(2026, 9, 9, 10), lastTs: Date.UTC(2026, 9, 9, 11, 30) }],
        accountNames: [],
        currentAccounts: [],
        limitWindows: [{ account: 'none', limitType: HOSTILE, resetsAt: 1791561600, hits: 2, firstTs: Date.UTC(2026, 9, 9, 10, 6), date: '2026-10-09' }],
        omitted: { sessions: 0, projects: 0, models: 0, efforts: 0, dayModels: 0, limitWindows: 0 },
        coverage: { start: Date.UTC(2026, 9, 1), newest: Date.UTC(2026, 9, 9, 11), requests: 3, ahead: 0, files: 4, oversizeLines: 0, malformedLines: 0 },
        ...overrides,
    };
}

function view(overrides: Partial<PanelView> = {}): PanelView {
    return {
        status: 'ready',
        reading: undefined,
        range: '7d',
        scope: 'all',
        account: 'all',
        givenNames: {},
        zone: 'Europe/Rome',
        where: '',
        remote: false,
        report: report(),
        modelLabel: id => id,
        roots: [{ path: `~/${HOSTILE}`, source: 'default', exists: true }],
        accountFiles: [`~/.claude${HOSTILE}.json`],
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

interface FakeRow {
    values: Record<string, string>;
    getAttribute(name: string): string | null;
}

interface FakePage {
    classList: { contains(name: string): boolean };
    tBodies: { rows: FakeRow[]; appendChild(row: FakeRow): void }[];
    inert: boolean;
    parentElement: unknown;
    headers: { key: string; attributes: Record<string, string>; querySelector(): unknown; setAttribute(name: string, value: string): void }[];
    contains(element: unknown): boolean;
    querySelector(selector: string): unknown;
}

/**
 * A list's strip as the page's script sees it: pages side by side, a table
 * each, whose rows carry their sort keys and whose headers have the buttons;
 * a list without `initial` is not sortable, as Usage limits reached is not.
 * Each double answers only the selectors the script should ask, as the DOM
 * would, and focus does nothing on an inert page, as in the DOM.
 */
function fakeStrip(id: string, initial: string | undefined, keys: string[], rows: Record<string, string>[], perPage = 10) {
    const pages: FakePage[] = [];
    const count = Math.max(1, Math.ceil(rows.length / perPage));
    for (let p = 0; p < count; p++) {
        const headers = keys.map(key => {
            const attributes: Record<string, string> = {};
            return { key, attributes, querySelector: () => ({ dataset: { sortKey: key } }), setAttribute: (name: string, value: string) => (attributes[name] = value) };
        });
        pages.push({
            classList: { contains: name => name === 'page' },
            tBodies: [
                {
                    rows: [],
                    appendChild(row) {
                        // Moved, as the DOM moves a node: out of whichever page held it.
                        for (const page of pages) {
                            const at = page.tBodies[0].rows.indexOf(row);
                            if (at !== -1) {
                                page.tBodies[0].rows.splice(at, 1);
                            }
                        }
                        this.rows.push(row);
                    },
                },
            ],
            inert: p > 0,
            parentElement: null,
            headers,
            contains: element => (element as { page?: number } | null)?.page === p,
            querySelector: selector => ({
                page: p,
                selector,
                focus: () => (pages[p].inert ? undefined : strip.focusedOn.push(`page ${p} ${selector}`)),
            }),
        });
    }
    rows.forEach((values, i) =>
        pages[Math.floor(i / perPage)].tBodies[0].rows.push({ values, getAttribute: name => values[name.replace(/^data-k-/, '')] ?? null }),
    );
    const strip = {
        id,
        dataset: { sort: initial, pageRows: String(perPage), rows: String(rows.length) },
        classList: { contains: (name: string) => name === 'pages' },
        children: pages,
        clientWidth: 600,
        scrollLeft: 0,
        glides: [] as number[],
        focusedOn: [] as string[],
        scrollTo(options: { left: number; behavior?: string }) {
            if (options.behavior === 'smooth') {
                this.glides.push(options.left);
            }
            this.scrollLeft = options.left;
        },
        querySelectorAll: (selector: string) => (selector === 'th' ? pages.flatMap(page => page.headers) : []),
        /** Row labels, page by page, in the order shown. */
        pages: () => pages.map(page => page.tBodies[0].rows.map(r => r.values.label)),
        order: () => pages.flatMap(page => page.tBodies[0].rows.map(r => r.values.label)),
        /** The pages that can be reached. */
        reachable: () => pages.flatMap((page, i) => (page.inert ? [] : [i])),
        /** A column's aria-sort, as every page's header says it: two different ones joined with |. */
        sortOf: (key: string) => [...new Set(pages.map(page => page.headers.find(h => h.key === key)?.attributes['aria-sort']))].join(' | '),
        /** A click on a header's sort button, on page `page`. */
        button: (key: string, page = 0) => ({
            page,
            dataset: { sortKey: key },
            getAttribute: (name: string) => (name === 'data-sort-key' ? key : null),
            closest: (selector: string) => (selector === '.pages' ? strip : null),
        }),
        /** Something focusable on page `page`, as focus finds it. */
        on: (page: number) => ({ closest: (selector: string) => (selector === '.pages > .page' ? pages[page] : null) }),
    };
    for (const page of pages) {
        page.parentElement = strip;
    }
    return strip;
}

type FakeStrip = ReturnType<typeof fakeStrip>;

/** A list's pager as the page's script sees it; its line counts the times it is written. */
function fakePager(id: string) {
    const attributes: Record<string, Record<string, string>> = { previous: {}, next: {} };
    const output = {
        writes: 0,
        line: '',
        get textContent() {
            return this.line;
        },
        set textContent(value: string) {
            this.line = value;
            this.writes++;
        },
    };
    const pager = {
        dataset: { pages: id },
        output,
        querySelector: (selector: string) =>
            selector === 'output'
                ? output
                : { setAttribute: (name: string, value: string) => (attributes[/previous/.test(selector) ? 'previous' : 'next'][name] = value) },
        disabled: (which: 'previous' | 'next') => attributes[which]['aria-disabled'],
        /** A click on its previous or next button, as rendered: enabled, or not. */
        button: (which: 'previous' | 'next') => ({
            dataset: { page: which },
            getAttribute: (name: string) => (name === 'aria-disabled' ? (attributes[which]['aria-disabled'] ?? null) : null),
            closest: (selector: string) => (selector === 'nav[data-pages]' ? pager : null),
        }),
    };
    return pager;
}

/** What the webview tells the page of motion: VS Code's Reduce Motion as a class on the body, the system's as a media query. */
interface Motion {
    vscodeReduced?: boolean;
    systemReduced?: boolean;
}

/** The page's script over a DOM that holds `strips`, swapped for new ones by each update. */
function livePage(fragments: PanelFragments, firstStrips: FakeStrip[], pagers: ReturnType<typeof fakePager>[] = [], motion: Motion = {}) {
    const html = renderUsagePage('n0nce', "default-src 'none'", fragments);
    const script = /<script nonce="n0nce">([\s\S]*)<\/script>/.exec(html)?.[1];
    assert.ok(script);
    const posted: { type: string; text?: string; account?: string }[] = [];
    const listeners: Record<string, (e: unknown) => void> = {};
    let strips = firstStrips;
    let nextStrips = firstStrips;
    const details = { current: { open: false } as { open: boolean } | null };
    const focused: string[] = [];
    const written: string[] = [];
    const document = {
        activeElement: null as unknown,
        body: { classList: { contains: (name: string) => name === 'vscode-reduce-motion' && motion.vscodeReduced === true } },
        getElementById: (id: string) =>
            id === 'diagnostics'
                ? details.current
                : (strips.find(s => s.id === id) ?? {
                      set innerHTML(_html: string) {
                          // The update writes the slots; what it wrote is the new DOM.
                          written.push(id);
                          if (id === 'diagnostics-slot') {
                              details.current = { open: false };
                          }
                          strips = nextStrips;
                      },
                  }),
        querySelectorAll: (selector: string) => (selector === '.pages' ? strips : []),
        querySelector: (selector: string) => {
            const pager = /^nav\[data-pages="([^"]+)"\]$/.exec(selector);
            return pager ? (pagers.find(p => p.dataset.pages === pager[1]) ?? null) : { focus: () => focused.push(selector) };
        },
        // Kept apart by phase: scrollend does not bubble, so only a listener
        // that captures it hears it from a strip.
        addEventListener: (name: string, fn: (e: unknown) => void, capture?: boolean) => (listeners[capture === true ? `${name} capture` : name] = fn),
    };
    vm.runInNewContext(script, {
        acquireVsCodeApi: () => ({ postMessage: (m: { type: string }) => posted.push(m) }),
        document,
        window: {
            origin: ORIGIN,
            addEventListener: (name: string, fn: (e: unknown) => void) => (listeners[`window:${name}`] = fn),
            matchMedia: (query: string) => ({ matches: query === '(prefers-reduced-motion: reduce)' && motion.systemReduced === true }),
        },
        Intl,
    });
    return {
        posted,
        focused,
        written,
        details,
        document,
        click: (target: unknown) => listeners.click({ target: { closest: () => target } }),
        /** A strip coming to rest after a swipe or a glide: scrollend, fired at the strip. */
        rest: (strip: FakeStrip) => listeners['scrollend capture']?.({ target: strip }),
        /** Focus landing on `target`: focusin, which bubbles. */
        focusIn: (target: unknown) => listeners.focusin?.({ target }),
        update: (next: PanelFragments, newStrips: FakeStrip[]) => {
            nextStrips = newStrips;
            listeners['window:message']({ origin: ORIGIN, data: { type: 'data', fragments: next } });
        },
    };
}

/** The page's script, run as the webview would, with only what it uses. */
/** The page's origin, as the editor's webview gives it. */
const ORIGIN = 'vscode-webview://0123abcd';

function runPage(fragments: PanelFragments): {
    posted: { type: string; text?: string; account?: string }[];
    click(action: string): string;
    clickOn(dataset: Record<string, string>): void;
    choose(account: string): void;
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
        clickOn: dataset => listeners.click({ target: { closest: () => ({ dataset }) } }),
        choose: account => listeners.change({ target: { matches: (selector: string) => selector === 'select[data-account-filter]', value: account } }),
    };
}

suite('usage page', () => {
    test('every empty state says why, and what would change it', () => {
        const off = text(renderFragments(view({ status: 'off', report: undefined })));
        assert.ok(off.includes('Claude Code usage is off'));
        assert.ok(off.includes('Nothing is sent anywhere'));
        assert.ok(off.includes('Never kept: prompts, responses, thinking, tool inputs or results'));
        assert.ok(off.includes('data-action="turnOn"') && off.includes('data-action="openSettings"'));
        assert.ok(!off.includes('Remote settings'));
        const remote = text(renderFragments(view({ status: 'off', report: undefined, remote: true, where: 'on box (ssh-remote)' })));
        // Turn On writes a machine setting at the user level: in a remote window, VS Code writes it to the host's.
        assert.ok(remote.includes('The setting is in Remote settings, for this host, and Turn On sets it there.'));
        // The host named once, not inside "this machine".
        assert.ok(remote.includes('session records on box (ssh-remote),') && !remote.includes('records on this machine'), remote);
        assert.ok(off.includes('session records on this machine,'));

        const noRoots = text(
            renderFragments(view({ status: 'no-roots', report: undefined, roots: [{ path: '~/.claude', source: 'the default', exists: false }] })),
        );
        assert.ok(noRoots.includes('~/.claude') && noRoots.includes('not found') && noRoots.includes('data-action="chooseFolder"'));

        const noSqlite = text(renderFragments(view({ status: 'no-sqlite', report: undefined, sqliteRuntime: { node: '20.18.0', electron: '34.5.0' } })));
        assert.ok(noSqlite.includes('node:sqlite') && noSqlite.includes('Node 20.18.0') && noSqlite.includes('Electron 34.5.0'));

        const failing = text(renderFragments(view({ status: 'failing' })));
        assert.ok(failing.includes('could not be read or updated just now') && failing.includes('data-action="showLog"'));
        // What to do, not only what is wrong: the newer version is installed, or only to be.
        const readOnly = text(renderFragments(view({ status: 'read-only' })));
        assert.ok(readOnly.includes('written by a newer version of LLM Tokenizer, so this window shows it without updating it'));
        assert.ok(readOnly.includes('Reload the window to run that version here, or update LLM Tokenizer if it is not installed.'));
        assert.ok(readOnly.includes('<button type="button" data-action="reloadWindow">Reload Window</button>'));
        assert.ok(!text(renderFragments(view())).includes('reloadWindow'));
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

    test('the off page lists what turning it on reads and keeps, as the README does', () => {
        // The T shows to everyone with Claude Code's extension: this page is
        // where turning the feature on is decided.
        const readme = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'README.md'), 'utf8');
        const kept = /Tokenizer\) keeps:\r?\n([\s\S]*?)\r?\n\r?\n/.exec(readme)?.[1];
        assert.ok(kept, "the README's list of what is kept was not found");
        const items = kept.split(/^- /m).map(item => item.replace(/\s+/g, ' ').trim()).filter(Boolean);
        assert.strictEqual(items.length, 6, kept);
        const off = renderFragments(view({ status: 'off', report: undefined })).body.replace(/\s+/g, ' ');
        for (const item of items) {
            assert.ok(off.includes(item), `the off page does not say: ${item}`);
        }
    });

    test('while the history is read, the page says how far, every total is a lower bound, and Refresh is busy', () => {
        const reading = renderFragments(view({ reading: { by: 'this window', files: 1_200, of: 3_875 } }));
        const all = text(reading);
        assert.ok(
            reading.body.includes('<p class="banner reading">Still reading Claude Code&#39;s records: 1,200 of 3,875 files. These totals grow until it is done.</p>'),
            reading.body.slice(0, 400),
        );
        // The hero, the days, the projects and the sessions: each only what was read so far.
        assert.ok(all.includes('class="hero-value">≥1.3K<'), 'the hero');
        assert.ok(all.includes('2026-10-09: ≥1,278 processed'), 'a day');
        assert.strictEqual((reading.body.match(/<td class="num">≥1,278<\/td>/g) ?? []).length, 2, 'a project and a session');
        assert.ok(reading.controls.includes('<button type="button" data-action="refresh" aria-disabled="true">Reading…</button>'));

        // A count of files not known yet, or none at all.
        assert.ok(renderFragments(view({ reading: { by: 'this window', files: 40 } })).body.includes('records: 40 files so far.'));
        assert.ok(renderFragments(view({ reading: { by: 'this window' } })).body.includes('Still reading Claude Code&#39;s records. These totals'));

        const done = renderFragments(view());
        assert.ok(!text(done).includes('≥') && !done.body.includes('Still reading') && done.controls.includes('>Refresh</button>'));
    });

    test("another window's reading is said too, with no count, and its totals are lower bounds", () => {
        const elsewhere = renderFragments(view({ reading: { by: 'another window' } }));
        assert.ok(elsewhere.body.includes('Another window is reading Claude Code&#39;s records; these totals grow as it goes.'));
        assert.ok(elsewhere.body.includes('class="hero-value">≥1.3K<'));
    });

    test('a range the reading has not reached is never called one with no requests', () => {
        const nothing = report({ totals: emptyTotals(), days: [], models: [], kinds: [], efforts: [], projects: [], sessions: [] });
        const reading = renderFragments(view({ report: nothing, reading: { by: 'this window', files: 12, of: 77 } })).body;
        assert.ok(reading.includes('Nothing has been read in this range yet.') && !reading.includes('No requests fall in this range.'), reading);
        assert.ok(renderFragments(view({ report: nothing, scope: 'workspace', reading: { by: 'another window' } })).body.includes('Nothing has been read in this range yet.'));
        assert.ok(renderFragments(view({ report: nothing })).body.includes('No requests fall in this range.'));
    });

    test("the total's line says how much of it is cache reads, cut rather than rounded up", () => {
        const page = (cacheRead: number, rest: number) =>
            renderFragments(view({ report: report({ totals: { ...totals(cacheRead + rest), input: rest, cacheRead } }) })).body;
        // The maintainer's last 7 days: 98.0% of 12.2 billion was cache reads.
        assert.ok(page(11_997_234_660, 239_749_843).includes('tokens processed · 98% cache reads, the conversation each request sends again · 3 requests'));
        assert.ok(page(996, 4).includes('· 99% cache reads'), 'rounded up to all of it');
        assert.ok(page(1, 999).includes('· under 1% cache reads'));
        assert.ok(!page(0, 1_000).includes('cache reads,'));
    });

    test("the cache reads' share is one figure, cut alike on the total's line and on its bar", () => {
        // Found in the README's GIF: today's 95.94% was 95% on the line and
        // 96% on the Cache read bar just below it.
        const shown = (cacheRead: number, rest: number) => {
            const body = renderFragments(view({ report: report({ totals: { ...totals(cacheRead + rest), input: rest, cacheRead } }) })).body;
            const line = /· ([^ ]+) cache reads, the conversation/.exec(body)?.[1];
            const bar = /title="Cache read">Cache read<\/div>[\s\S]*?class="row-share">([^<]*)</.exec(body)?.[1];
            return [line, bar];
        };
        assert.deepStrictEqual(shown(95_938, 4_062), ['95%', '95%']);
        assert.deepStrictEqual(shown(996, 4), ['99%', '99%'], '99.6% is not all of it');
        assert.deepStrictEqual(shown(56, 944), ['5.6%', '5.6%']);
        // 0.29 is a hair under 29 as a float: still 29%.
        assert.deepStrictEqual(shown(29, 71), ['29%', '29%']);
        assert.strictEqual(cutPercent(0.999_99), '99%');
        assert.strictEqual(cutPercent(0.0999), '9.9%');
        assert.strictEqual(cutPercent(0), '0.0%');
    });

    test("every share on the page is cut, the projects' and the thinking's too", () => {
        // Found reviewing the README's GIF: the projects' 19.49% read 19.5%,
        // rounded up, while every bar was cut.
        const whole = totals(1_000_000);
        whole.output = 1_000;
        whole.thinking = 996;
        const part = totals(194_903);
        const body = renderFragments(
            view({ report: report({ totals: whole, projects: [{ project: { kind: 'root', path: '/repo/a' }, label: 'a', sessions: 1, totals: part, models: [] }] }) }),
        ).body;
        assert.ok(body.includes('<td class="num">19.4%</td>'), 'the share rounded up');
        assert.ok(body.includes('99% of output was thinking'), 'the thinking share rounded up');
    });

    test('processed, never used, and cache reads explained', () => {
        const all = text(renderFragments(view({ report: report({ totals: { ...totals(1_278), input: 278, cacheRead: 1_000 } }) }))).toLowerCase();
        assert.ok(all.includes('tokens processed'));
        assert.ok(!/tokens used|used tokens/.test(all));
        assert.ok(all.includes('78% cache reads, the conversation each request sends again'));
        // One share of cache reads on the page, not a second of input alone.
        assert.strictEqual(all.match(/% cache reads|read from the cache/g)?.length, 1, all);
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

    test('the CSV is apart by what a price depends on, and its notes say how to read those columns', () => {
        const t = totals(1);
        const row = (model: string, speed: string | null, inferenceGeo: string | null, promptSize: 'up-to-100k' | 'over-200k' | null) =>
            ({ date: '2026-10-09', model, variant: null, speed, inferenceGeo, promptSize, totals: t });
        const { csv } = renderFragments(
            view({ report: report({ dayModels: [row('claude-haiku-5-5', 'standard', 'global', 'over-200k'), row('claude-opus-5-5', 'fast', 'us', 'up-to-100k'), row('claude-opus-5-5', null, null, null)] }) }),
        );
        const at = (name: string) => csv.header.indexOf(name);
        assert.deepStrictEqual(csv.rows.map(r => [r[at('speed')], r[at('inference_geo')], r[at('prompt_size')]]), [
            ['standard', 'global', 'over-200k'],
            ['fast', 'us', 'up-to-100k'],
            ['', '', ''],
        ]);
        for (const said of ['fast, and us, are billed higher', 'Claude Haiku 5.5 prices a request over 100,000 higher', 'thinking_tokens are part of output_tokens']) {
            assert.ok(csv.notes.some(n => n.includes(said)), said);
        }
    });

    test("the page's own exports quote, guard formulas, and open with their notes", () => {
        const page = runPage(renderFragments(view()));
        assert.deepStrictEqual(page.posted[0]?.type, 'ready');

        const csv = page.click('export');
        const lines = csv.split('\n');
        assert.ok(lines[0].startsWith('# extension: LLM Tokenizer 2.2.0'));
        assert.ok(lines.includes('"date","model","variant","speed","inference_geo","prompt_size","requests","input_tokens","cache_creation_input_tokens","cache_creation_5m","cache_creation_1h","cache_read_input_tokens","output_tokens","thinking_tokens","web_search_requests","web_fetch_requests","complete"'));
        assert.ok(csv.includes(`"'=cmd|""/c calc""!A1"`), 'a model id was left able to run as a formula');

        const copied = page.click('copy');
        assert.ok(copied.split('\n').some(l => l.split('\t').length === 7 && l.includes(HOSTILE)), 'a session row lost its columns');
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
        const html = renderUsagePage('abc', "default-src 'none'; script-src 'nonce-abc'", renderFragments(view({ report: report({ dayModels: [{ date: '2026-10-09', model: '</script><script>alert(1)</script>', variant: null, speed: null, inferenceGeo: null, promptSize: null, totals: totals(1) }] }) })));
        assert.ok(html.includes(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-abc'">`));
        assert.strictEqual((html.match(/<\/script>/g) ?? []).length, 1);
    });

    test("a header's button sorts its table, numbers as numbers, and says which way", () => {
        const sessions = fakeStrip('sessions', 'processed', ['label', 'processed'], [
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
        const before = fakeStrip('sessions', 'processed', ['label', 'processed'], rows);
        const page = livePage(renderFragments(view()), [before]);
        page.click(before.button('label'));
        page.details.current = { open: true };
        page.document.activeElement = { matches: () => true, closest: () => null, getAttribute: (name: string) => (name === 'data-range' ? '30d' : null) };

        const after = fakeStrip('sessions', 'processed', ['label', 'processed'], [...rows, { label: 'c', processed: '50' }]);
        const next = renderFragments(view({ report: report({ sessions: [{ ...report().sessions[0], label: 'moved', sessionId: 'next' }] }) }));
        page.update(next, [after]);
        assert.deepStrictEqual([after.order(), after.sortOf('label')], [['a', 'b', 'c'], 'ascending']);
        assert.strictEqual(page.details.current?.open, true, 'the diagnostics closed on an update');
        assert.deepStrictEqual(page.focused, ['button[data-range="30d"]']);
        // And the exports are the update's.
        page.click({ dataset: { action: 'copy' } });
        assert.ok(page.posted.at(-1)?.text?.includes('next'));
    });

    test("focus on a table's header returns to that table's, not to the first one with the same key", () => {
        // Projects and Sessions both sort by label and processed: the first
        // match in the page was the Projects table's, so Enter sorted the wrong one.
        const page = livePage(renderFragments(view()), [fakeStrip('sessions', 'processed', ['label', 'processed'], [])]);
        const sessions = { id: 'sessions' };
        page.document.activeElement = {
            matches: (s: string) => s === 'button',
            closest: (s: string) => (s === '.pages[id]' ? sessions : null),
            getAttribute: (name: string) => (name === 'data-sort-key' ? 'processed' : null),
        };
        page.update(renderFragments(view({ zone: 'UTC' })), [fakeStrip('sessions', 'processed', ['label', 'processed'], [])]);
        assert.deepStrictEqual(page.focused, ['#sessions > .page:nth-child(1) button[data-sort-key="processed"]']);
        // The diagnostics' own header, which is no button, keeps its focus too.
        page.document.activeElement = { matches: (s: string) => s === '#diagnostics > summary', closest: () => null, getAttribute: () => null };
        page.update(renderFragments(view({ zone: 'Europe/Rome' })), []);
        assert.strictEqual(page.focused.at(-1), '#diagnostics > summary');
    });

    test('an update that changes nothing in a region leaves that region as it is', () => {
        const first = renderFragments(view());
        const page = livePage(first, []);
        page.update(first, []);
        const once = page.written.length;
        page.update(first, []);
        assert.strictEqual(page.written.length, once, 'an unchanged page was written again');
        page.update(renderFragments(view({ zone: 'UTC' })), []);
        assert.ok(page.written.length > once);
    });

    test('sorting and every action work from the keyboard, as buttons', () => {
        const all = text(renderFragments(view()));
        assert.ok(/<th[^>]*aria-sort="descending"><button type="button" data-sort-key="processed">/.test(all));
        for (const action of ['refresh', 'copy', 'export', 'clear', 'showLog']) {
            assert.ok(all.includes(`<button type="button" data-action="${action}"`), action);
        }
        assert.ok(all.includes('aria-pressed="true">7 days'));
    });

    /** `n` sessions, labelled p0, p1, … */
    const manySessions = (n: number) => Array.from({ length: n }, (_, i) => ({ ...report().sessions[0], sessionId: `s${i}`, label: `p${i}` }));

    test('a long list pages sideways, ten rows a page, the first in view, with a pager that says which rows those are', () => {
        const body = renderFragments(view({ report: report({ sessions: manySessions(23) }) })).body;
        // Three pages of sessions and the one of projects, each with its own header.
        assert.strictEqual((body.match(/<table class="page"/g) ?? []).length, 4);
        assert.strictEqual((body.match(/data-sort-key="active"/g) ?? []).length, 3);
        assert.strictEqual((body.match(/<table class="page" inert>/g) ?? []).length, 2, 'a page out of view can be reached as rendered');
        assert.strictEqual((body.match(/<tr data-k-started/g) ?? []).length, 23);
        assert.ok(body.includes('<div class="pages" id="sessions" role="region" aria-label="Sessions" data-rows="23" data-page-rows="10" data-sort="processed" data-ascending="false">'));
        assert.ok(body.includes('<nav class="pager" data-pages="sessions" aria-label="Sessions, by page">'));
        assert.ok(body.includes('<output aria-live="polite">1–10 of 23</output>'));
        assert.ok(/data-page="previous"[^>]*aria-disabled="true"/.test(body) && !/data-page="next"[^>]*aria-disabled/.test(body));
        // Ten or fewer: one page, and no pager.
        const few = renderFragments(view({ report: report({ sessions: manySessions(10) }) })).body;
        assert.ok(!few.includes('<nav class="pager"'));
        assert.strictEqual((few.match(/<table class="page"/g) ?? []).length, 2);
        assert.ok(!few.includes(' inert'));
    });

    test('Usage limits reached lists the newest first, a page at a time', () => {
        const windows = Array.from({ length: 12 }, (_, i) => ({ account: 'none', limitType: 'five_hour', resetsAt: null, hits: 1, firstTs: Date.UTC(2026, 9, 9, i), date: '2026-10-09' }));
        const body = renderFragments(view({ report: report({ limitWindows: windows }) })).body;
        const newest = body.indexOf('refused from 2026-10-09 11:00');
        const oldest = body.indexOf('refused from 2026-10-09 00:00');
        assert.ok(newest !== -1 && oldest !== -1 && newest < oldest, 'not the newest first');
        assert.strictEqual((body.match(/<ul class="page plain-list"/g) ?? []).length, 2);
        assert.ok(body.includes('<ul class="page plain-list" inert>'));
        assert.ok(body.includes('<nav class="pager" data-pages="limits" aria-label="Usage limits reached, by page">'));
        assert.ok(body.includes('<output aria-live="polite">1–10 of 12</output>'));
    });

    test('the pager turns a list a page at a time, says which rows are in view, and stops at either end', () => {
        const rows = Array.from({ length: 23 }, (_, i) => ({ label: `r${i}`, processed: String(100 - i) }));
        const sessions = fakeStrip('sessions', 'processed', ['label', 'processed'], rows);
        const pager = fakePager('sessions');
        const page = livePage(renderFragments(view()), [sessions], [pager]);
        const state = () => [pager.output.textContent, pager.disabled('previous'), pager.disabled('next'), sessions.reachable()];
        assert.deepStrictEqual(state(), ['1–10 of 23', 'true', 'false', [0]]);
        page.click(pager.button('previous'));
        assert.deepStrictEqual(sessions.glides, [], 'turned back from the first page');

        page.click(pager.button('next'));
        assert.deepStrictEqual(sessions.glides, [600]);
        // Only the page it glides to can be reached, from the start: Tab after
        // the button goes into it, never back into the page it leaves.
        assert.deepStrictEqual(sessions.reachable(), [1]);
        page.rest(sessions);
        assert.deepStrictEqual(state(), ['11–20 of 23', 'false', 'false', [1]]);

        page.click(pager.button('next'));
        page.rest(sessions);
        assert.deepStrictEqual(state(), ['21–23 of 23', 'false', 'true', [2]]);
        page.click(pager.button('next'));
        assert.deepStrictEqual(sessions.glides, [600, 1200], 'went past the last page');

        page.click(pager.button('previous'));
        page.rest(sessions);
        assert.deepStrictEqual(state(), ['11–20 of 23', 'false', 'false', [1]]);
    });

    test('a swipe is a turn too: the page the strip rests on is the one in view', () => {
        const sessions = fakeStrip('sessions', 'processed', ['label', 'processed'], Array.from({ length: 30 }, (_, i) => ({ label: `r${i}`, processed: String(i) })));
        const pager = fakePager('sessions');
        const page = livePage(renderFragments(view()), [sessions], [pager]);
        sessions.scrollLeft = 1199.5;
        page.rest(sessions);
        // Within a pixel of the edge, as a fractional scroll position is, it is left where it rests.
        assert.deepStrictEqual([pager.output.textContent, sessions.reachable(), sessions.scrollLeft], ['21–30 of 30', [2], 1199.5]);
    });

    test('a glide cut short between two pages is put back on the page it comes to rest nearest', () => {
        // Focus during a glide stops it, and a resize lets it end off a
        // page's edge; scroll snapping moves it no further.
        const sessions = fakeStrip('sessions', 'processed', ['label', 'processed'], Array.from({ length: 30 }, (_, i) => ({ label: `r${i}`, processed: String(i) })));
        const pager = fakePager('sessions');
        const page = livePage(renderFragments(view()), [sessions], [pager]);
        sessions.scrollLeft = 700;
        page.rest(sessions);
        assert.deepStrictEqual([sessions.scrollLeft, sessions.reachable(), pager.output.textContent], [600, [1], '11–20 of 30']);
    });

    test('focus that lands on a page turns its strip there, where a glide it cut short left no scrollend', () => {
        const sessions = fakeStrip('sessions', 'processed', ['label', 'processed'], Array.from({ length: 30 }, (_, i) => ({ label: `r${i}`, processed: String(i) })));
        const pager = fakePager('sessions');
        const page = livePage(renderFragments(view()), [sessions], [pager]);
        page.click(pager.button('next'));
        // Tab into the page it glides to stops the glide 250 px in, and no scrollend comes.
        sessions.scrollLeft = 250;
        page.focusIn(sessions.on(1));
        assert.deepStrictEqual([sessions.scrollLeft, sessions.reachable(), pager.output.textContent], [600, [1], '11–20 of 30']);
        // Focus on another page, by a script say, turns there too.
        page.focusIn(sessions.on(2));
        assert.deepStrictEqual([sessions.scrollLeft, sessions.reachable(), pager.output.textContent], [1200, [2], '21–30 of 30']);
        // Focus already on the page in view, and at rest, moves nothing.
        const before = pager.output.writes;
        page.focusIn(sessions.on(2));
        assert.deepStrictEqual([sessions.scrollLeft, pager.output.writes], [1200, before]);
        // Nor does focus anywhere else.
        page.focusIn({ closest: () => null });
        assert.strictEqual(sessions.scrollLeft, 1200);
    });

    test("the pager's line, a live region, is written only when it changes", () => {
        const rows = Array.from({ length: 25 }, (_, i) => ({ label: `r${i}`, processed: String(i) }));
        const sessions = fakeStrip('sessions', 'processed', ['label', 'processed'], rows);
        const pager = fakePager('sessions');
        const page = livePage(renderFragments(view()), [sessions], [pager]);
        assert.deepStrictEqual([pager.output.textContent, pager.output.writes], ['1–10 of 25', 1]);
        // An update that leaves the list as it was, a refresh's time say, reads nothing out again.
        page.update(renderFragments(view({ refreshedAt: Date.UTC(2026, 9, 9, 13) })), [sessions]);
        const again = fakeStrip('sessions', 'processed', ['label', 'processed'], rows);
        page.update(renderFragments(view({ zone: 'UTC' })), [again]);
        assert.strictEqual(pager.output.writes, 1);
        page.click(pager.button('next'));
        page.rest(again);
        assert.deepStrictEqual([pager.output.textContent, pager.output.writes], ['11–20 of 25', 2]);
    });

    test("Reduce Motion, VS Code's or the system's, turns a page at once", () => {
        for (const motion of [{ vscodeReduced: true }, { systemReduced: true }]) {
            const sessions = fakeStrip('sessions', 'processed', ['label', 'processed'], Array.from({ length: 25 }, (_, i) => ({ label: `r${i}`, processed: String(i) })));
            const pager = fakePager('sessions');
            const page = livePage(renderFragments(view()), [sessions], [pager], motion);
            page.click(pager.button('next'));
            assert.deepStrictEqual([sessions.glides, sessions.scrollLeft, sessions.reachable(), pager.output.textContent], [[], 600, [1], '11–20 of 25'], JSON.stringify(motion));
        }
        // And without it, the turn glides.
        const sessions = fakeStrip('sessions', 'processed', ['label', 'processed'], Array.from({ length: 25 }, (_, i) => ({ label: `r${i}`, processed: String(i) })));
        const pager = fakePager('sessions');
        livePage(renderFragments(view()), [sessions], [pager]).click(pager.button('next'));
        assert.deepStrictEqual(sessions.glides, [600]);
    });

    test("a header's focus after an update returns to the page in view, or the last there is", () => {
        const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `r${i}`, processed: String(100 - i) }));
        const sessions = fakeStrip('sessions', 'processed', ['label', 'processed'], rows(25));
        const pager = fakePager('sessions');
        const page = livePage(renderFragments(view()), [sessions], [pager]);
        page.click(pager.button('next'));
        page.rest(sessions);
        page.click(pager.button('next'));
        page.rest(sessions);
        const header = {
            matches: (s: string) => s === 'button',
            closest: (s: string) => (s === '.pages[id]' ? { id: 'sessions' } : null),
            getAttribute: (name: string) => (name === 'data-sort-key' ? 'processed' : null),
        };
        page.document.activeElement = header;
        page.update(renderFragments(view({ zone: 'UTC' })), [fakeStrip('sessions', 'processed', ['label', 'processed'], rows(25))]);
        assert.strictEqual(page.focused.at(-1), '#sessions > .page:nth-child(3) button[data-sort-key="processed"]');
        page.document.activeElement = header;
        page.update(renderFragments(view({ zone: 'Europe/Rome' })), [fakeStrip('sessions', 'processed', ['label', 'processed'], rows(15))]);
        assert.strictEqual(page.focused.at(-1), '#sessions > .page:nth-child(2) button[data-sort-key="processed"]');
    });

    test('a list with nothing to focus in it, Usage limits reached, keeps its focus across an update', () => {
        // Its strip is then itself a stop on Tab, and the arrow keys turn its pages.
        const page = livePage(renderFragments(view()), []);
        page.document.activeElement = { matches: (s: string) => s === '.pages[id]', id: 'limits', closest: () => null, getAttribute: () => null };
        page.update(renderFragments(view({ zone: 'UTC' })), []);
        assert.deepStrictEqual(page.focused, ['#limits']);
    });

    test("in a narrow panel only a project's name is cut, its title whole; every figure wraps", () => {
        const fragments = renderFragments(view({ report: report({ sessions: manySessions(12) }) }));
        const html = renderUsagePage('n0nce', "default-src 'none'", fragments);
        assert.ok(html.includes('table.page td.label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }'));
        assert.ok(html.includes('table.page td, table.page th button { overflow-wrap: anywhere; }'));
        assert.ok(!/table\.page td,[^{]*\{[^}]*nowrap/.test(html), 'a figure can be cut');
        // The project's cell is the one cut, and its title holds the whole name.
        assert.ok(fragments.body.includes(`<td class="label"><span title="${'p0'}">p0</span></td>`));
        assert.strictEqual((fragments.body.match(/<td class="label">/g) ?? []).length, 12 + 1, 'every project cell, of the sessions and of the projects');
        // Each list's strip is named, so that one with nothing focusable in it is named when Tab reaches it.
        for (const [id, name] of [['sessions', 'Sessions'], ['projects', 'Projects'], ['limits', 'Usage limits reached']]) {
            assert.ok(fragments.body.includes(`<div class="pages" id="${id}" role="region" aria-label="${name}"`), id);
        }
    });

    test('a sort orders every row on every page, and shows the new order from its first page', () => {
        const rows = Array.from({ length: 12 }, (_, i) => ({ label: `r${String(i).padStart(2, '0')}`, processed: String(i) }));
        const sessions = fakeStrip('sessions', 'processed', ['label', 'processed'], rows);
        const pager = fakePager('sessions');
        const page = livePage(renderFragments(view()), [sessions], [pager]);
        // Largest first, across both pages, not page by page.
        assert.deepStrictEqual(sessions.pages(), [['r11', 'r10', 'r09', 'r08', 'r07', 'r06', 'r05', 'r04', 'r03', 'r02'], ['r01', 'r00']]);
        page.click(pager.button('next'));
        page.rest(sessions);
        page.click(sessions.button('label', 1));
        assert.deepStrictEqual(sessions.pages(), [['r00', 'r01', 'r02', 'r03', 'r04', 'r05', 'r06', 'r07', 'r08', 'r09'], ['r10', 'r11']]);
        assert.deepStrictEqual([sessions.scrollLeft, sessions.reachable(), pager.output.textContent], [0, [0], '1–10 of 12']);
        assert.deepStrictEqual([sessions.sortOf('label'), sessions.sortOf('processed')], ['ascending', 'none']);
    });

    test('an update keeps the page in view, or the last one there is when the list has grown shorter', () => {
        const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `r${i}`, processed: String(100 - i) }));
        const before = fakeStrip('sessions', 'processed', ['label', 'processed'], rows(25));
        const pager = fakePager('sessions');
        const page = livePage(renderFragments(view()), [before], [pager]);
        page.click(pager.button('next'));
        page.rest(before);
        page.click(pager.button('next'));
        page.rest(before);

        const longer = fakeStrip('sessions', 'processed', ['label', 'processed'], rows(26));
        page.update(renderFragments(view({ zone: 'UTC' })), [longer]);
        assert.deepStrictEqual([longer.scrollLeft, longer.reachable(), pager.output.textContent], [1200, [2], '21–26 of 26']);
        const shorter = fakeStrip('sessions', 'processed', ['label', 'processed'], rows(15));
        page.update(renderFragments(view({ zone: 'Europe/Rome' })), [shorter]);
        assert.deepStrictEqual([shorter.scrollLeft, shorter.reachable(), pager.output.textContent], [600, [1], '11–15 of 15']);
    });

    test('focus on a header that slides out of view follows to the same header on the page in view', () => {
        const sessions = fakeStrip('sessions', 'processed', ['label', 'processed'], Array.from({ length: 15 }, (_, i) => ({ label: `r${i}`, processed: String(i) })));
        const page = livePage(renderFragments(view()), [sessions], [fakePager('sessions')]);
        page.document.activeElement = sessions.button('processed', 0);
        sessions.scrollLeft = 600;
        page.rest(sessions);
        assert.deepStrictEqual([sessions.focusedOn, sessions.reachable()], [['page 1 button[data-sort-key="processed"]'], [1]]);
    });

    test("focus on a pager's button returns to that pager's after an update", () => {
        const sessions = fakeStrip('sessions', 'processed', ['label', 'processed'], []);
        const page = livePage(renderFragments(view()), [sessions]);
        page.document.activeElement = {
            matches: (s: string) => s === 'button',
            closest: (s: string) => (s === 'nav[data-pages]' ? { dataset: { pages: 'sessions' } } : null),
            getAttribute: (name: string) => (name === 'data-page' ? 'next' : null),
        };
        page.update(renderFragments(view({ zone: 'UTC' })), [sessions]);
        assert.deepStrictEqual(page.focused, ['nav[data-pages="sessions"] button[data-page="next"]']);
    });

    test("a session's or a project's tokens name their models on hover, each with its share, cut", () => {
        const models = (shares: number[]) => shares.map((n, i) => ({ model: i === 0 ? HOSTILE : `claude-model-${i}`, variant: i === 0 ? '1m' : null, totals: totals(n) }));
        const session = { ...report().sessions[0], totals: totals(1_000), models: models([996, 4]) };
        const project = { ...report().projects[0], totals: totals(1_000), models: models([500, ...Array.from({ length: 9 }, () => 50)]) };
        const body = renderFragments(view({ report: report({ sessions: [session], projects: [project] }), modelLabel: id => (id === HOSTILE ? HOSTILE : id.toUpperCase()) })).body;
        // 99.6% is not all of it, and a transcript's model id is escaped.
        assert.ok(body.includes('title="&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp; (1m) 99%, CLAUDE-MODEL-1 0.4%">1,000</span>'), body);
        // Eight named, the rest counted.
        assert.ok(body.includes('CLAUDE-MODEL-7 5.0%, and 2 more">1,000</span>'), body);
        // A row with nothing to name has no title.
        const bare = renderFragments(view()).body;
        assert.ok(bare.includes('<td class="num">1,278</td>'));
    });

    /** A report of three accounts: one Claude Code is signed in to now, one it never named, and the sessions that record none. */
    function accountsReport(overrides: Partial<UsageReport> = {}): UsageReport {
        const base = report();
        const t = base.totals;
        const A = '0f1e2d3c-4b5a-4968-8776-655443322110';
        const ORG = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
        const B = '9e8d7c6b-5a49-4837-a625-140f0e0d0c0b';
        const ownerA = { accountUuid: A, organizationUuid: ORG };
        const ownerB = { accountUuid: B, organizationUuid: null };
        const half = { ...t, processed: Math.floor(t.processed / 2) };
        return report({
            accounts: [
                { key: `${A}/${ORG}`, owner: ownerA, sessions: 2, totals: half, models: [], projects: ['one', 'two'] },
                { key: `${B}/`, owner: ownerB, sessions: 1, totals: { ...t, processed: 300 }, models: [], projects: [HOSTILE] },
                { key: 'none', owner: null, sessions: 4, totals: { ...t, processed: 100 }, models: [], projects: ['old'] },
            ],
            accountsSeen: [
                { key: `${A}/${ORG}`, owner: ownerA, sessions: 2, firstTs: Date.UTC(2026, 9, 1, 9), lastTs: Date.UTC(2026, 9, 9, 11) },
                { key: `${B}/`, owner: ownerB, sessions: 1, firstTs: Date.UTC(2026, 9, 3, 9), lastTs: Date.UTC(2026, 9, 4, 9) },
                { key: 'none', owner: null, sessions: 4, firstTs: Date.UTC(2026, 8, 1, 9), lastTs: Date.UTC(2026, 8, 30, 9) },
            ],
            accountNames: [{ accountUuid: A, organizationUuid: ORG, email: `a@example.com`, organizationName: HOSTILE }],
            currentAccounts: [`${A}/${ORG}`],
            sessions: [{ ...base.sessions[0], account: `${B}/` }],
            ...overrides,
        });
    }
    const KEY_A = '0f1e2d3c-4b5a-4968-8776-655443322110/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
    const ID_A = '0f1e2d3c-4b5a-4968-8776-655443322110';
    const ID_B = '9e8d7c6b-5a49-4837-a625-140f0e0d0c0b';

    test('the Accounts section names each account, says when it was used and where, and which one Claude Code is signed in to', () => {
        const fragments = renderFragments(view({ report: accountsReport() }));
        const body = fragments.body;
        assert.ok(body.includes('<h2>Accounts</h2>'));
        // Before the projects: the larger grouping first.
        assert.ok(body.indexOf('<h2>Accounts</h2>') < body.indexOf('<h2>Projects</h2>'));
        // Claude Code's own label, escaped; the one it never named numbered by first use.
        assert.ok(body.includes(`a@example.com (${HOSTILE_ESCAPED})</span><span class="badge">signed in now</span>`), body);
        assert.ok(body.includes('>Account 2</span>') && body.includes('>Not recorded</span>'));
        // What tells them apart, below each: when it was used and in which projects.
        assert.ok(body.includes('<div class="account-hint">2026-10-01 – 2026-10-09 · one, two</div>'));
        assert.ok(body.includes(`<div class="account-hint">2026-10-03 – 2026-10-04 · ${HOSTILE_ESCAPED}</div>`));
        assert.ok(body.includes('<div class="account-hint">no account in its transcripts</div>'));
        // Its ids on hover, whole, as the setting keys names by them.
        assert.ok(body.includes(`Account ${ID_A}\nOrganization a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d`));
        // A button to name each recorded account, by its id; none for the sessions that record none.
        assert.ok(body.includes(`data-action="nameAccount" data-account="${ID_A}"`) && body.includes(`data-action="nameAccount" data-account="${ID_B}"`));
        assert.strictEqual((body.match(/data-action="nameAccount"/g) ?? []).length, 2);
        assert.ok(body.includes('Not recorded: sessions Claude Code wrote before it recorded accounts, from version 2.1.318 or so'));
        // Sorted as the other tables, by the label as shown.
        assert.ok(body.includes('data-k-label="a@example.com (') && body.includes('data-k-label="Account 2"'));
    });

    test('no account is spoken of until the history has seen one, nor its section once one is chosen', () => {
        const none = renderFragments(view());
        assert.ok(!none.body.includes('<h2>Accounts</h2>') && !none.controls.includes('data-account-filter'));
        assert.ok(!none.body.includes('Account:'), 'a session says an account when there is none to say');
        const chosen = renderFragments(view({ account: KEY_A, report: accountsReport({ account: KEY_A }) }));
        assert.ok(!chosen.body.includes('<h2>Accounts</h2>'));
        assert.ok(chosen.controls.includes(`<option value="${KEY_A}" selected>`));
    });

    test('the account filter offers every account by first use, those with none last, and posts the one chosen', () => {
        const { controls } = renderFragments(view({ report: accountsReport() }));
        const options = [...controls.matchAll(/<option value="([^"]*)"( selected)?>([^<]*)<\/option>/g)].map(m => [m[1], m[3], Boolean(m[2])]);
        assert.deepStrictEqual(options, [
            ['all', 'All accounts', true],
            [KEY_A, `a@example.com (${HOSTILE_ESCAPED})`, false],
            [`${ID_B}/`, 'Account 2', false],
            ['none', 'Not recorded', false],
        ]);
        assert.ok(controls.includes('<select class="account-filter" data-account-filter aria-label="Account">'));
        // One the history no longer holds, while it is chosen, is still offered.
        const gone = `${ID_B}/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d`;
        assert.ok(renderFragments(view({ account: gone, report: accountsReport({ account: gone }) })).controls.includes(`<option value="${gone}" selected>`));

        const page = runPage(renderFragments(view({ report: accountsReport() })));
        page.choose(KEY_A);
        page.clickOn({ action: 'nameAccount', account: ID_B });
        // Posted from the page's own context: compared as the editor receives them.
        assert.deepStrictEqual(JSON.parse(JSON.stringify(page.posted.slice(1))), [
            { type: 'setAccount', account: KEY_A },
            { type: 'nameAccount', account: ID_B },
        ]);
    });

    test("a session's account is on hover and in Copy; a limit says whose it is once there are two; one account's export says which", () => {
        const both = accountsReport({
            limitWindows: [
                { account: KEY_A, limitType: 'five_hour', resetsAt: null, hits: 1, firstTs: Date.UTC(2026, 9, 9, 10), date: '2026-10-09' },
                { account: `${ID_B}/`, limitType: 'five_hour', resetsAt: null, hits: 2, firstTs: Date.UTC(2026, 9, 9, 11), date: '2026-10-09' },
            ],
        });
        const fragments = renderFragments(view({ report: both }));
        assert.ok(fragments.body.includes('\nAccount: Account 2"'), 'the session');
        assert.ok(fragments.body.includes('<li><span>Account 2: five hour limit, 2 requests refused from'));
        assert.ok(fragments.body.includes(`<li><span>a@example.com (${HOSTILE_ESCAPED}): five hour limit, 1 request refused`));
        assert.ok(fragments.body.includes('Each for its whole account, whichever project hit them'));
        assert.deepStrictEqual([fragments.copy.header.at(-1), fragments.copy.rows[0]?.at(-1)], ['account', 'Account 2']);
        assert.ok(fragments.copy.notes.some(n => n.startsWith('account is the Claude account a session was signed in to')));
        // One account's limits only: no need to say whose.
        const one = renderFragments(view({ report: accountsReport({ limitWindows: [both.limitWindows[0]] }) }));
        assert.ok(one.body.includes('<li><span>five hour limit') && one.body.includes('For the whole account, whichever project'));

        const filtered = renderFragments(view({ account: `${ID_B}/`, report: accountsReport({ account: `${ID_B}/` }) }));
        assert.ok(filtered.csv.notes.some(n => n.startsWith('range: ') && n.endsWith(', account Account 2')), filtered.csv.notes.join('|'));
        const empty = renderFragments(view({ account: `${ID_B}/`, report: accountsReport({ account: `${ID_B}/`, totals: emptyTotals() }) }));
        assert.ok(empty.body.includes('No session of Account 2 falls in this range.'), empty.body);
    });

    test('the diagnostics say which configuration file names the accounts, or that none does', () => {
        const named = renderFragments(view()).diagnostics;
        assert.ok(named.includes(`<dt>Account names</dt><dd>from <span class="path">~/.claude${HOSTILE_ESCAPED}.json</span></dd>`), named);
        const none = renderFragments(view({ accountFiles: [] })).diagnostics;
        assert.ok(none.includes('<dt>Account names</dt><dd>no Claude Code configuration file found</dd>'));
    });

    test('names you give stand in place of the email, and say what Claude Code calls the account on hover', () => {
        const { body, controls } = renderFragments(view({ report: accountsReport(), givenNames: { [ID_A]: 'Work', [ID_B]: '<b>Old</b>' } }));
        assert.ok(body.includes(`>Work (${HOSTILE_ESCAPED})</span>`));
        assert.ok(body.includes(`Claude Code calls it a@example.com (${HOSTILE_ESCAPED})`));
        assert.ok(body.includes('>&lt;b&gt;Old&lt;/b&gt;</span>') && !body.includes('<b>Old</b>'));
        assert.ok(body.includes(`data-account="${ID_A}" title="Rename this account in this panel">Rename…</button>`));
        assert.ok(controls.includes('>&lt;b&gt;Old&lt;/b&gt;</option>'));
    });

    test("a session's active time is shown, sorts as a number, is explained, and is copied", () => {
        const s = report().sessions[0];
        const quick = { ...s, sessionId: 'quick', activeMs: 20_000 };
        const long = { ...s, sessionId: 'long', activeMs: (2 * 60 + 5) * 60_000 + 20_000 };
        const fragments = renderFragments(view({ report: report({ sessions: [quick, long] }) }));
        const body = fragments.body;
        assert.ok(body.includes('<button type="button" data-sort-key="active">Active</button>'));
        assert.ok(body.includes('data-k-active="20000"') && body.includes('data-k-active="7520000"'));
        // Under a minute is said so, never 0 min.
        assert.ok(body.includes('>&lt; 1 min</span>') && !body.includes('>0 min<'));
        assert.ok(body.includes('>2 h 5 min</span>'));
        // From first to last stays at hand, on the cell.
        assert.ok(body.includes('title="Requests from 2026-10-09 10:00 to 2026-10-09 11:30"'));
        assert.ok(body.includes("Active is a session's time between requests in this range, its subagents' included, leaving out every pause of over 15 minutes"));
        assert.ok(!/>Span</.test(body) && !body.includes('first request to its last'));
        const active = fragments.copy.header.indexOf('active_minutes');
        assert.ok(active > 0);
        assert.deepStrictEqual(fragments.copy.rows.map(r => r[active]), ['0', '125']);
        assert.ok(fragments.copy.notes.some(n => n.startsWith('active_minutes is the time between')));
    });
});

suite('usage panel messages', () => {
    test('only the expected messages, with checked fields, are taken', () => {
        assert.deepStrictEqual(parsePanelMessage({ type: 'ready', zone: 'Europe/Rome' }), { type: 'ready', zone: 'Europe/Rome' });
        assert.deepStrictEqual(parsePanelMessage({ type: 'setRange', range: '30d' }), { type: 'setRange', range: '30d' });
        assert.deepStrictEqual(parsePanelMessage({ type: 'setScope', scope: 'workspace' }), { type: 'setScope', scope: 'workspace' });
        assert.deepStrictEqual(parsePanelMessage({ type: 'clear', extra: 1 }), { type: 'clear' });
        assert.deepStrictEqual(parsePanelMessage({ type: 'turnOn' }), { type: 'turnOn' });
        assert.deepStrictEqual(parsePanelMessage({ type: 'reloadWindow', command: 'x' }), { type: 'reloadWindow' });
        const account = '0f1e2d3c-4b5a-4968-8776-655443322110';
        for (const filter of ['all', 'none', `${account}/`, `${account}/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d`]) {
            assert.deepStrictEqual(parsePanelMessage({ type: 'setAccount', account: filter }), { type: 'setAccount', account: filter });
        }
        assert.deepStrictEqual(parsePanelMessage({ type: 'nameAccount', account }), { type: 'nameAccount', account });
        for (const bad of [
            null,
            'clear',
            { type: 'ready', zone: 'Mars/Olympus' },
            { type: 'ready' },
            { type: 'setRange', range: 'forever' },
            { type: 'setScope', scope: 'everything' },
            { type: 'setAccount', account: 'everyone' },
            { type: 'setAccount', account: '0f1e2d3c-4b5a-4968-8776-655443322110' },
            { type: 'setAccount' },
            { type: 'nameAccount', account: '0f1e2d3c-4b5a-4968-8776-655443322110/' },
            { type: 'nameAccount', account: 'none' },
            { type: 'nameAccount', account: ['0f1e2d3c-4b5a-4968-8776-655443322110'] },
            { type: 'copy', text: 42 },
            { type: 'export', text: 'x'.repeat((16 << 20) + 1) },
            { type: 'openFile', path: '/etc/passwd' },
            { type: '__proto__' },
        ]) {
            assert.strictEqual(parsePanelMessage(bad), undefined, JSON.stringify(bad)?.slice(0, 80));
        }
    });
});
