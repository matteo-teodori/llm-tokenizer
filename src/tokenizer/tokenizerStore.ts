/**
 * On-disk store for Hugging Face `tokenizer.json` files.
 *
 * These files are large (2–19 MB each) and there are too many models to ship
 * them all, so they are fetched on first use and kept in the extension's global
 * storage. A download is never required: callers fall back to the model's
 * heuristic while one is missing or in flight.
 *
 * Only ungated repos are referenced by the registry — Meta's and Google's own
 * repos return 401 without a Hugging Face token, so mirrors are used instead.
 */

import * as vscode from 'vscode';
import type { HfTokenizerFiles } from './encoders';

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
    private readonly inFlight = new Map<string, Promise<HfTokenizerFiles>>();
    private readonly memory = new Map<string, HfTokenizerFiles>();

    constructor(private readonly storageUri: vscode.Uri) {}

    /** Cached files for `repo`, or undefined if it has never been downloaded. */
    public async peek(repo: string): Promise<HfTokenizerFiles | undefined> {
        const cached = this.memory.get(repo);
        if (cached) {
            return cached;
        }

        try {
            const files = await this.readFromDisk(repo);
            this.memory.set(repo, files);
            return files;
        } catch {
            return undefined;
        }
    }

    /** True when `repo` is already on disk, so the UI can offer an exact count. */
    public async isDownloaded(repo: string): Promise<boolean> {
        return (await this.peek(repo)) !== undefined;
    }

    /**
     * Download `repo` if needed and return its files.
     *
     * @throws {TokenizerDownloadError} when the tokenizer cannot be obtained.
     */
    public async fetch(repo: string, token?: vscode.CancellationToken): Promise<HfTokenizerFiles> {
        const cached = await this.peek(repo);
        if (cached) {
            return cached;
        }

        const existing = this.inFlight.get(repo);
        if (existing) {
            return existing;
        }

        const download = this.download(repo, token)
            .then(files => {
                this.memory.set(repo, files);
                return files;
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

    private async readFromDisk(repo: string): Promise<HfTokenizerFiles> {
        const dir = this.repoDir(repo);
        const decoder = new TextDecoder();

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

        return { tokenizerJSON, tokenizerConfig };
    }

    private async download(
        repo: string,
        token?: vscode.CancellationToken,
    ): Promise<HfTokenizerFiles> {
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

        return { tokenizerJSON, tokenizerConfig };
    }

    private async fetchJson(
        repo: string,
        file: string,
        required: boolean,
        token?: vscode.CancellationToken,
    ): Promise<unknown> {
        const url = `${HF_ENDPOINT}/${repo}/resolve/main/${file}`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
        const cancel = token?.onCancellationRequested(() => controller.abort());

        try {
            const response = await fetch(url, {
                signal: controller.signal,
                headers: { accept: 'application/json' },
            });

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

            try {
                return JSON.parse(body);
            } catch {
                throw new TokenizerDownloadError(repo, `${file} is not valid JSON`);
            }
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
}
