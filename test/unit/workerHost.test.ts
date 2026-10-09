import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { WorkerHost } from '../../src/workerHost';

/** A worker that answers with its thread id and its heap limit. */
const ECHO = `
const { parentPort, resourceLimits, threadId } = require('worker_threads');
parentPort.on('message', request => parentPort.postMessage({ id: request.id, threadId, limit: resourceLimits.maxOldGenerationSizeMb }));
`;

interface Echo {
    id: number;
    threadId: number;
    limit: number;
}

/** A worker that, asked to, works for `beats` intervals, saying so at each, then answers; or never answers. */
const PATIENT = `
const { parentPort } = require('worker_threads');
parentPort.on('message', request => {
    if (request.silent) {
        return;
    }
    let beats = 0;
    const timer = setInterval(() => {
        if (++beats < request.beats) {
            parentPort.postMessage({ id: 0, progress: true });
        } else {
            clearInterval(timer);
            parentPort.postMessage({ id: request.id, done: true });
        }
    }, request.every);
});
`;

suite('worker host', () => {
    let tmp: string;
    let worker: string;
    const warnings: string[] = [];
    const log = { error: (m: string) => warnings.push(m), warn: (m: string) => warnings.push(m) };
    let hosts: WorkerHost<{ id: number }, Echo>[] = [];

    setup(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-tokenizer-host-'));
        worker = path.join(tmp, 'echo.js');
        fs.writeFileSync(worker, ECHO);
        warnings.length = 0;
    });

    teardown(() => {
        for (const host of hosts) {
            host.dispose();
        }
        hosts = [];
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    test('a stopped host starts a new worker on the next request, and no crash is counted', async () => {
        const host = new WorkerHost<{ id: number }, Echo>(worker, { name: 'echo', fallback: 'nothing', log });
        hosts.push(host);
        const first = await host.send({ id: 0 });
        assert.ok(host.running);

        host.stop();
        assert.ok(!host.running);
        const second = await host.send({ id: 0 });
        assert.notStrictEqual(second.threadId, first.threadId, 'the stopped worker answered');
        // Stopping four times inside a minute is no crash budget spent.
        for (let i = 0; i < 4; i++) {
            host.stop();
            await host.send({ id: 0 });
        }
        assert.deepStrictEqual([host.epoch, host.backingOff, warnings], [0, false, []]);
    });

    test('a request is given up when the worker goes silent, never because it is slow', async () => {
        const patient = path.join(tmp, 'patient.js');
        fs.writeFileSync(patient, PATIENT);
        type Ask = { id: number; every?: number; beats?: number; silent?: boolean };
        const host = new WorkerHost<Ask, { id: number; done?: boolean }>(patient, { name: 'patient', fallback: 'nothing', log, silenceTimeoutMs: 250 });
        const started = Date.now();
        // 600 ms of work, more than twice the timeout, with a word every 50 ms.
        const slow = host.send({ id: 0, every: 50, beats: 12 });
        // Sent at the same time, and never answered: alive while the worker talks.
        const unanswered = host.send({ id: 0, silent: true });
        assert.strictEqual((await slow).done, true);
        await assert.rejects(unanswered, /did not respond in time/);
        assert.ok(Date.now() - started >= 600, 'given up while the worker was still at work');
        host.dispose();
    });

    test('a heap limit reaches the worker', async () => {
        const host = new WorkerHost<{ id: number }, Echo>(worker, {
            name: 'echo',
            fallback: 'nothing',
            log,
            resourceLimits: { maxOldGenerationSizeMb: 64 },
        });
        hosts.push(host);
        assert.strictEqual((await host.send({ id: 0 })).limit, 64);
    });
});
