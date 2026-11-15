/**
 * An invented home for the README's screenshots: the demo workspace,
 * acme-storefront, and 30 days of Claude Code records for it and four other
 * invented projects, laid out as Claude Code lays out its own, on three
 * invented Claude accounts, with Claude Code's own configuration file naming
 * the one signed in now and one other; and 27 days of Codex rollouts for
 * three of those projects, from a generator of their own.
 *
 *   node demo.mjs <work dir> [now, ISO 8601]
 *
 * Writes <work>/home, emptied first. Nothing in it is anyone's usage: every
 * figure comes from a seeded generator, and the same now gives the same home.
 * Prints, as JSON, the totals it wrote, which the pages must show: capture.mjs
 * checks them.
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { claimWork, refuseEarlyHours } from './guard.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const work = resolve(process.argv[2] ?? '');
if (!process.argv[2]) {
    throw new Error('usage: node demo.mjs <work dir> [now]');
}
const NOW = process.argv[3] ? Date.parse(process.argv[3]) : Date.now();
const DAY = 86_400_000;
// Before anything is written: run alone, this is the only guard.
claimWork(work);
refuseEarlyHours(NOW);

const home = join(work, 'home');
const claude = join(home, '.claude');
const today = Math.floor(NOW / DAY) * DAY;
rmSync(home, { recursive: true, force: true });
mkdirSync(join(claude, 'projects'), { recursive: true });
mkdirSync(join(claude, 'sessions'), { recursive: true });

// The demo workspace's files as git has them: a leftover beside them, an
// editor's backup or a Finder .DS_Store, would change the token summary.
const workspace = join(home, 'code', 'acme-storefront');
const tracked = execFileSync('git', ['-C', here, 'ls-files', '-z', '--', 'workspace'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
if (tracked.length === 0) {
    throw new Error('no demo workspace in git: run from a clone of the repository');
}
for (const file of tracked) {
    const to = join(workspace, file.slice('workspace/'.length));
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(join(here, file), to);
}
const workspaceFiles = tracked.length;

// ── A seeded generator, so that a capture can be made again ─────────────────
let seed = 20261025;
function rand() {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const between = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const pick = weighted => {
    let r = rand() * weighted.reduce((s, [, w]) => s + w, 0);
    for (const [value, w] of weighted) {
        if ((r -= w) < 0) return value;
    }
    return weighted[weighted.length - 1][0];
};
const hex = n => Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join('');
const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-${pick([['8', 1], ['9', 1], ['a', 1], ['b', 1]])}${hex(3)}-${hex(12)}`;

/** Before Claude Code recorded a session's account, and after. */
const VERSION = '2.1.296';
const OWNER_VERSION = '2.1.320';
/**
 * The invented accounts: work, signed in now; a personal one, which Claude
 * Code's list of accounts names; and one it never named. Chosen by project
 * and day, never by the generator, so that every figure stays as it was.
 */
const ACCOUNTS = {
    work: { accountUuid: '5f3c2a1e-8b7d-4c6e-9a2f-1d0e3b4c5a6f', organizationUuid: 'c0ffee00-1234-4abc-8def-0123456789ab', email: 'dana@acme.example', organization: 'Acme Corp' },
    personal: { accountUuid: '7a9b8c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d', organizationUuid: '3e2d1c0b-9a8f-4e7d-8c6b-5a4f3e2d1c0b', email: 'dana@example.com', organization: "dana@example.com's Organization" },
    client: { accountUuid: '2b4d6f80-1a3c-4e5f-8a7b-9c0d1e2f3a4b', organizationUuid: '6c5b4a39-2817-4f6e-9d5c-4b3a29180f7e' },
};
/**
 * Claude Code recorded a session's account from version 2.1.318, which came
 * out around 4 November 2026: a session begun before then records none, as
 * the panel's note says, and so does one of the demo's first days whenever
 * it is made.
 */
const RECORDED_FROM = Date.UTC(2026, 10, 4);
const UNRECORDED_DAYS = 6;
/**
 * The account a session was signed in to, by its project and how many days
 * ago it began. The client's is the last first used, in the last few days,
 * so that it is the one the panel numbers 3.
 */
function accountOf(project, daysAgo, start) {
    if (daysAgo >= 30 - UNRECORDED_DAYS || start < RECORDED_FROM) {
        return null;
    }
    if (project === 'design-system' || project === 'mobile-app') {
        return ACCOUNTS.personal;
    }
    if (project === 'data-pipeline' && daysAgo >= 1 && daysAgo <= 3) {
        return ACCOUNTS.client;
    }
    return ACCOUNTS.work;
}
const PROJECTS = [
    ['acme-storefront', 38],
    ['inventory-api', 24],
    ['design-system', 16],
    ['data-pipeline', 14],
    ['mobile-app', 8],
];
const MAIN_MODELS = [
    ['claude-sonnet-5-5', 46],
    ['claude-opus-5-5', 38],
    ['claude-fable-5-1', 8],
    ['claude-haiku-5-5', 8],
];
const EFFORT = {
    'claude-sonnet-5-5': [['high', 6], ['medium', 3], ['xhigh', 1]],
    'claude-opus-5-5': [['high', 5], ['xhigh', 3], ['max', 2]],
    'claude-fable-5-1': [['high', 3], ['max', 2]],
    'claude-haiku-5-5': [['medium', 3], ['low', 2]],
};

const totals = { requests: 0, input: 0, cacheCreation: 0, cacheRead: 0, output: 0, thinking: 0, sessions: 0, compactions: 0, limits: 0 };
/** Requests and sessions by project, for the pages' per-project figures. */
const byProject = {};
/** Requests and sessions by account's key, as the panel keys them, for the account filter's figures, and when each was first used. */
const byAccount = {};
const files = new Map();
const write = (file, line) => {
    const lines = files.get(file) ?? [];
    lines.push(JSON.stringify(line));
    files.set(file, lines);
};
const iso = ms => new Date(ms).toISOString();

/**
 * One transcript's requests: a context that grows with every request, read
 * back from the cache, the new part written to it, compacted past `ceiling`.
 */
function requests(file, base, { model, count, start, span, context, ceiling, sidechain, effort, last }) {
    let ctx = context;
    let at = start;
    const step = span / Math.max(1, count);
    for (let i = 0; i < count; i++) {
        at += step * (0.4 + rand() * 1.2);
        const first = i === 0;
        const added = first ? ctx : between(700, 7_500);
        let input = between(3, 40);
        let cacheRead = first ? 0 : ctx;
        let cacheCreation = added;
        let output = 120 + Math.floor(rand() ** 2 * 3_800);
        if (last && i === count - 1) {
            // The running session's latest request: 532,842 tokens of context.
            input = 6;
            cacheCreation = 2_836;
            cacheRead = 530_000;
            output = 1_412;
        }
        const thinking = Math.floor(output * (0.15 + rand() * 0.2));
        const oneHour = model === 'claude-opus-5-5' && rand() < 0.2 ? Math.floor(cacheCreation * 0.6) : 0;
        const id = `msg_${hex(24)}`;
        const usage = {
            input_tokens: input,
            cache_creation_input_tokens: cacheCreation,
            cache_read_input_tokens: cacheRead,
            output_tokens: output,
            cache_creation: { ephemeral_5m_input_tokens: cacheCreation - oneHour, ephemeral_1h_input_tokens: oneHour },
            service_tier: 'standard',
            output_tokens_details: { thinking_tokens: thinking },
        };
        if (rand() < 0.03) {
            usage.server_tool_use = { web_search_requests: between(1, 3), web_fetch_requests: between(0, 2) };
        }
        write(file, {
            parentUuid: null,
            isSidechain: sidechain !== undefined,
            ...(sidechain ? { agentId: sidechain } : {}),
            message: { model, id, type: 'message', role: 'assistant', content: [{ type: 'text', text: '(demo)' }], stop_reason: 'end_turn', usage },
            requestId: `req_${hex(24)}`,
            type: 'assistant',
            uuid: uuid(),
            timestamp: iso(Math.min(at, NOW - 60_000)),
            ...base,
            ...(effort ? { effort } : {}),
        });
        totals.requests++;
        totals.input += input;
        totals.cacheCreation += cacheCreation;
        totals.cacheRead += cacheRead;
        totals.output += output;
        totals.thinking += thinking;
        ctx = cacheRead + cacheCreation + input + output;
        if (!last && ctx > ceiling) {
            const post = between(14_000, 32_000);
            write(file, {
                type: 'system',
                subtype: 'compact_boundary',
                uuid: uuid(),
                timestamp: iso(Math.min(at + 20_000, NOW - 60_000)),
                ...base,
                compactMetadata: { trigger: 'auto', preTokens: ctx, postTokens: post },
            });
            totals.compactions++;
            ctx = post;
        }
    }
    return at;
}

/** A session: its main transcript, the Task subagents and workflow agents it ran. */
function session({ project, start, minutes, count, model, live }) {
    const before = totals.requests;
    const cwd = join(home, 'code', project);
    const projectDir = cwd.replace(/[^A-Za-z0-9]/g, '-');
    const sessionId = live ?? uuid();
    const dir = join(claude, 'projects', projectDir);
    const main = join(dir, `${sessionId}.jsonl`);
    const account = accountOf(project, Math.floor((today - Math.floor(start / DAY) * DAY) / DAY), start);
    const base = { sessionId, version: account ? OWNER_VERSION : VERSION, cwd };
    // As Claude Code writes it: with the session's metadata, its account's ids only.
    const owner = account && { type: 'session-owner', accountUuid: account.accountUuid, organizationUuid: account.organizationUuid, sessionId };
    write(main, { type: 'user', uuid: uuid(), timestamp: iso(start), ...base, message: { role: 'user', content: '(demo)' } });
    if (owner) {
        write(main, owner);
    }
    const effort = pick(EFFORT[model]);
    const span = minutes * 60_000;
    const end = requests(main, base, {
        model,
        count,
        start,
        span,
        context: between(15_000, 22_000),
        ceiling: model === 'claude-haiku-5-5' ? 160_000 : between(200_000, 400_000),
        effort,
        last: live !== undefined,
    });
    for (let a = 0, agents = live ? 2 : pick([[0, 3], [1, 3], [2, 2], [3, 1], [4, 1]]); a < agents; a++) {
        const agentId = hex(17);
        const subModel = pick([['claude-haiku-5-5', 6], ['claude-sonnet-5-5', 3]]);
        requests(join(dir, sessionId, 'subagents', `agent-${agentId}.jsonl`), base, {
            model: subModel,
            count: between(6, 34),
            start: start + rand() * span * 0.7,
            span: span * 0.2,
            context: between(9_000, 16_000),
            ceiling: 150_000,
            sidechain: agentId,
            effort: pick(EFFORT[subModel]),
        });
    }
    if (!live && rand() < 0.09) {
        const run = hex(8);
        for (let a = 0, agents = between(2, 4); a < agents; a++) {
            const agentId = hex(17);
            const subModel = pick([['claude-sonnet-5-5', 3], ['claude-haiku-5-5', 2]]);
            requests(join(dir, sessionId, 'subagents', 'workflows', `wf_${run}`, `agent-${agentId}.jsonl`), base, {
                model: subModel,
                count: between(10, 26),
                start: start + rand() * span * 0.5,
                span: span * 0.3,
                context: between(10_000, 18_000),
                ceiling: 150_000,
                sidechain: agentId,
                effort: pick(EFFORT[subModel]),
            });
        }
    }
    if (owner) {
        // Written again with the rest of the metadata, as Claude Code does.
        write(main, owner);
    }
    totals.sessions++;
    const own = (byProject[project] ??= { requests: 0, sessions: 0 });
    own.requests += totals.requests - before;
    own.sessions++;
    const key = account ? `${account.accountUuid}/${account.organizationUuid}` : 'none';
    const mine = (byAccount[key] ??= { requests: 0, sessions: 0, first: start });
    mine.requests += totals.requests - before;
    mine.sessions++;
    mine.first = Math.min(mine.first, start);
    return { main, base, end };
}

/** A request refused at a usage limit: a synthetic record, which carries no tokens. */
function limitHit({ main, base, end }, kind, resetHours) {
    write(main, {
        parentUuid: null,
        isSidechain: false,
        type: 'assistant',
        uuid: uuid(),
        timestamp: iso(end + 30_000),
        ...base,
        isApiErrorMessage: true,
        quotaLimits: { status: 'rejected', rateLimitType: kind, resetsAt: Math.floor((end + resetHours * 3_600_000) / 1000), overageStatus: 'rejected', isUsingOverage: false },
        message: { id: `msg_${hex(24)}`, model: '<synthetic>', role: 'assistant', content: [], usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 } },
    });
    totals.limits++;
}

// ── 30 days, today included, in UTC ────────────────────────────────────────
const sessions = [];
for (let d = 29; d >= 1; d--) {
    const day = today - d * DAY;
    const weekday = new Date(day).getUTCDay();
    const weekend = weekday === 0 || weekday === 6;
    // The history starts with the 30 days shown, as a month's worth does.
    const n = d === 29 ? between(2, 3) : weekend ? pick([[0, 3], [1, 2], [2, 1]]) : between(3, 5);
    for (let s = 0; s < n; s++) {
        const start = day + between(7, 18) * 3_600_000 + between(0, 59) * 60_000;
        sessions.push(session({ project: pick(PROJECTS), start, minutes: between(25, 190), count: between(40, 190), model: pick(MAIN_MODELS) }));
    }
}
// Today: an earlier session in the workspace, then the one running now, both
// inside today's UTC date (see refuseEarlyHours), so that Today shows them.
const morning = session({ project: 'acme-storefront', start: Math.max(today + 5 * 60_000, NOW - 4.5 * 3_600_000), minutes: 70, count: 90, model: 'claude-sonnet-5-5' });
const LIVE = 'b7e2c4a9-3f1d-4c8e-9a6b-2d5f0e1c7a34';
session({ project: 'acme-storefront', start: NOW - 95 * 60_000, minutes: 92, count: 72, model: 'claude-opus-5-5', live: LIVE });
// Two days a usage limit was reached.
limitHit(sessions[Math.floor(sessions.length * 0.4)], 'five_hour', 3);
limitHit(sessions[Math.floor(sessions.length * 0.85)], 'five_hour', 2);
void morning;
// The client's account, whatever the draws gave the last days: a session of
// its own two days ago, made last so that every figure before it stays.
session({ project: 'data-pipeline', start: today - 2 * DAY + 10 * 3_600_000, minutes: 55, count: 60, model: 'claude-sonnet-5-5' });

// ── Codex's rollouts, from a generator of their own ─────────────────────────
// Made after Claude Code's, from a seed of their own, so that every figure of
// Claude Code's stays as it was. As Codex 0.169 writes them, under its home's
// sessions/YYYY/MM/DD (local time, which the capture runs in UTC): a record
// per model response, the running totals after it with the limits' snapshot,
// each turn's start, context and end, and a subagent's rollout of its own.
const codex = join(home, '.codex');
const codexTotals = { requests: 0, sessions: 0, limits: 0, input: 0, cacheCreation: 0, cacheRead: 0, output: 0, thinking: 0 };
{
    let codexSeed = 20261115;
    const crand = () => {
        codexSeed = (codexSeed + 0x6d2b79f5) | 0;
        let t = Math.imul(codexSeed ^ (codexSeed >>> 15), 1 | codexSeed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const cbetween = (lo, hi) => lo + Math.floor(crand() * (hi - lo + 1));
    const cpick = weighted => {
        let r = crand() * weighted.reduce((s, [, w]) => s + w, 0);
        for (const [value, w] of weighted) {
            if ((r -= w) < 0) return value;
        }
        return weighted[weighted.length - 1][0];
    };
    const chex = n => Array.from({ length: n }, () => Math.floor(crand() * 16).toString(16)).join('');
    // Codex's thread ids are UUIDv7: their first 48 bits are when the thread began.
    const thread = at => `${Math.floor(at).toString(16).padStart(12, '0').slice(0, 8)}-${Math.floor(at).toString(16).padStart(12, '0').slice(8)}-7${chex(3)}-${cpick([['8', 1], ['9', 1], ['a', 1], ['b', 1]])}${chex(3)}-${chex(12)}`;
    const stamp = ms => new Date(ms).toISOString().slice(0, 19).replace(/:/g, '-');
    const CODEX_PROJECTS = [
        ['acme-storefront', 5],
        ['inventory-api', 3],
        ['data-pipeline', 2],
    ];
    const CODEX_MODELS = [
        ['gpt-5.6-sol', 6],
        ['gpt-5.5', 3],
    ];
    const codexByProject = {};
    const rollout = (id, at) => join(codex, 'sessions', ...new Date(at).toISOString().slice(0, 10).split('-'), `rollout-${stamp(at)}-${id}.jsonl`);
    /** A thread's rollout: `turns` turns of a few responses each, on a context that grows and is mostly read from the cache. */
    function codexThread({ id, session, project, start, turns, model, effort, subagent, refused }) {
        const cwd = join(home, 'code', project);
        const file = rollout(id, start);
        const lines = [];
        const line = (at, type, payload) => lines.push(JSON.stringify({ timestamp: iso(Math.min(at, NOW - 60_000)), type, payload }));
        line(start, 'session_meta', {
            session_id: session,
            id,
            timestamp: iso(start),
            cwd,
            originator: 'codex_vscode',
            cli_version: '0.169.0',
            source: subagent ? { subagent: { thread_spawn: { parent_thread_id: session, depth: 1, agent_nickname: 'Helper', agent_role: 'worker' } } } : 'vscode',
            model_provider: 'openai',
        });
        const total = { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 };
        let context = cbetween(16_000, 26_000);
        let at = start;
        let used = cbetween(4, 30);
        for (let turn = 0; turn < turns; turn++) {
            const turnId = thread(at);
            line(at, 'event_msg', { type: 'task_started', turn_id: turnId, started_at: Math.floor(at / 1000), model_context_window: 272_000 });
            line(at + 5, 'turn_context', { turn_id: turnId, cwd, approval_policy: 'on-request', model, effort, summary: 'auto' });
            const responses = cbetween(4, 14);
            for (let r = 0; r < responses; r++) {
                at += cbetween(6, 70) * 1000;
                const added = cbetween(1_500, 9_000);
                const output = 90 + Math.floor(crand() ** 2 * 2_400);
                const reasoning = Math.floor(output * (0.2 + crand() * 0.4));
                const write = cbetween(0, 40);
                const usage = { input_tokens: context + added, cached_input_tokens: context, cache_write_input_tokens: write, output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: context + added + output };
                for (const key of Object.keys(total)) {
                    total[key] += usage[key];
                }
                const responseId = `resp_${chex(48)}`;
                line(at, 'token_usage_record', { thread_id: id, turn_id: turnId, session_id: session, root_turn_id: turnId, response_id: responseId, usage });
                used = Math.min(97, used + cbetween(0, 2));
                line(at + 3, 'event_msg', {
                    type: 'token_count',
                    info: { total_token_usage: { ...total }, last_token_usage: usage, last_usage_includes_reasoning: true, model_context_window: 272_000 },
                    rate_limits: { limit_id: 'codex', limit_name: null, primary: { used_percent: used, window_minutes: 300, resets_at: Math.floor(at / 1000) + 3 * 3600 }, secondary: { used_percent: Math.floor(used / 3), window_minutes: 10_080, resets_at: Math.floor(at / 1000) + 4 * 86_400 }, credits: null, individual_limit: null, spend_control_reached: null, plan_type: 'plus', rate_limit_reached_type: null },
                });
                codexTotals.requests++;
                // As the panel counts them: input what is left of the cache, thinking part of the output.
                codexTotals.input += usage.input_tokens - usage.cached_input_tokens - Math.min(write, added);
                codexTotals.cacheRead += usage.cached_input_tokens;
                codexTotals.cacheCreation += Math.min(write, added);
                codexTotals.output += output;
                codexTotals.thinking += reasoning;
                context += added + output;
            }
            line(at + 8, 'event_msg', { type: 'task_complete', turn_id: turnId, last_agent_message: '(demo)', started_at: Math.floor(start / 1000), completed_at: Math.floor(at / 1000) });
            at += cbetween(2, 25) * 60_000;
        }
        if (refused) {
            // A request refused at the five-hour limit: its snapshot names it, and its turn ends on it.
            const turnId = thread(at);
            line(at, 'event_msg', { type: 'task_started', turn_id: turnId, started_at: Math.floor(at / 1000), model_context_window: 272_000 });
            line(at + 5, 'turn_context', { turn_id: turnId, cwd, approval_policy: 'on-request', model, effort, summary: 'auto' });
            line(at + 600, 'event_msg', {
                type: 'token_count',
                info: { total_token_usage: { ...total }, last_token_usage: { ...total }, last_usage_includes_reasoning: true, model_context_window: 272_000 },
                rate_limits: { limit_id: 'codex', limit_name: null, primary: { used_percent: 100, window_minutes: 300, resets_at: Math.floor(at / 1000) + refused * 3600 }, secondary: { used_percent: 41, window_minutes: 10_080, resets_at: Math.floor(at / 1000) + 3 * 86_400 }, credits: null, individual_limit: null, spend_control_reached: null, plan_type: 'plus', rate_limit_reached_type: 'rate_limit_reached' },
            });
            line(at + 640, 'event_msg', { type: 'task_complete', turn_id: turnId, last_agent_message: null, error: { message: '(demo) usage limit reached', codex_error_info: 'usage_limit_exceeded' } });
            codexTotals.limits++;
        }
        files.set(file, lines);
        return at;
    }
    function codexSession({ project, start, model }) {
        const before = codexTotals.requests;
        const id = thread(start);
        const effort = cpick([['medium', 4], ['high', 3], ['xhigh', 1]]);
        const end = codexThread({ id, session: id, project, start, turns: cbetween(3, 8), model, effort, refused: codexTotals.sessions === 6 ? 2 : 0 });
        if (crand() < 0.3) {
            codexThread({ id: thread(start + 60_000), session: id, project, start: start + cbetween(2, 20) * 60_000, turns: cbetween(1, 2), model: 'gpt-5.4-mini', effort: 'low', subagent: true });
        }
        codexTotals.sessions++;
        const own = (codexByProject[project] ??= { requests: 0, sessions: 0 });
        own.requests += codexTotals.requests - before;
        own.sessions++;
        return end;
    }
    for (let d = 27; d >= 1; d--) {
        const day = today - d * DAY;
        const weekday = new Date(day).getUTCDay();
        const n = weekday === 0 || weekday === 6 ? cpick([[0, 3], [1, 2]]) : cpick([[1, 3], [2, 3], [3, 1]]);
        for (let s = 0; s < n; s++) {
            codexSession({ project: cpick(CODEX_PROJECTS), start: day + cbetween(8, 19) * 3_600_000 + cbetween(0, 59) * 60_000, model: cpick(CODEX_MODELS) });
        }
    }
    // Today, in the workspace, before the Claude Code session running now.
    codexSession({ project: 'acme-storefront', start: Math.max(today + 10 * 60_000, NOW - 3.2 * 3_600_000), model: 'gpt-5.6-sol' });
    for (const [project, own] of Object.entries(codexByProject)) {
        const both = (byProject[project] ??= { requests: 0, sessions: 0 });
        both.requests += own.requests;
        both.sessions += own.sessions;
    }
}

for (const [file, lines] of files) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, lines.join('\n') + '\n');
}

// Claude Code's configuration file, where CLAUDE_CONFIG_DIR puts it: the
// account signed in now, and its list of the accounts it has known. The
// client's account is in neither, so the panel numbers it.
const { work: workAccount, personal } = ACCOUNTS;
writeFileSync(
    join(claude, '.claude.json'),
    JSON.stringify(
        {
            numStartups: 214,
            projects: { [workspace]: { allowedTools: [], hasTrustDialogAccepted: true } },
            oauthAccount: {
                accountUuid: workAccount.accountUuid,
                emailAddress: workAccount.email,
                organizationUuid: workAccount.organizationUuid,
                organizationName: workAccount.organization,
                displayName: 'Dana',
                organizationRole: 'user',
            },
            knownAccounts: {
                [workAccount.accountUuid]: { emailAddress: workAccount.email, organizations: { [workAccount.organizationUuid]: workAccount.organization } },
                [personal.accountUuid]: { emailAddress: personal.email, organizations: { [personal.organizationUuid]: personal.organization } },
            },
        },
        null,
        2,
    ),
);

// Each agent's alone, and every agent's, as the page shows them.
const claudeOnly = { requests: totals.requests, sessions: totals.sessions };
for (const key of ['requests', 'sessions', 'limits', 'input', 'cacheCreation', 'cacheRead', 'output', 'thinking']) {
    totals[key] += codexTotals[key];
}
const processed = totals.input + totals.cacheCreation + totals.cacheRead + totals.output;
console.log(
    JSON.stringify({
        home,
        workspace,
        workspaceFiles,
        liveSession: LIVE,
        processed,
        ...totals,
        agents: { 'claude-code': claudeOnly, codex: { requests: codexTotals.requests, sessions: codexTotals.sessions } },
        codexHome: codex,
        files: files.size,
        projects: Object.keys(byProject).sort(),
        byProject,
        byAccount,
        accounts: { work: keyOf(workAccount), labels: accountLabels() },
    }),
);

function keyOf(account) {
    return `${account.accountUuid}/${account.organizationUuid}`;
}

/**
 * The labels the panel must show for the accounts the demo used: Claude
 * Code's for the two its configuration names, the personal one without its
 * organization, and a number by first use for the one it does not.
 */
function accountLabels() {
    const used = Object.entries(ACCOUNTS).filter(([, a]) => byAccount[keyOf(a)]);
    const order = used.map(([, a]) => keyOf(a)).sort((a, b) => byAccount[a].first - byAccount[b].first);
    // What the README's images and its alt texts show.
    if (used.length !== 3 || order.indexOf(keyOf(ACCOUNTS.client)) !== 2) {
        throw new Error('the demo has not used its three accounts, the client last: no Account 3 to show');
    }
    const labels = used.map(([name, a]) =>
        name === 'work' ? `${a.email} (${a.organization})` : name === 'personal' ? a.email : `Account ${order.indexOf(keyOf(a)) + 1}`,
    );
    return byAccount.none ? [...labels, 'Not recorded'] : labels;
}
