/**
 * OpenAI Codex's session records ("rollouts"), read incrementally. Codex's
 * command line, its editor extension and its desktop app all write them,
 * through one open-source recorder, under the Codex home (`CODEX_HOME`, else
 * `~/.codex`):
 *
 * - `sessions/YYYY/MM/DD/rollout-<local time>-<thread>.jsonl`, one file per
 *   thread, appended to as it goes on, resumes included; a revert writes
 *   `rollout-<time>-<thread>_<rollout>.jsonl` beside it;
 * - `archived_sessions/<the same name>`, flat;
 * - either as `<name>.jsonl.zst`, once Codex has compressed a file idle for
 *   a week; the plain file wins where both are there.
 *
 * Each line is `{"timestamp":"…Z",["ordinal":n,]"type":…,"payload":…}`, in
 * that order. What counts, from Codex's own source (rust-v0.32.0 to 0.169.0,
 * checked at each tag):
 *
 * - From 0.153, a `token_usage_record` line for every model response, with
 *   its `response_id` and that response's usage: the only lines counted
 *   once one of the file's own thread is read. Earlier, the `token_count`
 *   events, whose running total advances with each response and whose
 *   `last_token_usage` is that response's: counted where the total moved,
 *   and none whose counters are all zero (Codex's estimates and fills).
 *   Where the total moved by more than `last` in every counter, the rest is
 *   usage no line of its own shows, as a compaction's in 0.32 to 0.34: a
 *   request of its own. A total that moved by less started again, as one
 *   does at a resume until 0.78. From 0.163 the total also moves for
 *   responses that `last` does not show, which is why the records alone
 *   count once there are any.
 * - A review runs in a subagent of its own from 0.51, with a rollout of its
 *   own, whose token counts Codex 0.51 to 0.77 also wrote into the parent's,
 *   between `entered_review_mode` and `exited_review_mode`, on the
 *   subagent's running total: none of those counts here, and a resume from
 *   0.78, which seeds the thread's total with the last of them, goes on
 *   from there. Before 0.51 the review ran in the session itself, its turn
 *   and its totals the session's, its first request begun either just
 *   before `entered_review_mode` or just after.
 * - Input includes cached and cache-written tokens, and output includes
 *   reasoning: input is what is left of it, and thinking is part of output,
 *   as the panel counts every agent's.
 * - A fork or a spawned subagent of the legacy history mode begins with a
 *   copy of its parent's history, the parent's `session_meta` first: none
 *   of it is counted here, as the parent's own file counts it. The copy is
 *   written at once, each line stamped as it is written: it ends at the
 *   child's own `thread_settings_applied` (0.144 on), or at the first line
 *   written after a pause, which the child's first response always is.
 * - The model and the effort are the latest `turn_context`'s, or
 *   `thread_settings_applied`'s, the effort none where it names none, as
 *   Codex leaves it out when none is chosen. A response read before any
 *   line named them takes the first to, where it comes in the same moment,
 *   as a subagent's first record is written just before its settings.
 *   The project is `session_meta.cwd`; a subagent's session is its root
 *   thread's (`session_id`, 0.142 on), else its parent's.
 * - A compaction is a `compacted` line the thread writes once it has
 *   answered, read from its first bytes, with no size, which Codex does not
 *   record. One before the thread's first response is the history a fork
 *   begins with (measured, 20 of 402), not a compaction of its own.
 * - A usage limit is the snapshot a 429 refusal leaves in a `token_count`,
 *   with the window that was full, or else the meter it names (`limit_id`:
 *   Codex's own `codex`, another as `premium`, which has no windows). From
 *   0.145 the snapshot can name the kind of refusal
 *   (`rate_limit_reached_type`), as the server says, and the turn's
 *   `task_complete` always does with its error, which alone tells one the
 *   server left unnamed, or one with no snapshot, as an API key's quota.
 *   From 0.41 to 0.144 the snapshot says no more than a window at 100% with
 *   no new usage, as the one a response's headers bring does: a limit
 *   reached unless a response follows it before its turn ends, or the file
 *   does. A read that ends there, the file still written, counts it, and
 *   the next withdraws it if a response follows after all.
 *
 * Only those lines are parsed: a line's type is read from its first bytes,
 * and a response's content, a tool's output or a compacted history is never
 * decoded; a turn's end and a review's, which can hold a message, are read
 * from their bytes alone. A line a crash cut short, which a resume wrote its
 * first line onto, is read from where that one begins, whatever the line cut
 * short was. Nothing derived from
 * a line's bytes is logged; a failure is a fixed category. Nothing here
 * imports `vscode`.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
    MAX_PARSED_LINE_BYTES,
    PARSER_VERSION,
    canDecodeZstd,
    eachLine,
    eachLineOfZstd,
    isUnchanged,
    openRegular,
    restartReason,
    tailHash,
    type MalformedCategory,
    type ReadCheckpoint,
} from './lines';
import { UNRECORDED_MODEL } from './modelIds';
import type { ReadResult, RootWalk } from './readers';
import type { TranscriptFile } from './transcripts';
import type { LimitHit, TranscriptKind, UsageProvider, UsageRequest } from './types';

const PROVIDER: UsageProvider = 'codex';

/**
 * The oldest parser whose rows of Codex's this one keeps. Where an older
 * one checkpointed any rollout, a pass of every file that reads Codex first
 * forgets all that was read of Codex's, and reads each rollout again whole
 * (see `UsageStore.forgetReadsBefore`): a compressed rollout read again only
 * replaces the rows whose keys it gives again, a rollout compressed since
 * it was read plain left its rows under a name that is gone, and a limit is
 * never replaced. No pass reads a rollout from such a checkpoint, which
 * stays for that pass to find: one a window not yet updated writes after
 * the forgetting, or one a pass of named files comes to first. While
 * Codex's reading is off, its rows stay as they are. Raising this forgets
 * the rows of rollouts removed since, and, until a pass reads them again,
 * those under a home the pass does not read. 6, the first parser that read
 * them, ran in builds of 2.5.0 tried before its release: those made before
 * compactions were counted counted none, and the earliest gave a response
 * its effort, its model, a review's tokens and a limit otherwise than this
 * reader does.
 */
export const CODEX_ROWS_SINCE = 7;

/** A rollout's name: its creation time, its thread, a revert's own id, and whether it is compressed. */
const ROLLOUT = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\.jsonl(\.zst)?$/i;


/**
 * The longest pause between two lines of a copy of a parent's history, in
 * files that mark its end no other way: the copy is written in one go, and
 * the child's own first response takes longer than this to come.
 */
const COPY_PAUSE_MS = 1_000;

/** Bounds on what is kept, so a hostile line cannot bloat the history. */
const MAX_ID = 200;
const MAX_MODEL = 200;
const MAX_VERSION = 50;
const MAX_CWD = 4096;
const MAX_COUNTER = 100_000_000;
const EARLIEST_TIME = Date.UTC(2023, 0, 1);
const LATEST_TIME = Date.UTC(2100, 0, 1);

/** The line types read, by their first `"type":"` value; the payload's own type for an `event_msg`. */
const TYPE_KEY = Buffer.from('"type":"');
const WANTED = new Set(['session_meta', 'turn_context', 'token_usage_record', 'compacted']);
const WANTED_EVENTS = new Set(['token_count', 'task_started', 'thread_settings_applied', 'task_complete', 'turn_aborted', 'entered_review_mode', 'exited_review_mode']);
/**
 * The lines read from their bytes alone, never parsed: a turn's end can hold
 * its last message, a review's start its prompt, a compaction the whole
 * history it replaces, megabytes of it.
 */
const UNPARSED = new Set(['task_complete', 'turn_aborted', 'entered_review_mode', 'exited_review_mode', 'compacted']);

/**
 * The longest line parsed here: twenty times the longest measured of the
 * types this reader reads (a session_meta of 50 KB; a turn_context can carry
 * a project's instructions, up to 32 KiB by default in Codex 0.78), and 1
 * MiB of nested arrays costs the worker's heap at most 36 MB to parse.
 */
const MAX_PARSED_BYTES = Math.min(MAX_PARSED_LINE_BYTES, 1 << 20);

/** How every line starts: where a line a crash cut short ends, and the next one written onto it begins. */
const LINE_START = Buffer.from('{"timestamp":"');
/** A turn's end by a usage limit (0.145 on), as only Codex's own JSON writes it: a quote in a message is escaped. */
const USAGE_LIMIT_ERROR = Buffer.from('"codex_error_info":"usage_limit_exceeded"');
/** Within how long a second sighting of a limit is the same refusal: its snapshot sent again, or its turn's end. */
const SAME_REFUSAL_MS = 5_000;
/**
 * Within how long of each other lines are written in one go: a subagent's
 * first record and the settings it ran on (measured, in the same
 * millisecond), or a review's first request and the line that starts it.
 */
const SAME_MOMENT_MS = 1_000;
/** The most responses kept waiting for their thread's settings, from one read to the next. */
const MAX_UNNAMED = 8;

/** Codex's TokenUsage: input with its cached and cache-written tokens, output with its reasoning. */
interface TokenUsage {
    input: number;
    cached: number;
    cacheWrite: number;
    output: number;
    reasoning: number;
    total: number;
}

/**
 * What a read of a rollout has made of the lines before its checkpoint, kept
 * with it: a running total means nothing without the one before it.
 */
interface RolloutState {
    /** The file's own thread: its first `session_meta`'s id, else its name's. */
    thread: string | null;
    /** The session its requests count in: its root thread's, or its parent's. */
    session: string | null;
    kind: TranscriptKind;
    /** A copy of a parent's history being read, which is not counted: when its last line was written. */
    copy: { last: number } | null;
    /** Whether a record of the file's own thread has been read: from then on only records count. */
    records: boolean;
    /** The last running total read: input, cached, cache writes, output, reasoning, total. */
    total: number[] | null;
    model: string | null;
    effort: string | null;
    /** Whether a line has named the thread's settings, its model and effort: a turn_context, or thread_settings_applied, a copy's included. */
    named: boolean;
    /** The responses read before that line, until it comes: written again with what it names, if it comes in the same moment. */
    unnamed: UsageRequest[];
    version: string | null;
    /** The last limit read, which a repeat of its event does not count again. */
    hit: { ts: number; limitType: string; resetsAt: number | null } | null;
    /**
     * A full window on a snapshot that brought no usage and names no kind of
     * refusal: the limit it was reached at, unless a response follows it.
     */
    pending: LimitHit | null;
    /** What the request's latest snapshot says a refusal of it would be of, for its turn's end to name (see `refused`). */
    snapshot: { limitType: string; resetsAt: number | null } | null;
    /** A review under way: whether it runs in this file, or a subagent's token counts are written into it. */
    review: { own: boolean } | null;
    /** Whether the file's own thread has answered: a compaction before then is the history a fork begins with. */
    responded: boolean;
    /** When the latest request began, by its turn_context, until a token count, or its turn ended: see `unparsed`. */
    opened: number | null;
    /** The last running total a review subagent's token count wrote here, until the file's own next one: what a resume from 0.78 seeds its total with. */
    forwarded: number[] | null;
    /** A pending limit counted at the end of a read, the file still written: withdrawn if a response follows it after all. */
    told: { uuid: string; ts: number; hit: RolloutState['hit'] } | null;
}

function freshState(file: TranscriptFile): RolloutState {
    return {
        thread: ROLLOUT.exec(path.basename(file.path))?.[1]?.toLowerCase() ?? null,
        session: null,
        kind: 'main',
        copy: null,
        records: false,
        total: null,
        model: null,
        effort: null,
        named: false,
        unnamed: [],
        version: null,
        hit: null,
        pending: null,
        snapshot: null,
        review: null,
        responded: false,
        opened: null,
        forwarded: null,
        told: null,
    };
}

/** The state a checkpoint kept, or a fresh one where it kept none this reader can use. */
function stateOf(file: TranscriptFile, text: string | null | undefined): RolloutState {
    if (text) {
        try {
            const kept = JSON.parse(text) as Partial<RolloutState>;
            if (kept && typeof kept === 'object' && (kept.kind === 'main' || kept.kind === 'subagent')) {
                return { ...freshState(file), ...kept };
            }
        } catch {
            // Written by this module, so never; read again from the start then.
        }
    }
    return freshState(file);
}

/**
 * Every rollout under `<root>/sessions` and `<root>/archived_sessions`,
 * found by hand, as Claude Code's transcripts are: no symlinked folder is
 * entered, only regular files are taken, and an unreadable folder is counted
 * and skipped. Of a file there both plain and compressed, the plain one.
 */
export function walkRollouts(root: string): RootWalk {
    const walk: RootWalk = { folder: null, files: [], symlinkedFolders: 0, unreadableFolders: 0, passedOver: 0 };
    for (const name of ['sessions', 'archived_sessions']) {
        let folder: string;
        try {
            folder = fs.realpathSync(path.join(root, name));
        } catch {
            continue;
        }
        walk.folder ??= folder;
        const visit = (dir: string): void => {
            let entries: fs.Dirent[];
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            } catch {
                walk.unreadableFolders++;
                return;
            }
            const names = new Set(entries.map(e => e.name));
            for (const entry of entries) {
                const full = path.join(dir, entry.name);
                if (entry.isSymbolicLink()) {
                    walk.symlinkedFolders++;
                } else if (entry.isDirectory()) {
                    visit(full);
                } else if (entry.isFile() && ROLLOUT.test(entry.name) && !(entry.name.endsWith('.zst') && names.has(entry.name.slice(0, -'.zst'.length)))) {
                    walk.files.push(rolloutFile(root, full));
                }
            }
        };
        visit(folder);
    }
    return walk;
}

/**
 * The rollouts among `paths` that lie in `<root>/sessions` or
 * `<root>/archived_sessions`, as the walk would find them, under the same
 * real path: for the files a watcher reports changed.
 */
export function rolloutsAt(root: string, paths: readonly string[]): TranscriptFile[] {
    const folders: string[] = [];
    for (const name of ['sessions', 'archived_sessions']) {
        try {
            folders.push(fs.realpathSync(path.join(root, name)));
        } catch {
            // Not there.
        }
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
        // Spelled as the walk spells it, its folder's real path and the rest:
        // on Windows a hint can name the folders in another case, and a file
        // kept under two spellings would be two files.
        let spelled: string | undefined;
        for (const folder of folders) {
            const relative = path.relative(folder, real);
            if (relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)) {
                spelled = path.join(folder, relative);
                break;
            }
        }
        const name = path.basename(real);
        if (spelled === undefined || !ROLLOUT.test(name)) {
            continue;
        }
        // The plain one is read where both are there, as the walk does.
        if (name.endsWith('.zst') && fs.existsSync(real.slice(0, -'.zst'.length))) {
            continue;
        }
        found.push(rolloutFile(root, spelled));
    }
    return found;
}

function rolloutFile(root: string, file: string): TranscriptFile {
    // A thread's session and kind are its first line's to say: see `stateOf`.
    return { path: file, root, projectDir: '', kind: 'main', sessionId: null, agentId: null, runId: null };
}

/** Whether `file` is compressed: then it is always read whole. */
export function isCompressed(file: Pick<TranscriptFile, 'path'>): boolean {
    return file.path.endsWith('.zst');
}

/**
 * Read `file` on from `previous`, or from its start when that cannot be
 * trusted or the file is compressed: a compressed rollout is a week idle,
 * and Codex writes a new plain file before it appends to one.
 *
 * @throws the file system's error, or ZSTD_UNSUPPORTED for a compressed one
 *   this runtime cannot decode, for the importer to count as a skip reason.
 */
export function readRollout(file: TranscriptFile, previous: ReadCheckpoint | undefined, progress?: () => void): ReadResult | Promise<ReadResult> {
    const { fd, state } = openRegular(file.path);
    let closing = true;
    try {
        const result: ReadResult = {
            unchanged: false,
            restarted: null,
            requests: [],
            compactions: [],
            limitHits: [],
            withdrawnLimitHits: [],
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
            checkpoint: { ...state, offset: previous?.offset ?? 0, tailHash: previous?.tailHash ?? null, parserVersion: PARSER_VERSION, readerState: null },
        };
        // A newer parser's checkpoint is that parser's to move; nothing here rewrites it.
        if (previous && (isUnchanged(previous, state) || previous.parserVersion > PARSER_VERSION)) {
            return { ...result, unchanged: true, checkpoint: previous };
        }
        const compressed = isCompressed(file);
        result.restarted = !previous ? 'new' : compressed ? 'replaced' : restartReason(fd, state, previous, CODEX_ROWS_SINCE);
        const start = result.restarted === null ? (previous?.offset ?? 0) : 0;
        result.checkpoint.offset = start;
        const reading = new Reading(file, result, stateOf(file, start > 0 ? previous?.readerState : null));
        const use = (line: Buffer, offset: number) => reading.line(line, offset);
        const oversize = () => reading.oversize();
        const consumed = (offset: number) => {
            result.checkpoint.offset = offset;
        };
        if (compressed) {
            if (!canDecodeZstd()) {
                throw Object.assign(new Error('no zstd decoder'), { code: 'ZSTD_UNSUPPORTED' });
            }
            closing = false;
            return eachLineOfZstd(fd, use, oversize, consumed, progress)
                .then(() => reading.finish(null))
                .finally(() => fs.closeSync(fd));
        }
        eachLine(fd, start, state.size, use, oversize, consumed, progress);
        return reading.finish(tailHash(fd, result.checkpoint.offset));
    } finally {
        if (closing) {
            fs.closeSync(fd);
        }
    }
}

/** One read of a rollout in progress. */
class Reading {
    constructor(
        private readonly file: TranscriptFile,
        private readonly result: ReadResult,
        private readonly state: RolloutState,
    ) {}

    finish(tail: string | null): ReadResult {
        // The file ends where a refusal's turn did, or, still written, ends
        // for now: what is counted then is withdrawn if a response follows
        // after all (see `limit`).
        const pending = this.state.pending;
        if (pending) {
            const hit = this.state.hit;
            this.settle();
            this.state.told = { uuid: pending.uuid, ts: pending.timestamp, hit };
        }
        this.result.checkpoint.tailHash = tail;
        this.result.checkpoint.readerState = JSON.stringify(this.state);
        this.result.sessionId = this.state.session ?? this.state.thread;
        this.result.kind = this.state.kind;
        this.result.newestVersion = this.state.version;
        return this.result;
    }

    oversize(): void {
        this.result.oversize++;
        this.count('oversize');
    }

    line(bytes: Buffer, offset: number, resumed = false): void {
        const type = lineType(bytes);
        if (type === null) {
            // Of a type not read: it may be one a crash cut short, which a
            // resume wrote a line of a type read onto.
            if (!resumed) {
                this.resumedOnto(bytes, offset);
            }
            return;
        }
        if (UNPARSED.has(type)) {
            // Read from its bytes, and so never failing to parse: a crash may
            // have cut it short all the same, and a resume written onto it.
            const next = resumed ? -1 : lastLineStart(bytes, Math.max(1, bytes.length - MAX_PARSED_BYTES));
            if (next > 0) {
                this.unparsed(type, bytes.subarray(0, next));
                return this.line(bytes.subarray(next), offset + next, true);
            }
            return this.unparsed(type, bytes);
        }
        if (bytes.length > MAX_PARSED_BYTES) {
            // A line this reader would use, too long to parse safely.
            this.oversize();
            return;
        }
        let record: unknown;
        try {
            record = JSON.parse(bytes.toString('utf8'));
        } catch {
            // Never the error's message: it quotes the line.
            this.count('json-syntax');
            // A line a crash cut short, which a resume wrote its first line
            // onto: that one is whole, and read.
            const next = resumed ? -1 : lastLineStart(bytes, 1);
            if (next > 0) {
                this.line(bytes.subarray(next), offset + next, true);
            }
            return;
        }
        const r = objectOf(record);
        const payload = objectOf(r?.payload);
        if (!r || !payload) {
            this.count('not-object');
            return;
        }
        const ts = recordTime(r.timestamp);
        if (ts === null) {
            this.count('bad-field:timestamp');
            return;
        }
        // A copy of a parent's history ends where a line no longer belongs to it.
        const copy = this.state.copy;
        if (copy && !this.inCopy(type, payload, ts, copy)) {
            this.state.copy = null;
        }
        switch (type) {
            case 'session_meta':
                return this.meta(payload, ts);
            case 'turn_context':
                // A request begins: see `unparsed`.
                this.state.opened = ts;
                return this.context(payload, ts);
            case 'token_usage_record':
                return this.record(payload, ts, offset);
            case 'token_count':
                return this.tokenCount(payload, ts, offset);
            case 'thread_settings_applied':
                return this.settings(payload, ts);
            case 'task_started':
                this.state.opened = null;
                return this.begin();
            default:
                return;
        }
    }

    /**
     * Where a line ends with the start of another, a crash cut it short and a
     * resume wrote its first line onto it: that one is read, where it is of a
     * type read. Looked for as far back from the end as a line still parsed
     * reaches, no further: the line cut short can be megabytes of a
     * response's, and a longer one written onto it would not be parsed.
     */
    private resumedOnto(bytes: Buffer, offset: number): void {
        const at = lastLineStart(bytes, Math.max(1, bytes.length - MAX_PARSED_BYTES));
        if (at !== -1) {
            this.line(bytes.subarray(at), offset + at, true);
        }
    }

    /** An event read from its bytes alone: a turn's end, or a review's start or end. */
    private unparsed(type: string, bytes: Buffer): void {
        const ts = lineTime(bytes);
        if (ts === null) {
            this.count('bad-field:timestamp');
            return;
        }
        const copy = this.state.copy;
        if (copy && !this.inCopy(type, {}, ts, copy)) {
            this.state.copy = null;
        }
        if (this.state.copy) {
            return;
        }
        if (type === 'task_complete') {
            this.state.opened = null;
            this.settle();
            // A turn a usage limit ended, which its snapshot, if any, did not name: an API key's quota.
            if (bytes.includes(USAGE_LIMIT_ERROR)) {
                this.refused(ts);
            }
        } else if (type === 'turn_aborted') {
            // The request under way ended with no count: nothing begun is left.
            this.state.opened = null;
        } else if (type === 'compacted') {
            this.compacted(ts);
        } else if (type === 'entered_review_mode') {
            // Before 0.51 the review ran here, its first request begun just
            // after this, or, raced, just before, with no count since. From
            // 0.51 it runs in a subagent, and a request this file began was
            // ended first, aborted: not yet known to run here (see `forwarded`).
            const opened = this.state.opened;
            this.state.review = { own: opened !== null && ts - opened <= SAME_MOMENT_MS };
        } else {
            this.state.review = null;
        }
    }

    /**
     * Whether a line still belongs to a copy of a parent's history: none from
     * the child's own settings on, nor one written after a pause. A turn's
     * lines do not tell: the copy holds every turn of the parent's, each as
     * new as the child's first.
     */
    private inCopy(type: string, payload: Record<string, unknown>, ts: number, copy: { last: number }): boolean {
        if (type === 'thread_settings_applied' && boundedString(payload.thread_id, MAX_ID)?.toLowerCase() === this.state.thread) {
            return false;
        }
        if (ts - copy.last > COPY_PAUSE_MS) {
            return false;
        }
        copy.last = Math.max(copy.last, ts);
        return true;
    }

    private meta(payload: Record<string, unknown>, ts: number): void {
        const id = boundedString(payload.id, MAX_ID)?.toLowerCase() ?? null;
        if (this.state.session !== null) {
            // The file's own is its first: a later one of another thread opens
            // a copy of that thread's history, or is part of the one being read.
            if (id !== null && id !== this.state.thread && !this.state.copy) {
                this.state.copy = { last: ts };
            }
            return;
        }
        this.state.thread = id ?? this.state.thread;
        const source = objectOf(payload.source);
        const subagent = source ? source.subagent : undefined;
        const spawn = objectOf(objectOf(subagent)?.thread_spawn);
        const parent = boundedString(spawn?.parent_thread_id, MAX_ID) ?? boundedString(payload.parent_thread_id, MAX_ID);
        const root = boundedString(payload.session_id, MAX_ID)?.toLowerCase() ?? null;
        this.state.kind = subagent !== undefined ? 'subagent' : 'main';
        // A subagent's session is its root thread's; some legacy ones named their own, and count with their parent's.
        this.state.session =
            root !== null && (root !== this.state.thread || this.state.kind === 'main' || parent === null) ? root : (parent?.toLowerCase() ?? this.state.thread);
        this.state.version = boundedString(payload.cli_version, MAX_VERSION) ?? this.state.version;
        const cwd = boundedString(payload.cwd, MAX_CWD);
        if (cwd) {
            this.result.firstCwd = cwd;
            this.result.firstCwdTs = ts;
        }
    }

    /**
     * The model and effort in force from here on. A copy's are its parent's,
     * which the child's own then replace: one whose first context fell in
     * the copy runs on its parent's, not on none.
     */
    private context(payload: Record<string, unknown>, ts: number): void {
        // A request begins, and a review that shows one runs here.
        this.begin();
        if (this.state.review) {
            this.state.review.own = true;
        }
        this.name(boundedString(payload.model, MAX_MODEL), word(payload.effort), ts);
    }

    private settings(payload: Record<string, unknown>, ts: number): void {
        const settings = objectOf(payload.thread_settings);
        this.name(boundedString(settings?.model, MAX_MODEL), word(settings?.reasoning_effort), ts);
    }

    /**
     * The thread's settings from here on: its model, and its effort, none
     * where none is named, as Codex leaves it out when none is chosen. The
     * first line to name them names the responses read before it too, where
     * it comes in the same moment, as a subagent's settings come just after
     * its first record: in this read, or, read up to that record before, in
     * the next, which writes them again. Responses from further back ran
     * before Codex recorded a model, as 0.32 to 0.34 did not, or on what a
     * resume has since changed: they stay as read.
     */
    private name(model: string | null, effort: string | null, ts: number): void {
        this.state.model = model ?? this.state.model;
        this.state.effort = effort;
        if (this.state.named) {
            return;
        }
        this.state.named = true;
        const named = this.state.model;
        for (const request of this.state.unnamed.splice(0)) {
            if (named === null || ts - request.timestamp > SAME_MOMENT_MS) {
                continue;
            }
            const inThisRead = this.result.requests.includes(request);
            request.model = named;
            request.effort = effort;
            request.parserVersion = PARSER_VERSION;
            if (!inThisRead) {
                this.result.requests.push(request);
            }
        }
    }

    /**
     * A model response's own record, 0.153 on: counted for the file's own
     * thread, once, by its id. A copy of a parent's history holds the
     * parent's, which name the parent.
     */
    private record(payload: Record<string, unknown>, ts: number, offset: number): void {
        const thread = boundedString(payload.thread_id, MAX_ID)?.toLowerCase();
        const responseId = boundedString(payload.response_id, MAX_ID);
        if (!thread || !responseId) {
            this.count('bad-field:token_usage_record');
            return;
        }
        if (thread !== this.state.thread) {
            return;
        }
        this.state.records = true;
        const usage = this.usage(objectOf(payload.usage), 'usage');
        if (usage) {
            this.push(`r:${thread}:${responseId}`, responseId, ts, offset, usage);
        }
    }

    /** A running total, and the snapshot of the limits it carries. */
    private tokenCount(payload: Record<string, unknown>, ts: number, offset: number): void {
        // The request under way has answered, or been refused.
        this.state.opened = null;
        const info = objectOf(payload.info);
        const total = info ? this.usage(objectOf(info.total_token_usage), 'total_token_usage') : undefined;
        if (this.forwarded(info, total)) {
            return;
        }
        const fresh = info && total ? this.running(info, total, ts, offset) : false;
        this.limit(objectOf(payload.rate_limits), ts, fresh);
    }

    /**
     * A running total that moved: the response it moved by, counted, and
     * what it moved by beyond that response, in every counter, a request of
     * its own. Whether it shows a response's usage.
     */
    private running(info: Record<string, unknown>, total: TokenUsage, ts: number, offset: number): boolean {
        const tuple = [total.input, total.cached, total.cacheWrite, total.output, total.reasoning, total.total];
        // The file's first own total after a review subagent's: a resume
        // from 0.78 seeds the thread's with the last one the subagent wrote
        // here, and goes on from it, the review counted in its own file.
        const seed = this.state.forwarded;
        this.state.forwarded = null;
        const seedLast = seed ? this.usage(objectOf(info.last_token_usage), 'last_token_usage', true) : undefined;
        const seeded = seed !== null && (sameTotal(tuple, seed) || (seedLast !== undefined && sameTotal(tuple, seed.map((n, i) => n + stepsOf(seedLast)[i]))));
        const before = seeded ? seed : this.state.total;
        const repeated = before !== null && tuple.every((n, i) => n === before[i]);
        this.state.total = tuple;
        // A copy is its parent's to count, a repeat was counted, and from a
        // file's first record on only records count.
        if (this.state.copy || repeated || this.state.records) {
            return false;
        }
        const last = this.usage(objectOf(info.last_token_usage), 'last_token_usage');
        // Codex's estimates and fills carry no counter but the total.
        if (!last || last.input + last.cached + last.cacheWrite + last.output + last.reasoning === 0) {
            return false;
        }
        const key = `t:${this.state.thread ?? ''}:${ts}:${tuple.join(',')}`;
        // Usage the total took in with no line of its own; a total that moved
        // by less started again, at a resume.
        const rest = before === null ? null : beyond(tuple, before, last);
        if (rest) {
            this.push(`${key}:rest`, null, ts, offset, rest);
        }
        this.push(key, null, ts, offset, last);
        return true;
    }

    /**
     * Whether a token count is a review subagent's, which Codex 0.51 to 0.77
     * wrote into its parent's file on the subagent's own running total: one
     * in a review that has shown no turn of its own here, and does not go on
     * from this file's total. A review that runs here, as before 0.51, shows
     * its turn, or goes on from the session's total, and counts as the rest.
     */
    private forwarded(info: Record<string, unknown> | undefined, total: TokenUsage | undefined): boolean {
        const review = this.state.review;
        if (!review || review.own) {
            return false;
        }
        const before = this.state.total;
        const last = info ? this.usage(objectOf(info.last_token_usage), 'last_token_usage', true) : undefined;
        const tuple = total ? [total.input, total.cached, total.cacheWrite, total.output, total.reasoning, total.total] : null;
        if (tuple && last && before !== null) {
            const steps = stepsOf(last);
            if (sameTotal(tuple, before) || sameTotal(tuple, before.map((n, i) => n + steps[i]))) {
                review.own = true;
                return false;
            }
        }
        // The subagent's: its last total kept, which a resume can go on from.
        this.state.forwarded = tuple ?? this.state.forwarded;
        return true;
    }

    /**
     * A usage limit, where a 429 refusal left its snapshot: the window that
     * was full, and when it resets. One that names its kind of refusal is a
     * limit reached; in the shape of a snapshot before Codex 0.145, which
     * named none, a full window that brought no usage is one unless a
     * response follows before its turn ends (see `settle`).
     */
    private limit(snapshot: Record<string, unknown> | undefined, ts: number, fresh: boolean): void {
        if (fresh) {
            // A response came: the snapshot before it was its headers', not a refusal.
            this.state.pending = null;
            const told = this.state.told;
            if (told) {
                // Counted where a read ended, before the response it was the headers of.
                this.state.told = null;
                this.result.withdrawnLimitHits?.push(told.uuid);
                if (this.state.hit?.ts === told.ts) {
                    this.state.hit = told.hit;
                }
            }
        }
        if (!snapshot || this.state.copy) {
            return;
        }
        const reached = word(snapshot.rate_limit_reached_type);
        const windows = [objectOf(snapshot.secondary), objectOf(snapshot.primary)].filter((w): w is Record<string, unknown> => w !== undefined);
        const full = windows.find(w => typeof w.used_percent === 'number' && w.used_percent >= 100);
        // A limit is its full window's, else its meter's: Codex's own is `codex`, and another, as `premium`, has no windows.
        const meter = word(snapshot.limit_id);
        this.state.snapshot = {
            limitType: full ? windowName(full.window_minutes) : meter !== null && meter !== 'codex' ? meter : 'usage',
            resetsAt: full ? (resetTime(full.resets_at) ?? resetAfter(full.resets_in_seconds, ts)) : null,
        };
        // Codex 0.145 added this field with the kind of refusal: a snapshot that has it and names none is left to its turn's end.
        const names = Object.hasOwn(snapshot, 'spend_control_reached');
        if (!reached && (!full || fresh || names)) {
            return;
        }
        const sessionId = this.state.session ?? this.state.thread;
        if (!sessionId) {
            return;
        }
        const hit: LimitHit = {
            provider: PROVIDER,
            uuid: `${this.state.thread ?? ''}:${ts}`,
            sessionId,
            timestamp: ts,
            limitType: !reached || reached === 'rate_limit_reached' ? this.state.snapshot.limitType : (WORKSPACE_LIMITS[reached] ?? 'usage'),
            resetsAt: this.state.snapshot.resetsAt,
            owner: null,
        };
        if (reached) {
            this.confirm(hit);
        } else if (!this.state.told) {
            // The first of a refusal's snapshots, sent again a moment later.
            // One counted where a read ended is still its turn's first, as a
            // whole read keeps it: withdrawn, or standing, as that one is.
            this.state.pending ??= hit;
        }
    }

    /** A compaction of the thread's own history, once it has answered: Codex records no size. */
    private compacted(ts: number): void {
        const sessionId = this.state.session ?? this.state.thread;
        if (!this.state.responded || !sessionId) {
            return;
        }
        this.result.compactions.push({
            provider: PROVIDER,
            uuid: `${this.state.thread ?? ''}:${ts}`,
            sessionId,
            kind: this.state.kind,
            timestamp: ts,
            trigger: null,
            preTokens: null,
            postTokens: null,
        });
    }

    /** A turn or a request begins: whatever was refused before it is settled, and its own snapshots are yet to come. */
    private begin(): void {
        this.settle();
        this.state.snapshot = null;
    }

    /** A turn ends or a request begins, or the file does: a full window no response followed was a limit reached. */
    private settle(): void {
        // A limit counted where a read ended stands once its turn is over.
        this.state.told = null;
        const pending = this.state.pending;
        if (pending) {
            this.state.pending = null;
            this.confirm(pending);
        }
    }

    /** A limit reached, once though its refusal's snapshot comes again a moment later. */
    private confirm(hit: LimitHit): void {
        const before = this.state.hit;
        this.state.hit = { ts: hit.timestamp, limitType: hit.limitType, resetsAt: hit.resetsAt };
        if (before && before.limitType === hit.limitType && before.resetsAt === hit.resetsAt && hit.timestamp - before.ts < SAME_REFUSAL_MS) {
            return;
        }
        this.result.limitHits.push(hit);
    }

    /**
     * A turn a usage limit ended (0.145 on): a limit reached, unless its
     * snapshot just was one, of what the request's latest snapshot says,
     * where one does: the server need not name a refusal's kind.
     */
    private refused(ts: number): void {
        const before = this.state.hit;
        const sessionId = this.state.session ?? this.state.thread;
        if ((before && ts - before.ts < SAME_REFUSAL_MS) || !sessionId) {
            return;
        }
        const { limitType, resetsAt } = this.state.snapshot ?? { limitType: 'usage', resetsAt: null };
        this.confirm({ provider: PROVIDER, uuid: `${this.state.thread ?? ''}:${ts}`, sessionId, timestamp: ts, limitType, resetsAt, owner: null });
    }

    /**
     * Codex's TokenUsage, its counters checked, or undefined, counted as a
     * bad field, unless `quiet` (a look ahead of the line's own read), when
     * one is not a count.
     */
    private usage(u: Record<string, unknown> | undefined, field: string, quiet = false): TokenUsage | undefined {
        if (!u) {
            if (!quiet) {
                this.count(`bad-field:${field}`);
            }
            return undefined;
        }
        const n = (value: unknown, fallback?: number): number | null =>
            value === undefined && fallback !== undefined ? fallback : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_COUNTER * 100 ? value : null;
        const counts = {
            input: n(u.input_tokens),
            cached: n(u.cached_input_tokens),
            // From 0.145; missing means none, as Codex reads it.
            cacheWrite: n(u.cache_write_input_tokens, 0),
            output: n(u.output_tokens),
            reasoning: n(u.reasoning_output_tokens),
            total: n(u.total_tokens),
        };
        if (Object.values(counts).some(v => v === null)) {
            if (!quiet) {
                this.count(`bad-field:${field}`);
            }
            return undefined;
        }
        return counts as TokenUsage;
    }

    private push(
        messageId: string,
        responseId: string | null,
        ts: number,
        offset: number,
        u: { input: number; cached: number; cacheWrite: number; output: number; reasoning: number },
    ): void {
        const session = this.state.session ?? this.state.thread;
        if (!session || [u.input, u.output].some(v => v > MAX_COUNTER)) {
            this.count('bad-field:usage');
            return;
        }
        this.state.responded = true;
        // Cached and cache-written tokens are part of the input, and reasoning part of the output.
        const cacheRead = Math.min(u.cached, u.input);
        const cacheCreation = Math.min(u.cacheWrite, u.input - cacheRead);
        const request: UsageRequest = {
            provider: PROVIDER,
            messageId,
            requestId: responseId,
            sessionId: session,
            kind: this.state.kind,
            isMain: true,
            timestamp: ts,
            model: this.state.model ?? UNRECORDED_MODEL,
            variant: null,
            speed: null,
            inferenceGeo: null,
            input: u.input - cacheRead - cacheCreation,
            cacheCreation,
            cacheRead,
            output: u.output,
            cacheWrite5m: null,
            cacheWrite1h: null,
            thinking: Math.min(u.reasoning, u.output),
            effort: this.state.effort,
            webSearchRequests: null,
            webFetchRequests: null,
            claudeCodeVersion: this.state.version,
            agentId: this.state.kind === 'subagent' ? this.state.thread : null,
            runId: null,
            file: this.file.path,
            byteOffset: offset,
            parserVersion: PARSER_VERSION,
            owner: null,
        };
        this.result.requests.push(request);
        if (!this.state.named && this.state.unnamed.length < MAX_UNNAMED) {
            this.state.unnamed.push(request);
        }
    }

    private count(category: MalformedCategory): void {
        this.result.malformed.set(category, (this.result.malformed.get(category) ?? 0) + 1);
    }
}

/**
 * The type of a line worth parsing, from its bytes, or null: the first
 * `"type":"` is the line's own, which Codex writes before its payload, and
 * an event's own type is the next one, its payload's first field.
 */
function lineType(bytes: Buffer): string | null {
    const first = bytes.indexOf(TYPE_KEY);
    // The envelope's type comes after its time and ordinal, within its first bytes.
    if (first === -1 || first > 120) {
        return null;
    }
    const type = valueAt(bytes, first + TYPE_KEY.length);
    if (type === null) {
        return null;
    }
    if (WANTED.has(type)) {
        return type;
    }
    if (type !== 'event_msg') {
        return null;
    }
    const second = bytes.indexOf(TYPE_KEY, first + TYPE_KEY.length);
    const event = second === -1 || second > first + 64 ? null : valueAt(bytes, second + TYPE_KEY.length);
    return event !== null && WANTED_EVENTS.has(event) ? event : null;
}

/** The short string value that starts at `at`, up to its closing quote, or null. */
function valueAt(bytes: Buffer, at: number): string | null {
    const end = bytes.indexOf(0x22, at);
    return end === -1 || end - at > 40 ? null : bytes.toString('latin1', at, end);
}

/** The limits a workspace sets, by the kind of refusal Codex records: its credits spent, or its usage limit. */
const WORKSPACE_LIMITS: Record<string, string> = {
    workspace_owner_credits_depleted: 'workspace_credits',
    workspace_member_credits_depleted: 'workspace_credits',
    workspace_owner_usage_limit_reached: 'workspace_usage',
    workspace_member_usage_limit_reached: 'workspace_usage',
};

/** A rate-limit window's name, by its length: Codex's are five hours and a week. */
function windowName(minutes: unknown): string {
    if (minutes === 300) {
        return 'five_hour';
    }
    if (minutes === 10_080) {
        return 'weekly';
    }
    return typeof minutes === 'number' && Number.isSafeInteger(minutes) && minutes > 0 ? `${minutes}_minute` : 'usage';
}

/** A window's reset time in epoch seconds: a number, or an RFC 3339 string in old files. */
function resetTime(value: unknown): number | null {
    const ms = typeof value === 'number' ? value * 1000 : typeof value === 'string' ? Date.parse(value) : NaN;
    return Number.isFinite(ms) && ms >= EARLIEST_TIME && ms < LATEST_TIME ? Math.floor(ms / 1000) : null;
}

/** A window's reset time as Codex 0.41 to 0.47 wrote it: in how many seconds from the snapshot. */
function resetAfter(seconds: unknown, ts: number): number | null {
    return typeof seconds === 'number' && Number.isSafeInteger(seconds) && seconds >= 0 ? resetTime(Math.floor(ts / 1000) + seconds) : null;
}

/**
 * What a running total moved by beyond the response `last` shows, where it
 * moved by no less in any counter and by more in its input or output; null
 * where it moved by just that, or started again.
 */
function beyond(total: number[], before: number[], last: TokenUsage): TokenUsage | null {
    const steps = [last.input, last.cached, last.cacheWrite, last.output, last.reasoning, last.total];
    const rest = total.map((n, i) => n - before[i] - steps[i]);
    if (rest.slice(0, 5).some(n => n < 0) || (rest[0] <= 0 && rest[3] <= 0)) {
        return null;
    }
    return { input: rest[0], cached: rest[1], cacheWrite: rest[2], output: rest[3], reasoning: rest[4], total: Math.max(0, rest[5]) };
}

/** Where the last line in `bytes` begins, from `from` on, or -1: searched forward, twice as fast as back. */
function lastLineStart(bytes: Buffer, from: number): number {
    let at = bytes.indexOf(LINE_START, from);
    if (at === -1) {
        return -1;
    }
    for (let next = bytes.indexOf(LINE_START, at + 1); next !== -1; next = bytes.indexOf(LINE_START, next + 1)) {
        at = next;
    }
    return at;
}

/** A TokenUsage's counters in the order of a running total's. */
function stepsOf(u: TokenUsage): number[] {
    return [u.input, u.cached, u.cacheWrite, u.output, u.reasoning, u.total];
}

function sameTotal(a: readonly number[], b: readonly number[]): boolean {
    return a.length === b.length && a.every((n, i) => n === b[i]);
}

function recordTime(value: unknown): number | null {
    const time = typeof value === 'string' ? Date.parse(value) : NaN;
    return Number.isFinite(time) && time >= EARLIEST_TIME && time < LATEST_TIME ? time : null;
}

/** A line's time, from its first bytes, where it opens as every line Codex writes does. */
function lineTime(bytes: Buffer): number | null {
    if (bytes.indexOf(LINE_START) !== 0) {
        return null;
    }
    const end = bytes.indexOf(0x22, LINE_START.length);
    return end === -1 || end - LINE_START.length > 40 ? null : recordTime(bytes.toString('latin1', LINE_START.length, end));
}

function objectOf(value: unknown): Record<string, unknown> | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function boundedString(value: unknown, max: number): string | null {
    return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}

/** A word as Codex writes its enums: lower case, digits and underscores. */
function word(value: unknown): string | null {
    return typeof value === 'string' && /^[a-z][a-z0-9_-]{0,39}$/.test(value) ? value : null;
}
