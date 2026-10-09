/**
 * Claude Code's session records, read incrementally.
 *
 * Claude Code keeps one JSON object per line under `<root>/projects/`. The
 * layout and every per-record field are internal to Claude Code, so the rules
 * here are the ones measured on 268,354 assistant lines from 22 versions
 * (2.1.220–2.1.292), and on a later 678,034-line check of the needles:
 *
 * - `<project>/<session>.jsonl` is the main transcript, and its documented
 *   set-aside copies `<session>.orphaned-<ts>-<suffix>.jsonl` and
 *   `<session>.jsonl.superseded-<ts>` count as main too, since the global key
 *   makes reading them twice harmless;
 * - `<project>/<session>/subagents/agent-<id>.jsonl` is a Task subagent, and
 *   `…/subagents/workflows/wf_<run>/agent-<id>.jsonl` a workflow agent (the
 *   latter undocumented); a subagent's records are only in its own file;
 * - `journal.jsonl` holds no usage (0 markers in 6,730 lines) and is skipped;
 * - `<project>` is the cwd with every non-alphanumeric character replaced, so
 *   it is lossy and never decoded.
 *
 * Nothing here imports `vscode`, and nothing derived from a record's bytes is
 * ever logged, posted or stored as text beyond the fields `UsageRequest`
 * names: V8's JSON.parse messages quote their input, so a failure is reported
 * as a fixed category only.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { isSyntheticModel, variantOf } from './modelIds';
import type { Compaction, LimitHit, TranscriptKind, UsageRequest } from './types';

/** Bumped whenever what a line becomes changes; a bump re-reads every file. */
export const PARSER_VERSION = 1;

/** Bytes read at a time. */
const CHUNK_BYTES = 1 << 20;

/** About 12× the longest line measured (1.37 MB); past it a line is skipped. */
export const MAX_LINE_BYTES = 16 << 20;

/** Files over this are guarded while read; see `read_guards` in the store. */
export const LARGE_FILE_BYTES = 64 << 20;

/** How much of the file before the checkpoint is hashed to notice a rewrite. */
const TAIL_BYTES = 64;

/**
 * Byte needles that pick the lines worth parsing; confirmed on 678,034 real
 * lines to match their records exactly, with no miss and no false hit. They
 * are only an optimisation: validation decides what a parsed line is.
 */
const TYPE_KEY = Buffer.from('"type":"');
const ASSISTANT = Buffer.from('assistant"');
const SYSTEM = Buffer.from('system"');
const COMPACT_BOUNDARY = Buffer.from('"subtype":"compact_boundary"');
const API_ERROR = Buffer.from('"subtype":"api_error"');

/** Bounds on the strings kept, so a hostile record cannot bloat the store. */
const MAX_ID = 200;
const MAX_MODEL = 200;
const MAX_VERSION = 50;
const MAX_CWD = 4096;

/** A transcript found by the walk, with what its path says about it. */
export interface TranscriptFile {
    path: string;
    root: string;
    /** The encoded project folder; it only ties files to their session. */
    projectDir: string;
    kind: TranscriptKind;
    /** From the path, for every kind but set-aside main copies and `other`. */
    sessionId: string | null;
    agentId: string | null;
    runId: string | null;
}

export interface WalkReport {
    /** The real path of `<root>/projects`, or null when it does not exist. */
    projects: string | null;
    files: TranscriptFile[];
    symlinkedFolders: number;
    unreadableFolders: number;
    journals: number;
}

/**
 * Every transcript under `<root>/projects`, found by hand.
 *
 * Not readdir's `recursive` option: on Node 22.19 and 26.3 it followed
 * symlinked folders out of the root and looped (35 hits from 2 real files,
 * to depth 34), and one unreadable folder made it throw for the whole tree.
 * Symlinked folders are never entered, only regular files are taken, and an
 * unreadable folder is counted and skipped.
 */
export function walkProjects(root: string): WalkReport {
    const report: WalkReport = { projects: null, files: [], symlinkedFolders: 0, unreadableFolders: 0, journals: 0 };
    let projects: string;
    try {
        projects = fs.realpathSync(path.join(root, 'projects'));
    } catch {
        return report;
    }
    report.projects = projects;

    const visit = (dir: string, parts: string[]): void => {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            report.unreadableFolders++;
            return;
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isSymbolicLink()) {
                // A symlinked file would be fine, but telling one from a
                // symlinked folder costs a stat; neither occurs in practice.
                report.symlinkedFolders++;
            } else if (entry.isDirectory()) {
                // tool-results/ and memory/ hold content, never usage.
                if (entry.name !== 'tool-results' && entry.name !== 'memory') {
                    visit(full, [...parts, entry.name]);
                }
            } else if (entry.isFile()) {
                const file = classify(root, [...parts, entry.name]);
                if (file === 'journal') {
                    report.journals++;
                } else if (file) {
                    report.files.push({ ...file, path: full });
                }
            }
        }
    };
    visit(projects, []);
    return report;
}

/**
 * The transcripts among `paths` that lie in `<root>/projects`, classified as
 * the walk would classify them, under the same real path. For the files a
 * watcher reports changed: anything outside the projects folder, in a folder
 * the walk never enters, or not a transcript, is left out.
 */
export function transcriptsAt(root: string, paths: readonly string[]): TranscriptFile[] {
    let projects: string;
    try {
        projects = fs.realpathSync(path.join(root, 'projects'));
    } catch {
        return [];
    }
    const found: TranscriptFile[] = [];
    for (const candidate of paths) {
        let real: string;
        try {
            real = fs.realpathSync(candidate);
        } catch {
            continue;
        }
        const relative = path.relative(projects, real);
        if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
            continue;
        }
        const parts = relative.split(path.sep);
        if (parts.slice(0, -1).some(part => part === 'tool-results' || part === 'memory')) {
            continue;
        }
        const file = classify(root, parts);
        if (file && file !== 'journal') {
            found.push({ ...file, path: path.join(projects, relative) });
        }
    }
    return found;
}

/**
 * The main transcripts of one session: `<project>/<sessionId>.jsonl` in any
 * project folder, since `/cd` and EnterWorktree move a session between them.
 * One readdir of `projects` and a stat per folder, never a walk: this runs
 * every minute while the status item is shown. `sessionId` must already be
 * known safe for a file name.
 */
export function sessionTranscripts(root: string, sessionId: string): string[] {
    let projects: string;
    let entries: fs.Dirent[];
    try {
        projects = fs.realpathSync(path.join(root, 'projects'));
        entries = fs.readdirSync(projects, { withFileTypes: true });
    } catch {
        return [];
    }
    const found: string[] = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) {
            continue;
        }
        const candidate = path.join(projects, entry.name, `${sessionId}.jsonl`);
        try {
            if (fs.lstatSync(candidate).isFile()) {
                found.push(candidate);
            }
        } catch {
            // Not in this project.
        }
    }
    return found;
}

const AGENT = /^agent-(.+)\.jsonl$/;
const WORKFLOW = /^wf_(.+)$/;
const SET_ASIDE = /^(.+?)(?:\.orphaned-.+\.jsonl|\.jsonl\.superseded-.+)$/;

/** What a path under `projects/` says about the file, or null to skip it. */
function classify(root: string, parts: string[]): Omit<TranscriptFile, 'path'> | 'journal' | null {
    const name = parts[parts.length - 1];
    const projectDir = parts[0];
    const base = { root, projectDir, agentId: null, runId: null };
    if (name === 'journal.jsonl') {
        return 'journal';
    }
    const setAside = SET_ASIDE.exec(name);
    if (!name.endsWith('.jsonl') && !setAside) {
        return null;
    }
    if (parts.length === 2) {
        return name.endsWith('.jsonl') && !setAside
            ? { ...base, kind: 'main', sessionId: name.slice(0, -'.jsonl'.length) }
            : // A set-aside copy's session is whatever its records say.
              { ...base, kind: 'main', sessionId: null };
    }
    const agent = AGENT.exec(name);
    if (agent && parts.length === 4 && parts[2] === 'subagents') {
        return { ...base, kind: 'task', sessionId: parts[1], agentId: agent[1] };
    }
    const run = parts.length === 6 ? WORKFLOW.exec(parts[4]) : null;
    if (agent && run && parts[2] === 'subagents' && parts[3] === 'workflows') {
        return { ...base, kind: 'workflow', sessionId: parts[1], agentId: agent[1], runId: run[1] };
    }
    return { ...base, kind: 'other', sessionId: null };
}

/** Where a previous read of a file stopped, and what the file was then. */
export interface ReadCheckpoint extends FileState {
    offset: number;
    tailHash: string | null;
    parserVersion: number;
}

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

/** What reading a file found since its checkpoint. */
export interface ReadResult {
    /** Not read at all: size and mtime are as the checkpoint left them. */
    unchanged: boolean;
    /** Read from the start rather than the checkpoint, and why. */
    restarted: 'new' | 'replaced' | 'truncated' | 'rewritten' | 'parser' | null;
    requests: UsageRequest[];
    compactions: Compaction[];
    limitHits: LimitHit[];
    /** The first cwd of a main transcript, when this read reached it, and its record's time. */
    firstCwd: string | null;
    firstCwdTs: number | null;
    /** The session id the records gave, for files whose path does not. */
    sessionId: string | null;
    newestVersion: string | null;
    synthetic: number;
    apiErrors: number;
    oversize: number;
    malformed: Map<MalformedCategory, number>;
    checkpoint: ReadCheckpoint;
}

/**
 * Read `file` from its checkpoint, or from the start when it cannot be
 * trusted: a new file (dev, ino), one shorter than the checkpoint, one whose
 * byte before the checkpoint is not a newline, or whose 64 bytes before it
 * hash differently, which covers filesystems with unreliable inodes.
 *
 * Only whole lines are consumed: the checkpoint never passes the last newline,
 * so a line Claude Code is still writing is read once it is complete.
 *
 * @throws the file system's error, for the caller to count as a skip reason.
 */
export function readTranscript(file: TranscriptFile, previous: ReadCheckpoint | undefined): ReadResult {
    const fd = fs.openSync(file.path, 'r');
    try {
        const state = fileState(fs.fstatSync(fd, { bigint: true }));
        const result: ReadResult = {
            unchanged: false,
            restarted: null,
            requests: [],
            compactions: [],
            limitHits: [],
            firstCwd: null,
            firstCwdTs: null,
            sessionId: null,
            newestVersion: null,
            synthetic: 0,
            apiErrors: 0,
            oversize: 0,
            malformed: new Map(),
            checkpoint: {
                ...state,
                offset: previous?.offset ?? 0,
                tailHash: previous?.tailHash ?? null,
                parserVersion: PARSER_VERSION,
            },
        };

        if (previous && isUnchanged(previous, state)) {
            return { ...result, unchanged: true, checkpoint: previous };
        }

        result.restarted = previous ? restartReason(fd, state, previous) : 'new';
        const start = result.restarted === null ? (previous?.offset ?? 0) : 0;
        result.checkpoint.offset = start;

        readLines(fd, start, state.size, file, result);
        result.checkpoint.tailHash = tailHash(fd, result.checkpoint.offset);
        return result;
    } finally {
        fs.closeSync(fd);
    }
}

function restartReason(fd: number, state: FileState, previous: ReadCheckpoint): ReadResult['restarted'] {
    if (previous.parserVersion !== PARSER_VERSION) {
        return 'parser';
    }
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
    return null;
}

/** A hash of the TAIL_BYTES before `offset`, or null at the start of a file. */
function tailHash(fd: number, offset: number): string | null {
    if (offset === 0) {
        return null;
    }
    const length = Math.min(TAIL_BYTES, offset);
    const bytes = Buffer.alloc(length);
    fs.readSync(fd, bytes, 0, length, offset - length);
    return crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 32);
}

/**
 * Split the bytes from `start` into lines and use each whole one.
 *
 * The unterminated tail is held as a list of chunks and joined only once its
 * newline arrives, never on every read: joining on every chunk is quadratic
 * on a long line.
 */
function readLines(fd: number, start: number, size: number, file: TranscriptFile, result: ReadResult): void {
    const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
    let position = start;
    let lineStart = start;
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    let skipping = false;
    let needCwd = file.kind === 'main';

    while (position < size) {
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
                result.oversize++;
                count(result.malformed, 'oversize');
                skipping = false;
            } else {
                const line = pendingBytes === 0 ? piece : Buffer.concat([...pending, piece], pendingBytes + piece.length);
                needCwd = useLine(line, lineOffset, file, result, needCwd);
            }
            pending = [];
            pendingBytes = 0;
            result.checkpoint.offset = lineStart;
            from = newline + 1;
        }
        position += read;
    }
}

/**
 * What a line may hold, from its bytes: an assistant record, a compaction,
 * an API error, or nothing worth parsing.
 *
 * One pass over the line, for every `"type":"` in it, overlapping ones
 * included, so it finds every `"type":"assistant"` that searching for the
 * whole needle would. The subtypes are looked for only in a `system` line,
 * the one type that uses them. Measured on 675,118 real lines, this picked
 * exactly the lines the three separate needles did, in 1.46 s against
 * 2.78 s: those scanned each user line, most of the bytes, three times.
 */
function lineKind(bytes: Buffer): 'assistant' | 'compaction' | 'api-error' | null {
    let system = false;
    for (let i = bytes.indexOf(TYPE_KEY); i !== -1; i = bytes.indexOf(TYPE_KEY, i + 1)) {
        const value = i + TYPE_KEY.length;
        if (startsAt(bytes, ASSISTANT, value)) {
            return 'assistant';
        }
        system ||= startsAt(bytes, SYSTEM, value);
    }
    if (!system) {
        return null;
    }
    return bytes.includes(COMPACT_BOUNDARY) ? 'compaction' : bytes.includes(API_ERROR) ? 'api-error' : null;
}

function startsAt(bytes: Buffer, needle: Buffer, at: number): boolean {
    return at + needle.length <= bytes.length && bytes.compare(needle, 0, needle.length, at, at + needle.length) === 0;
}

/** Use one whole line. Returns whether a main transcript still needs its cwd. */
function useLine(line: Buffer, offset: number, file: TranscriptFile, result: ReadResult, needCwd: boolean): boolean {
    // Tolerate a CRLF file: the record is the same.
    const bytes = line.length > 0 && line[line.length - 1] === 0x0d ? line.subarray(0, line.length - 1) : line;
    if (bytes.length === 0) {
        return needCwd;
    }
    const kind = lineKind(bytes);
    if (kind === null && !needCwd) {
        return needCwd;
    }

    let record: unknown;
    try {
        record = JSON.parse(bytes.toString('utf8'));
    } catch {
        // Never the error's message: it quotes the line.
        count(result.malformed, 'json-syntax');
        return needCwd;
    }
    if (typeof record !== 'object' || record === null || Array.isArray(record)) {
        count(result.malformed, 'not-object');
        return needCwd;
    }
    const r = record as Record<string, unknown>;

    if (needCwd) {
        const cwd = boundedString(r.cwd, MAX_CWD);
        if (cwd) {
            const ts = typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : NaN;
            result.firstCwd = cwd;
            result.firstCwdTs = Number.isFinite(ts) ? ts : null;
            needCwd = false;
        }
    }
    const version = boundedString(r.version, MAX_VERSION);
    if (version) {
        result.newestVersion = newerVersion(result.newestVersion, version);
    }
    if (result.sessionId === null) {
        result.sessionId = boundedString(r.sessionId, MAX_ID);
    }

    if (r.type === 'assistant') {
        parseAssistant(r, offset, file, result);
    } else if (r.type === 'system' && r.subtype === 'compact_boundary') {
        parseCompaction(r, result);
    } else if (r.type === 'system' && r.subtype === 'api_error') {
        result.apiErrors++;
    }
    return needCwd;
}

function parseAssistant(r: Record<string, unknown>, offset: number, file: TranscriptFile, result: ReadResult): void {
    const message = r.message;
    if (typeof message !== 'object' || message === null) {
        count(result.malformed, 'bad-field:message');
        return;
    }
    const m = message as Record<string, unknown>;
    const model = boundedString(m.model, MAX_MODEL);
    if (!model) {
        count(result.malformed, 'bad-field:message.model');
        return;
    }
    const timestamp = typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : NaN;
    if (!Number.isFinite(timestamp)) {
        count(result.malformed, 'bad-field:timestamp');
        return;
    }
    const sessionId = boundedString(r.sessionId, MAX_ID) ?? file.sessionId;
    if (!sessionId) {
        count(result.malformed, 'bad-field:sessionId');
        return;
    }

    // A refused request records which limit it hit. Measured, all 657 such
    // records are the <synthetic> placeholders with zero usage, so this comes
    // before they are set aside below. It is a log of hits, not a gauge of how
    // much of an allowance is used.
    const quota = objectOf(r.quotaLimits);
    const uuid = boundedString(r.uuid, MAX_ID);
    const limitType = boundedString(quota?.rateLimitType, MAX_ID);
    if (quota && uuid && limitType) {
        const resetsAt = quota.resetsAt;
        result.limitHits.push({
            uuid,
            sessionId,
            timestamp,
            limitType,
            resetsAt: typeof resetsAt === 'number' && Number.isSafeInteger(resetsAt) ? resetsAt : null,
        });
    }

    if (isSyntheticModel(model)) {
        result.synthetic++;
        return;
    }
    const messageId = boundedString(m.id, MAX_ID);
    if (!messageId) {
        count(result.malformed, 'bad-field:message.id');
        return;
    }
    const usage = objectOf(m.usage);
    if (!usage) {
        count(result.malformed, 'bad-field:message.usage');
        return;
    }

    const cacheCreation = objectOf(usage.cache_creation);
    const serverTools = objectOf(usage.server_tool_use);
    const outputDetails = objectOf(usage.output_tokens_details);
    const counter = (value: unknown, field: string): number | null => {
        if (value === undefined || value === null) {
            return null;
        }
        if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
            return value;
        }
        count(result.malformed, `bad-field:${field}`);
        return null;
    };

    result.requests.push({
        provider: 'claude-code',
        messageId,
        requestId: boundedString(r.requestId, MAX_ID),
        sessionId,
        kind: file.kind,
        isMain: r.isSidechain !== true,
        timestamp,
        model,
        variant: variantOf(boundedString(r.requestedModel, MAX_MODEL) ?? undefined),
        input: counter(usage.input_tokens, 'input_tokens'),
        cacheCreation: counter(usage.cache_creation_input_tokens, 'cache_creation_input_tokens'),
        cacheRead: counter(usage.cache_read_input_tokens, 'cache_read_input_tokens'),
        output: counter(usage.output_tokens, 'output_tokens'),
        cacheWrite5m: counter(cacheCreation?.ephemeral_5m_input_tokens, 'ephemeral_5m_input_tokens'),
        cacheWrite1h: counter(cacheCreation?.ephemeral_1h_input_tokens, 'ephemeral_1h_input_tokens'),
        thinking: counter(outputDetails?.thinking_tokens, 'thinking_tokens'),
        effort: boundedString(r.effort, MAX_ID),
        webSearchRequests: counter(serverTools?.web_search_requests, 'web_search_requests'),
        webFetchRequests: counter(serverTools?.web_fetch_requests, 'web_fetch_requests'),
        claudeCodeVersion: boundedString(r.version, MAX_VERSION),
        agentId: boundedString(r.agentId, MAX_ID) ?? file.agentId,
        runId: file.runId,
        file: file.path,
        byteOffset: offset,
        parserVersion: PARSER_VERSION,
    });
}

function parseCompaction(r: Record<string, unknown>, result: ReadResult): void {
    const uuid = boundedString(r.uuid, MAX_ID);
    const sessionId = boundedString(r.sessionId, MAX_ID);
    const timestamp = typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : NaN;
    if (!uuid || !sessionId || !Number.isFinite(timestamp)) {
        count(result.malformed, 'bad-field:compact_boundary');
        return;
    }
    const meta = objectOf(r.compactMetadata);
    const tokens = (value: unknown): number | null =>
        typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
    result.compactions.push({
        uuid,
        sessionId,
        timestamp,
        trigger: boundedString(meta?.trigger, MAX_ID),
        preTokens: tokens(meta?.preTokens),
        postTokens: tokens(meta?.postTokens),
    });
}

function objectOf(value: unknown): Record<string, unknown> | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function boundedString(value: unknown, max: number): string | null {
    return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}

function count(counts: Map<MalformedCategory, number>, category: MalformedCategory): void {
    counts.set(category, (counts.get(category) ?? 0) + 1);
}

/** The newer of two Claude Code versions, compared numerically by part. */
export function newerVersion(a: string | null, b: string): string {
    if (a === null) {
        return b;
    }
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pb[i] ?? 0) - (pa[i] ?? 0);
        if (Number.isNaN(d)) {
            return a;
        }
        if (d !== 0) {
            return d > 0 ? b : a;
        }
    }
    return a;
}
