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
 * `≥`.
 */

import { RANKED_BARS_CSS, THEME_TOKENS_CSS, rankedBars, type RankedValue } from '../charts';
import { PAGE_TEXT_HELPERS, embed, escapeHtml } from '../html';
import { formatNumber } from '../utils';
import { cacheReadShare, type UsageTotals } from './aggregate';
import { totalPrefix } from './provenance';
import type { RangeKey, UsageReport } from './report';
import type { UsageStatus } from './usageService';

/** What the panel shows besides the report: status, scope, and diagnostics. */
export interface PanelView {
    status: UsageStatus;
    range: RangeKey;
    scope: 'all' | 'workspace';
    zone: string;
    /** "on <host>" in a remote window, empty locally. */
    where: string;
    remote: boolean;
    report: UsageReport | undefined;
    /** A model id's label, from the registry by exact id; the id itself when unknown. */
    modelLabel(id: string): string;
    /** Each root considered, as shown: `~`-relative, with what chose it in words. */
    roots: { path: string; source: string; exists: boolean }[];
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

/** What one post carries: the fragments, and the rows the page's exports are built from. */
export interface PanelFragments {
    controls: string;
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
            return `
            <section class="empty-state">
                <h2>Claude Code usage is off</h2>
                <p>Turned on, LLM Tokenizer reads Claude Code's own session records on this machine${view.where ? ` (${escapeHtml(view.where)})` : ''},
                and shows how many tokens Claude Code processed: by day, project, session and model.</p>
                <ul>
                    <li>Kept, in a database in this extension's own storage: each request's token counts, model, effort, time, ids and Claude Code version; the folder each session started in; and which transcripts were read, and how far.</li>
                    <li>Never kept: prompts, responses, thinking, tool inputs or results.</li>
                    <li>Nothing is sent anywhere.</li>
                    <li>The history outlives Claude Code's own records, which it deletes after 30 days by default; Clear Claude Code Usage History removes it.</li>
                </ul>
                <p><button type="button" data-action="openSettings">Open Settings</button>${
                    view.remote ? ' <span class="muted">The setting is in Remote settings, for this host.</span>' : ''
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
                }. VS Code 1.105 and later have it.</p>
            </section>`;
        default:
            return undefined;
    }
}

function rootList(view: PanelView): string {
    return `<ul class="plain-list">${view.roots
        .map(
            r =>
                `<li><span class="path">${escapeHtml(r.path)}</span><span class="reason">${escapeHtml(r.source)}${r.exists ? '' : ', not found'}</span></li>`,
        )
        .join('')}</ul>`;
}

function banner(view: PanelView): string {
    const lines: string[] = [];
    if (view.recoveredFrom) {
        lines.push(
            `The history could not be read, so it was moved aside as ${escapeHtml(view.recoveredFrom)}, and a new one started from what Claude Code still keeps.`,
        );
    }
    if (view.status === 'no-roots') {
        lines.push(
            "No Claude Code data folder is found now, so this is the history kept so far. <button type=\"button\" data-action=\"chooseFolder\">Choose Folder…</button>",
        );
    }
    if (view.status === 'read-only') {
        lines.push('This history was written by a newer LLM Tokenizer: it is shown, but not updated.');
    }
    if (view.status === 'failing') {
        lines.push('The last import failed; what is shown may be out of date. <button type="button" data-action="showLog">Show Log</button>');
    }
    if (view.historyDisabled) {
        lines.push('CLAUDE_CODE_SKIP_PROMPT_HISTORY is set, so Claude Code keeps no transcripts, and nothing new can be read.');
    }
    return lines.map(line => `<p class="banner">${line}</p>`).join('');
}

/** The range and scope buttons, and the refresh line. */
function controls(view: PanelView): string {
    const report = view.report;
    const since = report?.coverage.start != null ? ` ${view.formatDate(report.coverage.start)}` : '';
    const range = (key: RangeKey) =>
        `<button type="button" data-range="${key}" aria-pressed="${view.range === key}">${RANGE_LABELS[key]}${key === 'coverage' ? escapeHtml(since) : ''}</button>`;
    const scope = (key: 'all' | 'workspace', label: string) =>
        `<button type="button" data-scope="${key}" aria-pressed="${view.scope === key}">${label}</button>`;
    const newest = report?.coverage.newest != null ? `newest record ${escapeHtml(view.formatTime(report.coverage.newest))}` : '';
    const refreshed = view.refreshedAt !== undefined ? `refreshed ${escapeHtml(view.formatTime(view.refreshedAt))}` : '';
    return `
        <div class="segmented" role="group" aria-label="Range">${(['today', '7d', '30d', 'coverage'] as const).map(range).join('')}</div>
        <div class="segmented" role="group" aria-label="Scope">${scope('all', 'All projects')}${scope('workspace', 'This workspace')}</div>
        <button type="button" data-action="refresh">Refresh</button>
        <span class="muted">${[refreshed, newest].filter(Boolean).join(' · ')}${view.where ? ` · ${escapeHtml(view.where)}` : ''}</span>`;
}

function categoryBars(t: UsageTotals): string {
    const rows: [string, number][] = [
        ['Cache read', t.cacheRead],
        ['Cache write', t.cacheCreation],
        ['Input', t.input],
        ['Output', t.output],
    ];
    return rankedBars(ranked(rows, t.processed));
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
            const label = `${date}: ${totalPrefix(t?.provenance ?? 'reported')}${value.toLocaleString('en-US')} processed`;
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

function overview(report: UsageReport, view: PanelView): string {
    const t = report.totals;
    const prefix = totalPrefix(t.provenance);
    const share = cacheReadShare(t);
    const sessions = report.sessions.length + report.omitted.sessions;
    const thinking = t.output > 0 && t.thinking > 0 ? ` · ${((t.thinking / t.output) * 100).toFixed(0)}% of output was thinking` : '';
    const writes =
        t.cacheWrite5m + t.cacheWrite1h > 0
            ? ` · cache writes ${formatNumber(t.cacheWrite5m)} for 5 minutes, ${formatNumber(t.cacheWrite1h)} for 1 hour`
            : '';
    return `
    <header>
        <div class="hero-value">${prefix}${formatNumber(t.processed)}</div>
        <div class="hero-meta">tokens processed · ${t.coverage.requests.toLocaleString('en-US')} requests · ${sessions.toLocaleString('en-US')} sessions</div>
        ${
            t.provenance === 'partial'
                ? `<p class="note">≥: ${t.coverage.incompleteRequests.toLocaleString('en-US')} requests did not report every counter, so this is a lower bound.</p>`
                : ''
        }
    </header>
    <section class="panel">
        <h2>What was processed</h2>
        ${categoryBars(t)}
        <p class="note">${
            share === null ? '' : `${(share * 100).toFixed(1)}% of input was read from the cache, which Claude Code resends every turn.`
        }${thinking}${writes}</p>
    </section>
    <section class="panel"><h2>By day</h2>${dayColumns(report, view)}</section>
    <section class="panel">
        <h2>By model</h2>
        ${rankedBars(report.models.map(m => ({ label: modelName(view, m.model, m.variant), tokens: m.totals.processed, share: share0(m.totals, t) })))}
        ${capNote(report.omitted.models, 'models')}
    </section>
    <section class="panel">
        <h2>Delegated work</h2>
        ${rankedBars(report.kinds.map(k => ({ label: KIND_LABELS[k.kind] ?? k.kind, tokens: k.totals.processed, share: share0(k.totals, t) })))}
    </section>
    ${
        report.efforts.length > 1 || report.efforts[0]?.effort
            ? `<section class="panel"><h2>By effort</h2>${rankedBars(
                  report.efforts.map(e => ({ label: e.effort ?? 'not recorded', tokens: e.totals.processed, share: share0(e.totals, t) })),
              )}${capNote(report.omitted.efforts, 'effort levels')}</section>`
            : ''
    }
    ${limitWindows(report, view)}`;
}

function share0(part: UsageTotals, whole: UsageTotals): number {
    return whole.processed > 0 ? part.processed / whole.processed : 0;
}

function limitWindows(report: UsageReport, view: PanelView): string {
    if (report.limitWindows.length === 0) {
        return '';
    }
    return `
    <section class="panel">
        <h2>Usage limits reached</h2>
        <ul class="plain-list">${report.limitWindows
            .map(
                w =>
                    `<li><span>${escapeHtml(w.limitType.replace(/_/g, ' '))} limit, ${w.hits.toLocaleString('en-US')} ${
                        w.hits === 1 ? 'request' : 'requests'
                    } refused from ${escapeHtml(view.formatTime(w.firstTs))}</span><span class="reason">${
                        w.resetsAt !== null ? `reset ${escapeHtml(view.formatTime(w.resetsAt * 1000))}` : ''
                    }</span></li>`,
            )
            .join('')}</ul>
        ${report.omitted.limitWindows > 0 ? `<p class="truncation">…and ${report.omitted.limitWindows.toLocaleString('en-US')} earlier ones, not listed.</p>` : ''}
        <p class="note">For the whole account, whichever project hit them.</p>
    </section>`;
}

/** A sortable table: each row carries its sort keys, so the page can keep the sort across updates. */
function table(
    id: string,
    columns: { key: string; label: string; numeric?: boolean }[],
    rows: { keys: Record<string, string | number>; cells: string[] }[],
    initial: string,
): string {
    return `
    <table id="${id}" data-sort="${initial}" data-ascending="false">
        <thead><tr>${columns
            .map(
                c =>
                    `<th${c.numeric ? ' class="num"' : ''} aria-sort="${c.key === initial ? 'descending' : 'none'}"><button type="button" data-sort-key="${c.key}">${escapeHtml(c.label)}</button></th>`,
            )
            .join('')}</tr></thead>
        <tbody>${rows
            .map(
                r =>
                    `<tr ${Object.entries(r.keys)
                        .map(([k, v]) => `data-k-${k}="${escapeHtml(String(v))}"`)
                        .join(' ')}>${r.cells.map((cell, i) => `<td${columns[i]?.numeric ? ' class="num"' : ''}>${cell}</td>`).join('')}</tr>`,
            )
            .join('')}</tbody>
    </table>`;
}

function projects(report: UsageReport): string {
    const total = report.totals.processed;
    return `
    <section class="panel">
        <h2>Projects</h2>
        ${table(
            'projects',
            [
                { key: 'label', label: 'Project' },
                { key: 'sessions', label: 'Sessions', numeric: true },
                { key: 'processed', label: 'Processed', numeric: true },
                { key: 'share', label: 'Share', numeric: true },
            ],
            report.projects.map(p => ({
                keys: { label: p.label, sessions: p.sessions, processed: p.totals.processed, share: p.totals.processed },
                cells: [
                    `<span title="${escapeHtml(p.project.kind === 'root' ? p.project.path : p.project.projectDir)}">${escapeHtml(p.label)}</span>`,
                    p.sessions.toLocaleString('en-US'),
                    `${totalPrefix(p.totals.provenance)}${p.totals.processed.toLocaleString('en-US')}`,
                    total > 0 ? `${((p.totals.processed / total) * 100).toFixed(1)}%` : '—',
                ],
            })),
            'processed',
        )}
        ${capNote(report.omitted.projects, 'projects')}
    </section>`;
}

function sessions(report: UsageReport, view: PanelView): string {
    return `
    <section class="panel">
        <h2>Sessions</h2>
        ${table(
            'sessions',
            [
                { key: 'started', label: 'Started' },
                { key: 'label', label: 'Project' },
                { key: 'span', label: 'Span', numeric: true },
                { key: 'requests', label: 'Requests', numeric: true },
                { key: 'processed', label: 'Processed', numeric: true },
                { key: 'compactions', label: 'Compactions', numeric: true },
            ],
            report.sessions.map(s => {
                const span = s.firstTs !== null && s.lastTs !== null ? s.lastTs - s.firstTs : 0;
                const compactions = s.compactions
                    .map(c => `${c.preTokens?.toLocaleString('en-US') ?? '?'} → ${c.postTokens?.toLocaleString('en-US') ?? '?'}`)
                    .join(', ');
                return {
                    keys: {
                        started: s.firstTs ?? 0,
                        label: s.label,
                        span,
                        requests: s.totals.coverage.requests,
                        processed: s.totals.processed,
                        compactions: s.compactions.length,
                    },
                    cells: [
                        `<span title="${escapeHtml(`Session ${s.sessionId}`)}">${escapeHtml(s.firstTs !== null ? view.formatTime(s.firstTs) : '—')}</span>`,
                        escapeHtml(s.label),
                        escapeHtml(formatSpan(span)),
                        s.totals.coverage.requests.toLocaleString('en-US'),
                        `${totalPrefix(s.totals.provenance)}${s.totals.processed.toLocaleString('en-US')}`,
                        s.compactions.length > 0 ? `<span title="${escapeHtml(compactions)}">${s.compactions.length}</span>` : '0',
                    ],
                };
            }),
            'processed',
        )}
        ${capNote(report.omitted.sessions, 'sessions')}
        <p class="note">Span is from a session's first request to its last, not time spent working.</p>
    </section>`;
}

function formatSpan(ms: number): string {
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
        rows.push(['Moved aside', escapeHtml(view.recoveredFrom)]);
    }
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
                          : view.scope === 'workspace'
                            ? 'No session in this range started in a folder of this workspace.'
                            : 'No requests fall in this range.'
                  }</p></section>`
                : `${banner(view)}${overview(report, view)}${projects(report)}${sessions(report, view)}`
            : `${banner(view)}<p class="muted">Reading Claude Code's records…</p>`);
    return {
        controls: empty ? '' : controls(view),
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
    const notes = exportNotes(view);
    if (report && report.omitted.dayModels > 0) {
        notes.push(`${report.omitted.dayModels} older day-and-model rows are counted in the totals but not listed`);
    }
    return { header, rows, notes };
}

function copyRows(view: PanelView): PanelFragments['copy'] {
    const report = view.report;
    const rows = (report?.sessions ?? []).map(s => [
        s.firstTs !== null ? view.formatTime(s.firstTs) : '',
        s.label,
        s.sessionId,
        String(s.totals.coverage.requests),
        String(s.totals.processed),
    ]);
    const notes = exportNotes(view);
    if (report && report.omitted.sessions > 0) {
        notes.push(`${report.omitted.sessions} smaller sessions are counted in the totals but not listed`);
    }
    return { header: ['started', 'project', 'session', 'requests', 'processed'], rows, notes };
}

/** The `# key: value` lines every export opens with. */
function exportNotes(view: PanelView): string[] {
    const report = view.report;
    return [
        `extension: LLM Tokenizer ${view.extensionVersion}`,
        `time zone: ${view.zone}`,
        `range: ${report?.from ?? ''} to ${report?.to ?? ''}${view.scope === 'workspace' ? ', this workspace' : ''}`,
        'each request is its record with the largest output per message.id',
        `history since: ${report?.coverage.start !== null && report?.coverage.start !== undefined ? new Date(report.coverage.start).toISOString() : ''}`,
    ];
}

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
button[aria-pressed="true"] {
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
}
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
.truncation { color: var(--ink-muted); font-size: 0.9em; font-style: italic; margin: 10px 0 0; }
.plain-list { list-style: none; padding: 0; margin: 8px 0 0; }
.plain-list li { display: flex; justify-content: space-between; gap: 16px; padding: 2px 0; }
.path { overflow-wrap: anywhere; }
.facts { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 8px 0 0; }
.facts dt { color: var(--ink-muted); }
.facts dd { margin: 0; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
.empty-state ul { padding-left: 18px; }
</style>
</head>
<body>
<div class="wrap">
<div id="controls">${first.controls}</div>
<main id="body">${first.body}</main>
<div id="diagnostics-slot">${first.diagnostics}</div>
</div>
<script nonce="${nonce}">
(function () {
    const vscode = acquireVsCodeApi();
    let exports = ${embed({ csv: first.csv, copy: first.copy })};
    const sorts = {};
${PAGE_TEXT_HELPERS}
    const controls = document.getElementById('controls');
    const body = document.getElementById('body');
    const slot = document.getElementById('diagnostics-slot');

    // A table keeps the sort chosen for it across updates.
    function applySort(table) {
        const state = sorts[table.id] || { key: table.dataset.sort, ascending: false };
        const tbody = table.tBodies[0];
        const rows = Array.from(tbody.rows);
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
        rows.forEach(row => tbody.appendChild(row));
        table.querySelectorAll('th').forEach(th => {
            const key = th.querySelector('button') && th.querySelector('button').dataset.sortKey;
            th.setAttribute('aria-sort', key !== state.key ? 'none' : state.ascending ? 'ascending' : 'descending');
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

    function show(fragments) {
        // Focus is restored to the same control, found again by what it does.
        const focused = document.activeElement;
        const key = focused && focused.matches('button')
            ? ['data-action', 'data-range', 'data-scope', 'data-sort-key'].map(a => focused.getAttribute(a) && '[' + a + '="' + focused.getAttribute(a) + '"]').filter(Boolean)[0]
            : null;
        controls.innerHTML = fragments.controls;
        body.innerHTML = fragments.body;
        const open = document.getElementById('diagnostics');
        const wasOpen = !!(open && open.open);
        slot.innerHTML = fragments.diagnostics;
        const details = document.getElementById('diagnostics');
        if (details && wasOpen) { details.open = true; }
        exports = { csv: fragments.csv, copy: fragments.copy };
        document.querySelectorAll('table[data-sort]').forEach(applySort);
        if (key) {
            const again = document.querySelector('button' + key);
            if (again) { again.focus(); }
        }
    }

    document.addEventListener('click', e => {
        const button = e.target.closest('button');
        if (!button) { return; }
        if (button.dataset.range) {
            vscode.postMessage({ type: 'setRange', range: button.dataset.range });
        } else if (button.dataset.scope) {
            vscode.postMessage({ type: 'setScope', scope: button.dataset.scope });
        } else if (button.dataset.sortKey) {
            const table = button.closest('table');
            const current = sorts[table.id] || { key: table.dataset.sort, ascending: false };
            const key = button.dataset.sortKey;
            sorts[table.id] = { key, ascending: key === current.key ? !current.ascending : key === 'label' };
            applySort(table);
        } else if (button.dataset.action === 'copy') {
            vscode.postMessage({ type: 'copy', text: lines(exports.copy, '\\t', pasteCell) });
        } else if (button.dataset.action === 'export') {
            vscode.postMessage({ type: 'export', text: lines(exports.csv, ',', csv) });
        } else if (button.dataset.action) {
            vscode.postMessage({ type: button.dataset.action });
        }
    });

    window.addEventListener('message', e => {
        // The editor's own messages come from this page's origin; another
        // frame in the window could post here too.
        if (e.origin !== window.origin) { return; }
        if (e.data && e.data.type === 'data') { show(e.data.fragments); }
    });

    document.querySelectorAll('table[data-sort]').forEach(applySort);
    vscode.postMessage({ type: 'ready', zone: Intl.DateTimeFormat().resolvedOptions().timeZone });
})();
</script>
</body>
</html>`;
}
