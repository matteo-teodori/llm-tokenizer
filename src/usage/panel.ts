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
import { logoIcon } from '../logo';
import { modelById } from '../tokenizer/registry';
import { ALL_ACCOUNTS, MAX_GIVEN_NAME, accountLabels, givenNames, isAccountFilter, isAccountId, nameReplaces, showable } from './accounts';
import { isTimeZone, localMinute } from './aggregate';
import { renderFragments, renderUsagePage, type PanelFragments, type PanelView } from './render';
import { RANGE_KEYS, type RangeKey, type UsageReport } from './report';
import { sourceLabel, tildePath } from './roots';
import { CONFIG_SECTION } from './settings';
import type { UsageService } from './usageService';

/** Remembered between sessions: the zone the page reported, the range, the scope and the account. */
const STATE_KEY = 'llm-tokenizer.claudeCodeUsage.panel';

/** The names you give accounts, by account id: an application setting, so no repository can rename one. */
export const GIVEN_NAMES_SETTING = 'claudeCodeAccountNames';

/** The names you gave accounts, as the setting holds them now: none where it cannot be read. */
function readGivenNames(): Record<string, string> {
    try {
        return givenNames(vscode.workspace.getConfiguration(CONFIG_SECTION).get<unknown>(GIVEN_NAMES_SETTING));
    } catch {
        // Only names: the page shows Claude Code's own instead.
        return {};
    }
}

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

/**
 * This feature's settings, where they apply. They are machine settings, so
 * in a remote window only the remote ones count: User settings would be
 * ignored there. The query goes as an object, the one form the remote
 * command reads (VS Code 1.105 drops a string).
 */
export async function openUsageSettings(remoteName: string | undefined = vscode.env.remoteName): Promise<void> {
    const command = remoteName ? 'workbench.action.openRemoteSettings' : 'workbench.action.openSettings';
    await vscode.commands.executeCommand(command, { query: 'llm-tokenizer.enableClaudeCodeUsage' });
}

/**
 * Turn the feature on, from the off page's Turn On: the person's own click,
 * so reading Claude Code's records stays something they chose. At the user
 * level, which VS Code turns into the remote host's settings in a remote
 * window, for a machine setting (`toEditableConfigurationTarget` in its
 * configurationService.ts, 1.105 and since): where the setting applies.
 */
export async function turnOnUsage(): Promise<void> {
    try {
        await vscode.workspace.getConfiguration(CONFIG_SECTION).update('enableClaudeCodeUsage', true, vscode.ConfigurationTarget.Global);
    } catch {
        // A settings file VS Code will not write, one with errors in it say:
        // its Settings editor says why, and turns it on there.
        if (await vscode.window.showErrorMessage('LLM Tokenizer: Claude Code usage could not be turned on here.', 'Open Settings')) {
            await openUsageSettings();
        }
    }
}

/** What the page may ask for. */
export type PanelMessage =
    | { type: 'ready'; zone: string }
    | { type: 'refresh' }
    | { type: 'setRange'; range: RangeKey }
    | { type: 'setScope'; scope: 'all' | 'workspace' }
    /** `choice`: the page's number for it, which the updates after it carry back. */
    | { type: 'setAccount'; account: string; choice: number }
    | { type: 'nameAccount'; account: string }
    | { type: 'copy'; text: string }
    | { type: 'export'; text: string }
    | { type: 'turnOn' }
    | { type: 'openSettings' }
    | { type: 'chooseFolder' }
    | { type: 'clear' }
    | { type: 'showLog' }
    | { type: 'reloadWindow' };

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
        case 'setAccount':
            return isAccountFilter(m.account)
                ? { type: 'setAccount', account: m.account, choice: Number.isSafeInteger(m.choice) && (m.choice as number) >= 0 ? (m.choice as number) : 0 }
                : undefined;
        case 'nameAccount':
            return isAccountId(m.account) ? { type: 'nameAccount', account: m.account } : undefined;
        case 'copy':
        case 'export':
            return typeof m.text === 'string' && m.text.length <= MAX_EXPORT_CHARS ? { type: m.type, text: m.text } : undefined;
        case 'refresh':
        case 'turnOn':
        case 'openSettings':
        case 'chooseFolder':
        case 'clear':
        case 'showLog':
        case 'reloadWindow':
            return { type: m.type };
        default:
            return undefined;
    }
}

interface PanelState {
    zone: string;
    range: RangeKey;
    scope: 'all' | 'workspace';
    /** ALL_ACCOUNTS, or one account's key. */
    account: string;
}

export class UsagePanel implements vscode.Disposable {
    private static current: UsagePanel | undefined;

    private readonly disposables: vscode.Disposable[] = [];
    private hold: vscode.Disposable | undefined;
    private state: PanelState;
    private lastPosted = '';
    private lastFragments: PanelFragments | undefined;
    /** The report last shown: what Name… says an account is called now. */
    private lastReport: UsageReport | undefined;
    /** The page's number for the last account it chose, which each update carries back (see the page's `updateSelect`). */
    private choice = 0;
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
        panel.iconPath = logoIcon(context.extensionUri);
        try {
            UsagePanel.current = new UsagePanel(panel, context, service, log);
        } catch (error) {
            // No empty tab left open, and no raw message shown: the name
            // only, since what the feature had read could be in the message.
            panel.dispose();
            log.warn(`Claude Code usage panel: could not be opened (${error instanceof Error ? error.name : 'Error'})`);
            void vscode.window.showErrorMessage('LLM Tokenizer: the Claude Code Usage panel could not be opened; see the log.');
        }
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
            account: isAccountFilter(saved?.account) ? saved.account : ALL_ACCOUNTS,
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
            vscode.workspace.onDidChangeConfiguration(event => {
                if (event.affectsConfiguration(`${CONFIG_SECTION}.${GIVEN_NAMES_SETTING}`)) {
                    void this.update(false);
                }
            }),
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
                // A page counts its choices from its start.
                this.choice = 0;
                await this.saveState();
                // A page brought back from hidden starts empty: always answer.
                await this.update(true);
                return;
            case 'refresh':
                // The button says a pass is reading: its end is what a
                // Refresh would show, and the page is told of it.
                if (!this.service.reading) {
                    await this.refresh();
                }
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
            case 'setAccount':
                this.state.account = message.account;
                this.choice = message.choice;
                await this.saveState();
                await this.update(false);
                return;
            case 'nameAccount':
                await this.nameAccount(message.account);
                return;
            case 'copy':
            case 'export':
                await vscode.env.clipboard.writeText(message.text);
                void vscode.window.showInformationMessage(
                    message.type === 'export' ? 'LLM Tokenizer: usage CSV copied to the clipboard.' : 'LLM Tokenizer: sessions copied to the clipboard.',
                );
                return;
            case 'turnOn':
                await turnOnUsage();
                return;
            case 'openSettings':
                await openUsageSettings();
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
            case 'reloadWindow':
                await vscode.commands.executeCommand('workbench.action.reloadWindow');
                return;
        }
    }

    /**
     * Ask for a name for an account, in place of its email, as Claude Code
     * gives it, or of its number: kept in the setting, by the account's id,
     * where an empty one takes it out again. The prompt names what the name
     * replaces, never one organization's whole label: the name stands for
     * the account, beside each of its organizations.
     */
    private async nameAccount(account: string): Promise<void> {
        const given = readGivenNames();
        const report = this.lastReport;
        const replaces = report ? nameReplaces(account, report.accountsSeen, report.accountNames) : 'its number';
        const plain = report ? accountLabels(report.accountsSeen, report.accountNames, {}) : undefined;
        const organized = report?.accountsSeen.some(a => a.owner?.accountUuid === account && (plain?.get(a.key)?.organization ?? null) !== null) ?? false;
        const typed = await vscode.window.showInputBox({
            title: 'Name a Claude account',
            prompt: `Shown in Claude Code Usage in place of ${replaces}${organized ? ', beside its organization' : ''}. Leave it empty to show ${
                replaces === 'its number' ? 'that' : replaces
            } again.`,
            value: given[account] ?? '',
            validateInput: value => ([...value.trim()].length > MAX_GIVEN_NAME ? `At most ${MAX_GIVEN_NAME} characters.` : undefined),
        });
        if (typed === undefined) {
            return;
        }
        const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
        // Kept as the setting holds them, what this version cannot read included.
        const raw = config.inspect<unknown>(GIVEN_NAMES_SETTING)?.globalValue;
        const names: Record<string, unknown> = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
        for (const id of Object.keys(names)) {
            if (id.toLowerCase() === account) {
                delete names[id];
            }
        }
        const name = showable(typed, MAX_GIVEN_NAME);
        if (name) {
            names[account] = name;
        }
        try {
            await config.update(GIVEN_NAMES_SETTING, Object.keys(names).length > 0 ? names : undefined, vscode.ConfigurationTarget.Global);
        } catch {
            void vscode.window.showErrorMessage('LLM Tokenizer: the name could not be saved in your settings.');
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
                // The page's last choice the view is made from: taken with
                // the state, before the report is waited for.
                const choice = this.choice;
                const fragments = renderFragments(await this.view());
                this.lastFragments = fragments;
                const serialised = JSON.stringify([fragments, choice]);
                if (force || serialised !== this.lastPosted) {
                    this.lastPosted = serialised;
                    if (this.panel.visible) {
                        await this.panel.webview.postMessage({ type: 'data', fragments, choice });
                    } else {
                        // A hidden page drops what is posted to it, and comes
                        // back from its HTML: that is what is brought up to date.
                        this.setPage(fragments);
                    }
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
        // Read once, before the report is asked for: a range or scope chosen
        // while it comes is the next update's. Read again after, the page
        // showed the newly chosen range's button pressed over the figures of
        // the range before.
        const state = { ...this.state };
        const folders =
            state.scope === 'workspace'
                ? (vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file').map(f => f.uri.fsPath)
                : null;
        let report = await this.service.report(state.range, state.zone, folders, state.account);
        // An account the history no longer holds, after a Clear, is no filter
        // left to show: every account is shown again. Not while the history
        // is being read, which may not have reached that account's sessions.
        if (
            report &&
            state.account !== ALL_ACCOUNTS &&
            !this.service.reading &&
            !report.accountsSeen.some(a => a.key === state.account) &&
            this.state.account === state.account
        ) {
            this.state.account = state.account = ALL_ACCOUNTS;
            await this.saveState();
            report = await this.service.report(state.range, state.zone, folders, state.account);
        }
        this.lastReport = report ?? this.lastReport;
        return this.viewOf(report, state);
    }

    private viewOf(report: PanelView['report'], state: PanelState = this.state): PanelView {
        const zone = state.zone;
        const resolved = this.service.roots;
        const summary = this.service.lastImport;
        const version = (this.context.extension.packageJSON as { version?: unknown }).version;
        const remote = vscode.env.remoteName;
        return {
            status: this.service.status,
            reading: this.service.reading,
            range: state.range,
            scope: state.scope,
            account: state.account,
            givenNames: readGivenNames(),
            zone,
            where: remote ? `on ${os.hostname()} (${remote})` : '',
            remote: remote !== undefined,
            report,
            modelLabel: id => modelById(id)?.label ?? id,
            roots: (resolved?.candidates ?? []).map(c => ({
                path: c.notAbsolute ? c.path : tildePath(c.path),
                source: sourceLabel(c.source),
                exists: c.exists,
                ...(c.notAbsolute ? { notAbsolute: true as const } : {}),
            })),
            accountFiles: (resolved?.accountFiles ?? []).map(f => tildePath(f)),
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
