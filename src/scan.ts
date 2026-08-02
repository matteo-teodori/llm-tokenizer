/**
 * Workspace traversal.
 *
 * There used to be two independent walks — one for right-click on a folder and
 * one for the project-wide count — and they disagreed about dotfiles, ignored
 * directories and `.gitignore`, so the same tree produced two different totals.
 * Both now go through `shouldDescend` / `shouldCount` here.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import ignore, { type Ignore } from 'ignore';

import { BINARY_EXTENSIONS, IGNORED_DIRECTORIES, MAX_TOKENIZED_FILE_BYTES } from './constants';

/** Why a file was not counted, shown in the summary. */
export type SkipReason = 'binary' | 'too-large' | 'unreadable' | 'gitignored';

export interface ScanEntry {
    uri: vscode.Uri;
    /** Size in bytes, from the directory stat. */
    size: number;
}

/**
 * Per-workspace-folder context for a walk.
 *
 * Anchoring on `workspaceFolders[0]` was the single largest correctness bug in
 * v1.3.0: in a multi-root workspace every file outside the first folder
 * produced a `../otherRoot/...` relative path, which `ignore` rejects by
 * throwing — killing the whole scan for the rest of the session.
 */
export class FolderContext {
    private constructor(
        readonly folder: vscode.WorkspaceFolder,
        private readonly ig: Ignore | undefined,
    ) {}

    /**
     * A context for files that belong to no workspace folder — a standalone
     * file opened on its own, or one outside every root. Nothing to match
     * `.gitignore` against, so nothing is ignored.
     *
     * These used to be skipped outright, so counting such a file reported a
     * total of zero with no indication why.
     */
    static none(root: vscode.Uri): FolderContext {
        return new FolderContext({ uri: root, name: '', index: 0 }, undefined);
    }

    static async create(
        folder: vscode.WorkspaceFolder,
        respectGitignore: boolean,
    ): Promise<FolderContext> {
        if (!respectGitignore) {
            return new FolderContext(folder, undefined);
        }

        const ig = ignore();
        // `.git/info/exclude` is repo-local and just as binding as .gitignore.
        for (const candidate of ['.gitignore', '.git/info/exclude']) {
            try {
                const uri = vscode.Uri.joinPath(folder.uri, candidate);
                ig.add(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)));
            } catch {
                // Absent, which is normal.
            }
        }

        return new FolderContext(folder, ig);
    }

    /**
     * True when `uri` is excluded by the folder's ignore rules.
     *
     * `isDirectory` matters: `ignore` treats `build/` as matching `build/` but
     * not `build`, so a trailing slash has to be supplied for directories or
     * whole ignored trees get walked.
     */
    isIgnored(uri: vscode.Uri, isDirectory: boolean): boolean {
        if (!this.ig) {
            return false;
        }

        const relative = path.posix.relative(this.folder.uri.path, uri.path);
        // Outside this folder, or the folder itself; `ignore` throws on both.
        if (!relative || relative.startsWith('..')) {
            return false;
        }

        return this.ig.ignores(isDirectory ? `${relative}/` : relative);
    }
}

/** Whether to walk into a directory. */
export function shouldDescend(name: string, uri: vscode.Uri, context: FolderContext): boolean {
    if (IGNORED_DIRECTORIES.has(name)) {
        return false;
    }
    return !context.isIgnored(uri, true);
}

/**
 * Whether a file should be tokenized, and if not, why.
 *
 * Size is checked before reading: a 40 MB CSV costs ~4.5 heap bytes per input
 * byte to tokenize, so an unguarded read on a large data file was enough to
 * take the extension host down.
 */
export function shouldCount(
    uri: vscode.Uri,
    size: number,
    context: FolderContext,
): SkipReason | undefined {
    if (BINARY_EXTENSIONS.has(path.extname(uri.fsPath).toLowerCase())) {
        return 'binary';
    }
    if (size > MAX_TOKENIZED_FILE_BYTES) {
        return 'too-large';
    }
    if (context.isIgnored(uri, false)) {
        return 'gitignored';
    }
    return undefined;
}

/** How much of a file to inspect when deciding whether it is text. */
const SNIFF_BYTES = 8192;

/**
 * Whether the bytes look like binary content.
 *
 * The extension list is a fast reject, but it can only catch what it knows:
 * `.dat`, `.pack`, `.bin` under another name, and extensionless files all
 * reached the tokenizer as text. A NUL byte in the first few KB is the same
 * heuristic git uses, and it is decisive in practice — well-formed UTF-8 text
 * does not contain one.
 */
export function looksBinary(bytes: Uint8Array): boolean {
    const limit = Math.min(bytes.length, SNIFF_BYTES);
    for (let i = 0; i < limit; i++) {
        if (bytes[i] === 0) {
            return true;
        }
    }
    return false;
}

/** Human-readable form of a skip reason, for the summary webview. */
export function describeSkipReason(reason: SkipReason): string {
    switch (reason) {
        case 'binary': return 'Binary or unsupported file type';
        case 'too-large': return `Larger than ${MAX_TOKENIZED_FILE_BYTES / 1024 / 1024} MB`;
        case 'unreadable': return 'Could not be read';
        case 'gitignored': return 'Excluded by .gitignore';
    }
}

/**
 * A glob that excludes the directories we never count.
 *
 * `findFiles` replaces VS Code's default excludes when given an explicit
 * pattern, so excluding only node_modules silently re-enabled `.git`
 * traversal — and loose git objects have no extension, so they sailed past the
 * binary check and got tokenized as compressed text.
 */
export function buildExcludeGlob(): string {
    return `{${[...IGNORED_DIRECTORIES].map(dir => `**/${dir}/**`).join(',')}}`;
}

/**
 * Remove URIs contained within another selected URI.
 *
 * Selecting a folder and a file inside it in the explorer used to count that
 * file twice.
 */
export function dedupeSelection(uris: readonly vscode.Uri[]): vscode.Uri[] {
    const unique = [...new Map(uris.map(uri => [uri.toString(), uri])).values()];
    // Shortest paths first, so a parent is always seen before its children.
    unique.sort((a, b) => a.path.length - b.path.length);

    const kept: vscode.Uri[] = [];
    for (const uri of unique) {
        const contained = kept.some(parent => uri.path.startsWith(`${parent.path}/`));
        if (!contained) {
            kept.push(uri);
        }
    }
    return kept;
}

/** `FileType` is a bitmask — a symlinked directory is `Directory | SymbolicLink`. */
export function isDirectory(type: vscode.FileType): boolean {
    return (type & vscode.FileType.Directory) !== 0;
}

export function isFile(type: vscode.FileType): boolean {
    return (type & vscode.FileType.File) !== 0;
}
