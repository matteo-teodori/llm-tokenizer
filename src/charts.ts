/**
 * Chart pieces for the extension's webview pages: the theme tokens they are
 * coloured with, a meter, and ranked bars.
 *
 * Colours come entirely from VS Code's own theme tokens, so a page follows the
 * editor into any theme rather than shipping a palette that only works in one.
 * `charts.*` are the tokens VS Code publishes for exactly this. Every piece of
 * text these are given is escaped here.
 */

import { escapeHtml } from './html';
import { formatNumber } from './utils';

/** How close a value is to its limit; the meter's colour follows it. */
export type Severity = 'ok' | 'warning' | 'error';

/** One ranked bar: what it is, its value, and its share of the whole. */
export interface RankedValue {
    label: string;
    tokens: number;
    share: number;
}

/** The custom properties every page and chart is coloured with. */
export const THEME_TOKENS_CSS = `:root {
    /* One accent for every data mark. Severity recolours the meter only. */
    --accent: var(--vscode-charts-blue, #3794ff);
    --warning: var(--vscode-charts-yellow, #cca700);
    --danger: var(--vscode-charts-red, #f14c4c);
    --surface: var(--vscode-editor-background);
    --ink: var(--vscode-foreground);
    --ink-muted: var(--vscode-descriptionForeground);
    --hairline: var(--vscode-panel-border, rgba(128,128,128,.35));
}`;

export const METER_CSS = `/* ── Meter ──────────────────────────────────────────────────────── */

.meter { margin-top: 18px; }
/* The unfilled track is a lighter step of the same ramp, so the state reads
   across the whole bar rather than only where it is filled. */
.meter-track {
    height: 10px;
    border-radius: 5px;
    background: color-mix(in srgb, var(--accent) 18%, transparent);
    overflow: hidden;
}
.meter-fill {
    height: 100%;
    background: var(--accent);
    border-radius: 5px 0 0 5px;
}
.meter[data-severity="warning"] .meter-track { background: color-mix(in srgb, var(--warning) 18%, transparent); }
.meter[data-severity="warning"] .meter-fill  { background: var(--warning); }
.meter[data-severity="error"]   .meter-track { background: color-mix(in srgb, var(--danger) 18%, transparent); }
.meter[data-severity="error"]   .meter-fill  { background: var(--danger); }
.meter-caption { margin-top: 6px; color: var(--ink-muted); font-size: 0.92em; }
.meter-note { color: var(--ink-muted); margin-top: 14px; }`;

export const RANKED_BARS_CSS = `/* ── Ranked bars ────────────────────────────────────────────────── */

.chart { display: flex; flex-direction: column; gap: 2px; }
.row {
    display: grid;
    grid-template-columns: minmax(90px, 190px) 1fr 76px 46px;
    align-items: center;
    gap: 12px;
    /* Caps the bar well below the row height so the leftover is air, not ink. */
    min-height: 26px;
}
.row-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.92em;
}
.row-track { height: 100%; display: flex; align-items: center; }
.row-bar {
    height: 14px;
    background: var(--accent);
    /* Rounded at the data end, square against the baseline. */
    border-radius: 0 4px 4px 0;
    min-width: 2px;
}
.row-value {
    text-align: right;
    font-variant-numeric: tabular-nums;
    font-size: 0.92em;
}
.row-share {
    text-align: right;
    font-variant-numeric: tabular-nums;
    color: var(--ink-muted);
    font-size: 0.85em;
}

@media (max-width: 620px) {
    .row { grid-template-columns: minmax(70px, 1fr) 1fr 62px; }
    .row-share { display: none; }
}`;

/**
 * A meter: one ratio against a limit. The fill is clamped to the track, so a
 * value far over the limit cannot spill out of the panel; `figure` and
 * `caption` sit beside it, and `name` is what a screen reader calls it.
 */
export function meter(
    share: number,
    severity: Severity,
    figure: string,
    caption: string,
    name: string,
): string {
    const filled = Math.min(share, 1) * 100;

    // A meter role, so assistive technology announces a value rather than
    // two bare boxes. aria-valuenow must stay inside its range, so it is
    // clamped like the fill, and aria-valuetext carries the real figure.
    return `
    <div class="meter" data-severity="${severity}" role="meter" aria-label="${escapeHtml(name)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(filled)}" aria-valuetext="${escapeHtml(`${figure} ${caption}`)}">
        <div class="meter-track"><div class="meter-fill" style="width: ${filled.toFixed(2)}%"></div></div>
        <div class="meter-caption"><strong>${escapeHtml(figure)}</strong> ${escapeHtml(caption)}</div>
    </div>`;
}

/** One ranked-bar row, its width relative to the widest row's. */
export function rankedBar(row: RankedValue, widest: number): string {
    // Relative to the largest bar, so the longest row fills the track and the
    // rest stay comparable against it.
    const width = widest > 0 ? (row.tokens / widest) * 100 : 0;
    const percent = (row.share * 100).toFixed(row.share >= 0.1 ? 0 : 1);

    return `
        <div class="row">
            <div class="row-label" title="${escapeHtml(row.label)}">${escapeHtml(row.label)}</div>
            <div class="row-track">
                <div class="row-bar" style="width: ${width.toFixed(2)}%"></div>
            </div>
            <div class="row-value">${formatNumber(row.tokens)}</div>
            <div class="row-share">${percent}%</div>
        </div>`;
}

/**
 * Ranked bars on a common baseline, in the order given, every bar in the one
 * accent colour: the categories have no natural order, and shading them by
 * size would encode length twice.
 */
export function rankedBars(rows: RankedValue[]): string {
    // A loop, not a spread: a spread of a very long list overflows the stack.
    let widest = 0;
    for (const row of rows) {
        widest = Math.max(widest, row.tokens);
    }
    return `<div class="chart">${rows.map(r => rankedBar(r, widest)).join('')}</div>`;
}
