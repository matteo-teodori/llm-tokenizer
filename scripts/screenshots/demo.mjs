/**
 * An invented home for the README's screenshots: the demo workspace,
 * acme-storefront, and 30 days of Claude Code records for it and four other
 * invented projects, laid out as Claude Code lays out its own, on three
 * invented Claude accounts, with Claude Code's own configuration file naming
 * the one signed in now and one other.
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
/** The first days, before Claude Code recorded accounts: their sessions record none. */
const UNRECORDED_DAYS = 6;
/** The account a session was signed in to, by its project and how many days ago it began. */
function accountOf(project, daysAgo) {
    if (daysAgo >= 30 - UNRECORDED_DAYS) {
        return null;
    }
    if (project === 'design-system' || project === 'mobile-app') {
        return ACCOUNTS.personal;
    }
    if (project === 'data-pipeline' && daysAgo >= 12 && daysAgo <= 18) {
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
    const account = accountOf(project, Math.floor((today - Math.floor(start / DAY) * DAY) / DAY));
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

const processed = totals.input + totals.cacheCreation + totals.cacheRead + totals.output;
console.log(
    JSON.stringify({
        home,
        workspace,
        workspaceFiles,
        liveSession: LIVE,
        processed,
        ...totals,
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
    const labels = used.map(([name, a]) =>
        name === 'work' ? `${a.email} (${a.organization})` : name === 'personal' ? a.email : `Account ${order.indexOf(keyOf(a)) + 1}`,
    );
    return byAccount.none ? [...labels, 'Not recorded'] : labels;
}
