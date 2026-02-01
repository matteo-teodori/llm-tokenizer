import { getEncoding, Tiktoken } from "js-tiktoken";

/**
 * Model metadata for token counting
 * 
 * Accuracy notes (based on research):
 * - OpenAI: Uses tiktoken directly (exact)
 * - Claude: ~3.5 chars/token for English (Anthropic official)
 * - Gemini: ~4 chars/token (Google official)
 * - DeepSeek: ~3.3 chars/token (0.3 tokens per char, official docs)
 * - GLM: vocab 151K, similar to GPT-4 structure
 */
export interface ModelInfo {
    id: string;
    label: string;
    provider: string;
    encoding: 'cl100k_base' | 'p50k_base' | 'o200k_base' | 'char_approx';
    /** 
     * For char_approx: chars per token ratio (divide text.length by this)
     * For tiktoken: multiply result by this factor
     */
    tokenFactor: number;
}

/**
 * Complete model registry with top AI models (2026)
 * Research-based accuracy factors applied
 */
export const MODEL_REGISTRY: ModelInfo[] = [
    // ─────────────────────────────────────────────────────────────
    // OpenAI (tiktoken o200k_base/cl100k_base - EXACT)
    // ─────────────────────────────────────────────────────────────
    { id: "gpt-5.2", label: "GPT-5.2", provider: "OpenAI", encoding: "o200k_base", tokenFactor: 1.0 },
    { id: "gpt-oss-120b", label: "GPT-OSS 120B", provider: "OpenAI", encoding: "o200k_base", tokenFactor: 1.0 },
    { id: "gpt-4o", label: "GPT-4o", provider: "OpenAI", encoding: "o200k_base", tokenFactor: 1.0 },
    { id: "gpt-4o-mini", label: "GPT-4o Mini", provider: "OpenAI", encoding: "o200k_base", tokenFactor: 1.0 },
    { id: "o1", label: "o1", provider: "OpenAI", encoding: "o200k_base", tokenFactor: 1.0 },
    { id: "o3-mini", label: "o3-mini", provider: "OpenAI", encoding: "o200k_base", tokenFactor: 1.0 },
    { id: "gpt-4", label: "GPT-4 (Legacy)", provider: "OpenAI", encoding: "cl100k_base", tokenFactor: 1.0 },
    { id: "gpt-3.5-turbo", label: "GPT-3.5 Turbo (Legacy)", provider: "OpenAI", encoding: "cl100k_base", tokenFactor: 1.0 },

    // ─────────────────────────────────────────────────────────────
    // Anthropic (~3.5 chars/token for English - Anthropic official)
    // Using cl100k_base with 1.05x factor as approximation
    // ─────────────────────────────────────────────────────────────
    { id: "claude-4.5-sonnet", label: "Claude Sonnet 4.5", provider: "Anthropic", encoding: "cl100k_base", tokenFactor: 1.05 },
    { id: "claude-4.5-opus", label: "Claude Opus 4.5", provider: "Anthropic", encoding: "cl100k_base", tokenFactor: 1.05 },
    { id: "claude-4.5-haiku", label: "Claude Haiku 4.5", provider: "Anthropic", encoding: "cl100k_base", tokenFactor: 1.05 },
    { id: "claude-3.5-sonnet", label: "Claude 3.5 Sonnet", provider: "Anthropic", encoding: "cl100k_base", tokenFactor: 1.05 },
    { id: "claude-3-opus", label: "Claude 3 Opus", provider: "Anthropic", encoding: "cl100k_base", tokenFactor: 1.05 },
    { id: "claude-3-haiku", label: "Claude 3 Haiku", provider: "Anthropic", encoding: "cl100k_base", tokenFactor: 1.05 },

    // ─────────────────────────────────────────────────────────────
    // Google Gemini (~4 chars/token - Google official)
    // ─────────────────────────────────────────────────────────────
    { id: "gemini-3-flash", label: "Gemini 3 Flash Preview", provider: "Google", encoding: "char_approx", tokenFactor: 4.0 },
    { id: "gemini-3-pro", label: "Gemini 3 Pro Preview", provider: "Google", encoding: "char_approx", tokenFactor: 4.0 },
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", provider: "Google", encoding: "char_approx", tokenFactor: 4.0 },
    { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite", provider: "Google", encoding: "char_approx", tokenFactor: 4.0 },
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", provider: "Google", encoding: "char_approx", tokenFactor: 4.0 },
    { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash", provider: "Google", encoding: "char_approx", tokenFactor: 4.0 },
    { id: "gemini-1.5-pro", label: "Gemini 1.5 Pro", provider: "Google", encoding: "char_approx", tokenFactor: 4.0 },

    // ─────────────────────────────────────────────────────────────
    // xAI Grok (assumed similar to modern BPE, ~4 chars/token)
    // ─────────────────────────────────────────────────────────────
    { id: "grok-4.1-fast", label: "Grok 4.1 Fast", provider: "xAI", encoding: "cl100k_base", tokenFactor: 1.0 },
    { id: "grok-4-fast", label: "Grok 4 Fast", provider: "xAI", encoding: "cl100k_base", tokenFactor: 1.0 },
    { id: "grok-code-fast-1", label: "Grok Code Fast 1", provider: "xAI", encoding: "cl100k_base", tokenFactor: 1.0 },

    // ─────────────────────────────────────────────────────────────
    // DeepSeek (~3.3 chars/token, 0.3 tokens/char - Official docs)
    // ─────────────────────────────────────────────────────────────
    { id: "deepseek-v3.2", label: "DeepSeek V3.2", provider: "DeepSeek", encoding: "char_approx", tokenFactor: 3.33 },
    { id: "deepseek-v3", label: "DeepSeek V3", provider: "DeepSeek", encoding: "char_approx", tokenFactor: 3.33 },

    // ─────────────────────────────────────────────────────────────
    // Meta Llama (tiktoken-based for Llama 3+)
    // ─────────────────────────────────────────────────────────────
    { id: "llama-3.2", label: "Llama 3.2", provider: "Meta", encoding: "cl100k_base", tokenFactor: 1.0 },
    { id: "codellama", label: "CodeLlama", provider: "Meta", encoding: "cl100k_base", tokenFactor: 1.1 },

    // ─────────────────────────────────────────────────────────────
    // Mistral (BPE similar to GPT-4)
    // ─────────────────────────────────────────────────────────────
    { id: "mistral-large", label: "Mistral Large", provider: "Mistral", encoding: "cl100k_base", tokenFactor: 1.0 },

    // ─────────────────────────────────────────────────────────────
    // Alibaba Qwen (BPE, 151K vocab, similar to GPT-4)
    // ─────────────────────────────────────────────────────────────
    { id: "qwen-2.5-coder", label: "Qwen 2.5 Coder", provider: "Alibaba", encoding: "cl100k_base", tokenFactor: 1.0 },

    // ─────────────────────────────────────────────────────────────
    // Moonshot Kimi
    // ─────────────────────────────────────────────────────────────
    { id: "kimi-k2.5", label: "Kimi K2.5", provider: "Moonshot", encoding: "cl100k_base", tokenFactor: 1.0 },

    // ─────────────────────────────────────────────────────────────
    // Xiaomi MiMo
    // ─────────────────────────────────────────────────────────────
    { id: "mimo-v2-flash", label: "MiMo-V2-Flash", provider: "Xiaomi", encoding: "cl100k_base", tokenFactor: 1.0 },

    // ─────────────────────────────────────────────────────────────
    // MiniMax
    // ─────────────────────────────────────────────────────────────
    { id: "minimax-m2.1", label: "MiniMax M2.1", provider: "MiniMax", encoding: "cl100k_base", tokenFactor: 1.0 },

    // ─────────────────────────────────────────────────────────────
    // Zhipu GLM (vocab 151,552 - similar structure to GPT-4)
    // ─────────────────────────────────────────────────────────────
    { id: "glm-4.7", label: "GLM 4.7", provider: "Zhipu", encoding: "cl100k_base", tokenFactor: 1.0 },
    { id: "glm-4.6", label: "GLM 4.6", provider: "Zhipu", encoding: "cl100k_base", tokenFactor: 1.0 },
    { id: "glm-4.5", label: "GLM 4.5", provider: "Zhipu", encoding: "cl100k_base", tokenFactor: 1.0 },
];

export type ModelId = typeof MODEL_REGISTRY[number]['id'];

// Cache encoders to avoid re-initialization
const encoderCache: Map<string, Tiktoken> = new Map();

function getEncoder(encoding: 'cl100k_base' | 'p50k_base' | 'o200k_base'): Tiktoken {
    if (!encoderCache.has(encoding)) {
        encoderCache.set(encoding, getEncoding(encoding));
    }
    return encoderCache.get(encoding)!;
}

export class TokenizerService {
    private currentModelId: string = "gpt-5.2";

    constructor() { }

    public setModel(modelId: string) {
        this.currentModelId = modelId;
    }

    public getModel(): string {
        return this.currentModelId;
    }

    public getModelInfo(): ModelInfo | undefined {
        return MODEL_REGISTRY.find(m => m.id === this.currentModelId);
    }

    public countTokens(text: string): number {
        const model = this.getModelInfo();
        if (!model) {
            // Fallback: ~4 chars per token
            return Math.ceil(text.length / 4);
        }

        if (model.encoding === 'char_approx') {
            // Character-based approximation: divide by chars-per-token ratio
            return Math.ceil(text.length / model.tokenFactor);
        } else {
            // Tiktoken-based exact counting
            try {
                const enc = getEncoder(model.encoding);
                const baseCount = enc.encode(text).length;
                return Math.ceil(baseCount * model.tokenFactor);
            } catch (e) {
                console.error(`Error encoding with ${model.encoding}:`, e);
                return Math.ceil(text.length / 4);
            }
        }
    }
}
