/**
 * Extension-host side of tokenisation.
 *
 * Owns the worker thread, the request/response correlation, and the decision of
 * whether a given model can currently be counted exactly.
 */

import { Worker } from 'worker_threads';
import * as vscode from 'vscode';

import {
    isDownloadable,
    supportsRankTables,
    type DownloadableSpec,
    type EncoderSpec,
} from './encoders';
import type { WorkerRequest, WorkerResponse } from './protocol';
import { TokenizerStore, type AssetKind } from './tokenizerStore';
import type { ModelInfo } from './registry';
import { MAX_TOKENIZED_FILE_BYTES } from '../constants';

/** A token count plus whether it can be trusted as exact. */
export interface TokenCount {
    count: number;
    exact: boolean;
}

/** Raised when the worker dies with requests outstanding. */
export class TokenizerWorkerError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'TokenizerWorkerError';
    }
}

interface Pending {
    resolve(value: WorkerResponse): void;
    reject(error: Error): void;
}

/** Give up rather than leaking a promise if the worker goes silent. */
const REQUEST_TIMEOUT_MS = 120_000;

export class TokenizerService implements vscode.Disposable {
    private worker: Worker | undefined;
    private nextId = 0;
    private readonly pending = new Map<number, Pending>();
    private disposed = false;

    /** Repos whose tokenizer the worker already holds. */
    private readonly loadedRepos = new Set<string>();
    private readonly loading = new Map<string, Promise<boolean>>();

    /**
     * Repos known not to be on disk, or whose load failed.
     *
     * Without this, every count for a model with no downloaded tokenizer hit
     * the file system to ask again — once per file, so a scan of a 35k-file
     * workspace made 35k pointless stat calls — and a tokenizer.json that
     * fails to build was retried on every one of them.
     */
    private readonly unavailable = new Set<string>();

    private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
    /** Fires when a tokenizer finishes downloading, so counts can be refreshed. */
    public readonly onDidChangeAccuracy = this.onDidChangeEmitter.event;

    constructor(
        private readonly workerPath: string,
        private readonly store: TokenizerStore,
        private readonly log: vscode.LogOutputChannel,
    ) {}

    public dispose(): void {
        this.disposed = true;
        this.failAllPending(new TokenizerWorkerError('The tokenizer was shut down'));
        void this.worker?.terminate();
        this.worker = undefined;
        this.onDidChangeEmitter.dispose();
    }

    /**
     * Count the tokens in `text` for `model`.
     *
     * Never rejects for ordinary reasons: if the worker is unavailable the count
     * falls back to a character estimate, because a status bar that shows an
     * approximate number is better than one that shows an error.
     */
    public async count(text: string, model: ModelInfo): Promise<TokenCount> {
        if (text.length === 0) {
            return { count: 0, exact: true };
        }

        // The same cap the scan applies before reading a file, enforced here so
        // the open-editor paths get it too. Those read an already-in-memory
        // document, so nothing had stopped a 30 MB file reaching the tokenizer:
        // measured at 8.5 seconds and a 3.3 GB spike on the Hugging Face
        // backend, which costs ~90 bytes of heap per input byte — and repeated
        // on every debounced keystroke. Above the cap the count degrades to the
        // same estimate used when the worker is unavailable, which the UI
        // already presents as "≈".
        if (text.length > MAX_TOKENIZED_FILE_BYTES) {
            return { count: estimate(text, model), exact: false };
        }

        // A restarted worker has forgotten its downloaded tokenizers. Without
        // this, every subsequent count for that model quietly degrades to an
        // estimate — correctly labelled, but permanently, until the user
        // happens to re-run the download command.
        await this.rehydrateIfNeeded(model);

        try {
            const response = await this.send({
                type: 'count',
                id: 0, // replaced by send()
                text,
                spec: model.encoder,
            });

            if (response.type === 'count') {
                return { count: response.count, exact: response.exact };
            }
            if (response.type === 'error') {
                this.log.error(`Tokenizing failed for ${model.id}: ${response.message}`);
            }
        } catch (error) {
            this.log.error(`Tokenizer worker unavailable: ${describe(error)}`);
        }

        return { count: estimate(text, model), exact: false };
    }

    /**
     * Re-send an already-downloaded tokenizer that the worker no longer holds.
     *
     * Only touches the cache on disk — it never starts a download, so a model
     * the user has not opted into stays an estimate.
     */
    private async rehydrateIfNeeded(model: ModelInfo): Promise<void> {
        if (!isDownloadable(model.encoder)) {
            return;
        }

        const { repo, kind } = model.encoder;
        if (this.loadedRepos.has(repo) || this.unavailable.has(repo)) {
            return;
        }

        if (!(await this.store.isDownloaded(repo, kind))) {
            this.unavailable.add(repo);
            return;
        }

        if (!(await this.ensureExact(model))) {
            this.unavailable.add(repo);
        }
    }

    /**
     * True when `model` can be counted exactly right now — either it uses a
     * bundled tiktoken encoding, or its tokenizer has already been downloaded.
     */
    public async isExact(model: ModelInfo): Promise<boolean> {
        switch (model.encoder.kind) {
            case 'tiktoken':
                return true;
            case 'heuristic':
                return false;
            case 'tiktokenModel':
                // An older host cannot compile the pre-tokenizer, so promising
                // an exact count here would be a promise the worker breaks.
                return supportsRankTables() && this.isVocabularyPresent(model.encoder);
            case 'hf':
                return this.isVocabularyPresent(model.encoder);
        }
    }

    /**
     * Forget every loaded vocabulary, in the worker as well as here.
     *
     * Clearing the store alone left the worker holding its parsed tokenizers —
     * a rank table is ~150 MB of heap — and left `loadedRepos` populated, so
     * the download command afterwards reported "already downloaded" and did
     * nothing, while counts quietly reverted to estimates on the next reload.
     */
    public async forgetLoaded(): Promise<void> {
        const repos = [...this.loadedRepos];
        this.loadedRepos.clear();
        this.unavailable.clear();

        for (const repo of repos) {
            try {
                await this.send({ type: 'evict', id: 0, repo });
            } catch (error) {
                // A dead worker has already forgotten everything.
                this.log.debug(`Could not evict ${repo}: ${describe(error)}`);
            }
        }
    }

    /** True when a downloadable vocabulary is already loaded or on disk. */
    private async isVocabularyPresent(spec: DownloadableSpec): Promise<boolean> {
        return this.loadedRepos.has(spec.repo) || this.store.isDownloaded(spec.repo, spec.kind);
    }

    /**
     * Make `model` exact, downloading its tokenizer if needed.
     *
     * @returns whether the model can now be counted exactly.
     */
    public async ensureExact(
        model: ModelInfo,
        token?: vscode.CancellationToken,
    ): Promise<boolean> {
        if (!isDownloadable(model.encoder)) {
            return model.encoder.kind === 'tiktoken';
        }
        if (model.encoder.kind === 'tiktokenModel' && !supportsRankTables()) {
            this.log.warn(
                `${model.id} needs a newer VS Code to be counted exactly; using an estimate`,
            );
            return false;
        }

        const { repo, kind } = model.encoder;
        if (this.loadedRepos.has(repo)) {
            return true;
        }

        // An explicit request retries even a repo that failed before.
        this.unavailable.delete(repo);

        const existing = this.loading.get(repo);
        if (existing) {
            return existing;
        }

        const load = this.loadTokenizer(repo, kind, token).finally(() => this.loading.delete(repo));
        this.loading.set(repo, load);
        return load;
    }

    private async loadTokenizer(
        repo: string,
        kind: AssetKind,
        token?: vscode.CancellationToken,
    ): Promise<boolean> {
        try {
            const asset = await this.store.fetch(repo, kind, token);
            const response = await this.send({ type: 'loadTokenizer', id: 0, repo, asset });

            if (response.type === 'error') {
                this.log.error(`Could not load the tokenizer for ${repo}: ${response.message}`);
                return false;
            }

            this.loadedRepos.add(repo);
            this.log.info(`Exact tokenizer ready: ${repo}`);
            this.onDidChangeEmitter.fire();
            return true;
        } catch (error) {
            this.log.warn(`Falling back to an estimate for ${repo}: ${describe(error)}`);
            return false;
        }
    }

    // ── worker plumbing ──────────────────────────────────────────────────────

    /**
     * The worker is started on first use and restarted if it dies, so a crash
     * degrades one count instead of disabling the extension until reload.
     */
    private ensureWorker(): Worker {
        if (this.worker) {
            return this.worker;
        }
        if (this.disposed) {
            throw new TokenizerWorkerError('The tokenizer has been disposed');
        }

        const worker = new Worker(this.workerPath);
        worker.on('message', (response: WorkerResponse) => {
            const pending = this.pending.get(response.id);
            if (pending) {
                this.pending.delete(response.id);
                pending.resolve(response);
            }
        });
        worker.on('error', (error: unknown) => {
            this.log.error(`Tokenizer worker crashed: ${describe(error)}`);
            this.handleWorkerExit(toError(error));
        });
        worker.on('exit', code => {
            if (code !== 0 && !this.disposed) {
                this.handleWorkerExit(new TokenizerWorkerError(`worker exited with code ${code}`));
            }
        });

        this.worker = worker;
        return worker;
    }

    /**
     * A dead worker forgets its loaded tokenizers, so they are re-sent lazily on
     * the next request rather than silently reverting to estimates.
     */
    private handleWorkerExit(error: Error): void {
        this.worker = undefined;
        this.loadedRepos.clear();
        // Still on disk — let the next count re-send them.
        this.unavailable.clear();
        this.failAllPending(error);
    }

    private failAllPending(error: Error): void {
        for (const pending of this.pending.values()) {
            pending.reject(error);
        }
        this.pending.clear();
    }

    private send(request: WorkerRequest): Promise<WorkerResponse> {
        const worker = this.ensureWorker();
        const id = ++this.nextId;

        return new Promise<WorkerResponse>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new TokenizerWorkerError('The tokenizer did not respond in time'));
            }, REQUEST_TIMEOUT_MS);

            this.pending.set(id, {
                resolve: response => {
                    clearTimeout(timer);
                    resolve(response);
                },
                reject: error => {
                    clearTimeout(timer);
                    reject(error);
                },
            });

            worker.postMessage({ ...request, id });
        });
    }
}

/** Last-resort count used when the worker cannot answer. */
function estimate(text: string, model: ModelInfo): number {
    const charsPerToken = fallbackRatio(model.encoder);
    return Math.ceil(text.length / charsPerToken);
}

function fallbackRatio(spec: EncoderSpec): number {
    switch (spec.kind) {
        case 'heuristic': return spec.charsPerToken;
        case 'hf':
        case 'tiktokenModel': return spec.fallback.charsPerToken;
        case 'tiktoken': return 3.8;
    }
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}
