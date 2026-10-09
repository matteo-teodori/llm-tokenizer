/**
 * The model registry (October 2026).
 *
 * Every id here was checked against a live first-party source. v1.3.0 shipped
 * several models that never existed — `grok-4.2`, `grok-4.1-fast`,
 * `grok-4-fast` are absent from xAI's catalogue, and the whole Anthropic block
 * used a `claude-4.7-opus` id format that Anthropic does not use — so ids are
 * no longer written from memory.
 *
 * `contextLimit` is the **usable input** limit, not the advertised window. A
 * token counter exists to answer "does this fit", and GPT-5.6 advertises
 * 1,050,000 while capping input at 922,000; warning at 80% of the larger
 * number would be worse than not warning at all.
 *
 * Anything removed needs an entry in MODEL_ALIASES so existing users are
 * migrated rather than silently reset.
 */

import type { ModelInfo } from './registry';

// ─────────────────────────────────────────────────────────────────────────────
// Heuristic ratios
//
// Used only where no public tokenizer exists. Each is a chars-per-token figure
// for English prose and code, not a marketing number.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Claude 4.7 and later, Haiku 5.5 included. Anthropic changed tokenizer with
 * Opus 4.7, and its rule goes by generation: "Claude 4.7 and later models … use
 * a newer tokenizer", while "Claude Sonnet 4.6 and earlier models use the
 * previous tokenizer". The same text comes to about 30% more tokens on the
 * newer one, up to 35% depending on content, which is why this and
 * CLAUDE_LEGACY differ so much. 2.5 is Anthropic's own figure: 1M tokens is
 * "roughly 555k words or 2.5M Unicode characters on the current tokenizer".
 */
const CLAUDE_CURRENT = 2.5;

/**
 * Claude up to and including the 4.6 generation. Anthropic's own figures put
 * it between 3.25 (the newer tokenizer's 2.5 with its typical 30% more tokens)
 * and 3.38 (1M tokens held "about 750k words" before 4.7, against 555k words,
 * or 2.5M characters, now), and 3.3 lies between. 3.4, the figure before
 * 2.1.2, implied a 36% gap: past the 35% Anthropic gives as the most.
 */
const CLAUDE_LEGACY = 3.3;

/**
 * Grok. Uncalibrated: xAI publishes no tokenizer for any current model
 * (`xai-org` on Hugging Face stops at grok-1/grok-2) and the only exact path
 * is their server-side /v1/tokenize-text endpoint.
 */
const GROK = 3.7;

/**
 * The GPT-6 models. Estimated, deliberately, even though every other OpenAI
 * model here is exact.
 *
 * OpenAI's own tokenizer library is the source of truth for which encoding a
 * model uses, and `MODEL_PREFIX_TO_ENCODING` in tiktoken has no `gpt-6` entry —
 * it stops at `gpt-5`, and tiktoken's own lookup raises KeyError for every
 * GPT-6 id — while none of the GPT-6 documentation pages names an encoding.
 * Claiming o200k_base here would be a guess dressed as an exact count, which is
 * the one thing this file exists to prevent.
 *
 * The ratio is measured rather than assumed: 4.119 chars/token for o200k_base
 * over a mixed corpus of this repository's own TypeScript, JSON, YAML and
 * Markdown. Move these entries to a `tiktoken` encoder the moment tiktoken
 * ships a gpt-6 mapping.
 */
const GPT6_UNMAPPED = 4.1;

// The next five stand in for models that publish no tokenizer but have a close
// relative that does. Each is that relative's ratio, measured with the bundled
// @huggingface/tokenizers on the same kind of corpus as GPT6_UNMAPPED — this
// repository's own TypeScript, JSON, YAML, .mjs and Markdown at e706b82, 51
// files and 433,335 UTF-16 units, on which o200k_base gives 4.132 — and
// rounded down, so the estimate errs high.

/**
 * Gemini releases that Google's SDK does not yet map to a Gemma vocabulary.
 * Every release it does map uses one, and Gemma 4's measures 3.652 (Gemma 3's
 * 3.655).
 */
const GEMINI_UNMAPPED = 3.6;

/**
 * Qwen's API models with no open counterpart (3.7 and 3.6-Plus): the open
 * Qwen3.6 vocabulary, which 3.8 keeps, measures 3.803. Also the estimate every
 * downloadable Qwen model shows until its vocabulary arrives.
 */
const QWEN_CLOSED = 3.8;

/** GLM-5-Turbo: the vocabulary every published GLM-5 model shares measures 4.128. */
const GLM_UNPUBLISHED = 4.1;

/**
 * MiniMax M3.1 Flash: M3's vocabulary measures 4.114, and M2's encodes the
 * corpus to identical ids, so the family has kept one vocabulary so far.
 */
const MINIMAX_UNPUBLISHED = 4.1;

/**
 * Mistral Large 4, until its weights ship: Tekken measures 3.855 with Large
 * 3's file and 3.856 with Medium 3.5's.
 */
const MISTRAL_UNPUBLISHED = 3.8;

/** Only used until Kimi's rank table has been downloaded. */
const KIMI = 3.6;

// ─────────────────────────────────────────────────────────────────────────────
// Hugging Face tokenizer sources
//
// Meta's Llama repos (meta-llama/) and Google's Gemma 3 repos are gated (HTTP
// 401 without an account), so ungated mirrors are used. Meta's meta-models org
// and Google's Gemma 4 repos are not gated, which is why HF.museGlimmer and
// HF.gemma4 point at them directly. Every repo below was checked to serve
// tokenizer.json anonymously.
// ─────────────────────────────────────────────────────────────────────────────

const HF = {
    llama3: 'unsloth/Llama-3.3-70B-Instruct',
    llama4: 'unsloth/Llama-4-Scout-17B-16E-Instruct',
    gemma3: 'unsloth/gemma-3-4b-it',
    gemma4: 'google/gemma-4-E4B-it',
    /**
     * DeepSeek V4 Pro's vocabulary. The path is the retired V4 Flash's repo,
     * kept so existing downloads stay valid: its tokenizer.json is
     * byte-identical (sha256 8f9f37ca…) to deepseek-ai/DeepSeek-V4-Pro-0813,
     * the snapshot the API serves for deepseek-v4-pro.
     */
    deepseek: 'deepseek-ai/DeepSeek-V4-Flash',
    /**
     * V4.1 Flash keeps V4's vocabulary and merges but repurposes nine of its
     * added-token slots: it gains `<｜System｜>` (one token here, five under V4)
     * and loses V4's image and table tokens. So its file differs (sha256
     * c90dfa01…) and it cannot share V4 Pro's repo.
     */
    deepseek41: 'deepseek-ai/DeepSeek-V4.1-Flash',
    qwen: 'Qwen/Qwen3.6-27B',
    /**
     * Qwen 3.8's files differ from 3.6's. The vocabulary and merges are the
     * same; 3.8 adds seven audio and TTS special tokens, which is enough for the
     * files to hash differently (0997f410… against 3.6's 5f9e4d49…), so the 3.6
     * entries keep their own repo. Within 3.8 one download covers the family:
     * Qwen3.8-27B, Qwen3.8-Flash-Next and Qwen3.8-2.4T-A95B serve the same
     * tokenizer.json.
     */
    qwen38: 'Qwen/Qwen3.8-27B',
    mistral: 'mistralai/Mistral-Large-3-675B-Instruct-2512',
    /**
     * Medium 3.5 and Small 4 share one tokenizer.json (sha256 2ba5b333…) that
     * is not Large 3's (57757562…). See the Mistral section for why that
     * matters.
     */
    mistralMedium35: 'mistralai/Mistral-Medium-3.5-128B',
    /**
     * One repo for the whole GLM-5 line. Verified by hash: GLM-5, 5.1, 5.2, 5.3
     * and 5.3-Flash serve a byte-identical tokenizer.json (sha256 19e77364…),
     * and their tokenizer_config.json files differ only in model_max_length,
     * so a single download covers them all.
     */
    glm: 'zai-org/GLM-5.2',
    minimax: 'MiniMaxAI/MiniMax-M3',
    minimaxLegacy: 'MiniMaxAI/MiniMax-M2',
    /**
     * MiMo V2.5 and V2.5 Pro have the same vocabulary and merges, but their
     * tokenizer.json files differ (633518aa… and cdd40b08…: Pro lacks six
     * audio and video tokens, and V2.5 uses an older serialisation), and only
     * byte-identical files may share a repo, so each keeps its own.
     */
    mimo: 'XiaomiMiMo/MiMo-V2.5',
    mimoPro: 'XiaomiMiMo/MiMo-V2.5-Pro',
    /**
     * V2.6 is published as -RL and -MOPD checkpoints of Pro and Flash, and all
     * four serve a byte-identical tokenizer.json (sha256 ff15eb92…), so one
     * download covers both V2.6 models.
     */
    mimo26: 'XiaomiMiMo/MiMo-V2.6-Pro-RL',
    hunyuan: 'tencent/Hy3',
    hunyuan4: 'tencent/Hy4-preview',
    /**
     * Meta's current open-weight model. The Llama fallback ratio is right for
     * it (measured 4.207 chars/token against Llama 3.3's 4.225 on identical
     * text).
     */
    museGlimmer: 'meta-models/Muse-Glimmer-30B',
    /**
     * Moonshot publishes `tiktoken.model` rather than a `tokenizer.json`.
     *
     * One repo serves the whole family: the rank file is byte-identical across
     * K3, K2.7-Code, K2.6 and K2.5 (verified by hash), so pointing them all at
     * one repo means a single download covers every Kimi model.
     */
    kimi: 'moonshotai/Kimi-K3',
} as const;

/** A `tiktokenModel` encoder with the estimate used until it is downloaded. */
function rankTable(repo: string, charsPerToken: number): ModelInfo['encoder'] {
    return { kind: 'tiktokenModel', repo, fallback: { kind: 'heuristic', charsPerToken } };
}

/** An `hf` encoder with the fallback used until the download completes. */
function hf(repo: string, charsPerToken: number): ModelInfo['encoder'] {
    return { kind: 'hf', repo, fallback: { kind: 'heuristic', charsPerToken } };
}

/**
 * The model a user gets before they choose one.
 *
 * Deliberately not `MODELS[0]`: the registry is ordered newest-first, and the
 * newest OpenAI models are the GPT-6 family, which has no published tokenizer
 * yet. A token counter's default should be one it can count *exactly*, so this
 * is the newest exact model instead. It is also the value `scripts/sync-manifest.mjs`
 * writes into the settings dropdown, so the manifest and the code cannot drift.
 */
export const DEFAULT_MODEL_ID = 'gpt-5.6-sol';

export const MODELS: ModelInfo[] = [
    // ─────────────────────────────────────────────────────────────────────────
    // OpenAI — exact, offline. tiktoken is OpenAI's own tokenizer.
    // ─────────────────────────────────────────────────────────────────────────
    // The GPT-6 models are the OpenAI entries that are *not* exact — see
    // GPT6_UNMAPPED.
    { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', provider: 'OpenAI', contextLimit: 922_000, encoder: { kind: 'heuristic', charsPerToken: GPT6_UNMAPPED } },
    { id: 'gpt-6-sol', label: 'GPT-6 Sol', provider: 'OpenAI', contextLimit: 922_000, encoder: { kind: 'heuristic', charsPerToken: GPT6_UNMAPPED } },
    { id: 'gpt-6-luna', label: 'GPT-6 Luna', provider: 'OpenAI', contextLimit: 922_000, encoder: { kind: 'heuristic', charsPerToken: GPT6_UNMAPPED } },
    { id: 'gpt-6-astra', label: 'GPT-6 Astra', provider: 'OpenAI', contextLimit: 922_000, encoder: { kind: 'heuristic', charsPerToken: GPT6_UNMAPPED } },
    { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', provider: 'OpenAI', contextLimit: 922_000, encoder: { kind: 'tiktoken', encoding: 'o200k_base' } },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', provider: 'OpenAI', contextLimit: 922_000, encoder: { kind: 'tiktoken', encoding: 'o200k_base' } },
    { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', provider: 'OpenAI', contextLimit: 922_000, encoder: { kind: 'tiktoken', encoding: 'o200k_base' } },
    // GPT-5.5, 5.4, 5.2 and 5.1 publish only a window (1,050,000 or 400,000) and
    // a 128,000 max output — no separate input cap. Every OpenAI model that does
    // publish one sets it to exactly window minus max output (922,000 for
    // GPT-5.6 and GPT-6, 272,000 for GPT-5, GPT-5.3 Codex and GPT-5.4 mini), so
    // these four carry that derived figure rather than the larger window: a
    // "does it fit" warning should err early, not late.
    { id: 'gpt-5.5', label: 'GPT-5.5', provider: 'OpenAI', contextLimit: 922_000, encoder: { kind: 'tiktoken', encoding: 'o200k_base' } },
    { id: 'gpt-5.4', label: 'GPT-5.4', provider: 'OpenAI', contextLimit: 922_000, encoder: { kind: 'tiktoken', encoding: 'o200k_base' } },
    { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini', provider: 'OpenAI', contextLimit: 272_000, encoder: { kind: 'tiktoken', encoding: 'o200k_base' } },
    { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', provider: 'OpenAI', contextLimit: 272_000, encoder: { kind: 'tiktoken', encoding: 'o200k_base' } },
    { id: 'gpt-5.2', label: 'GPT-5.2', provider: 'OpenAI', contextLimit: 272_000, encoder: { kind: 'tiktoken', encoding: 'o200k_base' } },
    { id: 'gpt-5.1', label: 'GPT-5.1', provider: 'OpenAI', contextLimit: 272_000, encoder: { kind: 'tiktoken', encoding: 'o200k_base' } },
    // Scheduled shutdowns, still live today: o4-mini on 2026-10-23 (OpenAI's
    // replacement is gpt-5.6-terra), gpt-5 and o3 on 2026-12-11 (gpt-5.6-sol),
    // gpt-5.1 and gpt-5.3-codex on 2027-04-01 (gpt-6-sol). Remove each, with an
    // alias to its replacement, at the first refresh after its date. The two
    // legacy models at the end of this block go on 2026-10-23 as well.
    { id: 'gpt-5', label: 'GPT-5', provider: 'OpenAI', contextLimit: 272_000, encoder: { kind: 'tiktoken', encoding: 'o200k_base' } },
    { id: 'gpt-4.1', label: 'GPT-4.1', provider: 'OpenAI', contextLimit: 1_047_576, encoder: { kind: 'tiktoken', encoding: 'o200k_base' } },
    { id: 'gpt-4o', label: 'GPT-4o', provider: 'OpenAI', contextLimit: 128_000, encoder: { kind: 'tiktoken', encoding: 'o200k_base' } },
    { id: 'gpt-4o-mini', label: 'GPT-4o mini', provider: 'OpenAI', contextLimit: 128_000, encoder: { kind: 'tiktoken', encoding: 'o200k_base' } },
    { id: 'o3', label: 'o3', provider: 'OpenAI', contextLimit: 200_000, encoder: { kind: 'tiktoken', encoding: 'o200k_base' } },
    { id: 'o4-mini', label: 'o4-mini', provider: 'OpenAI', contextLimit: 200_000, encoder: { kind: 'tiktoken', encoding: 'o200k_base' } },
    // The open-weight models use the Harmony response format, which adds its own
    // special tokens on top of o200k.
    { id: 'gpt-oss-120b', label: 'gpt-oss-120b', provider: 'OpenAI', contextLimit: 131_072, encoder: { kind: 'tiktoken', encoding: 'o200k_harmony' } },
    { id: 'gpt-oss-20b', label: 'gpt-oss-20b', provider: 'OpenAI', contextLimit: 131_072, encoder: { kind: 'tiktoken', encoding: 'o200k_harmony' } },
    // OpenAI shuts both down on 2026-10-23 (replacements gpt-5.6-sol and
    // gpt-5.6-terra). They are kept for Azure OpenAI, which retires models on
    // its own schedule, but that is unconfirmed: Azure's retirement schedule
    // (updated 2026-09-21) and its retired-models page list neither as retired
    // or due to retire. Check again at the first refresh after the 23rd, and
    // if gpt-4-turbo goes, re-point the `gpt-4` alias with it.
    { id: 'gpt-4-turbo', label: 'GPT-4 Turbo (legacy)', provider: 'OpenAI', contextLimit: 128_000, encoder: { kind: 'tiktoken', encoding: 'cl100k_base' } },
    { id: 'gpt-3.5-turbo', label: 'GPT-3.5 Turbo (legacy)', provider: 'OpenAI', contextLimit: 16_385, encoder: { kind: 'tiktoken', encoding: 'cl100k_base' } },

    // ─────────────────────────────────────────────────────────────────────────
    // Anthropic — estimated. No Claude tokenizer has ever been published, and
    // Anthropic's own guidance, in the claude-api skill it publishes
    // (github.com/anthropics/skills, skills/claude-api/shared/token-counting.md),
    // is not to use tiktoken, which "undercounts Claude tokens by ~15-20% on
    // typical text, and by much more on code or non-English input". The only
    // exact route is their /v1/messages/count_tokens endpoint, which needs an
    // API key.
    // ─────────────────────────────────────────────────────────────────────────
    // Haiku 5.5 moved to the current tokenizer — Anthropic's model page says the
    // same text counts ~30% more than on Haiku 4.5 — so it shares CLAUDE_CURRENT
    // with the 4.7-and-later models rather than Haiku 4.5's ratio.
    { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', provider: 'Anthropic', contextLimit: 1_000_000, encoder: { kind: 'heuristic', charsPerToken: CLAUDE_CURRENT } },
    { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', provider: 'Anthropic', contextLimit: 1_000_000, encoder: { kind: 'heuristic', charsPerToken: CLAUDE_CURRENT } },
    { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', provider: 'Anthropic', contextLimit: 1_000_000, encoder: { kind: 'heuristic', charsPerToken: CLAUDE_CURRENT } },
    { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', provider: 'Anthropic', contextLimit: 1_000_000, encoder: { kind: 'heuristic', charsPerToken: CLAUDE_CURRENT } },
    { id: 'claude-opus-5', label: 'Claude Opus 5', provider: 'Anthropic', contextLimit: 1_000_000, encoder: { kind: 'heuristic', charsPerToken: CLAUDE_CURRENT } },
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', provider: 'Anthropic', contextLimit: 1_000_000, encoder: { kind: 'heuristic', charsPerToken: CLAUDE_CURRENT } },
    { id: 'claude-fable-5', label: 'Claude Fable 5', provider: 'Anthropic', contextLimit: 1_000_000, encoder: { kind: 'heuristic', charsPerToken: CLAUDE_CURRENT } },
    { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', provider: 'Anthropic', contextLimit: 1_000_000, encoder: { kind: 'heuristic', charsPerToken: CLAUDE_CURRENT } },
    { id: 'claude-opus-4-7', label: 'Claude Opus 4.7', provider: 'Anthropic', contextLimit: 1_000_000, encoder: { kind: 'heuristic', charsPerToken: CLAUDE_CURRENT } },
    { id: 'claude-opus-4-6', label: 'Claude Opus 4.6', provider: 'Anthropic', contextLimit: 1_000_000, encoder: { kind: 'heuristic', charsPerToken: CLAUDE_LEGACY } },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', provider: 'Anthropic', contextLimit: 1_000_000, encoder: { kind: 'heuristic', charsPerToken: CLAUDE_LEGACY } },
    { id: 'claude-opus-4-5', label: 'Claude Opus 4.5', provider: 'Anthropic', contextLimit: 200_000, encoder: { kind: 'heuristic', charsPerToken: CLAUDE_LEGACY } },
    // Deprecated on 2026-09-30: Anthropic retires it on 2026-11-30 and names
    // claude-sonnet-5-5 as the replacement. Remove it, with that alias, after.
    { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', provider: 'Anthropic', contextLimit: 200_000, encoder: { kind: 'heuristic', charsPerToken: CLAUDE_LEGACY } },
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', provider: 'Anthropic', contextLimit: 200_000, encoder: { kind: 'heuristic', charsPerToken: CLAUDE_LEGACY } },

    // ─────────────────────────────────────────────────────────────────────────
    // Google — exact where Google's own SDK maps the model to a Gemma
    // vocabulary, estimated otherwise. Text only: the local tokenizer cannot
    // account for image or audio input.
    // ─────────────────────────────────────────────────────────────────────────
    { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', provider: 'Google', contextLimit: 1_048_576, encoder: { kind: 'heuristic', charsPerToken: GEMINI_UNMAPPED } },
    { id: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash', provider: 'Google', contextLimit: 1_048_576, encoder: { kind: 'heuristic', charsPerToken: GEMINI_UNMAPPED } },
    { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', provider: 'Google', contextLimit: 1_048_576, encoder: { kind: 'heuristic', charsPerToken: GEMINI_UNMAPPED } },
    { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', provider: 'Google', contextLimit: 1_048_576, encoder: hf(HF.gemma4, GEMINI_UNMAPPED) },
    { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite', provider: 'Google', contextLimit: 1_048_576, encoder: { kind: 'heuristic', charsPerToken: GEMINI_UNMAPPED } },
    { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro (preview)', provider: 'Google', contextLimit: 1_048_576, encoder: hf(HF.gemma4, GEMINI_UNMAPPED) },
    { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite', provider: 'Google', contextLimit: 1_048_576, encoder: hf(HF.gemma4, GEMINI_UNMAPPED) },
    { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash (preview)', provider: 'Google', contextLimit: 1_048_576, encoder: hf(HF.gemma3, GEMINI_UNMAPPED) },
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', provider: 'Google', contextLimit: 1_048_576, encoder: hf(HF.gemma3, GEMINI_UNMAPPED) },
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', provider: 'Google', contextLimit: 1_048_576, encoder: hf(HF.gemma3, GEMINI_UNMAPPED) },
    { id: 'gemma-4-31b-it', label: 'Gemma 4 31B Instruct', provider: 'Google', contextLimit: 262_144, encoder: hf(HF.gemma4, GEMINI_UNMAPPED) },
    // Served by the Gemini API alongside 31B since 2026-04-02. All five Gemma 4
    // checkpoints serve a byte-identical tokenizer.json (sha256 cc8d3a0c…), so
    // it shares HF.gemma4.
    { id: 'gemma-4-26b-a4b-it', label: 'Gemma 4 26B A4B Instruct', provider: 'Google', contextLimit: 262_144, encoder: hf(HF.gemma4, GEMINI_UNMAPPED) },
    { id: 'gemma-4-e4b-it', label: 'Gemma 4 E4B Instruct', provider: 'Google', contextLimit: 131_072, encoder: hf(HF.gemma4, GEMINI_UNMAPPED) },

    // ─────────────────────────────────────────────────────────────────────────
    // xAI — estimated. No public tokenizer exists for any current Grok model.
    // Note grok-4.7, 4.6 and 4.5 have a *smaller* window than the older 4.3.
    // ─────────────────────────────────────────────────────────────────────────
    { id: 'grok-4.7', label: 'Grok 4.7', provider: 'xAI', contextLimit: 500_000, encoder: { kind: 'heuristic', charsPerToken: GROK } },
    { id: 'grok-4.6', label: 'Grok 4.6', provider: 'xAI', contextLimit: 500_000, encoder: { kind: 'heuristic', charsPerToken: GROK } },
    { id: 'grok-4.5', label: 'Grok 4.5', provider: 'xAI', contextLimit: 500_000, encoder: { kind: 'heuristic', charsPerToken: GROK } },
    { id: 'grok-4.3', label: 'Grok 4.3', provider: 'xAI', contextLimit: 1_000_000, encoder: { kind: 'heuristic', charsPerToken: GROK } },
    { id: 'grok-4.20', label: 'Grok 4.20', provider: 'xAI', contextLimit: 1_000_000, encoder: { kind: 'heuristic', charsPerToken: GROK } },
    { id: 'grok-build-0.1', label: 'Grok Build 0.1', provider: 'xAI', contextLimit: 256_000, encoder: { kind: 'heuristic', charsPerToken: GROK } },

    // ─────────────────────────────────────────────────────────────────────────
    // DeepSeek — exact. Reasoning is a mode of the model, not a separate one, so
    // the old R1/V3 entries are gone. V4.1 Flash replaced V4 Flash on
    // 2026-09-10 under the id `deepseek-flash`; the old id is only routed to it.
    // DeepSeek's API reference gives both models a context_window of 1048576,
    // input and output together, with no separate input cap.
    // ─────────────────────────────────────────────────────────────────────────
    { id: 'deepseek-flash', label: 'DeepSeek V4.1 Flash', provider: 'DeepSeek', contextLimit: 1_048_576, encoder: hf(HF.deepseek41, 3.3) },
    { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', provider: 'DeepSeek', contextLimit: 1_048_576, encoder: hf(HF.deepseek, 3.3) },

    // ─────────────────────────────────────────────────────────────────────────
    // Meta — exact. Llama 3+ uses a tiktoken-style BPE, which is why the old
    // cl100k proxy happened to be accurate here (measured: +0.2%).
    // ─────────────────────────────────────────────────────────────────────────
    // Meta's hosted API is now the closed Muse Spark family, which publishes no
    // tokenizer and no calibration data, so it is deliberately absent. Muse
    // Glimmer is the open-weight model and counts exactly.
    { id: 'muse-glimmer-30b', label: 'Muse Glimmer 30B', provider: 'Meta', contextLimit: 131_072, encoder: hf(HF.museGlimmer, 3.8) },
    { id: 'llama-4-scout', label: 'Llama 4 Scout', provider: 'Meta', contextLimit: 10_485_760, encoder: hf(HF.llama4, 3.8) },
    { id: 'llama-4-maverick', label: 'Llama 4 Maverick', provider: 'Meta', contextLimit: 1_048_576, encoder: hf(HF.llama4, 3.8) },
    { id: 'llama-3.3-70b', label: 'Llama 3.3 70B Instruct', provider: 'Meta', contextLimit: 131_072, encoder: hf(HF.llama3, 3.8) },
    { id: 'llama-3.1-8b', label: 'Llama 3.1 8B Instruct', provider: 'Meta', contextLimit: 131_072, encoder: hf(HF.llama3, 3.8) },

    // ─────────────────────────────────────────────────────────────────────────
    // Mistral — exact, except Large 4 until its weights ship. The Tekken
    // tokenizer is markedly denser than cl100k; the old proxy undercounted by up
    // to 23%.
    // ─────────────────────────────────────────────────────────────────────────
    // The ids are the strings Mistral's API actually accepts, which are not the
    // marketing names: Large 3 predates the major-minor convention and kept a
    // date suffix, Medium 3.5 and Large 4 use the hyphenated major-minor form
    // (never a dot), and Small 4 is date-suffixed too. "256k" on the docs means
    // 262,144 — the model cards serve with `--max-model-len 262144` — not
    // 256,000.
    //
    // Large 4 is a public preview whose open weights are announced but not yet
    // published (its Hugging Face repo is a placeholder that returns 401), so
    // it is estimated with Tekken's measured ratio, MISTRAL_UNPUBLISHED, and its
    // "1M" is taken literally until a config says otherwise. Revisit both when
    // the weights ship.
    //
    // Large 3 has its own file; Medium 3.5 and Small 4 share another. The two
    // vocabularies differ only in reserved slots 36 and 37, so ordinary text
    // encodes identically, but those slots are control strings: measured,
    // `[MODEL_SETTINGS]` is 1 token under Medium 3.5's own file and 6 under
    // Large 3's. Large 3's tokenizer also prepends a BOS token, which
    // `hfEncoder` already measures and subtracts.
    { id: 'mistral-large-4-0', label: 'Mistral Large 4 (preview)', provider: 'Mistral', contextLimit: 1_000_000, encoder: { kind: 'heuristic', charsPerToken: MISTRAL_UNPUBLISHED } },
    { id: 'mistral-large-2512', label: 'Mistral Large 3', provider: 'Mistral', contextLimit: 262_144, encoder: hf(HF.mistral, 3.0) },
    { id: 'mistral-medium-3-5', label: 'Mistral Medium 3.5', provider: 'Mistral', contextLimit: 262_144, encoder: hf(HF.mistralMedium35, 3.0) },
    { id: 'mistral-small-2603', label: 'Mistral Small 4', provider: 'Mistral', contextLimit: 262_144, encoder: hf(HF.mistralMedium35, 3.0) },

    // ─────────────────────────────────────────────────────────────────────────
    // Alibaba Qwen — exact for the open-weight models and for the two API models
    // Qwen's own model cards call "the official version based on" an open
    // checkpoint (Qwen3.8-Max on 2.4T-A95B, Qwen3.8-Flash on Flash-Next, both
    // sharing HF.qwen38). The 3.7 and 3.6 API models have no open counterpart,
    // so they are estimated with a ratio measured on the open Qwen3.6 vocab.
    // ─────────────────────────────────────────────────────────────────────────
    // Model Studio publishes "Context Window" and "Max Input Length" as separate
    // fields, and these are the latter: 991,808 rather than the advertised
    // 1,000,000, and 260,096 rather than 262,144. The registry records what a
    // prompt may actually contain. (The open-weight 3.8 checkpoints are 256K
    // natively — max_position_embeddings 262144 — and their model cards
    // document the extension to 1M that Alibaba serves.)
    { id: 'qwen3.8-max', label: 'Qwen3.8-Max', provider: 'Alibaba', contextLimit: 991_808, encoder: hf(HF.qwen38, QWEN_CLOSED) },
    { id: 'qwen3.8-flash', label: 'Qwen3.8-Flash', provider: 'Alibaba', contextLimit: 991_808, encoder: hf(HF.qwen38, QWEN_CLOSED) },
    { id: 'qwen3.8-2.4t-a95b', label: 'Qwen3.8 2.4T-A95B', provider: 'Alibaba', contextLimit: 991_808, encoder: hf(HF.qwen38, QWEN_CLOSED) },
    { id: 'qwen3.8-27b', label: 'Qwen3.8 27B', provider: 'Alibaba', contextLimit: 991_808, encoder: hf(HF.qwen38, QWEN_CLOSED) },
    { id: 'qwen3.7-max', label: 'Qwen3.7-Max', provider: 'Alibaba', contextLimit: 991_808, encoder: { kind: 'heuristic', charsPerToken: QWEN_CLOSED } },
    { id: 'qwen3.7-plus', label: 'Qwen3.7-Plus', provider: 'Alibaba', contextLimit: 991_808, encoder: { kind: 'heuristic', charsPerToken: QWEN_CLOSED } },
    { id: 'qwen3.7-flash', label: 'Qwen3.7-Flash', provider: 'Alibaba', contextLimit: 991_808, encoder: { kind: 'heuristic', charsPerToken: QWEN_CLOSED } },
    { id: 'qwen3.6-plus', label: 'Qwen3.6-Plus', provider: 'Alibaba', contextLimit: 991_808, encoder: { kind: 'heuristic', charsPerToken: QWEN_CLOSED } },
    { id: 'qwen3.6-27b', label: 'Qwen3.6 27B', provider: 'Alibaba', contextLimit: 260_096, encoder: hf(HF.qwen, QWEN_CLOSED) },
    { id: 'qwen3.6-35b-a3b', label: 'Qwen3.6 35B-A3B', provider: 'Alibaba', contextLimit: 260_096, encoder: hf(HF.qwen, QWEN_CLOSED) },

    // ─────────────────────────────────────────────────────────────────────────
    // Zhipu GLM — exact, except GLM-5-Turbo.
    // ─────────────────────────────────────────────────────────────────────────
    // Z.ai publishes a single "Context Window" per model and no separate input
    // cap, so these are the advertised windows — the same basis as glm-5.2.
    //
    // GLM-5.3-FlashX is GLM-5.3-Flash served faster: Zhipu documents both under
    // one model code line, "text parameters consistent with GLM-5.3", so it
    // takes Flash's vocabulary and window. GLM-5-Turbo is the reverse case:
    // Zhipu calls it separately optimised from the training phase, names no
    // shared base, and publishes no tokenizer to hash, so it is estimated with
    // the GLM-5 vocabulary's measured ratio, GLM_UNPUBLISHED. Every published
    // GLM-5 file is byte-identical, so a shared vocabulary is likely, but
    // likely is not exact. Zhipu's /paas/v4/tokenizer endpoint accepts it, so
    // with an API key the ratio could be checked against the model itself.
    { id: 'glm-5.3', label: 'GLM-5.3', provider: 'Zhipu', contextLimit: 1_048_576, encoder: hf(HF.glm, 3.6) },
    { id: 'glm-5.3-flash', label: 'GLM-5.3-Flash', provider: 'Zhipu', contextLimit: 1_048_576, encoder: hf(HF.glm, 3.6) },
    { id: 'glm-5.3-flashx', label: 'GLM-5.3-FlashX', provider: 'Zhipu', contextLimit: 1_048_576, encoder: hf(HF.glm, 3.6) },
    { id: 'glm-5.2', label: 'GLM-5.2', provider: 'Zhipu', contextLimit: 1_048_576, encoder: hf(HF.glm, 3.6) },
    { id: 'glm-5.1', label: 'GLM-5.1', provider: 'Zhipu', contextLimit: 200_000, encoder: hf(HF.glm, 3.6) },
    { id: 'glm-5', label: 'GLM-5', provider: 'Zhipu', contextLimit: 200_000, encoder: hf(HF.glm, 3.6) },
    { id: 'glm-5-turbo', label: 'GLM-5-Turbo', provider: 'Zhipu', contextLimit: 200_000, encoder: { kind: 'heuristic', charsPerToken: GLM_UNPUBLISHED } },

    // ─────────────────────────────────────────────────────────────────────────
    // MiniMax — exact, except the M3.1 Flash preview.
    // ─────────────────────────────────────────────────────────────────────────
    // The ids are mixed case because MiniMax's API documents only that form —
    // its OpenAPI enum, its list-models example and every `model=` in its docs
    // say `MiniMax-M3`. Lowercase appears only in a tool-call parser flag, a
    // container name and URLs, never as a model value. The lowercase ids this
    // registry used since 1.0 alias forward.
    //
    // M3.1 Flash is a closed preview (M Plan and MiniMax Code only, a public
    // subscription rather than an approval programme) with no published
    // tokenizer, and nothing first-party says it reuses M3's, so it is
    // estimated with M3's measured ratio, MINIMAX_UNPUBLISHED. As with Grok,
    // only the server counts it exactly: MiniMax's /v1/responses/input_tokens
    // accepts it.
    { id: 'MiniMax-M3.1-Flash-Preview', label: 'MiniMax M3.1 Flash (preview)', provider: 'MiniMax', contextLimit: 1_000_000, encoder: { kind: 'heuristic', charsPerToken: MINIMAX_UNPUBLISHED } },
    { id: 'MiniMax-M3', label: 'MiniMax M3', provider: 'MiniMax', contextLimit: 1_000_000, encoder: hf(HF.minimax, 3.6) },
    { id: 'MiniMax-M2.7', label: 'MiniMax M2.7', provider: 'MiniMax', contextLimit: 204_800, encoder: hf(HF.minimaxLegacy, 3.6) },
    { id: 'MiniMax-M2.5', label: 'MiniMax M2.5', provider: 'MiniMax', contextLimit: 204_800, encoder: hf(HF.minimaxLegacy, 3.6) },
    { id: 'MiniMax-M2.1', label: 'MiniMax M2.1', provider: 'MiniMax', contextLimit: 204_800, encoder: hf(HF.minimaxLegacy, 3.6) },
    { id: 'MiniMax-M2', label: 'MiniMax M2', provider: 'MiniMax', contextLimit: 204_800, encoder: hf(HF.minimaxLegacy, 3.6) },

    // ─────────────────────────────────────────────────────────────────────────
    // Moonshot Kimi — exact. Moonshot publishes a tiktoken rank table rather
    // than a tokenizer.json, which is why these were estimated until 2.1.
    // ─────────────────────────────────────────────────────────────────────────
    { id: 'kimi-k3', label: 'Kimi K3', provider: 'Moonshot', contextLimit: 1_048_576, encoder: rankTable(HF.kimi, KIMI) },
    { id: 'kimi-k2.7-code', label: 'Kimi K2.7 Code', provider: 'Moonshot', contextLimit: 262_144, encoder: rankTable(HF.kimi, KIMI) },
    { id: 'kimi-k2.6', label: 'Kimi K2.6', provider: 'Moonshot', contextLimit: 262_144, encoder: rankTable(HF.kimi, KIMI) },

    // ─────────────────────────────────────────────────────────────────────────
    // Xiaomi MiMo / Tencent Hunyuan — exact.
    // ─────────────────────────────────────────────────────────────────────────
    // The V2 series went offline on 2026-06-30 and mimo-v2-flash has been routed
    // to mimo-v2.5 since 2026-06-18, so the Flash entry is gone (aliased below).
    // V2.5 is next: Xiaomi routes mimo-v2.5-pro and mimo-v2.5 to the V2.6 models
    // from 2026-10-14 and retires both names on 2026-10-21. Remove them then,
    // aliased to their V2.6 replacements, and re-point mimo-v2-flash with them.
    { id: 'mimo-v2.6-pro', label: 'MiMo V2.6 Pro', provider: 'Xiaomi', contextLimit: 1_048_576, encoder: hf(HF.mimo26, 3.6) },
    { id: 'mimo-v2.6-flash', label: 'MiMo V2.6 Flash', provider: 'Xiaomi', contextLimit: 1_048_576, encoder: hf(HF.mimo26, 3.6) },
    { id: 'mimo-v2.5-pro', label: 'MiMo V2.5 Pro', provider: 'Xiaomi', contextLimit: 1_048_576, encoder: hf(HF.mimoPro, 3.6) },
    { id: 'mimo-v2.5', label: 'MiMo V2.5', provider: 'Xiaomi', contextLimit: 1_048_576, encoder: hf(HF.mimo, 3.6) },

    // `hunyuan-hy3` was never a Tencent id — it appears on none of their model
    // tables, on either the international or the China site. The real ids are
    // `hy4-preview` and `hy3`, and Tencent publishes a "Maximum Input (Tokens)"
    // column separately from the context window: 960k and 192k, where k is 1024
    // (the China docs write hy4-preview's window as "1024k", and 960k + 64k of
    // output closes exactly to it).
    { id: 'hy4-preview', label: 'Hy4 preview', provider: 'Tencent', contextLimit: 983_040, encoder: hf(HF.hunyuan4, 3.6) },
    { id: 'hy3', label: 'Hy3', provider: 'Tencent', contextLimit: 196_608, encoder: hf(HF.hunyuan, 3.6) },
];

/**
 * Ids the registry no longer lists — from v1.x and from later refreshes —
 * mapped to the nearest model it does.
 *
 * Most no longer exist: some were renamed (the whole Anthropic block, the
 * MiniMax case), some were retired by their provider, and some never existed
 * at all. A few are still served but were curated out as an older generation
 * or a superseded variant: gemini-2.5-flash-lite, the GLM-4 models, and
 * OpenAI's gpt-4, o1, o3-mini and o3-pro ahead of their shutdowns. A saved
 * choice is migrated on first run rather than silently reset to the default,
 * with a one-time notice unless only the case changed. `findModel` follows a
 * single hop, so when a target is itself retired, every alias pointing at it
 * is re-pointed in the same change.
 */
export const MODEL_ALIASES: Readonly<Record<string, string>> = Object.freeze({
    // Anthropic: v1.3.0 invented a `claude-<major>.<minor>-<tier>` format.
    'claude-4.7-opus': 'claude-opus-4-7',
    'claude-4.6-opus': 'claude-opus-4-6',
    'claude-4.6-sonnet': 'claude-sonnet-4-6',
    'claude-4.5-opus': 'claude-opus-4-5',
    'claude-4.5-sonnet': 'claude-sonnet-4-5',
    'claude-4.5-haiku': 'claude-haiku-4-5',
    // Retired Claude models.
    'claude-3.7-sonnet': 'claude-sonnet-5',
    'claude-3.5-sonnet': 'claude-sonnet-5',
    'claude-3-opus': 'claude-opus-5',
    'claude-3-haiku': 'claude-haiku-4-5',

    // OpenAI: renamed, retired, or superseded.
    'gpt-4': 'gpt-4-turbo',
    o1: 'o3',
    'o3-mini': 'o4-mini',
    'o3-pro': 'o3',

    // Google: v1.3.0 dropped the `-preview` suffix, so the ids 404'd.
    'gemini-3.1-pro': 'gemini-3.1-pro-preview',
    'gemini-3-flash': 'gemini-3-flash-preview',
    'gemini-3-pro': 'gemini-3.1-pro-preview',
    'gemini-2.5-flash-lite': 'gemini-3.5-flash-lite',
    'gemini-2.0-flash': 'gemini-2.5-flash',
    'gemini-1.5-pro': 'gemini-2.5-pro',

    // xAI: grok-4.2 / 4.1-fast / 4-fast are absent from xAI's catalogue and
    // appear to have been transcription errors for grok-4.20.
    'grok-4.2': 'grok-4.20',
    'grok-4.1-fast': 'grok-4.20',
    'grok-4-fast': 'grok-4.20',
    'grok-3': 'grok-4.3',
    'grok-code-fast-1': 'grok-build-0.1',

    // DeepSeek: reasoning folded into V4, and V4 Flash retired in favour of
    // V4.1 Flash on 2026-09-10 (DeepSeek routes the old id to it).
    'deepseek-v4-flash': 'deepseek-flash',
    'deepseek-v3.2': 'deepseek-flash',
    'deepseek-v3.1': 'deepseek-flash',
    'deepseek-v3': 'deepseek-flash',
    'deepseek-r1': 'deepseek-v4-pro',

    // Meta / Mistral / Alibaba: stale generations.
    'llama-3.3': 'llama-3.3-70b',
    'llama-3.2': 'llama-3.1-8b',
    codellama: 'llama-3.1-8b',
    'mistral-large': 'mistral-large-2512',
    'qwen3.5': 'qwen3.6-27b',
    qwen3: 'qwen3.6-27b',
    'qwq-32b': 'qwen3.6-27b',
    'qwen-2.5-coder': 'qwen3.6-27b',

    // Mistral: the registry carried the marketing names, which the API does not
    // accept. `mistral-medium-3` and the `-latest` aliases are Mistral's own
    // documented aliases and resolve to the same rows.
    'mistral-large-3': 'mistral-large-2512',
    'mistral-large-latest': 'mistral-large-2512',
    'mistral-medium-3.5': 'mistral-medium-3-5',
    'mistral-medium-3': 'mistral-medium-3-5',
    'mistral-medium-latest': 'mistral-medium-3-5',
    'mistral-small-4': 'mistral-small-2603',
    'mistral-small-latest': 'mistral-small-2603',
    // `mistral-large-4` is Mistral's documented floating major alias, as
    // `mistral-medium-3` is for Medium 3.5.
    'mistral-large-4': 'mistral-large-4-0',

    // MiniMax: the API documents mixed-case ids only.
    'minimax-m3': 'MiniMax-M3',
    'minimax-m2.7': 'MiniMax-M2.7',
    'minimax-m2.5': 'MiniMax-M2.5',
    'minimax-m2.1': 'MiniMax-M2.1',
    'minimax-m2': 'MiniMax-M2',

    // Tencent: `hunyuan-hy3` never existed as an API id.
    'hunyuan-hy3': 'hy3',

    // Xiaomi: the V2 series is offline; Xiaomi itself routes Flash to V2.5.
    'mimo-v2-flash': 'mimo-v2.5',

    // Zhipu / Moonshot.
    'glm-4.7': 'glm-5',
    'glm-4.6': 'glm-5',
    'glm-4.5': 'glm-5',
    'kimi-k2.5': 'kimi-k2.6',
});
