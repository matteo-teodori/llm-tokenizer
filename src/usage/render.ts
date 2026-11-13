/**
 * The Claude Code Usage page: one shell, rendered once, and fragments the
 * host renders and posts whenever the report changes.
 *
 * Every fragment is rendered here, in typed code, and every string from a
 * transcript (a cwd, a model id, a session id) goes through `escapeHtml`: a
 * record is attacker-controlled text. The page only swaps fragments in,
 * keeps each table's sort and the focus, and builds Copy and CSV from rows
 * posted with them, through the shared, tested `PAGE_TEXT_HELPERS`.
 *
 * Form follows the data's job, as on the summary page: the total is a hero
 * figure; categories, models, kinds and effort are ranked bars on a common
 * baseline; days are a column per day; projects and sessions are tables.
 * "Processed", never "used", and a total that is only a lower bound carries
 * `≥`: every total, while the history is still being read.
 */

import { RANKED_BARS_CSS, THEME_TOKENS_CSS, rankedBars, type RankedValue } from '../charts';
import { PAGE_TEXT_HELPERS, embed, escapeHtml } from '../html';
import { formatNumber } from '../utils';
import { ALL_ACCOUNTS, NOT_RECORDED, accountLabels, type AccountLabel } from './accounts';
import type { UsageTotals } from './aggregate';
import { totalPrefix } from './provenance';
import { ACTIVE_PAUSE_MS, type AccountRow, type ModelRow, type RangeKey, type UsageReport } from './report';
import type { Reading, UsageStatus } from './usageService';

/** What the panel shows besides the report: status, scope, and diagnostics. */
export interface PanelView {
    status: UsageStatus;
    /** The history being read, this window's pass or another's, while the page should say so. */
    reading: Reading | undefined;
    range: RangeKey;
    scope: 'all' | 'workspace';
    /** The account filter: ALL_ACCOUNTS, or one account's key. */
    account: string;
    /** The names you gave accounts, by account id, from the setting. */
    givenNames: Readonly<Record<string, string>>;
    zone: string;
    /** "on <host>" in a remote window, empty locally. */
    where: string;
    remote: boolean;
    report: UsageReport | undefined;
    /** A model id's label, from the registry by exact id; the id itself when unknown. */
    modelLabel(id: string): string;
    /** Each root considered, as shown: `~`-relative, with what chose it in words. */
    roots: { path: string; source: string; exists: boolean; notAbsolute?: true }[];
    /** Claude Code's configuration files the account names are read from, as shown: `~`-relative. */
    accountFiles: string[];
    historyDisabled: boolean;
    lastImport: LastImport | undefined;
    sqliteRuntime: { node: string; electron: string | null } | undefined;
    /** The file a corrupt history was moved to, when this window moved one. */
    recoveredFrom: string | undefined;
    extensionVersion: string;
    /** When the panel last refreshed, epoch ms. */
    refreshedAt: number | undefined;
    /** Formats epoch ms as a local date and time, in the page's zone. */
    formatTime(epochMs: number): string;
    /** Formats epoch ms as a local date, in the page's zone. */
    formatDate(epochMs: number): string;
}

export interface LastImport {
    files: number;
    read: number;
    skipped: Record<string, number>;
    malformed: Record<string, number>;
    oversizeLines: number;
    synthetic: number;
    apiErrors: number;
    symlinkedFolders: number;
    unreadableFolders: number;
    elapsedMs: number;
}

/**
 * The range, scope and account as chosen, and what the account filter
 * offers: what the page brings its controls up to date from, in place.
 */
export interface Choices {
    range: RangeKey;
    scope: 'all' | 'workspace';
    /** The text of the button for everything held: `Since` and the day the history starts. */
    since: string;
    /** The account filter, where the page shows one. */
    account: { value: string; options: { value: string; label: string; disabled?: true }[] } | null;
}

/** What one post carries: the fragments, and the rows the page's exports are built from. */
export interface PanelFragments {
    /**
     * The range, scope and account, as the page first shows them; after
     * that, `choices` brings them up to date in place, so that a control in
     * use is never rebuilt under it. Rebuilt from this only when the account
     * filter comes or goes.
     */
    controls: string;
    choices: Choices | null;
    /** Refresh and when the page was refreshed: changed whenever a pass reads or ends. */
    status: string;
    body: string;
    diagnostics: string;
    /** Every input of a hand-made cost calculation, by day and model; never a price. */
    csv: { header: string[]; rows: string[][]; notes: string[] };
    /** The sessions table as shown, for Copy. */
    copy: { header: string[]; rows: string[][]; notes: string[] };
}

const RANGE_LABELS: Record<RangeKey, string> = { today: 'Today', '7d': '7 days', '30d': '30 days', coverage: 'Since' };

const KIND_LABELS: Record<string, string> = {
    main: 'Main conversation',
    task: 'Task subagents',
    workflow: 'Workflow agents',
    other: 'Other transcripts',
};

/** The empty states, each saying why, and what would change it. */
function emptyState(view: PanelView): string | undefined {
    switch (view.status) {
        case 'off':
            // The page the editor title's T opens for anyone with Claude
            // Code's extension: what turning it on reads and keeps, listed
            // as the README lists it, and nothing read until Turn On.
            return `
            <section class="empty-state">
                <h2>Claude Code usage is off</h2>
                <p>Turned on, LLM Tokenizer reads Claude Code's own session records ${view.where ? escapeHtml(view.where) : 'on this machine'},
                in the projects folder of its configuration folder (<code>~/.claude</code> by default), and shows how many tokens Claude Code processed: by day, account, project, session and model.
                From Claude Code's configuration file (<code>~/.claude.json</code> by default, or <code>.claude.json</code> in its configuration folder, or <code>.config.json</code> there, the name older versions gave it) it reads only the Claude accounts it names.</p>
                <p>Kept, in a database in this extension's own storage:</p>
                <ul>
                    <li>each request's token counts, model, effort, speed, where it ran, time and Claude Code version, and its ids: message, request, session, and the subagent or workflow run it came from;</li>
                    <li>the folder each session started in;</li>
                    <li>the Claude account and organization each request was made with, by id, and where each session's changed in its transcript; for each account its number in the history, and the email and organization name Claude Code last gave it, with when;</li>
                    <li>each transcript's path, size, file id and how far it was read, with a hash of the last 64 bytes read, to tell what changed;</li>
                    <li>compactions' sizes, and the usage limits reached, with when they reset and the account that reached each, by id;</li>
                    <li>the window's process id and this machine's name, which each import writes so that two windows never import at once.</li>
                </ul>
                <p>Never kept: prompts, responses, thinking, tool inputs or results. Nothing is sent anywhere. The history outlives Claude Code's own records, which it deletes after 30 days by default; Clear Claude Code Usage History removes it.</p>
                <p class="actions"><button type="button" class="primary" data-action="turnOn">Turn On</button><button type="button" data-action="openSettings">Open Settings</button>${
                    view.remote ? '<span class="muted">The setting is in Remote settings, for this host, and Turn On sets it there.</span>' : ''
                }</p>
            </section>`;
        case 'no-roots':
            // With a history kept, the history is shown, under a banner.
            if (view.report && view.report.coverage.requests > 0) {
                return undefined;
            }
            return `
            <section class="empty-state">
                <h2>No Claude Code data folder found</h2>
                <p>None of these exist:</p>
                ${rootList(view)}
                <p><button type="button" data-action="chooseFolder">Choose Folder…</button></p>
            </section>`;
        case 'no-sqlite':
            return `
            <section class="empty-state">
                <h2>This editor cannot keep a usage history</h2>
                <p>Its runtime has no <code>node:sqlite</code>${
                    view.sqliteRuntime
                        ? ` (Node ${escapeHtml(view.sqliteRuntime.node)}${view.sqliteRuntime.electron ? `, Electron ${escapeHtml(view.sqliteRuntime.electron)}` : ''})`
                        : ''
                }. It needs Node 22.13 or later, which VS Code has from 1.105.</p>
            </section>`;
        default:
            return undefined;
    }
}

function rootList(view: PanelView): string {
    return `<ul class="plain-list">${view.roots
        .map(
            r =>
                `<li><span class="path">${escapeHtml(r.path)}</span><span class="reason">${escapeHtml(r.source)}${r.notAbsolute ? ', not an absolute path' : r.exists ? '' : ', not found'}</span></li>`,
        )
        .join('')}</ul>`;
}

function banner(view: PanelView): string {
    const lines: string[] = [];
    if (view.recoveredFrom) {
        lines.push(
            `The history could not be read, so it was set aside as ${escapeHtml(view.recoveredFrom)}, and a new one started from what Claude Code still keeps.`,
        );
    }
    if (view.status === 'no-roots') {
        lines.push(
            "No Claude Code data folder is found now, so this is the history kept so far. <button type=\"button\" data-action=\"chooseFolder\">Choose Folder…</button>",
        );
    }
    if (view.status === 'read-only') {
        // Another window runs the newer version, or ran it: installed, it
        // only waits for this window to reload.
        lines.push(
            'This history was written by a newer version of LLM Tokenizer, so this window shows it without updating it. Reload the window to run that version here, or update LLM Tokenizer if it is not installed. <button type="button" data-action="reloadWindow">Reload Window</button>',
        );
    }
    if (view.status === 'failing') {
        lines.push('The history could not be read or updated just now; what is shown may be out of date. <button type="button" data-action="showLog">Show Log</button>');
    }
    if (view.historyDisabled) {
        lines.push('CLAUDE_CODE_SKIP_PROMPT_HISTORY is set, so Claude Code keeps no transcripts, and nothing new can be read.');
    }
    // Not a warning: what is shown is right, only not complete yet.
    const reading = view.reading ? `<p class="banner reading">${escapeHtml(readingLine(view.reading))}</p>` : '';
    return reading + lines.map(line => `<p class="banner">${line}</p>`).join('');
}

/** What the page says while the history is read, with how far this window's pass has gone where the worker said. */
function readingLine(reading: Reading): string {
    if (reading.by === 'another window') {
        return "Another window is reading Claude Code's records; these totals grow as it goes.";
    }
    const count = (n: number) => n.toLocaleString('en-US');
    const sofar =
        reading.files === undefined
            ? ''
            : reading.of === undefined
              ? `: ${count(reading.files)} files so far`
              : `: ${count(reading.files)} of ${count(reading.of)} files`;
    return `Still reading Claude Code's records${sofar}. These totals grow until it is done.`;
}

/** A total's mark: `≥` while the history is still being read, or when some request did not report every counter. */
function mark(view: PanelView, provenance: UsageTotals['provenance']): '' | '≥' {
    return view.reading ? '≥' : totalPrefix(provenance);
}

/** The range and scope chosen, the account, and what the filter offers. */
function choicesOf(view: PanelView): Choices {
    const report = view.report;
    return {
        range: view.range,
        scope: view.scope,
        since: `${RANGE_LABELS.coverage}${report?.coverage.start != null ? ` ${view.formatDate(report.coverage.start)}` : ''}`,
        account: accountFilter(view),
    };
}

/** The range and scope buttons, and the account filter. */
function controls(choices: Choices): string {
    const range = (key: RangeKey) =>
        `<button type="button" data-range="${key}" aria-pressed="${choices.range === key}">${escapeHtml(key === 'coverage' ? choices.since : RANGE_LABELS[key])}</button>`;
    const scope = (key: 'all' | 'workspace', label: string) =>
        `<button type="button" data-scope="${key}" aria-pressed="${choices.scope === key}">${label}</button>`;
    const filter = choices.account
        ? `<select class="account-filter" data-account-filter aria-label="Account">${choices.account.options
              .map(
                  o =>
                      `<option value="${escapeHtml(o.value)}"${o.value === choices.account?.value && !o.disabled ? ' selected' : ''}${o.disabled ? ' disabled' : ''}>${escapeHtml(o.label)}</option>`,
              )
              .join('')}</select>`
        : '';
    return `
        <div class="segmented" role="group" aria-label="Range">${(['today', '7d', '30d', 'coverage'] as const).map(range).join('')}</div>
        <div class="segmented" role="group" aria-label="Scope">${scope('all', 'All projects')}${scope('workspace', 'This workspace')}</div>
        ${filter}`;
}

/** Refresh, and the line that says when the page was refreshed and how new its newest record is. */
function status(view: PanelView): string {
    const report = view.report;
    const newest = report?.coverage.newest != null ? `newest record ${escapeHtml(view.formatTime(report.coverage.newest))}` : '';
    const refreshed = view.refreshedAt !== undefined ? `refreshed ${escapeHtml(view.formatTime(view.refreshedAt))}` : '';
    // Busy while a pass reads, rather than a click that seems to do nothing:
    // Refresh would only wait for it. Still focusable, so focus stays put.
    const refresh = view.reading
        ? '<button type="button" data-action="refresh" aria-disabled="true">Reading…</button>'
        : '<button type="button" data-action="refresh">Refresh</button>';
    return `
        ${refresh}
        <span class="muted">${[refreshed, newest].filter(Boolean).join(' · ')}${view.where ? ` · ${escapeHtml(view.where)}` : ''}</span>`;
}

/** Whether the history has seen any account: until it has, nothing on the page speaks of them. */
function hasAccounts(report: UsageReport | undefined): report is UsageReport {
    return report !== undefined && report.accountsSeen.some(a => a.owner !== null);
}

/** Every account's label, by key: see accounts.ts. */
function labelsOf(view: PanelView): Map<string, AccountLabel> {
    return view.report ? accountLabels(view.report.accountsSeen, view.report.accountNames, view.givenNames) : new Map<string, AccountLabel>();
}

/** A key's label; one past the lists' caps, or no longer in the history, by the first digits of its account's id. */
function labelOf(labels: Map<string, AccountLabel>, key: string): string {
    return labels.get(key)?.label ?? (key === NOT_RECORDED ? 'Not recorded' : `Account ${key.slice(0, 8)}`);
}

/**
 * The account filter, once the history has seen two: every account by its
 * number, and the sessions that record none. One chosen that the history no
 * longer holds, after a Clear, is still offered while it is.
 */
function accountFilter(view: PanelView): Choices['account'] {
    const report = view.report;
    if (!hasAccounts(report) || (report.accountsSeen.length < 2 && view.account === ALL_ACCOUNTS)) {
        return null;
    }
    const labels = labelsOf(view);
    const keys = report.accountsSeen.map(a => a.key);
    if (view.account !== ALL_ACCOUNTS && !keys.includes(view.account)) {
        keys.push(view.account);
    }
    const more = report.omitted.accountsSeen;
    return {
        value: view.account,
        options: [
            { value: ALL_ACCOUNTS, label: 'All accounts' },
            ...keys.map(key => ({ value: key, label: labelOf(labels, key) })),
            ...(more > 0 ? [{ value: '', label: `…and ${more.toLocaleString('en-US')} more, with fewer sessions`, disabled: true as const }] : []),
        ],
    };
}

/**
 * `share` as a percent with `decimals` places, cut, never rounded up, as
 * every share on this page is written: 99.6% is not all of it, and the
 * total's line once said 95% of the cache reads its bar beside it called 96%.
 * The nudge keeps a share a float puts a hair under its figure, as 0.29 is,
 * on that figure.
 */
function cut(share: number, decimals: number): string {
    const scale = 10 ** decimals;
    return `${(Math.floor(share * 100 * scale + 1e-9) / scale).toFixed(decimals)}%`;
}

/** A share on a bar, or in a line of text: whole percent from 10%, one decimal below. */
export function cutPercent(share: number): string {
    return cut(share, share >= 0.1 ? 0 : 1);
}

function categoryBars(t: UsageTotals): string {
    const rows: [string, number][] = [
        ['Cache read', t.cacheRead],
        ['Cache write', t.cacheCreation],
        ['Input', t.input],
        ['Output', t.output],
    ];
    return rankedBars(ranked(rows, t.processed), cutPercent);
}

function ranked(rows: [string, number][], total: number): RankedValue[] {
    return rows.map(([label, tokens]) => ({ label, tokens, share: total > 0 ? tokens / total : 0 }));
}

/** The most days drawn as columns: past it, the newest are drawn, and the note says so. */
const MAX_DAY_COLUMNS = 400;

/** One column per day of the range, empty days included, so a gap reads as a gap. */
function dayColumns(report: UsageReport, view: PanelView): string {
    const days = report.days;
    if (days.length === 0) {
        return '';
    }
    const from = report.from ?? days[0].date;
    // Up to the range's last day, today, whatever a record dated later says.
    const last = report.to;
    const byDate = new Map(days.map(d => [d.date, d.totals]));
    // The newest days, counted back from the last one, not on from the first.
    const all: string[] = [];
    for (let d = last; d >= from && all.length < MAX_DAY_COLUMNS; d = previousDay(d)) {
        all.unshift(d);
    }
    if (all.length === 0) {
        return '';
    }
    const hidden = days.filter(d => d.date < all[0]).length;
    const later = days.filter(d => d.date > last).length;
    let tallest = 0;
    for (const date of all) {
        tallest = Math.max(tallest, byDate.get(date)?.processed ?? 0);
    }
    return `
    <div class="columns" role="list">${all
        .map(date => {
            const t = byDate.get(date);
            const value = t?.processed ?? 0;
            const height = tallest > 0 ? (value / tallest) * 100 : 0;
            const label = `${date}: ${mark(view, t?.provenance ?? 'reported')}${value.toLocaleString('en-US')} processed`;
            return `<div class="column" role="listitem" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}"><div class="column-bar" style="height: ${height.toFixed(2)}%"></div></div>`;
        })
        .join('')}</div>
    <div class="columns-axis"><span>${escapeHtml(all[0])}</span><span>${escapeHtml(all[all.length - 1])}</span></div>
    <p class="note">Days in ${escapeHtml(view.zone)}.${
        hidden > 0 ? ` The newest ${MAX_DAY_COLUMNS} are drawn; ${hidden.toLocaleString('en-US')} earlier days with requests are in the totals.` : ''
    }${
        later === 1
            ? ' A later day, from a clock ahead of this one, is in the totals.'
            : later > 1
              ? ` ${later.toLocaleString('en-US')} later days, from a clock ahead of this one, are in the totals.`
              : ''
    }</p>`;
}

function previousDay(date: string): string {
    const [y, m, d] = date.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

function modelName(view: PanelView, model: string, variant: string | null): string {
    return `${view.modelLabel(model)}${variant ? ` (${variant})` : ''}`;
}

/**
 * How much of the total is cache reads, beside it: the conversation each
 * request sends again, which is why one prompt making dozens of calls on a
 * large context processes tens of millions. As the Cache read bar below it
 * writes it (see cutPercent).
 */
function cacheReadPart(t: UsageTotals): string {
    if (t.processed <= 0 || t.cacheRead <= 0) {
        return '';
    }
    const share = t.cacheRead / t.processed;
    return ` · ${share < 0.01 ? 'under 1%' : cutPercent(share)} cache reads, the conversation each request sends again`;
}

function overview(report: UsageReport, view: PanelView): string {
    const t = report.totals;
    const prefix = mark(view, t.provenance);
    const sessions = report.sessions.length + report.omitted.sessions;
    // The cache reads' share is the total's line's: a second one here, of
    // input alone, read as the same figure, rounded otherwise.
    const notes = [
        t.output > 0 && t.thinking > 0 ? `${cutPercent(t.thinking / t.output)} of output was thinking` : '',
        t.cacheWrite5m + t.cacheWrite1h > 0 ? `cache writes ${formatNumber(t.cacheWrite5m)} for 5 minutes, ${formatNumber(t.cacheWrite1h)} for 1 hour` : '',
    ].filter(Boolean);
    return `
    <header>
        <div class="hero-value">${prefix}${formatNumber(t.processed)}</div>
        <div class="hero-meta">tokens processed${cacheReadPart(t)} · ${t.coverage.requests.toLocaleString('en-US')} requests · ${sessions.toLocaleString('en-US')} sessions</div>
        ${
            t.provenance === 'partial'
                ? `<p class="note">≥: ${t.coverage.incompleteRequests.toLocaleString('en-US')} requests did not report every counter, so this is a lower bound.</p>`
                : ''
        }
    </header>
    <section class="panel">
        <h2>What was processed</h2>
        ${categoryBars(t)}
        ${notes.length > 0 ? `<p class="note">${notes.join(' · ')}</p>` : ''}
    </section>
    <section class="panel"><h2>By day</h2>${dayColumns(report, view)}</section>
    <section class="panel">
        <h2>By model</h2>
        ${rankedBars(report.models.map(m => ({ label: modelName(view, m.model, m.variant), tokens: m.totals.processed, share: share0(m.totals, t) })), cutPercent)}
        ${capNote(report.omitted.models, 'models')}
    </section>
    <section class="panel">
        <h2>Delegated work</h2>
        ${rankedBars(report.kinds.map(k => ({ label: KIND_LABELS[k.kind] ?? k.kind, tokens: k.totals.processed, share: share0(k.totals, t) })), cutPercent)}
    </section>
    ${
        report.efforts.length > 1 || report.efforts[0]?.effort
            ? `<section class="panel"><h2>By effort</h2>${rankedBars(
                  report.efforts.map(e => ({ label: e.effort ?? 'not recorded', tokens: e.totals.processed, share: share0(e.totals, t) })),
                  cutPercent,
              )}${capNote(report.omitted.efforts, 'effort levels')}</section>`
            : ''
    }
    ${limitWindows(report, view)}`;
}

function share0(part: UsageTotals, whole: UsageTotals): number {
    return whole.processed > 0 ? part.processed / whole.processed : 0;
}

/**
 * Rows a page of a list holds. A longer list pages sideways: its pages side
 * by side in a strip that scrolls a page at a time, by a swipe or by its
 * pager's buttons, so that 200 sessions take the room of ten.
 */
export const PAGE_ROWS = 10;

/** `items` dealt out `PAGE_ROWS` at a time; one empty page for none. */
function pagesOf<T>(items: T[]): T[][] {
    const pages: T[][] = [];
    for (let i = 0; i < items.length; i += PAGE_ROWS) {
        pages.push(items.slice(i, i + PAGE_ROWS));
    }
    return pages.length > 0 ? pages : [[]];
}

/**
 * A section's heading, with its pager when its list runs to more than one
 * page. The page's script keeps the pager's line and buttons with the page in
 * view; as rendered, the first is.
 */
function sectionHead(title: string, id: string, rows: number): string {
    const pager =
        rows > PAGE_ROWS
            ? `<nav class="pager" data-pages="${id}" aria-label="${escapeHtml(title)}, by page">` +
              '<button type="button" data-page="previous" aria-label="Previous page" title="Previous page" aria-disabled="true">‹</button>' +
              `<output aria-live="polite">1–${PAGE_ROWS} of ${rows.toLocaleString('en-US')}</output>` +
              '<button type="button" data-page="next" aria-label="Next page" title="Next page">›</button></nav>'
            : '';
    return `<div class="section-head"><h2>${escapeHtml(title)}</h2>${pager}</div>`;
}

/**
 * The strip a list's pages sit in. Every one of them is in the document, so
 * a sort orders every row, not one page's; only the page in view can be
 * reached, the others are inert until the strip comes to rest on one.
 */
function strip(id: string, title: string, rows: number, pages: string[], attributes = ''): string {
    return `<div class="pages" id="${id}" role="region" aria-label="${escapeHtml(title)}" data-rows="${rows}" data-page-rows="${PAGE_ROWS}"${attributes}>${pages.join('')}</div>`;
}

function limitWindows(report: UsageReport, view: PanelView): string {
    if (report.limitWindows.length === 0) {
        return '';
    }
    // Newest first: the page in view on opening is the latest limits.
    const windows = [...report.limitWindows].reverse();
    // A limit is an account's: where the page holds more than one account's
    // sessions, each says whose, though one account alone hit any.
    const labels = labelsOf(view);
    const whose = new Set(windows.map(w => w.account)).size > 1 || (view.account === ALL_ACCOUNTS && report.accountsSeen.length > 1);
    const pages = pagesOf(windows).map(
        (page, i) =>
            `<ul class="page plain-list"${i > 0 ? ' inert' : ''}>${page
                .map(
                    w =>
                        `<li><span>${whose ? `${escapeHtml(labelOf(labels, w.account))}: ` : ''}${escapeHtml(w.limitType.replace(/_/g, ' '))} limit, ${w.hits.toLocaleString('en-US')} ${
                            w.hits === 1 ? 'request' : 'requests'
                        } refused from ${escapeHtml(view.formatTime(w.firstTs))}</span><span class="reason">${
                            w.resetsAt !== null ? `reset ${escapeHtml(view.formatTime(w.resetsAt * 1000))}` : ''
                        }</span></li>`,
                )
                .join('')}</ul>`,
    );
    return `
    <section class="panel">
        ${sectionHead('Usage limits reached', 'limits', windows.length)}
        ${strip('limits', 'Usage limits reached', windows.length, pages)}
        ${report.omitted.limitWindows > 0 ? `<p class="truncation">…and ${report.omitted.limitWindows.toLocaleString('en-US')} earlier ones, not listed.</p>` : ''}
        <p class="note">${whose ? 'Each for its whole account' : 'For the whole account'}, whichever project hit them, newest first.</p>
    </section>`;
}

interface Column {
    key: string;
    label: string;
    numeric?: boolean;
    /** Its share of the width, alike on every page, so that a column does not move as the pages go by. */
    width?: string;
}

/**
 * A sortable table, a page of it per `PAGE_ROWS` rows. Each row carries its
 * sort keys, so the page can keep the sort across updates, and each page its
 * own header, which sorts them all.
 */
function table(
    id: string,
    title: string,
    columns: Column[],
    rows: { keys: Record<string, string | number>; cells: string[] }[],
    initial: string,
): string {
    const head = `<colgroup>${columns.map(c => (c.width ? `<col style="width: ${c.width}">` : '<col>')).join('')}</colgroup>
        <thead><tr>${columns
            .map(
                c =>
                    `<th${c.numeric ? ' class="num"' : ''} aria-sort="${c.key === initial ? 'descending' : 'none'}"><button type="button" data-sort-key="${c.key}">${escapeHtml(c.label)}</button></th>`,
            )
            .join('')}</tr></thead>`;
    const pages = pagesOf(rows).map(
        (page, i) => `<table class="page"${i > 0 ? ' inert' : ''}>${head}
        <tbody>${page
            .map(
                r =>
                    `<tr ${Object.entries(r.keys)
                        .map(([k, v]) => `data-k-${k}="${escapeHtml(String(v))}"`)
                        .join(' ')}>${r.cells
                        .map((cell, c) => `<td${columns[c]?.numeric ? ' class="num"' : columns[c]?.key === 'label' ? ' class="label"' : ''}>${cell}</td>`)
                        .join('')}</tr>`,
            )
            .join('')}</tbody></table>`,
    );
    return `${sectionHead(title, id, rows.length)}
        ${strip(id, title, rows.length, pages, ` data-sort="${initial}" data-ascending="false"`)}`;
}

/**
 * The accounts the range's tokens went through, with what tells each apart:
 * its name, when it was used, and in which projects. Shown once the history
 * has seen an account, and while every account is: one chosen is the whole
 * page.
 */
function accounts(report: UsageReport, view: PanelView): string {
    if (view.account !== ALL_ACCOUNTS || !report.accounts.some(a => a.owner !== null)) {
        return '';
    }
    const total = report.totals.processed;
    const labels = labelsOf(view);
    const seen = new Map(report.accountsSeen.map(a => [a.key, a]));
    const current = new Set(report.currentAccounts);
    const unrecorded = report.accounts.some(a => a.owner === null);
    return `
    <section class="panel">
        ${table(
            'accounts',
            'Accounts',
            [
                { key: 'label', label: 'Account' },
                { key: 'sessions', label: 'Sessions', numeric: true, width: '14%' },
                { key: 'processed', label: 'Processed', numeric: true, width: '22%' },
                { key: 'share', label: 'Share', numeric: true, width: '12%' },
            ],
            report.accounts.map(a => {
                const label = labels.get(a.key);
                const used = seen.get(a.key);
                return {
                    keys: { label: labelOf(labels, a.key), sessions: a.sessions, processed: a.totals.processed, share: a.totals.processed },
                    cells: [
                        accountCell(view, a, label, used?.firstTs ?? null, used?.lastTs ?? null, current.has(a.key)),
                        a.sessions.toLocaleString('en-US'),
                        processedCell(view, a.totals, a.models),
                        total > 0 ? cut(a.totals.processed / total, 1) : '—',
                    ],
                };
            }),
            'processed',
        )}
        ${capNote(report.omitted.accounts, 'accounts')}
        <p class="note">An account is the Claude account and organization a request was made with, as its session's transcript records it, its subagents' included: a session resumed under another account counts under each for its own requests, and one from before Claude Code recorded accounts under the first it records. Its name is the one Claude Code gave it while this history was kept, or the one you give it.${
            unrecorded
                ? ' Not recorded: sessions whose transcripts record no account, as those Claude Code wrote before it recorded accounts, from version 2.1.318 or so, in October 2026, those signed in with an API key or through a cloud provider, and those Claude Code had deleted before this version first read them.'
                : ''
        }</p>
    </section>`;
}

/**
 * An account's cell: its label, whether Claude Code is signed in to it now,
 * a button to name it, and, below, when it was used and in which projects,
 * which tell apart an account with no name. Every id and date on hover.
 */
function accountCell(view: PanelView, row: AccountRow, label: AccountLabel | undefined, firstTs: number | null, lastTs: number | null, current: boolean): string {
    const name = label?.label ?? (row.owner ? `Account ${row.key.slice(0, 8)}` : 'Not recorded');
    const span = firstTs !== null && lastTs !== null ? `${view.formatDate(firstTs)} – ${view.formatDate(lastTs)}` : '';
    const hint = [span, row.projects.join(', ')].filter(Boolean).join(' · ');
    const title = row.owner
        ? [
              name,
              label?.named && label.claudeName ? `Claude Code calls it ${label.claudeName}` : '',
              current ? 'Claude Code is signed in to it now' : '',
              `Account ${row.owner.accountUuid}`,
              row.owner.organizationUuid ? `Organization ${row.owner.organizationUuid}` : 'No organization',
              firstTs !== null && lastTs !== null ? `Requests from ${view.formatTime(firstTs)} to ${view.formatTime(lastTs)}` : '',
              row.projects.length > 0 ? `In ${row.projects.join(', ')}` : '',
          ]
        : [
              'Sessions whose transcripts record no account',
              firstTs !== null && lastTs !== null ? `Requests from ${view.formatTime(firstTs)} to ${view.formatTime(lastTs)}` : '',
              row.projects.length > 0 ? `In ${row.projects.join(', ')}` : '',
          ];
    // Its account's id names it in the setting; its key finds the button
    // again after an update, as one account's organizations share the id.
    const verb = label?.named ? 'Rename' : 'Name';
    const button = row.owner
        ? `<button type="button" class="name" data-action="nameAccount" data-account="${escapeHtml(row.owner.accountUuid)}" data-key="${escapeHtml(
              row.key,
          )}" aria-label="${escapeHtml(`${verb} ${name}`)}" title="${verb} this account in this panel">${verb}…</button>`
        : '';
    return `<div class="account-line"><span class="account-name" title="${escapeHtml(title.filter(Boolean).join('\n'))}">${escapeHtml(name)}</span>${
        current ? '<span class="badge">signed in now</span>' : ''
    }${button}</div><div class="account-hint">${escapeHtml(hint)}</div>`;
}

function projects(report: UsageReport, view: PanelView): string {
    const total = report.totals.processed;
    return `
    <section class="panel">
        ${table(
            'projects',
            'Projects',
            [
                { key: 'label', label: 'Project' },
                { key: 'sessions', label: 'Sessions', numeric: true, width: '16%' },
                { key: 'processed', label: 'Processed', numeric: true, width: '22%' },
                { key: 'share', label: 'Share', numeric: true, width: '14%' },
            ],
            report.projects.map(p => ({
                keys: { label: p.label, sessions: p.sessions, processed: p.totals.processed, share: p.totals.processed },
                cells: [
                    `<span title="${escapeHtml(p.project.kind === 'root' ? p.project.path : p.project.projectDir)}">${escapeHtml(p.label)}</span>`,
                    p.sessions.toLocaleString('en-US'),
                    processedCell(view, p.totals, p.models),
                    total > 0 ? cut(p.totals.processed / total, 1) : '—',
                ],
            })),
            'processed',
        )}
        ${capNote(report.omitted.projects, 'projects')}
    </section>`;
}

function sessions(report: UsageReport, view: PanelView): string {
    const labels = hasAccounts(report) ? labelsOf(view) : undefined;
    return `
    <section class="panel">
        ${table(
            'sessions',
            'Sessions',
            [
                { key: 'started', label: 'Started', width: '22%' },
                { key: 'label', label: 'Project' },
                { key: 'active', label: 'Active', numeric: true, width: '13%' },
                { key: 'requests', label: 'Requests', numeric: true, width: '12%' },
                { key: 'processed', label: 'Processed', numeric: true, width: '17%' },
                { key: 'compactions', label: 'Compactions', numeric: true, width: '14%' },
            ],
            report.sessions.map(s => {
                const compactions = s.compactions
                    .map(c => `${c.preTokens?.toLocaleString('en-US') ?? '?'} → ${c.postTokens?.toLocaleString('en-US') ?? '?'}`)
                    .join(', ');
                const between =
                    s.firstTs !== null && s.lastTs !== null ? `Requests from ${view.formatTime(s.firstTs)} to ${view.formatTime(s.lastTs)}` : '';
                return {
                    keys: {
                        started: s.firstTs ?? 0,
                        label: s.label,
                        active: s.activeMs,
                        requests: s.totals.coverage.requests,
                        processed: s.totals.processed,
                        compactions: s.compactions.length,
                    },
                    cells: [
                        `<span title="${escapeHtml(`Session ${s.sessionId}${labels ? `\n${accountsLine(labels, s.accounts, s.moreAccounts)}` : ''}`)}">${escapeHtml(
                            s.firstTs !== null ? view.formatTime(s.firstTs) : '—',
                        )}</span>`,
                        `<span title="${escapeHtml(s.label)}">${escapeHtml(s.label)}</span>`,
                        between ? `<span title="${escapeHtml(between)}">${formatActive(s.activeMs)}</span>` : formatActive(s.activeMs),
                        s.totals.coverage.requests.toLocaleString('en-US'),
                        processedCell(view, s.totals, s.models),
                        s.compactions.length > 0 ? `<span title="${escapeHtml(compactions)}">${s.compactions.length}</span>` : '0',
                    ],
                };
            }),
            'processed',
        )}
        ${capNote(report.omitted.sessions, 'sessions')}
        <p class="note">Active is a session's time between requests in this range, its subagents' included, leaving out every pause of over ${
            ACTIVE_PAUSE_MS / 60_000
        } minutes: Claude and its tools at work, and your replies within that.</p>
    </section>`;
}

/** The accounts a session's requests were made with, as its hover says: one resumed under another names both, the first used first. */
function accountsLine(labels: Map<string, AccountLabel>, keys: string[], more: number): string {
    const named = keys.map(key => labelOf(labels, key)).join(', then ');
    return `${keys.length + more > 1 ? 'Accounts' : 'Account'}: ${named}${more > 0 ? `, and ${more.toLocaleString('en-US')} more` : ''}`;
}

/** The most models a row's Processed cell names on hover; the rest are counted. */
const MAX_MODELS_NAMED = 8;

/**
 * A row's tokens processed, with the models they went through, and each
 * one's share, on hover: what a session or a project was made of, without a
 * column for it.
 */
function processedCell(view: PanelView, totals: UsageTotals, models: ModelRow[]): string {
    const figure = `${mark(view, totals.provenance)}${totals.processed.toLocaleString('en-US')}`;
    if (models.length === 0 || totals.processed <= 0) {
        return figure;
    }
    const named = models
        .slice(0, MAX_MODELS_NAMED)
        .map(m => `${modelName(view, m.model, m.variant)} ${cutPercent(m.totals.processed / totals.processed)}`);
    const rest = models.length - named.length;
    const title = `${named.join(', ')}${rest > 0 ? `, and ${rest.toLocaleString('en-US')} more` : ''}`;
    return `<span title="${escapeHtml(title)}">${figure}</span>`;
}

/** An active time as its cell shows it, in HTML: minutes, and hours past 60; under a minute is said so, not rounded to none. */
export function formatActive(ms: number): string {
    if (ms < 60_000) {
        return '&lt; 1 min';
    }
    const minutes = Math.round(ms / 60_000);
    return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function capNote(omitted: number, what: string): string {
    return omitted > 0
        ? `<p class="truncation">…and ${omitted.toLocaleString('en-US')} smaller ${what}, counted in the totals but not listed.</p>`
        : '';
}

function diagnostics(view: PanelView): string {
    const report = view.report;
    const imported = view.lastImport;
    const counts = (record: Record<string, number>) =>
        Object.entries(record)
            .filter(([, n]) => n > 0)
            .map(([k, n]) => `${escapeHtml(k)} ${n.toLocaleString('en-US')}`)
            .join(', ') || 'none';
    const rows: [string, string][] = [];
    if (report) {
        rows.push([
            'History',
            `${report.coverage.requests.toLocaleString('en-US')} requests from ${report.coverage.files.toLocaleString('en-US')} files${
                report.coverage.start !== null ? `, since ${escapeHtml(view.formatTime(report.coverage.start))}` : ''
            }`,
        ]);
        if (report.coverage.ahead > 0) {
            const n = report.coverage.ahead;
            rows.push([
                'Dated ahead',
                `${n.toLocaleString('en-US')} ${n === 1 ? 'request' : 'requests'} dated more than a day after this machine's clock, kept and counted once it reaches ${n === 1 ? 'it' : 'them'}`,
            ]);
        }
        if (report.coverage.oversizeLines + report.coverage.malformedLines > 0) {
            rows.push([
                'Lines not read',
                `${report.coverage.malformedLines.toLocaleString('en-US')} malformed, ${report.coverage.oversizeLines.toLocaleString('en-US')} too long to read`,
            ]);
        }
    }
    if (imported) {
        rows.push([
            'Last import',
            `${imported.read.toLocaleString('en-US')} of ${imported.files.toLocaleString('en-US')} files read, in ${imported.elapsedMs.toLocaleString('en-US')} ms`,
        ]);
        rows.push(['Skipped files', counts(imported.skipped)]);
        rows.push(['Malformed lines', counts(imported.malformed)]);
        rows.push([
            'Not counted',
            `${imported.synthetic.toLocaleString('en-US')} refused-request placeholders, ${imported.apiErrors.toLocaleString('en-US')} API errors`,
        ]);
        if (imported.symlinkedFolders + imported.unreadableFolders > 0) {
            rows.push([
                'Folders not entered',
                `${imported.symlinkedFolders.toLocaleString('en-US')} symlinked, ${imported.unreadableFolders.toLocaleString('en-US')} unreadable`,
            ]);
        }
    }
    if (view.recoveredFrom) {
        rows.push(['Set aside', escapeHtml(view.recoveredFrom)]);
    }
    rows.push([
        'Account names',
        view.accountFiles.length > 0
            ? `from ${view.accountFiles.map(f => `<span class="path">${escapeHtml(f)}</span>`).join(', ')}`
            : "no Claude Code configuration file found",
    ]);
    rows.push(['Time zone', escapeHtml(view.zone)]);
    return `
    <details class="panel" id="diagnostics">
        <summary><h2>Diagnostics</h2></summary>
        <dl class="facts">${rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${v}</dd>`).join('')}</dl>
        <h3>Where Claude Code's records are read from</h3>
        ${rootList(view)}
        <p class="note">Claude Code deletes its records after <code>cleanupPeriodDays</code> (30 by default), so an import catches up only on what is still on disk. Their format is internal to Claude Code, and may change with it.</p>
        <p class="actions">
            <button type="button" data-action="copy">Copy Sessions</button>
            <button type="button" data-action="export">Export CSV</button>
            <button type="button" data-action="clear">Clear History…</button>
            <button type="button" data-action="showLog">Show Log</button>
        </p>
    </details>`;
}

/** The fragments for one post. */
export function renderFragments(view: PanelView): PanelFragments {
    const empty = emptyState(view);
    const report = view.report;
    const body =
        empty ??
        (report
            ? report.totals.coverage.requests === 0
                ? `${banner(view)}<section class="empty-state"><h2>Nothing in this range</h2><p>${
                      report.coverage.requests === 0
                          ? 'No Claude Code requests have been read yet.'
                          : view.reading
                            ? // A range the reading has not reached yet is not one without requests.
                              'Nothing has been read in this range yet.'
                            : view.account !== ALL_ACCOUNTS
                              ? `${
                                    view.account === NOT_RECORDED
                                        ? 'No request of a session that records no account'
                                        : `No request made with ${escapeHtml(labelOf(labelsOf(view), view.account))}`
                                } falls in this range${view.scope === 'workspace' ? ' in a folder of this workspace' : ''}.`
                              : view.scope === 'workspace'
                                ? 'No session in this range started in a folder of this workspace.'
                                : 'No requests fall in this range.'
                  }</p></section>`
                : `${banner(view)}${overview(report, view)}${accounts(report, view)}${projects(report, view)}${sessions(report, view)}`
            : `${banner(view)}<p class="muted">Reading Claude Code's records…</p>`);
    const choices = empty ? null : choicesOf(view);
    return {
        controls: choices ? controls(choices) : '',
        choices,
        status: empty ? '' : status(view),
        body,
        diagnostics: empty && view.status === 'off' ? '' : diagnostics(view),
        csv: csvRows(view),
        copy: copyRows(view),
    };
}

function csvRows(view: PanelView): PanelFragments['csv'] {
    const report = view.report;
    const header = [
        'date',
        'model',
        'variant',
        'speed',
        'inference_geo',
        'prompt_size',
        'requests',
        'input_tokens',
        'cache_creation_input_tokens',
        'cache_creation_5m',
        'cache_creation_1h',
        'cache_read_input_tokens',
        'output_tokens',
        'thinking_tokens',
        'web_search_requests',
        'web_fetch_requests',
        'complete',
    ];
    const rows = (report?.dayModels ?? []).map(r => [
        r.date,
        r.model,
        r.variant ?? '',
        r.speed ?? '',
        r.inferenceGeo ?? '',
        r.promptSize ?? '',
        String(r.totals.coverage.requests),
        String(r.totals.input),
        String(r.totals.cacheCreation),
        String(r.totals.cacheWrite5m),
        String(r.totals.cacheWrite1h),
        String(r.totals.cacheRead),
        String(r.totals.output),
        String(r.totals.thinking),
        String(r.totals.webSearchRequests),
        String(r.totals.webFetchRequests),
        r.totals.provenance === 'partial' ? 'no' : 'yes',
    ]);
    const notes = [
        ...exportNotes(view),
        // What a hand-made cost calculation needs to know of the columns.
        'speed and inference_geo are as each request recorded them, empty where it named none: fast, and us, are billed higher',
        "prompt_size is each request's input, cache writes and cache reads together, over 100,000 or 200,000 tokens or not: Claude Haiku 5.5 prices a request over 100,000 higher",
        'thinking_tokens are part of output_tokens; cache_creation_5m and cache_creation_1h split cache_creation_input_tokens where the requests recorded the split',
    ];
    if (report && report.omitted.dayModels > 0) {
        notes.push(`${report.omitted.dayModels} older day-and-model rows are counted in the totals but not listed`);
    }
    return { header, rows, notes };
}

function copyRows(view: PanelView): PanelFragments['copy'] {
    const report = view.report;
    const labels = labelsOf(view);
    const rows = (report?.sessions ?? []).map(s => [
        s.firstTs !== null ? view.formatTime(s.firstTs) : '',
        s.label,
        s.sessionId,
        String(s.totals.coverage.requests),
        String(s.totals.processed),
        String(Math.round(s.activeMs / 60_000)),
        [...s.accounts.map(key => labelOf(labels, key)), ...(s.moreAccounts > 0 ? [`and ${s.moreAccounts.toLocaleString('en-US')} more`] : [])].join('; '),
    ]);
    const notes = exportNotes(view);
    notes.push(`active_minutes is the time between a session's requests in the range, pauses of over ${ACTIVE_PAUSE_MS / 60_000} minutes left out`);
    if (report && report.omitted.sessions > 0) {
        notes.push(`${report.omitted.sessions} smaller sessions are counted in the totals but not listed`);
    }
    notes.push(
        "account is the Claude account a session's requests were made with, as the panel names it, those of one resumed under another separated by semicolons, the first used first; Not recorded where its transcripts record none",
    );
    return { header: ['started', 'project', 'session', 'requests', 'processed', 'active_minutes', 'account'], rows, notes };
}

/** The `# key: value` lines every export opens with. */
function exportNotes(view: PanelView): string[] {
    const report = view.report;
    return [
        `extension: LLM Tokenizer ${view.extensionVersion}`,
        `time zone: ${view.zone}`,
        `range: ${report?.from ?? ''} to ${report?.to ?? ''}${view.scope === 'workspace' ? ', this workspace' : ''}${accountNote(view)}`,
        'each request is its record with the largest output per message.id',
        `history since: ${report?.coverage.start !== null && report?.coverage.start !== undefined ? new Date(report.coverage.start).toISOString() : ''}`,
    ];
}

/**
 * The account an export holds, when one is chosen, for its range note. A
 * label is another program's text, an organization's name its admin's. In
 * the CSV, a note line stays one comment, never quoted, so that a reader
 * that skips lines starting with `#` still does: a comma or a semicolon in
 * the label, which a spreadsheet splits cells at, as it is set to, would
 * start a cell, a formula perhaps, so each is written as a space. What
 * follows a fixed comma of the note then starts with a word of it.
 */
function accountNote(view: PanelView): string {
    if (view.account === ALL_ACCOUNTS) {
        return '';
    }
    return view.account === NOT_RECORDED
        ? ', the sessions that record no account'
        : `, account ${labelOf(labelsOf(view), view.account)
              .replace(/[,;]/g, ' ')
              .replace(/\s+/g, ' ')}`;
}

/** How long the account filter's value must stay put before it is sent. */
export const ACCOUNT_SETTLE_MS = 250;

/** The page: rendered once; everything in it after that arrives as fragments. */
export function renderUsagePage(nonce: string, csp: string, first: PanelFragments): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>Claude Code Usage</title>
<style>
${THEME_TOKENS_CSS}
* { box-sizing: border-box; }
body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--ink);
    background: var(--surface);
    margin: 0;
    padding: 20px 28px 48px;
    line-height: 1.5;
}
.wrap { max-width: 960px; margin: 0 auto; }
#controls { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-bottom: 18px; }
/* Two regions, updated apart, laid out as one row. */
#choices, #status { display: contents; }
.segmented { display: inline-flex; }
button {
    padding: 3px 10px;
    color: var(--vscode-button-secondaryForeground, var(--ink));
    background: var(--vscode-button-secondaryBackground, transparent);
    border: 1px solid var(--hairline);
    border-radius: 3px;
    cursor: pointer;
    font: inherit;
}
.segmented button { border-radius: 0; margin-left: -1px; }
.segmented button:first-child { border-radius: 3px 0 0 3px; margin-left: 0; }
.segmented button:last-child { border-radius: 0 3px 3px 0; }
button[aria-pressed="true"], button.primary {
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
}
button[aria-disabled="true"] { opacity: 0.6; cursor: default; }
button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
.muted, .note, .reason { color: var(--ink-muted); }
.note { font-size: 0.9em; margin: 10px 0 0; }
.hero-value { font-size: 48px; font-weight: 600; line-height: 1.05; letter-spacing: -0.02em; }
.hero-meta { color: var(--ink-muted); margin-top: 4px; }
.banner {
    margin: 0 0 14px;
    padding: 8px 12px;
    border-radius: 4px;
    border-left: 3px solid var(--warning);
    background: color-mix(in srgb, var(--warning) 12%, transparent);
}
.banner.reading {
    border-left-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 10%, transparent);
}
.panel { margin-top: 26px; padding-top: 18px; border-top: 1px solid var(--hairline); }
.panel h2, .empty-state h2 {
    font-size: 0.8em;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--ink-muted);
    margin: 0 0 12px;
}
details.panel > summary { cursor: pointer; }
details.panel > summary h2 { display: inline; }
.panel h3 { font-size: 0.9em; margin: 16px 0 6px; }
${RANKED_BARS_CSS}
.columns { display: flex; align-items: flex-end; gap: 2px; height: 110px; }
.column { flex: 1; height: 100%; display: flex; align-items: flex-end; }
.column-bar { width: 100%; background: var(--accent); border-radius: 2px 2px 0 0; min-height: 1px; }
.columns-axis { display: flex; justify-content: space-between; color: var(--ink-muted); font-size: 0.85em; }
table { width: 100%; border-collapse: collapse; }
thead th {
    text-align: left;
    font-weight: 600;
    font-size: 0.8em;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--ink-muted);
    padding: 4px 8px;
    border-bottom: 1px solid var(--hairline);
}
thead th.num, td.num { text-align: right; }
thead th button { font: inherit; color: inherit; text-transform: inherit; letter-spacing: inherit; background: none; border: 0; padding: 0; }
tbody td { padding: 3px 8px; font-variant-numeric: tabular-nums; }
tbody tr:hover { background: var(--vscode-list-hoverBackground); }
/* Columns are as wide on every page. In a narrow panel a project's name is
   cut, its title whole; every other cell wraps, so no figure is lost. */
table.page td, table.page th button { overflow-wrap: anywhere; }
table.page th button { max-width: 100%; }
table.page td.label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.section-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin: 0 0 12px; }
select.account-filter {
    max-width: 22em;
    padding: 2px 6px;
    font: inherit;
    color: var(--vscode-dropdown-foreground, var(--ink));
    background: var(--vscode-dropdown-background, var(--surface));
    border: 1px solid var(--vscode-dropdown-border, var(--hairline));
    border-radius: 3px;
}
select.account-filter:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
/* An account's name, and what tells it apart below it: each line cut, its title whole. */
.account-line { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.account-name { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.account-line .badge { flex: none; color: var(--ink-muted); font-size: 0.85em; }
.account-line button.name { flex: none; margin-left: auto; padding: 0 6px; font-size: 0.85em; }
.account-hint { overflow: hidden; text-overflow: ellipsis; color: var(--ink-muted); font-size: 0.85em; }
.section-head h2 { margin: 0; }
.pager { display: inline-flex; align-items: center; gap: 8px; color: var(--ink-muted); font-size: 0.9em; font-variant-numeric: tabular-nums; }
.pager button { padding: 0 9px; }
/* Pages snap: a swipe comes to rest on a page's edge, the next one, or past
   it if long or fast, and the pager follows wherever it rests. */
.pages {
    display: flex;
    align-items: flex-start;
    overflow-x: auto;
    scroll-snap-type: x mandatory;
    overscroll-behavior-x: contain;
    scrollbar-width: none;
}
.pages::-webkit-scrollbar { display: none; }
.pages > .page { flex: 0 0 100%; min-width: 0; scroll-snap-align: start; scroll-snap-stop: always; }
table.page { table-layout: fixed; }
.truncation { color: var(--ink-muted); font-size: 0.9em; font-style: italic; margin: 10px 0 0; }
.plain-list { list-style: none; padding: 0; margin: 8px 0 0; }
.plain-list li { display: flex; justify-content: space-between; gap: 16px; padding: 2px 0; }
.path { overflow-wrap: anywhere; }
.facts { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 8px 0 0; }
.facts dt { color: var(--ink-muted); }
.facts dd { margin: 0; }
.actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 14px; }
.empty-state ul { padding-left: 18px; }
</style>
</head>
<body>
<div class="wrap">
<div id="controls"><div id="choices">${first.controls}</div><div id="status">${first.status}</div></div>
<main id="body">${first.body}</main>
<div id="diagnostics-slot">${first.diagnostics}</div>
</div>
<script nonce="${nonce}">
(function () {
    const vscode = acquireVsCodeApi();
    const ACCOUNT_SETTLE_MS = ${ACCOUNT_SETTLE_MS};
    let exports = ${embed({ csv: first.csv, copy: first.copy })};
    const sorts = {};
    // The page each list's strip is at, by its id: kept across updates, as sorts are.
    const at = {};
${PAGE_TEXT_HELPERS}
    const controls = document.getElementById('choices');
    const statusLine = document.getElementById('status');
    const body = document.getElementById('body');
    const slot = document.getElementById('diagnostics-slot');

    function pagesIn(strip) {
        return Array.prototype.filter.call(strip.children, el => el.classList.contains('page'));
    }

    // A table keeps the sort chosen for it across updates: every row, on
    // every page, is ordered, then dealt out a page's worth at a time.
    function applySort(strip) {
        const state = sorts[strip.id] || { key: strip.dataset.sort, ascending: false };
        const bodies = pagesIn(strip).map(page => page.tBodies[0]);
        const rows = [];
        bodies.forEach(tbody => Array.prototype.push.apply(rows, Array.from(tbody.rows)));
        const value = row => {
            const raw = row.getAttribute('data-k-' + state.key) || '';
            const n = Number(raw);
            return raw !== '' && !Number.isNaN(n) ? n : raw.toLowerCase();
        };
        rows.sort((a, b) => {
            const x = value(a), y = value(b);
            const d = typeof x === 'number' && typeof y === 'number' ? x - y : String(x) < String(y) ? -1 : String(x) > String(y) ? 1 : 0;
            return state.ascending ? d : -d;
        });
        const per = Number(strip.dataset.pageRows) || rows.length || 1;
        rows.forEach((row, i) => bodies[Math.min(bodies.length - 1, Math.floor(i / per))].appendChild(row));
        strip.querySelectorAll('th').forEach(th => {
            const key = th.querySelector('button') && th.querySelector('button').dataset.sortKey;
            th.setAttribute('aria-sort', key !== state.key ? 'none' : state.ascending ? 'ascending' : 'descending');
        });
    }

    // The page a strip has come to rest on: the only one that can be reached,
    // and the one its pager tells of.
    function settle(strip) {
        const pages = pagesIn(strip);
        const width = strip.clientWidth;
        const index = width > 0 ? Math.max(0, Math.min(pages.length - 1, Math.round(strip.scrollLeft / width))) : at[strip.id] || 0;
        at[strip.id] = index;
        // Back onto that page's edge: a glide cut short by focus, or outlived
        // by a resize of the panel, can stop between two pages, and scroll
        // snapping does not move it again.
        if (width > 0 && Math.abs(strip.scrollLeft - index * width) >= 1) {
            strip.scrollLeft = index * width;
        }
        pages.forEach((page, i) => {
            const away = i !== index;
            // Focus on a page about to go inert follows to the same button on the page in view.
            const focused = document.activeElement;
            if (away && focused && page.contains(focused)) {
                const key = focused.getAttribute && focused.getAttribute('data-sort-key');
                const again = key && pages[index].querySelector('button[data-sort-key="' + key + '"]');
                pages[index].inert = false;
                if (again) { again.focus({ preventScroll: true }); }
            }
            page.inert = away;
        });
        const pager = document.querySelector('nav[data-pages="' + strip.id + '"]');
        if (pager) {
            const per = Number(strip.dataset.pageRows);
            const rows = Number(strip.dataset.rows);
            const count = n => n.toLocaleString('en-US');
            const line = count(index * per + 1) + '–' + count(Math.min(rows, (index + 1) * per)) + ' of ' + count(rows);
            // Written only when it changes: it is a live region, which a
            // screen reader would read out again on every update.
            const output = pager.querySelector('output');
            if (output.textContent !== line) { output.textContent = line; }
            pager.querySelector('[data-page="previous"]').setAttribute('aria-disabled', String(index === 0));
            pager.querySelector('[data-page="next"]').setAttribute('aria-disabled', String(index >= pages.length - 1));
        }
    }

    // Turn a strip to a page: gliding there from a pager's button, unless
    // motion is to be reduced, in VS Code (a class on the body) or in the
    // system; at once after an update or a sort.
    function turn(strip, index, glide) {
        const pages = pagesIn(strip);
        const to = Math.max(0, Math.min(pages.length - 1, index));
        at[strip.id] = to;
        const left = to * strip.clientWidth;
        const reduced =
            !!(document.body && document.body.classList && document.body.classList.contains('vscode-reduce-motion')) ||
            !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
        if (glide && !reduced && Math.abs(strip.scrollLeft - left) >= 1) {
            // Only the page it glides to can be reached from the start: Tab
            // after the pager's button goes into it, never back into the page
            // it leaves, where focus would stop the glide halfway.
            pages.forEach((page, i) => { page.inert = i !== to; });
            strip.scrollTo({ left, behavior: 'smooth' });
        } else {
            strip.scrollLeft = left;
            settle(strip);
        }
    }

    // A strip at rest, after a swipe or a glide. scrollend does not bubble:
    // it is caught on its way down.
    document.addEventListener('scrollend', e => {
        const strip = e.target;
        if (strip && strip.classList && strip.classList.contains('pages')) { settle(strip); }
    }, true);

    // Focus that lands on a page turns its strip there, if it is not there
    // already: one that cuts a glide short can leave no scrollend behind.
    document.addEventListener('focusin', e => {
        const page = e.target && e.target.closest && e.target.closest('.pages > .page');
        if (!page) { return; }
        const strip = page.parentElement;
        const index = pagesIn(strip).indexOf(page);
        if (index !== at[strip.id] || Math.abs(strip.scrollLeft - index * strip.clientWidth) >= 1) { turn(strip, index, false); }
    });

    function arrange() {
        document.querySelectorAll('.pages').forEach(strip => {
            if (strip.dataset.sort) { applySort(strip); }
            turn(strip, at[strip.id] || 0, false);
        });
    }

    function lines(table, separator, format) {
        const out = table.notes.map(n => '# ' + n.replace(/[\\t\\r\\n]+/g, ' '));
        // Stamped on the click: the notes were rendered when the data came.
        out.push('# exported: ' + new Date().toISOString());
        out.push(table.header.map(format).join(separator));
        table.rows.forEach(r => out.push(r.map(format).join(separator)));
        return out.join('\\n');
    }

    // The range and scope buttons, and the account filter, as the page shows
    // them: never rebuilt, so that one in use is not replaced under it, but
    // brought up to date in place, unless the account filter comes or goes.
    let choices = ${embed(first.choices)};
    function showChoices(fragments) {
        const next = fragments.choices;
        const select = controls.querySelector('select[data-account-filter]');
        if (!next || !choices || !next.account !== !select) {
            if (JSON.stringify(next) !== JSON.stringify(choices)) {
                controls.innerHTML = fragments.controls;
                // What was waiting for the select it replaces is not the new one's.
                deferred = null;
            }
            choices = next;
            return;
        }
        controls.querySelectorAll('button[data-range]').forEach(button => {
            press(button, button.dataset.range === next.range);
            if (button.dataset.range === 'coverage' && button.textContent !== next.since) { button.textContent = next.since; }
        });
        controls.querySelectorAll('button[data-scope]').forEach(button => press(button, button.dataset.scope === next.scope));
        if (select && next.account) { updateSelect(select, next.account); }
        choices = next;
    }

    function press(button, pressed) {
        if (button.getAttribute('aria-pressed') !== String(pressed)) { button.setAttribute('aria-pressed', String(pressed)); }
    }

    // An account chosen is sent once the choice has settled: moving through
    // the list by the arrow keys changes the value at each step, and each
    // would otherwise read the history again. Each choice sent is numbered,
    // and the select keeps it until an update says the host has applied it:
    // one that comes before, for an earlier choice or a pass, never moves the
    // select back under the next step.
    let choosing;
    let sent = 0;
    let applied = 0;
    // What the account filter offers now, waiting for it to lose focus.
    let deferred = null;
    // In use: focused, in a window that has focus. Left focused while the
    // editor is in the background, it takes updates as they come.
    const inUse = select => document.activeElement === select && document.hasFocus();
    function updateSelect(select, account) {
        // Not while it is in use: an open list would close under the
        // pointer, and the next arrow key start from somewhere else.
        if (inUse(select)) {
            deferred = account;
            return;
        }
        deferred = null;
        const options = Array.from(select.options);
        const same = options.length === account.options.length &&
            account.options.every((o, i) => options[i].value === o.value && options[i].textContent === o.label && options[i].disabled === !!o.disabled);
        if (!same) {
            const value = select.value;
            const shownOption = select.options[select.selectedIndex];
            select.replaceChildren(...account.options.map(o => {
                const option = document.createElement('option');
                option.value = o.value;
                option.textContent = o.label;
                option.disabled = !!o.disabled;
                return option;
            }));
            // A choice not yet applied keeps its option, though the update
            // no longer offers it: the filter never goes blank under it.
            if ((choosing !== undefined || applied < sent) && shownOption && !account.options.some(o => o.value === value)) {
                select.appendChild(shownOption);
            }
            select.value = value;
        }
        if (choosing === undefined && applied >= sent && select.value !== account.value) {
            select.value = account.value;
        }
    }

    document.addEventListener('focusout', e => {
        const select = e.target;
        if (deferred && select && select.matches && select.matches('select[data-account-filter]')) {
            // Once focus has gone where it goes.
            setTimeout(() => {
                if (deferred && select.isConnected && !inUse(select)) { updateSelect(select, deferred); }
            }, 0);
        }
    });

    let shown = { status: null, body: null, diagnostics: null };
    function show(fragments) {
        // Focus is restored to the same control, found again by what it does,
        // and in which table: two share their sort keys.
        const focused = document.activeElement;
        let selector = () => null;
        if (focused && focused.matches('button')) {
            const attribute = ['data-action', 'data-range', 'data-scope', 'data-sort-key', 'data-page'].find(a => focused.getAttribute(a));
            // A header's button is found again on its list's page in view, once
            // the update is arranged, and a pager's in its pager: two lists
            // share their sort keys, and every page has a header.
            const strip = attribute === 'data-sort-key' && focused.closest('.pages[id]');
            const pager = attribute === 'data-page' && focused.closest('nav[data-pages]');
            // An account's Name… is found again by its row's key: every row has one.
            const key = focused.getAttribute('data-key');
            const button = attribute
                ? 'button[' + attribute + '="' + focused.getAttribute(attribute) + '"]' + (key ? '[data-key="' + key + '"]' : '')
                : null;
            selector = () =>
                !button ? null
                : strip ? '#' + strip.id + ' > .page:nth-child(' + ((at[strip.id] || 0) + 1) + ') ' + button
                : pager ? 'nav[data-pages="' + pager.dataset.pages + '"] ' + button
                : button;
        } else if (focused && focused.matches('.pages[id]')) {
            // Usage limits reached holds nothing focusable, so its strip is
            // itself a stop on Tab, and the arrow keys turn its pages.
            const id = focused.id;
            selector = () => '#' + id;
        } else if (focused && focused.matches('#diagnostics > summary')) {
            selector = () => '#diagnostics > summary';
        } else if (focused && focused.matches('select[data-account-filter]')) {
            selector = () => 'select[data-account-filter]';
        }
        // A region whose page has not changed is left as it is, focus and all.
        showChoices(fragments);
        if (fragments.status !== shown.status) { statusLine.innerHTML = fragments.status; }
        if (fragments.body !== shown.body) { body.innerHTML = fragments.body; }
        if (fragments.diagnostics !== shown.diagnostics) {
            const open = document.getElementById('diagnostics');
            const wasOpen = !!(open && open.open);
            slot.innerHTML = fragments.diagnostics;
            const details = document.getElementById('diagnostics');
            if (details && wasOpen) { details.open = true; }
        }
        shown = { status: fragments.status, body: fragments.body, diagnostics: fragments.diagnostics };
        exports = { csv: fragments.csv, copy: fragments.copy };
        arrange();
        const restore = selector();
        if (restore) {
            const again = document.querySelector(restore);
            if (again && again !== document.activeElement) {
                // On a page of its list that is not in view, as a row an
                // update moved: that page first, where it can take focus.
                const page = again.closest && again.closest('.pages > .page');
                if (page && page.inert) { turn(page.parentElement, pagesIn(page.parentElement).indexOf(page), false); }
                again.focus();
            }
        }
    }

    document.addEventListener('click', e => {
        const button = e.target.closest('button');
        if (!button) { return; }
        if (button.dataset.action === 'nameAccount') {
            vscode.postMessage({ type: 'nameAccount', account: button.dataset.account });
        } else if (button.dataset.range) {
            vscode.postMessage({ type: 'setRange', range: button.dataset.range });
        } else if (button.dataset.scope) {
            vscode.postMessage({ type: 'setScope', scope: button.dataset.scope });
        } else if (button.dataset.page) {
            // Past either end, turn() stays at that end.
            const pager = button.closest('nav[data-pages]');
            const strip = pager && document.getElementById(pager.dataset.pages);
            if (strip) {
                turn(strip, (at[strip.id] || 0) + (button.dataset.page === 'next' ? 1 : -1), true);
            }
        } else if (button.dataset.sortKey) {
            const strip = button.closest('.pages');
            const current = sorts[strip.id] || { key: strip.dataset.sort, ascending: false };
            const key = button.dataset.sortKey;
            sorts[strip.id] = { key, ascending: key === current.key ? !current.ascending : key === 'label' };
            applySort(strip);
            // A new order is shown from its first page.
            turn(strip, 0, false);
        } else if (button.dataset.action === 'copy') {
            vscode.postMessage({ type: 'copy', text: lines(exports.copy, '\\t', pasteCell) });
        } else if (button.dataset.action === 'export') {
            vscode.postMessage({ type: 'export', text: lines(exports.csv, ',', csv) });
        } else if (button.dataset.action) {
            vscode.postMessage({ type: button.dataset.action });
        }
    });

    document.addEventListener('change', e => {
        const select = e.target;
        if (select && select.matches && select.matches('select[data-account-filter]')) {
            clearTimeout(choosing);
            // The account chosen, as it was chosen: an update meanwhile can
            // change what the select offers, never what is sent.
            const value = select.value;
            choosing = setTimeout(() => {
                choosing = undefined;
                sent += 1;
                vscode.postMessage({ type: 'setAccount', account: value, choice: sent });
            }, ACCOUNT_SETTLE_MS);
        }
    });

    window.addEventListener('message', e => {
        // The editor's own messages come from this page's origin; another
        // frame in the window could post here too.
        if (e.origin !== window.origin) { return; }
        if (e.data && e.data.type === 'data') {
            if (typeof e.data.choice === 'number') { applied = e.data.choice; }
            show(e.data.fragments);
        }
    });

    arrange();
    vscode.postMessage({ type: 'ready', zone: Intl.DateTimeFormat().resolvedOptions().timeZone });
})();
</script>
</body>
</html>`;
}
