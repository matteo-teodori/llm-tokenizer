import * as vscode from 'vscode';

/**
 * Status indicator types for context limit visualization
 */
export type ContextStatus = 'ok' | 'warning' | 'error';

/**
 * Result from context status calculation
 */
export interface ContextStatusResult {
    percentage: number;
    status: ContextStatus;
    limit: number | undefined;
}

/**
 * File info with token count
 */
export interface ProcessedFile {
    path: string;
    tokens: number;
}

/**
 * Skipped file info with reason
 */
export interface SkippedFile {
    path: string;
    reason: string;
}

/**
 * Result from directory token counting
 */
export interface DirectoryCountResult {
    count: number;
    files: ProcessedFile[];
    skipped: SkippedFile[];
}

/**
 * File tree node for hierarchical display
 */
export interface FileNode {
    name: string;
    path: string;
    isFile: boolean;
    tokens?: number;
    reason?: string;
    children?: Map<string, FileNode>;
}

/**
 * Extended QuickPickItem with model ID
 */
export interface ModelQuickPickItem extends vscode.QuickPickItem {
    modelId?: string;
}

/**
 * Status indicator with icon and optional color
 */
export interface StatusIndicator {
    icon: string;
    color?: vscode.ThemeColor;
}

/**
 * Cache entry for project token counting
 */
export interface TokenCacheEntry {
    count: number;
    mtime: number;
}
