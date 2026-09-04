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

/**
 * What a previous pass concluded about a file: a count, or that it is binary.
 *
 * The binary verdict is cached too, and that is not a micro-optimisation.
 * `BINARY_EXTENSIONS` cannot cover everything — .wasm, .jar, .node, .parquet,
 * .npy, .pkl, .pt and friends all reach the content sniff — and the verdict was
 * reached by reading the file *whole*, up to the 10 MB cap. Without this the
 * project scan re-read every one of them end to end, and it re-runs a couple of
 * seconds after every save.
 */
export type CachedOutcome = CachedCount | { binary: true };

export function isBinaryOutcome(outcome: CachedOutcome): outcome is { binary: true } {
    return 'binary' in outcome;
}

type Entry = { mtime: number } & CachedOutcome;

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

    /** What was stored for this exact file revision, if anything. */
    public get(modelId: string, uri: Uri, mtime: number): CachedOutcome | undefined {
        const entry = this.entries.get(CountCache.key(modelId, uri));
        if (!entry || entry.mtime !== mtime) {
            return undefined;
        }
        return isBinaryOutcome(entry)
            ? { binary: true }
            : { count: entry.count, exact: entry.exact };
    }

    public set(modelId: string, uri: Uri, mtime: number, value: CachedOutcome): void {
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
