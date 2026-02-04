import * as vscode from 'vscode';
import { TokenizerService } from './tokenizer';
import { formatNumber, getStatusIndicator } from './utils';

/**
 * StatusBarManager handles all status bar related functionality
 */
export class StatusBarManager {
    private fileStatusBar: vscode.StatusBarItem;
    private projectStatusBar: vscode.StatusBarItem;
    private projectTokenCount: number = 0;

    constructor(
        private tokenizerService: TokenizerService,
        context: vscode.ExtensionContext
    ) {
        // File token count status bar (right side, higher priority)
        this.fileStatusBar = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            100
        );
        this.fileStatusBar.command = 'llm-tokenizer.selectModel';
        context.subscriptions.push(this.fileStatusBar);

        // Project token count status bar (right side, lower priority)
        this.projectStatusBar = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            99
        );
        this.projectStatusBar.command = 'llm-tokenizer.selectModel';
        this.projectStatusBar.tooltip = 'Project-wide token count\nClick to change model';
        context.subscriptions.push(this.projectStatusBar);
    }

    /**
     * Update file status bar based on active editor
     */
    public updateFileStatusBar(editor: vscode.TextEditor | undefined): void {
        if (!editor || !editor.document) {
            this.fileStatusBar.hide();
            return;
        }

        try {
            const document = editor.document;
            if (document.isClosed) {
                return;
            }

            // Determine text to count (selection or entire document)
            const isSelection = !editor.selection.isEmpty;
            const text = isSelection
                ? document.getText(editor.selection)
                : document.getText();

            const count = this.tokenizerService.countTokens(text);
            const modelInfo = this.tokenizerService.getModelInfo();
            const contextStatus = this.tokenizerService.getContextStatus(count);
            const indicator = getStatusIndicator(contextStatus.status);

            // Update status bar text
            const suffix = isSelection ? ' (selection)' : '';
            this.fileStatusBar.text = `${indicator.icon} ${formatNumber(count)} token${count !== 1 ? 's' : ''}${suffix}`;
            this.fileStatusBar.color = indicator.color;

            // Build tooltip
            let tooltip = `Token count for ${modelInfo?.label || this.tokenizerService.getModel()}\nClick to change model`;
            if (contextStatus.limit) {
                tooltip += `\n\nContext: ${contextStatus.percentage.toFixed(1)}% of ${formatNumber(contextStatus.limit)} limit`;
                if (contextStatus.status === 'warning') {
                    tooltip += '\n⚠️ Approaching context limit (80%+)';
                } else if (contextStatus.status === 'error') {
                    tooltip += '\n🔴 Exceeds context limit!';
                }
            }
            this.fileStatusBar.tooltip = tooltip;

            this.updateDisplayMode();
        } catch (error) {
            // Silently handle errors during rapid file switching
            console.debug('Token count update skipped:', error);
        }
    }

    /**
     * Update project status bar with total token count
     */
    public updateProjectStatusBar(count: number): void {
        this.projectTokenCount = count;

        const modelInfo = this.tokenizerService.getModelInfo();
        const contextStatus = this.tokenizerService.getContextStatus(count);
        const indicator = getStatusIndicator(contextStatus.status, '📂');

        this.projectStatusBar.text = `${indicator.icon} ${formatNumber(count)} tokens`;
        this.projectStatusBar.color = indicator.color;

        // Build tooltip
        let tooltip = `Project-wide token count\nModel: ${modelInfo?.label || this.tokenizerService.getModel()}\nClick to change model`;
        if (contextStatus.limit) {
            tooltip += `\n\nContext: ${contextStatus.percentage.toFixed(1)}% of ${formatNumber(contextStatus.limit)} limit`;
            if (contextStatus.status === 'warning') {
                tooltip += '\n⚠️ Approaching context limit (80%+)';
            } else if (contextStatus.status === 'error') {
                tooltip += '\n🔴 Exceeds context limit!';
            }
        }
        this.projectStatusBar.tooltip = tooltip;

        this.updateDisplayMode();
    }

    /**
     * Update display based on user configuration
     */
    public updateDisplayMode(): void {
        const config = vscode.workspace.getConfiguration('llm-tokenizer');
        const displayMode = config.get<string>('statusBarDisplay', 'file');

        switch (displayMode) {
            case 'project':
                this.fileStatusBar.hide();
                this.projectStatusBar.show();
                break;
            case 'both':
                this.fileStatusBar.show();
                this.projectStatusBar.show();
                break;
            case 'file':
            default:
                this.fileStatusBar.show();
                this.projectStatusBar.hide();
                break;
        }
    }

    /**
     * Hide all status bars
     */
    public hideAll(): void {
        this.fileStatusBar.hide();
        this.projectStatusBar.hide();
    }
}
