/**
 * On-disk store for downloaded vocabularies.
 *
 * Two shapes are published in the wild: a Hugging Face `tokenizer.json` (plus
 * its config), and a bare tiktoken rank table — Moonshot ships the latter for
 * the whole Kimi family. Both are large (3–35 MB) and there are too many models
 * to bundle, so they are fetched on first use and kept in global storage.
 *
 * A download is never required: callers fall back to the model's heuristic
 * while one is missing or in flight.
 *
 * Only ungated repos are referenced by the registry — Meta's Llama repos and
 * Google's Gemma 3 ones return 401 without a Hugging Face token, so mirrors are
 * used for those.
 *
 * Each is fetched at the commit the registry names, and its file is kept only
 * when its hash is the registry's: on download, and again on every read, so a
 * file cached from another commit, or by an older version that read the main
 * branch, is never counted as exact. One that does not match is downloaded
 * again, where downloads are allowed.
 */

import { createHash } from 'crypto';
import * as vscode from 'vscode';
import type { DownloadableSpec, TokenizerAsset } from './encoders';

/** Which shape of vocabulary a repo publishes. */
export type AssetKind = TokenizerAsset['kind'];

/** The file each shape lives in, relative to the repo root. */
const RANK_FILE = 'tiktoken.model';

/**
 * What a repo id's slash becomes in its directory name. `clear()` relies on
 * it to tell the store's directories from anything else in global storage.
 */
const REPO_SEPARATOR = '--';

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

/** SHA-256 of what the store keeps, as `PinnedSource.keptSha256` names it. */
export function keptSha256(bytes: Uint8Array | string): string {
    return createHash('sha256').update(bytes).digest('hex');
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

    /**
     * The hash each repo's file on disk matched when it was last read, so that
     * asking again whether a vocabulary is downloaded reads nothing.
     *
     * Only that, never the vocabulary. This used to keep each one parsed, from
     * the first look at it for the rest of the session and across model
     * switches, though the worker holds its own copy from the moment it is
     * loaded: measured in VS Code 1.105's runtime, 44 MB of the extension
     * host's heap for Gemma 3's, and 85 MB once Llama 3.3's and Qwen 3.8's had
     * joined it. A load now reads the file again, which is what re-hydration
     * after a worker crash does too.
     */
    private readonly verified = new Map<string, string>();

    /**
     * Bumped by `clear()`, so a download or a read that was already in flight
     * when the user cleared the cache does not put its result back afterwards.
     */
    private generation = 0;

    constructor(private readonly storageUri: vscode.Uri) {}

    /**
     * The vocabulary on disk for `spec`, or undefined if it has never been
     * downloaded, or what is on disk is not the file the registry names.
     *
     * Never downloads, which is why re-hydration loads through this rather
     * than `fetch`: a vocabulary deleted since it was verified — by "Clear
     * Downloaded Tokenizers" in another window — stays an estimate instead of
     * being downloaded again with nobody asked.
     */
    public async peek(spec: DownloadableSpec): Promise<TokenizerAsset | undefined> {
        const generation = this.generation;
        try {
            const asset = await this.readFromDisk(spec);
            this.markVerified(spec, generation);
            return asset;
        } catch {
            // Forgotten, or the download command would answer "already
            // downloaded" for a file that is no longer there, and never fetch
            // it again.
            if (this.verified.get(spec.repo) === spec.keptSha256) {
                this.verified.delete(spec.repo);
            }
            return undefined;
        }
    }

    /** True when `spec`'s vocabulary is already on disk, so the UI can offer an exact count. */
    public async isDownloaded(spec: DownloadableSpec): Promise<boolean> {
        if (this.verified.get(spec.repo) === spec.keptSha256) {
            return true;
        }

        const generation = this.generation;
        try {
            // Hashed only: nothing read here is kept, so nothing is decoded.
            await this.readPinned(spec);
            this.markVerified(spec, generation);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Download `repo` if needed and return its asset.
     *
     * @throws {TokenizerDownloadError} when the vocabulary cannot be obtained.
     */
    public async fetch(spec: DownloadableSpec, token?: vscode.CancellationToken): Promise<TokenizerAsset> {
        const cached = await this.peek(spec);
        if (cached) {
            return cached;
        }

        const { repo } = spec;
        const existing = this.inFlight.get(repo);
        if (existing) {
            return existing;
        }

        const generation = this.generation;
        const download: Promise<TokenizerAsset> = this.download(spec, generation, token)
            .then(asset => {
                // Still the caller's asset either way — it just no longer
                // belongs in a cache the user has since emptied.
                this.markVerified(spec, generation);
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
     * Only the store's own directories go, recognised by the name `repoDir`
     * gives them: every repo id is `owner/name`, so every one contains `--`.
     * This used to delete `globalStorageUri` whole, which is the directory the
     * whole extension shares, so anything else kept there went with the
     * tokenizers. Matching on the name rather than on what a directory holds
     * means a stray file in one (a Finder `.DS_Store`) cannot stop it being
     * cleared. Anything else stored here must therefore never have `--` in
     * its name.
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
        this.verified.clear();

        let entries: [string, vscode.FileType][];
        try {
            entries = await vscode.workspace.fs.readDirectory(this.storageUri);
        } catch {
            return; // Nothing cached yet.
        }
        for (const [name, type] of entries) {
            if (type !== vscode.FileType.Directory || !name.includes(REPO_SEPARATOR)) {
                continue;
            }
            try {
                await vscode.workspace.fs.delete(vscode.Uri.joinPath(this.storageUri, name), {
                    recursive: true,
                    useTrash: false,
                });
            } catch {
                // Best effort, as the whole-directory delete was: one that is
                // locked must not keep the others.
            }
        }
    }

    // ── internals ────────────────────────────────────────────────────────────

    /** Repo ids contain a slash; flatten it so it maps to a single directory. */
    private repoDir(repo: string): vscode.Uri {
        return vscode.Uri.joinPath(this.storageUri, repo.replace(/[/\\]/g, REPO_SEPARATOR));
    }

    /** Record that `spec`'s file matched, unless the cache was cleared since. */
    private markVerified(spec: DownloadableSpec, generation: number): void {
        if (generation === this.generation) {
            this.verified.set(spec.repo, spec.keptSha256);
        }
    }

    /** The vocabulary file's bytes, only when it is the one the registry names. */
    private async readPinned(spec: DownloadableSpec): Promise<Uint8Array> {
        const name = spec.kind === 'tiktokenModel' ? RANK_FILE : 'tokenizer.json';
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.repoDir(spec.repo), name));
        if (keptSha256(bytes) !== spec.keptSha256) {
            throw new TokenizerDownloadError(spec.repo, `the cached ${name} is not the file this version names`);
        }
        return bytes;
    }

    /** Decoded, never parsed: the worker parses it, for the reason `TokenizerAsset` gives. */
    private async readFromDisk(spec: DownloadableSpec): Promise<TokenizerAsset> {
        const decoder = new TextDecoder();
        const text = decoder.decode(await this.readPinned(spec));

        if (spec.kind === 'tiktokenModel') {
            return { kind: 'tiktokenModel', rankFile: text };
        }

        // Optional: some tokenizer-only mirrors omit it, and counting does not
        // need it.
        let tokenizerConfig: string;
        try {
            const config = vscode.Uri.joinPath(this.repoDir(spec.repo), 'tokenizer_config.json');
            tokenizerConfig = decoder.decode(await vscode.workspace.fs.readFile(config));
        } catch {
            tokenizerConfig = '{}';
        }

        return { kind: 'hf', tokenizerJSON: text, tokenizerConfig };
    }

    private async download(
        spec: DownloadableSpec,
        generation: number,
        token?: vscode.CancellationToken,
    ): Promise<TokenizerAsset> {
        const { repo } = spec;
        // Skipped when the user cleared the cache while this was in flight:
        // the directory has already been deleted, and writing now would put a
        // file back behind the delete.
        const stale = (): boolean => generation !== this.generation;
        const check = (name: string, kept: string): void => {
            if (keptSha256(kept) !== spec.keptSha256) {
                throw new TokenizerDownloadError(repo, `${name} at ${spec.revision.slice(0, 12)} is not the file this version names`);
            }
        };

        if (spec.kind === 'tiktokenModel') {
            const rankFile = await this.fetchText(spec, RANK_FILE, token);
            check(RANK_FILE, rankFile);
            if (!stale()) {
                const dir = this.repoDir(repo);
                await vscode.workspace.fs.createDirectory(dir);
                await writeWhole(dir, RANK_FILE, rankFile);
            }
            return { kind: 'tiktokenModel', rankFile };
        }

        const tokenizerJSON = await this.fetchJson(spec, 'tokenizer.json', true, token);
        const tokenizerConfig = (await this.fetchJson(spec, 'tokenizer_config.json', false, token)) ?? {};
        // Kept as it is written out again, which is what the hash is of.
        const kept = JSON.stringify(tokenizerJSON);
        check('tokenizer.json', kept);
        const config = JSON.stringify(tokenizerConfig);

        if (!stale()) {
            const dir = this.repoDir(repo);
            await vscode.workspace.fs.createDirectory(dir);
            await writeWhole(dir, 'tokenizer.json', kept);
            await writeWhole(dir, 'tokenizer_config.json', config);
        }

        // The text a read of these files gives back, for the worker to parse:
        // the object parsed here goes no further.
        return { kind: 'hf', tokenizerJSON: kept, tokenizerConfig: config };
    }

    /** Fetch a file as text, for vocabularies that are not JSON. */
    private async fetchText(
        spec: DownloadableSpec,
        file: string,
        token?: vscode.CancellationToken,
    ): Promise<string> {
        const { repo } = spec;
        const body = await this.fetchBody(spec, file, true, token);
        if (body === undefined) {
            throw new TokenizerDownloadError(repo, `${file} was empty`);
        }
        assertLooksLikeRankTable(repo, file, body);
        return body;
    }

    /** Fetch a file's body, or undefined when it is optional and absent. */
    private async fetchBody(
        spec: DownloadableSpec,
        file: string,
        required: boolean,
        token?: vscode.CancellationToken,
    ): Promise<string | undefined> {
        const { repo } = spec;
        // At the commit the registry names, never at whatever main holds now.
        const url = `${HF_ENDPOINT}/${repo}/resolve/${spec.revision}/${file}`;
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
        spec: DownloadableSpec,
        file: string,
        required: boolean,
        token?: vscode.CancellationToken,
    ): Promise<unknown> {
        const { repo } = spec;
        const body = await this.fetchBody(spec, file, required, token);
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
