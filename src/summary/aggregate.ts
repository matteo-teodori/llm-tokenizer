/**
 * Turning a flat list of counted files into the few numbers the summary leads
 * with.
 *
 * Deliberately free of `vscode` imports: this is arithmetic over paths and
 * counts, and it is the part most worth testing directly.
 */

import { LANGUAGE_BY_EXTENSION } from './languages';

export interface CountedFile {
    path: string;
    tokens: number;
}

/** One row of a ranked breakdown. */
export interface Slice {
    label: string;
    tokens: number;
    files: number;
    /** Share of the run's total, 0–1. */
    share: number;
}

/**
 * How many rows a breakdown shows before folding the tail into "Other".
 *
 * Past roughly seven classes adjacent bars stop being separable at a glance,
 * and the reader is better served by the table underneath.
 */
export const MAX_SLICES = 8;

const SEPARATOR = /[/\\]/;

function segments(filePath: string): string[] {
    return filePath.split(SEPARATOR).filter(Boolean);
}

/**
 * The deepest directory every file shares.
 *
 * Breakdowns are relative to this rather than to the workspace root, so
 * right-clicking one deep folder groups by what is *inside* it instead of
 * reporting a single row named after the folder itself.
 */
export function commonRoot(files: readonly CountedFile[]): string[] {
    if (files.length === 0) {
        return [];
    }

    // Every path minus its file name.
    let prefix = segments(files[0].path).slice(0, -1);
    for (const file of files.slice(1)) {
        const parts = segments(file.path).slice(0, -1);
        let i = 0;
        while (i < prefix.length && i < parts.length && prefix[i] === parts[i]) {
            i++;
        }
        prefix = prefix.slice(0, i);
        if (prefix.length === 0) {
            break;
        }
    }
    return prefix;
}

/** Rank slices, fold the tail into "Other", and compute shares. */
function rank(totals: Map<string, { tokens: number; files: number }>, total: number): Slice[] {
    const sorted = [...totals.entries()]
        .map(([label, v]) => ({ label, ...v }))
        .sort((a, b) => b.tokens - a.tokens || a.label.localeCompare(b.label));

    const head = sorted.slice(0, MAX_SLICES);
    const tail = sorted.slice(MAX_SLICES);

    if (tail.length > 0) {
        head.push({
            label: 'Other',
            tokens: tail.reduce((sum, s) => sum + s.tokens, 0),
            files: tail.reduce((sum, s) => sum + s.files, 0),
        });
    }

    return head
        .filter(s => s.tokens > 0 || s.files > 0)
        .map(s => ({ ...s, share: total > 0 ? s.tokens / total : 0 }));
}

/**
 * Tokens grouped by the first path segment below the shared root.
 *
 * Files sitting directly in that root are grouped under "(root)" rather than
 * dropped, so the shares always add up to the whole.
 */
export function byFolder(files: readonly CountedFile[]): Slice[] {
    const root = commonRoot(files);
    const totals = new Map<string, { tokens: number; files: number }>();
    let total = 0;

    for (const file of files) {
        const parts = segments(file.path).slice(root.length);
        // parts always ends with the file name, so a length of 1 means the file
        // sits directly in the shared root.
        const label = parts.length > 1 ? parts[0] : '(root)';

        const entry = totals.get(label) ?? { tokens: 0, files: 0 };
        entry.tokens += file.tokens;
        entry.files += 1;
        totals.set(label, entry);
        total += file.tokens;
    }

    return rank(totals, total);
}

/** The lower-cased extension of a path, without the dot; '' when there is none. */
export function extensionOf(filePath: string): string {
    const name = segments(filePath).pop() ?? '';
    const dot = name.lastIndexOf('.');
    // A leading dot is part of the name (.gitignore), not an extension.
    return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** A human name for the file's language, falling back to the extension. */
export function languageOf(filePath: string): string {
    const extension = extensionOf(filePath);
    if (!extension) {
        const name = segments(filePath).pop() ?? '';
        // Dotfiles and extensionless files read better by name than as "".
        return name.startsWith('.') ? name : 'No extension';
    }
    return LANGUAGE_BY_EXTENSION[extension] ?? `.${extension}`;
}

/** Tokens grouped by language. */
export function byLanguage(files: readonly CountedFile[]): Slice[] {
    const totals = new Map<string, { tokens: number; files: number }>();
    let total = 0;

    for (const file of files) {
        const label = languageOf(file.path);
        const entry = totals.get(label) ?? { tokens: 0, files: 0 };
        entry.tokens += file.tokens;
        entry.files += 1;
        totals.set(label, entry);
        total += file.tokens;
    }

    return rank(totals, total);
}

/** Files ranked by token count, largest first. */
export function largestFirst(files: readonly CountedFile[]): CountedFile[] {
    return [...files].sort((a, b) => b.tokens - a.tokens || a.path.localeCompare(b.path));
}

/** A path shortened for display, relative to what every file shares. */
export function displayPath(filePath: string, root: readonly string[]): string {
    const parts = segments(filePath);
    // Only strip the root when the path really is under it.
    const isUnderRoot = root.every((segment, i) => parts[i] === segment);
    return (isUnderRoot ? parts.slice(root.length) : parts).join('/');
}
