/**
 * The refusals both scripts make before they write anything: the work folder
 * must be a scratch folder of this pipeline's own, never one Claude Code or the
 * extension could take for real records, and the demo's day must have room
 * for today's sessions.
 */

import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

/**
 * A path as the file system sees it: links resolved through its nearest
 * existing folder, and compared without case or Unicode form, as macOS's
 * default volume does: ~/.CLAUDE is ~/.claude there.
 */
function comparable(p) {
    let existing = resolve(p);
    const rest = [];
    while (!existsSync(existing) && dirname(existing) !== existing) {
        rest.unshift(basename(existing));
        existing = dirname(existing);
    }
    return join(realpathSync.native(existing), ...rest).normalize('NFC').toLowerCase();
}

const within = (p, folder) => p === folder || p.startsWith(`${folder}/`);

/** Refuse `work` unless it is safe to write the demo into, then mark it as this pipeline's. */
export function claimWork(work) {
    const home = os.homedir();
    const at = comparable(work);
    // Every data folder Claude Code reads, and the extension with it.
    const dataFolders = [join(home, '.claude'), process.env.CLAUDE_CONFIG_DIR].filter(Boolean).map(comparable);
    if (within(comparable(home), at) || dataFolders.some(folder => within(at, folder))) {
        throw new Error('the work folder must be a scratch folder of its own: not the home, nor in a Claude Code data folder');
    }
    // A data folder named elsewhere, in a setting or a settings file, reads
    // every transcript under its projects/: nothing goes under one.
    if (at.split('/').includes('projects')) {
        throw new Error('the work folder must not be inside a folder named projects, where it could be read as Claude Code records');
    }
    const mark = join(work, '.llm-tokenizer-screenshots');
    if (existsSync(work) && !existsSync(mark) && readdirSync(work).length > 0) {
        throw new Error(`${work} holds files this pipeline did not make: give it an empty or a new folder`);
    }
    mkdirSync(work, { recursive: true });
    writeFileSync(mark, 'A work folder of scripts/screenshots.\n');
}

/** Today's demo sessions sit in the hours before now, inside today's UTC date. */
export function refuseEarlyHours(now = Date.now()) {
    if (new Date(now).getUTCHours() < 2) {
        throw new Error("run after 02:00 UTC: today's two demo sessions must fit in today");
    }
}
