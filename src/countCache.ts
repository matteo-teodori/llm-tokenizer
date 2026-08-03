/**
 * Per-file token count cache.
 *
 * Small enough to be obvious, separate enough to be testable — the two bugs
 * this has already had were both invisible at the call site:
 *
 *  - keyed on path alone, so switching model kept serving the previous model's
 *    numbers forever (mtimes were unchanged, so no rescan ever corrected it);
 *  - `exact` was not stored, so the second read of an estimated count reported
 *    it as exact, quietly dropping the ≈ while the number stayed a guess.
 */

import type { Uri } from 'vscode';

export interface CachedCount {
    count: number;
    /** False when the number came from a heuristic rather than a real tokenizer. */
    exact: boolean;
}

interface Entry extends CachedCount {
    mtime: number;
}

export class CountCache {
    private readonly entries = new Map<string, Entry>();

    /**
     * The cache key.
     *
     * Model id and URI are joined with a newline: it cannot occur in a model id
     * and is escaped in a URI, so two different pairs can never collide. (It
     * used to be a literal NUL, which worked but made every text tool — grep,
     * ripgrep, editors — treat the source file as binary.)
     */
    private static key(modelId: string, uri: Uri): string {
        return `${modelId}\n${uri.toString()}`;
    }

    /** The cached count, if one was stored for this exact file revision. */
    public get(modelId: string, uri: Uri, mtime: number): CachedCount | undefined {
        const entry = this.entries.get(CountCache.key(modelId, uri));
        if (!entry || entry.mtime !== mtime) {
            return undefined;
        }
        return { count: entry.count, exact: entry.exact };
    }

    public set(modelId: string, uri: Uri, mtime: number, value: CachedCount): void {
        this.entries.set(CountCache.key(modelId, uri), { ...value, mtime });
    }

    /** Forget one file, across every model. */
    public deleteFile(uri: Uri): void {
        const suffix = `\n${uri.toString()}`;
        for (const key of this.entries.keys()) {
            if (key.endsWith(suffix)) {
                this.entries.delete(key);
            }
        }
    }

    public clear(): void {
        this.entries.clear();
    }

    public get size(): number {
        return this.entries.size;
    }
}
