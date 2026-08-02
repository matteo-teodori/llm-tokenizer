import * as vscode from 'vscode';
import * as path from 'path';

import { TokenizerService } from './tokenizer/tokenizerService';
import { TokenizerStore } from './tokenizer/tokenizerStore';
import { findModel, defaultModel, MODELS, MODEL_ALIASES, type ModelInfo } from './tokenizer/registry';
import { StatusBarManager } from './statusbar';
import { showMultiFileSummary } from './webview';
import { formatNumber } from './utils';
import { STORAGE_KEY, DEBOUNCE_DELAY_MS, PROJECT_UPDATE_DELAY_MS } from './constants';
import {
    FolderContext,
    buildExcludeGlob,
    dedupeSelection,
    describeSkipReason,
    isDirectory,
    isFile,
    looksBinary,
    shouldCount,
    shouldDescend,
    type SkipReason,
} from './scan';
import type { ModelQuickPickItem, ProcessedFile, SkippedFile, IgnoredFile } from './types';

const CONFIG_SECTION = 'llm-tokenizer';

// ═══════════════════════════════════════════════════════════════
// Extension state
// ═══════════════════════════════════════════════════════════════

let log: vscode.LogOutputChannel;
let tokenizer: TokenizerService;
let statusBar: StatusBarManager;
let currentModel: ModelInfo;

let statusBarTimer: NodeJS.Timeout | undefined;
let projectScanTimer: NodeJS.Timeout | undefined;

/**
 * Cache of per-file counts, keyed by model **and** path.
 *
 * Keying on path alone meant that switching from GPT to Gemini kept serving the
 * old model's numbers forever: mtimes were unchanged, so every later rescan hit
 * the stale entry and the project total never self-corrected.
 */
const countCache = new Map<string, { count: number; mtime: number }>();

/**
 * Incremented whenever a scan is superseded or cancelled.
 *
 * The 2-second debounce only delayed *starting* a scan; two scans could still
 * overlap on a large repo, and whichever finished last won — often the older
 * one. Each scan captures the generation at its start and abandons its work if
 * it no longer matches.
 */
let scanGeneration = 0;

// ═══════════════════════════════════════════════════════════════
// Lifecycle
// ═══════════════════════════════════════════════════════════════

export function activate(context: vscode.ExtensionContext): void {
    log = vscode.window.createOutputChannel('LLM Tokenizer', { log: true });
    context.subscriptions.push(log);

    const store = new TokenizerStore(context.globalStorageUri);
    tokenizer = new TokenizerService(path.join(context.extensionPath, 'out', 'worker.js'), store, log);
    // v1.3.0 never disposed this, so every window reload leaked a worker thread.
    context.subscriptions.push(tokenizer);

    statusBar = new StatusBarManager(context);
    currentModel = resolveInitialModel(context);

    registerCommands(context, store);
    registerEventListeners(context);

    void refreshFileStatusBar(vscode.window.activeTextEditor);
    void refreshProjectCount();

    // An exact tokenizer finishing its download changes every displayed number.
    context.subscriptions.push(
        tokenizer.onDidChangeAccuracy(() => {
            countCache.clear();
            void refreshFileStatusBar(vscode.window.activeTextEditor);
            void refreshProjectCount();
        }),
    );

    log.info(`Activated with ${MODELS.length} models; current model ${currentModel.id}`);
}

export function deactivate(): void {
    clearTimeout(statusBarTimer);
    clearTimeout(projectScanTimer);
    scanGeneration++;
    countCache.clear();
}

/**
 * Pick the startup model: the saved choice, else the `defaultModel` setting.
 *
 * The setting was documented in the README and offered 69 values in the
 * settings UI, but nothing ever read it — the model came from global state with
 * a hardcoded fallback. Removed and renamed ids are migrated through
 * MODEL_ALIASES so nobody is silently reset.
 */
function resolveInitialModel(context: vscode.ExtensionContext): ModelInfo {
    const saved = context.globalState.get<string>(STORAGE_KEY);
    const configured = vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>('defaultModel');

    for (const candidate of [saved, configured]) {
        if (!candidate) {
            continue;
        }

        const model = findModel(candidate);
        if (model && model.id !== candidate) {
            log.info(`Model "${candidate}" no longer exists; migrated to "${model.id}"`);
            void context.globalState.update(STORAGE_KEY, model.id);
            void vscode.window.showInformationMessage(
                `LLM Tokenizer: "${candidate}" is no longer available. Switched to ${model.label}.`,
            );
        }
        if (model) {
            return model;
        }
        if (MODEL_ALIASES[candidate] === undefined) {
            log.warn(`Unknown model "${candidate}" in settings; falling back to the default`);
        }
    }

    return defaultModel();
}

// ═══════════════════════════════════════════════════════════════
// Commands
// ═══════════════════════════════════════════════════════════════

function registerCommands(context: vscode.ExtensionContext, store: TokenizerStore): void {
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'llm-tokenizer.countTokens',
            async (uri?: vscode.Uri, allUris?: vscode.Uri[]) => {
                const selection = allUris?.length ? allUris : uri ? [uri] : [];
                if (selection.length > 0) {
                    await countSelection(selection);
                } else {
                    await countActiveEditor();
                }
            },
        ),

        vscode.commands.registerCommand('llm-tokenizer.selectModel', async () => {
            const picked = await vscode.window.showQuickPick(buildModelPickerItems(), {
                placeHolder: 'Select a model for token counting',
                matchOnDescription: true,
                matchOnDetail: true,
            });
            if (!picked?.modelId) {
                return;
            }

            await setModel(context, picked.modelId);
        }),

        vscode.commands.registerCommand('llm-tokenizer.downloadTokenizer', async () => {
            await ensureExactTokenizer(currentModel, true);
        }),

        vscode.commands.registerCommand('llm-tokenizer.clearTokenizerCache', async () => {
            await store.clear();
            countCache.clear();
            void vscode.window.showInformationMessage('LLM Tokenizer: downloaded tokenizers cleared.');
            void refreshFileStatusBar(vscode.window.activeTextEditor);
        }),
    );
}

async function setModel(context: vscode.ExtensionContext, modelId: string): Promise<void> {
    const model = findModel(modelId);
    if (!model) {
        return;
    }

    currentModel = model;
    await context.globalState.update(STORAGE_KEY, model.id);

    // Counts are model-specific; keeping them would show the previous model's
    // numbers under the new model's name.
    countCache.clear();
    log.info(`Model set to ${model.id}`);

    void refreshFileStatusBar(vscode.window.activeTextEditor);
    void refreshProjectCount();
    void ensureExactTokenizer(model, false);
}

function buildModelPickerItems(): ModelQuickPickItem[] {
    const items: ModelQuickPickItem[] = [];
    let lastProvider: string | undefined;

    for (const model of MODELS) {
        if (model.provider !== lastProvider) {
            items.push({ label: model.provider, kind: vscode.QuickPickItemKind.Separator });
            lastProvider = model.provider;
        }

        const selected = model.id === currentModel.id;
        const accuracy = model.encoder.kind === 'heuristic' ? 'estimated' : 'exact';
        items.push({
            label: `${selected ? '$(check) ' : ''}${model.label}`,
            description: model.id,
            detail: `${formatNumber(model.contextLimit ?? 0)} token context · ${accuracy}`,
            modelId: model.id,
        });
    }

    return items;
}

/**
 * Download the model's real tokenizer so counts become exact.
 *
 * @param interactive whether to prompt and show progress, or fail silently.
 */
async function ensureExactTokenizer(model: ModelInfo, interactive: boolean): Promise<void> {
    if (model.encoder.kind !== 'hf' || (await tokenizer.isExact(model))) {
        return;
    }
    if (!vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>('downloadTokenizers', true)) {
        return;
    }

    const run = (token?: vscode.CancellationToken) => tokenizer.ensureExact(model, token);

    if (!interactive) {
        void run();
        return;
    }

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: `Downloading the ${model.label} tokenizer…`,
            cancellable: true,
        },
        (_progress, token) => run(token),
    );
}

// ═══════════════════════════════════════════════════════════════
// Event listeners
// ═══════════════════════════════════════════════════════════════

function registerEventListeners(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => debounceStatusBar(editor)),

        vscode.window.onDidChangeTextEditorSelection(e => debounceStatusBar(e.textEditor)),

        vscode.workspace.onDidChangeTextDocument(e => {
            // Only real files, and only the one on screen. v1.3.0 also rescanned
            // the whole workspace whenever any non-dirty document changed, which
            // fired on undo-to-baseline, on `git checkout`, and on every write to
            // an `output:` channel — so any extension that logs steadily kept the
            // project scan re-arming forever.
            if (e.document.uri.scheme !== 'file') {
                return;
            }
            if (e.document === vscode.window.activeTextEditor?.document) {
                debounceStatusBar(vscode.window.activeTextEditor);
            }
        }),

        vscode.workspace.onDidSaveTextDocument(document => {
            countCache.delete(cacheKey(document.uri));
            debounceProjectScan();
        }),

        vscode.workspace.onDidCreateFiles(() => debounceProjectScan()),

        vscode.workspace.onDidDeleteFiles(e => {
            // The event names exactly which files went, so a branch switch no
            // longer forces a cold re-tokenisation of the entire workspace.
            for (const uri of e.files) {
                countCache.delete(cacheKey(uri));
            }
            debounceProjectScan();
        }),

        vscode.workspace.onDidRenameFiles(e => {
            for (const { oldUri } of e.files) {
                countCache.delete(cacheKey(oldUri));
            }
            debounceProjectScan();
        }),

        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            countCache.clear();
            void refreshProjectCount();
        }),

        // v1.3.0 had no configuration listener at all, so changing the display
        // mode or the gitignore setting did nothing until some unrelated event
        // happened to fire.
        vscode.workspace.onDidChangeConfiguration(e => {
            if (!e.affectsConfiguration(CONFIG_SECTION)) {
                return;
            }

            if (e.affectsConfiguration(`${CONFIG_SECTION}.ignoreGitignoredFiles`)) {
                countCache.clear();
            }

            statusBar.applyDisplayMode(isProjectScanEnabled());

            if (isProjectScanEnabled()) {
                void refreshProjectCount();
            } else {
                // Stop the in-flight scan; otherwise it completes minutes later
                // and writes a total into a bar the user just turned off.
                scanGeneration++;
                clearTimeout(projectScanTimer);
                statusBar.clearProjectCount();
            }
        }),
    );
}

function debounceStatusBar(editor: vscode.TextEditor | undefined): void {
    clearTimeout(statusBarTimer);
    statusBarTimer = setTimeout(() => void refreshFileStatusBar(editor), DEBOUNCE_DELAY_MS);
}

function debounceProjectScan(): void {
    clearTimeout(projectScanTimer);
    projectScanTimer = setTimeout(() => void refreshProjectCount(), PROJECT_UPDATE_DELAY_MS);
}

// ═══════════════════════════════════════════════════════════════
// Counting
// ═══════════════════════════════════════════════════════════════

function cacheKey(uri: vscode.Uri): string {
    return `${currentModel.id} ${uri.toString()}`;
}

function isProjectScanEnabled(): boolean {
    return vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>('enableProjectScan', true);
}

function respectGitignore(): boolean {
    return vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>('ignoreGitignoredFiles', true);
}

async function refreshFileStatusBar(editor: vscode.TextEditor | undefined): Promise<void> {
    if (!editor || editor.document.isClosed) {
        statusBar.clearFileCount();
        return;
    }

    const document = editor.document;
    const hasSelection = !editor.selection.isEmpty;
    const text = hasSelection ? document.getText(editor.selection) : document.getText();

    const { count, exact } = await tokenizer.count(text, currentModel);

    // The editor may have changed while we were counting; writing the result
    // now would show file A's count while file B is on screen.
    if (vscode.window.activeTextEditor !== editor || document.isClosed) {
        return;
    }

    statusBar.showFileCount({
        count,
        exact,
        model: currentModel,
        isSelection: hasSelection,
        projectScanEnabled: isProjectScanEnabled(),
    });
}

async function countActiveEditor(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        void vscode.window.showInformationMessage('LLM Tokenizer: no file is open.');
        return;
    }

    const hasSelection = !editor.selection.isEmpty;
    const text = hasSelection ? editor.document.getText(editor.selection) : editor.document.getText();
    const { count, exact } = await tokenizer.count(text, currentModel);

    const what = hasSelection ? 'Selection' : path.basename(editor.document.uri.fsPath);
    void vscode.window.showInformationMessage(
        `${what}: ${exact ? '' : '≈'}${formatNumber(count)} tokens (${currentModel.label})`,
    );
}

interface ScanResult {
    total: number;
    processed: ProcessedFile[];
    skipped: SkippedFile[];
    ignored: IgnoredFile[];
    exact: boolean;
}

/** A successful count, or the reason the file was not counted. */
type FileOutcome = { count: number; exact: boolean } | { skip: SkipReason };

function isCounted(outcome: FileOutcome): outcome is { count: number; exact: boolean } {
    return 'count' in outcome;
}

async function countFile(uri: vscode.Uri, size: number): Promise<FileOutcome> {
    const key = cacheKey(uri);

    try {
        const stat = await vscode.workspace.fs.stat(uri);
        const cached = countCache.get(key);
        if (cached && cached.mtime === stat.mtime) {
            return { count: cached.count, exact: true };
        }

        // Reading bytes rather than `openTextDocument`: opening a TextDocument
        // creates a text model in the extension host and fires open/close events
        // to *every* other extension in the window. On a 35k-file repo that is
        // 70k lifecycle events flooding tsserver, ESLint and friends.
        const bytes = await vscode.workspace.fs.readFile(uri);
        if (looksBinary(bytes)) {
            return { skip: 'binary' };
        }

        const text = new TextDecoder().decode(bytes);
        const { count, exact } = await tokenizer.count(text, currentModel);

        countCache.set(key, { count, mtime: stat.mtime });
        return { count, exact };
    } catch (error) {
        log.debug(`Skipping ${uri.fsPath}: ${error instanceof Error ? error.message : String(error)}`);
        void size;
        return { skip: 'unreadable' };
    }
}

async function walkDirectory(
    uri: vscode.Uri,
    context: FolderContext,
    result: ScanResult,
    token: vscode.CancellationToken,
): Promise<void> {
    let entries: [string, vscode.FileType][];
    try {
        entries = await vscode.workspace.fs.readDirectory(uri);
    } catch {
        return;
    }

    for (const [name, type] of entries) {
        if (token.isCancellationRequested) {
            return;
        }

        const child = vscode.Uri.joinPath(uri, name);

        if (isDirectory(type)) {
            if (shouldDescend(name, child, context)) {
                await walkDirectory(child, context, result, token);
            } else if (context.isIgnored(child, true)) {
                result.ignored.push({ path: child.fsPath });
            }
            continue;
        }

        if (!isFile(type)) {
            continue;
        }

        let size: number;
        try {
            size = (await vscode.workspace.fs.stat(child)).size;
        } catch {
            // One deleted file used to abort the whole run and discard every
            // count already computed.
            result.skipped.push({ path: child.fsPath, reason: describeSkipReason('unreadable') });
            continue;
        }

        await recordFile(child, size, context, result);
    }
}

async function recordFile(
    uri: vscode.Uri,
    size: number,
    context: FolderContext,
    result: ScanResult,
): Promise<void> {
    const skip: SkipReason | undefined = shouldCount(uri, size, context);
    if (skip === 'gitignored') {
        result.ignored.push({ path: uri.fsPath });
        return;
    }
    if (skip) {
        result.skipped.push({ path: uri.fsPath, reason: describeSkipReason(skip) });
        return;
    }

    const outcome = await countFile(uri, size);
    if (!isCounted(outcome)) {
        result.skipped.push({ path: uri.fsPath, reason: describeSkipReason(outcome.skip) });
        return;
    }

    result.total += outcome.count;
    result.exact &&= outcome.exact;
    result.processed.push({ path: uri.fsPath, tokens: outcome.count });
}

async function countSelection(uris: readonly vscode.Uri[]): Promise<void> {
    const selection = dedupeSelection(uris);

    // A single file with an active selection means "count what I highlighted".
    if (selection.length === 1) {
        const editor = vscode.window.activeTextEditor;
        if (
            editor &&
            !editor.selection.isEmpty &&
            editor.document.uri.toString() === selection[0].toString()
        ) {
            await countActiveEditor();
            return;
        }
    }

    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Counting tokens…', cancellable: true },
        async (progress, token) => {
            const result: ScanResult = { total: 0, processed: [], skipped: [], ignored: [], exact: true };
            const contexts = new Map<string, FolderContext>();
            const useGitignore = respectGitignore();

            for (let i = 0; i < selection.length; i++) {
                if (token.isCancellationRequested) {
                    break;
                }

                const uri = selection[i];
                progress.report({
                    message: `${i + 1}/${selection.length}: ${path.basename(uri.fsPath)}`,
                    increment: 100 / selection.length,
                });

                const folder = vscode.workspace.getWorkspaceFolder(uri);
                if (!folder) {
                    continue;
                }

                // Built once per folder, not once per selected URI: v1.3.0 read
                // and re-parsed .gitignore for every single file selected.
                let context = contexts.get(folder.uri.toString());
                if (!context) {
                    context = await FolderContext.create(folder, useGitignore);
                    contexts.set(folder.uri.toString(), context);
                }

                let stat: vscode.FileStat;
                try {
                    stat = await vscode.workspace.fs.stat(uri);
                } catch {
                    result.skipped.push({ path: uri.fsPath, reason: describeSkipReason('unreadable') });
                    continue;
                }

                if (isDirectory(stat.type)) {
                    await walkDirectory(uri, context, result, token);
                } else {
                    await recordFile(uri, stat.size, context, result);
                }
            }

            showMultiFileSummary({
                totalTokens: result.total,
                filesProcessed: result.processed.length,
                processedFiles: result.processed,
                skippedFiles: result.skipped,
                ignoredFiles: result.ignored,
                modelLabel: currentModel.label,
                exact: result.exact,
                contextStatus: contextStatus(result.total),
            });
        },
    );
}

// ═══════════════════════════════════════════════════════════════
// Project-wide count
// ═══════════════════════════════════════════════════════════════

async function refreshProjectCount(): Promise<void> {
    if (!isProjectScanEnabled()) {
        statusBar.clearProjectCount();
        return;
    }

    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) {
        statusBar.clearProjectCount();
        return;
    }

    // A generation counter rather than a CancellationToken: nothing here can
    // be interrupted mid-await, so cancellation is entirely a matter of the
    // loop noticing it has been superseded and abandoning its result.
    const generation = ++scanGeneration;
    const superseded = () => generation !== scanGeneration;

    try {
        const useGitignore = respectGitignore();
        let total = 0;
        let exact = true;

        for (const folder of folders) {
            const context = await FolderContext.create(folder, useGitignore);
            const files = await vscode.workspace.findFiles(
                new vscode.RelativePattern(folder, '**/*'),
                buildExcludeGlob(),
            );

            for (const uri of files) {
                if (superseded()) {
                    log.debug('Project scan superseded; abandoning');
                    return;
                }

                let size: number;
                try {
                    size = (await vscode.workspace.fs.stat(uri)).size;
                } catch {
                    continue;
                }

                if (shouldCount(uri, size, context)) {
                    continue;
                }

                const outcome = await countFile(uri, size);
                if (isCounted(outcome)) {
                    total += outcome.count;
                    exact &&= outcome.exact;
                }
            }
        }

        // Checked once more: the scan may have been superseded, or the setting
        // turned off, while the last file was being counted.
        if (superseded() || !isProjectScanEnabled()) {
            return;
        }

        statusBar.showProjectCount({
            count: total,
            exact,
            model: currentModel,
            projectScanEnabled: true,
        });
    } catch (error) {
        log.error(`Project scan failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}

// ═══════════════════════════════════════════════════════════════

function contextStatus(count: number): { percentage: number; status: 'ok' | 'warning' | 'error'; limit: number | undefined } {
    const limit = currentModel.contextLimit;
    if (!limit) {
        return { percentage: 0, status: 'ok', limit: undefined };
    }

    const percentage = (count / limit) * 100;
    const status = percentage >= 100 ? 'error' : percentage >= 80 ? 'warning' : 'ok';
    return { percentage, status, limit };
}

export { contextStatus };
