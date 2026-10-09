/**
 * A worker thread started on demand, with its requests correlated to their
 * responses, and the crash handling the tokenizer worker needed in 2.1.2:
 *
 * - **Identity guard.** A worker that throws asynchronously emits 'error', and
 *   its 'exit' usually follows a turn later, by which time the next request
 *   has spawned a replacement. Unguarded, the dead worker's 'exit' discarded
 *   that replacement: it rejected the replacement's request, and orphaned a
 *   live thread that dispose() never terminated. Both handlers therefore
 *   ignore a worker that has already been replaced.
 * - **Crash budget.** A worker that dies as it loads used to be respawned by
 *   every request: measured at 50 spawns for 50 requests in 1.2 s. After
 *   MAX_WORKER_CRASHES deaths within CRASH_WINDOW_MS it is not restarted until
 *   the oldest of them ages out, on a monotonic clock so a wall-clock step back
 *   cannot stretch the window.
 * - **Crash epoch.** Bumped on every death, so code that awaits the worker can
 *   tell a dying worker from a failed request by comparing it before and
 *   after — which also sees a crash when there was no worker beforehand, where
 *   comparing Worker objects compared undefined with undefined.
 * - **Silence, not duration.** A request is given up when the worker has sent
 *   nothing at all for the timeout, and any message restarts every request's
 *   wait. A worker that reports progress, as the usage worker does through a
 *   long first import, is never cut off for being slow, and a request queued
 *   behind another is not timed out by the other's length.
 */

import { Worker } from 'worker_threads';
import type * as vscode from 'vscode';

/** Give up rather than leaking a promise if the worker goes silent this long. */
const SILENCE_TIMEOUT_MS = 120_000;

/** Worker deaths within CRASH_WINDOW_MS after which the worker is not restarted. */
const MAX_WORKER_CRASHES = 3;
const CRASH_WINDOW_MS = 60_000;

/** Raised when the worker cannot answer: dead, disposed, refusing to restart, or silent. */
export class WorkerHostError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'WorkerHostError';
    }
}

export interface WorkerHostOptions {
    /** What messages call it, lowercase: "tokenizer" gives "The tokenizer worker…". */
    name: string;
    /** What its caller does instead while the worker is not restarted. */
    fallback: string;
    log: Pick<vscode.LogOutputChannel, 'error' | 'warn'>;
    /**
     * Runs once a worker has died, before its pending requests are rejected,
     * for the caller to forget what the dead worker held.
     */
    onExit?: () => void;
    /** Injectable so a test can let the crash window run out without waiting. */
    now?: () => number;
    /** Passed to each Worker: caps its V8 heap, not its native memory. */
    resourceLimits?: { maxOldGenerationSizeMb?: number };
    /** How long the worker may send nothing while a request waits; tests shorten it. */
    silenceTimeoutMs?: number;
}

interface Pending<Response> {
    resolve(value: Response): void;
    reject(error: Error): void;
    /** The worker sent something: start the wait again. */
    heard(): void;
}

export class WorkerHost<Request extends { id: number }, Response extends { id: number }> {
    private worker: Worker | undefined;
    private nextId = 0;
    private readonly pending = new Map<number, Pending<Response>>();
    private disposed = false;
    /** When the worker died, oldest first, on `now`. */
    private readonly crashTimes: number[] = [];
    private crashEpoch = 0;
    private readonly now: () => number;

    constructor(
        private readonly workerPath: string,
        private readonly options: WorkerHostOptions,
    ) {
        this.now = options.now ?? (() => performance.now());
    }

    /** Bumped on every worker death; see the module comment. */
    public get epoch(): number {
        return this.crashEpoch;
    }

    /** True while the worker has died too often to be restarted yet. */
    public get backingOff(): boolean {
        return this.recentCrashes() >= MAX_WORKER_CRASHES;
    }

    public dispose(): void {
        this.disposed = true;
        this.stop();
    }

    /**
     * End the current worker, as dispose does, but leave the host usable: the
     * next request starts a new worker. For a caller that lets an idle worker
     * go. Not a crash, so it never counts against the budget.
     */
    public stop(): void {
        this.failAllPending(new WorkerHostError(`The ${this.options.name} was shut down`));
        void this.worker?.terminate();
        this.worker = undefined;
    }

    /** Whether a worker is running now. */
    public get running(): boolean {
        return this.worker !== undefined;
    }

    /**
     * Post `request`, its `id` replaced by a fresh one, and resolve with the
     * response that carries that id.
     *
     * Throws synchronously, rather than rejecting, when no worker can be
     * started; callers await it inside a try either way.
     */
    public send(request: Request): Promise<Response> {
        const worker = this.ensureWorker();
        const id = ++this.nextId;

        return new Promise<Response>((resolve, reject) => {
            let timer: NodeJS.Timeout | undefined;
            const wait = () => {
                clearTimeout(timer);
                timer = setTimeout(() => {
                    this.pending.delete(id);
                    reject(new WorkerHostError(`The ${this.options.name} did not respond in time`));
                }, this.options.silenceTimeoutMs ?? SILENCE_TIMEOUT_MS);
            };
            wait();

            this.pending.set(id, {
                resolve: response => {
                    clearTimeout(timer);
                    resolve(response);
                },
                reject: error => {
                    clearTimeout(timer);
                    reject(error);
                },
                heard: wait,
            });

            worker.postMessage({ ...request, id });
        });
    }

    /**
     * The worker is started on first use and restarted if it dies, so a crash
     * degrades one request instead of disabling the feature until reload.
     */
    private ensureWorker(): Worker {
        if (this.worker) {
            return this.worker;
        }
        if (this.disposed) {
            throw new WorkerHostError(`The ${this.options.name} has been disposed`);
        }
        if (this.backingOff) {
            throw new WorkerHostError(
                `The ${this.options.name} worker keeps failing; ${this.options.fallback} for now`,
            );
        }

        const worker = new Worker(this.workerPath, { resourceLimits: this.options.resourceLimits });
        worker.on('message', (response: Response) => {
            const pending = this.pending.get(response.id);
            if (pending) {
                this.pending.delete(response.id);
                pending.resolve(response);
            }
            // Any message, a progress one included, shows the worker alive.
            for (const waiting of this.pending.values()) {
                waiting.heard();
            }
        });
        worker.on('error', (error: unknown) => {
            if (this.worker !== worker) {
                return;
            }
            this.options.log.error(`${capitalised(this.options.name)} worker crashed: ${describe(error)}`);
            this.handleWorkerExit(toError(error));
        });
        worker.on('exit', code => {
            if (this.worker !== worker || code === 0 || this.disposed) {
                return;
            }
            this.handleWorkerExit(new WorkerHostError(`worker exited with code ${code}`));
        });

        this.worker = worker;
        return worker;
    }

    private handleWorkerExit(error: Error): void {
        this.crashEpoch++;
        this.worker = undefined;
        this.options.onExit?.();
        this.failAllPending(error);

        this.crashTimes.push(this.now());
        if (this.recentCrashes() === MAX_WORKER_CRASHES) {
            this.options.log.warn(
                `The ${this.options.name} worker failed ${MAX_WORKER_CRASHES} times within a minute; ` +
                `${this.options.fallback} until it can be restarted`,
            );
        }
    }

    /** Worker deaths within the last CRASH_WINDOW_MS. */
    private recentCrashes(): number {
        const cutoff = this.now() - CRASH_WINDOW_MS;
        while (this.crashTimes.length > 0 && this.crashTimes[0] <= cutoff) {
            this.crashTimes.shift();
        }
        return this.crashTimes.length;
    }

    private failAllPending(error: Error): void {
        for (const pending of this.pending.values()) {
            pending.reject(error);
        }
        this.pending.clear();
    }
}

function capitalised(text: string): string {
    return text.charAt(0).toUpperCase() + text.slice(1);
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}
