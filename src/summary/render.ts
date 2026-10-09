/**
 * The multi-file summary page. Its colours, meter and ranked bars come from
 * `charts.ts`, which the other webview pages share.
 *
 * Form follows the data's job:
 *   - the total is one headline number, so it is a hero figure, not a chart;
 *   - context use is a single ratio against a limit, so it is a meter;
 *   - folders and languages are magnitude comparisons, so they are ranked bars
 *     on a common baseline — every bar in one colour, because the categories
 *     have no natural order and shading them by size would encode length twice;
 *   - the per-file list is too many classes to colour, so it is a table.
 */

import { METER_CSS, RANKED_BARS_CSS, THEME_TOKENS_CSS, meter, rankedBars, type Severity } from '../charts';
import { PAGE_TEXT_HELPERS, embed, escapeHtml } from '../html';
import { formatNumber } from '../utils';
import type { Slice } from './aggregate';

/** Everything the page needs, already aggregated. */
export interface SummaryView {
    totalTokens: number;
    exact: boolean;
    cancelled: boolean;
    modelLabel: string;
    contextLimit?: number;
    filesCounted: number;
    filesSkipped: number;
    filesIgnored: number;
    byFolder: Slice[];
    byLanguage: Slice[];
    /** Largest first, already capped. */
    files: { path: string; display: string; tokens: number }[];
    /** Files counted but not listed, because the listing is capped. */
    filesNotListed: number;
    skipped: { display: string; reason: string }[];
    ignored: { display: string }[];
}

function severityOf(view: SummaryView): Severity {
    if (!view.contextLimit) {
        return 'ok';
    }
    const share = view.totalTokens / view.contextLimit;
    return share >= 1 ? 'error' : share >= 0.8 ? 'warning' : 'ok';
}

function breakdown(title: string, slices: Slice[], emptyNote: string): string {
    if (slices.length === 0) {
        return '';
    }

    // A single series carries no legend: there is one colour, and the heading
    // already says what is plotted.
    return `
    <section class="panel">
        <h2>${escapeHtml(title)}</h2>
        ${slices.length === 1 ? `<p class="note">${escapeHtml(emptyNote)}</p>` : ''}
        ${rankedBars(slices)}
    </section>`;
}

function contextMeter(view: SummaryView): string {
    if (!view.contextLimit) {
        return `<p class="meter-note">${escapeHtml(view.modelLabel)} has no published context limit.</p>`;
    }

    const share = view.totalTokens / view.contextLimit;
    const severity = severityOf(view);

    // The figure and the caption sit next to each other, so they must not
    // disagree. Rounding let 99.7% print as "100% — Approaching the limit", and
    // 79.99% print as "80%" with none of the warning styling. Truncating means
    // the figure can never claim a threshold the severity has not crossed.
    const percent =
        share >= 0.1
            ? String(Math.floor(share * 100))
            : (Math.floor(share * 1000) / 10).toFixed(1);

    const verdict =
        severity === 'error'
            ? `Over the ${formatNumber(view.contextLimit)} token limit`
            : severity === 'warning'
                ? `Approaching the ${formatNumber(view.contextLimit)} token limit`
                : `of ${formatNumber(view.contextLimit)} tokens`;

    return meter(share, severity, `${percent}%`, verdict, 'Context window used');
}

function statRow(view: SummaryView): string {
    const stats: [string, number][] = [
        ['Counted', view.filesCounted],
        ['Skipped', view.filesSkipped],
        ['Ignored', view.filesIgnored],
    ];

    return `
    <div class="stats">
        ${stats
            .filter(([, n], i) => i === 0 || n > 0)
            .map(
                ([label, n]) => `
        <div class="stat">
            <div class="stat-value">${n.toLocaleString('en-US')}</div>
            <div class="stat-label">${label}</div>
        </div>`,
            )
            .join('')}
    </div>`;
}

/**
 * Discloses rows a listing left out, so a cap never reads as a total.
 *
 * Every capped section says how many it dropped; a silent cap is how a partial
 * list starts being mistaken for the whole one.
 */
function truncationNote(hidden: number): string {
    return hidden === 0
        ? ''
        : `<p class="truncation">…and ${hidden.toLocaleString('en-US')} more, not listed.</p>`;
}

function collapsibleList(
    title: string,
    rows: { display: string; reason?: string }[],
    total: number,
): string {
    if (rows.length === 0) {
        return '';
    }

    // The badge reports the true total, not the number of rows shown, or it
    // would contradict the stat row directly above it.
    const hidden = Math.max(0, total - rows.length);
    return `
    <details class="panel">
        <summary><h2>${escapeHtml(title)} <span class="count">${total.toLocaleString('en-US')}</span></h2></summary>
        <ul class="plain-list">
            ${rows
                .map(
                    r => `<li><span>${escapeHtml(r.display)}</span>${
                        r.reason ? `<span class="reason">${escapeHtml(r.reason)}</span>` : ''
                    }</li>`,
                )
                .join('')}
        </ul>
        ${truncationNote(hidden)}
    </details>`;
}

export function renderSummary(view: SummaryView, nonce: string, csp: string): string {
    const approx = view.exact ? '' : '≈';

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>Token summary</title>
<style>
${THEME_TOKENS_CSS}

* { box-sizing: border-box; }

body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--ink);
    background: var(--surface);
    margin: 0;
    padding: 24px 28px 48px;
    line-height: 1.5;
}

.wrap { max-width: 940px; margin: 0 auto; }

/* ── Header ─────────────────────────────────────────────────────── */

header { margin-bottom: 28px; }

/* Proportional figures: tabular-nums gives every digit the width of a zero,
   which reads loose at display size. */
.hero-value {
    font-size: 52px;
    font-weight: 600;
    line-height: 1.05;
    letter-spacing: -0.02em;
}
.hero-meta { color: var(--ink-muted); margin-top: 4px; }
.chip {
    display: inline-block;
    padding: 1px 8px;
    border-radius: 10px;
    border: 1px solid var(--hairline);
    font-size: 0.85em;
    margin-left: 6px;
}

.banner {
    margin: 14px 0 0;
    padding: 8px 12px;
    border-radius: 4px;
    border-left: 3px solid var(--warning);
    background: color-mix(in srgb, var(--warning) 12%, transparent);
}

${METER_CSS}

/* ── Stats ──────────────────────────────────────────────────────── */

.stats { display: flex; gap: 32px; margin-top: 22px; }
.stat-value { font-size: 20px; font-weight: 600; font-variant-numeric: tabular-nums; }
.stat-label { color: var(--ink-muted); font-size: 0.85em; }

/* ── Panels ─────────────────────────────────────────────────────── */

.panel {
    margin-top: 28px;
    padding-top: 20px;
    border-top: 1px solid var(--hairline);
}
.panel h2 {
    font-size: 0.8em;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--ink-muted);
    margin: 0 0 14px;
    display: inline;
}
details.panel > summary { cursor: pointer; list-style: revert; }
details.panel > summary::marker { color: var(--ink-muted); }
.count {
    font-variant-numeric: tabular-nums;
    color: var(--ink-muted);
    letter-spacing: 0;
}

${RANKED_BARS_CSS}

/* ── Table ──────────────────────────────────────────────────────── */

.toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; }
.toolbar input {
    flex: 1;
    min-width: 0;
    padding: 4px 8px;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--hairline));
    border-radius: 3px;
    font-family: inherit;
    font-size: inherit;
}
.toolbar input:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.toolbar button {
    padding: 4px 10px;
    color: var(--vscode-button-secondaryForeground, var(--ink));
    background: var(--vscode-button-secondaryBackground, transparent);
    border: 1px solid var(--hairline);
    border-radius: 3px;
    cursor: pointer;
    font-family: inherit;
    font-size: inherit;
}
.toolbar button:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground)); }

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
thead th.num { text-align: right; }
/* Real buttons, so sorting works from the keyboard; styled as the header. */
thead th button {
    font: inherit;
    color: inherit;
    text-transform: inherit;
    letter-spacing: inherit;
    background: none;
    border: 0;
    padding: 0;
    cursor: pointer;
    user-select: none;
}
tbody td { padding: 3px 8px; }
tbody tr:hover { background: var(--vscode-list-hoverBackground); }
td.num { text-align: right; font-variant-numeric: tabular-nums; width: 96px; }
td.share { text-align: right; color: var(--ink-muted); width: 60px; font-variant-numeric: tabular-nums; font-size: .9em; }
/* A button that looks like a link: it opens a file, it does not navigate. */
.file-link {
    color: var(--vscode-textLink-foreground);
    cursor: pointer;
    text-decoration: none;
    font: inherit;
    text-align: left;
    background: none;
    border: 0;
    padding: 0;
}
.file-link:hover { text-decoration: underline; }
thead th button:focus-visible,
.file-link:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
.note, .empty { color: var(--ink-muted); font-size: 0.9em; margin: 10px 0 0; }
.truncation {
    color: var(--ink-muted);
    font-size: 0.9em;
    font-style: italic;
    margin: 10px 0 0;
}

.plain-list { list-style: none; padding: 0; margin: 10px 0 0; }
.plain-list li { display: flex; justify-content: space-between; gap: 16px; padding: 2px 0; }
.reason { color: var(--ink-muted); font-size: 0.88em; }
</style>
</head>
<body>
<div class="wrap">

<header>
    <div class="hero-value">${approx}${formatNumber(view.totalTokens)}</div>
    <div class="hero-meta">
        tokens · ${escapeHtml(view.modelLabel)}
        <span class="chip">${view.exact ? 'exact' : 'estimated'}</span>
    </div>
    ${
        view.cancelled
            ? '<p class="banner">Cancelled — this total covers only the files counted before you stopped it.</p>'
            : ''
    }
    ${contextMeter(view)}
    ${statRow(view)}
</header>

${breakdown('Where the tokens are', view.byFolder, 'Everything is in one folder.')}
${breakdown('By language', view.byLanguage, 'Everything is one language.')}

<section class="panel">
    <h2>Files</h2>
    <div class="toolbar">
        <input id="filter" type="search" placeholder="Filter by path…" aria-label="Filter files by path">
        <button id="copy" type="button">Copy</button>
        <button id="csv" type="button">Export CSV</button>
    </div>
    <table>
        <thead>
            <tr>
                <th aria-sort="none"><button type="button" data-sort="path">Path</button></th>
                <th aria-sort="descending" class="num"><button type="button" data-sort="tokens">Tokens</button></th>
                <th class="num">Share</th>
            </tr>
        </thead>
        <tbody id="rows"></tbody>
    </table>
    <p class="empty" id="empty" hidden>${
        view.files.length === 0
            ? 'No files were counted.'
            : 'No file matches that filter.'
    }</p>
    ${
        view.filesNotListed > 0
            ? `<p class="note">${view.filesNotListed.toLocaleString(
                  'en-US',
              )} smaller files are counted in the total but not listed.</p>`
            : ''
    }
</section>

${collapsibleList('Skipped', view.skipped, view.filesSkipped)}
${collapsibleList('Ignored', view.ignored, view.filesIgnored)}

</div>
<script nonce="${nonce}">
(function () {
    const vscode = acquireVsCodeApi();
    const FILES = ${embed(view.files)};
    const TOTAL = ${embed(view.totalTokens)};
    // The page discloses the row cap in its own note; the exports did not, so a
    // copied list or a CSV of the "whole" folder silently stopped at 1,000 rows.
    // A silent cap is how a partial list starts being mistaken for a complete one.
    // Rendered server-side and empty when nothing was dropped, so the wording
    // never appears in a page that has nothing to disclose.
    const TRUNCATION_NOTE = ${embed(
        view.filesNotListed > 0
            ? `${view.filesNotListed.toLocaleString()} smaller files are counted in the total but not listed`
            : '',
    )};

    const tbody = document.getElementById('rows');
    const empty = document.getElementById('empty');
    const filter = document.getElementById('filter');

    let sortKey = 'tokens';
    let ascending = false;
    let visible = FILES;

    const share = t => (TOTAL > 0 ? ((t / TOTAL) * 100).toFixed(1) + '%' : '—');
${PAGE_TEXT_HELPERS}
    function render() {
        const term = filter.value.trim().toLowerCase();
        visible = term ? FILES.filter(f => f.display.toLowerCase().includes(term)) : FILES.slice();

        visible.sort((a, b) => {
            const d = sortKey === 'tokens' ? a.tokens - b.tokens : a.display.localeCompare(b.display);
            return ascending ? d : -d;
        });

        // One string, one reflow: a row-at-a-time append is visibly slow at a
        // thousand rows.
        tbody.innerHTML = visible
            .map((f, i) =>
                '<tr><td><button type="button" class="file-link" data-i="' + i + '">' +
                escapeText(f.display) +
                '</button></td><td class="num">' +
                f.tokens.toLocaleString('en-US') +
                '</td><td class="share">' + share(f.tokens) + '</td></tr>')
            .join('');

        empty.hidden = visible.length > 0;
    }

    filter.addEventListener('input', render);

    // Sorting was a click handler on the header cell, which the keyboard
    // cannot reach; the cells now hold buttons. aria-sort sits on the cells,
    // so a screen reader says which column the rows follow, and which way.
    const sortButtons = document.querySelectorAll('button[data-sort]');
    function showSort() {
        sortButtons.forEach(button => {
            const state = button.dataset.sort !== sortKey ? 'none' : ascending ? 'ascending' : 'descending';
            button.parentElement.setAttribute('aria-sort', state);
        });
    }
    sortButtons.forEach(button => {
        button.addEventListener('click', () => {
            const key = button.dataset.sort;
            ascending = key === sortKey ? !ascending : key === 'path';
            sortKey = key;
            showSort();
            render();
        });
    });

    // One delegated listener rather than one per row.
    tbody.addEventListener('click', e => {
        const link = e.target.closest('.file-link');
        if (!link) { return; }
        const file = visible[Number(link.dataset.i)];
        if (file) { vscode.postMessage({ command: 'openFile', path: file.path }); }
    });

    document.getElementById('copy').addEventListener('click', () => {
        const lines = visible.map(f => pasteCell(f.display) + '\\t' + f.tokens);
        if (TRUNCATION_NOTE) {
            lines.push('# ' + TRUNCATION_NOTE);
        }
        vscode.postMessage({ command: 'copy', text: lines.join('\\n') });
    });

    document.getElementById('csv').addEventListener('click', () => {
        const rows = [['path', 'tokens'], ...visible.map(f => [f.display, String(f.tokens)])];
        if (TRUNCATION_NOTE) {
            rows.push([TRUNCATION_NOTE, '']);
        }
        vscode.postMessage({
            command: 'export',
            text: rows.map(r => r.map(csv).join(',')).join('\\n'),
        });
    });

    showSort();
    render();
})();
</script>
</body>
</html>`;
}
