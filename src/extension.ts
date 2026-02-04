import * as vscode from 'vscode';
import * as path from 'path';
import { TokenizerService, MODEL_REGISTRY } from './tokenizer';
import { StatusBarManager } from './statusbar';
import { showMultiFileSummary } from './webview';
import { isBinaryFile, formatNumber } from './utils';
import {
    STORAGE_KEY,
    DEBOUNCE_DELAY_MS,
    PROJECT_UPDATE_DELAY_MS,
    IGNORED_DIRECTORIES
} from './constants';
import {
    ModelQuickPickItem,
    DirectoryCountResult,
    TokenCacheEntry
} from './types';

// ═══════════════════════════════════════════════════════════════
// Extension State
// ═══════════════════════════════════════════════════════════════

let tokenizerService: TokenizerService;
let statusBarManager: StatusBarManager;
let debounceTimer: NodeJS.Timeout | undefined;
let projectUpdateTimer: NodeJS.Timeout | undefined;
let projectTokenCount: number = 0;
let projectCountCache: Map<string, TokenCacheEntry> = new Map();

// ═══════════════════════════════════════════════════════════════
// Extension Lifecycle
// ═══════════════════════════════════════════════════════════════

export function activate(context: vscode.ExtensionContext): void {
    console.log('LLM Tokenizer extension is now active!');

    // Initialize services
    tokenizerService = new TokenizerService();
    statusBarManager = new StatusBarManager(tokenizerService, context);

    // Load saved model preference
    const savedModel = context.globalState.get<string>(STORAGE_KEY);
    if (savedModel && MODEL_REGISTRY.find(m => m.id === savedModel)) {
        tokenizerService.setModel(savedModel);
    }

    // Register commands
    registerCommands(context);

    // Register event listeners
    registerEventListeners(context);

    // Initial updates
    statusBarManager.updateFileStatusBar(vscode.window.activeTextEditor);
    updateProjectTokenCountAsync();
}

export function deactivate(): void {
    if (debounceTimer) {
        clearTimeout(debounceTimer);
    }
    if (projectUpdateTimer) {
        clearTimeout(projectUpdateTimer);
    }
}

// ═══════════════════════════════════════════════════════════════
// Command Registration
// ═══════════════════════════════════════════════════════════════

function registerCommands(context: vscode.ExtensionContext): void {
    // Count tokens command
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'llm-tokenizer.countTokens',
            async (uri: vscode.Uri, allUris?: vscode.Uri[]) => {
                if (allUris && allUris.length > 1) {
                    await handleMultipleUris(allUris);
                } else if (uri) {
                    await handleSingleUri(uri);
                } else {
                    await handleCommandPalette();
                }
            }
        )
    );

    // Select model command
    context.subscriptions.push(
        vscode.commands.registerCommand('llm-tokenizer.selectModel', async () => {
            const selected = await showModelPicker();
            if (selected?.modelId) {
                tokenizerService.setModel(selected.modelId);
                context.globalState.update(STORAGE_KEY, selected.modelId);
                vscode.window.showInformationMessage(`Switched to: ${selected.label}`);
                statusBarManager.updateFileStatusBar(vscode.window.activeTextEditor);
            }
        })
    );
}

// ═══════════════════════════════════════════════════════════════
// Event Listeners
// ═══════════════════════════════════════════════════════════════

function registerEventListeners(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => {
            debouncedUpdateStatusBar(editor);
        }),

        vscode.window.onDidChangeTextEditorSelection(e => {
            debouncedUpdateStatusBar(e.textEditor);
        }),

        vscode.workspace.onDidChangeTextDocument(e => {
            if (
                vscode.window.activeTextEditor &&
                e.document === vscode.window.activeTextEditor.document
            ) {
                debouncedUpdateStatusBar(vscode.window.activeTextEditor);
            }
            // Trigger project update when a document becomes clean (saved)
            if (!e.document.isDirty) {
                debouncedUpdateProjectCount();
            }
        }),

        vscode.workspace.onDidSaveTextDocument(() => {
            debouncedUpdateProjectCount();
        }),

        vscode.workspace.onDidCreateFiles(() => {
            debouncedUpdateProjectCount();
        }),

        vscode.workspace.onDidDeleteFiles(() => {
            projectCountCache.clear();
            debouncedUpdateProjectCount();
        })
    );
}

// ═══════════════════════════════════════════════════════════════
// Model Picker
// ═══════════════════════════════════════════════════════════════

async function showModelPicker(): Promise<ModelQuickPickItem | undefined> {
    const items = buildQuickPickItems();
    return vscode.window.showQuickPick(items, {
        placeHolder: 'Select AI Model for Token Counting',
        matchOnDescription: true
    });
}

function buildQuickPickItems(): ModelQuickPickItem[] {
    const items: ModelQuickPickItem[] = [];
    const providers = [...new Set(MODEL_REGISTRY.map(m => m.provider))];

    for (const provider of providers) {
        // Add separator
        items.push({
            label: provider,
            kind: vscode.QuickPickItemKind.Separator
        });

        // Add models for this provider
        const models = MODEL_REGISTRY.filter(m => m.provider === provider);
        for (const model of models) {
            const isSelected = model.id === tokenizerService.getModel();
            items.push({
                label: `${isSelected ? '$(check) ' : ''}${model.label}`,
                description: model.id,
                modelId: model.id
            });
        }
    }

    return items;
}

// ═══════════════════════════════════════════════════════════════
// URI Handlers
// ═══════════════════════════════════════════════════════════════

async function handleSingleUri(uri: vscode.Uri): Promise<void> {
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.type === vscode.FileType.Directory) {
        await handleMultipleUris([uri]);
    } else {
        await countFileTokens(uri, true);
    }
}

async function handleCommandPalette(): Promise<void> {
    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor) {
        vscode.window.showInformationMessage('No file is currently open.');
        return;
    }

    if (!activeEditor.selection.isEmpty) {
        await countSelectionTokens(activeEditor);
    } else {
        await countFileTokens(activeEditor.document.uri, true);
    }
}

async function handleMultipleUris(uris: vscode.Uri[]): Promise<void> {
    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'Counting tokens in selected files...',
            cancellable: true
        },
        async (progress, token) => {
            let totalTokens = 0;
            let filesProcessed = 0;
            const processedFiles: { path: string; tokens: number }[] = [];
            const skippedFiles: { path: string; reason: string }[] = [];

            for (let i = 0; i < uris.length; i++) {
                if (token.isCancellationRequested) {
                    vscode.window.showWarningMessage(
                        `Token counting cancelled. Processed ${filesProcessed}/${uris.length} files.`
                    );
                    return;
                }

                const uri = uris[i];
                const fileName = path.basename(uri.fsPath);

                progress.report({
                    message: `${i + 1}/${uris.length}: ${fileName}`,
                    increment: 100 / uris.length
                });

                const stat = await vscode.workspace.fs.stat(uri);

                if (stat.type === vscode.FileType.Directory) {
                    const result = await countTokensInDirectory(uri, token);
                    totalTokens += result.count;
                    filesProcessed += result.files.length;
                    processedFiles.push(...result.files);
                    skippedFiles.push(...result.skipped);
                } else {
                    // Check if binary BEFORE counting to distinguish from empty files
                    if (isBinaryFile(uri.fsPath)) {
                        skippedFiles.push({
                            path: uri.fsPath,
                            reason: 'Binary or unsupported file'
                        });
                    } else {
                        const count = await countFileTokens(uri, false);
                        if (count >= 0) {
                            totalTokens += count;
                            filesProcessed++;
                            processedFiles.push({ path: uri.fsPath, tokens: count });
                        }
                    }
                }
            }

            // Show summary in webview
            const modelInfo = tokenizerService.getModelInfo();
            showMultiFileSummary({
                totalTokens,
                filesProcessed,
                processedFiles,
                skippedFiles,
                modelLabel: modelInfo?.label || tokenizerService.getModel(),
                contextStatus: tokenizerService.getContextStatus(totalTokens)
            });
        }
    );
}

// ═══════════════════════════════════════════════════════════════
// Token Counting
// ═══════════════════════════════════════════════════════════════

async function countSelectionTokens(editor: vscode.TextEditor): Promise<void> {
    const selectedText = editor.document.getText(editor.selection);
    const count = tokenizerService.countTokens(selectedText);
    const modelInfo = tokenizerService.getModelInfo();

    vscode.window.showInformationMessage(
        `📝 Selection: ${formatNumber(count)} tokens (${modelInfo?.label || tokenizerService.getModel()})`
    );
}

async function countFileTokens(
    uri: vscode.Uri,
    showNotification: boolean = false
): Promise<number> {
    if (isBinaryFile(uri.fsPath)) {
        if (showNotification) {
            vscode.window.showWarningMessage(
                `Cannot count tokens: '${path.basename(uri.fsPath)}' appears to be a binary or unsupported file type.`
            );
        }
        return 0;
    }

    try {
        const document = await vscode.workspace.openTextDocument(uri);
        const text = document.getText();
        const count = tokenizerService.countTokens(text);

        if (showNotification) {
            const modelInfo = tokenizerService.getModelInfo();
            vscode.window.showInformationMessage(
                `📄 ${path.basename(uri.fsPath)}: ${formatNumber(count)} tokens (${modelInfo?.label || tokenizerService.getModel()})`
            );
        }
        return count;
    } catch (error) {
        console.error(error);
        if (showNotification) {
            vscode.window.showErrorMessage(`Error reading file: ${error}`);
        }
        return 0;
    }
}

async function countTokensInDirectory(
    uri: vscode.Uri,
    token: vscode.CancellationToken
): Promise<DirectoryCountResult> {
    let total = 0;
    const files: { path: string; tokens: number }[] = [];
    const skipped: { path: string; reason: string }[] = [];

    const entries = await vscode.workspace.fs.readDirectory(uri);

    for (const [name, type] of entries) {
        if (token.isCancellationRequested) break;

        // Skip hidden files and common non-source directories
        if (name.startsWith('.') || IGNORED_DIRECTORIES.has(name)) {
            continue;
        }

        const entryUri = vscode.Uri.joinPath(uri, name);

        if (type === vscode.FileType.Directory) {
            const result = await countTokensInDirectory(entryUri, token);
            total += result.count;
            files.push(...result.files);
            skipped.push(...result.skipped);
        } else if (type === vscode.FileType.File) {
            if (isBinaryFile(entryUri.fsPath)) {
                skipped.push({
                    path: entryUri.fsPath,
                    reason: 'Binary or unsupported file'
                });
                continue;
            }

            try {
                const arr = await vscode.workspace.fs.readFile(entryUri);
                const text = new TextDecoder().decode(arr);
                const count = tokenizerService.countTokens(text);
                total += count;
                files.push({ path: entryUri.fsPath, tokens: count });
            } catch (e) {
                console.warn(`Skipping file ${name}: ${e}`);
                skipped.push({ path: entryUri.fsPath, reason: 'Error reading file' });
            }
        }
    }

    return { count: total, files, skipped };
}

// ═══════════════════════════════════════════════════════════════
// Debounced Updates
// ═══════════════════════════════════════════════════════════════

function debouncedUpdateStatusBar(editor: vscode.TextEditor | undefined): void {
    if (debounceTimer) {
        clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
        statusBarManager.updateFileStatusBar(editor);
    }, DEBOUNCE_DELAY_MS);
}

function debouncedUpdateProjectCount(): void {
    if (projectUpdateTimer) {
        clearTimeout(projectUpdateTimer);
    }
    projectUpdateTimer = setTimeout(() => {
        updateProjectTokenCountAsync();
    }, PROJECT_UPDATE_DELAY_MS);
}

// ═══════════════════════════════════════════════════════════════
// Project-wide Token Counting
// ═══════════════════════════════════════════════════════════════

async function updateProjectTokenCountAsync(): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        return;
    }

    try {
        const files = await vscode.workspace.findFiles('**/*', '**/node_modules/**');
        let total = 0;

        for (const file of files) {
            if (isBinaryFile(file.fsPath)) {
                continue;
            }

            try {
                const stat = await vscode.workspace.fs.stat(file);
                const cacheKey = file.fsPath;
                const cached = projectCountCache.get(cacheKey);

                // Use cache if file hasn't been modified
                if (cached && cached.mtime === stat.mtime) {
                    total += cached.count;
                } else {
                    const count = await countFileTokens(file, false);
                    projectCountCache.set(cacheKey, { count, mtime: stat.mtime });
                    total += count;
                }
            } catch {
                // Skip files that can't be read
                continue;
            }
        }

        projectTokenCount = total;
        statusBarManager.updateProjectStatusBar(total);
    } catch (error) {
        console.error('Error calculating project tokens:', error);
    }
}
