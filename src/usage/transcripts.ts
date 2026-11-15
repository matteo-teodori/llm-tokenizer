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
 * - a session's owner, the Claude account and organization it was signed in
 *   to, is a `session-owner` record in its main transcript only (863 of 863
 *   on 5,102 files), written since Claude Code 2.1.318 or so, in November
 *   2026: when a session starts, before its first request, again with the
 *   rest of its metadata, and when it is resumed under another account, so
 *   that a session from before then, resumed since, has one too, after its
 *   older requests: ids only, never a name;
 * - `<project>` is the cwd with every non-alphanumeric character replaced, so
 *   it is lossy and never decoded.
 *
 * Nothing here imports `vscode`, and nothing derived from a record's bytes is
 * ever logged, posted or stored as text beyond the fields `UsageRequest`
 * names: V8's JSON.parse messages quote their input, so a failure is reported
 * as a fixed category only.
 */

import * as fs from 'fs';
import * as path from 'path';

import { MAX_PARSED_LINE_BYTES, PARSER_VERSION, eachLine, isUnchanged, openRegular, restartReason, tailHash, type MalformedCategory, type ReadCheckpoint } from './lines';
import { isSyntheticModel, variantOf } from './modelIds';
import type { ReadResult } from './readers';
import type { OwnerChange, SessionOwner, TranscriptKind, UsageProvider } from './types';

/** The agent whose records this module reads. */
const PROVIDER: UsageProvider = 'claude-code';

/*
 * What PARSER_VERSION (lines.ts) has meant for Claude Code's lines:
 * 2: each request's `usage.speed` and `usage.inference_geo`.
 * 3, 4: builds of 2.4.0 made before its release, and no other: the account
 *    each request was made with, from its main transcript's `session-owner`
 *    records, some taken by time, and changes of owner begun at an error's
 *    placeholder.
 * 5: only the owner a request's own transcript records before it, none for
 *    a subagent's; a change of owner begins with the next request kept or
 *    limit reached, never an error's placeholder, and of several before
 *    one, only the last. What parsers 3 and 4 wrote is undone where it
 *    differs (see `completeSchema4` in store.ts): their main transcripts are
 *    searched for their owners again, the owners they took by time dropped,
 *    and their other files kept as they are; the bump also stops a window
 *    still running one (see `outdated`).
 * 6: a line is parsed only up to `MAX_PARSED_LINE_BYTES`, 2 MiB, where 5
 *    parsed up to 4: a longer one holding a record is skipped as oversize,
 *    and the rows parser 5 read from one are kept. Codex's rollouts are read
 *    from 6 on.
 */

/**
 * The oldest parser whose rows this one keeps. A file it or a later one read
 * is read on from its checkpoint; one an older parser read is read again
 * whole, its rows replaced. Parser 3 only reads lines parser 2 passed over,
 * so parser 2's rows stand: what parser 3 needs from the bytes before such a
 * checkpoint, a main transcript's owner, is searched for there alone (see
 * `OWNERS_SINCE`). On the heaviest history measured that is a scan of the
 * main transcripts, 678 MB of its 12.6 GB, where reading every file again
 * would have replaced all of its 405,584 requests.
 */
export const ROWS_SINCE = 2;

/**
 * The first parser that reads owners: a main transcript's bytes before an
 * older one's checkpoint are searched for them, and the rows read from them
 * then given theirs by where they are in the file (see `UsageStore.giveOwners`).
 */
export const OWNERS_SINCE = 3;

/**
 * No real request reports more of a counter than this: 100 times the
 * largest context window. Larger values, which summed would pass 2^53 and
 * make every report fail, are refused as bad fields.
 */
export const MAX_COUNTER = 100_000_000;

/**
 * Record times outside these are not Claude Code's, which began in 2025. A
 * time ahead of this clock is kept, never refused: this clock may be the
 * wrong one, and a record refused is never read again. Reports count it
 * once this clock reaches it (see `AHEAD_ALLOWANCE_MS`).
 */
const EARLIEST_TIME = Date.UTC(2023, 0, 1);
const LATEST_TIME = Date.UTC(2100, 0, 1);

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
const SESSION_OWNER = Buffer.from('session-owner"');
/** The whole key and value, which the scan of bytes an older parser read looks for alone. */
const SESSION_OWNER_TYPE = Buffer.from('"type":"session-owner"');
/** And a request's, which that scan parses only while an owner it found waits for its time. */
const ASSISTANT_TYPE = Buffer.from('"type":"assistant"');

/** A Claude account's or organization's id, as Claude Code writes them; lower-cased when kept. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
            // A regular file only: opening a FIFO would block the worker.
            if (!fs.statSync(real).isFile()) {
                continue;
            }
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

/** A read in progress: what it has found, and each session's owner where it is. */
interface Reading {
    result: ReadResult;
    /** The owner each session's records are under at this point of the file. */
    inForce: Map<string, SessionOwner>;
    /** Owner changes no request has followed yet, by session: the next one gives the last of them its time. */
    pending: Map<string, OwnerChange[]>;
    /** Sessions whose owner changed in this read: their requests no longer settle an earlier read's change. */
    changed: Set<string>;
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
 * `inForce`: each session's owner at the checkpoint, as earlier reads of the
 * file left it; the records read on from there are under it until another
 * owner record. Not used when the file is read from its start.
 *
 * @throws the file system's error, for the caller to count as a skip reason.
 */
export function readTranscript(
    file: TranscriptFile,
    previous: ReadCheckpoint | undefined,
    progress?: () => void,
    inForce?: ReadonlyMap<string, SessionOwner>,
): ReadResult {
    // Non-blocking, so that a FIFO under the projects folder cannot hang the
    // worker in open(); anything but a regular file is then refused.
    const { fd, state } = openRegular(file.path);
    try {
        const result: ReadResult = {
            unchanged: false,
            restarted: null,
            requests: [],
            compactions: [],
            limitHits: [],
            firstCwd: null,
            firstCwdTs: null,
            sessionId: null,
            ownerChanges: [],
            firstRequestTs: new Map(),
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

        // A newer parser's checkpoint is that parser's to move; nothing here
        // rewrites it.
        if (previous && (isUnchanged(previous, state) || previous.parserVersion > PARSER_VERSION)) {
            return { ...result, unchanged: true, checkpoint: previous };
        }

        result.restarted = previous ? restartReason(fd, state, previous, ROWS_SINCE) : 'new';
        const start = result.restarted === null ? (previous?.offset ?? 0) : 0;
        result.checkpoint.offset = start;
        // Bytes an older parser read are searched from the start, owners and all.
        const scan = start > 0 && previous !== undefined && needsOwnerScan(file, previous);
        const reading: Reading = { result, inForce: new Map(start > 0 && !scan ? (inForce ?? []) : []), pending: new Map(), changed: new Set() };

        if (scan) {
            // Before the lines read on from the checkpoint, so that these are
            // under the last owner written before them.
            readLines(fd, 0, start, file, reading, progress, 'owners');
        }
        readLines(fd, start, state.size, file, reading, progress);
        result.checkpoint.tailHash = tailHash(fd, result.checkpoint.offset);
        return result;
    } finally {
        fs.closeSync(fd);
    }
}

/**
 * Whether the bytes before `previous`'s checkpoint are to be searched for
 * owner records: a main transcript's, read by a parser before OWNERS_SINCE.
 */
export function needsOwnerScan(file: Pick<TranscriptFile, 'kind'>, previous: Pick<ReadCheckpoint, 'parserVersion'>): boolean {
    return file.kind === 'main' && previous.parserVersion < OWNERS_SINCE;
}

/**
 * Use each whole line of the bytes from `start`, as `eachLine` splits them.
 *
 * `owners`: bytes an older parser has read already, searched for owner
 * records alone, up to the checkpoint, and for the time of the request after
 * each. Nothing else in them is used again, and a line too long to read was
 * counted when they were read.
 */
function readLines(
    fd: number,
    start: number,
    size: number,
    file: TranscriptFile,
    reading: Reading,
    progress?: () => void,
    mode: 'all' | 'owners' = 'all',
): void {
    const result = reading.result;
    let needCwd = file.kind === 'main' && mode === 'all';
    eachLine(
        fd,
        start,
        size,
        (line, offset) => {
            if (mode === 'all') {
                needCwd = useLine(line, offset, file, reading, needCwd);
            } else {
                useOwnerLine(line, offset, file, reading);
            }
        },
        () => {
            if (mode === 'all') {
                result.oversize++;
                count(result.malformed, 'oversize');
            }
        },
        // Bytes searched for owners end where the checkpoint is already.
        offset => {
            result.checkpoint.offset = offset;
        },
        progress,
    );
}

/**
 * What a line may hold, from its bytes: an assistant record, a compaction,
 * an API error, a session's owner, or nothing worth parsing.
 *
 * One pass over the line, for every `"type":"` in it, overlapping ones
 * included, so it finds every `"type":"assistant"` that searching for the
 * whole needle would. The subtypes are looked for only in a `system` line,
 * the one type that uses them. Measured on 675,118 real lines, this picked
 * exactly the lines the three separate needles did, in 1.46 s against
 * 2.78 s: those scanned each user line, most of the bytes, three times.
 */
function lineKind(bytes: Buffer): 'assistant' | 'compaction' | 'api-error' | 'owner' | null {
    let system = false;
    let owner = false;
    for (let i = bytes.indexOf(TYPE_KEY); i !== -1; i = bytes.indexOf(TYPE_KEY, i + 1)) {
        const value = i + TYPE_KEY.length;
        if (startsAt(bytes, ASSISTANT, value)) {
            return 'assistant';
        }
        system ||= startsAt(bytes, SYSTEM, value);
        owner ||= startsAt(bytes, SESSION_OWNER, value);
    }
    if (owner) {
        return 'owner';
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
function useLine(bytes: Buffer, offset: number, file: TranscriptFile, reading: Reading, needCwd: boolean): boolean {
    const result = reading.result;
    if (bytes.length === 0) {
        return needCwd;
    }
    const kind = lineKind(bytes);
    if (kind === null && !needCwd) {
        return needCwd;
    }
    if (bytes.length > MAX_PARSED_LINE_BYTES) {
        // Too long to parse safely. Only a record's line counts as lost; a
        // line read for its cwd alone is just not looked in.
        if (kind !== null) {
            result.oversize++;
            count(result.malformed, 'oversize');
        }
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
            result.firstCwd = cwd;
            result.firstCwdTs = recordTime(r.timestamp);
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
        parseAssistant(r, offset, file, reading);
    } else if (r.type === 'system' && r.subtype === 'compact_boundary') {
        parseCompaction(r, file, result);
    } else if (r.type === 'system' && r.subtype === 'api_error') {
        result.apiErrors++;
    } else if (r.type === 'session-owner' && file.kind === 'main') {
        parseOwner(r, offset, file, reading);
    }
    return needCwd;
}

/**
 * A line of bytes an older parser read: used only when it is a session's
 * owner, or, while an owner found waits for its time, a request, whose time
 * gives it.
 */
function useOwnerLine(bytes: Buffer, offset: number, file: TranscriptFile, reading: Reading): void {
    if (bytes.length > MAX_PARSED_LINE_BYTES) {
        return;
    }
    const owner = bytes.includes(SESSION_OWNER_TYPE);
    if (!owner && !(reading.pending.size > 0 && bytes.includes(ASSISTANT_TYPE))) {
        return;
    }
    let record: unknown;
    try {
        record = JSON.parse(bytes.toString('utf8'));
    } catch {
        // Counted, if it held a record, when these bytes were read.
        return;
    }
    const r = objectOf(record);
    if (r?.type === 'session-owner') {
        parseOwner(r, offset, file, reading);
    } else if (r?.type === 'assistant') {
        const timestamp = recordTime(r.timestamp);
        const sessionId = boundedString(r.sessionId, MAX_ID) ?? file.sessionId;
        if (timestamp !== null && sessionId && isUse(r)) {
            settlePending(reading, sessionId, timestamp);
        }
    }
}

/**
 * Whether an assistant record is a use of the account a session is under:
 * a request kept (a model's, with an id and usage), or a limit reached.
 * An error's placeholder, such as a request refused for a bad key, is not:
 * nothing is ever shown under the account for it. As `parseAssistant` keeps
 * them.
 */
function isUse(r: Record<string, unknown>): boolean {
    const m = objectOf(r.message);
    const model = m && boundedString(m.model, MAX_MODEL);
    if (!m || !model) {
        return false;
    }
    return limitOf(r) !== null || (!isSyntheticModel(model) && boundedString(m.id, MAX_ID) !== null && objectOf(m.usage) !== undefined);
}

/** A refused request's limit: its type, and the record's id. */
function limitOf(r: Record<string, unknown>): { quota: Record<string, unknown>; uuid: string; limitType: string } | null {
    const quota = objectOf(r.quotaLimits);
    const uuid = boundedString(r.uuid, MAX_ID);
    const limitType = boundedString(quota?.rateLimitType, MAX_ID);
    return quota && uuid && limitType ? { quota, uuid, limitType } : null;
}

/**
 * A session's owner: the account and, where it names one, the organization
 * it was signed in to, by id. The records after it are under it, until the
 * next; one that names the account already in force is the session's
 * metadata written again, and changes nothing.
 */
function parseOwner(r: Record<string, unknown>, offset: number, file: TranscriptFile, reading: Reading): void {
    const account = r.accountUuid;
    const organization = r.organizationUuid;
    const sessionId = boundedString(r.sessionId, MAX_ID) ?? file.sessionId;
    const organizationOk = organization === undefined || organization === null || organization === '' || (typeof organization === 'string' && UUID.test(organization));
    if (typeof account !== 'string' || !UUID.test(account) || !organizationOk || !sessionId) {
        count(reading.result.malformed, 'bad-field:session-owner');
        return;
    }
    const owner: SessionOwner = {
        accountUuid: account.toLowerCase(),
        organizationUuid: typeof organization === 'string' && organization !== '' ? organization.toLowerCase() : null,
    };
    const before = reading.inForce.get(sessionId);
    if (before && before.accountUuid === owner.accountUuid && before.organizationUuid === owner.organizationUuid) {
        return;
    }
    const change: OwnerChange = { sessionId, offset, owner, sinceTs: null };
    reading.result.ownerChanges.push(change);
    reading.pending.set(sessionId, [...(reading.pending.get(sessionId) ?? []), change]);
    reading.inForce.set(sessionId, owner);
    reading.changed.add(sessionId);
}

/**
 * A session's request at `timestamp`: the last owner change that waits for
 * one begins then. Those before it were never in force for a request, a
 * session resumed under one account and then another before it asked
 * anything, and keep no time: no account is counted as used for them.
 */
function settlePending(reading: Reading, sessionId: string, timestamp: number): void {
    const pending = reading.pending.get(sessionId);
    if (pending && pending.length > 0) {
        pending[pending.length - 1].sinceTs = timestamp;
    }
    reading.pending.delete(sessionId);
}

/**
 * A use of the account at `timestamp` (see `isUse`): it begins the owner
 * change waiting for one, and is the session's first in this read, which
 * gives an earlier read's change its time, unless a change came first.
 */
function began(reading: Reading, sessionId: string, timestamp: number): void {
    settlePending(reading, sessionId, timestamp);
    if (!reading.result.firstRequestTs.has(sessionId) && !reading.changed.has(sessionId)) {
        reading.result.firstRequestTs.set(sessionId, timestamp);
    }
}

function parseAssistant(r: Record<string, unknown>, offset: number, file: TranscriptFile, reading: Reading): void {
    const result = reading.result;
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
    const timestamp = recordTime(r.timestamp);
    if (timestamp === null) {
        count(result.malformed, 'bad-field:timestamp');
        return;
    }
    const sessionId = boundedString(r.sessionId, MAX_ID) ?? file.sessionId;
    if (!sessionId) {
        count(result.malformed, 'bad-field:sessionId');
        return;
    }
    // The account it was made with, where its own transcript says: the
    // session's owner at this point of it. Where none does, a subagent's
    // transcript among them, a report goes by the time of the request and
    // the session's owners (see report.ts), never fixed here by what has
    // been read so far.
    const owner = reading.inForce.get(sessionId) ?? null;

    // A refused request records which limit it hit. Measured, all 657 such
    // records are the <synthetic> placeholders with zero usage, so this comes
    // before they are set aside below. It is a log of hits, not a gauge of how
    // much of an allowance is used.
    const limit = limitOf(r);
    if (limit) {
        const { quota, uuid, limitType } = limit;
        began(reading, sessionId, timestamp);
        const resetsAt = quota.resetsAt;
        result.limitHits.push({
            provider: PROVIDER,
            uuid,
            sessionId,
            timestamp,
            limitType,
            // Epoch seconds, kept only where they make a real date.
            resetsAt:
                typeof resetsAt === 'number' &&
                Number.isSafeInteger(resetsAt) &&
                resetsAt * 1000 >= EARLIEST_TIME &&
                resetsAt * 1000 < LATEST_TIME
                    ? resetsAt
                    : null,
            owner,
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
    began(reading, sessionId, timestamp);

    const cacheCreation = objectOf(usage.cache_creation);
    const serverTools = objectOf(usage.server_tool_use);
    const outputDetails = objectOf(usage.output_tokens_details);
    const counter = (value: unknown, field: string): number | null => {
        if (value === undefined || value === null) {
            return null;
        }
        if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_COUNTER) {
            return value;
        }
        count(result.malformed, `bad-field:${field}`);
        return null;
    };
    // A word as the API writes them; an empty one is a record that names none.
    const word = (value: unknown, field: string): string | null => {
        if (value === undefined || value === null || value === '') {
            return null;
        }
        if (typeof value === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(value)) {
            return value;
        }
        count(result.malformed, `bad-field:${field}`);
        return null;
    };

    result.requests.push({
        provider: PROVIDER,
        messageId,
        requestId: boundedString(r.requestId, MAX_ID),
        sessionId,
        kind: file.kind,
        isMain: r.isSidechain !== true,
        timestamp,
        model,
        variant: variantOf(boundedString(r.requestedModel, MAX_MODEL) ?? undefined),
        speed: word(usage.speed, 'speed'),
        inferenceGeo: word(usage.inference_geo, 'inference_geo'),
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
        owner,
    });
}

function parseCompaction(r: Record<string, unknown>, file: TranscriptFile, result: ReadResult): void {
    const uuid = boundedString(r.uuid, MAX_ID);
    const sessionId = boundedString(r.sessionId, MAX_ID);
    const timestamp = recordTime(r.timestamp);
    if (!uuid || !sessionId || timestamp === null) {
        count(result.malformed, 'bad-field:compact_boundary');
        return;
    }
    const meta = objectOf(r.compactMetadata);
    const tokens = (value: unknown): number | null =>
        typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_COUNTER ? value : null;
    result.compactions.push({
        provider: PROVIDER,
        uuid,
        sessionId,
        // A subagent compacts its own context, not the main conversation's.
        kind: file.kind,
        timestamp,
        trigger: boundedString(meta?.trigger, MAX_ID),
        preTokens: tokens(meta?.preTokens),
        postTokens: tokens(meta?.postTokens),
    });
}

/** A record's ISO time as epoch milliseconds, or null when it is not a plausible one. */
function recordTime(value: unknown): number | null {
    const time = typeof value === 'string' ? Date.parse(value) : NaN;
    return Number.isFinite(time) && time >= EARLIEST_TIME && time < LATEST_TIME ? time : null;
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
