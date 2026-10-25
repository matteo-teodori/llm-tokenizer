/**
 * Claude Code usage, on or off: the one owner of the usage worker, its timers
 * and its watchers, which the panel and the status item use.
 *
 * Loaded by onDemand.ts, which registers the commands and the settings
 * listener. Off, it touches nothing: no file, no worker, no watcher, no
 * timer. On, it imports once
 * the startup project scan has settled or after 30 s, whichever is first, and
 * never in the activation tick; then hourly, on the Refresh command, and, while
 * the panel or the status item holds it, on watcher hints. The import is the
 * reconcile: an unchanged file costs the worker one stat, so a hint only says
 * when to look, and the hourly pass keeps the history whole even when every
 * hint was missed.
 *
 * Hourly whatever is shown, because Claude Code deletes its records after
 * `cleanupPeriodDays`: a history only updated while the panel is open would
 * lose whatever was written in a month it stayed closed.
 *
 * A pass or a look that fails for a reason that clears by itself (another
 * window busy with the history, a file refused for a moment, a worker that
 * died or went silent) is tried again after 5 s, 30 s, 2 and 10 minutes,
 * then by the hourly pass, and shows as failing only once a retry has failed
 * too. A pass that takes longer than a second is told to the page while it
 * reads, so that what it has read so far never passes for the whole history.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { WorkerHost, WorkerHostError } from '../workerHost';
import { localMinute } from './aggregate';
import type { ImportSummary } from './importer';
import { readLiveSessions } from './liveSessions';
import { UsagePanel, openUsageSettings, savedZone } from './panel';
import type { ImportProgress, UsageWorkerRequest, UsageWorkerResponse } from './protocol';
import type { RangeKey, UsageReport } from './report';
import type { LatestRequest } from './store';
import type { Compaction } from './types';
import { machineRootInputs, resolveRoots, type ResolvedRoots, type RootInputs } from './roots';
import { CONFIG_SECTION } from './settings';
import { UsageStatusItem } from './statusItem';


/** The first import waits at most this long for the startup project scan. */
export const FIRST_IMPORT_MAX_WAIT_MS = 30_000;
export const HOURLY_MS = 60 * 60 * 1000;
/** An idle worker is let go after this long with nothing holding the service. */
export const IDLE_MS = 10 * 60 * 1000;
/** Watcher hints are coalesced over this long, and never deferred past the ceiling. */
export const HINT_DEBOUNCE_MS = 1_000;
export const HINT_CEILING_MS = 10_000;
/** Past this many changed files, one full pass is cheaper than naming each. */
export const MAX_HINT_PATHS = 200;
/** A pass refused because another window holds the import lease is tried again after this. */
export const LEASE_RETRY_MS = 5_000;
/**
 * A pass or a look that failed for a reason that clears by itself is tried
 * again after each of these in turn; past the last, a pass is tried again by
 * the hourly one.
 */
export const RETRY_MS = [5_000, 30_000, 2 * 60_000, 10 * 60_000] as const;
/**
 * A pass shorter than this says nothing of its reading: a hint's pass, or a
 * full one over unchanged files, is over before the page could say so, and
 * saying it would only flicker.
 */
export const READING_SHOWN_MS = 1_000;
/** While a pass's reading is shown, what it has read so far is shown this often. */
export const READING_UPDATE_MS = 2_000;
/** A worker asked to close its history is ended after this, answered or not. */
export const CLOSE_GRACE_MS = 2_000;

export type UsageStatus = 'off' | 'ready' | 'no-roots' | 'no-sqlite' | 'read-only' | 'failing';

/**
 * The history being read while the page shows it: by this window, with how
 * far its pass has gone where the worker said, or by another window, whose
 * progress is not known here. Until it is done, every total is a lower bound.
 */
export type Reading = ({ by: 'this window' } & Partial<ImportProgress>) | { by: 'another window' };

/**
 * A request with no answer, logged and given its status already;
 * `transient` when the reason clears by itself, so trying again is worth it.
 */
interface Unanswered {
    type: 'unanswered';
    transient: boolean;
}

/**
 * What a Clear left to finish. `settled`: false while another window's read
 * keeps what it deleted in the file; `copiesLeft`: copies not removed yet.
 */
export interface ClearOutcome {
    settled: boolean;
    copiesLeft: number;
}

export interface UsageSettings {
    enabled: boolean;
    dataDirectory: string;
    /** The user-level `claudeCode.environmentVariables`; only its CLAUDE_CONFIG_DIR is kept. */
    editorEnvironment: unknown;
}

/**
 * The settings as the editor holds them. Claude Code's environmentVariables
 * is taken at the user level only: get() returned a cloned repository's
 * workspace value where Claude Code is not installed, and a repository must
 * not choose which folder is read.
 *
 * get() returns a value as settings.json has it, of whatever type: only
 * `true` turns the feature on, since "false" written as a string is no
 * consent, and a data folder that is no string reads as unset.
 */
export function readUsageSettings(configuration: (section: string) => Pick<vscode.WorkspaceConfiguration, 'get' | 'inspect'>): UsageSettings {
    const config = configuration(CONFIG_SECTION);
    const dataDirectory = config.get<unknown>('claudeCodeDataDirectory');
    return {
        enabled: config.get<unknown>('enableClaudeCodeUsage') === true,
        dataDirectory: typeof dataDirectory === 'string' ? dataDirectory : '',
        editorEnvironment: configuration('claudeCode').inspect('environmentVariables')?.globalValue,
    };
}

/** Whether the status item is shown: the feature and the item both set to `true`, as readUsageSettings reads the one. */
export function statusItemShown(config: Pick<vscode.WorkspaceConfiguration, 'get'>): boolean {
    return config.get<unknown>('enableClaudeCodeUsage') === true && config.get<unknown>('showClaudeCodeUsageInStatusBar') === true;
}

/** What the service needs from the editor and the machine, injected so a test can fake each. */
export interface UsageServiceDeps {
    log: Pick<vscode.LogOutputChannel, 'info' | 'warn' | 'debug'>;
    storeFile: string;
    readSettings(): UsageSettings;
    /** Everything `resolveRoots` needs besides the two settings. */
    rootInputs(): Omit<RootInputs, 'setting' | 'editorEnvironment'>;
    /** `onCrash` runs when a worker dies on its own, never when it is stopped. */
    createHost(onCrash: () => void): UsageHost;
    /** Watch a `projects` folder for transcript changes; each event is only a hint, naming the file. */
    watch(projectsFolder: string, onHint: (file: string) => void): vscode.Disposable;
    startupSettled: Thenable<unknown>;
    clock?: Clock;
}

/** The part of WorkerHost the service uses. */
export type UsageHost = Pick<WorkerHost<UsageWorkerRequest, UsageWorkerResponse>, 'send' | 'stop' | 'dispose' | 'running'>;

export interface Clock {
    setTimeout(callback: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
    now(): number;
}

const realClock: Clock = {
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: handle => clearTimeout(handle as NodeJS.Timeout),
    now: () => Date.now(),
};

/** A request's own fields; the host assigns the id. */
type Ask = UsageWorkerRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never;

export class UsageService implements vscode.Disposable {
    private readonly changed = new vscode.EventEmitter<void>();
    /** Fired when the history or the status may have changed. */
    readonly onDidChange = this.changed.event;

    private readonly clock: Clock;
    private host: UsageHost | undefined;
    private enabled = false;
    private disposed = false;
    private currentStatus: UsageStatus = 'off';
    private summary: ImportSummary | undefined;
    private resolved: ResolvedRoots | undefined;
    private runtime: { node: string; electron: string | null } | undefined;

    /** Bumped on every start and stop, so a timer armed before either does nothing. */
    private generation = 0;
    private importing: Promise<ImportSummary | undefined> | undefined;
    /** The start the running pass belongs to. */
    private importingGeneration = -1;
    /** What the next pass must cover: named files, or everything. */
    private pending: Set<string> | 'all' | undefined;
    /** This window, as the holder of the import lease, whichever worker runs for it. */
    private readonly holder = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    /** Since another window was first found importing, and whether it still was a retry later. */
    private refused: { since: number; again: boolean } | undefined;
    private retryTimer: unknown;
    /** Whether `retryTimer` tries a failed pass again: watcher hints wait for it. */
    private retryingFailure = false;
    /** Failures in a row, of passes and of looks, for reasons that clear by themselves. */
    private readonly failures = { pass: 0, look: 0 };
    private lookTimer: unknown;
    /** When this window's pass began: while one runs, or while a long one that failed waits to be tried again. */
    private readingSince: number | undefined;
    /** How far that pass has gone, as the worker last said. */
    private progress: ImportProgress | undefined;
    private readingTimer: unknown;
    /** Whether the page was last told that the history is being read. */
    private readingShown = false;
    /** Whether a full pass has gone through since the feature started, or since the last Clear. */
    private readAll = false;
    /** A worker of this window crashed since the last import that went through. */
    private crashed = false;
    private recovered: string | undefined;
    private holders = 0;
    private watchers: vscode.Disposable[] = [];
    private startupGate: Promise<void> | undefined;
    private hourlyTimer: unknown;
    private idleTimer: unknown;
    private hintTimer: unknown;
    private hintDeadline = 0;
    private hinted = new Set<string>();
    private inFlight = 0;

    constructor(private readonly deps: UsageServiceDeps) {
        this.clock = deps.clock ?? realClock;
        if (deps.readSettings().enabled) {
            this.start();
        }
    }

    get status(): UsageStatus {
        return this.currentStatus;
    }

    /** The last import's summary in this window, for diagnostics. */
    get lastImport(): ImportSummary | undefined {
        return this.summary;
    }

    /** Every root considered at the last import, and where each came from. */
    get roots(): ResolvedRoots | undefined {
        return this.resolved;
    }

    /** The runtime that has no `node:sqlite`, when that is why nothing shows. */
    get missingSqlite(): { node: string; electron: string | null } | undefined {
        return this.runtime;
    }

    /** Whether the last pass found another window importing, and is waiting to try again. */
    get updatingElsewhere(): boolean {
        return this.refused !== undefined;
    }

    /** Whether a pass failed for a reason that clears by itself, and is to be tried again before it shows as failing. */
    get retrying(): boolean {
        return this.retryingFailure && this.currentStatus !== 'failing';
    }

    /** The history being read, while the page should say so; see `Reading`. */
    get reading(): Reading | undefined {
        if (!this.enabled) {
            return undefined;
        }
        if (this.readingSince !== undefined && this.clock.now() - this.readingSince >= READING_SHOWN_MS) {
            return { by: 'this window', ...this.progress };
        }
        // Refused once, the other window's pass can have been a hint's, over
        // at once; refused again a retry later, it is one that takes a while.
        return this.refused?.again ? { by: 'another window' } : undefined;
    }

    /** The name of a corrupt history set aside beside the one in use, until Clear removes it. */
    get recoveredFrom(): string | undefined {
        return this.recovered;
    }

    /**
     * Resolves once the startup project scan has settled, or 30 s after it
     * was first asked for: the first import waits for it, and so does the
     * status item's first look, so nothing is read in the activation tick.
     */
    whenStarted(): Promise<void> {
        if (!this.startupGate) {
            let timer: unknown;
            const ceiling = new Promise<void>(resolve => (timer = this.clock.setTimeout(resolve, FIRST_IMPORT_MAX_WAIT_MS)));
            const scan = Promise.resolve(this.deps.startupSettled).then(
                () => undefined,
                () => undefined,
            );
            this.startupGate = Promise.race([scan, ceiling]).then(() => this.clock.clearTimeout(timer));
        }
        return this.startupGate;
    }

    /** Re-read the settings: start, stop, or pick up a new data folder. */
    settingsChanged(): void {
        const enabled = this.deps.readSettings().enabled;
        if (enabled && !this.enabled) {
            this.start();
        } else if (!enabled && this.enabled) {
            this.stop();
        } else if (enabled) {
            // A data folder or Claude Code's own setting changed: watch the new
            // roots, and read them now.
            this.restartWatchers();
            void this.runImport();
        }
    }

    /** Import now, and resolve with the pass that started after this call. */
    refresh(): Promise<ImportSummary | undefined> {
        return this.enabled ? this.runImport() : Promise.resolve(undefined);
    }

    /**
     * Delete the history. Works while the feature is off, since the history
     * outlives the switch; records still on disk are read again by the next
     * import.
     *
     * @returns undefined when it could not be cleared; else what is left to
     * finish, which the next request of any window using the history does.
     */
    async clear(): Promise<ClearOutcome | undefined> {
        // Neither a pass nor a look: a Clear that fails says so itself, and leaves the status be.
        const response = await this.ask({ type: 'clear', storeFile: this.deps.storeFile });
        if (response.type !== 'cleared') {
            return undefined;
        }
        this.summary = undefined;
        // What is on disk is read again from the start: a first import.
        this.readAll = false;
        // Clear deleted the copy set aside along with the rest; one it could
        // not is named again by the next report.
        this.recovered = undefined;
        this.deps.log.info(`Claude Code usage history cleared (generation ${response.generation})`);
        if (!response.settled) {
            this.deps.log.info(
                'Claude Code usage: another window was reading the history, so what Clear deleted leaves the file once that read ends',
            );
        }
        if (response.copiesLeft > 0) {
            this.deps.log.warn(
                `Claude Code usage: ${response.copiesLeft} copies of the history could not be removed yet; one may be open in another window, and each is removed at a later request`,
            );
        }
        this.changed.fire();
        return { settled: response.settled, copiesLeft: response.copiesLeft };
    }

    /**
     * One session's live context: its main transcript brought up to date, then
     * its latest request and its compactions, newest first. Undefined while
     * off or failing.
     */
    async liveContext(sessionId: string): Promise<{ latest: LatestRequest | null; compactions: Compaction[] } | undefined> {
        if (!this.enabled) {
            return undefined;
        }
        const roots = (this.resolved ?? this.resolveNow()).roots.map(r => r.path);
        const response = await this.ask(
            {
                type: 'liveContext',
                storeFile: this.deps.storeFile,
                roots,
                sessionId,
                holder: this.holder,
                crashed: this.crashed,
            },
            'look',
        );
        // The crash flag is not spent here: this reads one session's file,
        // and the read a crash left unfinished is most likely another's.
        return response.type === 'liveContext' ? { latest: response.latest, compactions: response.compactions } : undefined;
    }

    /** The report for one range and scope, or undefined while off or failing. */
    async report(range: RangeKey, zone: string, workspaceFolders: string[] | null): Promise<UsageReport | undefined> {
        if (!this.enabled) {
            return undefined;
        }
        if (!this.readAll && this.readingSince !== undefined && !this.reading) {
            // No full pass has gone through here yet, as the feature starts
            // or after a Clear: the one under way may be a first import a few
            // files in, which is not to be shown as the whole history. Its
            // end, or its first second, when its reading shows, is waited for.
            await this.firstSecondOfPass();
            if (!this.enabled) {
                return undefined;
            }
        }
        // How many files the pass has is worth a walk of the roots only once
        // the page says how far it has gone.
        const progress = this.reading?.by === 'this window';
        const response = await this.ask(
            { type: 'query', storeFile: this.deps.storeFile, range, zone, workspaceFolders, ...(progress ? { progress } : {}) },
            'look',
        );
        if (response.type !== 'report') {
            return undefined;
        }
        if (this.readingSince !== undefined) {
            this.progress = response.reading;
        }
        return response.report;
    }

    /**
     * Keep the service attentive: watchers on, the worker resident. The panel
     * holds it while visible, the status item while shown.
     */
    hold(): vscode.Disposable {
        this.holders++;
        this.clock.clearTimeout(this.idleTimer);
        if (this.holders === 1 && this.enabled) {
            try {
                this.restartWatchers();
            } catch (error) {
                // A hold that threw holds nothing: counted, it would keep the
                // worker for good, and the next hold would watch nothing.
                this.holders--;
                this.stopWatchers();
                this.armIdle();
                throw error;
            }
        }
        let released = false;
        return new vscode.Disposable(() => {
            if (released) {
                return;
            }
            released = true;
            this.holders--;
            if (this.holders === 0) {
                this.stopWatchers();
                this.armIdle();
            }
        });
    }

    dispose(): void {
        this.disposed = true;
        this.stop();
        this.host = undefined;
        this.changed.dispose();
    }

    private start(): void {
        this.enabled = true;
        this.generation++;
        this.refused = undefined;
        this.setStatus('ready');
        if (this.holders > 0) {
            this.restartWatchers();
        }
        const generation = this.generation;
        void this.whenStarted().then(() => {
            if (generation === this.generation) {
                void this.runImport();
            }
        });
    }

    private stop(): void {
        this.enabled = false;
        this.generation++;
        this.pending = undefined;
        this.refused = undefined;
        // A start after this one starts afresh: its first failure is a first again.
        this.retryingFailure = false;
        this.failures.pass = 0;
        this.failures.look = 0;
        this.readingSince = undefined;
        this.progress = undefined;
        this.readingShown = false;
        this.readAll = false;
        this.stopWatchers();
        for (const timer of [this.hourlyTimer, this.idleTimer, this.hintTimer, this.retryTimer, this.lookTimer, this.readingTimer]) {
            this.clock.clearTimeout(timer);
        }
        // An import in flight stops at its next file, and every checkpoint it
        // committed is kept.
        void this.endWorker(this.generation);
        this.setStatus('off');
    }

    /**
     * Close the worker's history, then end the thread: a thread ended in the
     * middle of a SQLite call is ended mid-write. Ended all the same if it
     * has not answered within CLOSE_GRACE_MS, and left be if the feature was
     * turned on again meanwhile.
     */
    private async endWorker(generation: number): Promise<void> {
        const host = this.host;
        if (!host?.running) {
            if (this.disposed) {
                void host?.dispose();
            }
            return;
        }
        let timer: unknown;
        this.inFlight++;
        try {
            await Promise.race([
                host.send({ type: 'close', id: 0 }),
                new Promise<void>(resolve => (timer = this.clock.setTimeout(resolve, CLOSE_GRACE_MS))),
            ]);
        } catch {
            // Gone already.
        } finally {
            this.inFlight--;
            this.clock.clearTimeout(timer);
        }
        if (this.disposed) {
            void host.dispose();
        } else if (generation === this.generation && this.inFlight === 0) {
            void host.stop();
        }
        // Otherwise a request sent since, a Clear while off for one, is
        // answered first: the idle release ends the worker after it.
    }

    /**
     * Import `paths`, or everything when none are given. Calls during a pass
     * are merged into one more pass after it, which keeps named files named:
     * a hint during a full pass never becomes a second full pass.
     */
    private runImport(paths?: readonly string[]): Promise<ImportSummary | undefined> {
        this.want(paths);
        return this.drain();
    }

    /** Note what the next pass must cover: the named files, or everything. */
    private want(paths?: readonly string[]): void {
        if (!paths || this.pending === 'all') {
            this.pending = 'all';
            return;
        }
        this.pending ??= new Set();
        for (const p of paths) {
            this.pending.add(p);
        }
        if (this.pending.size > MAX_HINT_PATHS) {
            this.pending = 'all';
        }
    }

    /** Run passes, one at a time, until nothing is pending. */
    private drain(): Promise<ImportSummary | undefined> {
        if (this.importing) {
            // A pass of an earlier start, turned off and on again meanwhile,
            // ends without taking what this start wants: run after it.
            return this.importingGeneration === this.generation ? this.importing : this.importing.then(() => this.drain());
        }
        const generation = this.generation;
        const pass = async (): Promise<ImportSummary | undefined> => {
            let summary: ImportSummary | undefined;
            while (this.pending && generation === this.generation) {
                const take = this.pending;
                this.pending = undefined;
                const outcome = await this.importOnce(take === 'all' ? undefined : [...take], generation);
                // Hourly from the last full pass: a hint's pass covers only
                // its files, so it must not put the next full one off. Past
                // its retries, a failed pass is tried again by this one.
                if (take === 'all' && outcome !== 'held' && generation === this.generation && this.enabled) {
                    this.clock.clearTimeout(this.hourlyTimer);
                    this.hourlyTimer = this.clock.setTimeout(() => void this.runImport(), HOURLY_MS);
                }
                if (outcome === 'held' || outcome === 'failed') {
                    // Keep what this pass was for, and try again: once another
                    // window's pass is likely over, or, after a failure that
                    // clears by itself, later each time. (Only this start's
                    // answers come here; stop() clears the timer.)
                    this.want(take === 'all' ? undefined : [...take]);
                    this.clock.clearTimeout(this.retryTimer);
                    // Past the last retry, none: the hourly pass is the retry.
                    const after: number | undefined = outcome === 'held' ? LEASE_RETRY_MS : RETRY_MS[this.failures.pass - 1];
                    this.retryingFailure = outcome === 'failed' && after !== undefined;
                    if (after !== undefined) {
                        this.retryTimer = this.clock.setTimeout(() => {
                            this.retryingFailure = false;
                            void this.drain();
                        }, after);
                    }
                    // Nothing was read: no answer to a Refresh.
                    summary = undefined;
                    break;
                }
                this.retryingFailure = false;
                summary = outcome;
            }
            return summary;
        };
        this.importingGeneration = generation;
        this.importing = pass().finally(() => {
            this.importing = undefined;
        });
        return this.importing;
    }

    /** Where Claude Code writes, now, with the settings as they are. */
    private resolveNow(): ResolvedRoots {
        const settings = this.deps.readSettings();
        this.resolved = resolveRoots({
            ...this.deps.rootInputs(),
            setting: settings.dataDirectory,
            editorEnvironment: settings.editorEnvironment,
        });
        return this.resolved;
    }

    /**
     * One pass; 'held' when another window holds the import lease, 'failed'
     * when it failed for a reason that clears by itself. An answer that comes
     * after the feature was turned off, or off and on, belongs to a start
     * that is over, and changes nothing.
     */
    private async importOnce(paths: string[] | undefined, generation: number): Promise<ImportSummary | 'held' | 'failed' | undefined> {
        const resolved = this.resolveNow();
        for (const refused of resolved.refused) {
            this.deps.log.warn(`Claude Code usage: refused a root outside the test fixtures (${refused.source})`);
        }
        if (resolved.roots.length === 0) {
            if (this.currentStatus !== 'no-roots') {
                this.deps.log.info(`Claude Code usage: no Claude Code data folder found, of ${resolved.candidates.length} places looked at`);
                this.deps.log.debug(`Claude Code usage: looked at ${resolved.candidates.map(c => c.path).join(', ')}`);
            }
            this.stopReading();
            this.setStatus('no-roots');
            return undefined;
        }
        const roots = resolved.roots.map(r => r.path);
        this.deps.log.debug(`Claude Code usage: importing ${paths ? `${paths.length} changed files in ` : ''}${roots.join(', ')}`);
        // Begun now, or, for the retry of a pass whose reading was shown, when that one began.
        this.readingSince ??= this.clock.now();
        this.followReading();
        const response = await this.ask(
            {
                type: 'import',
                storeFile: this.deps.storeFile,
                roots,
                paths,
                holder: this.holder,
                crashed: this.crashed,
            },
            'pass',
        );
        if (generation !== this.generation) {
            return undefined;
        }
        if (response.type !== 'imported') {
            const retried = response.type === 'unanswered' && response.transient;
            // The page says this window's pass is reading, and the pass is
            // tried again in a few seconds: it goes on saying so, with no
            // count meanwhile. Shown as failing, it says that instead.
            const goesOn = retried && this.currentStatus !== 'failing' && this.reading?.by === 'this window';
            this.refused = undefined;
            if (goesOn) {
                this.progress = undefined;
                this.followReading();
            } else {
                this.stopReading();
            }
            return retried ? 'failed' : undefined;
        }
        if (response.leaseHeldElsewhere) {
            // Another window is importing into the same history; what it
            // writes shows here too.
            const now = this.clock.now();
            this.refused = this.refused
                ? { since: this.refused.since, again: this.refused.again || now - this.refused.since >= LEASE_RETRY_MS }
                : { since: now, again: false };
            this.setStatus(this.failingNow ? 'failing' : 'ready');
            if (!this.stopReading()) {
                this.changed.fire();
            }
            return 'held';
        }
        this.refused = undefined;
        // The page is told once that the reading is over: with what was read.
        const told = this.stopReading();
        const s = response.summary;
        // The crash has been accounted for once a pass has counted the read
        // it left unfinished, or has gone over every file without finding one.
        if (s.interrupted > 0 || (!paths && !s.cancelled)) {
            this.crashed = false;
        }
        this.readAll ||= !paths && !s.cancelled;
        this.summary = s;
        this.setStatus(this.failingNow ? 'failing' : 'ready');
        const skipped = Object.values(s.skipped).reduce((sum, n) => sum + (n ?? 0), 0);
        this.deps.log.info(
            `Claude Code usage: read ${s.read} of ${s.files} files in ${s.roots} ${s.roots === 1 ? 'root' : 'roots'}, ` +
                `${s.records} records, ${skipped} skipped, in ${s.elapsedMs} ms${s.cancelled ? ', cancelled' : ''}`,
        );
        if (s.read > 0 && !told) {
            this.changed.fire();
        }
        return s;
    }

    /**
     * One request to the worker; a failure becomes a status and a log line,
     * never a throw. A `kind` of request that fails for a reason that clears
     * by itself is tried again before it shows as failing: see `failedForNow`.
     */
    private async ask(request: Ask, kind?: 'pass' | 'look'): Promise<UsageWorkerResponse | Unanswered> {
        if (this.disposed) {
            return { type: 'unanswered', transient: false };
        }
        const generation = this.generation;
        this.host ??= this.deps.createHost(() => (this.crashed = true));
        this.clock.clearTimeout(this.idleTimer);
        this.inFlight++;
        try {
            const response = await this.host.send({ ...request, id: 0 });
            if ('recovered' in response && response.recovered) {
                this.recovered = response.recovered;
                this.deps.log.warn(
                    `Claude Code usage: the history could not be read, so it was set aside as ${response.recovered}, and a new one started`,
                );
                this.changed.fire();
            } else if (response.type === 'report' && response.aside !== this.recovered) {
                // What is beside the history now: told in every window, and
                // after a reload, until Clear removes it.
                this.recovered = response.aside;
                this.changed.fire();
            }
            switch (response.type) {
                case 'unavailable':
                    this.runtime = { node: response.node, electron: response.electron };
                    this.deps.log.warn(
                        `Claude Code usage needs node:sqlite, which this editor's runtime lacks (Node ${response.node})`,
                    );
                    this.statusWhileOn('no-sqlite');
                    return { type: 'unanswered', transient: false };
                case 'failed':
                    if (response.failure === 'store-read-only') {
                        this.deps.log.warn('Claude Code usage: the history was created by a newer LLM Tokenizer, so it is read-only here');
                        this.statusWhileOn('read-only');
                    } else if (response.failure === 'outdated') {
                        if (this.currentStatus !== 'read-only') {
                            this.deps.log.warn(
                                'Claude Code usage: a newer LLM Tokenizer, in another window, updates this history; reload this window to update it here',
                            );
                        }
                        this.statusWhileOn('read-only');
                    } else if (response.failure === 'bad-request') {
                        // A request the worker would not take says nothing
                        // about the history: the status stays as it is.
                        this.deps.log.warn(`Claude Code usage: a request was refused (${response.errorName})`);
                    } else {
                        // Busy, a file refused, an import that threw: none of them lasts.
                        return this.failedForNow(kind, generation, `${response.failure} (${failureDetail(response)})`);
                    }
                    return { type: 'unanswered', transient: false };
                default:
                    if (kind && generation === this.generation) {
                        this.wentThrough(kind);
                    }
                    return response;
            }
        } catch (error) {
            // The worker died, refused to restart, or went silent.
            if (!this.disposed && this.enabled) {
                return this.failedForNow(kind, generation, error instanceof WorkerHostError ? error.message : 'the worker failed');
            }
            return { type: 'unanswered', transient: false };
        } finally {
            this.inFlight--;
            this.armIdle();
        }
    }

    /**
     * A pass or a look that failed for a reason that clears by itself: it is
     * logged and tried again, a pass by `drain`, a look by telling the panel
     * and the status item to look again. Only a retry that fails too shows as
     * 'failing': shown at once, it would say the history could not be read
     * of something that settles in seconds. A Clear that fails so is only
     * logged: the Clear itself says it failed.
     */
    private failedForNow(kind: 'pass' | 'look' | undefined, generation: number, why: string): Unanswered {
        if (!kind || !this.enabled || generation !== this.generation) {
            this.deps.log.warn(`Claude Code usage: ${why}`);
            return { type: 'unanswered', transient: true };
        }
        const failures = ++this.failures[kind];
        const retry: number | undefined = RETRY_MS[failures - 1];
        this.deps.log.warn(
            `Claude Code usage: ${why}${retry !== undefined ? `; tried again in ${duration(retry)}` : kind === 'pass' ? '; tried again by the hourly pass' : ''}`,
        );
        if (kind === 'look') {
            this.clock.clearTimeout(this.lookTimer);
            if (retry !== undefined) {
                this.lookTimer = this.clock.setTimeout(() => this.changed.fire(), retry);
            }
        }
        if (failures >= 2) {
            this.setStatus('failing');
        }
        return { type: 'unanswered', transient: true };
    }

    /** A request of `kind` went through: its failures are over, and so is 'failing' if they were why. */
    private wentThrough(kind: 'pass' | 'look'): void {
        if (this.failures[kind] === 0) {
            return;
        }
        this.failures[kind] = 0;
        if (kind === 'look') {
            this.clock.clearTimeout(this.lookTimer);
        }
        if (this.currentStatus === 'failing' && !this.failingNow) {
            this.setStatus('ready');
        }
    }

    /** Whether a retry has failed too, of a pass or of a look: what 'failing' says. */
    private get failingNow(): boolean {
        return this.failures.pass >= 2 || this.failures.look >= 2;
    }

    /**
     * Keep the page told while the history is read: the moment that shows,
     * every READING_UPDATE_MS while it does, and once when it ends.
     *
     * @returns whether it told the page, by firing onDidChange.
     */
    private followReading(): boolean {
        this.clock.clearTimeout(this.readingTimer);
        const shown = this.reading !== undefined;
        const flipped = shown !== this.readingShown;
        this.readingShown = shown;
        if (shown) {
            this.readingTimer = this.clock.setTimeout(() => {
                this.changed.fire();
                this.followReading();
            }, READING_UPDATE_MS);
        } else if (this.readingSince !== undefined) {
            // Not a second along yet: looked at again once it would be.
            this.readingTimer = this.clock.setTimeout(() => void this.followReading(), this.readingSince + READING_SHOWN_MS - this.clock.now());
        }
        if (flipped) {
            this.changed.fire();
        }
        return flipped;
    }

    /** Until this window's passes are over, or the one under way is a second along, whichever is first. */
    private firstSecondOfPass(): Promise<void> {
        let timer: unknown;
        const since = this.readingSince ?? this.clock.now();
        return Promise.race([
            Promise.resolve(this.importing).then(
                () => undefined,
                () => undefined,
            ),
            new Promise<void>(resolve => (timer = this.clock.setTimeout(resolve, Math.max(0, since + READING_SHOWN_MS - this.clock.now())))),
        ]).finally(() => this.clock.clearTimeout(timer));
    }

    /** This window's pass is over, or never ran: the page stops saying it reads. */
    private stopReading(): boolean {
        this.readingSince = undefined;
        this.progress = undefined;
        return this.followReading();
    }

    /** A status from an answer: while off, the status stays 'off', whatever a Clear met. */
    private statusWhileOn(status: UsageStatus): void {
        if (this.enabled) {
            this.setStatus(status);
        }
    }

    /** Held only while on: off, a held service has nothing for a worker to do. */
    private get held(): boolean {
        return this.enabled && this.holders > 0;
    }

    /** Let an idle worker go: its history closed first, then the thread ended. */
    private armIdle(): void {
        this.clock.clearTimeout(this.idleTimer);
        if (!this.host?.running || this.held || this.inFlight > 0 || this.disposed) {
            return;
        }
        const after = this.enabled ? IDLE_MS : 0;
        this.idleTimer = this.clock.setTimeout(() => void this.release(), after);
    }

    private async release(): Promise<void> {
        const host = this.host;
        if (!host?.running || this.held || this.inFlight > 0 || this.importing) {
            return;
        }
        this.inFlight++;
        try {
            await host.send({ type: 'close', id: 0 });
        } catch {
            // Gone already.
        } finally {
            this.inFlight--;
        }
        if (!this.held && this.inFlight === 0 && !this.importing) {
            void host.stop();
        }
    }

    private restartWatchers(): void {
        this.stopWatchers();
        if (!this.enabled || this.holders === 0) {
            return;
        }
        this.watchers = this.resolveNow().roots.map(root => this.deps.watch(path.join(root.path, 'projects'), file => this.hint(file)));
    }

    private stopWatchers(): void {
        for (const watcher of this.watchers) {
            watcher.dispose();
        }
        this.watchers = [];
        this.clock.clearTimeout(this.hintTimer);
        this.hintDeadline = 0;
        this.hinted.clear();
    }

    /** A transcript changed: import it soon, coalescing a burst, never later than the ceiling. */
    private hint(file: string): void {
        if (!this.enabled) {
            return;
        }
        this.hinted.add(file);
        const now = this.clock.now();
        if (this.hintDeadline === 0) {
            this.hintDeadline = now + HINT_CEILING_MS;
        }
        this.clock.clearTimeout(this.hintTimer);
        const generation = this.generation;
        this.hintTimer = this.clock.setTimeout(
            () => {
                this.hintDeadline = 0;
                const files = [...this.hinted];
                this.hinted.clear();
                if (generation !== this.generation) {
                    return;
                }
                if (this.retryingFailure) {
                    // A pass failed and is tried again on its own schedule,
                    // with these: a hint each second would undo its backing off.
                    this.want(files);
                } else {
                    void this.runImport(files);
                }
            },
            Math.max(0, Math.min(HINT_DEBOUNCE_MS, this.hintDeadline - now)),
        );
    }

    private setStatus(status: UsageStatus): void {
        if (status !== this.currentStatus) {
            this.currentStatus = status;
            this.changed.fire();
        }
    }
}

/** A failure as the log gives it: the error's name, and SQLite's result code and text for it when SQLite raised it. */
function failureDetail(response: Extract<UsageWorkerResponse, { type: 'failed' }>): string {
    const sqlite = response.sqlite;
    return sqlite ? `${response.errorName}, SQLite ${sqlite.code}${sqlite.text ? `: ${sqlite.text}` : ''}` : response.errorName;
}

function duration(ms: number): string {
    return ms < 60_000 ? `${ms / 1000} s` : `${ms / 60_000} min`;
}

/** What the extension's loader asks of the feature once it is loaded. */
export interface UsageCommands {
    show(): void;
    refresh(): Promise<void>;
    clear(): Promise<void>;
    settingsChanged(): void;
}

/**
 * The service as the extension runs it, and the status item: the entry of
 * the feature's own bundle, which onDemand.ts loads. In the test host, roots
 * are confined to the fixtures; see `machineRootInputs`.
 */
export function startClaudeCodeUsage(
    context: vscode.ExtensionContext,
    log: vscode.LogOutputChannel,
    startupSettled: Thenable<unknown>,
): UsageCommands {
    const underTest = context.extensionMode === vscode.ExtensionMode.Test;
    const fixtures = path.join(context.extensionPath, 'test', 'fixtures');
    // Under test, a history of its own, emptied as each run starts: one that
    // a branch with a newer parser left in the test profile would refuse
    // this branch's imports.
    const usageFolder = path.join(context.globalStorageUri.fsPath, underTest ? 'claude-code-usage-test' : 'claude-code-usage');
    if (underTest) {
        fs.rmSync(usageFolder, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
    const service = new UsageService({
        log,
        storeFile: path.join(usageFolder, 'usage.sqlite'),
        readSettings: () => readUsageSettings(section => vscode.workspace.getConfiguration(section)),
        rootInputs: () => machineRootInputs(underTest ? { fixtures } : undefined),
        createHost: onCrash =>
            new WorkerHost<UsageWorkerRequest, UsageWorkerResponse>(path.join(context.extensionPath, 'out', 'usageWorker.js'), {
                name: 'Claude Code usage reader',
                fallback: 'usage is not updated',
                log,
                onExit: onCrash,
                resourceLimits: { maxOldGenerationSizeMb: 128 },
            }),
        watch: (projectsFolder, onHint) => {
            const watcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(vscode.Uri.file(projectsFolder), '**/*.jsonl'),
                false,
                false,
                true,
            );
            const named = (uri: vscode.Uri) => onHint(uri.fsPath);
            return vscode.Disposable.from(watcher, watcher.onDidCreate(named), watcher.onDidChange(named));
        },
        startupSettled,
    });

    const config = () => vscode.workspace.getConfiguration(CONFIG_SECTION);
    // The reader's zone, as the panel's page last reported it: in a remote
    // window, the extension host's can be another machine's.
    const zone = () => savedZone(context) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const statusItem = new UsageStatusItem(service, {
        shown: () => statusItemShown(config()),
        readLive: roots => readLiveSessions(roots),
        workspaceFolders: () => (vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file').map(f => f.uri.fsPath),
        platform: process.platform,
        zone,
        formatTime: ms => localMinute(ms, zone()),
        createItem: () => vscode.window.createStatusBarItem('llm-tokenizer.claudeCodeUsage', vscode.StatusBarAlignment.Right, 98),
    });

    context.subscriptions.push(service, statusItem);
    return {
        show: () => UsagePanel.show(context, service, log),
        refresh: () => refreshCommand(service),
        clear: () => clearCommand(service),
        settingsChanged: () => {
            service.settingsChanged();
            statusItem.settingsChanged();
        },
    };
}

async function refreshCommand(service: UsageService): Promise<void> {
    if (service.status === 'off') {
        const open = await vscode.window.showInformationMessage('Claude Code usage is off.', 'Open Settings');
        if (open) {
            await openUsageSettings();
        }
        return;
    }
    const said = refreshMessage(await service.refresh(), service);
    if (said?.kind === 'info') {
        void vscode.window.showInformationMessage(said.text);
    } else if (said) {
        void vscode.window.showWarningMessage(said.text);
    }
}

/** What Refresh says, from the pass it ran and the state that left; nothing when all is well and nothing was read. */
export function refreshMessage(
    summary: ImportSummary | undefined,
    state: { updatingElsewhere: boolean; status: UsageStatus; retrying: boolean },
): { kind: 'info' | 'warning'; text: string } | undefined {
    if (summary) {
        return { kind: 'info', text: `LLM Tokenizer: read ${summary.read} changed of ${summary.files} Claude Code transcripts.` };
    }
    if (state.updatingElsewhere) {
        return { kind: 'info', text: 'LLM Tokenizer: another window is updating the Claude Code usage history; this one shows it as it goes.' };
    }
    if (state.status === 'no-roots') {
        // The log says so once, when the folder goes; this says it every time.
        return { kind: 'warning', text: 'LLM Tokenizer: no Claude Code data folder was found. Show Claude Code Usage lists the places looked at.' };
    }
    if (state.retrying) {
        // A warning only once the retry has failed too.
        return { kind: 'info', text: 'LLM Tokenizer: Claude Code usage could not be refreshed just now; it is tried again in a few seconds.' };
    }
    if (state.status !== 'ready') {
        return { kind: 'warning', text: 'LLM Tokenizer: Claude Code usage could not be refreshed; see the log.' };
    }
    return undefined;
}

async function clearCommand(service: UsageService): Promise<void> {
    const choice = await vscode.window.showWarningMessage(
        'Clear the Claude Code usage history LLM Tokenizer keeps?',
        {
            modal: true,
            detail:
                "Claude Code's own records are not touched. Those still on disk are read again at the next refresh; anything older is gone for good.",
        },
        'Clear History',
    );
    if (choice !== 'Clear History') {
        return;
    }
    const cleared = await service.clear();
    if (!cleared) {
        void vscode.window.showWarningMessage('LLM Tokenizer: the history could not be cleared; see the log.');
    } else if (cleared.copiesLeft > 0) {
        void vscode.window.showWarningMessage(clearedMessage(cleared));
    } else {
        void vscode.window.showInformationMessage(clearedMessage(cleared));
    }
}

/** What a Clear tells: the copies it could not remove yet included, which stay readable until they are. */
export function clearedMessage(outcome: ClearOutcome): string {
    const n = outcome.copiesLeft;
    if (n === 0) {
        return 'LLM Tokenizer: Claude Code usage history cleared.';
    }
    const copies = n === 1 ? 'one copy of it' : `${n.toLocaleString('en-US')} copies of it`;
    return `LLM Tokenizer: Claude Code usage history cleared, but ${copies} could not be removed yet, perhaps because another window has ${n === 1 ? 'it' : 'them'} open. ${n === 1 ? 'It is' : 'They are'} removed as soon as ${n === 1 ? 'it' : 'they'} can be.`;
}
