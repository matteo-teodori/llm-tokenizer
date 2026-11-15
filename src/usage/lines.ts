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
import { pipeline } from 'stream/promises';
import * as zlib from 'zlib';

/**
 * Bumped whenever what a line becomes changes, in any agent's reader: one
 * number for every reader, as one history and one import lease are shared,
 * and a window running an older build must stop writing once a newer one
 * has (see `UsageStore.outdated`). Claude Code's own history of it is in
 * transcripts.ts, beside `ROWS_SINCE`, the oldest of its parsers whose rows
 * it keeps: 6 is the first that reads Codex's rollouts too, and parses a
 * line only up to 2 MiB, where 5 parsed 4.
 */
export const PARSER_VERSION = 6;

/** Bytes read at a time. */
const CHUNK_BYTES = 1 << 20;

/** About 12× the longest line measured (1.37 MB); past it a line is skipped. */
export const MAX_LINE_BYTES = 16 << 20;

/**
 * The longest line that is ever parsed. Measured, the longest real assistant
 * line is 478 KB, and none passes 1 MiB. Parsing costs Node's heap up to 31
 * bytes a byte, for nested arrays (`[[[…]]]`): 4 MiB of them took 127 MB,
 * and with what an import holds besides (up to 26 MB), the worker's 128 MB
 * ran out, on the Node a remote extension host runs; Electron's V8, which
 * compresses its pointers, spends half as much. 2 MiB take 66 MB. A longer
 * line holding a record's marker is skipped as oversize.
 */
export const MAX_PARSED_LINE_BYTES = 2 << 20;

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
    /**
     * What the reader had made of the lines before the checkpoint, where the
     * meaning of a line depends on them, as a running total's does: its own
     * text, never a line's bytes. Null for a reader that needs none.
     */
    readerState?: string | null;
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
 * Lines out of chunks as they come: a line of over MAX_LINE_BYTES is passed
 * over, the rest handed to `use` whole, without its newline or a CR before
 * it, with the offset it starts at; `consumed` is told the byte after each
 * newline, where a checkpoint may be put. The unterminated tail is held as a
 * list of chunks and joined only once its newline arrives, never on every
 * chunk: joining on every chunk is quadratic on a long line.
 */
export class LineSplitter {
    private pending: Buffer[] = [];
    private pendingBytes = 0;
    private skipping = false;
    private position: number;
    private lineStart: number;

    constructor(
        start: number,
        private readonly use: (line: Buffer, offset: number) => void,
        private readonly oversize: () => void,
        private readonly consumed: (offset: number) => void,
    ) {
        this.position = start;
        this.lineStart = start;
    }

    /** Take the next `chunk` of the file; it may be reused once this returns. */
    push(chunk: Buffer): void {
        let from = 0;
        while (from < chunk.length) {
            const newline = chunk.indexOf(0x0a, from);
            if (newline === -1) {
                // The rest of this chunk is a line still to be finished.
                const piece = chunk.subarray(from);
                if (!this.skipping && this.pendingBytes + piece.length > MAX_LINE_BYTES) {
                    this.skipping = true;
                    this.pending = [];
                    this.pendingBytes = 0;
                }
                if (!this.skipping) {
                    // Copied: the chunk may be reused.
                    this.pending.push(Buffer.from(piece));
                    this.pendingBytes += piece.length;
                }
                break;
            }
            const piece = chunk.subarray(from, newline);
            const lineOffset = this.lineStart;
            this.lineStart = this.position + newline + 1;
            if (this.skipping || this.pendingBytes + piece.length > MAX_LINE_BYTES) {
                // Too long to be a record: dropped, and the checkpoint moves past it anyway.
                this.oversize();
                this.skipping = false;
            } else {
                const line = this.pendingBytes === 0 ? piece : Buffer.concat([...this.pending, piece], this.pendingBytes + piece.length);
                // Tolerate a CRLF file: the record is the same.
                this.use(line.length > 0 && line[line.length - 1] === 0x0d ? line.subarray(0, line.length - 1) : line, lineOffset);
            }
            this.pending = [];
            this.pendingBytes = 0;
            this.consumed(this.lineStart);
            from = newline + 1;
        }
        this.position += chunk.length;
    }
}

/**
 * Split the bytes of `fd` from `start` to `size` into lines, as
 * `LineSplitter` does: a checkpoint is never put past the last newline, so a
 * line still being written is read once it is complete.
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
    const lines = new LineSplitter(start, use, oversize, consumed);
    let position = start;
    while (position < size) {
        progress?.();
        const read = fs.readSync(fd, chunk, 0, Math.min(CHUNK_BYTES, size - position), position);
        if (read <= 0) {
            break;
        }
        lines.push(chunk.subarray(0, read));
        position += read;
    }
}

/** The runtime's zstd decoder, where it has one: Node 22.15 and later. */
function zstdDecoder(): (() => NodeJS.ReadWriteStream) | undefined {
    const create = (zlib as unknown as { createZstdDecompress?: () => NodeJS.ReadWriteStream }).createZstdDecompress;
    return typeof create === 'function' ? create : undefined;
}

/** Whether this runtime can read a zstd-compressed file. */
export function canDecodeZstd(): boolean {
    return zstdDecoder() !== undefined;
}

/**
 * The lines of the zstd-compressed file open at `fd`, as `LineSplitter`
 * splits them, read whole through the runtime's own decoder as a stream,
 * never decoded whole into memory. Offsets are the decoded bytes'. Every
 * editor this extension supports has the decoder: measured on VS Code
 * 1.105 (Node 22.19), Antigravity 2.7.0 (22.21) and VS Code 1.141 (24.21),
 * with no warning.
 *
 * Each frame is walked whole, to its last block and its checksum, before
 * its bytes are read, and that is how a cut is found: the decoder of most
 * runtimes gives a cut frame's complete blocks as all there is (measured:
 * Node 22.19, 22.21, 24.18 and 26.3; 24.21 says so itself, `Z_BUF_ERROR`).
 * The frames are walked one at a time, as they are read, so that a file of
 * millions of them holds one. All go through one decoder, each frame's
 * bytes in writes of their own: given a write that holds the end of a frame
 * and more, the decoder of most runtimes drops the rest of the write unless
 * the frame's output ends just as an output chunk fills (Node 22.19, 22.21,
 * 24.21 and 26.3; 24.22 decodes on), so a file of several frames, as zstd
 * writes from several inputs, as two files put end to end and pzstd make,
 * would be read as its first. A decoder for each frame would read it whole,
 * but on Node 22 each keeps its buffers until the next collection: for a
 * hundred frames of 8 MiB windows, 616 MB more, where one decoder takes 37
 * (measured on 22.19). A decoder that took less than it was given stopped
 * short, as 24.22's does, without a word, at bytes that open no frame. The
 * bytes are read where they are, by position: a stream given the descriptor
 * closes it itself as a decoder fails, and the caller's own close then
 * closes whatever has had the number since, another thread's file in the
 * extension host for one.
 *
 * @returns how many decoded bytes there were.
 * @throws with the code `ZSTD_UNSUPPORTED` where the runtime has no
 *   decoder; with `ZSTD_TRUNCATED` where the file holds no frame but
 *   skippable ones, or a frame, a block or a checksum ends past it, or the
 *   file is shorter as it is read than it was walked; with `ZSTD_UNDECODED`
 *   where the decoder took less than it was given. The decoder refuses
 *   other invalid bytes itself, a whole frame that declares a size it does
 *   not hold among them (measured on the same runtimes, and 24.22); a file
 *   both cut and invalid can fail either way.
 */
export async function eachLineOfZstd(
    fd: number,
    use: (line: Buffer, offset: number) => void,
    oversize: () => void,
    consumed: (offset: number) => void,
    progress?: () => void,
): Promise<number> {
    const create = zstdDecoder();
    if (!create) {
        throw Object.assign(new Error('no zstd decoder'), { code: 'ZSTD_UNSUPPORTED' });
    }
    const size = fs.fstatSync(fd).size;
    const decoder = create() as NodeJS.ReadWriteStream & { readonly bytesWritten: number };
    const lines = new LineSplitter(0, use, oversize, consumed);
    let given = 0;
    let decoded = 0;
    // Each frame walked whole, then its bytes, none in a write with another's.
    async function* frameBytes(): AsyncGenerator<Buffer> {
        for (const frame of zstdFrames(fd, size, progress)) {
            given += frame.end - frame.start;
            yield* bytesOf(fd, frame.start, frame.end);
        }
    }
    await pipeline(frameBytes(), decoder, async (chunks: AsyncIterable<string | Buffer>) => {
        for await (const chunk of chunks) {
            // A decoder's chunks are bytes: it is given no encoding.
            const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'latin1') : chunk;
            progress?.();
            lines.push(bytes);
            decoded += bytes.length;
        }
    });
    if (decoder.bytesWritten !== given) {
        throw Object.assign(new Error('zstd bytes left undecoded'), { code: 'ZSTD_UNDECODED' });
    }
    return decoded;
}

function truncatedZstd(): Error {
    return Object.assign(new Error('zstd frame cut short'), { code: 'ZSTD_TRUNCATED' });
}

/** The bytes from `start` to `end` of the file open at `fd`, read where they are: the descriptor stays the caller's. */
async function* bytesOf(fd: number, start: number, end: number): AsyncGenerator<Buffer> {
    for (let at = start; at < end; ) {
        const chunk = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, end - at));
        const read = await new Promise<number>((resolve, reject) => fs.read(fd, chunk, 0, chunk.length, at, (error, n) => (error ? reject(error) : resolve(n))));
        if (read === 0) {
            // Shorter now than when its frames were walked.
            throw truncatedZstd();
        }
        yield chunk.subarray(0, read);
        at += read;
    }
}

/** A zstd frame of a file: where it begins and ends. */
interface ZstdFrame {
    start: number;
    end: number;
}

/**
 * The zstd frames of the file open at `fd`, found from their frame and
 * block headers alone (RFC 8878 §§3.1.1–3.1.2), their blocks' contents
 * passed over: a frame streamed declares no size, and the sizes of its
 * blocks are all that tell it whole. Skippable frames are passed over too.
 * Of a frame header, its magic number and descriptor are read, 5 bytes,
 * and of a block, its 3-byte header: nothing of their contents. Each frame
 * is given as soon as it is walked, and none is kept. From an unknown magic
 * number, or a block of the reserved type, the rest of the file is one last
 * frame, for the decoder to refuse; after a whole frame, 24.22's takes none
 * of a rest that opens no frame, and says nothing, so `eachLineOfZstd`
 * refuses it itself (`ZSTD_UNDECODED`). A file of several frames cut just
 * where one of them ends is a shorter file of whole frames, which nothing in
 * the format tells apart: Codex writes one frame a file.
 *
 * @throws with the code `ZSTD_TRUNCATED` where the file holds no frame
 *   but skippable ones, as one empty does, or pzstd's cut after its first,
 *   or where a frame, a block or a checksum ends past it.
 */
function* zstdFrames(fd: number, size: number, progress?: () => void): Generator<ZstdFrame> {
    const header = Buffer.alloc(4);
    let frames = 0;
    let at = 0;
    const skip = (length: number) => {
        at += length;
        if (at > size) {
            throw truncatedZstd();
        }
    };
    const read = (length: number) => {
        if (size - at < length || fs.readSync(fd, header, 0, length, at) !== length) {
            throw truncatedZstd();
        }
        at += length;
    };
    while (at < size) {
        progress?.();
        const start = at;
        read(4);
        const magic = header.readUInt32LE(0);
        if (magic >= 0x184d2a50 && magic <= 0x184d2a5f) {
            read(4);
            skip(header.readUInt32LE(0));
            continue;
        }
        if (magic !== 0xfd2fb528) {
            yield { start, end: size };
            return;
        }
        read(1);
        const descriptor = header[0];
        const single = (descriptor & 0x20) !== 0;
        // The window, the dictionary and the content size passed over: RFC 8878 §3.1.1.1.
        skip((single ? 0 : 1) + [0, 1, 2, 4][descriptor & 0x03] + [single ? 1 : 0, 2, 4, 8][descriptor >> 6]);
        for (;;) {
            progress?.();
            read(3);
            const block = header.readUIntLE(0, 3);
            const type = (block >> 1) & 3;
            if (type === 3) {
                yield { start, end: size };
                return;
            }
            // RLE stores one byte, whatever decompressed length the block names.
            skip(type === 1 ? 1 : block >> 3);
            if (block & 1) {
                break;
            }
        }
        skip(descriptor & 0x04 ? 4 : 0);
        frames++;
        yield { start, end: at };
    }
    // Nothing, or skippable frames alone: no compressed rollout is that.
    if (frames === 0) {
        throw truncatedZstd();
    }
}
