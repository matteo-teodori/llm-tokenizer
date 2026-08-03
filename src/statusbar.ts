import * as vscode from 'vscode';

import { formatNumber } from './utils';
import { CONTEXT_ERROR_THRESHOLD, CONTEXT_WARNING_THRESHOLD } from './constants';
import type { ModelInfo } from './tokenizer/registry';

/** The manifest's default; the code used to disagree with it and fall back to 'file'. */
const DEFAULT_DISPLAY_MODE = 'both';

export interface CountDisplay {
    count: number;
    /** False when the number came from a heuristic rather than a real tokenizer. */
    exact: boolean;
    model: ModelInfo;
    isSelection?: boolean;
    projectScanEnabled: boolean;
}

/**
 * The two status bar items.
 *
 * Estimated counts are prefixed with `≈`. v1.3.0 rendered a ±25% guess in the
 * same typeface and with the same authority as an exact tiktoken count, which
 * is the part users could not see and could not correct for.
 */
export class StatusBarManager {
    private readonly fileItem: vscode.StatusBarItem;
    private readonly projectItem: vscode.StatusBarItem;
    private hasFileCount = false;
    private hasProjectCount = false;

    constructor(context: vscode.ExtensionContext) {
        this.fileItem = vscode.window.createStatusBarItem('llm-tokenizer.file', vscode.StatusBarAlignment.Right, 100);
        this.fileItem.name = 'LLM Tokenizer: file';
        this.fileItem.command = 'llm-tokenizer.selectModel';

        this.projectItem = vscode.window.createStatusBarItem('llm-tokenizer.project', vscode.StatusBarAlignment.Right, 99);
        this.projectItem.name = 'LLM Tokenizer: project';
        this.projectItem.command = 'llm-tokenizer.selectModel';

        context.subscriptions.push(this.fileItem, this.projectItem);
    }

    public showFileCount(display: CountDisplay): void {
        const status = contextStatus(display.count, display.model);
        const scope = display.isSelection ? 'selection' : 'file';

        this.fileItem.text = `${icon(status)} ${prefix(display.exact)}${formatNumber(display.count)} tokens${display.isSelection ? ' (selection)' : ''}`;
        applyStatusColour(this.fileItem, status);
        this.fileItem.tooltip = tooltip(`Tokens in the current ${scope}`, display, status);
        this.hasFileCount = true;

        this.applyDisplayMode(display.projectScanEnabled);
    }

    public clearFileCount(): void {
        this.hasFileCount = false;
        this.fileItem.hide();
    }

    public showProjectCount(display: CountDisplay): void {
        const status = contextStatus(display.count, display.model);

        this.projectItem.text = `$(folder) ${prefix(display.exact)}${formatNumber(display.count)} tokens`;
        applyStatusColour(this.projectItem, status);
        this.projectItem.tooltip = tooltip('Tokens across the whole workspace', display, status);
        this.hasProjectCount = true;

        this.applyDisplayMode(display.projectScanEnabled);
    }

    public clearProjectCount(): void {
        this.hasProjectCount = false;
        this.projectItem.hide();
    }

    /**
     * Show or hide each item according to `statusBarDisplay`.
     *
     * When project scanning is off, `project` mode is treated as `file` — the
     * naive reading hides both items and makes the extension look uninstalled.
     */
    public applyDisplayMode(projectScanEnabled: boolean): void {
        const configured = vscode.workspace
            .getConfiguration('llm-tokenizer')
            .get<string>('statusBarDisplay', DEFAULT_DISPLAY_MODE);

        const mode = configured === 'project' && !projectScanEnabled ? 'file' : configured;
        const showProject = projectScanEnabled && this.hasProjectCount && mode !== 'file';

        // `hasFileCount` matters: with no editor open there is no count to
        // show, and re-showing the item would resurrect whatever number was
        // last written to it — belonging to a file the user has since closed.
        if (!this.hasFileCount || (mode === 'project' && showProject)) {
            this.fileItem.hide();
        } else {
            this.fileItem.show();
        }

        if (showProject) {
            this.projectItem.show();
        } else {
            this.projectItem.hide();
        }
    }
}

type Status = 'ok' | 'warning' | 'error';

function contextStatus(count: number, model: ModelInfo): Status {
    if (!model.contextLimit) {
        return 'ok';
    }
    const percentage = (count / model.contextLimit) * 100;
    if (percentage >= CONTEXT_ERROR_THRESHOLD) {
        return 'error';
    }
    return percentage >= CONTEXT_WARNING_THRESHOLD ? 'warning' : 'ok';
}

/** Codicons rather than emoji: emoji render inconsistently across platforms. */
function icon(status: Status): string {
    switch (status) {
        case 'error': return '$(error)';
        case 'warning': return '$(warning)';
        default: return '$(symbol-numeric)';
    }
}

/**
 * Colour a status bar item for its context-limit status.
 *
 * Sets `backgroundColor`, not `color`. VS Code registers
 * `statusBarItem.errorForeground` and `statusBarItem.warningForeground` as
 * plain white for *every* theme, because they are meant to sit on the matching
 * red or amber background. Setting the foreground alone therefore painted white
 * text onto the ordinary status bar — legible on a dark theme, invisible on a
 * light one, which is precisely when a user most needs to see that they are
 * over the context limit.
 *
 * `backgroundColor` accepts only these two colours, and the API guarantees the
 * status bar will pick a readable foreground to go with them.
 */
function applyStatusColour(item: vscode.StatusBarItem, status: Status): void {
    // Cleared explicitly: a badge left over from a previous file would
    // otherwise stay behind on a count that is now well within limits.
    item.color = undefined;

    switch (status) {
        case 'error':
            item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
            break;
        case 'warning':
            item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            break;
        default:
            item.backgroundColor = undefined;
    }
}

function prefix(exact: boolean): string {
    return exact ? '' : '≈';
}

function tooltip(title: string, display: CountDisplay, status: Status): vscode.MarkdownString {
    const lines = [`**${title}**`, '', `Model: ${display.model.label}`];

    if (display.model.contextLimit) {
        const percentage = (display.count / display.model.contextLimit) * 100;
        lines.push(`Context: ${percentage.toFixed(1)}% of ${formatNumber(display.model.contextLimit)}`);
        if (status === 'warning') {
            lines.push('', '⚠️ Approaching the context limit.');
        } else if (status === 'error') {
            lines.push('', '🔴 Over the context limit.');
        }
    }

    if (!display.exact) {
        lines.push(
            '',
            display.model.encoder.kind === 'hf'
                ? '_Estimated._ Run **LLM Tokenizer: Download Exact Tokenizer** for an exact count.'
                : `_Estimated._ ${display.model.provider} does not publish a tokenizer for this model.`,
        );
    }

    lines.push('', 'Click to change model.');

    const markdown = new vscode.MarkdownString(lines.join('\n'));
    markdown.supportThemeIcons = true;
    return markdown;
}
