/**
 * The model registry (August 2026).
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
 * Claude from Opus 4.7 onward. Anthropic switched tokenizer at that release:
 * the same text costs roughly 1.35× what it did before, which is why this and
 * CLAUDE_LEGACY differ so much.
 *
 * Do not infer the tokenizer from the version number — Sonnet 4.6 shipped
 * after Opus 4.7 and still uses the old one.
 */
const CLAUDE_CURRENT = 2.5;

/** Claude up to and including the 4.6 generation. */
const CLAUDE_LEGACY = 3.4;

/**
 * Grok. Uncalibrated: xAI publishes no tokenizer for any current model
 * (`xai-org` on Hugging Face stops at grok-1/grok-2) and the only exact path
 * is their server-side /v1/tokenize-text endpoint.
 */
const GROK = 3.7;

/** Gemini releases that Google's SDK does not yet map to a Gemma vocabulary. */
const GEMINI_UNMAPPED = 4.0;

/** Qwen's closed-weight API models, proxied through the open Qwen3.6 vocab. */
const QWEN_CLOSED = 3.6;

/** Only used until Kimi's rank table has been downloaded. */
const KIMI = 3.6;

// ─────────────────────────────────────────────────────────────────────────────
// Hugging Face tokenizer sources
//
// Meta's and Google's own repos are gated (HTTP 401 without an account), so
// ungated mirrors are used. Every repo below was checked to serve
// tokenizer.json anonymously.
// ─────────────────────────────────────────────────────────────────────────────

const HF = {
    llama3: 'unsloth/Llama-3.3-70B-Instruct',
    llama4: 'unsloth/Llama-4-Scout-17B-16E-Instruct',
    gemma3: 'unsloth/gemma-3-4b-it',
    gemma4: 'google/gemma-4-E4B-it',
    deepseek: 'deepseek-ai/DeepSeek-V4-Flash',
    qwen: 'Qwen/Qwen3.6-27B',
    mistral: 'mistralai/Mistral-Large-3-675B-Instruct-2512',
    glm: 'zai-org/GLM-5.2',
    minimax: 'MiniMaxAI/MiniMax-M3',
    minimaxLegacy: 'MiniMaxAI/MiniMax-M2',
    mimo: 'XiaomiMiMo/MiMo-V2-Flash',
    hunyuan: 'tencent/Hy3',
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

export const MODELS: ModelInfo[] = [
    // ─────────────────────────────────────────────────────────────────────────
    // OpenAI — exact, offline. tiktoken is OpenAI's own tokenizer.
    // ─────────────────────────────────────────────────────────────────────────
    { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', provider: 'OpenAI', contextLimit: 922_000, encoder: { kind: 'tiktoken', encoding: 'o200k_base' } },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', provider: 'OpenAI', contextLimit: 922_000, encoder: { kind: 'tiktoken', encoding: 'o200k_base' } },
    { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', provider: 'OpenAI', contextLimit: 922_000, encoder: { kind: 'tiktoken', encoding: 'o200k_base' } },
    { id: 'gpt-5.5', label: 'GPT-5.5', provider: 'OpenAI', contextLimit: 922_000, encoder: { kind: 'tiktoken', encoding: 'o200k_base' } },
    { id: 'gpt-5.4', label: 'GPT-5.4', provider: 'OpenAI', contextLimit: 922_000, encoder: { kind: 'tiktoken', encoding: 'o200k_base' } },
    { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini', provider: 'OpenAI', contextLimit: 272_000, encoder: { kind: 'tiktoken', encoding: 'o200k_base' } },
    { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', provider: 'OpenAI', contextLimit: 272_000, encoder: { kind: 'tiktoken', encoding: 'o200k_base' } },
    { id: 'gpt-5.2', label: 'GPT-5.2', provider: 'OpenAI', contextLimit: 272_000, encoder: { kind: 'tiktoken', encoding: 'o200k_base' } },
    { id: 'gpt-5.1', label: 'GPT-5.1', provider: 'OpenAI', contextLimit: 272_000, encoder: { kind: 'tiktoken', encoding: 'o200k_base' } },
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
    // Kept because Azure OpenAI retires on its own schedule and these
    // deployments are still widespread in enterprises.
    { id: 'gpt-4-turbo', label: 'GPT-4 Turbo (legacy)', provider: 'OpenAI', contextLimit: 128_000, encoder: { kind: 'tiktoken', encoding: 'cl100k_base' } },
    { id: 'gpt-3.5-turbo', label: 'GPT-3.5 Turbo (legacy)', provider: 'OpenAI', contextLimit: 16_385, encoder: { kind: 'tiktoken', encoding: 'cl100k_base' } },

    // ─────────────────────────────────────────────────────────────────────────
    // Anthropic — estimated. No Claude tokenizer has ever been published, and
    // Anthropic's own guidance is not to approximate Claude with tiktoken: it
    // undercounts by 15-20% on prose and more on code. The only exact route is
    // their /v1/messages/count_tokens endpoint, which needs an API key.
    // ─────────────────────────────────────────────────────────────────────────
    { id: 'claude-opus-5', label: 'Claude Opus 5', provider: 'Anthropic', contextLimit: 1_000_000, encoder: { kind: 'heuristic', charsPerToken: CLAUDE_CURRENT } },
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', provider: 'Anthropic', contextLimit: 1_000_000, encoder: { kind: 'heuristic', charsPerToken: CLAUDE_CURRENT } },
    { id: 'claude-fable-5', label: 'Claude Fable 5', provider: 'Anthropic', contextLimit: 1_000_000, encoder: { kind: 'heuristic', charsPerToken: CLAUDE_CURRENT } },
    { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', provider: 'Anthropic', contextLimit: 1_000_000, encoder: { kind: 'heuristic', charsPerToken: CLAUDE_CURRENT } },
    { id: 'claude-opus-4-7', label: 'Claude Opus 4.7', provider: 'Anthropic', contextLimit: 1_000_000, encoder: { kind: 'heuristic', charsPerToken: CLAUDE_CURRENT } },
    { id: 'claude-opus-4-6', label: 'Claude Opus 4.6', provider: 'Anthropic', contextLimit: 1_000_000, encoder: { kind: 'heuristic', charsPerToken: CLAUDE_LEGACY } },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', provider: 'Anthropic', contextLimit: 1_000_000, encoder: { kind: 'heuristic', charsPerToken: CLAUDE_LEGACY } },
    { id: 'claude-opus-4-5', label: 'Claude Opus 4.5', provider: 'Anthropic', contextLimit: 200_000, encoder: { kind: 'heuristic', charsPerToken: CLAUDE_LEGACY } },
    { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', provider: 'Anthropic', contextLimit: 200_000, encoder: { kind: 'heuristic', charsPerToken: CLAUDE_LEGACY } },
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', provider: 'Anthropic', contextLimit: 200_000, encoder: { kind: 'heuristic', charsPerToken: CLAUDE_LEGACY } },

    // ─────────────────────────────────────────────────────────────────────────
    // Google — exact where Google's own SDK maps the model to a Gemma
    // vocabulary, estimated otherwise. Text only: the local tokenizer cannot
    // account for image or audio input.
    // ─────────────────────────────────────────────────────────────────────────
    { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', provider: 'Google', contextLimit: 1_048_576, encoder: { kind: 'heuristic', charsPerToken: GEMINI_UNMAPPED } },
    { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', provider: 'Google', contextLimit: 1_048_576, encoder: hf(HF.gemma4, GEMINI_UNMAPPED) },
    { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite', provider: 'Google', contextLimit: 1_048_576, encoder: { kind: 'heuristic', charsPerToken: GEMINI_UNMAPPED } },
    { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro (preview)', provider: 'Google', contextLimit: 1_048_576, encoder: hf(HF.gemma4, GEMINI_UNMAPPED) },
    { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite', provider: 'Google', contextLimit: 1_048_576, encoder: hf(HF.gemma4, GEMINI_UNMAPPED) },
    { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash (preview)', provider: 'Google', contextLimit: 1_048_576, encoder: hf(HF.gemma3, GEMINI_UNMAPPED) },
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', provider: 'Google', contextLimit: 1_048_576, encoder: hf(HF.gemma3, GEMINI_UNMAPPED) },
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', provider: 'Google', contextLimit: 1_048_576, encoder: hf(HF.gemma3, GEMINI_UNMAPPED) },
    { id: 'gemma-4-31b-it', label: 'Gemma 4 31B Instruct', provider: 'Google', contextLimit: 262_144, encoder: hf(HF.gemma4, GEMINI_UNMAPPED) },
    { id: 'gemma-4-e4b-it', label: 'Gemma 4 E4B Instruct', provider: 'Google', contextLimit: 131_072, encoder: hf(HF.gemma4, GEMINI_UNMAPPED) },

    // ─────────────────────────────────────────────────────────────────────────
    // xAI — estimated. No public tokenizer exists for any current Grok model.
    // Note grok-4.5 has a *smaller* window than the older grok-4.3.
    // ─────────────────────────────────────────────────────────────────────────
    { id: 'grok-4.5', label: 'Grok 4.5', provider: 'xAI', contextLimit: 500_000, encoder: { kind: 'heuristic', charsPerToken: GROK } },
    { id: 'grok-4.3', label: 'Grok 4.3', provider: 'xAI', contextLimit: 1_000_000, encoder: { kind: 'heuristic', charsPerToken: GROK } },
    { id: 'grok-4.20', label: 'Grok 4.20', provider: 'xAI', contextLimit: 1_000_000, encoder: { kind: 'heuristic', charsPerToken: GROK } },
    { id: 'grok-build-0.1', label: 'Grok Build 0.1', provider: 'xAI', contextLimit: 256_000, encoder: { kind: 'heuristic', charsPerToken: GROK } },

    // ─────────────────────────────────────────────────────────────────────────
    // DeepSeek — exact. Reasoning is a mode of V4, not a separate model, so the
    // old R1/V3 entries are gone.
    // ─────────────────────────────────────────────────────────────────────────
    { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', provider: 'DeepSeek', contextLimit: 1_000_000, encoder: hf(HF.deepseek, 3.3) },
    { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', provider: 'DeepSeek', contextLimit: 1_000_000, encoder: hf(HF.deepseek, 3.3) },

    // ─────────────────────────────────────────────────────────────────────────
    // Meta — exact. Llama 3+ uses a tiktoken-style BPE, which is why the old
    // cl100k proxy happened to be accurate here (measured: +0.2%).
    // ─────────────────────────────────────────────────────────────────────────
    { id: 'llama-4-scout', label: 'Llama 4 Scout', provider: 'Meta', contextLimit: 10_485_760, encoder: hf(HF.llama4, 3.8) },
    { id: 'llama-4-maverick', label: 'Llama 4 Maverick', provider: 'Meta', contextLimit: 1_048_576, encoder: hf(HF.llama4, 3.8) },
    { id: 'llama-3.3-70b', label: 'Llama 3.3 70B Instruct', provider: 'Meta', contextLimit: 131_072, encoder: hf(HF.llama3, 3.8) },
    { id: 'llama-3.1-8b', label: 'Llama 3.1 8B Instruct', provider: 'Meta', contextLimit: 131_072, encoder: hf(HF.llama3, 3.8) },

    // ─────────────────────────────────────────────────────────────────────────
    // Mistral — exact. The Tekken tokenizer is markedly denser than cl100k;
    // the old proxy undercounted by up to 23%.
    // ─────────────────────────────────────────────────────────────────────────
    { id: 'mistral-large-3', label: 'Mistral Large 3', provider: 'Mistral', contextLimit: 256_000, encoder: hf(HF.mistral, 3.0) },
    { id: 'mistral-medium-3.5', label: 'Mistral Medium 3.5', provider: 'Mistral', contextLimit: 256_000, encoder: hf(HF.mistral, 3.0) },
    { id: 'mistral-small-4', label: 'Mistral Small 4', provider: 'Mistral', contextLimit: 256_000, encoder: hf(HF.mistral, 3.0) },

    // ─────────────────────────────────────────────────────────────────────────
    // Alibaba Qwen — exact for the open-weight models; the -Max/-Plus API
    // models are closed, so they are proxied through the open Qwen3.6 vocab.
    // ─────────────────────────────────────────────────────────────────────────
    { id: 'qwen3.7-max', label: 'Qwen3.7-Max', provider: 'Alibaba', contextLimit: 1_000_000, encoder: { kind: 'heuristic', charsPerToken: QWEN_CLOSED } },
    { id: 'qwen3.7-plus', label: 'Qwen3.7-Plus', provider: 'Alibaba', contextLimit: 1_000_000, encoder: { kind: 'heuristic', charsPerToken: QWEN_CLOSED } },
    { id: 'qwen3.6-plus', label: 'Qwen3.6-Plus', provider: 'Alibaba', contextLimit: 1_000_000, encoder: { kind: 'heuristic', charsPerToken: QWEN_CLOSED } },
    { id: 'qwen3.6-27b', label: 'Qwen3.6 27B', provider: 'Alibaba', contextLimit: 262_144, encoder: hf(HF.qwen, QWEN_CLOSED) },
    { id: 'qwen3.6-35b-a3b', label: 'Qwen3.6 35B-A3B', provider: 'Alibaba', contextLimit: 262_144, encoder: hf(HF.qwen, QWEN_CLOSED) },

    // ─────────────────────────────────────────────────────────────────────────
    // Zhipu GLM — exact.
    // ─────────────────────────────────────────────────────────────────────────
    { id: 'glm-5.2', label: 'GLM-5.2', provider: 'Zhipu', contextLimit: 1_048_576, encoder: hf(HF.glm, 3.6) },
    { id: 'glm-5.1', label: 'GLM-5.1', provider: 'Zhipu', contextLimit: 200_000, encoder: hf(HF.glm, 3.6) },
    { id: 'glm-5', label: 'GLM-5', provider: 'Zhipu', contextLimit: 200_000, encoder: hf(HF.glm, 3.6) },
    { id: 'glm-5-turbo', label: 'GLM-5-Turbo', provider: 'Zhipu', contextLimit: 200_000, encoder: hf(HF.glm, 3.6) },

    // ─────────────────────────────────────────────────────────────────────────
    // MiniMax — exact.
    // ─────────────────────────────────────────────────────────────────────────
    { id: 'minimax-m3', label: 'MiniMax M3', provider: 'MiniMax', contextLimit: 1_000_000, encoder: hf(HF.minimax, 3.6) },
    { id: 'minimax-m2.7', label: 'MiniMax M2.7', provider: 'MiniMax', contextLimit: 204_800, encoder: hf(HF.minimaxLegacy, 3.6) },
    { id: 'minimax-m2.5', label: 'MiniMax M2.5', provider: 'MiniMax', contextLimit: 204_800, encoder: hf(HF.minimaxLegacy, 3.6) },
    { id: 'minimax-m2.1', label: 'MiniMax M2.1', provider: 'MiniMax', contextLimit: 204_800, encoder: hf(HF.minimaxLegacy, 3.6) },

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
    { id: 'mimo-v2.5-pro', label: 'MiMo V2.5 Pro', provider: 'Xiaomi', contextLimit: 1_048_576, encoder: hf(HF.mimo, 3.6) },
    { id: 'mimo-v2-flash', label: 'MiMo V2 Flash', provider: 'Xiaomi', contextLimit: 262_144, encoder: hf(HF.mimo, 3.6) },
    { id: 'hunyuan-hy3', label: 'Hunyuan Hy3', provider: 'Tencent', contextLimit: 262_144, encoder: hf(HF.hunyuan, 3.6) },
];

/**
 * v1.x ids that no longer exist, mapped to the nearest live model.
 *
 * Some were renamed (the whole Anthropic block), some were retired by their
 * provider, and some never existed at all. Users get migrated on first run
 * with a one-time notice rather than silently reset to the default.
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

    // DeepSeek: reasoning folded into V4.
    'deepseek-v3.2': 'deepseek-v4-flash',
    'deepseek-v3.1': 'deepseek-v4-flash',
    'deepseek-v3': 'deepseek-v4-flash',
    'deepseek-r1': 'deepseek-v4-pro',

    // Meta / Mistral / Alibaba: stale generations.
    'llama-3.3': 'llama-3.3-70b',
    'llama-3.2': 'llama-3.1-8b',
    codellama: 'llama-3.1-8b',
    'mistral-large': 'mistral-large-3',
    'qwen3.5': 'qwen3.6-27b',
    qwen3: 'qwen3.6-27b',
    'qwq-32b': 'qwen3.6-27b',
    'qwen-2.5-coder': 'qwen3.6-27b',

    // Zhipu / Moonshot.
    'glm-4.7': 'glm-5',
    'glm-4.6': 'glm-5',
    'glm-4.5': 'glm-5',
    'kimi-k2.5': 'kimi-k2.6',
});
