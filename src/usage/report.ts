/**
 * What the Claude Code Usage panel shows for one range and one scope, folded
 * from the store's 15-minute sums.
 *
 * Pure: the zone, the clock and each session's project and scope are
 * parameters. The worker resolves projects (real paths, platform rules) and
 * gathers the rows; the rules are here, and tested here.
 */

import { ALL_ACCOUNTS, NOT_RECORDED, type AccountNumber } from './accounts';
import { BUCKET_MS, emptyTotals, localDate, mergeTotals, type UsageTotals } from './aggregate';
import { projectLabel, type ProjectRef } from './projects';
import type { AccountName } from './store';
import type { BucketSums, Compaction, LimitHit, OwnerSpan, PromptSize, SessionOwner, StoreCoverage, TranscriptKind } from './types';

/** Today, the last 7 or 30 local days, or everything held. Never "all time". */
export type RangeKey = 'today' | '7d' | '30d' | 'coverage';

export const RANGE_KEYS: readonly RangeKey[] = ['today', '7d', '30d', 'coverage'];

/** A session as the report needs it, its project already resolved. */
export interface ReportSession {
    sessionId: string;
    project: ProjectRef;
    /** Groups sessions into projects: equal for two spellings of one folder. */
    projectKey: string;
    /** Whether its session root is in a folder of the open workspace. */
    inWorkspace: boolean;
    /** Its whole observed span, not only the part in the range. */
    firstTs: number | null;
    lastTs: number | null;
    /**
     * The accounts it was signed in to, in time order, as its main
     * transcripts record them: the first also takes the requests before any
     * owner record. Empty where they record none.
     */
    owners: OwnerSpan[];
    /**
     * When it first reached a usage limit that records no owner: such limits
     * go to its owner at their time (see `ownerAt`), the first owner where
     * none has a time yet. Whenever dated, as the numbering takes them.
     */
    unownedHitTs: number | null;
    /** Its limits before the report's end, by the owner each records, null for none: when first and last. */
    limitSpans: { owner: SessionOwner | null; firstTs: number; lastTs: number }[];
}

export interface ReportInput {
    sums: BucketSums[];
    sessions: ReportSession[];
    compactions: Compaction[];
    limitHits: LimitHit[];
    coverage: StoreCoverage;
    /** What Claude Code's configuration named accounts, the history's and its own now. */
    accountNames?: AccountName[];
    /** Each account's number, by key, as the history gave it, those with no session left included (see `UsageStore.numberAccounts`). */
    accountNumbers?: ReadonlyMap<string, AccountNumber>;
    /** The keys of the accounts Claude Code is signed in to now. */
    currentAccounts?: string[];
}

export interface ReportOptions {
    range: RangeKey;
    /** An IANA zone the runtime knows; see `isTimeZone`. */
    zone: string;
    now: number;
    scope: 'all' | 'workspace';
    /** One account's requests only, by its key, or NOT_RECORDED's; every request when absent or ALL_ACCOUNTS. */
    account?: string;
    /** Rows kept per list, largest first; the rest are counted in `omitted`. */
    maxSessions?: number;
    maxProjects?: number;
}

export interface ModelRow {
    model: string;
    variant: string | null;
    totals: UsageTotals;
}

export interface ProjectRow {
    project: ProjectRef;
    label: string;
    sessions: number;
    totals: UsageTotals;
    models: ModelRow[];
}

export interface SessionRow {
    sessionId: string;
    project: ProjectRef;
    label: string;
    /**
     * The keys of the accounts its requests in the range were made with (see
     * `accountKey`), the first used first, at most MAX_SESSION_ACCOUNTS;
     * `moreAccounts` counts the rest.
     */
    accounts: string[];
    moreAccounts: number;
    firstTs: number | null;
    lastTs: number | null;
    /** Its time between requests in the range, pauses over ACTIVE_PAUSE_MS left out: see `activeTime`. */
    activeMs: number;
    totals: UsageTotals;
    models: ModelRow[];
    compactions: Compaction[];
}

/**
 * An account's requests in the range: an account and organization, by key,
 * or those of the sessions that record none.
 */
export interface AccountRow {
    key: string;
    owner: SessionOwner | null;
    sessions: number;
    totals: UsageTotals;
    models: ModelRow[];
    /** The projects its sessions in the range began in, the most processed first, at most `MAX_ACCOUNT_PROJECTS`. */
    projects: string[];
}

/** An account in the whole history, whatever the range: what the account filter offers, and when it was used. */
export interface AccountSeen {
    key: string;
    owner: SessionOwner | null;
    sessions: number;
    /** Its sessions' first and last use: a request, or a limit reached. */
    firstTs: number | null;
    lastTs: number | null;
    /**
     * Its number in the history, what names it when nothing else does, and
     * its organization's among the account's, as the history gave them: null
     * until a pass has numbered it (by first use, once the history is read
     * whole), and for the sessions that record none.
     */
    ordinal: number | null;
    organizationOrdinal: number | null;
    /** How many organizations the account has in the history, numbered or not yet: past one, an unnamed one is told by its number. */
    organizations: number;
}

/** The hits of one limit window: one limit type and one reset time, on one account. */
export interface LimitWindow {
    /** The account that hit it, by key: a limit is an account's. */
    account: string;
    limitType: string;
    resetsAt: number | null;
    hits: number;
    firstTs: number;
    /** The local day of its first hit. */
    date: string;
}

/** A day's requests on one model, at one speed, where they ran and of one prompt size: a CSV row. */
export interface DayModelRow {
    date: string;
    model: string;
    variant: string | null;
    speed: string | null;
    inferenceGeo: string | null;
    promptSize: PromptSize | null;
    totals: UsageTotals;
}

export interface UsageReport {
    range: RangeKey;
    /** The first local day covered, as YYYY-MM-DD; null for an empty history. */
    from: string | null;
    /** Today, where the reader is. */
    to: string;
    zone: string;
    scope: 'all' | 'workspace';
    /** The account filter applied: ALL_ACCOUNTS, or one key. */
    account: string;
    totals: UsageTotals;
    days: { date: string; totals: UsageTotals }[];
    models: ModelRow[];
    kinds: { kind: TranscriptKind; totals: UsageTotals }[];
    efforts: { effort: string | null; totals: UsageTotals }[];
    projects: ProjectRow[];
    sessions: SessionRow[];
    /** Every input of a hand-made cost calculation, by day and model. */
    dayModels: DayModelRow[];
    /** In the range, by processed; the sessions with no recorded owner in one row of their own. */
    accounts: AccountRow[];
    /**
     * Every account in the history, whatever the range and scope, by number;
     * those with no owner last. Capped, as the lists are, at the accounts
     * with the most sessions, and those every other list and the filter
     * name, so that each has its label.
     */
    accountsSeen: AccountSeen[];
    /** The names Claude Code's configuration gave accounts, and which it is signed in to now. */
    accountNames: AccountName[];
    currentAccounts: string[];
    /** Account-wide, so never narrowed to the workspace, but to an account when one is chosen. */
    limitWindows: LimitWindow[];
    /** Rows each list left out past its cap: counted in the totals, not listed. */
    omitted: {
        sessions: number;
        projects: number;
        models: number;
        efforts: number;
        dayModels: number;
        limitWindows: number;
        accounts: number;
        accountsSeen: number;
    };
    coverage: StoreCoverage;
}

const DEFAULT_MAX_SESSIONS = 200;
const DEFAULT_MAX_PROJECTS = 100;
/**
 * The other lists' caps. Real histories hold a handful of models and five
 * effort levels; these only bound what a hostile one can make the page
 * render (150,000 model ids overflowed the stack).
 */
const MAX_MODELS = 50;
const MAX_EFFORTS = 20;
const MAX_DAY_MODELS = 5_000;
const MAX_LIMIT_WINDOWS = 200;
/** An account's projects named, to tell it by. */
export const MAX_ACCOUNT_PROJECTS = 3;
/**
 * The accounts listed, and those the filter offers. Real histories hold a
 * few; one transcript whose records named a new account for each of
 * 100,000 sessions made a page of 85 MB.
 */
export const MAX_ACCOUNTS = 50;
export const MAX_ACCOUNTS_SEEN = 200;
/** A session's accounts named, in its row: real sessions have one or two. */
export const MAX_SESSION_ACCOUNTS = 3;
const KIND_ORDER: readonly TranscriptKind[] = ['main', 'task', 'workflow', 'other'];

/** The largest UTC offset in use, +14:00: no local day starts earlier than its UTC midnight minus this. */
const MAX_OFFSET_MS = 14 * 60 * 60 * 1000;

/**
 * The longest pause between two of a session's requests that its active time
 * still counts: one bucket. Measured on 18 real sessions of 400,000 requests,
 * their time between requests, longer pauses left out, came to 1.02 times
 * their working time: from each prompt to the last response of its turn,
 * tools and subagents at work included, and a pause of over 30 minutes inside
 * a turn left out. With 5 minutes it came to 0.91, with 10 to 0.98, and the
 * span from each session's first request to its last to 10.4. Any pause of a
 * bucket or more also makes the active time exact from the buckets alone (see
 * `activeTime`), where a shorter one would need every request.
 */
export const ACTIVE_PAUSE_MS = BUCKET_MS;

/**
 * How far ahead of this clock a request still counts: written on a machine
 * whose clock runs ahead. Records are written as they happen, so one dated
 * later, from a wrong clock, would count in every range until its day came;
 * it is kept, and counted from then, which is also when it counts if this
 * clock is the wrong one.
 */
export const AHEAD_ALLOWANCE_MS = 24 * 60 * 60 * 1000;

/** The time no request is counted from, at `now`. */
export function rangeUntil(now: number): number {
    return now + AHEAD_ALLOWANCE_MS;
}

/** The first local day `range` covers, or null for everything held. */
export function rangeStart(range: RangeKey, today: string): string | null {
    switch (range) {
        case 'today':
            return today;
        case '7d':
            return addDays(today, -6);
        case '30d':
            return addDays(today, -29);
        case 'coverage':
            return null;
    }
}

/**
 * The earliest request time the store must return for `range`: bucket
 * aligned, and early enough for the first local day in any zone, and for the
 * bucket before it, where a pause that ends in the range can start (see
 * `activeTime`). The report then keeps a bucket by its local day, exactly.
 */
export function rangeSince(range: RangeKey, zone: string, now: number): number {
    const from = rangeStart(range, localDate(now, zone));
    if (from === null) {
        return 0;
    }
    const [y, m, d] = from.split('-').map(Number);
    const since = Date.UTC(y, m - 1, d) - MAX_OFFSET_MS - ACTIVE_PAUSE_MS;
    return Math.floor(since / BUCKET_MS) * BUCKET_MS;
}

export function buildReport(input: ReportInput, options: ReportOptions): UsageReport {
    const { zone } = options;
    const to = localDate(options.now, zone);
    const from =
        options.range === 'coverage'
            ? input.coverage.start === null
                ? null
                : localDate(input.coverage.start, zone)
            : rangeStart(options.range, to);
    const inRange = (date: string) => from === null || date >= from;

    const sessionsById = new Map(input.sessions.map(s => [s.sessionId, s]));
    const account = options.account ?? ALL_ACCOUNTS;
    // The account requests were made with: the one they record, else their
    // session's at their time, and its first owner before any.
    const ownerOf = (owner: SessionOwner | null | undefined, session: ReportSession | undefined, ts: number) =>
        owner ?? (session ? ownerAt(session.owners, ts) : null);
    const ofAccount = (key: string) => account === ALL_ACCOUNTS || key === account;
    const inScope = (session: ReportSession | undefined) => options.scope === 'all' || session?.inWorkspace === true;

    let totals = emptyTotals();
    const days = new Map<string, UsageTotals>();
    const models = new Map<string, ModelRow>();
    const kinds = new Map<TranscriptKind, UsageTotals>();
    const efforts = new Map<string | null, UsageTotals>();
    const dayModels = new Map<string, DayModelRow>();
    const projects = new Map<string, { row: ProjectRow; sessionIds: Set<string>; models: Map<string, ModelRow> }>();
    const sessions = new Map<string, { row: SessionRow; models: Map<string, ModelRow> }>();
    const accounts = new Map<string, { row: AccountRow; sessionIds: Set<string>; models: Map<string, ModelRow>; projects: Map<string, number> }>();
    // The accounts each session's requests in the range were made with, and when each was first.
    const sessionAccounts = new Map<string, Map<string, number>>();
    // Each session's first and last request by bucket, the buckets fetched
    // before the range included, for its active time.
    const activity = new Map<string, Map<number, BucketActivity>>();

    for (const sums of input.sums) {
        const date = localDate(sums.bucket * BUCKET_MS, zone);
        const session = sessionsById.get(sums.sessionId);
        const owner = ownerOf(sums.owner, session, sums.firstTs);
        const accountKey = owner ? keyOf(owner) : NOT_RECORDED;
        if (!inScope(session) || !ofAccount(accountKey)) {
            continue;
        }
        noteActivity(activity, sums, inRange(date));
        if (!inRange(date)) {
            continue;
        }
        const t = totalsOfSums(sums);
        const modelKey = `${sums.model}\u0000${sums.variant ?? ''}`;

        totals = mergeTotals(totals, t);
        add(days, date, t);
        addModel(models, modelKey, sums, t);
        add(kinds, sums.kind, t);
        add(efforts, sums.effort, t);
        // Apart by all that a request's price depends on, beside its model.
        const dayModelKey = [date, modelKey, sums.speed ?? '', sums.inferenceGeo ?? '', sums.promptSize ?? ''].join('\u0000');
        const dayModel = dayModels.get(dayModelKey);
        dayModels.set(dayModelKey, {
            date,
            model: sums.model,
            variant: sums.variant,
            speed: sums.speed,
            inferenceGeo: sums.inferenceGeo,
            promptSize: sums.promptSize,
            totals: mergeTotals(dayModel?.totals ?? emptyTotals(), t),
        });

        // A request whose session has no row cannot happen once imported,
        // since every session a file names is sighted; it is kept, not lost.
        const project: ProjectRef = session?.project ?? { kind: 'unattributed', projectDir: '' };
        const projectKey = session?.projectKey ?? 'dir:';
        let p = projects.get(projectKey);
        if (!p) {
            p = {
                row: { project, label: projectLabel(project), sessions: 0, totals: emptyTotals(), models: [] },
                sessionIds: new Set(),
                models: new Map(),
            };
            projects.set(projectKey, p);
        }
        p.row.totals = mergeTotals(p.row.totals, t);
        p.sessionIds.add(sums.sessionId);
        addModel(p.models, modelKey, sums, t);

        let a = accounts.get(accountKey);
        if (!a) {
            a = {
                row: { key: accountKey, owner, sessions: 0, totals: emptyTotals(), models: [], projects: [] },
                sessionIds: new Set(),
                models: new Map(),
                projects: new Map(),
            };
            accounts.set(accountKey, a);
        }
        a.row.totals = mergeTotals(a.row.totals, t);
        a.sessionIds.add(sums.sessionId);
        addModel(a.models, modelKey, sums, t);
        const projectName = projectLabel(project);
        a.projects.set(projectName, (a.projects.get(projectName) ?? 0) + t.processed);
        const used = sessionAccounts.get(sums.sessionId) ?? new Map<string, number>();
        used.set(accountKey, Math.min(used.get(accountKey) ?? Infinity, sums.firstTs));
        sessionAccounts.set(sums.sessionId, used);

        let s = sessions.get(sums.sessionId);
        if (!s) {
            s = {
                row: {
                    sessionId: sums.sessionId,
                    project,
                    label: projectLabel(project),
                    accounts: [],
                    moreAccounts: 0,
                    firstTs: session?.firstTs ?? null,
                    lastTs: session?.lastTs ?? null,
                    activeMs: 0,
                    totals: emptyTotals(),
                    models: [],
                    compactions: [],
                },
                models: new Map(),
            };
            sessions.set(sums.sessionId, s);
        }
        s.row.totals = mergeTotals(s.row.totals, t);
        addModel(s.models, modelKey, sums, t);
    }

    for (const c of input.compactions) {
        const s = sessions.get(c.sessionId);
        // The main conversation's: a subagent compacts its own context.
        if (s && c.kind === 'main' && inRange(localDate(c.timestamp, zone))) {
            s.row.compactions.push(c);
        }
    }

    const projectRows = [...projects.values()].map(({ row, sessionIds, models: m }) => ({
        ...row,
        sessions: sessionIds.size,
        models: byProcessed([...m.values()]),
    }));
    const sessionRows = [...sessions.values()].map(({ row, models: m }) => ({
        ...row,
        ...firstUsed(sessionAccounts.get(row.sessionId)),
        activeMs: activeTime(activity.get(row.sessionId)),
        models: byProcessed([...m.values()]),
    }));
    const maxProjects = options.maxProjects ?? DEFAULT_MAX_PROJECTS;
    const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    const modelRows = byProcessed([...models.values()]);
    const effortRows = [...efforts]
        .map(([effort, t]) => ({ effort, totals: t }))
        .sort((a, b) => b.totals.processed - a.totals.processed || compareText(a.effort ?? '', b.effort ?? ''));
    // The newest rows are kept, then listed oldest day first, and within a
    // day largest first.
    const dayModelRows = [...dayModels.values()]
        .sort((a, b) => compareText(b.date, a.date) || b.totals.processed - a.totals.processed || compareText(a.model, b.model))
        .slice(0, MAX_DAY_MODELS)
        .sort((a, b) => compareText(a.date, b.date) || b.totals.processed - a.totals.processed || compareText(a.model, b.model));
    const hitAccount = (hit: LimitHit) => {
        const owner = ownerOf(hit.owner, sessionsById.get(hit.sessionId), hit.timestamp);
        return owner ? keyOf(owner) : NOT_RECORDED;
    };
    const windows = limitWindows(
        input.limitHits.filter(hit => ofAccount(hitAccount(hit))),
        hitAccount,
        zone,
        inRange,
    );
    const accountRows = [...accounts.values()]
        .map(({ row, sessionIds, models: m, projects: p }) => ({
            ...row,
            sessions: sessionIds.size,
            models: byProcessed([...m.values()]),
            projects: [...p].sort(([x, a], [y, b]) => b - a || compareText(x, y)).slice(0, MAX_ACCOUNT_PROJECTS).map(([name]) => name),
        }))
        .sort((a, b) => b.totals.processed - a.totals.processed || compareText(a.key, b.key));
    const listedSessions = sessionRows
        .sort((a, b) => b.totals.processed - a.totals.processed || (b.lastTs ?? 0) - (a.lastTs ?? 0) || compareText(a.sessionId, b.sessionId))
        .slice(0, maxSessions);
    const listedAccounts = accountRows.slice(0, MAX_ACCOUNTS);
    const listedWindows = windows.slice(-MAX_LIMIT_WINDOWS);
    // Past the cap, the accounts with the most sessions are kept, and every
    // one the page names elsewhere.
    const named = new Set([account, ...listedAccounts.map(a => a.key), ...listedSessions.flatMap(s => s.accounts), ...listedWindows.map(w => w.account)]);
    const seenRows = numbered(accountsSeen(input.sessions), input.accountNumbers).sort((a, b) => b.sessions - a.sessions || bySeenOrder(a, b));
    const seenKept = seenRows.filter((a, i) => i < MAX_ACCOUNTS_SEEN || named.has(a.key));

    return {
        range: options.range,
        from,
        to,
        zone,
        scope: options.scope,
        account,
        totals,
        days: [...days].sort(([a], [b]) => compareText(a, b)).map(([date, t]) => ({ date, totals: t })),
        models: modelRows.slice(0, MAX_MODELS),
        kinds: KIND_ORDER.filter(k => kinds.has(k)).map(kind => ({ kind, totals: kinds.get(kind) ?? emptyTotals() })),
        efforts: effortRows.slice(0, MAX_EFFORTS),
        projects: projectRows
            .sort((a, b) => b.totals.processed - a.totals.processed || compareText(a.label, b.label))
            .slice(0, maxProjects),
        sessions: listedSessions,
        dayModels: dayModelRows,
        accounts: listedAccounts,
        accountsSeen: seenKept.sort(bySeenOrder),
        accountNames: input.accountNames ?? [],
        currentAccounts: input.currentAccounts ?? [],
        limitWindows: listedWindows,
        omitted: {
            sessions: Math.max(0, sessionRows.length - maxSessions),
            projects: Math.max(0, projectRows.length - maxProjects),
            models: Math.max(0, modelRows.length - MAX_MODELS),
            efforts: Math.max(0, effortRows.length - MAX_EFFORTS),
            dayModels: Math.max(0, dayModels.size - MAX_DAY_MODELS),
            limitWindows: Math.max(0, windows.length - MAX_LIMIT_WINDOWS),
            accounts: Math.max(0, accountRows.length - MAX_ACCOUNTS),
            accountsSeen: seenRows.length - seenKept.length,
        },
        coverage: input.coverage,
    };
}

/** One group of sums as totals: partial when any request in it missed a counter. */
export function totalsOfSums(sums: BucketSums): UsageTotals {
    return {
        input: sums.input,
        cacheCreation: sums.cacheCreation,
        cacheRead: sums.cacheRead,
        output: sums.output,
        cacheWrite5m: sums.cacheWrite5m,
        cacheWrite1h: sums.cacheWrite1h,
        thinking: sums.thinking,
        webSearchRequests: sums.webSearchRequests,
        webFetchRequests: sums.webFetchRequests,
        processed: sums.input + sums.cacheCreation + sums.cacheRead + sums.output,
        provenance: sums.completeRequests < sums.requests ? 'partial' : 'reported',
        coverage: {
            start: sums.firstTs,
            newest: sums.lastTs,
            requests: sums.requests,
            incompleteRequests: sums.requests - sums.completeRequests,
        },
    };
}

/** A session's requests in one bucket: its first and last, and whether the bucket is in the range. */
interface BucketActivity {
    first: number;
    last: number;
    inRange: boolean;
}

function noteActivity(activity: Map<string, Map<number, BucketActivity>>, sums: BucketSums, inRange: boolean): void {
    let buckets = activity.get(sums.sessionId);
    if (!buckets) {
        buckets = new Map();
        activity.set(sums.sessionId, buckets);
    }
    const bucket = buckets.get(sums.bucket);
    if (!bucket) {
        buckets.set(sums.bucket, { first: sums.firstTs, last: sums.lastTs, inRange });
    } else {
        bucket.first = Math.min(bucket.first, sums.firstTs);
        bucket.last = Math.max(bucket.last, sums.lastTs);
    }
}

/**
 * A session's active time in the range: the time between its requests, its
 * subagents' included, inside the range, with every pause over
 * ACTIVE_PAUSE_MS left out.
 *
 * Exact from each bucket's first and last request, because the pause is at
 * least a bucket long: two requests in one bucket are less than a bucket
 * apart, so every pause inside one counts, and those add up to its last
 * request less its first; a pause between two buckets runs from the last
 * request of one to the first of the next one that has any. A pause that
 * starts before the range counts from the range's start: it can only end in
 * the range's first bucket, which starts at its first day's midnight.
 */
function activeTime(buckets: Map<number, BucketActivity> | undefined): number {
    if (!buckets) {
        return 0;
    }
    let active = 0;
    let previous: BucketActivity | null = null;
    for (const [key, bucket] of [...buckets].sort(([a], [b]) => a - b)) {
        if (bucket.inRange) {
            active += bucket.last - bucket.first;
            if (previous !== null && bucket.first - previous.last <= ACTIVE_PAUSE_MS) {
                active += bucket.first - (previous.inRange ? previous.last : key * BUCKET_MS);
            }
        }
        previous = bucket;
    }
    return active;
}

/**
 * The owner `owners`, a session's in time order, say it was under at `ts`:
 * the last whose requests had begun by then, else its first, which the
 * requests before any owner record also count under. Those with a time come
 * first, in its order, as `UsageStore.sessions` gives them, so the last to
 * have begun is found by halving: a session that changed owner thousands of
 * times costs a report no more than a few steps a row.
 */
export function ownerAt(owners: readonly OwnerSpan[], ts: number): SessionOwner | null {
    // The first span that had not begun by `ts`: one with no time yet, or a later one.
    let low = 0;
    let high = owners.length;
    while (low < high) {
        const middle = (low + high) >>> 1;
        const since = owners[middle].sinceTs;
        if (since !== null && since <= ts) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    return owners[low - 1]?.owner ?? owners[0]?.owner ?? null;
}

/** A session's accounts, by when each was first used in the range: the first few, and how many more. */
function firstUsed(used: Map<string, number> | undefined): { accounts: string[]; moreAccounts: number } {
    const keys = [...(used ?? [])].sort(([x, a], [y, b]) => a - b || compareText(x, y)).map(([key]) => key);
    return { accounts: keys.slice(0, MAX_SESSION_ACCOUNTS), moreAccounts: Math.max(0, keys.length - MAX_SESSION_ACCOUNTS) };
}

/**
 * The owners of a session that were in force for something: its first,
 * once the session has a request, a request or limit hit followed it, or
 * the session reached a limit that records no owner, which `ownerAt` gives
 * the first owner when it has no other in time; and every later one a
 * request or limit hit followed. One changed again before any, or one a
 * session was resumed under and quit before it asked anything, used no
 * account. As `usedAccounts` in store.ts.
 */
function usedOwners(s: ReportSession): OwnerSpan[] {
    return s.owners.filter((o, i) => (i === 0 ? s.firstTs !== null || o.sinceTs !== null || s.unownedHitTs !== null : o.sinceTs !== null));
}

/**
 * Every account in the history, from each session's whole span: when it was
 * used, which tells an account apart. A session counts for each account it
 * used: its first owner from the first of the session's first request, its
 * change's time and its first limit that records no owner; a later one from
 * its change's time, the request or limit after it; each until the next
 * one's, and the last until the session's last request, or a limit it
 * reached after that. A session that used none counts for the sessions that
 * record none, once it has a request or has reached a limit, which a report
 * then gives them too.
 */
function accountsSeen(sessions: ReportSession[]): AccountSeen[] {
    const seen = new Map<string, AccountSeen>();
    const counted = new Map<string, string>();
    const note = (owner: SessionOwner | null, sessionId: string, from: number | null, to: number | null) => {
        const key = owner ? keyOf(owner) : NOT_RECORDED;
        const a = seen.get(key) ?? { key, owner, sessions: 0, firstTs: null, lastTs: null, ordinal: null, organizationOrdinal: null, organizations: 0 };
        if (counted.get(key) !== sessionId) {
            counted.set(key, sessionId);
            a.sessions++;
        }
        a.firstTs = from === null ? a.firstTs : a.firstTs === null ? from : Math.min(a.firstTs, from);
        a.lastTs = to === null ? a.lastTs : a.lastTs === null ? to : Math.max(a.lastTs, to);
        seen.set(key, a);
    };
    for (const s of sessions) {
        const spans = usedOwners(s);
        // A session's last use: its last request, or a limit its last owner
        // reached after it, never one another account reached.
        const unowned = s.limitSpans.find(h => h.owner === null) ?? null;
        const lastSpan = spans[spans.length - 1];
        const ownedEnd = lastSpan
            ? s.limitSpans.filter(h => h.owner !== null && keyOf(h.owner) === keyOf(lastSpan.owner)).reduce<number | null>((m, h) => latest(m, h.lastTs), null)
            : null;
        const unownedEnd = unowned && (!lastSpan || lastSpan.sinceTs === null || unowned.lastTs >= lastSpan.sinceTs) ? unowned.lastTs : null;
        const last = latest(s.lastTs, latest(ownedEnd, unownedEnd));
        // The sessions that record none: from requests and limits before the clock, as nothing numbers them.
        if (spans.length === 0 && (s.firstTs !== null || unowned !== null)) {
            note(null, s.sessionId, earliest(s.firstTs, unowned?.firstTs ?? null), last);
        }
        // Dated as the history numbers them: the first from the first of the
        // session's first request, its own change's time and the first limit
        // that records no owner; a later one from its change's.
        spans.forEach((o, i) =>
            note(
                o.owner,
                s.sessionId,
                i === 0 ? earliest(earliest(s.firstTs, o.sinceTs), s.unownedHitTs) : o.sinceTs,
                spans[i + 1]?.sinceTs ?? last,
            ),
        );
    }
    return [...seen.values()];
}

/**
 * `seen` with the numbers the history gave its accounts. One a pass has
 * found and not numbered yet has none until it has: shown by the first
 * digits of its id, never by a number the pass might not give it, as an
 * account first used earlier in a file read later would take its place.
 */
function numbered(seen: AccountSeen[], stored: ReadonlyMap<string, AccountNumber> | undefined): AccountSeen[] {
    const numbers = stored ?? new Map<string, AccountNumber>();
    // An account's organizations: those the history numbered, and those not numbered yet.
    const organizations = new Map<string, Set<string>>();
    const add = (key: string) => {
        const accountUuid = key.slice(0, key.indexOf('/'));
        organizations.set(accountUuid, (organizations.get(accountUuid) ?? new Set()).add(key));
    };
    [...numbers.keys()].forEach(add);
    seen.filter(a => a.owner !== null).forEach(a => add(a.key));
    return seen.map(a => ({
        ...a,
        ordinal: numbers.get(a.key)?.ordinal ?? null,
        organizationOrdinal: numbers.get(a.key)?.organization ?? null,
        organizations: a.owner ? (organizations.get(a.owner.accountUuid)?.size ?? 1) : 0,
    }));
}

/** By number, one account's organizations by theirs, and the sessions with no owner last. */
function bySeenOrder(a: AccountSeen, b: AccountSeen): number {
    return (
        Number(a.key === NOT_RECORDED) - Number(b.key === NOT_RECORDED) ||
        (a.ordinal ?? Infinity) - (b.ordinal ?? Infinity) ||
        (a.organizationOrdinal ?? Infinity) - (b.organizationOrdinal ?? Infinity) ||
        (a.firstTs ?? Infinity) - (b.firstTs ?? Infinity) ||
        compareText(a.key, b.key)
    );
}

/** The earlier of two times either of which may be missing, and the later. */
function earliest(a: number | null, b: number | null): number | null {
    return a === null ? b : b === null ? a : Math.min(a, b);
}
function latest(a: number | null, b: number | null): number | null {
    return a === null ? b : b === null ? a : Math.max(a, b);
}

/** As `accountKey` makes it; kept here so that the report's rules read on their own. */
function keyOf(owner: SessionOwner): string {
    return `${owner.accountUuid}/${owner.organizationUuid ?? ''}`;
}

/** Limit hits in the range, one row per window: an account, a limit type and its reset time. */
function limitWindows(hits: LimitHit[], accountOf: (hit: LimitHit) => string, zone: string, inRange: (date: string) => boolean): LimitWindow[] {
    const windows = new Map<string, LimitWindow>();
    for (const hit of hits) {
        const date = localDate(hit.timestamp, zone);
        if (!inRange(date)) {
            continue;
        }
        const account = accountOf(hit);
        const key = `${account}\u0000${hit.limitType}\u0000${hit.resetsAt ?? ''}`;
        const window = windows.get(key);
        if (!window) {
            windows.set(key, { account, limitType: hit.limitType, resetsAt: hit.resetsAt, hits: 1, firstTs: hit.timestamp, date });
        } else {
            window.hits++;
            if (hit.timestamp < window.firstTs) {
                window.firstTs = hit.timestamp;
                window.date = date;
            }
        }
    }
    return [...windows.values()].sort((a, b) => a.firstTs - b.firstTs || compareText(a.limitType, b.limitType));
}

function add<K>(map: Map<K, UsageTotals>, key: K, t: UsageTotals): void {
    map.set(key, mergeTotals(map.get(key) ?? emptyTotals(), t));
}

function addModel(map: Map<string, ModelRow>, key: string, sums: BucketSums, t: UsageTotals): void {
    const row = map.get(key);
    map.set(key, { model: sums.model, variant: sums.variant, totals: mergeTotals(row?.totals ?? emptyTotals(), t) });
}

function byProcessed(rows: ModelRow[]): ModelRow[] {
    return rows.sort(
        (a, b) =>
            b.totals.processed - a.totals.processed || compareText(a.model, b.model) || compareText(a.variant ?? '', b.variant ?? ''),
    );
}

/** Code-unit order, the same everywhere: never the locale's. */
function compareText(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

/** `date` (YYYY-MM-DD) moved by `days` calendar days. */
function addDays(date: string, days: number): string {
    const [y, m, d] = date.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
