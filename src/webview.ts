import * as vscode from 'vscode';
import { TokenizerService } from './tokenizer';
import { ContextStatusResult, ProcessedFile, SkippedFile } from './types';
import { formatNumber, getStatusColor } from './utils';
import { buildProcessedFilesHtml, buildSkippedFilesHtml } from './fileTree';

/**
 * Configuration for multi-file summary webview
 */
export interface MultiFileSummaryConfig {
    totalTokens: number;
    filesProcessed: number;
    processedFiles: ProcessedFile[];
    skippedFiles: SkippedFile[];
    modelLabel: string;
    contextStatus: ContextStatusResult;
}

/**
 * Create and show a webview panel with multi-file token summary
 */
export function showMultiFileSummary(config: MultiFileSummaryConfig): vscode.WebviewPanel {
    const panel = vscode.window.createWebviewPanel(
        'multiFileSummary',
        'Multi-file Token Summary',
        vscode.ViewColumn.Active,
        {
            enableScripts: true,
            retainContextWhenHidden: true  // Preserve tree state when switching tabs
        }
    );

    // Handle file clicks from webview
    panel.webview.onDidReceiveMessage(async message => {
        if (message.command === 'openFile') {
            const uri = vscode.Uri.file(message.path);
            await vscode.window.showTextDocument(uri);
        }
    });

    panel.webview.html = generateSummaryHtml(config);
    return panel;
}

/**
 * Get status icon based on context status
 */
function getStatusIcon(status: ContextStatusResult['status']): string {
    switch (status) {
        case 'error': return '🔴';
        case 'warning': return '⚠️';
        default: return '📊';
    }
}

/**
 * Generate context info HTML if limit exists
 */
function generateContextInfoHtml(contextStatus: ContextStatusResult): string {
    if (!contextStatus.limit) {
        return '';
    }

    let html = `<p><strong>Context Usage:</strong> ${contextStatus.percentage.toFixed(1)}% of ${formatNumber(contextStatus.limit)} tokens</p>`;

    if (contextStatus.status === 'warning') {
        html += '<p style="color: #ff9800;">⚠️ Approaching context limit (80%+)</p>';
    } else if (contextStatus.status === 'error') {
        html += '<p style="color: #f44336;">🔴 Exceeds context limit!</p>';
    }

    return html;
}

/**
 * Generate complete HTML for multi-file summary webview
 */
function generateSummaryHtml(config: MultiFileSummaryConfig): string {
    const {
        totalTokens,
        filesProcessed,
        processedFiles,
        skippedFiles,
        modelLabel,
        contextStatus
    } = config;

    const statusColor = getStatusColor(contextStatus.status);
    const icon = getStatusIcon(contextStatus.status);
    const contextInfo = generateContextInfoHtml(contextStatus);
    const processedFilesHtml = buildProcessedFilesHtml(processedFiles);
    const skippedFilesHtml = buildSkippedFilesHtml(skippedFiles);

    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <style>
        body {
            font-family: var(--vscode-font-family);
            color: var(--vscode-foreground);
            padding: 20px;
            line-height: 1.6;
        }
        h1 {
            color: ${statusColor};
            border-bottom: 2px solid ${statusColor};
            padding-bottom: 10px;
            margin-bottom: 20px;
        }
        p { margin: 8px 0; }
        strong { color: var(--vscode-textLink-foreground); }
        .icon { font-size: 1.2em; margin-right: 8px; }
        
        details {
            margin-top: 20px;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            padding: 10px;
        }
        summary {
            cursor: pointer;
            user-select: none;
            padding: 5px;
        }
        summary:hover { background: var(--vscode-list-hoverBackground); }
        
        .tree-list {
            list-style: none;
            padding-left: 20px;
            margin: 0;
        }
        .root-list { padding-left: 0; padding-top: 10px; }
        
        .folder-item { margin: 4px 0; }
        .folder-item > details { border: none; padding: 0; margin: 0; }
        .folder-item > details > summary {
            padding: 4px 8px;
            border-radius: 3px;
            font-weight: 500;
        }
        .folder-item > details > summary:hover {
            background: var(--vscode-list-hoverBackground);
        }
        .folder-icon { margin-right: 6px; }
        
        .file-item {
            padding: 4px 8px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-radius: 3px;
        }
        .file-item:hover { background: var(--vscode-list-hoverBackground); }
        
        .file-link {
            color: var(--vscode-textLink-foreground);
            text-decoration: none;
            cursor: pointer;
        }
        .file-link:hover { text-decoration: underline; }
        
        .token-count {
            color: var(--vscode-descriptionForeground);
            font-size: 0.9em;
        }
        .reason {
            color: var(--vscode-errorForeground);
            font-size: 0.9em;
            font-style: italic;
        }
        .folder-total {
            color: var(--vscode-textPreformat-foreground);
            font-size: 0.85em;
            font-weight: normal;
            margin-left: 10px;
            opacity: 0.8;
        }
    </style>
</head>
<body>
    <h1><span class="icon">${icon}</span>Multi-file Summary</h1>
    <p><strong>Total Tokens:</strong> ${formatNumber(totalTokens)}</p>
    <p><strong>Files Processed:</strong> ${filesProcessed}</p>
    ${skippedFiles.length > 0 ? `<p><strong>Files Skipped:</strong> ${skippedFiles.length}</p>` : ''}
    <p><strong>Model:</strong> ${modelLabel}</p>
    ${contextInfo}
    ${processedFilesHtml}
    ${skippedFilesHtml}
    <script>
        const vscode = acquireVsCodeApi();
        document.querySelectorAll('.file-link').forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                const path = e.target.dataset.path;
                vscode.postMessage({ command: 'openFile', path: path });
            });
        });
    </script>
</body>
</html>
    `;
}
