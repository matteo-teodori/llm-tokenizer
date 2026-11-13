/**
 * The names Claude Code's own configuration gives Claude accounts: the one
 * signed in now, `oauthAccount`, and, where Claude Code keeps it, every one
 * it has been signed in to, `knownAccounts`. A session's transcript names
 * its owner by id only; these are the names Claude Code itself shows for
 * those ids, as `email (Organization)`.
 *
 * Read in the worker, from the files `roots.ts` names, by their bytes: only
 * those two top-level keys are parsed. The file also holds every project
 * Claude Code has opened, and can be large, where the worker's heap is
 * 128 MB. Nothing is kept from it but each account's and organization's id,
 * the email and the organization's name, and nothing derived from it is
 * logged: like a transcript, it is another program's file, and its layout
 * is internal to Claude Code (measured on 2.1.322).
 */

import * as fs from 'fs';

import { showable } from './accounts';
import type { AccountName } from './store';
import type { SessionOwner } from './types';

/** What Claude Code's configuration says of its accounts. */
export interface ConfiguredAccounts {
    /** Every account and organization it names, with their names: the one signed in now first. */
    names: AccountName[];
    /** The account and organization each file says is signed in now. */
    current: SessionOwner[];
}

/** Larger than this, a file is not read: the heaviest measured was 86 KB, and older Claude Code kept prompts in it. */
export const MAX_CONFIG_BYTES = 64 << 20;
/** The most a wanted value may take: an account's profile is about 1 KB. */
const MAX_VALUE_BYTES = 1 << 20;
/** Bounds on what is kept, so that a hostile file cannot fill the history. */
const MAX_ACCOUNTS = 100;
const MAX_ORGANIZATIONS = 100;
const MAX_EMAIL = 254;
const MAX_ORGANIZATION_NAME = 200;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const WANTED: ReadonlySet<string> = new Set(['oauthAccount', 'knownAccounts']);

/** What one file says, and when it was written. */
interface FileAccounts {
    accounts: ConfiguredAccounts;
    modifiedMs: number;
}

/** Each file read, by what it was when read: a file unchanged since is not read again. */
const cache = new Map<string, { stamp: string; read: FileAccounts }>();

/**
 * What `files` say, merged, the file written last first: an account named
 * in more than one keeps the newest name given, and where that leaves out
 * its email or its organization's name, an older one's. Only `signedIn`
 * say which account Claude Code is signed in to now, every file when it is
 * not given. A file missing, unreadable, too large or not JSON says nothing.
 */
export function readClaudeAccounts(files: readonly string[], signedIn: readonly string[] = files): ConfiguredAccounts {
    const names = new Map<string, AccountName>();
    const current = new Map<string, SessionOwner>();
    const reads = files.map((file, i) => ({ file, i, ...readOne(file) })).sort((a, b) => b.modifiedMs - a.modifiedMs || a.i - b.i);
    for (const { file, accounts: read } of reads) {
        if (signedIn.includes(file)) {
            for (const owner of read.current) {
                current.set(ownerKey(owner), owner);
            }
        }
        for (const name of read.names) {
            const key = ownerKey(name);
            const known = names.get(key);
            names.set(key, known ? { ...known, email: known.email ?? name.email, organizationName: known.organizationName ?? name.organizationName } : name);
        }
    }
    return { names: [...names.values()], current: [...current.values()] };
}

function ownerKey(owner: SessionOwner): string {
    return `${owner.accountUuid}/${owner.organizationUuid ?? ''}`;
}

function readOne(file: string): FileAccounts {
    const none: FileAccounts = { accounts: { names: [], current: [] }, modifiedMs: -Infinity };
    let fd: number | undefined;
    try {
        // A regular file only, read through the descriptor that was checked:
        // a FIFO in its place would block the worker.
        fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
        const stat = fs.fstatSync(fd, { bigint: true });
        if (!stat.isFile() || stat.size > BigInt(MAX_CONFIG_BYTES)) {
            cache.delete(file);
            return none;
        }
        const stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`;
        const cached = cache.get(file);
        if (cached?.stamp === stamp) {
            return cached.read;
        }
        const bytes = Buffer.alloc(Number(stat.size));
        const length = fs.readSync(fd, bytes, 0, bytes.length, 0);
        const read = { accounts: accountsOf(topLevel(bytes.subarray(0, length), WANTED)), modifiedMs: Number(stat.mtimeMs) };
        cache.set(file, { stamp, read });
        return read;
    } catch {
        // Missing, unreadable: nothing said. Never the error's message.
        cache.delete(file);
        return none;
    } finally {
        if (fd !== undefined) {
            fs.closeSync(fd);
        }
    }
}

/** What the two values say, each field checked; anything else is ignored. */
function accountsOf(values: Map<string, unknown>): ConfiguredAccounts {
    const names: AccountName[] = [];
    const current: SessionOwner[] = [];
    const signedIn = objectOf(values.get('oauthAccount'));
    const account = uuidOf(signedIn?.accountUuid);
    if (signedIn && account) {
        const organizationUuid = uuidOf(signedIn.organizationUuid);
        current.push({ accountUuid: account, organizationUuid });
        names.push({
            accountUuid: account,
            organizationUuid,
            email: showable(signedIn.emailAddress, MAX_EMAIL),
            organizationName: showable(signedIn.organizationName, MAX_ORGANIZATION_NAME),
        });
    }
    const known = objectOf(values.get('knownAccounts'));
    for (const [id, entry] of Object.entries(known ?? {}).slice(0, MAX_ACCOUNTS)) {
        const accountUuid = uuidOf(id);
        const value = objectOf(entry);
        if (!accountUuid || !value) {
            continue;
        }
        const email = showable(value.emailAddress, MAX_EMAIL);
        // Claude Code keeps an account's organizations by id, an empty one
        // where it named none, each with its name or null.
        for (const [organization, name] of Object.entries(objectOf(value.organizations) ?? {}).slice(0, MAX_ORGANIZATIONS)) {
            const organizationUuid = uuidOf(organization);
            if (organization !== '' && !organizationUuid) {
                continue;
            }
            names.push({ accountUuid, organizationUuid, email, organizationName: showable(name, MAX_ORGANIZATION_NAME) });
        }
    }
    return { names, current };
}

function objectOf(value: unknown): Record<string, unknown> | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function uuidOf(value: unknown): string | null {
    return typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null;
}


/**
 * The values of the `wanted` keys of the object `bytes` hold, parsed, without
 * parsing anything else: strings are skipped by their quotes, objects and
 * arrays by their brackets, so a value is never built in memory unless it is
 * wanted. A key given twice is its last value, as JSON.parse takes it. What
 * cannot be read as JSON ends the search, keeping what was found before it.
 */
export function topLevel(bytes: Buffer, wanted: ReadonlySet<string>): Map<string, unknown> {
    const found = new Map<string, unknown>();
    // A byte order mark, which JSON itself does not allow, is let pass.
    let i = skipSpace(bytes, bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0);
    if (bytes[i] !== 0x7b) {
        return found;
    }
    i = skipSpace(bytes, i + 1);
    if (bytes[i] === 0x7d) {
        return found;
    }
    for (;;) {
        if (bytes[i] !== 0x22) {
            return found;
        }
        const keyEnd = stringEnd(bytes, i);
        if (keyEnd < 0) {
            return found;
        }
        // Only a short key can be one of these.
        const key = keyEnd - i <= 64 ? parsed(bytes, i, keyEnd) : undefined;
        i = skipSpace(bytes, keyEnd);
        if (bytes[i] !== 0x3a) {
            return found;
        }
        const start = skipSpace(bytes, i + 1);
        const end = valueEnd(bytes, start);
        if (end < 0) {
            return found;
        }
        if (typeof key === 'string' && wanted.has(key)) {
            const value = end - start <= MAX_VALUE_BYTES ? parsed(bytes, start, end) : undefined;
            if (value === undefined) {
                // Too large to be what is wanted, or not JSON: as if it were not there.
                found.delete(key);
                if (end - start <= MAX_VALUE_BYTES) {
                    return found;
                }
            } else {
                found.set(key, value);
            }
        }
        i = skipSpace(bytes, end);
        if (bytes[i] !== 0x2c) {
            return found;
        }
        i = skipSpace(bytes, i + 1);
    }
}

function parsed(bytes: Buffer, start: number, end: number): unknown {
    try {
        return JSON.parse(bytes.toString('utf8', start, end)) as unknown;
    } catch {
        return undefined;
    }
}

function skipSpace(bytes: Buffer, at: number): number {
    let i = at;
    while (i < bytes.length && (bytes[i] === 0x20 || bytes[i] === 0x0a || bytes[i] === 0x0d || bytes[i] === 0x09)) {
        i++;
    }
    return i;
}

/** The index just past the string whose quote is at `at`, or -1 where it never closes. */
function stringEnd(bytes: Buffer, at: number): number {
    for (let from = at + 1; ; ) {
        const quote = bytes.indexOf(0x22, from);
        if (quote < 0) {
            return -1;
        }
        let backslashes = 0;
        for (let b = quote - 1; b > at && bytes[b] === 0x5c; b--) {
            backslashes++;
        }
        if (backslashes % 2 === 0) {
            return quote + 1;
        }
        from = quote + 1;
    }
}

/** The index just past the value that starts at `at`, or -1 where it never ends. */
function valueEnd(bytes: Buffer, at: number): number {
    const first = bytes[at];
    if (first === 0x22) {
        return stringEnd(bytes, at);
    }
    if (first === 0x7b || first === 0x5b) {
        let depth = 0;
        for (let i = at; i < bytes.length; ) {
            const b = bytes[i];
            if (b === 0x22) {
                const end = stringEnd(bytes, i);
                if (end < 0) {
                    return -1;
                }
                i = end;
                continue;
            }
            if (b === 0x7b || b === 0x5b) {
                depth++;
            } else if (b === 0x7d || b === 0x5d) {
                depth--;
                if (depth === 0) {
                    return i + 1;
                }
            }
            i++;
        }
        return -1;
    }
    // A number, true, false or null: up to what follows it.
    let i = at;
    while (i < bytes.length && bytes[i] !== 0x2c && bytes[i] !== 0x7d && bytes[i] !== 0x5d && bytes[i] > 0x20) {
        i++;
    }
    return i > at ? i : -1;
}
