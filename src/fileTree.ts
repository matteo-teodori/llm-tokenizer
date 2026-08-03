import * as vscode from 'vscode';
import * as path from 'path';
import { FileNode, ProcessedFile, SkippedFile, IgnoredFile } from './types';
import { formatNumber } from './utils';
import { escapeHtml } from './html';

/**
 * Build a hierarchical file tree from a flat list of files
 * @param files - Array of files with path and optional tokens/reason
 * @returns Root FileNode of the tree with calculated folder totals
 */
export function buildFileTree(
    files: { path: string; tokens?: number; reason?: string; isDirectory?: boolean }[]
): FileNode {
    const root: FileNode = {
        name: 'root',
        path: '',
        isFile: false,
        children: new Map()
    };

    // In a multi-root workspace, `src/index.ts` can exist in two roots. Without
    // the folder name in the path they collide into one node showing one file's
    // count while the header reports the sum of both.
    const multiRoot = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;

    for (const file of files) {
        const fileUri = vscode.Uri.file(file.path);
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(fileUri);

        // Determine relative path from workspace root
        let relativePath = file.path;
        if (workspaceFolder) {
            relativePath = path.relative(workspaceFolder.uri.fsPath, file.path);
            if (multiRoot) {
                relativePath = path.join(workspaceFolder.name, relativePath);
            }
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
                // Reconstruct the absolute path so the node can be opened.
                // In multi-root mode the first segment is the folder name we
                // prefixed above, not a real directory, so it is dropped here.
                const segments = parts.slice(multiRoot && workspaceFolder ? 1 : 0, i + 1);
                const nodePath = workspaceFolder
                    ? path.join(workspaceFolder.uri.fsPath, ...segments)
                    : parts.slice(0, i + 1).join(path.sep);

                current.children.set(part, {
                    name: part,
                    path: nodePath,
                    // An ignored *directory* is a leaf of this tree but is not
                    // a file: rendering it as a link produced a row that looked
                    // clickable and did nothing.
                    isFile: isLastPart && !file.isDirectory,
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

    // Node names, paths and skip reasons all come from the workspace, so every
    // one of them is escaped before it reaches the document.
    if (node.isFile) {
        const extra = node.tokens !== undefined
            ? `<span class="token-count">${formatNumber(node.tokens)} tokens</span>`
            : `<span class="reason">${escapeHtml(node.reason ?? '')}</span>`;

        return `
            <li class="file-item">
                <a href="#" class="file-link" data-path="${escapeHtml(node.path)}">${escapeHtml(node.name)}</a>
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
                        <span class="folder-icon">📁</span>${escapeHtml(node.name)}
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
/**
 * Most files a listing will render.
 *
 * The panel is created with `retainContextWhenHidden`, so a scan of a large
 * monorepo used to build a multi-megabyte HTML string and hold it, plus one DOM
 * node per file, for the lifetime of the window. Totals are still computed over
 * every file — only the listing is capped.
 */
const MAX_LISTED_FILES = 1000;

function truncate<T extends { path: string }>(files: T[]): { shown: T[]; hidden: number } {
    if (files.length <= MAX_LISTED_FILES) {
        return { shown: files, hidden: 0 };
    }
    return { shown: files.slice(0, MAX_LISTED_FILES), hidden: files.length - MAX_LISTED_FILES };
}

function truncationNote(hidden: number): string {
    return hidden === 0
        ? ''
        : `<p class="truncation">…and ${hidden.toLocaleString('en-US')} more, not listed. The total above includes them.</p>`;
}

export function buildProcessedFilesHtml(files: ProcessedFile[]): string {
    if (files.length === 0) {
        return '';
    }

    // Largest first, so the cap keeps the files that matter.
    const sorted = [...files].sort((a, b) => b.tokens - a.tokens);
    const { shown, hidden } = truncate(sorted);
    const tree = buildFileTree(shown);

    return `
        <details open>
            <summary><strong>Processed Files (${files.length})</strong></summary>
            <ul class="tree-list root-list">
                ${renderTreeAsHtml(tree, true)}
            </ul>
            ${truncationNote(hidden)}
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

    const { shown, hidden } = truncate(files);
    return `
        <details>
            <summary><strong>Skipped Files (${files.length})</strong></summary>
            <ul class="tree-list root-list">
                ${renderTreeAsHtml(buildFileTree(shown), true)}
            </ul>
            ${truncationNote(hidden)}
        </details>
    `;
}

/**
 * Build HTML for ignored files section
 * @param files - Array of ignored files
 * @returns HTML string for the ignored files tree
 */
export function buildIgnoredFilesHtml(files: IgnoredFile[]): string {
    if (files.length === 0) {
        return '';
    }

    const { shown, hidden } = truncate(files);
    return `
        <details>
            <summary><strong>Ignored Files (${files.length})</strong></summary>
            <ul class="tree-list root-list">
                ${renderTreeAsHtml(buildFileTree(shown), true)}
            </ul>
            ${truncationNote(hidden)}
        </details>
    `;
}
