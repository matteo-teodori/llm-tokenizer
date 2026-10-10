/**
 * Which file holds the history, and which files beside it are copies.
 *
 * A history's file is never renamed, and its name is never given to another
 * history. SQLite deletes a file's `-wal` and `-shm` by name when its last
 * connection closes: a window that still held a history another window had
 * moved aside, or one deleted under it, would otherwise have deleted the new
 * history's journal files along with its own, losing what they held. Each
 * history is therefore started as `usage-<id>.sqlite`, with an id no history
 * has had before, and `usage.current` names the one in use. `usage.sqlite`,
 * the one name used before, stays in use while there is no pointer.
 *
 * A new history is named only once it is ready: its file is created, opened
 * and marked first, so that a window following the pointer never finds it
 * missing or half made. The first pointer is made as a link, which fails if
 * another window made one first, and that window's history is used instead.
 * A pointer is replaced only while it still names what the window replacing
 * it found.
 *
 * Only absence is taken for absence. A pointer that cannot be read for any
 * other reason fails the request and changes nothing: starting a new history
 * then would leave the old one, the only copy of records Claude Code has
 * since deleted, where no window looks. A pointer this version cannot read
 * as a name is never replaced, and one whose history is gone is followed no
 * further: the newest history there is used, and a new one started only when
 * there is none. Nothing but a regular file is opened as a history: not a
 * link, which could lead out of the folder, nor a folder or a FIFO.
 *
 * Only the worker reads these: the extension names the folder.
 */

import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/** The name of the history in use, in the folder of the histories. */
const POINTER = 'usage.current';
/** The history's name before the pointer. */
const LEGACY = 'usage.sqlite';
/** What a pointer may name: a history of this layout, or the legacy one. */
const NAMED = /^usage(-[0-9a-z]{8,40})?\.sqlite$/;
/** A history this version started: the time it was started, in base 36, then 12 random hex digits. */
const STARTED = /^usage-([0-9a-z]{8,9})([0-9a-f]{12})\.sqlite$/;
/** A history's file, its journals and backups, and the copies earlier builds set aside. */
const HISTORY_FILE = /^usage(-[0-9a-z]+)?\.sqlite(-wal|-shm|-journal|\.bak-v.+|\.corrupt-.+)?$/;
/** A history's own files: the history, and SQLite's journals beside it. */
const OWN_SUFFIXES = ['', '-wal', '-shm', '-journal'];
/** A pointer holds one name; a larger file holds something else. */
const MAX_POINTER_BYTES = 256;

/** The history's files could not be told apart for a reason other than their absence. */
export class HistoryFileError extends Error {
    constructor(readonly code: string | undefined) {
        super(`the usage history's files could not be read (${code ?? 'unknown'})`);
        this.name = 'HistoryFileError';
    }
}

/**
 * What the pointer says: nothing, a history's name, or something this
 * version cannot read as one, which it never replaces.
 */
export type Pointer = { kind: 'absent' } | { kind: 'name'; name: string } | { kind: 'unknown' };

export interface History {
    /** The history in use; undefined when there is none, and one is to be started. */
    file: string | undefined;
    /** The pointer as it was read: what a history started now replaces. */
    pointer: Pointer;
}

/**
 * The history in use in `folder`: the one the pointer names, or with no
 * pointer the legacy one; failing those, the newest history there.
 *
 * @throws HistoryFileError for anything but absence: the request fails.
 */
export function resolveHistory(folder: string): History {
    const pointer = readPointer(folder);
    if (pointer.kind === 'name' && isHistory(path.join(folder, pointer.name))) {
        return { file: path.join(folder, pointer.name), pointer };
    }
    if (pointer.kind === 'absent' && isHistory(path.join(folder, LEGACY))) {
        return { file: path.join(folder, LEGACY), pointer };
    }
    return { file: newestHistory(folder), pointer };
}

/** The history in use in `folder`, or undefined when there is none. */
export function currentHistory(folder: string): string | undefined {
    return resolveHistory(folder).file;
}

/** A new, empty history file under a name no history has had: no window uses it until it is published. */
export function createHistory(folder: string): string {
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, `usage-${Date.now().toString(36)}${randomBytes(6).toString('hex')}.sqlite`);
    // Exclusive: nothing already there is taken for it.
    fs.closeSync(fs.openSync(file, 'wx'));
    return file;
}

/**
 * Point every window at `file`, in place of `over`, the pointer as it was
 * read before `file` was started.
 *
 * @returns the history in use afterwards: `file`, or the one another window
 * published first, which is then used instead.
 */
export function publishHistory(folder: string, file: string, over: Pointer): string {
    if (over.kind === 'unknown') {
        // Never replaced: the newest history is the one in use, and that is this one.
        return file;
    }
    const pointer = path.join(folder, POINTER);
    const written = `${pointer}.${randomBytes(6).toString('hex')}`;
    const fd = fs.openSync(written, 'wx');
    try {
        fs.writeSync(fd, path.basename(file));
        // On disk before it is named: a crash must not leave a pointer with nothing in it.
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    try {
        return publishOver(folder, file, over, written, pointer);
    } finally {
        fs.rmSync(written, { force: true });
    }
}

function publishOver(folder: string, file: string, over: Exclude<Pointer, { kind: 'unknown' }>, written: string, pointer: string): string {
    if (over.kind === 'absent') {
        try {
            fs.linkSync(written, pointer);
            return file;
        } catch (error) {
            if (codeOf(error) !== 'EEXIST') {
                // No links on this file system: replaced as any pointer is,
                // and a window that started one at the same moment follows
                // the last at its next request.
                renameRetrying(written, pointer);
                return file;
            }
        }
        return published(folder, file);
    }
    const now = readPointer(folder);
    if (now.kind === 'absent') {
        return publishOver(folder, file, now, written, pointer);
    }
    if (now.kind === 'name' && now.name === over.name) {
        renameRetrying(written, pointer);
        return file;
    }
    return published(folder, file);
}

/** The history another window just published, or `file` while the pointer names none there. */
function published(folder: string, file: string): string {
    const pointer = readPointer(folder);
    return pointer.kind === 'name' && isHistory(path.join(folder, pointer.name)) ? path.join(folder, pointer.name) : file;
}

/** Remove a history no window was pointed at, its journals with it; best effort. */
export function removeHistory(file: string): void {
    for (const suffix of OWN_SUFFIXES) {
        try {
            fs.rmSync(`${file}${suffix}`, { force: true });
        } catch {
            // Opened meanwhile by a window that took it for the newest: a copy, which Clear removes.
        }
    }
}

/** The names of a history's own files: the history, and SQLite's journals beside it. */
export function ownFiles(history: string): string[] {
    return OWN_SUFFIXES.map(suffix => `${path.basename(history)}${suffix}`);
}

/** The history files in `current`'s folder that are not `current`'s own: what Clear removes. */
export function copiesBeside(current: string): string[] {
    const own = new Set(ownFiles(current));
    try {
        return fs.readdirSync(path.dirname(current)).filter(name => HISTORY_FILE.test(name) && !own.has(name));
    } catch {
        return [];
    }
}

/**
 * The pointer, read as the other small files are: never a link or anything
 * but a small regular file, opened without blocking, checked and read
 * through the descriptor.
 */
function readPointer(folder: string): Pointer {
    const file = path.join(folder, POINTER);
    let stat: fs.Stats;
    try {
        // Windows has no O_NOFOLLOW: the link itself is refused first.
        stat = retrying(() => fs.lstatSync(file));
    } catch (error) {
        if (absent(error)) {
            return { kind: 'absent' };
        }
        throw new HistoryFileError(codeOf(error));
    }
    if (!stat.isFile() || stat.size > MAX_POINTER_BYTES) {
        return { kind: 'unknown' };
    }
    let fd: number;
    try {
        fd = retrying(() => fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0) | (fs.constants.O_NOFOLLOW ?? 0)));
    } catch (error) {
        if (absent(error)) {
            return { kind: 'absent' };
        }
        // Swapped for a link or a folder since the check.
        if (codeOf(error) === 'ELOOP' || codeOf(error) === 'EISDIR') {
            return { kind: 'unknown' };
        }
        throw new HistoryFileError(codeOf(error));
    }
    try {
        const opened = fs.fstatSync(fd);
        if (!opened.isFile() || opened.size > MAX_POINTER_BYTES) {
            return { kind: 'unknown' };
        }
        const bytes = Buffer.alloc(opened.size);
        const read = fs.readSync(fd, bytes, 0, opened.size, 0);
        const name = bytes.subarray(0, read).toString('utf8').trim();
        return NAMED.test(name) ? { kind: 'name', name } : { kind: 'unknown' };
    } catch (error) {
        throw new HistoryFileError(codeOf(error));
    } finally {
        fs.closeSync(fd);
    }
}

/** Whether a history is at `file`: false when nothing is, or something that is not a regular file. */
function isHistory(file: string): boolean {
    try {
        return retrying(() => fs.lstatSync(file)).isFile();
    } catch (error) {
        if (absent(error)) {
            return false;
        }
        throw new HistoryFileError(codeOf(error));
    }
}

/**
 * The history this version started last in `folder`, or undefined when
 * there is none. Only names it gives, and none dated after this clock: a
 * history under a later name, corrupt, would otherwise stay the newest
 * whatever was started after it, and a new one would be started at every
 * request.
 */
function newestHistory(folder: string): string | undefined {
    let names: string[];
    try {
        names = fs.readdirSync(folder);
    } catch (error) {
        if (absent(error)) {
            return undefined;
        }
        throw new HistoryFileError(codeOf(error));
    }
    const now = Date.now();
    return names
        .flatMap(name => {
            const id = STARTED.exec(name);
            const started = id ? parseInt(id[1], 36) : NaN;
            return id && started <= now ? [{ name, started, random: id[2] }] : [];
        })
        // The latest first; the random part settles a tie.
        .sort((a, b) => b.started - a.started || (a.random < b.random ? 1 : a.random > b.random ? -1 : 0))
        .map(h => path.join(folder, h.name))
        .find(isHistory);
}

/**
 * Windows refuses, for a moment, to open or replace a file another window
 * has open or is replacing: tried again a few times before it counts.
 */
function retrying<T>(work: () => T): T {
    for (let attempt = 1; ; attempt++) {
        try {
            return work();
        } catch (error) {
            const code = codeOf(error);
            if (process.platform !== 'win32' || attempt >= 8 || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) {
                throw error;
            }
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * attempt);
        }
    }
}

function renameRetrying(from: string, to: string): void {
    retrying(() => fs.renameSync(from, to));
}

function absent(error: unknown): boolean {
    const code = codeOf(error);
    return code === 'ENOENT' || code === 'ENOTDIR';
}

function codeOf(error: unknown): string | undefined {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return typeof code === 'string' ? code : undefined;
}
