/**
 * Extension-host side of tokenisation.
 *
 * Owns the decision of whether a given model can currently be counted exactly,
 * and which vocabularies the worker holds. The worker itself, and what happens
 * when it dies, is `WorkerHost`'s.
 */

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
import { WorkerHost } from '../workerHost';

/** A token count plus whether it can be trusted as exact. */
export interface TokenCount {
    count: number;
    exact: boolean;
}

export class TokenizerService implements vscode.Disposable {
    private readonly host: WorkerHost<WorkerRequest, WorkerResponse>;

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

    /**
     * Bumped whenever every loaded vocabulary is disowned.
     *
     * `TokenizerStore.clear()` already refuses to write a download that finished
     * after the user cleared the cache; this is the same guard one layer up. A
     * download still in flight when "Clear Downloaded Tokenizers" ran would
     * otherwise complete, be posted to the worker, recorded as loaded and
     * announced as an accuracy change — repopulating the very thing the user was
     * just told had been emptied. `forgetLoaded` could not prevent it, because
     * it iterates `loadedRepos`, which the in-flight load had not joined yet.
     */
    private loadGeneration = 0;

    private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
    /** Fires when a tokenizer finishes downloading, so counts can be refreshed. */
    public readonly onDidChangeAccuracy = this.onDidChangeEmitter.event;

    constructor(
        workerPath: string,
        private readonly store: TokenizerStore,
        private readonly log: vscode.LogOutputChannel,
        // Injectable so a test can let the crash window run out without
        // waiting a minute for it.
        now: () => number = () => performance.now(),
    ) {
        this.host = new WorkerHost(workerPath, {
            name: 'tokenizer',
            fallback: 'counting with estimates',
            log,
            now,
            // A dead worker forgets its loaded tokenizers, so they are re-sent
            // lazily on the next count rather than silently reverting to
            // estimates; the files are still on disk.
            onExit: () => {
                this.loadedRepos.clear();
                this.unavailable.clear();
            },
        });
    }

    public dispose(): void {
        void this.host.dispose();
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
        // `Buffer.byteLength`, not `text.length`: the cap is a byte budget (the
        // scan applies it to the stat's size) but this compared UTF-16 code
        // units, and UTF-8 CJK is three bytes per unit — so a 25 MB CJK file
        // measured 8 M here and sailed past the guard the constant exists to
        // enforce, which is the allocation profile that took the host down.
        if (Buffer.byteLength(text, 'utf8') > MAX_TOKENIZED_FILE_BYTES) {
            return { count: estimate(text, model), exact: false };
        }

        // A worker that keeps dying has nothing to answer with. Going straight
        // to the estimate also keeps the rest of this method from running:
        // every count would otherwise log the same failure, and re-hydration
        // would record a downloaded vocabulary as unusable when it is the
        // worker that is.
        if (this.host.backingOff) {
            return { count: estimate(text, model), exact: false };
        }

        // A restarted worker has forgotten its downloaded tokenizers. Without
        // this, every subsequent count for that model quietly degrades to an
        // estimate — correctly labelled, but permanently, until the user
        // happens to re-run the download command.
        await this.rehydrateIfNeeded(model);

        try {
            const response = await this.host.send({
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

        // `unavailable` means "this vocabulary cannot be used", which is a
        // statement about the file, not about the worker. A worker crash
        // mid-load rejects the pending request, and the host's onExit clears
        // the set so the restarted worker can be re-sent everything — but this
        // `add` ran *after* that clear and put the repo straight back,
        // permanently degrading the model to an estimate for the rest of the
        // session. Only record the failure if no worker died while it was
        // being loaded.
        //
        // Read before the first await, so nothing runs between count()'s
        // budget check and this. Read after the disk check instead, it missed
        // a crash landing during that check — the first read of a large
        // tokenizer.json takes a quarter of a second — and when that crash
        // tripped the budget, the load the budget refused was recorded here as
        // a vocabulary that cannot be used.
        const epoch = this.host.epoch;

        if (!(await this.store.isDownloaded(repo, kind))) {
            this.unavailable.add(repo);
            return;
        }

        if (!(await this.ensureExact(model)) && this.host.epoch === epoch) {
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
     * measured, from 13 MB of heap for Kimi's rank table to 130 MB for Gemma
     * 3's tokenizer.json — and left `loadedRepos` populated, so the download
     * command afterwards reported "already downloaded" and did nothing, while
     * counts quietly reverted to estimates on the next reload.
     */
    public async forgetLoaded(): Promise<void> {
        const repos = [...this.loadedRepos];
        this.loadGeneration++;
        this.loadedRepos.clear();
        this.unavailable.clear();

        for (const repo of repos) {
            try {
                await this.host.send({ type: 'evict', id: 0, repo });
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
        const generation = this.loadGeneration;

        try {
            const asset = await this.store.fetch(repo, kind, token);
            // Fetched now, whatever a count recorded while it was downloading.
            // Left in place, that "not on disk" outlived a load the crash budget
            // refused, and the model stayed an estimate for the session.
            this.unavailable.delete(repo);
            const response = await this.host.send({ type: 'loadTokenizer', id: 0, repo, asset });

            if (response.type === 'error') {
                this.log.error(`Could not load the tokenizer for ${repo}: ${response.message}`);
                return false;
            }

            // Disowned while we were downloading: undo the load rather than
            // announce it, or the cache the user just cleared comes back.
            if (generation !== this.loadGeneration) {
                this.log.info(`Discarding ${repo}: the cache was cleared while it was loading`);
                try {
                    await this.host.send({ type: 'evict', id: 0, repo });
                } catch (error) {
                    this.log.debug(`Could not evict ${repo}: ${describe(error)}`);
                }
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
