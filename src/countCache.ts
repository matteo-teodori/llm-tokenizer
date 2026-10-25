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
 *
 * `DocumentCounts`, below it, does the same for the open documents the status
 * bar counts, which have a version rather than an mtime.
 */

import type { TextDocument, Uri } from 'vscode';

import { accuracyOf } from './tokenizer/encoders';
import type { ModelInfo } from './tokenizer/registry';

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

type Entry = { modelId: string; mtime: number } & CachedOutcome;

export class CountCache {
    /**
     * Entries by file URI: a file's one entry, or, once it has been counted
     * under more than one model, a map of them by model id.
     *
     * Forgetting a file is what the file watcher asks for every file that
     * changes or goes, synchronously on the extension host's thread. With one
     * map keyed by model and URI together, that was a walk of every entry:
     * measured at 1.5–1.9 ms a file with one entry for each file of a
     * 35,000-file workspace, so a checkout touching 5,000 files held the
     * thread, and every extension in the window, for 7–9 s. Keyed by file
     * first, it is one lookup, and the same 5,000 take about 3 ms.
     *
     * A lone entry is kept as it is because one model is the usual case, and
     * a map for every file cost two thirds more heap for it: 14.9 MB against
     * 9.0 for those 35,000 files, measured, where this holds 9.4.
     */
    private readonly files = new Map<string, Entry | Map<string, Entry>>();

    /** Entries across every file, kept as they come and go rather than counted. */
    private entries = 0;

    /** What was stored for this exact file revision, if anything. */
    public get(modelId: string, uri: Uri, mtime: number): CachedOutcome | undefined {
        const held = this.files.get(uri.toString());
        const entry = held instanceof Map ? held.get(modelId) : held?.modelId === modelId ? held : undefined;
        if (!entry || entry.mtime !== mtime) {
            return undefined;
        }
        return isBinaryOutcome(entry)
            ? { binary: true }
            : { count: entry.count, exact: entry.exact };
    }

    public set(modelId: string, uri: Uri, mtime: number, value: CachedOutcome): void {
        const key = uri.toString();
        const entry: Entry = { ...value, modelId, mtime };
        const held = this.files.get(key);
        if (held instanceof Map) {
            if (!held.has(modelId)) {
                this.entries++;
            }
            held.set(modelId, entry);
        } else if (held && held.modelId !== modelId) {
            this.entries++;
            this.files.set(key, new Map([[held.modelId, held], [modelId, entry]]));
        } else {
            if (!held) {
                this.entries++;
            }
            this.files.set(key, entry);
        }
    }

    /** Forget one file, across every model. */
    public deleteFile(uri: Uri): void {
        const key = uri.toString();
        const held = this.files.get(key);
        if (held) {
            this.entries -= held instanceof Map ? held.size : 1;
            this.files.delete(key);
        }
    }

    public clear(): void {
        this.files.clear();
        this.entries = 0;
    }

    public get size(): number {
        return this.entries;
    }
}

/** A document's count: of one version of its text, by one model. */
interface DocumentCount {
    version: number;
    modelId: string;
    count: Promise<CachedCount>;
}

/**
 * The whole-text counts of open documents, which the status bar shows.
 *
 * Every cursor stop in an editor with no selection, and every switch back to
 * its tab, sent the whole document to the worker again, though neither its
 * text nor the model had changed. The worker answers one request at a time, in
 * order, and cannot drop one, so each recount also held up every count queued
 * behind it, the project scan's included: measured with Llama 3.3's tokenizer,
 * a 1.9 MB file took about half a second a count, and a 20-byte count posted
 * behind five of them waited 2.8 s.
 *
 * A document's version changes with every edit, so the version and the model
 * say whether its text has been counted. Entries are keyed by the document
 * itself, not its URI: a document closed and opened again starts again at
 * version 1, possibly with other text, and its entry goes with the document. A
 * count still in flight is shared rather than posted again.
 */
export class DocumentCounts {
    private counts = new WeakMap<object, DocumentCount>();

    constructor(private readonly tokenize: (text: string, model: ModelInfo) => Promise<CachedCount>) {}

    /** The count of `document`'s whole text by `model`, reusing one already made of this version. */
    public count(document: Pick<TextDocument, 'version' | 'getText'>, model: ModelInfo): Promise<CachedCount> {
        const known = this.counts.get(document);
        if (known && known.version === document.version && known.modelId === model.id) {
            return known.count;
        }

        const counts = this.counts;
        const entry: DocumentCount = {
            version: document.version,
            modelId: model.id,
            count: this.tokenize(document.getText(), model),
        };
        counts.set(document, entry);

        // Only an answer is kept. An estimate from a model that can count
        // exactly means the count degraded — the worker crashed, timed out or
        // errored — and the next refresh should ask again rather than show the
        // guess until the next edit. Whether a downloadable model's vocabulary
        // is there would cost a read to find out, on every keystroke, so its
        // estimates are counted again too: the worker only divides for them.
        const forget = (): void => {
            if (counts.get(document) === entry) {
                counts.delete(document);
            }
        };
        void entry.count.then(result => {
            if (!result.exact && accuracyOf(model.encoder) !== 'estimated') {
                forget();
            }
        }, forget);

        return entry.count;
    }

    /**
     * Forget every document's count. Called with the per-file cache's clear:
     * a vocabulary downloaded or deleted changes the answer for an unchanged
     * document too.
     */
    public clear(): void {
        this.counts = new WeakMap();
    }
}
