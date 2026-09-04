import * as vscode from 'vscode';
import * as path from 'path';

import { TokenizerService } from './tokenizer/tokenizerService';
import { TokenizerStore } from './tokenizer/tokenizerStore';
import { findModel, defaultModel, MODELS, MODEL_ALIASES, type ModelInfo } from './tokenizer/registry';
import { StatusBarManager } from './statusbar';
import { showMultiFileSummary } from './webview';
import { formatNumber } from './utils';
import {
    STORAGE_KEY,
    DEBOUNCE_DELAY_MS,
    PROJECT_UPDATE_DELAY_MS,
    PROJECT_SCAN_MAX_DELAY_MS,
} from './constants';
import {
    FolderContext,
    buildExcludeGlob,
    couldAffectCount,
    dedupeSelection,
    describeSkipReason,
    collectFiles,
    isDirectory,
    looksBinary,
    shouldCount,
    type SkipReason,
} from './scan';
import { accuracyOf, isDownloadable } from './tokenizer/encoders';
import { CountCache, isBinaryOutcome } from './countCache';
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
 * The latest a debounced project scan may be deferred to, as a timestamp.
 *
 * The debounce re-armed on every event, so a workspace under continuous churn —
 * an agent writing a file a second, a dev server rewriting a log — pushed the
 * scan out indefinitely and the total simply stopped updating. The window still
 * collapses a burst into one scan; it can no longer postpone one forever.
 */
let projectScanDeadline = 0;

/**
 * Incremented whenever a file count is superseded.
 *
 * `refreshFileStatusBar` re-checked the active editor but not the ordering, and
 * the two counting paths are not FIFO: an empty or oversized document returns
 * without reaching the worker, and a model whose vocabulary still has to be read
 * from disk and built blocks for seconds first. So a refresh started earlier
 * could resolve later and overwrite a newer count, which then stayed on screen.
 */
let fileCountGeneration = 0;

/** Per-file counts, keyed by model and file revision. See src/countCache.ts. */
const countCache = new CountCache();

/**
 * Incremented whenever a scan is superseded or cancelled.
 *
 * The 2-second debounce only delayed *starting* a scan; two scans could still
 * overlap on a large repo, and whichever finished last won — often the older
 * one. Each scan captures the generation at its start and abandons its work if
 * it no longer matches.
 */
let scanGeneration = 0;

/**
 * Drop every cached count and invalidate any scan in flight.
 *
 * The two have to happen together. Clearing the cache alone left a running
 * scan writing results computed under the previous model or gitignore setting
 * into the cache that was just emptied.
 */
function invalidateCounts(): void {
    countCache.clear();
    scanGeneration++;
}

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

    // If the startup model needs a tokenizer and the user has opted into
    // downloads, fetch it now rather than leaving them on an estimate until
    // they happen to find the command.
    void ensureExactTokenizer(currentModel, false);

    // An exact tokenizer finishing its download changes every displayed number.
    context.subscriptions.push(
        tokenizer.onDidChangeAccuracy(() => {
            invalidateCounts();
            void refreshFileStatusBar(vscode.window.activeTextEditor);
            void refreshProjectCount();
        }),
    );

    log.info(`Activated with ${MODELS.length} models; current model ${currentModel.id}`);
}

export function deactivate(): void {
    clearTimeout(statusBarTimer);
    cancelProjectScan();
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
export function resolveInitialModel(
    context: vscode.ExtensionContext,
    // Defaulted rather than read from the module so a test can drive this
    // without activating: the test host loads the bundle, and an import of this
    // file is a second module instance whose `log` was never assigned.
    channel: vscode.LogOutputChannel = log,
): ModelInfo {
    const saved = context.globalState.get<string>(STORAGE_KEY);
    const configured = vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>('defaultModel');

    for (const candidate of [saved, configured]) {
        if (!candidate) {
            continue;
        }

        const model = findModel(candidate);

        // Only a *saved* choice is migrated. A stored value is the sentinel for
        // "the user has picked a model", and rewriting it for an aliased
        // `defaultModel` turned a user who had never picked one into one who
        // had — permanently, and with no action on their part. Their setting
        // was then ignored on every later activation, and the live
        // settings-change handler, which is gated on global state being empty,
        // went dead with it. 41 of the 69 ids the v1.3.0 dropdown offered are
        // aliases today, so this fired on the first activation after upgrade
        // for anyone who had set it. An aliased setting still resolves below;
        // it just no longer fabricates a stored choice.
        if (model && model.id !== candidate && candidate === saved) {
            channel.info(`Model "${candidate}" no longer exists; migrated to "${model.id}"`);
            void context.globalState.update(STORAGE_KEY, model.id);
            void vscode.window.showInformationMessage(
                `LLM Tokenizer: "${candidate}" is no longer available. Switched to ${model.label}.`,
            );
        }
        if (model) {
            return model;
        }
        if (MODEL_ALIASES[candidate] === undefined) {
            channel.warn(`Unknown model "${candidate}" in settings; falling back to the default`);
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
            // Both halves, or the worker keeps counting from a vocabulary the
            // user just deleted and the download command thinks it still has it.
            await store.clear();
            await tokenizer.forgetLoaded();
            invalidateCounts();

            void vscode.window.showInformationMessage('LLM Tokenizer: downloaded tokenizers cleared.');
            void refreshFileStatusBar(vscode.window.activeTextEditor);
            void refreshProjectCount();
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
    // numbers under the new model's name. The project item is cleared as well
    // as invalidated: a cold rescan takes seconds on a large repo, and until it
    // finished the bar kept showing the old model's total, metered and coloured
    // against the old model's context limit under the new model's name.
    invalidateCounts();
    statusBar.clearProjectCount();
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
        const accuracy = {
            exact: 'exact',
            'after-download': 'exact once downloaded',
            estimated: 'estimated',
        }[accuracyOf(model.encoder)];
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
    // Invoked from the command palette this must always say something. Doing
    // nothing at all is indistinguishable from the command being broken.
    if (!isDownloadable(model.encoder)) {
        if (interactive) {
            void vscode.window.showInformationMessage(
                model.encoder.kind === 'tiktoken'
                    ? `${model.label} is already counted exactly — nothing to download.`
                    : `${model.provider} does not publish a tokenizer for ${model.label}, so its counts are estimated.`,
            );
        }
        return;
    }

    if (await tokenizer.isExact(model)) {
        if (interactive) {
            void vscode.window.showInformationMessage(
                `The ${model.label} tokenizer is already downloaded.`,
            );
        }
        return;
    }

    if (!vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>('downloadTokenizers', true)) {
        if (interactive) {
            void vscode.window.showWarningMessage(
                'Tokenizer downloads are turned off. Enable llm-tokenizer.downloadTokenizers to get exact counts.',
            );
        }
        return;
    }

    if (!interactive) {
        void tokenizer.ensureExact(model);
        return;
    }

    let cancelled = false;
    const succeeded = await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: `Downloading the ${model.label} tokenizer…`,
            cancellable: true,
        },
        (_progress, token) => {
            token.onCancellationRequested(() => {
                cancelled = true;
            });
            return tokenizer.ensureExact(model, token);
        },
    );

    // ensureExact never rejects — a failed download is logged and reported as
    // false. Discarding that left the command showing a progress notification
    // that vanished with no result: offline, behind a proxy, on a gated
    // repository or after the timeout, it was indistinguishable from broken.
    if (succeeded) {
        void vscode.window.showInformationMessage(
            `${model.label} is now counted exactly.`,
        );
        return;
    }

    // Checked after `succeeded`, so a download that landed just before the
    // cancel took effect still reports the success that actually happened.
    // Otherwise: the user asked for it to stop, and an error notification would
    // report their own action back to them as a failure, with a button
    // inviting them to read the log about it. The progress notification
    // disappearing is the acknowledgement.
    if (cancelled) {
        log.info(`Download of the ${model.label} tokenizer was cancelled`);
        return;
    }

    const openLog = 'Show Log';
    void vscode.window
        .showErrorMessage(
            `Could not download the ${model.label} tokenizer. Counts stay estimated.`,
            openLog,
        )
        .then(choice => {
            if (choice === openLog) {
                log.show();
            }
        });
}

// ═══════════════════════════════════════════════════════════════
// Event listeners
// ═══════════════════════════════════════════════════════════════

function registerEventListeners(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => debounceStatusBar(editor)),

        // Filtered to the active editor, as the document listener below already
        // is. This event fires for *any* visible editor whose selection moves —
        // including the other half of a split showing the same document — and an
        // update armed for a non-active editor is dropped by the guard inside
        // `refreshFileStatusBar`, so it cancelled the real update rather than
        // delaying it.
        vscode.window.onDidChangeTextEditorSelection(e => {
            if (e.textEditor === vscode.window.activeTextEditor) {
                debounceStatusBar(e.textEditor);
            }
        }),

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
            countCache.deleteFile(document.uri);
            debounceProjectScan();
        }),

        vscode.workspace.onDidCreateFiles(() => debounceProjectScan()),

        vscode.workspace.onDidDeleteFiles(e => {
            // Explorer and applyEdit deletions only. A `git checkout` or an rm
            // from a terminal fires nothing here — see the watcher below, which
            // is what actually covers a branch switch.
            for (const uri of e.files) {
                countCache.deleteFile(uri);
            }
            debounceProjectScan();
        }),

        vscode.workspace.onDidRenameFiles(e => {
            for (const { oldUri } of e.files) {
                countCache.deleteFile(oldUri);
            }
            debounceProjectScan();
        }),

        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            invalidateCounts();
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
                invalidateCounts();
            }

            // `defaultModel` is only the fallback for a user who has never
            // picked a model from the status bar, so an explicit choice still
            // wins. Without this the setting appeared to do nothing until the
            // window was reloaded.
            if (e.affectsConfiguration(`${CONFIG_SECTION}.defaultModel`) &&
                !context.globalState.get<string>(STORAGE_KEY)) {
                const configured = vscode.workspace
                    .getConfiguration(CONFIG_SECTION)
                    .get<string>('defaultModel');
                const model = configured ? findModel(configured) : undefined;
                if (model && model.id !== currentModel.id) {
                    currentModel = model;
                    invalidateCounts();
                    log.info(`Default model changed to ${model.id}`);
                    void refreshFileStatusBar(vscode.window.activeTextEditor);
                    void ensureExactTokenizer(model, false);
                }
            }

            statusBar.applyDisplayMode(isProjectScanEnabled());

            if (isProjectScanEnabled()) {
                void refreshProjectCount();
            } else {
                // Stop the in-flight scan; otherwise it completes minutes later
                // and writes a total into a bar the user just turned off.
                scanGeneration++;
                cancelProjectScan();
                statusBar.clearProjectCount();
            }
        }),
    );

    registerFileWatcher(context);
}

/**
 * Watch the workspace for changes made outside the editor.
 *
 * Every listener above is driven by an editor gesture. `vscode.d.ts` is explicit
 * that `onDidCreateFiles`, `onDidDeleteFiles` and `onDidRenameFiles` are "*not*
 * fired when files change on disk, e.g triggered by another application, or when
 * using the workspace.fs-api", and a save event needs VS Code to have done the
 * saving. So none of them see a coding agent writing files, a `git checkout`, an
 * `npm install`, or a formatter run from a terminal — and the workspace total
 * went stale and stayed stale until some unrelated save happened to trigger a
 * rescan. A FileSystemWatcher is the only API that reports these.
 *
 * The per-file count is unaffected: VS Code reloads an open document when its
 * file changes underneath it, which does fire `onDidChangeTextDocument`.
 */
function registerFileWatcher(context: vscode.ExtensionContext): void {
    // A plain string pattern watches every workspace folder, follows folders as
    // they are added or removed, and — unlike a RelativePattern — is served by
    // the recursive watcher VS Code already runs, so it honours the user's
    // `files.watcherExclude` and costs nothing extra.
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');

    const changed = (uri: vscode.Uri): void => {
        if (!couldAffectCount(uri)) {
            return;
        }
        // The cache is keyed by mtime, so a changed file re-counts on its own;
        // this only stops entries accumulating for paths that are now gone.
        countCache.deleteFile(uri);
        debounceProjectScan();
    };

    context.subscriptions.push(
        watcher,
        watcher.onDidCreate(uri => {
            if (couldAffectCount(uri)) {
                debounceProjectScan();
            }
        }),
        watcher.onDidChange(changed),
        watcher.onDidDelete(changed),
    );
}

function debounceStatusBar(editor: vscode.TextEditor | undefined): void {
    clearTimeout(statusBarTimer);
    statusBarTimer = setTimeout(() => void refreshFileStatusBar(editor), DEBOUNCE_DELAY_MS);
}

/**
 * Schedule a project scan, coalescing a burst of changes into one run.
 *
 * Bounded by `PROJECT_SCAN_MAX_DELAY_MS`: without a ceiling the timer restarted
 * on every event, so steady churn starved the scan completely.
 */
function debounceProjectScan(): void {
    const now = Date.now();
    if (projectScanTimer === undefined) {
        projectScanDeadline = now + PROJECT_SCAN_MAX_DELAY_MS;
    }

    clearTimeout(projectScanTimer);
    const delay = Math.max(0, Math.min(PROJECT_UPDATE_DELAY_MS, projectScanDeadline - now));
    projectScanTimer = setTimeout(() => {
        projectScanTimer = undefined;
        void refreshProjectCount();
    }, delay);
}

/** Cancel a pending scan and reset its deadline, so the next burst starts fresh. */
function cancelProjectScan(): void {
    clearTimeout(projectScanTimer);
    projectScanTimer = undefined;
    projectScanDeadline = 0;
}

// ═══════════════════════════════════════════════════════════════
// Counting
// ═══════════════════════════════════════════════════════════════

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

    // Snapshotted for the whole operation, as countSelection already does. Read
    // twice — once to count, once to display — a model switch mid-count rendered
    // model A's number under model B's name, limit and exact/estimated wording:
    // an estimate could lose its ≈, and the context meter metered the wrong limit.
    const model = currentModel;
    const generation = ++fileCountGeneration;

    const { count, exact } = await tokenizer.count(text, model);

    // The editor may have changed while we were counting; writing the result
    // now would show file A's count while file B is on screen. The generation
    // check covers the other direction: a newer count that already landed must
    // not be overwritten by an older one that took longer to arrive.
    if (generation !== fileCountGeneration || vscode.window.activeTextEditor !== editor || document.isClosed) {
        return;
    }

    statusBar.showFileCount({
        count,
        exact,
        model,
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

/**
 * Count one file, caching the result.
 *
 * `stillValid` guards the cache write. A scan that has been superseded — by a
 * model change, or by the gitignore setting flipping — would otherwise keep
 * writing results computed under the old settings into the cache the new scan
 * had just cleared, poisoning it.
 */
async function countFile(
    uri: vscode.Uri,
    size: number,
    model: ModelInfo,
    stillValid: () => boolean = () => true,
): Promise<FileOutcome> {
    try {
        const stat = await vscode.workspace.fs.stat(uri);
        const cached = countCache.get(model.id, uri, stat.mtime);
        if (cached) {
            return isBinaryOutcome(cached) ? { skip: 'binary' } : cached;
        }

        // Reading bytes rather than `openTextDocument`: opening a TextDocument
        // creates a text model in the extension host and fires open/close events
        // to *every* other extension in the window. On a 35k-file repo that is
        // 70k lifecycle events flooding tsserver, ESLint and friends.
        const bytes = await vscode.workspace.fs.readFile(uri);
        if (looksBinary(bytes)) {
            // Cached under the same key as a count. The verdict cost a full read
            // and the answer cannot change without the mtime changing.
            if (stillValid()) {
                countCache.set(model.id, uri, stat.mtime, { binary: true });
            }
            return { skip: 'binary' };
        }

        const text = new TextDecoder().decode(bytes);
        const { count, exact } = await tokenizer.count(text, model);

        // A non-exact result is only cacheable when the estimate *is* this
        // model's answer. For every other kind it means the count degraded — the
        // worker crashed, timed out, or errored — and caching that pins the file
        // to a guess. A downloadable model recovers when the download fires
        // `onDidChangeAccuracy`, but a bundled tiktoken model emits no such
        // event, so the wrong number would survive for the rest of the session.
        // Recomputing an estimate costs one division, so nothing is lost.
        const cacheable = exact || accuracyOf(model.encoder) === 'estimated';
        if (stillValid() && cacheable) {
            countCache.set(model.id, uri, stat.mtime, { count, exact });
        }
        return { count, exact };
    } catch (error) {
        log.debug(`Skipping ${uri.fsPath}: ${error instanceof Error ? error.message : String(error)}`);
        void size;
        return { skip: 'unreadable' };
    }
}

async function recordFile(
    uri: vscode.Uri,
    size: number,
    context: FolderContext,
    result: ScanResult,
    model: ModelInfo,
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

    const outcome = await countFile(uri, size, model);
    if (!isCounted(outcome)) {
        result.skipped.push({ path: uri.fsPath, reason: describeSkipReason(outcome.skip) });
        return;
    }

    result.total += outcome.count;
    result.exact &&= outcome.exact;
    result.processed.push({ path: uri.fsPath, tokens: outcome.count });
}

/** Count an open document's current text, saved or not. */
async function countOpenDocument(document: vscode.TextDocument): Promise<void> {
    const model = currentModel;
    const { count, exact } = await tokenizer.count(document.getText(), model);
    const name = document.isUntitled
        ? 'Untitled'
        : path.basename(document.uri.fsPath);

    void vscode.window.showInformationMessage(
        `${name}: ${exact ? '' : '≈'}${formatNumber(count)} tokens (${model.label})`,
    );
}

/** Count one file and report it as a notification. */
async function countSingleFile(uri: vscode.Uri, size: number): Promise<void> {
    const name = path.basename(uri.fsPath);
    const model = currentModel;
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    const context = folder
        ? await FolderContext.create(folder, respectGitignore())
        : FolderContext.none(uri);

    const skip = shouldCount(uri, size, context);
    if (skip && skip !== 'gitignored') {
        void vscode.window.showWarningMessage(
            `LLM Tokenizer: ${name} was not counted — ${describeSkipReason(skip).toLowerCase()}.`,
        );
        return;
    }

    const outcome = await countFile(uri, size, model);
    if (!isCounted(outcome)) {
        void vscode.window.showWarningMessage(
            `LLM Tokenizer: ${name} was not counted — ${describeSkipReason(outcome.skip).toLowerCase()}.`,
        );
        return;
    }

    void vscode.window.showInformationMessage(
        `${name}: ${outcome.exact ? '' : '≈'}${formatNumber(outcome.count)} tokens (${model.label})`,
    );
}

async function countSelection(uris: readonly vscode.Uri[]): Promise<void> {
    const selection = dedupeSelection(uris);

    if (selection.length === 1) {
        const only = selection[0];

        // A single file with an active selection means "count what I highlighted".
        const editor = vscode.window.activeTextEditor;
        if (
            editor &&
            !editor.selection.isEmpty &&
            editor.document.uri.toString() === only.toString()
        ) {
            await countActiveEditor();
            return;
        }

        // An open editor is the authority on its own contents. Going straight
        // to disk reported the last saved version for a file with unsaved
        // edits, and failed outright on an untitled document — which has no
        // file to stat — so asking for a count produced an error instead.
        const open = vscode.workspace.textDocuments.find(
            doc => doc.uri.toString() === only.toString(),
        );
        if (open && (open.isDirty || open.isUntitled)) {
            await countOpenDocument(open);
            return;
        }

        // One file answers with a notification. Opening a full summary panel
        // listing a single row is a lot of ceremony for one number.
        let stat: vscode.FileStat | undefined;
        try {
            stat = await vscode.workspace.fs.stat(only);
        } catch {
            void vscode.window.showErrorMessage(
                `LLM Tokenizer: could not read ${path.basename(only.fsPath)}.`,
            );
            return;
        }

        if (!isDirectory(stat.type)) {
            await countSingleFile(only, stat.size);
            return;
        }
    }

    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Counting tokens…', cancellable: true },
        async (progress, token) => {
            // Snapshot the model for the whole operation. Reading the global
            // per file meant switching model mid-count produced a total that
            // was part one model and part another, and cached both under
            // whichever id happened to be current at the time.
            const model = currentModel;
            const result: ScanResult = { total: 0, processed: [], skipped: [], ignored: [], exact: true };
            const contexts = new Map<string, FolderContext>();
            const useGitignore = respectGitignore();
            /** A file to count, with the folder context that governs it. */
            const candidates: { uri: vscode.Uri; size: number; context: FolderContext }[] = [];
            // Carried across selected folders so the running total is for the
            // whole selection, not restarted per folder.
            let base = 0;

            // ── Discovery ────────────────────────────────────────────────────
            // Listing directories is cheap next to reading and tokenizing them,
            // so this pass finishes quickly and buys an honest denominator for
            // the pass that does not.
            let lastReport = 0;
            const reportFound = (n: number): void => {
                // Every ~250 files: reporting per file floods the window with
                // IPC for numbers nobody can read at that rate.
                if (n - lastReport >= 250) {
                    lastReport = n;
                    progress.report({ message: `Finding files… ${n.toLocaleString()} found` });
                }
            };

            for (const uri of selection) {
                if (token.isCancellationRequested) {
                    break;
                }

                const folder = vscode.workspace.getWorkspaceFolder(uri);

                // Built once per folder, not once per selected URI: v1.3.0 read
                // and re-parsed .gitignore for every single file selected.
                const contextKey = folder?.uri.toString() ?? '';
                let context = contexts.get(contextKey);
                if (!context) {
                    context = folder
                        ? await FolderContext.create(folder, useGitignore)
                        : FolderContext.none(uri);
                    contexts.set(contextKey, context);
                }

                let stat: vscode.FileStat;
                try {
                    stat = await vscode.workspace.fs.stat(uri);
                } catch {
                    result.skipped.push({ path: uri.fsPath, reason: describeSkipReason('unreadable') });
                    continue;
                }

                if (isDirectory(stat.type)) {
                    const found = await collectFiles(uri, context, token, n => reportFound(base + n));
                    base += found.files.length;
                    for (const file of found.files) {
                        candidates.push({ ...file, context });
                    }
                    for (const dir of found.ignoredDirectories) {
                        result.ignored.push({ path: dir.fsPath });
                    }
                    for (const bad of found.unreadable) {
                        result.skipped.push({ path: bad.fsPath, reason: describeSkipReason('unreadable') });
                    }
                } else {
                    candidates.push({ uri, size: stat.size, context });
                }
            }

            // ── Counting ─────────────────────────────────────────────────────
            const total = candidates.length;
            // At most ~100 updates over the run, whatever the size, with the
            // skipped increments carried so the bar still reaches the end.
            const step = Math.max(1, Math.floor(total / 100));
            let pending = 0;

            for (let i = 0; i < total; i++) {
                if (token.isCancellationRequested) {
                    break;
                }

                const { uri, size, context } = candidates[i];
                pending++;

                if (pending >= step || i === total - 1) {
                    progress.report({
                        message: `${(i + 1).toLocaleString()} of ${total.toLocaleString()} files`,
                        increment: (100 / total) * pending,
                    });
                    pending = 0;
                }

                await recordFile(uri, size, context, result, model);
            }

            showMultiFileSummary({
                cancelled: token.isCancellationRequested,
                totalTokens: result.total,
                filesProcessed: result.processed.length,
                processedFiles: result.processed,
                skippedFiles: result.skipped,
                ignoredFiles: result.ignored,
                modelLabel: model.label,
                exact: result.exact,
                contextStatus: contextStatus(result.total, model),
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
    const model = currentModel;
    const generation = ++scanGeneration;
    const superseded = () => generation !== scanGeneration;

    try {
        const useGitignore = respectGitignore();
        let total = 0;
        let exact = true;

        // Workspace folders are allowed to nest: `/repo` and `/repo/packages/web`
        // can both be roots. `findFiles` walks a root's entire subtree, so a
        // nested root's files would be counted once under each — inflating the
        // total and pushing the badge to an amber or red the project has not
        // actually reached. Keeping only the outermost roots covers every file
        // exactly once.
        // `delete` rather than `has`: it returns true only the first time, so
        // two folders sharing one URI still contribute a single root.
        const outermost = new Set(dedupeSelection(folders.map(f => f.uri)).map(uri => uri.toString()));
        const roots = folders.filter(folder => outermost.delete(folder.uri.toString()));

        for (const folder of roots) {
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

                const outcome = await countFile(uri, size, model, () => !superseded());
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
            model,
            projectScanEnabled: true,
        });
    } catch (error) {
        log.error(`Project scan failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}

// ═══════════════════════════════════════════════════════════════

/**
 * A count's standing against a model's context limit.
 *
 * The model is a parameter rather than a read of `currentModel`: a multi-file
 * count snapshots the model it started with and can finish after the user has
 * switched, and the summary would then meter the new model's limit under the
 * old model's name.
 */
function contextStatus(count: number, model: ModelInfo): { percentage: number; status: 'ok' | 'warning' | 'error'; limit: number | undefined } {
    const limit = model.contextLimit;
    if (!limit) {
        return { percentage: 0, status: 'ok', limit: undefined };
    }

    const percentage = (count / limit) * 100;
    const status = percentage >= 100 ? 'error' : percentage >= 80 ? 'warning' : 'ok';
    return { percentage, status, limit };
}

export { contextStatus };
