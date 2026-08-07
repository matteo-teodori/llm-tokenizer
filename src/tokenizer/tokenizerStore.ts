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

        const download = this.download(repo, kind, token)
            .then(asset => {
                this.memory.set(repo, asset);
                return asset;
            })
            .finally(() => this.inFlight.delete(repo));

        this.inFlight.set(repo, download);
        return download;
    }

    /** Delete every cached tokenizer. Exposed as a command so users can reclaim disk. */
    public async clear(): Promise<void> {
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
        token?: vscode.CancellationToken,
    ): Promise<TokenizerAsset> {
        if (kind === 'tiktokenModel') {
            const rankFile = await this.fetchText(repo, RANK_FILE, token);
            const dir = this.repoDir(repo);
            await vscode.workspace.fs.createDirectory(dir);
            await vscode.workspace.fs.writeFile(
                vscode.Uri.joinPath(dir, RANK_FILE),
                new TextEncoder().encode(rankFile),
            );
            return { kind: 'tiktokenModel', rankFile };
        }

        const tokenizerJSON = await this.fetchJson(repo, 'tokenizer.json', true, token);
        const tokenizerConfig = (await this.fetchJson(repo, 'tokenizer_config.json', false, token)) ?? {};

        const dir = this.repoDir(repo);
        await vscode.workspace.fs.createDirectory(dir);
        const encoder = new TextEncoder();
        await vscode.workspace.fs.writeFile(
            vscode.Uri.joinPath(dir, 'tokenizer.json'),
            encoder.encode(JSON.stringify(tokenizerJSON)),
        );
        await vscode.workspace.fs.writeFile(
            vscode.Uri.joinPath(dir, 'tokenizer_config.json'),
            encoder.encode(JSON.stringify(tokenizerConfig)),
        );

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
