/**
 * Encoder backends.
 *
 * Four backends, in descending order of trustworthiness:
 *
 *   1. `tiktoken`       OpenAI's own BPE, via `gpt-tokenizer`. Exact, bundled, fast.
 *   2. `hf`             the model's real `tokenizer.json`, fetched once from
 *                       Hugging Face and cached. Exact, but costs a download.
 *   3. `tiktokenModel`  a tiktoken rank table where the provider publishes one
 *                       instead of a tokenizer.json — Moonshot's Kimi family.
 *                       Also exact, also downloaded.
 *   4. `heuristic`      characters ÷ ratio. Only where no tokenizer is public
 *                       (Claude, Grok). Always reported as an estimate.
 *
 * The encoders themselves run inside the worker; the host imports this module
 * only for the spec types and the `isDownloadable` / `supportsRankTables`
 * predicates it needs to decide what to offer.
 */

import * as path from 'path';

/** How a model's tokens are counted, and how much you should trust the number. */
export type EncoderKind = 'tiktoken' | 'hf' | 'tiktokenModel' | 'heuristic';

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

/**
 * A model whose vocabulary ships as a tiktoken rank table rather than a
 * `tokenizer.json` — Moonshot's Kimi family. Downloaded and cached the same
 * way, and exact once present.
 */
export interface TiktokenModelSpec {
    kind: 'tiktokenModel';
    /** Hugging Face repo holding a downloadable `tiktoken.model`. Must be ungated. */
    repo: string;
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

export type EncoderSpec = TiktokenSpec | HfSpec | TiktokenModelSpec | HeuristicSpec;

/** Specs whose vocabulary is fetched once and cached, rather than bundled. */
export type DownloadableSpec = HfSpec | TiktokenModelSpec;

export function isDownloadable(spec: EncoderSpec): spec is DownloadableSpec {
    return spec.kind === 'hf' || spec.kind === 'tiktokenModel';
}

/**
 * How much a model's counts can be trusted, as three states rather than two.
 *
 * Callers used to ask about a specific kind — `=== 'hf'` for "downloadable",
 * `=== 'heuristic'` for "not exact" — and both stopped being true as kinds were
 * added: the first shipped a download path Kimi could never reach, the second
 * labelled Kimi "exact" with nothing on disk. Deciding it here means a new kind
 * is a compile error rather than a wrong label.
 */
export type Accuracy = 'exact' | 'after-download' | 'estimated';

export function accuracyOf(spec: EncoderSpec): Accuracy {
    switch (spec.kind) {
        case 'tiktoken': return 'exact';
        case 'hf':
        case 'tiktokenModel': return 'after-download';
        case 'heuristic': return 'estimated';
    }
}

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
 * `@huggingface/tokenizers` — the tokenizer implementation on its own, with no
 * dependencies.
 *
 * The obvious alternative, `@huggingface/transformers`, contains the same
 * tokenizer code but depends on onnxruntime-node: 215 MB of native binaries
 * that a token counter never runs. Keeping it out of the bundle required an
 * esbuild plugin stubbing the inference stack, which worked but was
 * load-bearing — one upstream import-path change and the VSIX would silently
 * grow by two orders of magnitude. Verified equivalent: identical counts on
 * Llama 3, Qwen 3, DeepSeek, Mistral and Gemma, including CJK and emoji.
 */
/**
 * `encode` returns an encoding object, not an array — reading `.length` on it
 * yields `undefined`, which is exactly the kind of silently-wrong number this
 * release exists to remove. The count is `ids.length`.
 *
 * Special tokens are not added: this library ignores `add_special_tokens`, and
 * that is the behaviour we want. Special tokens belong to chat templating, not
 * to the contents of a file.
 */
interface HfEncoding {
    ids: number[];
    tokens: string[];
}

type TokenizerCtor = new (
    tokenizerJSON: unknown,
    tokenizerConfig: unknown,
) => { encode(text: string): HfEncoding };

let Tokenizer: TokenizerCtor | undefined;

function loadTokenizerLibrary(): TokenizerCtor {
    if (!Tokenizer) {
        // Deferred so a workspace using only OpenAI models never loads it.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mod = require('@huggingface/tokenizers') as { Tokenizer: TokenizerCtor };
        Tokenizer = mod.Tokenizer;
    }
    return Tokenizer;
}

/** Raw `tokenizer.json` + `tokenizer_config.json`, as fetched from the Hub. */
export interface HfTokenizerFiles {
    kind: 'hf';
    tokenizerJSON: unknown;
    tokenizerConfig: unknown;
}

/** A raw `tiktoken.model` rank table, as fetched from the Hub. */
export interface TiktokenModelFile {
    kind: 'tiktokenModel';
    rankFile: string;
}

/**
 * A downloaded vocabulary.
 *
 * One type so the store, the worker protocol and the service all have a single
 * path for "fetch this model's vocabulary and hand it to the worker", whatever
 * shape the provider happens to publish.
 */
export type TokenizerAsset = HfTokenizerFiles | TiktokenModelFile;

const hfCache = new Map<string, Encoder>();

export function hfEncoder(repo: string, files: HfTokenizerFiles): Encoder {
    const cached = hfCache.get(repo);
    if (cached) {
        return cached;
    }

    const Ctor = loadTokenizerLibrary();
    const tokenizer = new Ctor(files.tokenizerJSON, files.tokenizerConfig);

    /**
     * Tokens this tokenizer adds regardless of input.
     *
     * Some tokenizers carry a `TemplateProcessing` post-processor that prepends
     * a beginning-of-sequence token — Mistral's does, so every file came back
     * one token heavy, and it was labelled exact. Those tokens belong to chat
     * templating, not to the contents of a file, so the constant is measured
     * once here and subtracted. Llama, Qwen and DeepSeek use a plain ByteLevel
     * post-processor and measure zero, so they are unaffected.
     */
    const specialTokenBaseline = tokenizer.encode('').ids.length;

    const encoder: Encoder = {
        kind: 'hf',
        exact: true,
        count: text => Math.max(0, tokenizer.encode(text).ids.length - specialTokenBaseline),
    };

    hfCache.set(repo, encoder);
    return encoder;
}

// ─────────────────────────────────────────────────────────────────────────────
// tiktoken rank tables (downloaded once, exact)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Whether this runtime can compile the Kimi pre-tokenizer.
 *
 * The pattern needs the `v` flag for set difference, which arrived in V8 11.6.
 * Every VS Code the extension supports should have it, but `engines` allows
 * 1.105 and the suite runs against much newer builds, so this is checked rather
 * than assumed: on an older host Kimi quietly stays an estimate instead of
 * every count failing.
 */
let setNotation: boolean | undefined;

export function supportsRankTables(): boolean {
    if (setNotation === undefined) {
        try {
            new RegExp(String.raw`[[\p{L}]--[\p{Script=Han}]]`, 'v');
            setNotation = true;
        } catch {
            setNotation = false;
        }
    }
    return setNotation;
}

const rankCache = new Map<string, Encoder>();

export function tiktokenModelEncoder(repo: string, file: TiktokenModelFile): Encoder {
    const cached = rankCache.get(repo);
    if (cached) {
        return cached;
    }

    // Deferred like the others: a workspace that never selects a Kimi model
    // never parses a 2.7 MB rank table.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { kimiCore, countWithCore } = require('./kimi') as typeof import('./kimi');
    const core = kimiCore(repo, file.rankFile);

    const encoder: Encoder = {
        kind: 'tiktokenModel',
        exact: true,
        count: text => countWithCore(core, text),
    };

    rankCache.set(repo, encoder);
    return encoder;
}

/** Free the memory held by a downloaded tokenizer (each costs ~120 MB of heap). */
export function evictDownloadedEncoder(repo: string): void {
    hfCache.delete(repo);
    rankCache.delete(repo);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    (require('./kimi') as typeof import('./kimi')).evictKimiCore(repo);
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
export function resolveEncoder(spec: EncoderSpec, asset?: TokenizerAsset): Encoder {
    switch (spec.kind) {
        case 'tiktoken':
            return tiktokenEncoder(spec.encoding);
        case 'heuristic':
            return heuristicEncoder(spec.charsPerToken);
        case 'hf':
            return asset?.kind === 'hf'
                ? hfEncoder(spec.repo, asset)
                : heuristicEncoder(spec.fallback.charsPerToken);
        case 'tiktokenModel':
            return asset?.kind === 'tiktokenModel' && supportsRankTables()
                ? tiktokenModelEncoder(spec.repo, asset)
                : heuristicEncoder(spec.fallback.charsPerToken);
    }
}
