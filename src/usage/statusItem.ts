/**
 * This workspace's live Claude Code context, in the status bar: off by
 * default, and shown only while a Claude Code session runs in a folder of the
 * workspace. Its own item, apart from StatusBarManager: those are about token
 * counts of files, and their tests index items by creation order.
 *
 * What it shows is the context of the session's latest request in its main
 * conversation (input, cache writes and cache reads of that one request), or,
 * when a compaction came after it, what the compaction left. A share of the
 * window, and the warning colours with it, only where the window is known:
 * the record's own model by exact id, never the tokenizer's selected model,
 * with Claude Code's own rules for which window it ran in. Otherwise the
 * figure stands alone, with a `?`.
 */

import * as vscode from 'vscode';

import { applyStatusColour, contextStatus, type Status } from '../statusbar';
import { modelById, type ModelInfo } from '../tokenizer/registry';
import { formatNumber } from '../utils';
import type { LiveSession } from './liveSessions';
import { inFolders } from './queries';
import type { LatestRequest } from './store';
import type { Compaction } from './types';
import type { UsageService } from './usageService';

/** The window CLAUDE_CODE_DISABLE_1M_CONTEXT holds every model to. */
const HELD_WINDOW = 200_000;

/** How often the item looks again while shown, whatever else is visible. */
export const LIVE_TICK_MS = 60_000;

/**
 * The context window a request ran with in Claude Code, or undefined when it
 * cannot be known: an id the registry does not list, or one with no limit.
 *
 * `[1m]` selects the larger window where a model has two; per Claude Code's
 * model configuration docs, Opus 4.6 and Sonnet 4.6 reach 1M only with it,
 * and the newer models have 1M either way. CLAUDE_CODE_DISABLE_1M_CONTEXT
 * holds them all to 200K.
 */
export function contextWindow(model: ModelInfo | undefined, variant: string | null, largeContextDisabled: boolean): number | undefined {
    if (!model?.contextLimit) {
        return undefined;
    }
    const window = variant === '1m' ? model.contextLimit : (model.claudeCodeBaseContext ?? model.contextLimit);
    return largeContextDisabled ? Math.min(window, HELD_WINDOW) : window;
}

export interface LiveInput {
    latest: LatestRequest | null;
    /** Newest first. */
    compactions: readonly Compaction[];
    largeContextDisabled: boolean;
    todayProcessed: { tokens: number; partial: boolean } | undefined;
    formatTime(epochMs: number): string;
}

export interface LiveView {
    text: string;
    tooltip: string[];
    /** Undefined: no share, so no colour. */
    status: Status | undefined;
}

/** What the item shows for a session; pure, for its tests. */
export function describeLive(input: LiveInput): LiveView {
    const { latest } = input;
    const compaction = input.compactions[0];
    const afterCompaction = compaction !== undefined && (latest === null || compaction.timestamp > latest.timestamp);
    const occupancy = afterCompaction
        ? compaction.postTokens
        : latest && latest.input !== null && latest.cacheCreation !== null && latest.cacheRead !== null
          ? latest.input + latest.cacheCreation + latest.cacheRead
          : null;
    const model = latest ? modelById(latest.model) : undefined;
    const window = latest ? contextWindow(model, latest.variant, input.largeContextDisabled) : undefined;
    const share = occupancy !== null && window !== undefined && occupancy <= window ? occupancy / window : undefined;
    const status = share !== undefined && model && window !== undefined ? contextStatus(occupancy ?? 0, { ...model, contextLimit: window }) : undefined;

    const figure = occupancy === null ? '—' : formatNumber(occupancy);
    const icon = status === 'error' ? '$(error)' : status === 'warning' ? '$(warning)' : '$(comment-discussion)';
    const text =
        share !== undefined ? `${icon} ${figure} · ${percent(share)}` : occupancy === null ? `${icon} ${figure}` : `${icon} ${figure} ?`;

    // Plain text, never Markdown: a model id comes from a record, and could
    // otherwise render as a link.
    const tooltip = ['Claude Code, in this workspace', ''];
    if (occupancy === null) {
        tooltip.push(afterCompaction ? 'Context: compacted; its size after was not recorded.' : 'Context: not reported yet.');
    } else if (share !== undefined && window !== undefined) {
        tooltip.push(`Context: ${occupancy.toLocaleString('en-US')} of ${window.toLocaleString('en-US')} tokens (${percent(share)})${afterCompaction ? ', after compacting' : ''}.`);
    } else {
        tooltip.push(
            `Context: ${occupancy.toLocaleString('en-US')} tokens${afterCompaction ? ', after compacting' : ''}. ${
                window === undefined ? 'The window of this model is not known here.' : 'More than the window this model was thought to have.'
            }`,
        );
    }
    if (latest) {
        tooltip.push(`Model: ${model?.label ?? latest.model}${latest.variant ? ` (${latest.variant})` : ''}`);
        tooltip.push(`Last request: ${input.formatTime(latest.timestamp)}`);
    }
    if (input.compactions.length > 0) {
        const last = input.compactions[0];
        tooltip.push(
            `Compactions: ${input.compactions.length.toLocaleString('en-US')}${input.compactions.length === 20 ? ' or more' : ''}, the last ${
                last.preTokens?.toLocaleString('en-US') ?? '?'
            } → ${last.postTokens?.toLocaleString('en-US') ?? '?'}`,
        );
    }
    if (input.todayProcessed) {
        tooltip.push(`Today in this workspace: ${input.todayProcessed.partial ? '≥' : ''}${formatNumber(input.todayProcessed.tokens)} processed`);
    }
    tooltip.push('', 'Click to show Claude Code usage.');
    return { text, tooltip, status };
}

function percent(share: number): string {
    // Truncated, as the summary's meter is: never a threshold not crossed.
    return `${Math.floor(share * 100)}%`;
}

/** What the item needs from the rest of the extension, injected so a test can fake each. */
export interface StatusItemDeps {
    /** Both settings: the feature, and the item. */
    shown(): boolean;
    readLive(roots: readonly string[]): Promise<LiveSession[]>;
    workspaceFolders(): string[];
    platform: NodeJS.Platform;
    zone(): string;
    formatTime: (epochMs: number) => string;
    createItem(): vscode.StatusBarItem;
}

export type StatusItemService = Pick<UsageService, 'roots' | 'liveContext' | 'report' | 'onDidChange' | 'hold'>;

export class UsageStatusItem implements vscode.Disposable {
    private item: vscode.StatusBarItem | undefined;
    private hold: vscode.Disposable | undefined;
    private timer: NodeJS.Timeout | undefined;
    private refreshing: Promise<void> | undefined;
    private readonly listener: vscode.Disposable;

    constructor(
        private readonly service: StatusItemService,
        private readonly deps: StatusItemDeps,
    ) {
        this.listener = service.onDidChange(() => void this.refresh());
        this.settingsChanged();
    }

    /** Show or remove the item as the settings now say. */
    settingsChanged(): void {
        const shown = this.deps.shown();
        if (shown && !this.item) {
            this.item = this.deps.createItem();
            this.item.name = 'LLM Tokenizer: Claude Code usage';
            this.item.command = 'llm-tokenizer.showClaudeCodeUsage';
            // Resident while shown: watcher hints keep the session current.
            this.hold = this.service.hold();
            this.timer = setInterval(() => void this.refresh(), LIVE_TICK_MS);
            void this.refresh();
        } else if (!shown && this.item) {
            this.remove();
        }
    }

    dispose(): void {
        this.remove();
        this.listener.dispose();
    }

    private remove(): void {
        clearInterval(this.timer);
        this.timer = undefined;
        this.hold?.dispose();
        this.hold = undefined;
        this.item?.dispose();
        this.item = undefined;
    }

    /** Look again; a call during a look waits for it rather than starting another. */
    refresh(): Promise<void> {
        this.refreshing ??= this.look().finally(() => (this.refreshing = undefined));
        return this.refreshing;
    }

    private async look(): Promise<void> {
        const item = this.item;
        const resolved = this.service.roots;
        if (!item || !resolved) {
            return;
        }
        const folders = this.deps.workspaceFolders();
        const live = (await this.deps.readLive(resolved.roots.map(r => r.path))).find(s =>
            inFolders(s.cwd, folders, this.deps.platform),
        );
        if (item !== this.item) {
            return;
        }
        // Nothing reads as live without a running session in this workspace.
        if (!live) {
            item.hide();
            return;
        }
        const context = await this.service.liveContext(live.sessionId);
        if (item !== this.item) {
            return;
        }
        if (!context) {
            item.text = '$(comment-discussion) —';
            item.tooltip = 'Claude Code usage is unavailable just now; the log says why.';
            applyStatusColour(item, 'ok');
            item.show();
            return;
        }
        const report = await this.service.report('today', this.deps.zone(), folders);
        if (item !== this.item) {
            return;
        }
        const view = describeLive({
            ...context,
            largeContextDisabled: resolved.largeContextDisabled,
            todayProcessed: report && { tokens: report.totals.processed, partial: report.totals.provenance === 'partial' },
            formatTime: this.deps.formatTime,
        });
        item.text = view.text;
        item.tooltip = view.tooltip.join('\n');
        applyStatusColour(item, view.status ?? 'ok');
        item.show();
    }
}
