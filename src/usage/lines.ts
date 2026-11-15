/**
 * Append-only JSON Lines files, read incrementally: what every agent's
 * reader shares. A file is read from its checkpoint, the byte after the last
 * newline read, or from its start when that cannot be trusted; it is split
 * into whole lines a chunk at a time, and a line too long to be a record is
 * skipped without being held whole.
 *
 * Nothing here knows what a line means, imports `vscode`, or keeps a line's
 * bytes beyond the call that uses it.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';

/**
 * Bumped whenever what a line becomes changes, in any agent's reader: one
 * number for every reader, as one history and one import lease are shared,
 * and a window running an older build must stop writing once a newer one
 * has (see `UsageStore.outdated`). Claude Code's own history of it is in
 * transcripts.ts, beside `ROWS_SINCE`, the oldest of its parsers whose rows
 * it keeps.
 */
export const PARSER_VERSION = 5;

/** Bytes read at a time. */
const CHUNK_BYTES = 1 << 20;

/** About 12× the longest line measured (1.37 MB); past it a line is skipped. */
export const MAX_LINE_BYTES = 16 << 20;

/**
 * The longest line that is ever parsed. Measured, the longest real assistant
 * line is 396 KiB, and none passes 1 MiB; 8 MiB of dense JSON (`[{},{},…]`)
 * exhausted the worker's 128 MB heap on every pass, where 4 MiB did not. A
 * longer line holding a record's marker is skipped as oversize.
 */
export const MAX_PARSED_LINE_BYTES = 4 << 20;

/** Reads of more new bytes than this are guarded; see `read_guards` in the store. */
export const GUARDED_READ_BYTES = 4 << 20;

/** How much of the file before the checkpoint is hashed to notice a rewrite. */
const TAIL_BYTES = 64;

/** What a checkpoint remembers of a file's identity, size and time. */
export interface FileState {
    /**
     * Decimal text, exact: NTFS file ids keep a reuse count in their top 16
     * bits, so they pass 2^53, where a JavaScript number loses digits and
     * node:sqlite refuses to read such an integer back (measured: an id of
     * 2^53 + 2 stored, then threw ERR_OUT_OF_RANGE on read; one of 2^63 or
     * more was refused on insert). `ino` is null where the filesystem has none.
     */
    dev: string | null;
    ino: string | null;
    size: number;
    mtimeMs: number;
}

/** Where a previous read of a file stopped, and what the file was then. */
export interface ReadCheckpoint extends FileState {
    offset: number;
    tailHash: string | null;
    parserVersion: number;
}

/** A file's state, from `stat` or `fstat` with `bigint: true`. */
export function fileState(stat: fs.BigIntStats): FileState {
    return {
        dev: stat.dev.toString(),
        ino: stat.ino === 0n ? null : stat.ino.toString(),
        size: Number(stat.size),
        mtimeMs: Number(stat.mtimeMs),
    };
}

/** Whether reading the file again would find nothing: as `previous` left it. */
export function isUnchanged(previous: ReadCheckpoint | undefined, state: FileState): boolean {
    return (
        previous !== undefined &&
        previous.parserVersion === PARSER_VERSION &&
        previous.size === state.size &&
        previous.mtimeMs === state.mtimeMs
    );
}

/** Why a line was not used. Fixed strings, never derived from the line. */
export type MalformedCategory = 'json-syntax' | 'not-object' | 'oversize' | `bad-field:${string}`;

/** Why a file is read from its start rather than its checkpoint; null when it is read on from there. */
export type Restart = 'new' | 'replaced' | 'truncated' | 'rewritten' | 'parser' | null;

/**
 * `path` opened for reading, never blocking: a FIFO among an agent's files
 * cannot hang the worker in open(), and anything but a regular file is then
 * refused, with the code `ENOTREG`. The caller closes `fd`.
 *
 * @throws the file system's error, for the caller to count as a skip reason.
 */
export function openRegular(path: string): { fd: number; state: FileState } {
    const fd = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
    try {
        const stat = fs.fstatSync(fd, { bigint: true });
        if (!stat.isFile()) {
            throw Object.assign(new Error('not a regular file'), { code: 'ENOTREG' });
        }
        return { fd, state: fileState(stat) };
    } catch (error) {
        fs.closeSync(fd);
        throw error;
    }
}

/**
 * Why `previous` cannot be read on from, or null when it can: a new file
 * (dev, ino), one shorter than the checkpoint, one whose byte before the
 * checkpoint is not a newline, or whose 64 bytes before it hash differently,
 * which covers filesystems with unreliable inodes. A parser older than
 * `rowsSince`, the reader's oldest whose rows it keeps, is the reason only
 * once the file is known to hold every line `previous` read: the importer
 * then deletes their rows before reading it again, and the rows of lines
 * since removed from a file replaced, truncated or rewritten could never be
 * read again.
 */
export function restartReason(fd: number, state: FileState, previous: ReadCheckpoint, rowsSince: number): Restart {
    if (previous.ino !== null && state.ino !== null && (state.ino !== previous.ino || state.dev !== previous.dev)) {
        return 'replaced';
    }
    if (state.size < previous.offset) {
        return 'truncated';
    }
    if (previous.offset > 0) {
        const before = Buffer.alloc(1);
        fs.readSync(fd, before, 0, 1, previous.offset - 1);
        if (before[0] !== 0x0a || tailHash(fd, previous.offset) !== previous.tailHash) {
            return 'rewritten';
        }
    }
    return previous.parserVersion < rowsSince ? 'parser' : null;
}

/** A hash of the TAIL_BYTES before `offset`, or null at the start of a file. */
export function tailHash(fd: number, offset: number): string | null {
    if (offset === 0) {
        return null;
    }
    const length = Math.min(TAIL_BYTES, offset);
    const bytes = Buffer.alloc(length);
    fs.readSync(fd, bytes, 0, length, offset - length);
    return crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 32);
}

/**
 * Split the bytes of `fd` from `start` to `size` into lines, and hand each
 * whole one to `use`, without its newline or a CR before it, with the offset
 * it starts at; a line of over MAX_LINE_BYTES is passed over, and
 * `oversize` told. `consumed` is told the byte after each newline, which is
 * where a checkpoint may be put: never past the last newline, so a line
 * still being written is read once it is complete.
 *
 * The unterminated tail is held as a list of chunks and joined only once its
 * newline arrives, never on every read: joining on every chunk is quadratic
 * on a long line.
 */
export function eachLine(
    fd: number,
    start: number,
    size: number,
    use: (line: Buffer, offset: number) => void,
    oversize: () => void,
    consumed: (offset: number) => void,
    progress?: () => void,
): void {
    const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
    let position = start;
    let lineStart = start;
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    let skipping = false;

    while (position < size) {
        progress?.();
        const read = fs.readSync(fd, chunk, 0, Math.min(CHUNK_BYTES, size - position), position);
        if (read <= 0) {
            break;
        }
        const view = chunk.subarray(0, read);
        let from = 0;
        while (from < read) {
            const newline = view.indexOf(0x0a, from);
            if (newline === -1) {
                // The rest of this chunk is a line still to be finished.
                const piece = view.subarray(from);
                if (!skipping && pendingBytes + piece.length > MAX_LINE_BYTES) {
                    skipping = true;
                    pending = [];
                    pendingBytes = 0;
                }
                if (!skipping) {
                    // Copied: the chunk is reused by the next read.
                    pending.push(Buffer.from(piece));
                    pendingBytes += piece.length;
                }
                break;
            }

            const piece = view.subarray(from, newline);
            const lineOffset = lineStart;
            lineStart = position + newline + 1;
            if (skipping || pendingBytes + piece.length > MAX_LINE_BYTES) {
                // Too long to be a record: dropped, and the checkpoint moves
                // past it anyway.
                oversize();
                skipping = false;
            } else {
                const line = pendingBytes === 0 ? piece : Buffer.concat([...pending, piece], pendingBytes + piece.length);
                // Tolerate a CRLF file: the record is the same.
                use(line.length > 0 && line[line.length - 1] === 0x0d ? line.subarray(0, line.length - 1) : line, lineOffset);
            }
            pending = [];
            pendingBytes = 0;
            consumed(lineStart);
            from = newline + 1;
        }
        position += read;
    }
}
