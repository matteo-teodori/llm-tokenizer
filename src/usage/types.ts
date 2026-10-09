/**
 * The domain of Claude Code usage: what one request is, as read from Claude
 * Code's own session records, and what an aggregate of them reports.
 *
 * No file system and no `vscode` here or in the other core modules
 * (provenance, model ids, accounting, rollups), so they can be tested, and
 * their rules read, on their own.
 *
 * Counters are `null` when a record did not report them, never 0: a real zero
 * and an unknown are different facts, and a total that includes an unknown is
 * only a lower bound (see `provenance.ts`).
 */

/** Every key carries its provider, so a second one costs no migration. */
export type UsageProvider = 'claude-code';

/**
 * Which kind of transcript a request was read from. Main, task and workflow
 * partition a session's total: a subagent's requests are written only to its
 * own file, never also to its parent's.
 *
 * - `main`: `<project>/<session>.jsonl`, and its documented set-aside copies;
 * - `task`: `<project>/<session>/subagents/agent-<id>.jsonl`;
 * - `workflow`: `…/subagents/workflows/wf_<run>/agent-<id>.jsonl`;
 * - `other`: a `.jsonl` at a path not recognised, that still holds usage.
 */
export type TranscriptKind = 'main' | 'task' | 'workflow' | 'other';

/**
 * The four categories a request's tokens fall into. `input` excludes the
 * cache, as in the API and in Claude Code's OpenTelemetry metric, so the four
 * add up to what was processed.
 */
export interface TokenCounts {
    input: number | null;
    cacheCreation: number | null;
    cacheRead: number | null;
    output: number | null;
}

/** One request: the record chosen to represent one `message.id`. */
export interface UsageRequest extends TokenCounts {
    provider: UsageProvider;
    /** The request's key, global across files and roots. */
    messageId: string;
    /** An attribute only: OpenTelemetry joins on it. */
    requestId: string | null;
    sessionId: string;
    kind: TranscriptKind;
    /** The main chain, as opposed to a sidechain copy of it. */
    isMain: boolean;
    /** UTC epoch milliseconds. */
    timestamp: number;
    /** `message.model`, verbatim; never mapped through the tokenizer registry. */
    model: string;
    /** A routing suffix such as `1m`, from `requestedModel`'s brackets. */
    variant: string | null;
    /** Cache writes split by time to live; together they are `cacheCreation`. */
    cacheWrite5m: number | null;
    cacheWrite1h: number | null;
    /** Part of `output`, never in addition to it. */
    thinking: number | null;
    effort: string | null;
    webSearchRequests: number | null;
    webFetchRequests: number | null;
    claudeCodeVersion: string | null;
    agentId: string | null;
    runId: string | null;
    /** Where the record was read: the comparator's last tie-break. */
    file: string;
    byteOffset: number;
    /** The parser that produced the row; a newer one always wins. */
    parserVersion: number;
}

/** A context compaction: how many tokens a session held before and after it. */
export interface Compaction {
    uuid: string;
    sessionId: string;
    /** The transcript it was in: a subagent compacts its own context. */
    kind: TranscriptKind;
    timestamp: number;
    trigger: string | null;
    preTokens: number | null;
    postTokens: number | null;
}

/**
 * A request Claude Code was refused because a usage limit was reached. A log
 * of hits, not a gauge of how much of an allowance is used.
 */
export interface LimitHit {
    uuid: string;
    sessionId: string;
    timestamp: number;
    limitType: string;
    resetsAt: number | null;
}

/** What one import learnt about a session, merged into what is stored. */
export interface SessionSighting {
    sessionId: string;
    root: string;
    /**
     * The first cwd this import read in one of its main transcripts, and the
     * time of the record that carried it. The earliest one seen is kept,
     * whatever order the files are read in: `/cd` and EnterWorktree move a
     * session's main transcript to another project folder.
     */
    cwd: string | null;
    cwdTs: number | null;
    projectDir: string;
    firstTs: number | null;
    lastTs: number | null;
}

/** One group of the store's bucket sums: counters summed, a missing one adding nothing. */
export interface BucketSums {
    /** `floor(ts / BUCKET_MS)`. */
    bucket: number;
    sessionId: string;
    model: string;
    variant: string | null;
    kind: TranscriptKind;
    effort: string | null;
    requests: number;
    /** Requests that reported all four counters. */
    completeRequests: number;
    firstTs: number;
    lastTs: number;
    input: number;
    cacheCreation: number;
    cacheRead: number;
    output: number;
    cacheWrite5m: number;
    cacheWrite1h: number;
    thinking: number;
    webSearchRequests: number;
    webFetchRequests: number;
}

export interface StoreCoverage {
    /** The oldest and newest request held, of any range. */
    start: number | null;
    newest: number | null;
    requests: number;
    files: number;
    oversizeLines: number;
    malformedLines: number;
}
