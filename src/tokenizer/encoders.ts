/**
 * Encoder backends.
 *
 * Three tiers, in descending order of trustworthiness:
 *
 *   1. `tiktoken`   — OpenAI's own BPE, via `gpt-tokenizer`. Exact, bundled, fast.
 *   2. `hf`         — the model's real `tokenizer.json`, fetched once from Hugging
 *                     Face and cached on disk. Exact, but costs a download.
 *   3. `heuristic`  — characters ÷ ratio. Only for models whose tokenizer is not
 *                     public (Claude, Gemini, Grok). Always reported as an estimate.
 *
 * Everything here runs inside the tokenizer worker, never on the extension host.
 */

import * as path from 'path';

/** How a model's tokens are counted, and how much you should trust the number. */
export type EncoderKind = 'tiktoken' | 'hf' | 'heuristic';

/**
 * tiktoken encodings we ship. Must stay in sync with `ENCODINGS` in build.mjs.
 *
 * `p50k_base` and `r50k_base` are deliberately absent: no model in the registry
 * uses them and they cost ~400 KB gzipped in the VSIX.
 */
export type TiktokenEncoding = 'o200k_harmony' | 'o200k_base' | 'cl100k_base';

export interface TiktokenSpec {
    kind: 'tiktoken';
    encoding: TiktokenEncoding;
}

export interface HfSpec {
    kind: 'hf';
    /** Hugging Face repo holding a downloadable `tokenizer.json`. Must be ungated. */
    repo: string;
    /**
     * Fallback used until the tokenizer has been downloaded, or if the download
     * fails. Keeps the extension useful offline instead of showing nothing.
     */
    fallback: HeuristicSpec;
}

export interface HeuristicSpec {
    kind: 'heuristic';
    /**
     * Characters per token. Calibrated per family against real corpora rather
     * than copied from a marketing page — see `docs/calibration.md`.
     */
    charsPerToken: number;
}

export type EncoderSpec = TiktokenSpec | HfSpec | HeuristicSpec;

/** A loaded, ready-to-use encoder. */
export interface Encoder {
    readonly kind: EncoderKind;
    /** True when the count is exact rather than estimated. */
    readonly exact: boolean;
    count(text: string): number;
}

// ─────────────────────────────────────────────────────────────────────────────
// tiktoken (bundled, exact, ~28 MB/s)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Each encoding is built into its own file under `out/encodings/` (see
 * `build.mjs`) and required by path at runtime.
 *
 * This matters: the rank tables are constructed at module load, so importing
 * all five costs ~250 ms and ~200 MB of heap. Loading only the active model's
 * encoding costs ~70 ms and ~30 MB.
 */
type GptTokenizerModule = { countTokens(text: string): number };

const tiktokenCache = new Map<TiktokenEncoding, Encoder>();

function loadTiktokenModule(encoding: TiktokenEncoding): GptTokenizerModule {
    // Built with __dirname rather than a bare template literal: esbuild expands
    // `require(`./encodings/${x}.js`)` into a directory glob at build time and
    // then fails to resolve it. An absolute path is opaque to the bundler and
    // resolved normally at runtime.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(path.join(__dirname, 'encodings', `${encoding}.js`)) as GptTokenizerModule;
}

function tiktokenEncoder(encoding: TiktokenEncoding): Encoder {
    const cached = tiktokenCache.get(encoding);
    if (cached) {
        return cached;
    }

    const mod = loadTiktokenModule(encoding);
    const encoder: Encoder = {
        kind: 'tiktoken',
        exact: true,
        // `countTokens` counts without materialising the token array, which
        // matters when walking a whole workspace.
        count: text => mod.countTokens(text),
    };

    tiktokenCache.set(encoding, encoder);
    return encoder;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hugging Face tokenizer.json (downloaded once, exact, ~5 MB/s)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Only the tokenizer half of `@huggingface/transformers` is bundled; the ONNX
 * runtime it would otherwise drag in (215 MB of native binaries) is stubbed out
 * at build time. See `build.mjs`.
 */
type PreTrainedTokenizerCtor = new (
    tokenizerJSON: unknown,
    tokenizerConfig: unknown,
) => { encode(text: string, opts: { add_special_tokens: boolean }): unknown[] };

let PreTrainedTokenizer: PreTrainedTokenizerCtor | undefined;

function loadTransformers(): PreTrainedTokenizerCtor {
    if (!PreTrainedTokenizer) {
        // Deferred so a workspace using only OpenAI models never loads it.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mod = require('@huggingface/transformers') as {
            PreTrainedTokenizer: PreTrainedTokenizerCtor;
        };
        PreTrainedTokenizer = mod.PreTrainedTokenizer;
    }
    return PreTrainedTokenizer;
}

/** Raw `tokenizer.json` + `tokenizer_config.json`, as fetched from the Hub. */
export interface HfTokenizerFiles {
    tokenizerJSON: unknown;
    tokenizerConfig: unknown;
}

const hfCache = new Map<string, Encoder>();

export function hfEncoder(repo: string, files: HfTokenizerFiles): Encoder {
    const cached = hfCache.get(repo);
    if (cached) {
        return cached;
    }

    const Ctor = loadTransformers();
    const tokenizer = new Ctor(files.tokenizerJSON, files.tokenizerConfig);
    const encoder: Encoder = {
        kind: 'hf',
        exact: true,
        // Special tokens belong to chat templating, not to counting file
        // contents, so they are excluded.
        count: text => tokenizer.encode(text, { add_special_tokens: false }).length,
    };

    hfCache.set(repo, encoder);
    return encoder;
}

/** Free the memory held by a downloaded tokenizer (each costs ~120 MB of heap). */
export function evictHfEncoder(repo: string): void {
    hfCache.delete(repo);
}

// ─────────────────────────────────────────────────────────────────────────────
// Heuristic (no public tokenizer exists for this model)
// ─────────────────────────────────────────────────────────────────────────────

export function heuristicEncoder(charsPerToken: number): Encoder {
    return {
        kind: 'heuristic',
        exact: false,
        count: text => Math.ceil(text.length / charsPerToken),
    };
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve a spec to an encoder.
 *
 * `hf` specs need their files supplied by the caller, which owns the download
 * and the on-disk cache; when they are absent we degrade to the spec's own
 * fallback rather than failing the count.
 */
export function resolveEncoder(spec: EncoderSpec, hfFiles?: HfTokenizerFiles): Encoder {
    switch (spec.kind) {
        case 'tiktoken':
            return tiktokenEncoder(spec.encoding);
        case 'heuristic':
            return heuristicEncoder(spec.charsPerToken);
        case 'hf':
            return hfFiles
                ? hfEncoder(spec.repo, hfFiles)
                : heuristicEncoder(spec.fallback.charsPerToken);
    }
}
