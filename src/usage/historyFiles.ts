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
/** Held while the pointer is read, compared and replaced, so that only one window replaces it. */
const LOCK = 'usage.current.lock';
/** A lock older than this was left by a window that died holding it. */
const LOCK_STALE_MS = 5_000;
/** A pointer's temporary file: the pointer's name, a dot, and 12 random hex digits. */
const TEMPORARY = /^usage\.current\.[0-9a-f]{12}$/;
/** One older than this is no window's publish in flight, but one a refused removal left. */
const TEMPORARY_STALE_MS = 60_000;
/** How long Windows is given to let go of a file before its refusal counts. */
const RETRY_BUDGET_MS = 2_000;

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

/**
 * `history`, published first when no pointer names it: the newest history
 * found with no pointer may be another window's, started but not yet
 * published, which that window deletes if it loses the race to publish one.
 * Published through the same race, every window ends on the history the
 * pointer names. The legacy history is used as it is, as before the pointer.
 *
 * @throws as `publishHistory` does: the request fails, and nothing is opened.
 */
export function claimFound(folder: string, history: History): History {
    if (history.pointer.kind !== 'absent' || history.file === undefined || path.basename(history.file) === LEGACY) {
        return history;
    }
    const used = publishHistory(folder, history.file, history.pointer);
    return { file: used, pointer: { kind: 'name', name: path.basename(used) } };
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
export function publishHistory(folder: string, file: string, over: Pointer, options: { lockWaitMs?: number } = {}): string {
    if (over.kind === 'unknown') {
        // Never replaced: the newest history is the one in use, and that is this one.
        return file;
    }
    const pointer = path.join(folder, POINTER);
    sweepTemporaries(folder);
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
        return publishOver(folder, file, over, written, pointer, options.lockWaitMs ?? 3_000);
    } finally {
        // Tidying only: what the pointer names was decided above, and a
        // removal Windows refuses must not undo it. One left is swept later.
        removeQuietly(written);
    }
}

function publishOver(
    folder: string,
    file: string,
    over: Exclude<Pointer, { kind: 'unknown' }>,
    written: string,
    pointer: string,
    lockWaitMs: number,
): string {
    if (over.kind === 'absent') {
        try {
            // Refused for a moment on Windows, as a file just written can be:
            // tried again before it is taken for a file system without links.
            retrying(() => fs.linkSync(written, pointer));
            return file;
        } catch (error) {
            if (transient(error)) {
                // Refused past the budget: nothing is replaced, and the request fails.
                throw error;
            }
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
    // Read, compared and replaced as one step: two windows replacing it at
    // once both found the name they replace, and each kept its own history.
    return underLock(folder, lockWaitMs, held => {
        const now = readPointer(folder);
        if (now.kind === 'absent') {
            return publishOver(folder, file, now, written, pointer, lockWaitMs);
        }
        if (now.kind === 'name' && now.name === over.name) {
            // Taken over meanwhile by a window that found it stale: that
            // window replaces the pointer, never both.
            if (!held()) {
                throw new HistoryFileError('EBUSY');
            }
            renameRetrying(written, pointer);
            return file;
        }
        return published(folder, file);
    });
}

/**
 * Run `work` holding the pointer's lock, a file made exclusively. One left by
 * a window that died holding it is taken over once it is LOCK_STALE_MS old.
 *
 * @throws HistoryFileError when another window holds it past `waitMs`.
 */
function underLock<T>(folder: string, waitMs: number, work: (held: () => boolean) => T): T {
    const lock = path.join(folder, LOCK);
    const until = Date.now() + waitMs;
    /** The lock this window made, as it was made: whether it still holds it is whether that file is still there. */
    let mine: fs.BigIntStats;
    for (;;) {
        try {
            mine = made(lock);
            break;
        } catch (error) {
            // On Windows a lock another window has just let go of can still be
            // "delete pending" while any handle is open on it, and creating it
            // then fails with EPERM: it is held a moment longer, not a failure.
            if (codeOf(error) !== 'EEXIST' && !transient(error)) {
                throw error;
            }
        }
        let seen: fs.BigIntStats | undefined;
        try {
            // The lock itself, never what a link there leads to: one leading
            // nowhere would otherwise be looked at, and passed over, forever.
            seen = fs.lstatSync(lock, { bigint: true });
        } catch (error) {
            // Let go of meanwhile, or being let go of: looked at again below.
            if (!absent(error) && !transient(error)) {
                throw new HistoryFileError(codeOf(error));
            }
        }
        // Removed only while it is still the lock judged stale: another
        // window that judged it so too may have taken it over meanwhile.
        if (seen && Date.now() - Number(seen.mtimeMs) > LOCK_STALE_MS && isStill(lock, seen) && removeQuietly(lock)) {
            continue;
        }
        if (Date.now() >= until) {
            throw new HistoryFileError('EBUSY');
        }
        sleep(seen ? 5 : 1);
    }
    const held = () => isStill(lock, mine);
    try {
        return work(held);
    } finally {
        // Tidying only: the pointer is replaced, or not, by now. A lock that
        // cannot be removed is taken over once LOCK_STALE_MS old; one another
        // window took over is that window's to remove.
        if (held()) {
            removeQuietly(lock);
        }
    }
}

/**
 * Make the lock, exclusively; what it is once made, as the lock is looked at
 * again later: by its path, after it is closed, so that no time the system
 * sets on closing it can tell it apart from itself.
 */
function made(lock: string): fs.BigIntStats {
    fs.closeSync(fs.openSync(lock, 'wx'));
    try {
        return retrying(() => fs.lstatSync(lock, { bigint: true }));
    } catch (error) {
        // Made, but not known as this window's: let go of at once.
        removeQuietly(lock);
        throw new HistoryFileError(codeOf(error));
    }
}

/**
 * Whether `file` is still the file `seen` describes, and not one put in its
 * place since. As bigints: an NTFS file id passes 2^53, where a number loses
 * the digits that tell two files apart.
 */
function isStill(file: string, seen: fs.BigIntStats): boolean {
    try {
        const now = retrying(() => fs.lstatSync(file, { bigint: true }));
        return now.ino === seen.ino && now.dev === seen.dev && now.mtimeNs === seen.mtimeNs && now.birthtimeNs === seen.birthtimeNs;
    } catch {
        return false;
    }
}

/** Remove what a refused removal left of other publishes: never one in flight. */
function sweepTemporaries(folder: string): void {
    let names: string[];
    try {
        names = fs.readdirSync(folder).filter(name => TEMPORARY.test(name));
    } catch {
        return;
    }
    for (const name of names) {
        const file = path.join(folder, name);
        try {
            if (Date.now() - fs.lstatSync(file).mtimeMs > TEMPORARY_STALE_MS) {
                fs.unlinkSync(file);
            }
        } catch {
            // Gone, or refused: swept at a later publish.
        }
    }
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
            fs.unlinkSync(`${file}${suffix}`);
        } catch {
            // Absent; or opened meanwhile by a window that took it for the newest: a copy, which Clear removes.
        }
    }
}

/** The names of a history's own files: the history, and SQLite's journals beside it. */
export function ownFiles(history: string): string[] {
    return OWN_SUFFIXES.map(suffix => `${path.basename(history)}${suffix}`);
}

/**
 * Remove every history file in `folder`, which holds no history in use:
 * copies that earlier ones left. Returns how many could not be removed.
 */
export function removeLeftovers(folder: string): number {
    let names: string[];
    try {
        names = fs.readdirSync(folder);
    } catch {
        return 0;
    }
    let left = 0;
    for (const name of names.filter(n => HISTORY_FILE.test(n))) {
        try {
            fs.unlinkSync(path.join(folder, name));
        } catch (error) {
            if (!absent(error)) {
                left++;
            }
        }
    }
    return left;
}

/**
 * The history files in `current`'s folder that are not `current`'s own: what Clear removes.
 *
 * @throws HistoryFileError when the folder cannot be listed for a reason other
 * than its absence: none found is not the same as none there.
 */
export function copiesBeside(current: string): string[] {
    const own = new Set(ownFiles(current));
    let names: string[];
    try {
        names = fs.readdirSync(path.dirname(current));
    } catch (error) {
        if (absent(error)) {
            return [];
        }
        throw new HistoryFileError(codeOf(error));
    }
    return names.filter(name => HISTORY_FILE.test(name) && !own.has(name));
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
 * Windows refuses, for a moment, to open, replace or delete a file another
 * handle has open, an antivirus's or an indexer's among them: tried again for
 * up to RETRY_BUDGET_MS before it counts.
 */
function retrying<T>(work: () => T): T {
    const until = Date.now() + RETRY_BUDGET_MS;
    for (let attempt = 1; ; attempt++) {
        try {
            return work();
        } catch (error) {
            if (!transient(error) || Date.now() >= until) {
                throw error;
            }
            sleep(Math.min(10 * attempt, 100));
        }
    }
}

/** EPERM, EACCES or EBUSY on Windows: another handle has the file open, or it is being deleted. */
function transient(error: unknown): boolean {
    const code = codeOf(error);
    return process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY');
}

/**
 * Give `from`, a file just written whole, the name `to`, unless a file has it
 * already: through a link, which fails where the name exists, tried again
 * while Windows refuses the new file for a moment; on a file system without
 * links, by a rename.
 *
 * @returns false when `to` was there already, and `from` is left as it is.
 */
export function linkWhole(from: string, to: string): boolean {
    try {
        retrying(() => fs.linkSync(from, to));
        return true;
    } catch (error) {
        if (codeOf(error) === 'EEXIST') {
            return false;
        }
        if (transient(error)) {
            throw error;
        }
    }
    renameRetrying(from, to);
    return true;
}

/**
 * Remove one of this module's own small files: true once it is gone, false
 * when it could not be. Never throws: what it tidies has been decided.
 *
 * unlink, never rm: from Node 23, fs.rmSync is std::filesystem::remove, which
 * in the editor's Electron build (libc++) deletes on close, so the name stays,
 * "delete pending", while any other handle is open on it, and creating it
 * fails meanwhile; libuv's unlink removes the name at once where NTFS can.
 */
export function removeQuietly(file: string): boolean {
    try {
        retrying(() => fs.unlinkSync(file));
        return true;
    } catch (error) {
        return absent(error);
    }
}

function sleep(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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
