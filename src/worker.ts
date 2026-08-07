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
    type TokenizerAsset,
    evictDownloadedEncoder,
    hfEncoder,
    isDownloadable,
    resolveEncoder,
    tiktokenModelEncoder,
} from './tokenizer/encoders';
import type { WorkerRequest, WorkerResponse } from './tokenizer/protocol';

if (!parentPort) {
    throw new Error('worker.ts must be run as a worker thread');
}

const port = parentPort;

/** Vocabularies the host has handed us, keyed by repo id. */
const loaded = new Map<string, TokenizerAsset>();

function reply(response: WorkerResponse): void {
    port.postMessage(response);
}

function encoderFor(spec: EncoderSpec): Encoder {
    // resolveEncoder falls back to the spec's own heuristic when the asset is
    // absent: not downloaded yet, so an estimate now beats an error, and the
    // host re-counts once the download lands.
    return isDownloadable(spec)
        ? resolveEncoder(spec, loaded.get(spec.repo))
        : resolveEncoder(spec);
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
            loaded.set(request.repo, request.asset);
            // Built now so the cost lands here rather than inside the first
            // count, and so a malformed vocabulary is reported as a failed load
            // rather than a failed count.
            if (request.asset.kind === 'hf') {
                hfEncoder(request.repo, request.asset);
            } else {
                tiktokenModelEncoder(request.repo, request.asset);
            }
            reply({ type: 'ack', id: request.id });
            break;
        }

        case 'evict': {
            loaded.delete(request.repo);
            evictDownloadedEncoder(request.repo);
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
