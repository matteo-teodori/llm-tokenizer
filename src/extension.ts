import * as vscode from 'vscode';
import * as path from 'path';
import { TokenizerService, MODEL_REGISTRY, ModelInfo } from './tokenizer';

let statusBarItem: vscode.StatusBarItem;
let tokenizerService: TokenizerService;
let debounceTimer: NodeJS.Timeout | undefined;

const STORAGE_KEY = 'tokenizer.selectedModel';

export function activate(context: vscode.ExtensionContext) {
    console.log('Tokenizer extension is now active!');

    tokenizerService = new TokenizerService();

    // Load saved model preference
    const savedModel = context.globalState.get<string>(STORAGE_KEY);
    if (savedModel && MODEL_REGISTRY.find(m => m.id === savedModel)) {
        tokenizerService.setModel(savedModel);
    }

    // Initialize Status Bar Item
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'tokenizer.selectModel';
    context.subscriptions.push(statusBarItem);

    // Register Commands
    context.subscriptions.push(
        vscode.commands.registerCommand('tokenizer.countTokens', async (uri: vscode.Uri) => {
            if (uri) {
                await handleUri(uri);
            } else {
                const activeEditor = vscode.window.activeTextEditor;
                if (activeEditor) {
                    await countFileTokens(activeEditor.document.uri, true);
                } else {
                    vscode.window.showInformationMessage("No file is currently open.");
                }
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('tokenizer.selectModel', async () => {
            const items = buildQuickPickItems();
            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: "Select AI Model for Token Counting",
                matchOnDescription: true
            });
            if (selected && selected.modelId) {
                tokenizerService.setModel(selected.modelId);
                context.globalState.update(STORAGE_KEY, selected.modelId);
                vscode.window.showInformationMessage(`Switched to: ${selected.label}`);
                updateStatusBarImmediate(vscode.window.activeTextEditor);
            }
        })
    );

    // Event Listeners with debounce
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => debouncedUpdateStatusBar(editor)),
        vscode.workspace.onDidChangeTextDocument(e => {
            if (vscode.window.activeTextEditor && e.document === vscode.window.activeTextEditor.document) {
                debouncedUpdateStatusBar(vscode.window.activeTextEditor);
            }
        })
    );

    // Initial update
    updateStatusBarImmediate(vscode.window.activeTextEditor);
}

interface ModelQuickPickItem extends vscode.QuickPickItem {
    modelId?: string;
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

async function handleUri(uri: vscode.Uri) {
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.type === vscode.FileType.Directory) {
        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Counting tokens in folder...",
            cancellable: true
        }, async (progress, token) => {
            const count = await countTokensInDirectory(uri, token);
            const modelInfo = tokenizerService.getModelInfo();
            vscode.window.showInformationMessage(
                `📁 ${path.basename(uri.fsPath)}: ${formatNumber(count)} tokens (${modelInfo?.label || tokenizerService.getModel()})`
            );
        });
    } else {
        await countFileTokens(uri, true);
    }
}

async function countFileTokens(uri: vscode.Uri, showNotification = false): Promise<number> {
    // Check for common binary extensions
    if (isBinaryFile(uri.fsPath)) {
        if (showNotification) {
            vscode.window.showWarningMessage(`Cannot count tokens: '${path.basename(uri.fsPath)}' appears to be a binary or unsupported file type.`);
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

function isBinaryFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    const binaryExtensions = [
        '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', // Images
        '.zip', '.tar', '.gz', '.7z', '.rar', // Archives
        '.exe', '.dll', '.so', '.dylib', '.bin', // Executables
        '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', // Documents
        '.mp3', '.mp4', '.wav', '.avi', '.mov' // Media
    ];
    return binaryExtensions.includes(ext);
}

async function countTokensInDirectory(uri: vscode.Uri, token: vscode.CancellationToken): Promise<number> {
    let total = 0;
    const entries = await vscode.workspace.fs.readDirectory(uri);

    for (const [name, type] of entries) {
        if (token.isCancellationRequested) break;

        // Skip hidden files and common non-source directories
        if (name.startsWith('.') || ['node_modules', 'dist', 'out', 'build', '__pycache__', '.git'].includes(name)) {
            continue;
        }

        const entryUri = vscode.Uri.joinPath(uri, name);

        if (type === vscode.FileType.Directory) {
            total += await countTokensInDirectory(entryUri, token);
        } else if (type === vscode.FileType.File) {
            try {
                const arr = await vscode.workspace.fs.readFile(entryUri);
                const text = new TextDecoder().decode(arr);
                total += tokenizerService.countTokens(text);
            } catch (e) {
                console.warn(`Skipping file ${name}: ${e}`);
            }
        }
    }
    return total;
}

function debouncedUpdateStatusBar(editor: vscode.TextEditor | undefined) {
    if (debounceTimer) {
        clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
        updateStatusBarImmediate(editor);
    }, 300);
}

function updateStatusBarImmediate(editor: vscode.TextEditor | undefined) {
    if (!editor) {
        statusBarItem.hide();
        return;
    }

    const text = editor.document.getText();
    const count = tokenizerService.countTokens(text);
    const modelInfo = tokenizerService.getModelInfo();

    statusBarItem.text = `$(hubot) ${formatNumber(count)} tokens`;
    statusBarItem.tooltip = `Token count for ${modelInfo?.label || tokenizerService.getModel()}\nClick to change model`;
    statusBarItem.show();
}

function formatNumber(num: number): string {
    if (num >= 1000000) {
        return (num / 1000000).toFixed(1) + 'M';
    } else if (num >= 1000) {
        return (num / 1000).toFixed(1) + 'K';
    }
    return num.toString();
}

export function deactivate() {
    if (debounceTimer) {
        clearTimeout(debounceTimer);
    }
}
