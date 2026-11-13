/**
 * The worker's side of a report: what the store holds for the range, each
 * session's project resolved on this machine, folded by `report.ts`.
 *
 * Real paths are resolved here, where the file system is: a session root and
 * a workspace folder are compared after `realpath`, when the path still
 * exists, so `/var` and `/private/var`, or a symlinked checkout, are one
 * folder. A UNC path is compared as written, never resolved: on Windows that
 * would connect to the server it names, and a cwd comes from a record. So is
 * one under /net or /Network, which the automounter would mount from the host
 * it names, and wait on while that host does not answer.
 */

import * as fs from 'fs';
import * as path from 'path';

import { accountKey } from './accounts';
import type { ConfiguredAccounts } from './claudeAccounts';
import { comparablePath, isWithin, projectOf, sessionRoot } from './projects';
import { buildReport, rangeSince, rangeUntil, type RangeKey, type ReportSession, type UsageReport } from './report';
import type { AccountName, StoredSession, UsageStore } from './store';

export interface ReportQuery {
    range: RangeKey;
    zone: string;
    /** The open workspace's folders, for its scope; null for every project. */
    workspaceFolders: string[] | null;
    now: number;
    platform: NodeJS.Platform;
    /** One account's sessions only, by key; every session when absent. */
    account?: string;
    /** What Claude Code's configuration says now of its accounts. */
    configured?: ConfiguredAccounts;
    /** Resolves symlinks; the path itself when it no longer exists (tests). */
    realpath?: (p: string) => string;
}

export function queryReport(store: UsageStore, query: ReportQuery): UsageReport {
    const since = rangeSince(query.range, query.zone, query.now);
    const until = rangeUntil(query.now);
    // One snapshot: read statement by statement, another window's commit
    // could land between the sums and the sessions they belong to.
    const input = store.read(() => ({
        sums: store.bucketSums(since, until),
        sessions: store.sessions(until),
        compactions: store.compactions(since, until),
        limitHits: store.limitHits(since, until),
        coverage: store.coverage(until),
        accountNames: store.accountNames(),
        accountNumbers: store.accountNumbers(),
    }));
    const configured = query.configured ?? { names: [], current: [] };
    return buildReport(
        {
            ...input,
            sessions: reportSessions(input.sessions, query),
            accountNames: mergeNames(configured.names, input.accountNames),
            currentAccounts: configured.current.map(accountKey),
        },
        { range: query.range, zone: query.zone, now: query.now, scope: query.workspaceFolders ? 'workspace' : 'all', account: query.account },
    );
}

/**
 * The names Claude Code's configuration gives now, over those the history
 * kept: a name it gives now is the newer one, and one it no longer gives is
 * kept as it was.
 */
function mergeNames(now: AccountName[], kept: AccountName[]): AccountName[] {
    const merged = new Map(kept.map(n => [accountKey(n), n]));
    for (const n of now) {
        const before = merged.get(accountKey(n));
        merged.set(accountKey(n), {
            ...n,
            email: n.email ?? before?.email ?? null,
            organizationName: n.organizationName ?? before?.organizationName ?? null,
        });
    }
    return [...merged.values()];
}

/** Each stored session with its project, its grouping key and whether it is in the workspace. */
export function reportSessions(
    sessions: StoredSession[],
    query: Pick<ReportQuery, 'workspaceFolders' | 'platform' | 'realpath'>,
): ReportSession[] {
    const realpath = query.realpath ?? realOrSelf;
    const resolved = new Map<string, string>();
    const resolve = (p: string) => {
        let real = resolved.get(p);
        if (real === undefined) {
            real = realpath(p);
            resolved.set(p, real);
        }
        return real;
    };
    const folders = (query.workspaceFolders ?? []).map(resolve);

    return sessions.map(s => {
        const root = s.cwd === null ? null : sessionRoot(s.cwd);
        const real = root === null ? null : resolve(root);
        return {
            sessionId: s.sessionId,
            project: projectOf(root, s.projectDir),
            projectKey: real === null ? `dir:${s.projectDir}` : `root:${comparablePath(real, query.platform)}`,
            inWorkspace: real !== null && folders.some(folder => isWithin(real, folder, query.platform)),
            firstTs: s.firstTs,
            lastTs: s.lastTs,
            owner: s.owner ?? null,
        };
    });
}

/** Whether a session that started in `cwd` counts for one of `folders`, as "This workspace" counts it. */
export function inFolders(
    cwd: string,
    folders: readonly string[],
    platform: NodeJS.Platform,
    realpath: (p: string) => string = realOrSelf,
): boolean {
    const root = realpath(sessionRoot(cwd));
    return folders.some(folder => isWithin(root, realpath(folder), platform));
}

function realOrSelf(p: string): string {
    if (!path.isAbsolute(p) || /^[\\/]{2}/.test(p) || /^\/(net|Network)(\/|$)/.test(p)) {
        return p;
    }
    try {
        return fs.realpathSync(p);
    } catch {
        return p;
    }
}
