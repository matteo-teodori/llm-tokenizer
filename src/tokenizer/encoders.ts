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
 *   4. `heuristic`      characters ÷ ratio. For models whose tokenizer is not
 *                       published (Claude, Grok, GPT-6 and a few others), and
 *                       for any other until its vocabulary is downloaded.
 *                       Always reported as an estimate.
 *
 * The encoders themselves run inside the worker; the host imports this module
 * only for the spec types and the `isDownloadable` / `supportsRankTables`
 * predicates it needs to decide what to offer.
 */

import * as path from 'path';

/** How a model's tokens are counted, and how much you should trust the number. */
export type EncoderKind = 'tiktoken' | 'hf' | 'tiktokenModel' | 'heuristic';

/**
 * tiktoken encodings we ship. Must stay in sync with `ENCODINGS` in scripts/bundles.mjs.
 *
 * Only those a model in the registry uses, since each ships its own rank
 * tables: `cl100k_base` went with GPT-4 Turbo and GPT-3.5 Turbo, the last
 * models on it, and `p50k_base` and `r50k_base` are absent for the same
 * reason. gpt-oss counts with `o200k_base`: tiktoken's `o200k_harmony` is the
 * same tables with Harmony's special tokens added, and special tokens are
 * counted as text here (see ENCODE_LITERALLY), so it would ship them twice for
 * identical counts.
 */
export type TiktokenEncoding = 'o200k_base';

export interface TiktokenSpec {
    kind: 'tiktoken';
    encoding: TiktokenEncoding;
}

export interface HfSpec {
    kind: 'hf';
    /** Hugging Face repo holding a downloadable `tokenizer.json`. Must be ungated. */
    repo: string;
    /** The commit it is read at, and its file's hash: see `PinnedSource`. */
    revision: string;
    keptSha256: string;
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
    revision: string;
    keptSha256: string;
    fallback: HeuristicSpec;
}

/**
 * Where a downloaded vocabulary comes from: a repo at one commit, never at
 * whatever its main branch holds now, so a change upstream never changes a
 * count until the registry moves to it. `keptSha256` is the SHA-256 of the
 * file as the store keeps it, and is checked on every download and every
 * read: tokenizer.json as `JSON.stringify` writes it out again once parsed,
 * which is not the published file's own hash, and tiktoken.model as it is.
 * `scripts/pin-tokenizers.mjs` works out both for a registry refresh.
 */
export type PinnedSource = Pick<HfSpec, 'repo' | 'revision' | 'keptSha256'>;

export interface HeuristicSpec {
    kind: 'heuristic';
    /**
     * Characters per token, for English prose and code.
     *
     * Each constant records where its figure comes from at its definition in
     * `models.ts` — most are measured on a related published vocabulary, and
     * Grok's is openly uncalibrated because no current Grok tokenizer exists
     * to measure against. The bare figures passed to `hf()` there are
     * placeholders shown until a download completes, and its docstring says
     * so. This used to cite a `docs/calibration.md` that was never written,
     * which read as provenance the ratios did not have.
     *
     * Note the unit: `length` is UTF-16 code units, so the ratio is only
     * meaningful for Latin-script text. See `heuristicEncoder`.
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
 * `build.mjs`) and required by path at runtime, on the first count for a
 * model that uses it.
 *
 * This matters: the rank tables are constructed at module load, which costs
 * o200k_base about 65 ms and 16 MB of heap, measured, and a worker counting
 * only downloaded vocabularies or estimates never needs them.
 */
type GptTokenizerModule = {
    countTokens(text: string, options?: { disallowedSpecial?: ReadonlySet<string> }): number;
};

/**
 * Passed as `disallowedSpecial` so special-token literals are encoded as text.
 *
 * `gpt-tokenizer` disallows every special token by default and *throws* on
 * input containing one, rather than encoding it. A file holding the literal
 * `<|endoftext|>` — a prompt template, a tokenizer_config.json, a fine-tuning
 * dataset, this project's own tests — therefore failed to count, and the
 * failure was invisible: the worker reported an error, the service fell back to
 * `length / 3.8`, and because the scan folds `exact &&=` across every file, one
 * such file relabelled an entire exact workspace as an estimate.
 *
 * An empty set restores the behaviour the other two backends already have and
 * the one the comments argue for: special tokens belong to chat templating, not
 * to the contents of a file. Shared and frozen — it is read on every count.
 */
const ENCODE_LITERALLY: ReadonlySet<string> = new Set<string>();

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
        count: text => mod.countTokens(text, { disallowedSpecial: ENCODE_LITERALLY }),
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
 * Those ids include the special tokens the tokenizer's post-processor adds:
 * `encode` adds them unless it is passed `add_special_tokens: false`, and this
 * library honours the option. `hfEncoder` takes them off by subtracting what
 * the empty string encodes to instead, which comes to the same count: every
 * post-processor the library implements adds the same tokens whatever the
 * input. Measured with the 17 Hugging Face vocabularies the registry named at
 * 2.2.0, over this repository's own files, the two never differed.
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

/** `tokenizer.json` + `tokenizer_config.json`, as text. */
export interface HfTokenizerFiles {
    kind: 'hf';
    /** As the store keeps it: the text whose hash `keptSha256` is. */
    tokenizerJSON: string;
    /** `{}` where the repo publishes none, as some tokenizer-only mirrors do. */
    tokenizerConfig: string;
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
 *
 * Text in both shapes, parsed only in the worker. The store used to parse
 * tokenizer.json on the extension host, whose thread every extension in the
 * window shares, and then post the parsed object, which took about as long to
 * copy across as to parse: measured with Gemma 3's in VS Code 1.105's runtime,
 * loading it held that thread for 150 to 320 ms at a stretch, where reading
 * and posting the text holds it for 34 to 41. The worker builds its tokenizer
 * from its own copy either way.
 */
export type TokenizerAsset = HfTokenizerFiles | TiktokenModelFile;

const hfCache = new Map<string, Encoder>();

export function hfEncoder(repo: string, files: HfTokenizerFiles): Encoder {
    const cached = hfCache.get(repo);
    if (cached) {
        return cached;
    }

    const Ctor = loadTokenizerLibrary();
    const tokenizer = new Ctor(
        JSON.parse(files.tokenizerJSON) as unknown,
        parseConfig(files.tokenizerConfig),
    );

    /**
     * Tokens this tokenizer adds regardless of input.
     *
     * Some tokenizers carry a `TemplateProcessing` post-processor that prepends
     * a beginning-of-sequence token — Mistral's does, so every file came back
     * one token heavy, and it was labelled exact. Those tokens belong to chat
     * templating, not to the contents of a file, so the constant is measured
     * once here and subtracted. Measured: Mistral Large 3 and Llama 3.3 add
     * one token to the empty string (Llama's ByteLevel is followed by a
     * TemplateProcessing step); Qwen 3.6 and DeepSeek V4 use a plain ByteLevel
     * post-processor and add none.
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

/**
 * `tokenizer_config.json`, or an empty one where it does not parse: counting
 * does not need it, so a damaged one must not cost the load.
 */
function parseConfig(text: string): unknown {
    try {
        return JSON.parse(text) as unknown;
    } catch {
        return {};
    }
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

/**
 * Free the memory held by a downloaded vocabulary: from 13 MB of heap for
 * Kimi's rank table to about 130 MB for Gemma 3's tokenizer.json, measured.
 */
export function evictDownloadedEncoder(repo: string): void {
    hfCache.delete(repo);
    rankCache.delete(repo);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    (require('./kimi') as typeof import('./kimi')).evictKimiCore(repo);
}

// ─────────────────────────────────────────────────────────────────────────────
// Heuristic (no tokenizer published, or none downloaded yet)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Characters ÷ ratio: for models with no published tokenizer, and for any other
 * until its vocabulary is downloaded.
 *
 * Known limitation, recorded rather than silently carried: `length` counts
 * UTF-16 code units and the measured ratios come from English prose and code, so
 * the further the input is from that, the worse the estimate. A BMP CJK
 * character is one code unit but costs roughly one token, so Chinese and
 * Japanese are under-counted substantially; an emoji is two code units and is
 * counted as if it were two characters of English. Correcting this means
 * re-calibrating every ratio against real corpora per script, which is a
 * measurement exercise, not a code change — so the number stays as it is and
 * keeps its `≈`.
 */
export function heuristicEncoder(charsPerToken: number): Encoder {
    return {
        kind: 'heuristic',
        exact: false,
        count: text => Math.ceil(text.length / charsPerToken),
    };
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve a spec to the encoder it has without a download.
 *
 * A downloadable spec degrades to its own fallback rather than failing the
 * count: its exact encoder is built by the worker from the vocabulary the
 * host hands it, which owns the download and the on-disk cache, and kept
 * there.
 */
export function resolveEncoder(spec: EncoderSpec): Encoder {
    switch (spec.kind) {
        case 'tiktoken':
            return tiktokenEncoder(spec.encoding);
        case 'heuristic':
            return heuristicEncoder(spec.charsPerToken);
        case 'hf':
        case 'tiktokenModel':
            return heuristicEncoder(spec.fallback.charsPerToken);
    }
}
