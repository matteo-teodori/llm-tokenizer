/**
 * The Claude Code Usage panel: one, reused, and not kept alive while hidden.
 *
 * It holds the service while visible, so imports follow watcher hints, and
 * lets go when hidden. The page is rendered once; after that the panel posts
 * fragments only when they change, and a page brought back from hidden asks
 * for them again with `ready`. What the page may ask for is a fixed list, and
 * every field is checked before it is used.
 */

import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { contentSecurityPolicy, createNonce } from '../html';
import { modelById } from '../tokenizer/registry';
import { isTimeZone, localMinute } from './aggregate';
import { renderFragments, renderUsagePage, type PanelFragments, type PanelView } from './render';
import { RANGE_KEYS, type RangeKey } from './report';
import { sourceLabel, tildePath } from './roots';
import type { UsageService } from './usageService';

/** Remembered between sessions: the zone the page reported, the range and the scope. */
const STATE_KEY = 'llm-tokenizer.claudeCodeUsage.panel';

/**
 * The zone the panel's page last reported: the reader's own, even in a
 * remote window, where the extension host's can be another machine's.
 */
export function savedZone(context: vscode.ExtensionContext): string | undefined {
    const zone = context.globalState.get<Partial<PanelState>>(STATE_KEY)?.zone;
    return zone && isTimeZone(zone) ? zone : undefined;
}

/** Copied or exported text is the page's own rendering of what it was sent; far more is not that. */
const MAX_EXPORT_CHARS = 16 << 20;

/** What the page may ask for. */
export type PanelMessage =
    | { type: 'ready'; zone: string }
    | { type: 'refresh' }
    | { type: 'setRange'; range: RangeKey }
    | { type: 'setScope'; scope: 'all' | 'workspace' }
    | { type: 'copy'; text: string }
    | { type: 'export'; text: string }
    | { type: 'openSettings' }
    | { type: 'chooseFolder' }
    | { type: 'clear' }
    | { type: 'showLog' };

/** The message, checked field by field, or undefined for anything else. */
export function parsePanelMessage(raw: unknown): PanelMessage | undefined {
    if (typeof raw !== 'object' || raw === null) {
        return undefined;
    }
    const m = raw as Record<string, unknown>;
    switch (m.type) {
        case 'ready':
            return typeof m.zone === 'string' && m.zone.length <= 100 && isTimeZone(m.zone) ? { type: 'ready', zone: m.zone } : undefined;
        case 'setRange':
            return RANGE_KEYS.includes(m.range as RangeKey) ? { type: 'setRange', range: m.range as RangeKey } : undefined;
        case 'setScope':
            return m.scope === 'all' || m.scope === 'workspace' ? { type: 'setScope', scope: m.scope } : undefined;
        case 'copy':
        case 'export':
            return typeof m.text === 'string' && m.text.length <= MAX_EXPORT_CHARS ? { type: m.type, text: m.text } : undefined;
        case 'refresh':
        case 'openSettings':
        case 'chooseFolder':
        case 'clear':
        case 'showLog':
            return { type: m.type };
        default:
            return undefined;
    }
}

interface PanelState {
    zone: string;
    range: RangeKey;
    scope: 'all' | 'workspace';
}

export class UsagePanel implements vscode.Disposable {
    private static current: UsagePanel | undefined;

    private readonly disposables: vscode.Disposable[] = [];
    private hold: vscode.Disposable | undefined;
    private state: PanelState;
    private lastPosted = '';
    private lastFragments: PanelFragments | undefined;
    private refreshedAt: number | undefined;
    private updating = Promise.resolve();

    /** Show the panel, creating it on first use, and refresh what it shows. */
    static show(context: vscode.ExtensionContext, service: UsageService, log: vscode.LogOutputChannel): void {
        if (UsagePanel.current) {
            UsagePanel.current.panel.reveal();
            void UsagePanel.current.refresh();
            return;
        }
        const panel = vscode.window.createWebviewPanel('llmTokenizer.claudeCodeUsage', 'Claude Code Usage', vscode.ViewColumn.Active, {
            enableScripts: true,
            // The page is self-contained: nothing on disk is needed.
            localResourceRoots: [],
        });
        UsagePanel.current = new UsagePanel(panel, context, service, log);
    }

    private constructor(
        private readonly panel: vscode.WebviewPanel,
        private readonly context: vscode.ExtensionContext,
        private readonly service: UsageService,
        private readonly log: vscode.LogOutputChannel,
    ) {
        const saved = context.globalState.get<Partial<PanelState>>(STATE_KEY);
        this.state = {
            zone: saved?.zone && isTimeZone(saved.zone) ? saved.zone : Intl.DateTimeFormat().resolvedOptions().timeZone,
            range: saved?.range && RANGE_KEYS.includes(saved.range) ? saved.range : '7d',
            scope: saved?.scope === 'workspace' ? 'workspace' : 'all',
        };
        this.hold = service.hold();
        this.disposables.push(
            panel.onDidDispose(() => this.dispose()),
            panel.onDidChangeViewState(() => {
                if (panel.visible && !this.hold) {
                    // Nothing was imported while hidden: look now.
                    this.hold = service.hold();
                    void this.refresh();
                } else if (!panel.visible) {
                    this.hold?.dispose();
                    this.hold = undefined;
                    // Not kept alive while hidden: the page comes back from
                    // its HTML, so that HTML is made the latest.
                    this.setPage(this.lastFragments ?? this.fragmentsWithoutData());
                }
            }),
            panel.webview.onDidReceiveMessage((raw: unknown) => void this.receive(raw)),
            service.onDidChange(() => void this.update(false)),
        );
        this.setPage(this.fragmentsWithoutData());
        // Opening the panel is one of the times a full pass runs.
        void this.refresh();
    }

    private setPage(fragments: PanelFragments): void {
        const nonce = createNonce();
        this.panel.webview.html = renderUsagePage(nonce, contentSecurityPolicy(nonce), fragments);
    }

    dispose(): void {
        UsagePanel.current = undefined;
        this.hold?.dispose();
        this.hold = undefined;
        for (const d of this.disposables) {
            d.dispose();
        }
        this.panel.dispose();
    }

    private async refresh(): Promise<void> {
        // Stamped only when a pass ran: not when it failed, or waits on
        // another window's.
        if (await this.service.refresh()) {
            this.refreshedAt = Date.now();
        }
        await this.update(false);
    }

    private async receive(raw: unknown): Promise<void> {
        const message = parsePanelMessage(raw);
        if (!message) {
            return;
        }
        switch (message.type) {
            case 'ready':
                this.state.zone = message.zone;
                await this.saveState();
                // A page brought back from hidden starts empty: always answer.
                await this.update(true);
                return;
            case 'refresh':
                await this.refresh();
                return;
            case 'setRange':
                this.state.range = message.range;
                await this.saveState();
                await this.update(false);
                return;
            case 'setScope':
                this.state.scope = message.scope;
                await this.saveState();
                await this.update(false);
                return;
            case 'copy':
            case 'export':
                await vscode.env.clipboard.writeText(message.text);
                void vscode.window.showInformationMessage(
                    message.type === 'export' ? 'LLM Tokenizer: usage CSV copied to the clipboard.' : 'LLM Tokenizer: sessions copied to the clipboard.',
                );
                return;
            case 'openSettings':
                await vscode.commands.executeCommand('workbench.action.openSettings', 'llm-tokenizer.enableClaudeCodeUsage');
                return;
            case 'chooseFolder':
                await this.chooseFolder();
                return;
            case 'clear':
                await vscode.commands.executeCommand('llm-tokenizer.clearClaudeCodeUsageHistory');
                return;
            case 'showLog':
                this.log.show();
                return;
        }
    }

    /** Ask for Claude Code's folder; a `projects` folder picked by mistake means its parent. */
    private async chooseFolder(): Promise<void> {
        const picked = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: 'Use This Folder',
            title: "Claude Code's configuration folder, the one that contains projects",
        });
        const folder = picked?.[0]?.fsPath;
        if (!folder) {
            return;
        }
        const root = path.basename(folder) === 'projects' ? path.dirname(folder) : folder;
        await vscode.workspace
            .getConfiguration('llm-tokenizer')
            .update('claudeCodeDataDirectory', root, vscode.ConfigurationTarget.Global);
    }

    private async saveState(): Promise<void> {
        await this.context.globalState.update(STATE_KEY, this.state);
    }

    /** Post the fragments if they changed, one update at a time; one failing never stops the next. */
    private update(force: boolean): Promise<void> {
        this.updating = this.updating
            .then(async () => {
                const fragments = renderFragments(await this.view());
                this.lastFragments = fragments;
                const serialised = JSON.stringify(fragments);
                if (force || serialised !== this.lastPosted) {
                    this.lastPosted = serialised;
                    await this.panel.webview.postMessage({ type: 'data', fragments });
                }
            })
            .catch((error: unknown) => {
                this.log.warn(`Claude Code usage panel: could not update (${error instanceof Error ? error.name : 'Error'})`);
            });
        return this.updating;
    }

    private fragmentsWithoutData(): PanelFragments {
        return renderFragments(this.viewOf(undefined));
    }

    private async view(): Promise<PanelView> {
        const folders =
            this.state.scope === 'workspace'
                ? (vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file').map(f => f.uri.fsPath)
                : null;
        const report = await this.service.report(this.state.range, this.state.zone, folders);
        return this.viewOf(report);
    }

    private viewOf(report: PanelView['report']): PanelView {
        const zone = this.state.zone;
        const resolved = this.service.roots;
        const summary = this.service.lastImport;
        const version = (this.context.extension.packageJSON as { version?: unknown }).version;
        const remote = vscode.env.remoteName;
        return {
            status: this.service.status,
            range: this.state.range,
            scope: this.state.scope,
            zone,
            where: remote ? `on ${os.hostname()} (${remote})` : '',
            remote: remote !== undefined,
            report,
            modelLabel: id => modelById(id)?.label ?? id,
            roots: (resolved?.candidates ?? []).map(c => ({ path: tildePath(c.path), source: sourceLabel(c.source), exists: c.exists })),
            historyDisabled: resolved?.historyDisabled ?? false,
            lastImport: summary && {
                files: summary.files,
                read: summary.read,
                skipped: summary.skipped,
                malformed: summary.malformed as Record<string, number>,
                oversizeLines: summary.oversizeLines,
                synthetic: summary.synthetic,
                apiErrors: summary.apiErrors,
                symlinkedFolders: summary.symlinkedFolders,
                unreadableFolders: summary.unreadableFolders,
                elapsedMs: summary.elapsedMs,
            },
            sqliteRuntime: this.service.missingSqlite,
            recoveredFrom: this.service.recoveredFrom,
            extensionVersion: typeof version === 'string' ? version : '',
            refreshedAt: this.refreshedAt,
            formatTime: ms => localMinute(ms, zone),
            // A dash stays a dash.
            formatDate: ms => localMinute(ms, zone).slice(0, 10),
        };
    }
}
