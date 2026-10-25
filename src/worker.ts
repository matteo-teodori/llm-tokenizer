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

/**
 * The encoders built from the vocabularies the host has handed us, keyed by
 * repo id. The encoder, not what it was built from: the host posts the text of
 * the file, and keeping that would hold a second copy of each vocabulary for
 * nothing beside the tokenizer built from it — 24 MB of heap for Gemma 3's,
 * measured.
 */
const loaded = new Map<string, Encoder>();

function reply(response: WorkerResponse): void {
    port.postMessage(response);
}

function encoderFor(spec: EncoderSpec): Encoder {
    const downloaded = isDownloadable(spec) ? loaded.get(spec.repo) : undefined;
    // Without one, resolveEncoder falls back to the spec's own heuristic: not
    // downloaded yet, so an estimate now beats an error, and the host
    // re-counts once the download lands.
    return downloaded?.kind === spec.kind ? downloaded : resolveEncoder(spec);
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
            // Parsed and built now, so the cost lands here rather than inside
            // the first count, and so a malformed vocabulary is reported as a
            // failed load rather than a failed count.
            const encoder = request.asset.kind === 'hf'
                ? hfEncoder(request.repo, request.asset)
                : tiktokenModelEncoder(request.repo, request.asset);
            // Recorded only once it builds. Recording it first meant a
            // vocabulary that failed to build stayed in the map, so every
            // later count re-entered the same failing constructor and threw
            // instead of falling back to the model's estimate.
            loaded.set(request.repo, encoder);
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
