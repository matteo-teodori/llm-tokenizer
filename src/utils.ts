import * as vscode from 'vscode';
import * as path from 'path';
import { BINARY_EXTENSIONS } from './constants';
import { ContextStatus, StatusIndicator } from './types';

/**
 * Format a number with K/M suffixes for readability
 * @param num - Number to format
 * @returns Formatted string (e.g., "1.5K", "2.3M")
 */
export function formatNumber(num: number): string {
    if (num >= 1_000_000) {
        return (num / 1_000_000).toFixed(1) + 'M';
    } else if (num >= 1_000) {
        return (num / 1_000).toFixed(1) + 'K';
    }
    return num.toString();
}

/**
 * Check if a file is binary based on its extension
 * @param filePath - Path to the file
 * @returns true if the file is binary/unsupported
 */
export function isBinaryFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return BINARY_EXTENSIONS.has(ext);
}

/**
 * Get status indicator (icon and color) based on context status
 * @param status - Context status ('ok', 'warning', 'error')
 * @param defaultIcon - Default icon for 'ok' status
 * @returns StatusIndicator with icon and optional color
 */
export function getStatusIndicator(
    status: ContextStatus,
    defaultIcon: string = '$(hubot)'
): StatusIndicator {
    switch (status) {
        case 'error':
            return {
                icon: '🔴',
                color: new vscode.ThemeColor('editorError.foreground')
            };
        case 'warning':
            return {
                icon: '⚠️',
                color: new vscode.ThemeColor('editorWarning.foreground')
            };
        default:
            return {
                icon: defaultIcon,
                color: undefined
            };
    }
}

/**
 * Get status color for HTML/CSS styling
 * @param status - Context status
 * @returns CSS color string
 */
export function getStatusColor(status: ContextStatus): string {
    switch (status) {
        case 'error':
            return '#f44336'; // red
        case 'warning':
            return '#ff9800'; // orange
        default:
            return '#4CAF50'; // green
    }
}

/**
 * Escape backslashes for safe use in HTML data attributes
 * @param filePath - File path to escape
 * @returns Escaped path string
 */
export function escapePathForHtml(filePath: string): string {
    return filePath.replace(/\\/g, '\\\\');
}

/**
 * Build a relative path from workspace folder
 * @param filePath - Absolute file path
 * @returns Relative path from workspace, or original if no workspace
 */
export function getRelativePath(filePath: string): string {
    const fileUri = vscode.Uri.file(filePath);
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(fileUri);

    if (workspaceFolder) {
        return path.relative(workspaceFolder.uri.fsPath, filePath);
    }
    return filePath;
}
