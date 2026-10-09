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
