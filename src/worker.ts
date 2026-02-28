import { parentPort } from 'worker_threads';
import { getEncoding, Tiktoken } from 'js-tiktoken';

// Cache encoders within this specific worker
const encoderCache: Map<string, Tiktoken> = new Map();

function getEncoder(encoding: 'cl100k_base' | 'p50k_base' | 'o200k_base' | string): Tiktoken {
    if (!encoderCache.has(encoding)) {
        encoderCache.set(encoding, getEncoding(encoding as any));
    }
    return encoderCache.get(encoding)!;
}

export interface TokenizeRequest {
    messageId: number;
    text: string;
    encoding: 'cl100k_base' | 'p50k_base' | 'o200k_base' | 'char_approx' | string;
    tokenFactor: number;
}

export interface TokenizeResponse {
    messageId: number;
    count: number;
    error?: string;
}

parentPort?.on('message', (request: TokenizeRequest) => {
    try {
        const { messageId, text, encoding, tokenFactor } = request;

        // Exact counting or character approximation is processed here in the background
        if (encoding === 'char_approx') {
            const count = Math.ceil(text.length / tokenFactor);
            parentPort?.postMessage({ messageId, count } as TokenizeResponse);
        } else {
            const enc = getEncoder(encoding);
            const baseCount = enc.encode(text).length;
            const count = Math.ceil(baseCount * tokenFactor);
            parentPort?.postMessage({ messageId, count } as TokenizeResponse);
        }
    } catch (error) {
        parentPort?.postMessage({
            messageId: request?.messageId,
            count: Math.ceil((request?.text?.length || 0) / 4), // Fallback calculation
            error: error instanceof Error ? error.message : String(error)
        } as TokenizeResponse);
    }
});
