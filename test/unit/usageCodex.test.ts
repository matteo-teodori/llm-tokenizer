import * as assert from 'assert';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';

import { CODEX_ROWS_SINCE, readRollout, rolloutsAt, walkRollouts } from '../../src/usage/codex';
import { UNRECORDED_MODEL } from '../../src/usage/modelIds';
import { importSources, importUnderLease } from '../../src/usage/importer';
import { PARSER_VERSION, eachLineOfZstd } from '../../src/usage/lines';
import { queryReport } from '../../src/usage/queries';
import { resolveCodexRoots } from '../../src/usage/roots';
import type { ReadResult } from '../../src/usage/readers';
import { UsageStore, loadSqlite } from '../../src/usage/store';
import type { TranscriptFile } from '../../src/usage/transcripts';

/*
 * Codex's rollouts, as its recorder writes them: shapes from its source
 * (codex-rs at rust-v0.172.0 and earlier tags: RolloutLineRef, SessionMeta,
 * TurnContextItem, TokenCountEvent, TokenUsageRecord), values invented.
 */

const sqlite = loadSqlite();

const THREAD = '019a0000-0000-7000-8000-000000000001';
const PARENT = '019a0000-0000-7000-8000-0000000000aa';
const ROOT = '019a0000-0000-7000-8000-0000000000bb';
const at = (second: number) => new Date(Date.UTC(2026, 10, 5, 10) + Math.round(second * 1000)).toISOString();

/** One line as Codex writes it: its time, then its type and payload. */
function line(second: number, type: string, payload: object): string {
    return `${JSON.stringify({ timestamp: at(second), type, payload })}\n`;
}

function meta(second: number, fields: Record<string, unknown> = {}): string {
    return line(second, 'session_meta', {
        session_id: fields.id ?? THREAD,
        id: THREAD,
        timestamp: at(second),
        cwd: '/Users/dev/projects/demo-app',
        originator: 'codex_cli_rs',
        cli_version: '0.169.0',
        source: 'cli',
        model_provider: 'openai',
        base_instructions: { text: 'You are Codex.' },
        ...fields,
    });
}

function context(second: number, model: string, fields: Record<string, unknown> = {}): string {
    return line(second, 'turn_context', { cwd: '/Users/dev/projects/demo-app', approval_policy: 'on-request', model, effort: 'medium', summary: 'auto', ...fields });
}

/** The k-th response's usage, distinct and checkable. */
function usage(k: number, cacheWrite = true) {
    const input = 10_000 + 1_000 * k;
    const output = 300 + 10 * k;
    return {
        input_tokens: input,
        cached_input_tokens: 4_000 + 100 * k,
        ...(cacheWrite ? { cache_write_input_tokens: 10 + k } : {}),
        output_tokens: output,
        reasoning_output_tokens: 100 + k,
        total_tokens: input + output,
    };
}

function sum(...ks: number[]) {
    const parts = ks.map(k => usage(k));
    const add = (key: keyof ReturnType<typeof usage>) => parts.reduce((n, u) => n + (u[key] ?? 0), 0);
    return {
        input_tokens: add('input_tokens'),
        cached_input_tokens: add('cached_input_tokens'),
        cache_write_input_tokens: add('cache_write_input_tokens'),
        output_tokens: add('output_tokens'),
        reasoning_output_tokens: add('reasoning_output_tokens'),
        total_tokens: add('total_tokens'),
    };
}

function tokenCount(second: number, total: object | null, last: object | null, rateLimits: object | null = null): string {
    return line(second, 'event_msg', {
        type: 'token_count',
        info: total && last ? { total_token_usage: total, last_token_usage: last, model_context_window: 272_000 } : null,
        rate_limits: rateLimits,
    });
}

function record(second: number, k: number, thread = THREAD): string {
    return line(second, 'token_usage_record', {
        thread_id: thread,
        turn_id: `turn-${k}`,
        session_id: thread,
        root_turn_id: `turn-${k}`,
        response_id: `resp_${k}`,
        usage: usage(k),
        turn_token_usage: usage(k),
        thread_token_usage: usage(k),
    });
}

/** What the panel counts for the k-th response: input left of the cache, thinking part of the output. */
function counted(k: number, cacheWrite = true) {
    const u = usage(k, cacheWrite);
    const write = cacheWrite ? 10 + k : 0;
    return { input: u.input_tokens - u.cached_input_tokens - write, cacheRead: u.cached_input_tokens, cacheCreation: write, output: u.output_tokens, thinking: u.reasoning_output_tokens };
}

const tokensOf = (r: { input: number | null; cacheRead: number | null; cacheCreation: number | null; output: number | null; thinking: number | null }) => ({
    input: r.input,
    cacheRead: r.cacheRead,
    cacheCreation: r.cacheCreation,
    output: r.output,
    thinking: r.thinking,
});

suite('usage Codex rollouts', () => {
    let home: string;

    setup(() => {
        home = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-tokenizer-codex-'));
    });

    teardown(() => {
        fs.rmSync(home, { recursive: true, force: true });
    });

    /** Write a rollout under `sessions/2026/11/05/`, or another folder of the home. */
    function rollout(lines: string[], thread = THREAD, folder = path.join('sessions', '2026', '11', '05')): string {
        const dir = path.join(home, folder);
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `rollout-2026-11-05T11-00-00-${thread}.jsonl`);
        fs.writeFileSync(file, lines.join(''));
        return file;
    }

    const fileOf = (file: string): TranscriptFile => ({ path: file, root: home, projectDir: '', kind: 'main', sessionId: null, agentId: null, runId: null });

    async function read(file: string, previous?: Parameters<typeof readRollout>[1]): Promise<ReadResult> {
        return readRollout(fileOf(file), previous);
    }

    test("a thread's records are its requests: each response once, by its id, on the model in force, its input what is left of the cache, its thinking part of its output", async () => {
        const file = rollout([
            meta(0),
            context(1, 'gpt-5.5'),
            record(5, 1),
            tokenCount(6, usage(1), usage(1)),
            context(7, 'gpt-5.6', { effort: 'high' }),
            record(9, 2),
            tokenCount(10, sum(1, 2), usage(2)),
            // A rate-limit update sends the same total again.
            tokenCount(11, sum(1, 2), usage(2)),
        ]);
        const result = await read(file);
        assert.deepStrictEqual(
            result.requests.map(r => [r.messageId, r.requestId, r.model, r.effort, r.timestamp, r.sessionId, r.kind, r.provider]),
            [
                [`r:${THREAD}:resp_1`, 'resp_1', 'gpt-5.5', 'medium', Date.parse(at(5)), THREAD, 'main', 'codex'],
                [`r:${THREAD}:resp_2`, 'resp_2', 'gpt-5.6', 'high', Date.parse(at(9)), THREAD, 'main', 'codex'],
            ],
        );
        assert.deepStrictEqual(result.requests.map(tokensOf), [counted(1), counted(2)]);
        assert.deepStrictEqual(
            [result.sessionId, result.kind, result.firstCwd, result.firstCwdTs, result.newestVersion, result.restarted],
            [THREAD, 'main', '/Users/dev/projects/demo-app', Date.parse(at(0)), '0.169.0', 'new'],
        );
        assert.strictEqual(result.malformed.size, 0);
    });

    test('before records, a running total counts the response it moved by, once: a repeat, an estimate and a fill count nothing', async () => {
        const fill = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 272_000 };
        const file = rollout([
            meta(0, { cli_version: '0.120.0' }),
            context(1, 'gpt-5.2-codex'),
            tokenCount(5, sum(1), usage(1)),
            tokenCount(6, sum(1), usage(1)),
            // An estimate after a compaction: the total unchanged, the last a total alone.
            tokenCount(7, sum(1), { ...fill, total_tokens: 5_000 }),
            tokenCount(9, sum(1, 2), usage(2)),
            // The context window overflows: the total is filled to it, the last a total alone.
            tokenCount(10, fill, { ...fill, total_tokens: 1_000 }),
            tokenCount(12, sum(3), usage(3)),
        ]);
        const result = await read(file);
        assert.deepStrictEqual(
            result.requests.map(r => [r.timestamp, r.model, r.requestId]),
            [
                [Date.parse(at(5)), 'gpt-5.2-codex', null],
                [Date.parse(at(9)), 'gpt-5.2-codex', null],
                [Date.parse(at(12)), 'gpt-5.2-codex', null],
            ],
        );
        assert.deepStrictEqual(result.requests.map(tokensOf), [counted(1), counted(2), counted(3)]);
        // A key from the line itself: the same line read from another copy of the file is the same request.
        assert.ok(result.requests.every(r => r.messageId.startsWith(`t:${THREAD}:`)));
    });

    test("a response's cache is never more than its input, nor its reasoning more than its output, whatever a line says", async () => {
        const odd = { input_tokens: 100, cached_input_tokens: 150, cache_write_input_tokens: 30, output_tokens: 20, reasoning_output_tokens: 50, total_tokens: 120 };
        const file = rollout([
            meta(0),
            line(1, 'token_usage_record', { thread_id: THREAD, turn_id: 't', session_id: THREAD, root_turn_id: 't', response_id: 'resp_odd', usage: odd, turn_token_usage: odd, thread_token_usage: odd }),
        ]);
        assert.deepStrictEqual((await read(file)).requests.map(tokensOf), [{ input: 0, cacheRead: 100, cacheCreation: 0, output: 20, thinking: 20 }]);
    });

    test("a response read before its thread names its settings takes the first to, in the same moment, as a subagent's first record is written just before its settings; one further back stays as read", async () => {
        const spawned = meta(0, { session_id: ROOT, source: { subagent: { thread_spawn: { parent_thread_id: PARENT, depth: 1 } } } });
        const settings = (second: number, fields: Record<string, unknown>) =>
            line(second, 'event_msg', { type: 'thread_settings_applied', thread_id: THREAD, thread_settings: { model: 'gpt-6-astra', model_provider_id: 'openai', ...fields } });
        // As Codex 0.153 writes them, measured: the first record, then the thread's settings and its turn's, in the same millisecond.
        const lines = [spawned, record(1, 1), settings(1, { reasoning_effort: 'xhigh' }), context(1, 'gpt-6-astra', { effort: 'xhigh' }), record(4, 2), context(5, 'gpt-6.1-sol', { effort: 'low' }), record(6, 3)];
        const named = (result: ReadResult) => result.requests.map(r => [r.requestId, r.model, r.effort]);
        const whole = [
            ['resp_1', 'gpt-6-astra', 'xhigh'],
            ['resp_2', 'gpt-6-astra', 'xhigh'],
            ['resp_3', 'gpt-6.1-sol', 'low'],
        ];
        assert.deepStrictEqual(named(await read(rollout(lines))), whole);
        // Read up to its first record, then on: the next read writes it again, named.
        const file = rollout(lines.slice(0, 2));
        const first = await read(file);
        assert.deepStrictEqual(named(first), [['resp_1', UNRECORDED_MODEL, null]]);
        fs.appendFileSync(file, lines.slice(2).join(''));
        const next = await read(file, first.checkpoint);
        assert.deepStrictEqual(named(next), whole);
        assert.strictEqual(next.requests[0].byteOffset, first.requests[0].byteOffset);
        // Settings that name no effort name none, whatever the turn's says next.
        assert.deepStrictEqual(named(await read(rollout([spawned, record(1, 1), settings(1, {}), context(1, 'gpt-6-astra', { effort: 'xhigh' }), record(4, 2)]))), [
            ['resp_1', 'gpt-6-astra', null],
            ['resp_2', 'gpt-6-astra', 'xhigh'],
        ]);
        // A thread Codex 0.34 began, which recorded no model, resumed eleven days later by 0.41: its own responses stay of none, read whole or as written.
        const days = 11 * 86_400;
        const resumed = [meta(0, { cli_version: '0.34.0' }), tokenCount(5, usage(1), usage(1)), tokenCount(9, sum(1, 2), usage(2)), context(days, 'gpt-5-codex'), tokenCount(days + 4, sum(1, 2, 3), usage(3))];
        const models = (result: ReadResult) => result.requests.map(r => [r.model, r.effort]);
        assert.deepStrictEqual(models(await read(rollout(resumed))), [
            [UNRECORDED_MODEL, null],
            [UNRECORDED_MODEL, null],
            ['gpt-5-codex', 'medium'],
        ]);
        const live = rollout(resumed.slice(0, 3));
        const before = await read(live);
        fs.appendFileSync(live, resumed.slice(3).join(''));
        assert.deepStrictEqual(models(await read(live, before.checkpoint)), [['gpt-5-codex', 'medium']]);
    });

    test('the effort is the one each turn names, none where it names none: never the one before it, nor one named later', async () => {
        const file = rollout([meta(0), context(1, 'gpt-5.5', { effort: undefined }), record(2, 1), context(3, 'gpt-5.5', { effort: 'high' }), record(4, 2), context(5, 'gpt-5.5', { effort: undefined }), record(6, 3)]);
        assert.deepStrictEqual((await read(file)).requests.map(r => r.effort), [null, 'high', null]);
    });

    test('a counter that was never recorded is none: cache writes before Codex 0.145, the model before 0.35', async () => {
        const noWrite = (k: number) => usage(k, false);
        const file = rollout([meta(0, { cli_version: '0.32.0', source: 'exec' }), tokenCount(5, noWrite(1), noWrite(1))]);
        const result = await read(file);
        assert.deepStrictEqual(result.requests.map(r => [r.model, r.cacheCreation, r.input]), [[UNRECORDED_MODEL, 0, counted(1, false).input]]);
    });

    test("a legacy fork's copy of its parent's history is its parent's to count, every turn of it: the child counts from its own settings, or from the first line after a pause", async () => {
        const parentMeta = (second: number) => meta(second, { id: PARENT, session_id: PARENT });
        // The child's own meta, then its parent's history, two turns of it, copied in one go, stamped as written.
        const copied = (second: number) => [
            parentMeta(second),
            line(second, 'event_msg', { type: 'task_started', turn_id: 'turn-p1' }),
            context(second, 'gpt-5.5', { turn_id: 'turn-p1' }),
            tokenCount(second, sum(1), usage(1)),
            line(second + 0.02, 'event_msg', { type: 'task_started', turn_id: 'turn-p2' }),
            context(second + 0.02, 'gpt-5.5', { turn_id: 'turn-p2' }),
            tokenCount(second + 0.03, sum(1, 2), usage(2)),
        ];
        // From 0.144, the child's own settings close the copy.
        const bySettings = await read(
            rollout([
                meta(0, { forked_from_id: PARENT }),
                ...copied(0),
                line(0.04, 'event_msg', { type: 'thread_settings_applied', thread_id: THREAD, thread_settings: { model: 'gpt-5.6', model_provider_id: 'openai' } }),
                // Written with the copy, as a deferred rollout writes its first lines.
                tokenCount(0.05, sum(1, 2, 3), usage(3)),
            ]),
        );
        assert.deepStrictEqual(bySettings.requests.map(r => [r.timestamp, r.model, tokensOf(r).input]), [[Date.parse(at(0.05)), 'gpt-5.6', counted(3).input]]);
        // Before 0.144, the first line written after a pause: the child's first turn, begun once the copy is written.
        const byPause = await read(
            rollout(
                [
                    meta(0, { forked_from_id: PARENT, cli_version: '0.120.0' }),
                    ...copied(0),
                    line(4, 'event_msg', { type: 'task_started', turn_id: 'turn-c1' }),
                    context(4, 'gpt-5.2-codex', { turn_id: 'turn-c1' }),
                    tokenCount(9, sum(1, 2, 3), usage(3)),
                ],
                '019a0000-0000-7000-8000-000000000002',
            ),
        );
        assert.deepStrictEqual(byPause.requests.map(r => [r.model, tokensOf(r).output]), [['gpt-5.2-codex', counted(3).output]]);
        // In the oldest files too, with no turns at all.
        const byTime = await read(
            rollout(
                [
                    meta(0, { forked_from_id: PARENT, cli_version: '0.90.0' }),
                    parentMeta(0),
                    tokenCount(0, sum(1), usage(1)),
                    // A long copy, written steadily, is one copy however long it takes.
                    tokenCount(0.7, sum(1, 2), usage(2)),
                    tokenCount(1.4, sum(1, 2, 4), usage(4)),
                    tokenCount(9, sum(1, 2, 4, 3), usage(3)),
                ],
                '019a0000-0000-7000-8000-000000000003',
            ),
        );
        assert.deepStrictEqual(byTime.requests.map(r => tokensOf(r).output), [counted(3).output]);
        // A record of the parent's, copied into a fork from 0.153, is never the child's; the child's own is.
        const records = await read(
            rollout(
                [meta(0, { forked_from_id: PARENT }), parentMeta(0), record(0, 1, PARENT), tokenCount(0, sum(1), usage(1)), record(6, 2), tokenCount(6, sum(1, 2), usage(2)), record(7, 5, PARENT)],
                '019a0000-0000-7000-8000-000000000004',
            ),
        );
        assert.deepStrictEqual(records.requests.map(r => r.requestId), ['resp_2']);
    });

    test("a fork's copy of its parent's history holds the parent's limits and reviews too: the parent's, not the child's", async () => {
        const reached = { limit_id: 'codex', primary: { used_percent: 100, window_minutes: 300, resets_at: 1_794_000_000 }, secondary: null, spend_control_reached: null, rate_limit_reached_type: 'rate_limit_reached' };
        const result = await read(
            rollout([
                meta(0, { forked_from_id: PARENT }),
                // The parent's history, copied in one go: a turn a limit ended, and a review it began.
                meta(0, { id: PARENT, session_id: PARENT }),
                context(0.01, 'gpt-5.5'),
                tokenCount(0.02, sum(1), usage(1)),
                tokenCount(0.03, sum(1), usage(1), reached),
                line(0.03, 'event_msg', { type: 'task_complete', turn_id: 'p', last_agent_message: null, error: { message: 'You have hit your usage limit.', codex_error_info: 'usage_limit_exceeded' } }),
                line(0.04, 'event_msg', { type: 'entered_review_mode', target: { type: 'uncommittedChanges' }, user_facing_hint: 'current changes' }),
                // The child's own, after a pause, on a total of its own: its first response.
                tokenCount(9, usage(2), usage(2)),
            ]),
        );
        assert.deepStrictEqual([result.requests.map(tokensOf), result.limitHits], [[counted(2)], []]);
    });

    test("a subagent counts in its root's session, a legacy one naming its own in its parent's; a user fork is a session of its own", async () => {
        const spawned = (session: string) =>
            meta(0, { session_id: session, source: { subagent: { thread_spawn: { parent_thread_id: PARENT, depth: 1, agent_nickname: 'Ada' } } } });
        const subagent = await read(rollout([spawned(ROOT), context(1, 'gpt-5.5'), record(2, 1)]));
        assert.deepStrictEqual([subagent.sessionId, subagent.kind, subagent.requests.map(r => [r.sessionId, r.kind, r.agentId])], [ROOT, 'subagent', [[ROOT, 'subagent', THREAD]]]);
        const legacy = await read(rollout([spawned(THREAD), context(1, 'gpt-5.5'), record(2, 1)], THREAD, 'archived_sessions'));
        assert.deepStrictEqual([legacy.sessionId, legacy.kind], [PARENT, 'subagent']);
        const review = await read(rollout([meta(0, { source: { subagent: 'review' }, session_id: ROOT }), record(2, 1)], '019a0000-0000-7000-8000-000000000005'));
        assert.deepStrictEqual([review.sessionId, review.kind], [ROOT, 'subagent']);
        const fork = await read(rollout([meta(0, { forked_from_id: PARENT }), context(1, 'gpt-5.5'), record(2, 1)], '019a0000-0000-7000-8000-000000000006'));
        assert.deepStrictEqual([fork.sessionId, fork.kind], [THREAD, 'main']);
    });

    test('a refusal at a usage limit is a hit of the window that was full, once though its snapshot comes twice; a workspace limit is named as such', async () => {
        const reset = 1_794_000_000;
        const limits = (primary: number, secondary: number, reached: string | null) => ({
            limit_id: 'codex',
            limit_name: null,
            primary: { used_percent: primary, window_minutes: 300, resets_at: reset },
            secondary: { used_percent: secondary, window_minutes: 10_080, resets_at: reset + 86_400 },
            credits: null,
            plan_type: 'plus',
            rate_limit_reached_type: reached,
        });
        const file = rollout([
            meta(0),
            record(1, 1),
            tokenCount(2, usage(1), usage(1), limits(42, 10, null)),
            tokenCount(30, usage(1), usage(1), limits(100, 12, 'rate_limit_reached')),
            tokenCount(30.15, usage(1), usage(1), limits(100, 12, 'rate_limit_reached')),
            tokenCount(90, usage(1), usage(1), limits(100, 100, 'rate_limit_reached')),
            tokenCount(120, usage(1), usage(1), { ...limits(10, 10, 'workspace_member_usage_limit_reached'), primary: null, secondary: null }),
        ]);
        const result = await read(file);
        assert.deepStrictEqual(
            result.limitHits.map(h => [h.timestamp, h.limitType, h.resetsAt, h.sessionId, h.provider]),
            [
                [Date.parse(at(30)), 'five_hour', reset, THREAD, 'codex'],
                [Date.parse(at(90)), 'weekly', reset + 86_400, THREAD, 'codex'],
                [Date.parse(at(120)), 'workspace_usage', null, THREAD, 'codex'],
            ],
        );
    });

    test("an old file's reset time written as RFC 3339 text is the same time", async () => {
        const file = rollout([
            meta(0, { cli_version: '0.48.0' }),
            tokenCount(4, usage(1), usage(1)),
            tokenCount(5, usage(1), usage(1), { primary: { used_percent: 100, window_minutes: 300, resets_at: '2026-11-05T15:00:00Z' }, secondary: null }),
        ]);
        assert.deepStrictEqual((await read(file)).limitHits.map(h => h.resetsAt), [Date.UTC(2026, 10, 5, 15) / 1000]);
    });

    test('before Codex 0.145 a refusal is a full window on a snapshot that brought no usage: a limit reached unless a response follows before its turn ends, its reset in the seconds 0.41 to 0.47 gave', async () => {
        const window = (percent: number, minutes: number, seconds: number) => ({ used_percent: percent, window_minutes: minutes, resets_in_seconds: seconds });
        const old = (primary: object, secondary: object | null = null) => ({ primary, secondary });
        const file = rollout([
            meta(0, { cli_version: '0.41.0' }),
            context(1, 'gpt-5-codex'),
            tokenCount(5, sum(1), usage(1), old(window(97, 300, 3000))),
            // A response's headers at 100%, then the response: no limit reached.
            context(10, 'gpt-5-codex'),
            tokenCount(11, sum(1), usage(1), old(window(100, 300, 2900))),
            tokenCount(15, sum(1, 2), usage(2), old(window(100, 300, 2900))),
            // A refusal, its snapshot sent twice; the user's next turn comes ten minutes later.
            context(20, 'gpt-5-codex'),
            tokenCount(21, sum(1, 2), usage(2), old(window(100, 300, 2880))),
            tokenCount(21.2, sum(1, 2), usage(2), old(window(100, 300, 2880))),
            context(600, 'gpt-5-codex'),
            // One at the weekly window, the file's last line: the user went no further.
            tokenCount(601, sum(1, 2), usage(2), old(window(40, 300, 100), window(100, 10_080, 86_400))),
        ]);
        const result = await read(file);
        const after = (second: number, seconds: number) => Math.floor(Date.parse(at(second)) / 1000) + seconds;
        assert.deepStrictEqual(
            result.limitHits.map(h => [h.timestamp, h.limitType, h.resetsAt]),
            [
                [Date.parse(at(21)), 'five_hour', after(21, 2880)],
                [Date.parse(at(601)), 'weekly', after(601, 86_400)],
            ],
        );
        assert.deepStrictEqual(result.requests.map(tokensOf), [counted(1), counted(2)]);
        // 0.142: the kind of refusal not yet in the snapshot, and the turn's end written.
        const later = rollout(
            [
                meta(0, { id: PARENT, session_id: PARENT, cli_version: '0.142.0' }),
                context(0.5, 'gpt-5.5'),
                tokenCount(0.9, sum(1), usage(1)),
                line(1, 'event_msg', { type: 'task_started', turn_id: 'a' }),
                context(1.1, 'gpt-5.5'),
                tokenCount(2, sum(1), usage(1), { limit_id: 'codex', primary: { used_percent: 100, window_minutes: 300, resets_at: 1_794_000_000 }, secondary: null, rate_limit_reached_type: null }),
                line(2.04, 'event_msg', { type: 'task_complete', turn_id: 'a', last_agent_message: null }),
                line(9, 'event_msg', { type: 'task_started', turn_id: 'b' }),
            ],
            PARENT,
        );
        assert.deepStrictEqual((await read(later)).limitHits.map(h => [h.timestamp, h.limitType, h.resetsAt]), [[Date.parse(at(2)), 'five_hour', 1_794_000_000]]);
    });

    test("from Codex 0.145 a refusal names itself, in its snapshot and in its turn's end, which alone tells one with no snapshot, as an API key's quota, from 0.172 a spend limit by a code of its own; a full window it does not name is none", async () => {
        const reset = 1_794_000_000;
        const limits = (primary: number, reached: string | null) => ({
            limit_id: 'codex',
            limit_name: null,
            primary: { used_percent: primary, window_minutes: 300, resets_at: reset },
            secondary: null,
            credits: null,
            individual_limit: null,
            spend_control_reached: null,
            plan_type: 'plus',
            rate_limit_reached_type: reached,
        });
        const end = (second: number, error: string | null) =>
            line(second, 'event_msg', { type: 'task_complete', turn_id: `turn-${second}`, last_agent_message: null, ...(error ? { error: { message: 'You have hit your usage limit.', codex_error_info: error } } : {}) });
        const file = rollout([
            meta(0, { cli_version: '0.145.0' }),
            context(1, 'gpt-5.5'),
            tokenCount(3, sum(1), usage(1)),
            // A response's headers at 100%, naming no refusal: none.
            tokenCount(5, sum(1), usage(1), limits(100, null)),
            end(6, null),
            // A refusal: its snapshot, then its turn's end a moment later.
            context(10, 'gpt-5.5'),
            tokenCount(11, sum(1), usage(1), limits(100, 'rate_limit_reached')),
            end(11.04, 'usage_limit_exceeded'),
            // An API key's quota: no snapshot, its turn's end alone.
            context(20, 'gpt-5.5'),
            end(21, 'usage_limit_exceeded'),
            // A message quoting the error is none: its quotes are escaped.
            line(30, 'event_msg', { type: 'task_complete', turn_id: 'u', last_agent_message: '"codex_error_info":"usage_limit_exceeded"' }),
            // The server need not name a refusal: then the request's snapshot says what was full, a window or a meter of its own.
            context(40, 'gpt-5.5'),
            tokenCount(41, sum(1), usage(1), { ...limits(100, null), secondary: { used_percent: 31, window_minutes: 10_080, resets_at: reset + 86_400 } }),
            end(41.05, 'usage_limit_exceeded'),
            context(50, 'gpt-5.5-pro'),
            tokenCount(51, sum(1), usage(1), { ...limits(0, null), limit_id: 'premium', primary: null, secondary: null }),
            end(51.05, 'usage_limit_exceeded'),
            // Codex's own meter with no window full names nothing more than a usage limit.
            context(60, 'gpt-5.5'),
            tokenCount(61, sum(1), usage(1), limits(50, null)),
            end(61.05, 'usage_limit_exceeded'),
            // A workspace's cap, named in its snapshot, is one limit with its turn's end.
            context(70, 'gpt-5.5'),
            tokenCount(71, sum(1), usage(1), limits(64, 'workspace_member_usage_limit_reached')),
            end(71.04, 'usage_limit_exceeded'),
            // From 0.172, the spend limit of an API key, a project or an organization, by a code of its own: a usage limit, as 0.171 wrote it.
            ...['api_key', 'project', 'organization'].flatMap((scope, i) => [context(80 + 10 * i, 'gpt-5.5'), end(81 + 10 * i, `${scope}_spend_limit_exceeded`)]),
        ]);
        assert.deepStrictEqual(
            (await read(file)).limitHits.map(h => [h.timestamp, h.limitType, h.resetsAt]),
            [
                [Date.parse(at(11)), 'five_hour', reset],
                [Date.parse(at(21)), 'usage', null],
                [Date.parse(at(41.05)), 'five_hour', reset],
                [Date.parse(at(51.05)), 'premium', null],
                [Date.parse(at(61.05)), 'usage', null],
                [Date.parse(at(71)), 'workspace_usage', null],
                [Date.parse(at(81)), 'usage', null],
                [Date.parse(at(91)), 'usage', null],
                [Date.parse(at(101)), 'usage', null],
            ],
        );
    });

    test('a total that moved by more than its response, in every counter, took in usage no line of its own shows, as a compaction in Codex 0.32 to 0.34 did: a request of its own; one that moved by less started again', async () => {
        const file = rollout([
            meta(0, { cli_version: '0.32.0' }),
            tokenCount(5, sum(1), usage(1)),
            // /compact: its response's usage is added to the total, and no token count of its own is written.
            tokenCount(60, sum(1, 2, 3), usage(3)),
            // A resume: the total starts again, from the response it shows.
            tokenCount(90, sum(4), usage(4)),
            tokenCount(95, sum(4, 5), usage(5)),
            // One that moved by more in its input and by less in its cache says no usage of its own.
            tokenCount(99, { ...sum(4, 5, 6), input_tokens: sum(4, 5, 6).input_tokens + 5_000, cached_input_tokens: sum(4, 5).cached_input_tokens }, usage(6)),
        ]);
        const result = await read(file);
        assert.deepStrictEqual(result.requests.map(tokensOf), [counted(1), counted(2), counted(3), counted(4), counted(5), counted(6)]);
        assert.deepStrictEqual(
            result.requests.map(r => r.timestamp),
            [5, 60, 60, 90, 95, 99].map(second => Date.parse(at(second))),
        );
        // Two requests of one line, each with a key of its own.
        assert.strictEqual(new Set(result.requests.map(r => r.messageId)).size, 6);
    });

    test("a review's token counts Codex 0.51 to 0.77 wrote into its parent's file are its subagent's, whose own file counts them; a review that runs in the session, as before 0.51, is the session's", async () => {
        const REVIEW = '019a0000-0000-7000-8000-0000000000cc';
        const start = (second: number) => line(second, 'event_msg', { type: 'entered_review_mode', target: { type: 'uncommittedChanges' }, user_facing_hint: 'current changes' });
        const end = (second: number) => line(second, 'event_msg', { type: 'exited_review_mode', review_output: null });
        const parent = rollout([
            meta(0, { cli_version: '0.66.0' }),
            context(1, 'gpt-5.1-codex'),
            tokenCount(5, sum(1), usage(1)),
            start(20),
            // The subagent's, on its own running total: its first snapshot before any usage, then its responses.
            tokenCount(21, null, null, { primary: { used_percent: 100, window_minutes: 300, resets_at: 1_794_000_000 }, secondary: null }),
            tokenCount(25, sum(7), usage(7)),
            tokenCount(30, sum(7, 8), usage(8)),
            end(40),
            // The parent's own again, going on from its own total.
            tokenCount(50, sum(1), usage(1)),
            context(51, 'gpt-5.1-codex'),
            tokenCount(55, sum(1, 2), usage(2)),
        ]);
        const child = rollout(
            [meta(20, { id: REVIEW, session_id: REVIEW, source: { subagent: 'review' }, cli_version: '0.66.0' }), context(21, 'gpt-5.1-codex-mini'), tokenCount(25, sum(7), usage(7)), tokenCount(30, sum(7, 8), usage(8))],
            REVIEW,
        );
        const fromParent = await read(parent);
        assert.deepStrictEqual([fromParent.requests.map(tokensOf), fromParent.limitHits], [[counted(1), counted(2)], []]);
        const fromChild = await read(child);
        assert.deepStrictEqual([fromChild.kind, fromChild.requests.map(tokensOf)], ['subagent', [counted(7), counted(8)]]);
        // Before 0.51 the review ran here: its turn shows, and its totals go on from the session's.
        const inSession = (lines: string[]) => rollout([meta(0, { id: PARENT, session_id: PARENT, cli_version: '0.48.0' }), ...lines], PARENT);
        const own = await read(
            inSession([context(1, 'gpt-5-codex'), tokenCount(5, sum(1), usage(1)), start(20), context(21, 'gpt-5-codex'), tokenCount(25, sum(1, 7), usage(7)), end(40), tokenCount(55, sum(1, 7, 2), usage(2))]),
        );
        assert.deepStrictEqual(own.requests.map(tokensOf), [counted(1), counted(7), counted(2)]);
        // Its turn written before the review's start, as the two can race: its total still goes on from the session's,
        // and a refusal of its request, the snapshot repeating the session's total, is the session's limit.
        const full = { primary: { used_percent: 100, window_minutes: 300, resets_at: 1_794_000_000 }, secondary: null };
        const raced = await read(
            inSession([
                context(1, 'gpt-5-codex'),
                tokenCount(5, sum(1), usage(1)),
                context(19, 'gpt-5-codex'),
                start(20),
                tokenCount(25, sum(1, 7), usage(7)),
                end(40),
                context(59, 'gpt-5-codex'),
                start(60),
                tokenCount(61, sum(1, 7), usage(7), full),
            ]),
        );
        assert.deepStrictEqual([raced.requests.map(tokensOf), raced.limitHits.map(h => h.timestamp)], [[counted(1), counted(7)], [Date.parse(at(61))]]);
        // A review the session began with: its turn alone tells it runs here.
        const first = await read(rollout([meta(0, { id: ROOT, session_id: ROOT, cli_version: '0.48.0' }), start(1), context(2, 'gpt-5-codex'), tokenCount(5, usage(7), usage(7))], ROOT));
        assert.deepStrictEqual(first.requests.map(tokensOf), [counted(7)]);
        // Its turn written a moment before the review's start, with no total before it: counted all the same, at its own time.
        const opening = await read(rollout([meta(0, { id: ROOT, session_id: ROOT, cli_version: '0.48.0' }), context(1, 'gpt-5-codex'), start(1.002), tokenCount(5, usage(7), usage(7))], ROOT));
        assert.deepStrictEqual([opening.requests.map(tokensOf), opening.requests.map(r => r.timestamp)], [[counted(7)], [Date.parse(at(5))]]);
        // From 0.51 a request under way when a review starts is aborted first, and one begun long before that never answered
        // ends no review either: the review is its subagent's.
        const subagents = [
            [context(19, 'gpt-5.1-codex'), line(19.5, 'event_msg', { type: 'turn_aborted', reason: 'replaced' }), start(19.6)],
            [context(10, 'gpt-5.1-codex'), start(20)],
        ];
        for (const before of subagents) {
            const later = await read(rollout([meta(0, { cli_version: '0.66.0' }), context(1, 'gpt-5.1-codex'), tokenCount(5, sum(1), usage(1)), ...before, tokenCount(25, sum(7), usage(7)), end(40)]));
            assert.deepStrictEqual(later.requests.map(tokensOf), [counted(1)]);
        }
    });

    test("a thread whose last turn was a review, resumed by Codex 0.78, goes on from the review's last total: the review counted once, in its own file", async () => {
        const start = (second: number) => line(second, 'event_msg', { type: 'entered_review_mode', target: { type: 'uncommittedChanges' }, user_facing_hint: 'current changes' });
        const end = (second: number) => line(second, 'event_msg', { type: 'exited_review_mode', review_output: null });
        const day = 86_400;
        const lines = [
            meta(0, { cli_version: '0.66.0' }),
            context(1, 'gpt-5.1-codex'),
            tokenCount(5, sum(1), usage(1)),
            start(20),
            tokenCount(25, sum(7), usage(7)),
            tokenCount(30, sum(7, 8), usage(8)),
            end(40),
            // A day later: 0.78 seeds the thread's total with the file's last, the review's, which its first response's headers repeat.
            context(day, 'gpt-5.1-codex'),
            tokenCount(day + 1, sum(7, 8), usage(8)),
            tokenCount(day + 9, sum(7, 8, 3), usage(3)),
        ];
        assert.deepStrictEqual((await read(rollout(lines))).requests.map(tokensOf), [counted(1), counted(3)]);
        // Its headers' count not written: the first count after the seed is that response alone.
        assert.deepStrictEqual((await read(rollout(lines.filter((_, i) => i !== 8)))).requests.map(tokensOf), [counted(1), counted(3)]);
        // Read up to the review's end, then on.
        const file = rollout(lines.slice(0, 7));
        const first = await read(file);
        fs.appendFileSync(file, lines.slice(7).join(''));
        assert.deepStrictEqual([first.requests.map(tokensOf), (await read(file, first.checkpoint)).requests.map(tokensOf)], [[counted(1)], [counted(3)]]);
    });

    test("a line a crash cut short, which a resume wrote its first line onto, is read from where that line begins", async () => {
        const cut = tokenCount(5, sum(1), usage(1)).slice(0, 90);
        const file = rollout([meta(0, { cli_version: '0.66.0' }), context(1, 'gpt-5.1-codex'), cut + context(60, 'gpt-5.1-codex-max'), tokenCount(65, sum(2), usage(2))]);
        const result = await read(file);
        assert.deepStrictEqual(
            result.requests.map(r => [r.model, tokensOf(r)]),
            [['gpt-5.1-codex-max', counted(2)]],
        );
        assert.deepStrictEqual([...result.malformed], [['json-syntax', 1]]);
        // The line cut short one this reader has no use for, as a response's content, however long: the line written onto it is read all the same.
        for (const text of ['partial answer', 'x'.repeat(1 << 20)]) {
            const content = JSON.stringify({ timestamp: at(2), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } });
            const onto = await read(rollout([meta(0, { cli_version: '0.66.0' }), context(1, 'gpt-5.1-codex'), content.slice(0, -10) + tokenCount(65, usage(2), usage(2))]));
            assert.deepStrictEqual([onto.requests.map(tokensOf), [...onto.malformed]], [[counted(2)], []]);
        }
        // However long the line written onto it, as a resume's compaction's turn, which carries the project's instructions (32 KiB by default in 0.78).
        const content = JSON.stringify({ timestamp: at(2), type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'x'.repeat(200_000) } });
        const compaction = context(60, 'gpt-5.1-codex-mini', { effort: 'low', user_instructions: 'Use the repository\'s own scripts.\n'.repeat(1_200) });
        assert.ok(compaction.length > 32 << 10);
        const resumed = await read(rollout([meta(0, { cli_version: '0.78.0' }), context(1, 'gpt-5.1-codex-max', { effort: 'high' }), content.slice(0, 120_000) + compaction, tokenCount(65, usage(2), usage(2))]));
        assert.deepStrictEqual(resumed.requests.map(r => [r.model, r.effort, tokensOf(r)]), [['gpt-5.1-codex-mini', 'low', counted(2)]]);
        // Cut short where it is read from its bytes alone: a turn's end, a review's start or end, an abort.
        for (const event of [
            { type: 'task_complete', turn_id: 'a', last_agent_message: 'All done: the tests pass.' },
            { type: 'entered_review_mode', target: { type: 'uncommittedChanges' }, user_facing_hint: 'current changes' },
            { type: 'exited_review_mode', review_output: null },
            { type: 'turn_aborted', reason: 'interrupted' },
        ]) {
            const whole = line(6, 'event_msg', event);
            const onto = await read(rollout([meta(0, { cli_version: '0.66.0' }), context(1, 'gpt-5.1-codex'), tokenCount(5, sum(1), usage(1)), whole.slice(0, -8) + tokenCount(65, sum(1, 2), usage(2))]));
            assert.deepStrictEqual([onto.requests.map(tokensOf), [...onto.malformed]], [[counted(1), counted(2)], []], event.type);
        }
    });

    test("a compaction is a compacted line the thread writes once it has answered, read from its bytes alone, with no size; the one a fork's history begins with is not its own", async () => {
        const compacted = (second: number) =>
            `${JSON.stringify({ timestamp: at(second), type: 'compacted', payload: { message: '', replacement_history: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'x'.repeat(200) }] }] } })}\n`;
        const result = await read(rollout([meta(0), context(1, 'gpt-5.5'), record(2, 1), compacted(3), context(4, 'gpt-5.5'), record(5, 2)]));
        assert.deepStrictEqual(
            result.compactions.map(c => [c.provider, c.sessionId, c.kind, c.timestamp, c.trigger, c.preTokens, c.postTokens]),
            [['codex', THREAD, 'main', Date.parse(at(3)), null, null, null]],
        );
        assert.deepStrictEqual([result.requests.length, result.malformed.size], [2, 0]);
        // Its history is never decoded: one broken past its first bytes is a compaction all the same.
        const broken = `{"timestamp":"${at(3)}","type":"compacted","payload":{"message":"","replacement_history":[{"type":"mess\n`;
        const cut = await read(rollout([meta(0), context(1, 'gpt-5.5'), record(2, 1), broken]));
        assert.deepStrictEqual([cut.compactions.length, [...cut.malformed]], [1, []]);
        // A spawned subagent's file begins with its context as a compacted line: its own compactions come once it has answered.
        const spawned = meta(0, { session_id: ROOT, source: { subagent: { thread_spawn: { parent_thread_id: PARENT, depth: 1 } } } });
        const lines = [spawned, compacted(0.001), context(1, 'gpt-5.5'), record(2, 1), compacted(9)];
        assert.deepStrictEqual((await read(rollout(lines))).compactions.map(c => [c.sessionId, c.kind, c.timestamp]), [[ROOT, 'subagent', Date.parse(at(9))]]);
        // Read as it was written, the same.
        const live = rollout(lines.slice(0, 3));
        const first = await read(live);
        fs.appendFileSync(live, lines.slice(3).join(''));
        assert.deepStrictEqual([first.compactions, (await read(live, first.checkpoint)).compactions.map(c => c.timestamp)], [[], [Date.parse(at(9))]]);
    });

    test('a rollout read on from its checkpoint goes on from what it had made of the lines before it: its thread, model and running total', async () => {
        const file = rollout([meta(0, { cli_version: '0.120.0' }), context(1, 'gpt-5.2-codex'), tokenCount(5, sum(1), usage(1))]);
        const first = await read(file);
        assert.strictEqual(first.requests.length, 1);
        // Resumed days later: appended to, with no session_meta again.
        fs.appendFileSync(file, [tokenCount(600, sum(1), usage(1)), tokenCount(605, sum(1, 2), usage(2))].join(''));
        const previous = { ...first.checkpoint };
        const second = await read(file, previous);
        assert.deepStrictEqual(
            [second.restarted, second.requests.map(r => [r.timestamp, r.model, r.sessionId, tokensOf(r).output]), second.firstCwd],
            [null, [[Date.parse(at(605)), 'gpt-5.2-codex', THREAD, counted(2).output]], null],
        );
        // A file whose bytes before the checkpoint changed is read again from its start, its state afresh.
        fs.writeFileSync(
            file,
            [
                meta(0, { cli_version: '0.120.0' }),
                context(1, 'gpt-5.2'),
                line(2, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'x'.repeat(2_000) }] }),
                tokenCount(5, sum(1), usage(1)),
                tokenCount(605, sum(1, 2), usage(2)),
                tokenCount(610, sum(1, 2, 3), usage(3)),
            ].join(''),
        );
        assert.ok(fs.statSync(file).size >= second.checkpoint.offset);
        const third = await read(file, second.checkpoint);
        assert.deepStrictEqual([third.restarted, third.requests.map(r => r.model)], ['rewritten', ['gpt-5.2', 'gpt-5.2', 'gpt-5.2']]);
    });

    test("lines this reader has no use for are never parsed, however long or broken: a response's content, a tool's output, a compacted history", async () => {
        const content = `${JSON.stringify({ timestamp: at(2), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'x'.repeat(5 << 20) }] } })}\n`;
        const file = rollout([
            meta(0),
            content,
            `{"timestamp":"${at(3)}","type":"response_item","payload":{"type":"function_call_output","output":"{"\n`,
            `{"timestamp":"${at(4)}","type":"compacted","payload":{"message":"","replacement_history":[], "latest_token_usage_record": ${JSON.stringify({ response_id: 'resp_9', usage: usage(9) })}}}\n`,
            record(5, 1),
            // A line this reader would use, broken: counted, by category alone.
            `{"timestamp":"${at(6)}","type":"token_usage_record","payload":{"thread_id":"${THREAD}"\n`,
        ]);
        const result = await read(file);
        assert.deepStrictEqual(result.requests.map(r => r.requestId), ['resp_1']);
        assert.deepStrictEqual([...result.malformed], [['json-syntax', 1]]);
        assert.strictEqual(result.oversize, 0);
        // One it would use, too long to parse safely, is counted as such, unread: past 1 MiB, twenty times the longest of its types measured.
        const padded = (bytes: number) => record(1, 1).replace('"session_id"', `"padding":"${'x'.repeat(bytes)}","session_id"`);
        const long = rollout([meta(0), padded(1 << 20)], '019a0000-0000-7000-8000-000000000007');
        const skipped = await read(long);
        assert.deepStrictEqual([skipped.requests.length, skipped.oversize, [...skipped.malformed]], [0, 1, [['oversize', 1]]]);
        const under = rollout([meta(0), padded((1 << 20) - 4096)], '019a0000-0000-7000-8000-000000000008');
        assert.deepStrictEqual((await read(under)).requests.map(r => r.requestId), ['resp_1']);
    });

    test('a checkpoint a parser older than CODEX_ROWS_SINCE left, as 6, the first that read Codex, did, is read again whole, its rows replaced', async () => {
        const file = rollout([meta(0), record(1, 1)]);
        const first = await read(file);
        for (const parserVersion of [6, CODEX_ROWS_SINCE - 1]) {
            const older = await read(file, { ...first.checkpoint, parserVersion, size: first.checkpoint.size - 1 });
            assert.deepStrictEqual([older.restarted, older.requests.map(r => r.requestId)], ['parser', ['resp_1']], `parser ${parserVersion}`);
        }
    });

    test('rollouts are found in sessions and archived_sessions, compressed or not, the plain copy read where both are there, and never Codex\'s temporary files', async () => {
        const plain = rollout([meta(0), record(1, 1)]);
        fs.writeFileSync(`${plain}.zst`, zlib.zstdCompressSync(fs.readFileSync(plain)));
        const archived = rollout([meta(0, { id: PARENT, session_id: PARENT }), record(1, 2, PARENT)], PARENT, 'archived_sessions');
        fs.writeFileSync(`${archived}.zst`, zlib.zstdCompressSync(fs.readFileSync(archived)));
        fs.rmSync(archived);
        const dir = path.dirname(plain);
        for (const name of ['rollout-compress-1234.tmp', `.rollout-materialize-${THREAD}`, `.rollout-2026-11-05T11-00-00-${THREAD}.jsonl.paginated.tmp`, 'notes.jsonl', 'history.jsonl']) {
            fs.writeFileSync(path.join(dir, name), 'x');
        }
        const found = walkRollouts(home);
        assert.deepStrictEqual(found.files.map(f => path.relative(fs.realpathSync(home), f.path)).sort(), [
            path.join('archived_sessions', `rollout-2026-11-05T11-00-00-${PARENT}.jsonl.zst`),
            path.join('sessions', '2026', '11', '05', `rollout-2026-11-05T11-00-00-${THREAD}.jsonl`),
        ]);
        assert.deepStrictEqual(rolloutsAt(home, [plain, `${plain}.zst`, `${archived}.zst`, path.join(dir, 'notes.jsonl')]).map(f => path.basename(f.path)), [
            path.basename(plain),
            `${path.basename(archived)}.zst`,
        ]);
        // A compressed one is read whole, through the runtime's decoder.
        const compressed = await read(`${archived}.zst`);
        assert.deepStrictEqual([compressed.requests.map(r => [r.requestId, r.sessionId]), compressed.restarted], [[['resp_2', PARENT]], 'new']);
        assert.strictEqual(walkRollouts(path.join(home, 'nothing-here')).folder, null);
        // A symlinked folder is never entered, and a path outside the home is no rollout of it.
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-tokenizer-codex-outside-'));
        try {
            fs.writeFileSync(path.join(outside, path.basename(plain)), fs.readFileSync(plain));
            fs.symlinkSync(outside, path.join(home, 'sessions', 'linked'), 'dir');
            const linked = walkRollouts(home);
            assert.deepStrictEqual([linked.files.length, linked.symlinkedFolders], [2, 1]);
            assert.deepStrictEqual(rolloutsAt(home, [path.join(outside, path.basename(plain))]), []);
        } finally {
            fs.rmSync(outside, { recursive: true, force: true });
        }
    });

    test('a rollout a watcher names is kept under the path the walk finds it at, however the hint spells its folders', () => {
        const plain = rollout([meta(0), record(1, 1)]);
        const walked = walkRollouts(home).files.map(f => f.path);
        assert.deepStrictEqual(rolloutsAt(home, [plain]).map(f => f.path), walked);
        // The home in capitals: on Windows the same folder, which must not be
        // kept a second time; where case matters, or path.relative minds it,
        // not found, and left to the walk.
        const shouted = path.join(home.toUpperCase(), path.relative(home, plain));
        const found = rolloutsAt(home, [shouted]).map(f => f.path);
        assert.ok(found.length === 0 || (found.length === 1 && found[0] === walked[0]), JSON.stringify([found, walked]));
        if (process.platform === 'win32') {
            assert.deepStrictEqual(found, walked);
        }
    });

    test("a compressed rollout cut short is no empty one, nor a shorter one: it is a file that could not be read, whether its frame declares its size or not", async function () {
        const records = (n: number) => Buffer.from([meta(0), context(1, 'gpt-5.5'), ...Array.from({ length: n }, (_, i) => record(2 + i / 100, i + 1))].join(''));
        // As Codex 0.152 on writes them, its size declared; and as 0.145 did, a stream that declares none.
        const streamed = (text: Buffer) =>
            new Promise<Buffer>((resolve, reject) => {
                const parts: Buffer[] = [];
                const encoder = zlib.createZstdCompress();
                encoder.on('data', (chunk: Buffer) => parts.push(chunk));
                encoder.on('end', () => resolve(Buffer.concat(parts)));
                encoder.on('error', reject);
                encoder.end(text);
            });
        const file = path.join(home, 'archived_sessions', `rollout-2026-11-05T11-00-00-${THREAD}.jsonl.zst`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        // Every runtime's alike: a cut is found as its frame is walked, before
        // that frame is decoded. Most decoders give what they decoded as all there is.
        const cutShort = (e: NodeJS.ErrnoException) => e.code === 'ZSTD_TRUNCATED';
        // Small, nothing comes out of a frame cut short; large, its first blocks
        // do. Bytes that do not compress are kept in raw blocks of 128 KiB,
        // whose headers' every byte counts.
        const raw = Buffer.concat(Array.from({ length: 12_000 }, (_, i) => crypto.createHash('sha256').update(String(i)).digest()));
        for (const [frame, n] of [
            [zlib.zstdCompressSync(records(40)), 40],
            [await streamed(records(40)), 40],
            [zlib.zstdCompressSync(records(4_000)), 4_000],
            [await streamed(records(4_000)), 4_000],
            [zlib.zstdCompressSync(records(40), { params: { [zlib.constants.ZSTD_c_checksumFlag]: true } }), 40],
            [zlib.zstdCompressSync(raw), 0],
        ] as const) {
            fs.writeFileSync(file, frame);
            assert.strictEqual((await read(file)).requests.length, n);
            // Cut to nothing, which no zstd file is; part way; and a byte and four
            // bytes short: into the last block, or, where the frame has a checksum,
            // a byte of it short, all the content decoded, and the checksum missing whole.
            for (const end of [0, Math.floor(frame.length * 0.6), frame.length - 1, frame.length - 4]) {
                fs.writeFileSync(file, frame.subarray(0, end));
                await assert.rejects(async () => read(file), cutShort);
            }
        }
        // Nor is a skippable frame alone, as pzstd's first is, nor one cut short
        // after a whole frame, nor a frame after one cut a byte short.
        const skippable = Buffer.from([0x50, 0x2a, 0x4d, 0x18, 4, 0, 0, 0, 1, 2, 3, 4]);
        const whole = zlib.zstdCompressSync(records(10));
        const skipped = Buffer.concat([whole, skippable, whole]);
        for (const bytes of [
            skippable,
            Buffer.concat([whole, skippable.subarray(0, 8)]),
            Buffer.concat([whole, skippable.subarray(0, skippable.length - 1)]),
            skipped.subarray(0, skipped.length - 1),
        ]) {
            fs.writeFileSync(file, bytes);
            await assert.rejects(async () => read(file), cutShort);
        }
        if (!sqlite) {
            this.skip();
        }
        // An import counts it among the files it could not read, and keeps nothing of it.
        const opened = UsageStore.open(sqlite, path.join(home, 'history', 'usage.sqlite'));
        assert.strictEqual(opened.status, 'ready');
        if (opened.status !== 'ready') {
            return;
        }
        try {
            const summary = await importSources(opened.store, [{ provider: 'codex', roots: [home] }]);
            assert.deepStrictEqual([summary.files, summary.read, summary.skipped, [...opened.store.requests()].length], [1, 0, { error: 1 }, 0]);
        } finally {
            opened.store.close();
        }
    });

    test('complete empty and RLE zstd frames remain readable, with a dictionary id of 0 or none', async () => {
        const file = rollout([]);
        // RFC 8878: a frame without a content size, one final RLE block of twenty newlines.
        const rle = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0, 0x38, (20 << 3) | 3, 0, 0, 0x0a]);
        // The same with a dictionary id of 0, which names none (§3.1.1.1.3), in a field of 1, 2 and 4 bytes.
        const noDictionary = [1, 2, 4].map((width, flag) => Buffer.concat([rle.subarray(0, 4), Buffer.from([flag + 1, 0x38]), Buffer.alloc(width), rle.subarray(6)]));
        for (const frame of [rle, ...noDictionary]) {
            assert.deepStrictEqual(zlib.zstdDecompressSync(frame), Buffer.alloc(20, 0x0a));
        }
        for (const frame of [zlib.zstdCompressSync(Buffer.alloc(0)), rle, ...noDictionary]) {
            fs.writeFileSync(`${file}.zst`, frame);
            assert.deepStrictEqual((await read(`${file}.zst`)).requests, []);
        }
    });

    test('a compressed rollout of several frames is read whole: from several inputs, put end to end, with a skippable frame, a frame ended mid-stream, or one ended mid-line', async () => {
        const lines = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => record(2 + (from + i) / 100, from + i + 1)).join('');
        const head = meta(0) + context(1, 'gpt-5.5');
        const frame = (text: string) => zlib.zstdCompressSync(Buffer.from(text));
        const skippable = Buffer.from([0x50, 0x2a, 0x4d, 0x18, 4, 0, 0, 0, 1, 2, 3, 4]);
        const endedMidStream = (parts: string[]) =>
            new Promise<Buffer>((resolve, reject) => {
                const out: Buffer[] = [];
                const encoder = zlib.createZstdCompress();
                encoder.on('data', (chunk: Buffer) => out.push(chunk));
                encoder.on('end', () => resolve(Buffer.concat(out)));
                encoder.on('error', reject);
                encoder.write(parts[0]);
                encoder.flush(zlib.constants.ZSTD_e_end, () => encoder.end(parts[1]));
            });
        const file = path.join(home, 'archived_sessions', `rollout-2026-11-05T11-00-00-${THREAD}.jsonl.zst`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        // Given the end of a frame and more in one write, the decoder of most
        // runtimes drops the rest of the write unless the frame's output ends
        // just as an output chunk of 16 KiB fills: a first frame under it, and past it.
        for (const split of [10, 300]) {
            const [first, second] = [head + lines(0, split), lines(split, 600)];
            assert.ok(Buffer.byteLength(first) < 16_384 === (split === 10));
            for (const bytes of [
                Buffer.concat([frame(first), frame(second)]),
                Buffer.concat([skippable, frame(first + second)]),
                Buffer.concat([frame(first), skippable, frame(second)]),
                await endedMidStream([first, second]),
                // As pzstd ends its frames, where a size falls: a line split between two.
                Buffer.concat([frame(first + second.slice(0, 100)), frame(second.slice(100))]),
            ]) {
                fs.writeFileSync(file, bytes);
                assert.strictEqual((await read(file)).requests.length, 600, `split at ${split}, ${bytes.length} bytes`);
            }
        }
    });

    test("a compressed rollout the decoder refuses fails with the decoder's own error, and its descriptor stays its reader's to close, once; a whole frame with bytes after it that open none is refused too, by the decoder or as undecoded", async () => {
        // Bytes that do not compress, read in more than one go: a stream given
        // the descriptor is still reading it as the decoder fails, and a stream
        // that has ended is left as it is.
        const noise = crypto.randomBytes(3 << 20);
        // A reserved bit of the frame header set, a block of the reserved type, and gzip's bytes under the name.
        const reserved = zlib.zstdCompressSync(noise);
        reserved[4] |= 0x08;
        const reservedBlock = Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0, 0x38, (20 << 3) | 7, 0, 0, 0x0a]), noise]);
        const file = path.join(home, 'archived_sessions', `rollout-2026-11-05T11-00-00-${THREAD}.jsonl.zst`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const ignore = () => undefined;
        const decoders = (e: NodeJS.ErrnoException) => typeof e.code === 'string' && e.code.startsWith('ZSTD_error_');
        for (const bytes of [reserved, reservedBlock, zlib.gzipSync(noise)]) {
            fs.writeFileSync(file, bytes);
            const fd = fs.openSync(file, 'r');
            try {
                await assert.rejects(eachLineOfZstd(fd, ignore, ignore, ignore), decoders);
                // A stream given it closed it as the decoder failed, and the reader's own close then closed whatever had the number since.
                assert.ok(fs.fstatSync(fd).isFile());
            } finally {
                fs.closeSync(fd);
            }
            await assert.rejects(async () => read(file), decoders);
        }
        // After a whole frame, the decoder of most runtimes refuses bytes that
        // open no frame; 24.22's stops there and says nothing, having taken less than it was given.
        const frame = zlib.zstdCompressSync(Buffer.from(meta(0) + context(1, 'gpt-5.5') + record(2, 1)));
        for (const after of [Buffer.alloc(5_000, 0x41), zlib.gzipSync(noise)]) {
            fs.writeFileSync(file, Buffer.concat([frame, after]));
            await assert.rejects(async () => read(file), (e: NodeJS.ErrnoException) => decoders(e) || e.code === 'ZSTD_UNDECODED');
        }
    });

    test("a compressed rollout's frames are walked one at a time, as they are read: a cut in a later frame is found once the earlier ones' lines are used", async () => {
        // A frame of several reads: the next is walked only once its bytes are all written.
        const big = zlib.zstdCompressSync(Buffer.from(Array.from({ length: 48 }, () => `${crypto.randomBytes(96 << 10).toString('base64')}\n`).join('')));
        const cut = zlib.zstdCompressSync(Buffer.from(record(3, 2)));
        const file = path.join(home, 'archived_sessions', `rollout-2026-11-05T11-00-00-${THREAD}.jsonl.zst`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, Buffer.concat([big, cut.subarray(0, cut.length - 1)]));
        let used = 0;
        const fd = fs.openSync(file, 'r');
        try {
            await assert.rejects(
                eachLineOfZstd(fd, () => used++, () => undefined, () => undefined),
                (e: NodeJS.ErrnoException) => e.code === 'ZSTD_TRUNCATED',
            );
        } finally {
            fs.closeSync(fd);
        }
        assert.ok(used > 0, 'no line of the first frame was used before the cut was found');
    });

    test('a compressed rollout shortened as it is read is cut short, and its read ends', async () => {
        // A frame of several reads, of lines that hardly compress: shortened as
        // its first line comes, within it, or to its end, before a frame after it.
        const big = zlib.zstdCompressSync(Buffer.from(Array.from({ length: 48 }, () => `${crypto.randomBytes(96 << 10).toString('base64')}\n`).join('')));
        assert.ok(big.length > 3 << 20);
        const file = path.join(home, 'archived_sessions', `rollout-2026-11-05T11-00-00-${THREAD}.jsonl.zst`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        for (const [bytes, to] of [
            [big, 1 << 20],
            [Buffer.concat([big, zlib.zstdCompressSync(Buffer.from(record(3, 2)))]), big.length],
        ] as const) {
            fs.writeFileSync(file, bytes);
            let shortened = false;
            const shorten = () => {
                if (!shortened) {
                    shortened = true;
                    fs.truncateSync(file, to);
                }
            };
            const fd = fs.openSync(file, 'r');
            let timer: NodeJS.Timeout | undefined;
            try {
                const outcome = await Promise.race([
                    eachLineOfZstd(fd, shorten, () => undefined, () => undefined).then(
                        () => 'read',
                        (e: NodeJS.ErrnoException) => e.code,
                    ),
                    new Promise(resolve => (timer = setTimeout(resolve, 5_000, 'still reading'))),
                ]);
                assert.deepStrictEqual([outcome, shortened], ['ZSTD_TRUNCATED', true], `shortened to ${to}`);
            } finally {
                clearTimeout(timer);
                // A read still going ends here, its next read refused.
                fs.closeSync(fd);
            }
        }
    });

    test('a full window a read ended on, before Codex 0.145, is a limit until the response it was the headers of follows, then withdrawn, as a whole read never counts it', async function () {
        if (!sqlite) {
            this.skip();
        }
        const window = (percent: number) => ({ primary: { used_percent: percent, window_minutes: 300, resets_in_seconds: 2900 }, secondary: null });
        const lines = [
            meta(0, { cli_version: '0.66.0' }),
            context(1, 'gpt-5.1-codex'),
            tokenCount(5, sum(1), usage(1), window(97)),
            context(10, 'gpt-5.1-codex'),
            // A response's headers at 100%, the file's last line while the response streams...
            tokenCount(11, sum(1), usage(1), window(100)),
            // ...then the response.
            tokenCount(15, sum(1, 2), usage(2), window(100)),
        ];
        const opened = UsageStore.open(sqlite, path.join(home, 'history', 'usage.sqlite'));
        assert.strictEqual(opened.status, 'ready');
        if (opened.status !== 'ready') {
            return;
        }
        const store = opened.store;
        const imported = () => importSources(store, [{ provider: 'codex', roots: [home] }]);
        try {
            const file = rollout(lines.slice(0, 5));
            await imported();
            assert.deepStrictEqual(store.limitHits().map(h => h.timestamp), [Date.parse(at(11))]);
            fs.appendFileSync(file, lines.slice(5).join(''));
            await imported();
            assert.deepStrictEqual([store.limitHits(), [...store.requests()].map(tokensOf)], [[], [counted(1), counted(2)]]);
            assert.deepStrictEqual((await read(file)).limitHits, []);
            // A turn begun after it instead: it was a limit reached, and stays one whatever responds next.
            fs.writeFileSync(file, lines.slice(0, 5).join(''));
            await importSources(store, [{ provider: 'codex', roots: [home] }]);
            fs.appendFileSync(file, [context(600, 'gpt-5.1-codex'), tokenCount(605, sum(1, 2), usage(2), window(20))].join(''));
            await imported();
            assert.deepStrictEqual(store.limitHits().map(h => h.timestamp), [Date.parse(at(11))]);
        } finally {
            store.close();
        }
    });

    test('a full window read where reads end, twice in one request, is the one limit a whole read finds, or none', async function () {
        if (!sqlite) {
            this.skip();
        }
        // A compaction's retry, and a turn's from 0.119, write each attempt's headers with no turn between.
        const full = (percent: number) => ({ primary: { used_percent: percent, window_minutes: 300, resets_at: 1_794_000_000 }, secondary: null });
        const head = [meta(0, { cli_version: '0.66.0' }), context(1, 'gpt-5.1-codex'), tokenCount(5, sum(1), usage(1), full(97)), context(10, 'gpt-5.1-codex')];
        const cases: [string, string[], number[]][] = [
            // Its second attempt's headers, then the response: no limit.
            ['the response follows', [tokenCount(11, sum(1), usage(1), full(100)), tokenCount(12.5, sum(1), usage(1), full(100)), tokenCount(15, sum(1, 2), usage(2), full(100))], []],
            // The second a while later, then the turn ends: the first, once.
            ['the turn ends', [tokenCount(11, sum(1), usage(1), full(100)), tokenCount(20, sum(1), usage(1), full(100)), context(600, 'gpt-5.1-codex')], [11]],
            // Withdrawn, then the next request refused a moment later, at the same window: that one stands.
            [
                'refused after the response',
                [tokenCount(10.3, sum(1), usage(1), full(100)), tokenCount(13, sum(1, 2), usage(2), full(100)), context(13.5, 'gpt-5.1-codex'), tokenCount(14, sum(1, 2), usage(2), full(100)), context(600, 'gpt-5.1-codex')],
                [14],
            ],
        ];
        for (const [name, tail, expected] of cases) {
            const opened = UsageStore.open(sqlite, path.join(home, `history-${expected.length}-${tail.length}`, 'usage.sqlite'));
            assert.strictEqual(opened.status, 'ready');
            if (opened.status !== 'ready') {
                return;
            }
            const store = opened.store;
            try {
                const lines = [...head, ...tail];
                const whole = (await read(rollout(lines))).limitHits.map(h => h.timestamp);
                // Read after each of its last lines but the last, as a watcher's hints would, then whole.
                const file = rollout(lines.slice(0, head.length + 1));
                await importSources(store, [{ provider: 'codex', roots: [home] }]);
                for (const next of lines.slice(head.length + 1)) {
                    fs.appendFileSync(file, next);
                    await importSources(store, [{ provider: 'codex', roots: [home] }]);
                }
                const live = store.limitHits().map(h => h.timestamp);
                assert.deepStrictEqual([whole, live], [expected.map(s => Date.parse(at(s))), expected.map(s => Date.parse(at(s)))], name);
            } finally {
                store.close();
            }
        }
    });

    test('a response read before its settings, written again once they come, is kept named', async function () {
        if (!sqlite) {
            this.skip();
        }
        const spawned = meta(0, { session_id: ROOT, source: { subagent: { thread_spawn: { parent_thread_id: PARENT, depth: 1 } } } });
        const settings = line(1, 'event_msg', { type: 'thread_settings_applied', thread_id: THREAD, thread_settings: { model: 'gpt-6-astra', model_provider_id: 'openai', reasoning_effort: 'xhigh' } });
        const opened = UsageStore.open(sqlite, path.join(home, 'history', 'usage.sqlite'));
        assert.strictEqual(opened.status, 'ready');
        if (opened.status !== 'ready') {
            return;
        }
        const store = opened.store;
        try {
            const file = rollout([spawned, record(1, 1)]);
            await importSources(store, [{ provider: 'codex', roots: [home] }]);
            assert.deepStrictEqual([...store.requests()].map(r => [r.requestId, r.model, r.effort]), [['resp_1', UNRECORDED_MODEL, null]]);
            fs.appendFileSync(file, [settings, context(1, 'gpt-6-astra', { effort: 'xhigh' }), record(4, 2)].join(''));
            await importSources(store, [{ provider: 'codex', roots: [home] }]);
            assert.deepStrictEqual([...store.requests()].map(r => [r.requestId, r.model, r.effort]), [
                ['resp_1', 'gpt-6-astra', 'xhigh'],
                ['resp_2', 'gpt-6-astra', 'xhigh'],
            ]);
        } finally {
            store.close();
        }
    });

    test('an import keeps each response once, whichever copies of its rollout there are, and reports it as Codex\'s', async function () {
        if (!sqlite) {
            this.skip();
        }
        const plain = rollout([meta(0), context(1, 'gpt-5.5'), record(2, 1), tokenCount(3, usage(1), usage(1)), record(5, 2)]);
        const copy = path.join(home, 'archived_sessions', path.basename(plain));
        fs.mkdirSync(path.dirname(copy), { recursive: true });
        fs.copyFileSync(plain, copy);
        fs.writeFileSync(`${copy}.zst`, zlib.zstdCompressSync(fs.readFileSync(plain)));
        const opened = UsageStore.open(sqlite, path.join(home, 'history', 'usage.sqlite'));
        assert.strictEqual(opened.status, 'ready');
        if (opened.status !== 'ready') {
            return;
        }
        const store = opened.store;
        try {
            const summary = await importSources(store, [{ provider: 'codex', roots: [home] }]);
            assert.deepStrictEqual([summary.files, summary.read, summary.skipped], [2, 2, {}]);
            assert.deepStrictEqual([...store.requests()].map(r => [r.provider, r.requestId]), [
                ['codex', 'resp_1'],
                ['codex', 'resp_2'],
            ]);
            assert.deepStrictEqual(store.sessions().map(s => [s.provider, s.sessionId, s.cwd]), [['codex', THREAD, '/Users/dev/projects/demo-app']]);
            const checkpoint = store.getFile('codex', fs.realpathSync(plain));
            assert.deepStrictEqual([checkpoint?.parserVersion, checkpoint?.kind, typeof checkpoint?.readerState], [PARSER_VERSION, 'main', 'string']);
            const report = queryReport(store, { range: 'coverage', zone: 'UTC', workspaceFolders: null, now: Date.UTC(2026, 10, 6), platform: process.platform });
            assert.deepStrictEqual(
                [report.sessions.map(s => [s.provider, s.sessionId]), report.totals.output, report.accounts.length],
                [[['codex', THREAD]], counted(1).output + counted(2).output, 0],
            );
            // Read again, nothing changes.
            const again = await importSources(store, [{ provider: 'codex', roots: [home] }]);
            assert.deepStrictEqual([again.read, again.unchanged], [0, 2]);
        } finally {
            store.close();
        }
    });

    test("a pass of every file that reads Codex forgets what a parser older than CODEX_ROWS_SINCE read of its rollouts, compressed or compressed since, limits and compactions too, and reads them again whole; a pass of named files, or one with Codex's reading off, leaves it as it is, and Claude Code's rows stay", async function () {
        if (!sqlite) {
            this.skip();
        }
        const lines = [meta(0), context(1, 'gpt-5.5'), record(2, 1)];
        const plain = rollout(lines);
        const compressed = `${plain}.zst`;
        fs.writeFileSync(compressed, zlib.zstdCompressSync(Buffer.from(lines.join(''))));
        fs.rmSync(plain);
        const claude = path.join(home, 'claude');
        fs.mkdirSync(path.join(claude, 'projects'), { recursive: true });
        const opened = UsageStore.open(sqlite, path.join(home, 'history', 'usage.sqlite'));
        assert.strictEqual(opened.status, 'ready');
        if (opened.status !== 'ready') {
            return;
        }
        const store = opened.store;
        const codex = [{ provider: 'codex' as const, roots: [home] }];
        try {
            assert.ok(await importUnderLease(store, codex, 'window-a'));
            const [fresh] = [...store.requests()];
            const real = fs.realpathSync(compressed);
            const checkpoint = store.getFile('codex', real);
            assert.ok(checkpoint);
            // As an older parser left it: a row under a key this one no longer
            // gives, a limit and a compaction it no longer counts, and the rows,
            // session and checkpoint of a plain rollout Codex has compressed
            // since. And Claude Code's, which stay: a request, the checkpoint
            // 2.4.0 left of a transcript removed since, a session, a limit and a
            // compaction.
            const older = CODEX_ROWS_SINCE - 1;
            const gone = real.slice(0, -'.zst'.length);
            const removed = path.join(claude, 'projects', 'p', 'removed.jsonl');
            store.transaction(() => {
                store.putFile({ ...checkpoint, parserVersion: older });
                store.putFile({ ...checkpoint, path: gone, parserVersion: older });
                store.putFile({ ...checkpoint, provider: 'claude-code', path: removed, parserVersion: 5 });
                store.upsertRequests([
                    { ...fresh, messageId: `${fresh.messageId}:older`, parserVersion: older },
                    { ...fresh, messageId: `${fresh.messageId}:plain`, file: gone, sessionId: PARENT, parserVersion: older },
                    { ...fresh, provider: 'claude-code', messageId: 'msg_kept', sessionId: 'sess-kept', parserVersion: 5 },
                ]);
                store.upsertSession('codex', { sessionId: PARENT, root: home, cwd: null, cwdTs: null, projectDir: '', firstTs: fresh.timestamp, lastTs: fresh.timestamp });
                store.upsertSession('claude-code', { sessionId: 'sess-kept', root: claude, cwd: '/work', cwdTs: fresh.timestamp, projectDir: 'p', firstTs: fresh.timestamp, lastTs: fresh.timestamp });
                for (const [provider, uuid, sessionId] of [['codex', `${THREAD}:older`, THREAD], ['claude-code', 'kept', 'sess-kept']] as const) {
                    store.insertLimitHits([{ provider, uuid, sessionId, timestamp: fresh.timestamp, limitType: 'five_hour', resetsAt: null }]);
                    store.insertCompactions([{ provider, uuid, sessionId, kind: 'main', timestamp: fresh.timestamp, trigger: null, preTokens: null, postTokens: null }]);
                }
            });
            const state = () => ({
                rows: [...store.requests()].map(r => [r.provider, r.messageId, r.parserVersion]),
                limits: store.limitHits().map(h => [h.provider, h.uuid]).sort(),
                compactions: store.compactions().map(c => [c.provider, c.uuid]).sort(),
                sessions: store.sessions().map(s => [s.provider, s.sessionId]).sort(),
                checkpoints: [store.getFile('codex', real)?.parserVersion, store.getFile('codex', gone)?.parserVersion, store.getFile('claude-code', removed)?.parserVersion],
            });
            const before = state();
            // A pass of named files leaves the rollout as it is, for a pass of
            // every file to forget; so does a pass with Codex's reading off, or
            // with no home of Codex's to read.
            const named = await importUnderLease(store, codex, 'window-a', {}, [compressed]);
            assert.deepStrictEqual([named?.read, named?.unchanged], [0, 1]);
            assert.ok(await importUnderLease(store, [{ provider: 'claude-code', roots: [claude] }], 'window-a'));
            assert.ok(await importUnderLease(store, [{ provider: 'codex', roots: [] }], 'window-a'));
            assert.deepStrictEqual(state(), before);
            // A pass of every file that reads Codex forgets all of Codex's, reads the rollout again whole, and keeps Claude Code's.
            const summary = await importUnderLease(store, codex, 'window-a');
            assert.deepStrictEqual([summary?.files, summary?.read], [1, 1]);
            assert.deepStrictEqual(state(), {
                rows: [
                    ['claude-code', 'msg_kept', 5],
                    ['codex', fresh.messageId, PARSER_VERSION],
                ],
                limits: [['claude-code', 'kept']],
                compactions: [['claude-code', 'kept']],
                sessions: [
                    ['claude-code', 'sess-kept'],
                    ['codex', THREAD],
                ],
                checkpoints: [PARSER_VERSION, undefined, 5],
            });
            // The next pass reads nothing again.
            const again = await importUnderLease(store, codex, 'window-a');
            assert.deepStrictEqual([again?.read, again?.unchanged], [0, 1]);
        } finally {
            store.close();
        }
    });

    test("a rollout a window not yet updated checkpoints at an older parser while a pass is under way is left as it is, for the next pass of every file to forget with all of Codex's", async function () {
        if (!sqlite) {
            this.skip();
        }
        const first = fs.realpathSync(rollout([meta(0), context(1, 'gpt-5.5'), record(2, 1)]));
        const second = fs.realpathSync(rollout([meta(0, { id: PARENT, session_id: PARENT }), context(1, 'gpt-5.5'), record(2, 2, PARENT)], PARENT));
        assert.ok(first < second, 'the first is read first');
        const opened = UsageStore.open(sqlite, path.join(home, 'history', 'usage.sqlite'));
        assert.strictEqual(opened.status, 'ready');
        if (opened.status !== 'ready') {
            return;
        }
        const store = opened.store;
        const codex = [{ provider: 'codex' as const, roots: [home] }];
        const rows = () => [...store.requests()].map(r => [r.requestId, r.parserVersion]);
        try {
            // Between the two, an outdated window writes the second's rows and checkpoint, as its parser reads them.
            let wrote = false;
            const pause = () => {
                const checkpoint = store.getFile('codex', first);
                if (!wrote && checkpoint) {
                    wrote = true;
                    const [row] = [...store.requests()];
                    store.transaction(() => {
                        store.putFile({ ...checkpoint, path: second, parserVersion: CODEX_ROWS_SINCE - 1 });
                        store.upsertRequests([{ ...row, messageId: `r:${PARENT}:resp_older`, requestId: 'resp_older', sessionId: PARENT, file: second, parserVersion: CODEX_ROWS_SINCE - 1 }]);
                    });
                }
                return Promise.resolve();
            };
            const during = await importUnderLease(store, codex, 'window-a', { filesPerYield: 1, pause });
            assert.deepStrictEqual([wrote, during?.read, during?.unchanged, store.getFile('codex', second)?.parserVersion], [true, 1, 1, CODEX_ROWS_SINCE - 1]);
            const next = await importUnderLease(store, codex, 'window-a');
            assert.deepStrictEqual([next?.read, rows()], [
                2,
                [
                    ['resp_1', PARSER_VERSION],
                    ['resp_2', PARSER_VERSION],
                ],
            ]);
            const again = await importUnderLease(store, codex, 'window-a');
            assert.deepStrictEqual([again?.read, again?.unchanged], [0, 2]);
        } finally {
            store.close();
        }
    });
});

suite("usage Codex homes", () => {
    let tmp: string;

    setup(() => {
        // As the file system spells it, as roots are read: /private/var on
        // macOS, and on Windows the long names of an 8.3 short one, RUNNER~1.
        tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'llm-tokenizer-codex-homes-')));
    });

    teardown(() => {
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    const folder = (name: string) => {
        const p = path.join(tmp, name);
        fs.mkdirSync(p, { recursive: true });
        return p;
    };

    test('the setting, then CODEX_HOME as the editor sees it, then ~/.codex, each that is a folder, once', () => {
        const home = folder('home');
        const dotCodex = folder(path.join('home', '.codex'));
        const set = folder('set');
        const variable = folder('variable');
        const resolved = resolveCodexRoots({ setting: set, env: { CODEX_HOME: variable }, home });
        assert.deepStrictEqual(resolved.candidates.map(c => [c.source, c.path, c.exists]), [
            ['setting', set, true],
            ['process-environment', variable, true],
            ['default', dotCodex, true],
        ]);
        assert.deepStrictEqual(resolved.roots.map(r => r.path), [set, variable, dotCodex]);
        // One folder named three ways is read once; an empty CODEX_HOME is unset, as Codex takes it.
        const once = resolveCodexRoots({ setting: '~/.codex', env: { CODEX_HOME: `${dotCodex}${path.sep}` }, home });
        assert.deepStrictEqual(once.roots.map(r => [r.source, r.path]), [['setting', dotCodex]]);
        assert.deepStrictEqual(resolveCodexRoots({ setting: '', env: { CODEX_HOME: '  ' }, home }).candidates.map(c => c.source), ['default']);
    });

    test('a relative setting is listed and never read, and a missing folder is looked at and not read', () => {
        const home = path.join(tmp, 'nobody');
        const resolved = resolveCodexRoots({ setting: 'codex', env: { CODEX_HOME: path.join(tmp, 'missing') }, home });
        assert.deepStrictEqual(resolved.candidates.map(c => [c.source, c.exists, c.notAbsolute ?? false]), [
            ['setting', false, true],
            ['process-environment', false, false],
            ['default', false, false],
        ]);
        assert.deepStrictEqual(resolved.roots, []);
    });

    test('under test, a home, or its sessions, outside the fixtures is refused, never read', () => {
        const allowed = folder('allowed');
        const inside = folder(path.join('allowed', 'codex'));
        const outside = folder('outside');
        const leaky = folder(path.join('allowed', 'leaky'));
        fs.symlinkSync(outside, path.join(leaky, 'sessions'), 'dir');
        const resolved = resolveCodexRoots({ setting: outside, env: { CODEX_HOME: leaky }, home: inside, confineTo: [allowed] });
        assert.deepStrictEqual(resolved.refused.map(r => r.source), ['setting', 'process-environment']);
        assert.deepStrictEqual(resolved.roots, []);
        const fine = resolveCodexRoots({ setting: '', env: { CODEX_HOME: inside }, home: path.join(tmp, 'nobody'), confineTo: [allowed] });
        assert.deepStrictEqual(fine.roots.map(r => r.path), [inside]);
    });
});
