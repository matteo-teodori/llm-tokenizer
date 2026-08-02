/**
 * Wire protocol between the extension host and the tokenizer worker.
 *
 * Kept in its own module so both sides import the same definitions and neither
 * pulls in the other's dependencies.
 */

import type { EncoderSpec, HfTokenizerFiles } from './encoders';

/** Count the tokens in `text` using `spec`. */
export interface CountRequest {
    type: 'count';
    id: number;
    text: string;
    spec: EncoderSpec;
}

/**
 * Hand the worker a downloaded tokenizer so subsequent `count` requests for the
 * same repo are exact. Sent once per repo; the extension host owns the download.
 */
export interface LoadTokenizerRequest {
    type: 'loadTokenizer';
    id: number;
    repo: string;
    files: HfTokenizerFiles;
}

/** Release a loaded Hugging Face tokenizer (each holds ~120 MB of heap). */
export interface EvictRequest {
    type: 'evict';
    id: number;
    repo: string;
}

export type WorkerRequest = CountRequest | LoadTokenizerRequest | EvictRequest;

export interface CountResult {
    type: 'count';
    id: number;
    count: number;
    /** False when the number came from a heuristic rather than a real tokenizer. */
    exact: boolean;
}

export interface AckResult {
    type: 'ack';
    id: number;
}

export interface ErrorResult {
    type: 'error';
    id: number;
    message: string;
}

export type WorkerResponse = CountResult | AckResult | ErrorResult;
