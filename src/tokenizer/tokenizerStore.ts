/**
 * On-disk store for downloaded vocabularies.
 *
 * Two shapes are published in the wild: a Hugging Face `tokenizer.json` (plus
 * its config), and a bare tiktoken rank table — Moonshot ships the latter for
 * the whole Kimi family. Both are large (2–19 MB) and there are too many models
 * to bundle, so they are fetched on first use and kept in global storage.
 *
 * A download is never required: callers fall back to the model's heuristic
 * while one is missing or in flight.
 *
 * Only ungated repos are referenced by the registry — Meta's and Google's own
 * repos return 401 without a Hugging Face token, so mirrors are used instead.
 */

import * as vscode from 'vscode';
import type { TokenizerAsset } from './encoders';

/** Which shape of vocabulary a repo publishes. */
export type AssetKind = TokenizerAsset['kind'];

/** The file each shape lives in, relative to the repo root. */
const RANK_FILE = 'tiktoken.model';

const HF_ENDPOINT = 'https://huggingface.co';

/** Refuse absurd payloads rather than filling the user's disk on a bad redirect. */
const MAX_TOKENIZER_BYTES = 64 * 1024 * 1024;

const DOWNLOAD_TIMEOUT_MS = 120_000;

/**
 * Write a cache file so a reader can never see a partial one.
 *
 * The rank table is why this matters. It is parsed line by line and a truncated
 * one still yields a plausible table — just a shorter, wrong one — which is then
 * read back as an exact tokenizer on every count for as long as it sits on disk.
 * A `tokenizer.json` cut short at least fails to parse and is re-fetched, so it
 * degrades safely; the rank file does not. Writing beside the target and
 * renaming means the target either does not exist or is whole, whatever happens
 * mid-write.
 *
 * Exported for the test that proves the target never appears half-written.
 */
export async function writeWhole(dir: vscode.Uri, name: string, contents: string): Promise<void> {
    const target = vscode.Uri.joinPath(dir, name);
    // Unique per writer. `globalStorageUri` is shared by every window of the
    // same install, each with its own extension host and its own store, so a
    // fixed `${name}.part` meant two windows downloading the same repo wrote to
    // one path — and `writeFile` truncates, which is the premise this function
    // is built on. One window could therefore rename the other's half-written
    // file into place.
    const partial = vscode.Uri.joinPath(
        dir,
        `${name}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.part`,
    );

    await vscode.workspace.fs.writeFile(partial, new TextEncoder().encode(contents));
    try {
        await vscode.workspace.fs.rename(partial, target, { overwrite: true });
    } catch (error) {
        try {
            await vscode.workspace.fs.delete(partial, { useTrash: false });
        } catch {
            // Best effort. A leftover `.part` is never read — readFromDisk asks
            // for exact names — so it costs disk and nothing else.
        }
        throw error;
    }
}

export class TokenizerDownloadError extends Error {
    constructor(readonly repo: string, message: string) {
        super(`Could not download the tokenizer for ${repo}: ${message}`);
        this.name = 'TokenizerDownloadError';
    }
}

/**
 * Fetches and caches tokenizer files.
 *
 * Concurrent requests for the same repo share one download, so a workspace scan
 * that touches hundreds of files still only fetches once.
 */
export class TokenizerStore {
    private readonly inFlight = new Map<string, Promise<TokenizerAsset>>();
    private readonly memory = new Map<string, TokenizerAsset>();

    /**
     * Bumped by `clear()`, so a download that was already in flight when the
     * user cleared the cache does not put its result back afterwards.
     */
    private generation = 0;

    constructor(private readonly storageUri: vscode.Uri) {}

    /** The cached asset for `repo`, or undefined if it has never been downloaded. */
    public async peek(repo: string, kind: AssetKind): Promise<TokenizerAsset | undefined> {
        const cached = this.memory.get(repo);
        if (cached) {
            return cached;
        }

        try {
            const asset = await this.readFromDisk(repo, kind);
            this.memory.set(repo, asset);
            return asset;
        } catch {
            return undefined;
        }
    }

    /** True when `repo` is already on disk, so the UI can offer an exact count. */
    public async isDownloaded(repo: string, kind: AssetKind): Promise<boolean> {
        return (await this.peek(repo, kind)) !== undefined;
    }

    /**
     * Download `repo` if needed and return its asset.
     *
     * @throws {TokenizerDownloadError} when the vocabulary cannot be obtained.
     */
    public async fetch(
        repo: string,
        kind: AssetKind,
        token?: vscode.CancellationToken,
    ): Promise<TokenizerAsset> {
        const cached = await this.peek(repo, kind);
        if (cached) {
            return cached;
        }

        const existing = this.inFlight.get(repo);
        if (existing) {
            return existing;
        }

        const generation = this.generation;
        const download: Promise<TokenizerAsset> = this.download(repo, kind, generation, token)
            .then(asset => {
                // Still the caller's asset either way — it just no longer
                // belongs in a cache the user has since emptied.
                if (generation === this.generation) {
                    this.memory.set(repo, asset);
                }
                return asset;
            })
            .finally(() => {
                // Only if it is still ours: `clear()` empties the map, and a
                // later download for the same repo must not be evicted by this
                // one finishing.
                if (this.inFlight.get(repo) === download) {
                    this.inFlight.delete(repo);
                }
            });

        this.inFlight.set(repo, download);
        return download;
    }

    /**
     * Delete every cached tokenizer. Exposed as a command so users can reclaim
     * disk.
     *
     * Downloads already in flight are disowned rather than awaited: one can
     * have up to two minutes left to run, and the command is awaited before the
     * user is told the cache is empty. Disowning them is what stops a finished
     * download repopulating the cache behind the message — which used to leave
     * counts exact, and the download command answering "already downloaded",
     * straight after a successful clear.
     */
    public async clear(): Promise<void> {
        this.generation++;
        this.inFlight.clear();
        this.memory.clear();
        try {
            await vscode.workspace.fs.delete(this.storageUri, { recursive: true, useTrash: false });
        } catch {
            // Nothing cached yet.
        }
    }

    /** Total bytes currently cached, for display in the settings UI. */
    public async cacheSize(): Promise<number> {
        let total = 0;
        try {
            for (const [name, type] of await vscode.workspace.fs.readDirectory(this.storageUri)) {
                if (type !== vscode.FileType.Directory) {
                    continue;
                }
                const dir = vscode.Uri.joinPath(this.storageUri, name);
                for (const [file, fileType] of await vscode.workspace.fs.readDirectory(dir)) {
                    if (fileType === vscode.FileType.File) {
                        total += (await vscode.workspace.fs.stat(vscode.Uri.joinPath(dir, file))).size;
                    }
                }
            }
        } catch {
            // Nothing cached yet.
        }
        return total;
    }

    // ── internals ────────────────────────────────────────────────────────────

    /** Repo ids contain a slash; flatten it so it maps to a single directory. */
    private repoDir(repo: string): vscode.Uri {
        return vscode.Uri.joinPath(this.storageUri, repo.replace(/[/\\]/g, '--'));
    }

    private async readFromDisk(repo: string, kind: AssetKind): Promise<TokenizerAsset> {
        const dir = this.repoDir(repo);
        const decoder = new TextDecoder();

        if (kind === 'tiktokenModel') {
            const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir, RANK_FILE));
            return { kind: 'tiktokenModel', rankFile: decoder.decode(bytes) };
        }

        const read = async (name: string): Promise<unknown> =>
            JSON.parse(
                decoder.decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir, name))),
            ) as unknown;

        const tokenizerJSON = await read('tokenizer.json');

        // Optional: some tokenizer-only mirrors omit it, and counting does not
        // need it.
        let tokenizerConfig: unknown;
        try {
            tokenizerConfig = await read('tokenizer_config.json');
        } catch {
            tokenizerConfig = {};
        }

        return { kind: 'hf', tokenizerJSON, tokenizerConfig };
    }

    private async download(
        repo: string,
        kind: AssetKind,
        generation: number,
        token?: vscode.CancellationToken,
    ): Promise<TokenizerAsset> {
        // Skipped when the user cleared the cache while this was in flight:
        // the directory has already been deleted, and writing now would put a
        // file back behind the delete.
        const stale = (): boolean => generation !== this.generation;

        if (kind === 'tiktokenModel') {
            const rankFile = await this.fetchText(repo, RANK_FILE, token);
            if (!stale()) {
                const dir = this.repoDir(repo);
                await vscode.workspace.fs.createDirectory(dir);
                await writeWhole(dir, RANK_FILE, rankFile);
            }
            return { kind: 'tiktokenModel', rankFile };
        }

        const tokenizerJSON = await this.fetchJson(repo, 'tokenizer.json', true, token);
        const tokenizerConfig = (await this.fetchJson(repo, 'tokenizer_config.json', false, token)) ?? {};

        if (!stale()) {
            const dir = this.repoDir(repo);
            await vscode.workspace.fs.createDirectory(dir);
            await writeWhole(dir, 'tokenizer.json', JSON.stringify(tokenizerJSON));
            await writeWhole(dir, 'tokenizer_config.json', JSON.stringify(tokenizerConfig));
        }

        return { kind: 'hf', tokenizerJSON, tokenizerConfig };
    }

    /** Fetch a file as text, for vocabularies that are not JSON. */
    private async fetchText(
        repo: string,
        file: string,
        token?: vscode.CancellationToken,
    ): Promise<string> {
        const body = await this.fetchBody(repo, file, true, token);
        if (body === undefined) {
            throw new TokenizerDownloadError(repo, `${file} was empty`);
        }
        assertLooksLikeRankTable(repo, file, body);
        return body;
    }

    /** Fetch a file's body, or undefined when it is optional and absent. */
    private async fetchBody(
        repo: string,
        file: string,
        required: boolean,
        token?: vscode.CancellationToken,
    ): Promise<string | undefined> {
        const url = `${HF_ENDPOINT}/${repo}/resolve/main/${file}`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
        const cancel = token?.onCancellationRequested(() => controller.abort());

        try {
            const response = await fetch(url, { signal: controller.signal });

            if (!response.ok) {
                if (!required) {
                    return undefined;
                }
                const hint =
                    response.status === 401 || response.status === 403
                        ? ' (the repository is gated and needs a Hugging Face account)'
                        : '';
                throw new TokenizerDownloadError(repo, `HTTP ${response.status}${hint}`);
            }

            const declared = Number(response.headers.get('content-length') ?? '0');
            if (declared > MAX_TOKENIZER_BYTES) {
                throw new TokenizerDownloadError(repo, `file is implausibly large (${declared} bytes)`);
            }

            const body = await response.text();
            if (body.length > MAX_TOKENIZER_BYTES) {
                throw new TokenizerDownloadError(repo, 'file is implausibly large');
            }

            // A short read is the one corruption nothing downstream can see. The
            // rank-table parser rejects gaps, because published vocabularies are
            // dense — but a body truncated at the *end* leaves ranks 0..n intact
            // and dense, so it parses, is cached, and then counts every file a
            // little low while still labelled exact. Comparing bytes against the
            // declared length catches it at the only point where the truth is
            // still available. (Skipped when the length is absent, as it is under
            // chunked transfer encoding.)
            const received = Buffer.byteLength(body, 'utf8');
            if (declared > 0 && received !== declared) {
                throw new TokenizerDownloadError(
                    repo,
                    `${file} was truncated (${received} of ${declared} bytes)`,
                );
            }
            return body;
        } catch (error) {
            if (error instanceof TokenizerDownloadError) {
                throw error;
            }
            if (!required) {
                return undefined;
            }
            const reason = controller.signal.aborted
                ? 'the download was cancelled or timed out'
                : error instanceof Error
                    ? error.message
                    : String(error);
            throw new TokenizerDownloadError(repo, reason);
        } finally {
            clearTimeout(timer);
            cancel?.dispose();
        }
    }

    private async fetchJson(
        repo: string,
        file: string,
        required: boolean,
        token?: vscode.CancellationToken,
    ): Promise<unknown> {
        const body = await this.fetchBody(repo, file, required, token);
        if (body === undefined) {
            return undefined;
        }
        try {
            return JSON.parse(body) as unknown;
        } catch {
            if (!required) {
                return undefined;
            }
            throw new TokenizerDownloadError(repo, `${file} is not valid JSON`);
        }
    }
}

/**
 * Reject a body that is not a tiktoken rank table.
 *
 * The JSON path is validated by `JSON.parse`; this path had nothing. A gateway,
 * captive portal or Hub incident that answers 200 with an HTML page would be
 * written to disk as the vocabulary, and every later load would fail against a
 * file the store believed was good — permanently, since a cached file is never
 * re-fetched. One line of shape-checking is enough: the format is
 * `<base64> <rank>` per line.
 */
function assertLooksLikeRankTable(repo: string, file: string, body: string): void {
    const firstLine = body.split('\n', 1)[0]?.trim() ?? '';
    if (!/^[A-Za-z0-9+/]+={0,2} \d+$/.test(firstLine)) {
        throw new TokenizerDownloadError(
            repo,
            `${file} is not a tiktoken rank table (got "${firstLine.slice(0, 40)}")`,
        );
    }
}
