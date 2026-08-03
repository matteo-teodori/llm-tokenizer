/**
 * Tokenizer worker thread.
 *
 * Tokenising is CPU-bound and can run for seconds on a large workspace, so it
 * never happens on the extension host. This file is the only place that loads
 * the tokenizer libraries.
 */

import { parentPort } from 'worker_threads';
import {
    type Encoder,
    type EncoderSpec,
    type HfTokenizerFiles,
    evictHfEncoder,
    heuristicEncoder,
    hfEncoder,
    resolveEncoder,
} from './tokenizer/encoders';
import type { WorkerRequest, WorkerResponse } from './tokenizer/protocol';

if (!parentPort) {
    throw new Error('worker.ts must be run as a worker thread');
}

const port = parentPort;

/** Hugging Face tokenizers the host has handed us, keyed by repo id. */
const loaded = new Map<string, HfTokenizerFiles>();

function reply(response: WorkerResponse): void {
    port.postMessage(response);
}

function encoderFor(spec: EncoderSpec): Encoder {
    if (spec.kind !== 'hf') {
        return resolveEncoder(spec);
    }

    const files = loaded.get(spec.repo);
    return files
        ? hfEncoder(spec.repo, files)
        // Not downloaded yet: an estimate now beats an error, and the host will
        // re-count once the download lands.
        : heuristicEncoder(spec.fallback.charsPerToken);
}

function handle(request: WorkerRequest): void {
    switch (request.type) {
        case 'count': {
            const encoder = encoderFor(request.spec);
            reply({
                type: 'count',
                id: request.id,
                count: encoder.count(request.text),
                exact: encoder.exact,
            });
            break;
        }

        case 'loadTokenizer': {
            loaded.set(request.repo, request.files);
            // Build it now so the cost lands here rather than inside the first
            // count, and so a malformed tokenizer.json is reported as a failed
            // load instead of a failed count.
            hfEncoder(request.repo, request.files);
            reply({ type: 'ack', id: request.id });
            break;
        }

        case 'evict': {
            loaded.delete(request.repo);
            evictHfEncoder(request.repo);
            reply({ type: 'ack', id: request.id });
            break;
        }
    }
}

port.on('message', (request: WorkerRequest) => {
    try {
        handle(request);
    } catch (error) {
        // Never let one bad request take down the worker: the host has pending
        // promises riding on every id.
        reply({
            type: 'error',
            id: request?.id ?? -1,
            message: error instanceof Error ? error.message : String(error),
        });
    }
});
