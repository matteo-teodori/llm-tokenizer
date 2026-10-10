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
 * the one name used before, stays in use while no pointer says otherwise.
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
const HISTORY = /^usage(-[0-9a-z]{8,40})?\.sqlite$/;
/** A history's file, its journals and backups, and copies set aside by earlier versions. */
const HISTORY_FILE = /^usage(-[0-9a-z]+)?\.sqlite(-wal|-shm|\.bak-v.+|\.corrupt-.+)?$/;

/** The history in use in `folder`, or undefined when a new one is to be started. */
export function currentHistory(folder: string): string | undefined {
    const named = readPointer(folder);
    if (named !== undefined) {
        // A history whose file is gone is not started again under its name:
        // a window may still hold the one that was there.
        return exists(path.join(folder, named)) ? path.join(folder, named) : undefined;
    }
    return exists(path.join(folder, LEGACY)) ? path.join(folder, LEGACY) : undefined;
}

/**
 * Start a new history in `folder`: a name no history has had, and the pointer
 * at it, replaced in one rename. Two windows starting one at the same time
 * each point at their own, and the last pointer wins; the other follows it at
 * its next request.
 */
export function startHistory(folder: string): string {
    fs.mkdirSync(folder, { recursive: true });
    const name = `usage-${Date.now().toString(36)}${randomBytes(6).toString('hex')}.sqlite`;
    const pointer = path.join(folder, POINTER);
    const written = `${pointer}.${randomBytes(6).toString('hex')}`;
    fs.writeFileSync(written, name);
    try {
        fs.renameSync(written, pointer);
    } catch (error) {
        fs.rmSync(written, { force: true });
        throw error;
    }
    return path.join(folder, name);
}

/** The history files in `current`'s folder that are not `current`'s own: what Clear removes. */
export function copiesBeside(current: string): string[] {
    const own = new Set(['', '-wal', '-shm'].map(suffix => path.basename(current) + suffix));
    try {
        return fs.readdirSync(path.dirname(current)).filter(name => HISTORY_FILE.test(name) && !own.has(name));
    } catch {
        return [];
    }
}

function readPointer(folder: string): string | undefined {
    try {
        const name = fs.readFileSync(path.join(folder, POINTER), 'utf8').trim();
        return HISTORY.test(name) ? name : undefined;
    } catch {
        return undefined;
    }
}

/** Anything at `p`, a folder in the history's place included: opening it is what fails. */
function exists(p: string): boolean {
    try {
        fs.lstatSync(p);
        return true;
    } catch {
        return false;
    }
}
