import * as vscode from 'vscode';

import { ContextStatusResult, ProcessedFile, SkippedFile, IgnoredFile } from './types';
import { contentSecurityPolicy, createNonce } from './html';
import {
    byFolder,
    byLanguage,
    commonRoot,
    displayPath,
    largestFirst,
    type CountedFile,
} from './summary/aggregate';
import { renderSummary, type SummaryView } from './summary/render';

/**
 * Most files listed in the table.
 *
 * The panel keeps its context while hidden, so both the embedded data and the
 * rendered rows stay in memory for the lifetime of the window. Totals and the
 * breakdowns always cover every file — only the listing is capped.
 */
const MAX_LISTED_FILES = 1000;

export interface MultiFileSummaryConfig {
    totalTokens: number;
    filesProcessed: number;
    processedFiles: ProcessedFile[];
    skippedFiles: SkippedFile[];
    ignoredFiles: IgnoredFile[];
    modelLabel: string;
    /** False when any file in the run was counted by heuristic. */
    exact: boolean;
    /** True when the user stopped the run, so the total covers only part of it. */
    cancelled: boolean;
    contextStatus: ContextStatusResult;
}

function buildView(config: MultiFileSummaryConfig): SummaryView {
    const counted: CountedFile[] = config.processedFiles.map(f => ({
        path: f.path,
        tokens: f.tokens,
    }));

    // Paths are shown relative to what every entry shares, so counting one deep
    // folder does not show the same long prefix on every row.
    const root = commonRoot([
        ...counted,
        ...config.skippedFiles.map(f => ({ path: f.path, tokens: 0 })),
        ...config.ignoredFiles.map(f => ({ path: f.path, tokens: 0 })),
    ]);

    const ranked = largestFirst(counted);

    return {
        totalTokens: config.totalTokens,
        exact: config.exact,
        cancelled: config.cancelled,
        modelLabel: config.modelLabel,
        contextLimit: config.contextStatus.limit,
        filesCounted: config.filesProcessed,
        filesSkipped: config.skippedFiles.length,
        filesIgnored: config.ignoredFiles.length,
        byFolder: byFolder(counted),
        byLanguage: byLanguage(counted),
        files: ranked.slice(0, MAX_LISTED_FILES).map(f => ({
            path: f.path,
            display: displayPath(f.path, root),
            tokens: f.tokens,
        })),
        filesNotListed: Math.max(0, ranked.length - MAX_LISTED_FILES),
        skipped: config.skippedFiles
            .slice(0, MAX_LISTED_FILES)
            .map(f => ({ display: displayPath(f.path, root), reason: f.reason })),
        ignored: config.ignoredFiles
            .slice(0, MAX_LISTED_FILES)
            .map(f => ({ display: displayPath(f.path, root) })),
    };
}

/** Create and show the multi-file token summary. */
export function showMultiFileSummary(config: MultiFileSummaryConfig): vscode.WebviewPanel {
    const panel = vscode.window.createWebviewPanel(
        'llmTokenizer.summary',
        'Token Summary',
        vscode.ViewColumn.Active,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            // The page is fully self-contained, so it needs nothing on disk.
            localResourceRoots: [],
        },
    );

    // The webview may only ask to open a file this summary actually listed.
    // Without that check, anything able to post a message could make the
    // extension open an arbitrary path.
    const openable = new Set(config.processedFiles.map(f => f.path));

    panel.webview.onDidReceiveMessage(async (message: unknown) => {
        if (typeof message !== 'object' || message === null) {
            return;
        }
        const { command, path: requested, text } = message as {
            command?: unknown;
            path?: unknown;
            text?: unknown;
        };

        if (command === 'openFile' && typeof requested === 'string' && openable.has(requested)) {
            await vscode.window.showTextDocument(vscode.Uri.file(requested));
            return;
        }

        if ((command === 'copy' || command === 'export') && typeof text === 'string') {
            await vscode.env.clipboard.writeText(text);
            void vscode.window.showInformationMessage(
                command === 'export'
                    ? 'LLM Tokenizer: CSV copied to the clipboard.'
                    : 'LLM Tokenizer: file list copied to the clipboard.',
            );
        }
    });

    const nonce = createNonce();
    panel.webview.html = renderSummary(buildView(config), nonce, contentSecurityPolicy(nonce));
    return panel;
}
