/**
 * Claude Code's running sessions, from `<root>/sessions/<pid>.json`: one
 * small file per running session (documented as a file, not as a schema).
 *
 * The file is parsed whole, but only `sessionId`, `cwd`, `status`,
 * `updatedAt`, `pid` and `pidDomain` are used; nothing else in it is kept,
 * logged or posted. Measured on Claude Code 2.1.295 it also names a messaging
 * socket, and `.key` files sit beside it: neither is ever opened. Sessions are never ordered by file time, which a sync rewrites
 * for every file; `updatedAt` is the session's own.
 *
 * A file can outlive its session when Claude Code is killed, so a session
 * whose `pidDomain` is this platform's must still have a running process. On
 * Linux, one updated in the last RECENT_MS counts too: a pid from another PID
 * namespace, as a Flatpak editor sees a host terminal's or a container's,
 * names no process here even while it runs. Under another domain the pid
 * means nothing here, so only a recent update says the session runs. An
 * update time further ahead of this clock than CLOCK_SKEW_MS is no evidence
 * of anything, and ranks the session nowhere: it is taken as unknown.
 *
 * A session id is taken only in the form the worker accepts, so a file with
 * any other cannot make every look fail.
 */

import { constants as fsConstants, promises as fs } from 'fs';
import * as path from 'path';

import { SESSION_ID } from './protocol';

/** A running session, as much of it as is read. */
export interface LiveSession {
    sessionId: string;
    cwd: string;
    status: string | null;
    /** Epoch milliseconds, as Claude Code writes it; null when there is none, or none to believe. */
    updatedAt: number | null;
}

/** Real files are a few hundred bytes. */
const MAX_FILE_BYTES = 64 << 10;
/** A session updated this recently is taken as running where its pid cannot be checked. */
export const RECENT_MS = 15 * 60_000;
/** How far ahead of this clock an update time may be: another machine's clock, or this one set back. */
export const CLOCK_SKEW_MS = 5 * 60_000;
const FILE_NAME = /^\d{1,10}\.json$/;

/** One `<pid>.json`, or undefined when it is not a live session's. */
export function parseLiveSession(
    text: string,
    isAlive: (pid: number) => boolean,
    platform: NodeJS.Platform,
    now: number,
): LiveSession | undefined {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        return undefined;
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        return undefined;
    }
    const r = raw as Record<string, unknown>;
    const sessionId = bounded(r.sessionId, 200);
    const cwd = bounded(r.cwd, 4096);
    if (!sessionId || !SESSION_ID.test(sessionId) || !cwd || !path.isAbsolute(cwd)) {
        return undefined;
    }
    // A time past the clocks' skew is no time at all: a leftover file dated
    // far ahead would otherwise count as recent, and rank above the running
    // session for good.
    const updatedAt =
        typeof r.updatedAt === 'number' && Number.isSafeInteger(r.updatedAt) && r.updatedAt <= now + CLOCK_SKEW_MS ? r.updatedAt : null;
    const recent = updatedAt !== null && now - updatedAt <= RECENT_MS;
    const localPid = r.pidDomain === platform && typeof r.pid === 'number' && Number.isSafeInteger(r.pid) && r.pid > 0 ? r.pid : undefined;
    const running = localPid !== undefined ? isAlive(localPid) || (platform === 'linux' && recent) : recent;
    if (!running) {
        return undefined;
    }
    return { sessionId, cwd, status: bounded(r.status, 40), updatedAt };
}

/** Every live session under `roots`, newest first by its own `updatedAt`. */
export async function readLiveSessions(
    roots: readonly string[],
    options: { isAlive?: (pid: number) => boolean; platform?: NodeJS.Platform; now?: number } = {},
): Promise<LiveSession[]> {
    const isAlive = options.isAlive ?? processAlive;
    const platform = options.platform ?? process.platform;
    const now = options.now ?? Date.now();
    const sessions = new Map<string, LiveSession>();
    for (const root of roots) {
        const dir = path.join(root, 'sessions');
        let names: string[];
        try {
            names = await fs.readdir(dir);
        } catch {
            continue;
        }
        for (const name of names.filter(n => FILE_NAME.test(n))) {
            const file = path.join(dir, name);
            try {
                const text = await readSmallFile(file);
                if (text === undefined) {
                    continue;
                }
                const session = parseLiveSession(text, isAlive, platform, now);
                const known = session && sessions.get(session.sessionId);
                if (session && (!known || (session.updatedAt ?? 0) > (known.updatedAt ?? 0))) {
                    sessions.set(session.sessionId, session);
                }
            } catch {
                // Gone between the listing and the read: a session that ended.
            }
        }
    }
    return [...sessions.values()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

/**
 * A regular file's text, up to MAX_FILE_BYTES, or undefined. Opened without
 * blocking and without following a link, then checked and read through the
 * descriptor: a FIFO swapped in after a check would otherwise hold a thread
 * of the extension host's pool, and the status item with it, for good.
 */
async function readSmallFile(file: string): Promise<string | undefined> {
    // Windows has no O_NOFOLLOW: the link itself is refused first.
    if (!(await fs.lstat(file)).isFile()) {
        return undefined;
    }
    const handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0) | (fsConstants.O_NOFOLLOW ?? 0));
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
            return undefined;
        }
        const bytes = Buffer.alloc(stat.size);
        const { bytesRead } = await handle.read(bytes, 0, stat.size, 0);
        return bytes.subarray(0, bytesRead).toString('utf8');
    } finally {
        await handle.close();
    }
}

function bounded(value: unknown, max: number): string | null {
    return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}

/** Signal 0 checks that the process exists, and sends nothing. */
function processAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
}
