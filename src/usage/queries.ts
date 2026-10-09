/**
 * The worker's side of a report: what the store holds for the range, each
 * session's project resolved on this machine, folded by `report.ts`.
 *
 * Real paths are resolved here, where the file system is: a session root and
 * a workspace folder are compared after `realpath`, when the path still
 * exists, so `/var` and `/private/var`, or a symlinked checkout, are one
 * folder. A UNC path is compared as written, never resolved: on Windows that
 * would connect to the server it names, and a cwd comes from a record.
 */

import * as fs from 'fs';
import * as path from 'path';

import { comparablePath, isWithin, projectOf, sessionRoot } from './projects';
import { buildReport, rangeSince, type RangeKey, type ReportSession, type UsageReport } from './report';
import type { UsageStore } from './store';
import type { SessionSighting } from './types';

export interface ReportQuery {
    range: RangeKey;
    zone: string;
    /** The open workspace's folders, for its scope; null for every project. */
    workspaceFolders: string[] | null;
    now: number;
    platform: NodeJS.Platform;
    /** Resolves symlinks; the path itself when it no longer exists (tests). */
    realpath?: (p: string) => string;
}

export function queryReport(store: UsageStore, query: ReportQuery): UsageReport {
    const since = rangeSince(query.range, query.zone, query.now);
    return buildReport(
        {
            sums: store.bucketSums(since),
            sessions: reportSessions(store.sessions(), query),
            compactions: store.compactions(since),
            limitHits: store.limitHits(since),
            coverage: store.coverage(),
        },
        { range: query.range, zone: query.zone, now: query.now, scope: query.workspaceFolders ? 'workspace' : 'all' },
    );
}

/** Each stored session with its project, its grouping key and whether it is in the workspace. */
export function reportSessions(
    sessions: SessionSighting[],
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
        };
    });
}

function realOrSelf(p: string): string {
    if (!path.isAbsolute(p) || /^[\\/]{2}/.test(p)) {
        return p;
    }
    try {
        return fs.realpathSync(p);
    } catch {
        return p;
    }
}
