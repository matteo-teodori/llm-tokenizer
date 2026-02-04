import * as vscode from 'vscode';
import * as path from 'path';
import { FileNode, ProcessedFile, SkippedFile } from './types';
import { escapePathForHtml, formatNumber } from './utils';

/**
 * Build a hierarchical file tree from a flat list of files
 * @param files - Array of files with path and optional tokens/reason
 * @returns Root FileNode of the tree with calculated folder totals
 */
export function buildFileTree(
    files: { path: string; tokens?: number; reason?: string }[]
): FileNode {
    const root: FileNode = {
        name: 'root',
        path: '',
        isFile: false,
        children: new Map()
    };

    for (const file of files) {
        const fileUri = vscode.Uri.file(file.path);
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(fileUri);

        // Determine relative path from workspace root
        let relativePath = file.path;
        if (workspaceFolder) {
            relativePath = path.relative(workspaceFolder.uri.fsPath, file.path);
        }

        const parts = relativePath.split(path.sep);
        let current = root;

        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            const isLastPart = i === parts.length - 1;

            if (!current.children) {
                current.children = new Map();
            }

            if (!current.children.has(part)) {
                // Reconstruct the absolute path for opening files
                const nodePath = workspaceFolder
                    ? path.join(workspaceFolder.uri.fsPath, ...parts.slice(0, i + 1))
                    : parts.slice(0, i + 1).join(path.sep);

                current.children.set(part, {
                    name: part,
                    path: nodePath,
                    isFile: isLastPart,
                    tokens: isLastPart ? file.tokens : 0, // Initialize folder tokens to 0
                    reason: isLastPart ? file.reason : undefined,
                    children: isLastPart ? undefined : new Map()
                });
            }

            current = current.children.get(part)!;
        }
    }

    // Calculate folder totals recursively
    calculateFolderTotals(root);

    return root;
}

/**
 * Recursively calculate total tokens for each folder
 * @param node - FileNode to calculate totals for
 * @returns Total tokens in this node and all descendants
 */
function calculateFolderTotals(node: FileNode): number {
    if (node.isFile) {
        return node.tokens || 0;
    }

    let total = 0;
    if (node.children) {
        for (const child of node.children.values()) {
            total += calculateFolderTotals(child);
        }
    }

    node.tokens = total;
    return total;
}

/**
 * Render a file tree node as HTML
 * @param node - FileNode to render
 * @param isRoot - Whether this is the root node
 * @returns HTML string representation
 */
export function renderTreeAsHtml(node: FileNode, isRoot = false): string {
    if (isRoot && node.children) {
        return Array.from(node.children.values())
            .map(child => renderTreeAsHtml(child))
            .join('');
    }

    if (node.isFile) {
        const extra = node.tokens !== undefined
            ? `<span class="token-count">${formatNumber(node.tokens)} tokens</span>`
            : `<span class="reason">${node.reason}</span>`;

        return `
            <li class="file-item">
                <a href="#" class="file-link" data-path="${escapePathForHtml(node.path)}">${node.name}</a>
                ${extra}
            </li>
        `;
    } else {
        const childrenHtml = node.children
            ? Array.from(node.children.values())
                .map(child => renderTreeAsHtml(child))
                .join('')
            : '';

        // Show folder total tokens
        const folderTotal = node.tokens !== undefined && node.tokens > 0
            ? `<span class="folder-total">${formatNumber(node.tokens)} tokens</span>`
            : '';

        return `
            <li class="folder-item">
                <details>
                    <summary>
                        <span class="folder-icon">📁</span>${node.name}
                        ${folderTotal}
                    </summary>
                    <ul class="tree-list">
                        ${childrenHtml}
                    </ul>
                </details>
            </li>
        `;
    }
}

/**
 * Build HTML for processed files section
 * @param files - Array of processed files
 * @returns HTML string for the processed files tree
 */
export function buildProcessedFilesHtml(files: ProcessedFile[]): string {
    if (files.length === 0) {
        return '';
    }

    const tree = buildFileTree(files);
    return `
        <details open>
            <summary><strong>Processed Files (${files.length})</strong></summary>
            <ul class="tree-list root-list">
                ${renderTreeAsHtml(tree, true)}
            </ul>
        </details>
    `;
}

/**
 * Build HTML for skipped files section
 * @param files - Array of skipped files
 * @returns HTML string for the skipped files tree
 */
export function buildSkippedFilesHtml(files: SkippedFile[]): string {
    if (files.length === 0) {
        return '';
    }

    const tree = buildFileTree(files);
    return `
        <details>
            <summary><strong>Skipped Files (${files.length})</strong></summary>
            <ul class="tree-list root-list">
                ${renderTreeAsHtml(tree, true)}
            </ul>
        </details>
    `;
}
