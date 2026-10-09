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
 * whose `pidDomain` is this platform's must still have a running process, or
 * have been updated in the last RECENT_MS: a pid from another PID namespace,
 * as a Flatpak editor sees a host terminal's or a container's, names no
 * process here even while it runs. Under another domain, the pid means
 * nothing here, and the file is taken at its word.
 */

import { promises as fs } from 'fs';
import * as path from 'path';

/** A running session, as much of it as is read. */
export interface LiveSession {
    sessionId: string;
    cwd: string;
    status: string | null;
    /** Epoch milliseconds, as Claude Code writes it. */
    updatedAt: number | null;
}

/** Real files are a few hundred bytes. */
const MAX_FILE_BYTES = 64 << 10;
/** A session updated this recently is taken as running, whatever its pid says here. */
export const RECENT_MS = 15 * 60_000;
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
    if (!sessionId || !cwd || !path.isAbsolute(cwd)) {
        return undefined;
    }
    const updatedAt = typeof r.updatedAt === 'number' && Number.isSafeInteger(r.updatedAt) ? r.updatedAt : null;
    const recent = updatedAt !== null && now - updatedAt <= RECENT_MS;
    if (r.pidDomain === platform && typeof r.pid === 'number' && Number.isSafeInteger(r.pid) && r.pid > 0 && !recent && !isAlive(r.pid)) {
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
                const stat = await fs.lstat(file);
                if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
                    continue;
                }
                const session = parseLiveSession(await fs.readFile(file, 'utf8'), isAlive, platform, now);
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
