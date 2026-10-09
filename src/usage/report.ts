/**
 * What the Claude Code Usage panel shows for one range and one scope, folded
 * from the store's 15-minute sums.
 *
 * Pure: the zone, the clock and each session's project and scope are
 * parameters. The worker resolves projects (real paths, platform rules) and
 * gathers the rows; the rules are here, and tested here.
 */

import { BUCKET_MS, emptyTotals, localDate, mergeTotals, type UsageTotals } from './aggregate';
import { projectLabel, type ProjectRef } from './projects';
import type { BucketSums, Compaction, LimitHit, StoreCoverage, TranscriptKind } from './types';

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
}

export interface ReportInput {
    sums: BucketSums[];
    sessions: ReportSession[];
    compactions: Compaction[];
    limitHits: LimitHit[];
    coverage: StoreCoverage;
}

export interface ReportOptions {
    range: RangeKey;
    /** An IANA zone the runtime knows; see `isTimeZone`. */
    zone: string;
    now: number;
    scope: 'all' | 'workspace';
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
    firstTs: number | null;
    lastTs: number | null;
    totals: UsageTotals;
    models: ModelRow[];
    compactions: Compaction[];
}

/** The hits of one limit window: one limit type and one reset time. */
export interface LimitWindow {
    limitType: string;
    resetsAt: number | null;
    hits: number;
    firstTs: number;
    /** The local day of its first hit. */
    date: string;
}

export interface UsageReport {
    range: RangeKey;
    /** The first local day covered, as YYYY-MM-DD; null for an empty history. */
    from: string | null;
    /** Today, where the reader is. */
    to: string;
    zone: string;
    scope: 'all' | 'workspace';
    totals: UsageTotals;
    days: { date: string; totals: UsageTotals }[];
    models: ModelRow[];
    kinds: { kind: TranscriptKind; totals: UsageTotals }[];
    efforts: { effort: string | null; totals: UsageTotals }[];
    projects: ProjectRow[];
    sessions: SessionRow[];
    /** Every input of a hand-made cost calculation, by day and model. */
    dayModels: { date: string; model: string; variant: string | null; totals: UsageTotals }[];
    /** Account-wide, so never narrowed to the workspace. */
    limitWindows: LimitWindow[];
    omitted: { sessions: number; projects: number };
    coverage: StoreCoverage;
}

const DEFAULT_MAX_SESSIONS = 200;
const DEFAULT_MAX_PROJECTS = 100;
const KIND_ORDER: readonly TranscriptKind[] = ['main', 'task', 'workflow', 'other'];

/** The largest UTC offset in use, +14:00: no local day starts earlier than its UTC midnight minus this. */
const MAX_OFFSET_MS = 14 * 60 * 60 * 1000;

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
 * aligned, and early enough for the first local day in any zone. The report
 * then keeps a bucket by its local day, exactly.
 */
export function rangeSince(range: RangeKey, zone: string, now: number): number {
    const from = rangeStart(range, localDate(now, zone));
    if (from === null) {
        return 0;
    }
    const [y, m, d] = from.split('-').map(Number);
    const since = Date.UTC(y, m - 1, d) - MAX_OFFSET_MS;
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
    const inScope = (session: ReportSession | undefined) => options.scope === 'all' || session?.inWorkspace === true;

    let totals = emptyTotals();
    const days = new Map<string, UsageTotals>();
    const models = new Map<string, ModelRow>();
    const kinds = new Map<TranscriptKind, UsageTotals>();
    const efforts = new Map<string | null, UsageTotals>();
    const dayModels = new Map<string, { date: string; model: string; variant: string | null; totals: UsageTotals }>();
    const projects = new Map<string, { row: ProjectRow; sessionIds: Set<string>; models: Map<string, ModelRow> }>();
    const sessions = new Map<string, { row: SessionRow; models: Map<string, ModelRow> }>();

    for (const sums of input.sums) {
        const date = localDate(sums.bucket * BUCKET_MS, zone);
        const session = sessionsById.get(sums.sessionId);
        if (!inRange(date) || !inScope(session)) {
            continue;
        }
        const t = totalsOfSums(sums);
        const modelKey = `${sums.model}\u0000${sums.variant ?? ''}`;

        totals = mergeTotals(totals, t);
        add(days, date, t);
        addModel(models, modelKey, sums, t);
        add(kinds, sums.kind, t);
        add(efforts, sums.effort, t);
        const dayModelKey = `${date}\u0000${modelKey}`;
        const dayModel = dayModels.get(dayModelKey);
        dayModels.set(dayModelKey, {
            date,
            model: sums.model,
            variant: sums.variant,
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

        let s = sessions.get(sums.sessionId);
        if (!s) {
            s = {
                row: {
                    sessionId: sums.sessionId,
                    project,
                    label: projectLabel(project),
                    firstTs: session?.firstTs ?? null,
                    lastTs: session?.lastTs ?? null,
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
        if (s && inRange(localDate(c.timestamp, zone))) {
            s.row.compactions.push(c);
        }
    }

    const projectRows = [...projects.values()].map(({ row, sessionIds, models: m }) => ({
        ...row,
        sessions: sessionIds.size,
        models: byProcessed([...m.values()]),
    }));
    const sessionRows = [...sessions.values()].map(({ row, models: m }) => ({ ...row, models: byProcessed([...m.values()]) }));
    const maxProjects = options.maxProjects ?? DEFAULT_MAX_PROJECTS;
    const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;

    return {
        range: options.range,
        from,
        to,
        zone,
        scope: options.scope,
        totals,
        days: [...days].sort(([a], [b]) => compareText(a, b)).map(([date, t]) => ({ date, totals: t })),
        models: byProcessed([...models.values()]),
        kinds: KIND_ORDER.filter(k => kinds.has(k)).map(kind => ({ kind, totals: kinds.get(kind) ?? emptyTotals() })),
        efforts: [...efforts]
            .map(([effort, t]) => ({ effort, totals: t }))
            .sort((a, b) => b.totals.processed - a.totals.processed || compareText(a.effort ?? '', b.effort ?? '')),
        projects: projectRows
            .sort((a, b) => b.totals.processed - a.totals.processed || compareText(a.label, b.label))
            .slice(0, maxProjects),
        sessions: sessionRows
            .sort(
                (a, b) =>
                    b.totals.processed - a.totals.processed ||
                    (b.lastTs ?? 0) - (a.lastTs ?? 0) ||
                    compareText(a.sessionId, b.sessionId),
            )
            .slice(0, maxSessions),
        dayModels: [...dayModels.values()].sort(
            (a, b) => compareText(a.date, b.date) || b.totals.processed - a.totals.processed || compareText(a.model, b.model),
        ),
        limitWindows: limitWindows(input.limitHits, zone, inRange),
        omitted: {
            sessions: Math.max(0, sessionRows.length - maxSessions),
            projects: Math.max(0, projectRows.length - maxProjects),
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

/** Limit hits in the range, one row per window: a limit type and its reset time. */
function limitWindows(hits: LimitHit[], zone: string, inRange: (date: string) => boolean): LimitWindow[] {
    const windows = new Map<string, LimitWindow>();
    for (const hit of hits) {
        const date = localDate(hit.timestamp, zone);
        if (!inRange(date)) {
            continue;
        }
        const key = `${hit.limitType}\u0000${hit.resetsAt ?? ''}`;
        const window = windows.get(key);
        if (!window) {
            windows.set(key, { limitType: hit.limitType, resetsAt: hit.resetsAt, hits: 1, firstTs: hit.timestamp, date });
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
