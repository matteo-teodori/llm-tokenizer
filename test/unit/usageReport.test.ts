import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { BUCKET_MS, byDay, localDate } from '../../src/usage/aggregate';
import { importRoots } from '../../src/usage/importer';
import { comparablePath, isWithin, projectLabel, sessionRoot } from '../../src/usage/projects';
import type { UsageWorkerRequest, UsageWorkerResponse } from '../../src/usage/protocol';
import { queryReport, reportSessions, type ReportQuery } from '../../src/usage/queries';
import { buildReport, rangeSince, type RangeKey } from '../../src/usage/report';
import { currentHistory, startHistory } from '../../src/usage/historyFiles';
import { SCHEMA_VERSION, UsageStore, loadSqlite } from '../../src/usage/store';
import type { UsageRequest } from '../../src/usage/types';
import { WorkerHost } from '../../src/workerHost';

const FIXTURE_ROOT = path.join(__dirname, '..', '..', '..', 'test', 'fixtures', 'claude-config');
const sqlite = loadSqlite();

/** The history a worker keeps in `storeFile`'s folder: the one in use there. */
const historyIn = (storeFile: string) => currentHistory(path.dirname(storeFile)) ?? storeFile;

/** The day the fixture's requests fall on, at noon UTC: R4 is already the 10th in Rome. */
const FIXTURE_NOW = Date.UTC(2026, 9, 10, 12);

function seeded(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function request(overrides: Partial<UsageRequest>): UsageRequest {
    return {
        provider: 'claude-code',
        messageId: 'm',
        requestId: null,
        sessionId: 's',
        kind: 'main',
        isMain: true,
        timestamp: Date.UTC(2026, 9, 9, 12),
        model: 'claude-opus-5-5',
        variant: null,
        input: 1,
        cacheCreation: 2,
        cacheRead: 3,
        output: 4,
        cacheWrite5m: null,
        cacheWrite1h: null,
        thinking: null,
        effort: null,
        webSearchRequests: null,
        webFetchRequests: null,
        claudeCodeVersion: null,
        agentId: null,
        runId: null,
        file: '/f.jsonl',
        byteOffset: 0,
        parserVersion: 1,
        ...overrides,
    };
}

/** One JSON line. */
const line = (record: object) => JSON.stringify(record) + '\n';

/** A main transcript's opening user record, carrying its cwd. */
function userRecord(sessionId: string, cwd: string, timestamp: string): object {
    return { type: 'user', uuid: `u-${sessionId}-${timestamp}`, sessionId, timestamp, cwd, message: { role: 'user', content: 'x' } };
}

/** An assistant record in Claude Code's own key order: the message first. */
function assistantRecord(sessionId: string, id: string, timestamp: string, output = 1): object {
    return {
        parentUuid: null,
        isSidechain: false,
        message: {
            model: 'claude-opus-5-5',
            id,
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'Done.' }],
            usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: output },
        },
        type: 'assistant',
        uuid: `a-${id}`,
        timestamp,
        sessionId,
    };
}

suite('usage projects', () => {
    test('a session root is its cwd, cut at the first .claude/worktrees/ segment', () => {
        const cases: [string, string][] = [
            ['/repo/app', '/repo/app'],
            ['/repo/app/', '/repo/app'],
            ['/repo/.claude/worktrees/feat-x', '/repo'],
            ['/repo/.claude/worktrees/feat-x/src', '/repo'],
            // A worktree made inside a worktree still belongs to the outer repository.
            ['/repo/.claude/worktrees/a/.claude/worktrees/b', '/repo'],
            ['C:\\repo\\.claude\\worktrees\\x', 'C:\\repo'],
            ['C:\\repo/.claude\\worktrees/x', 'C:\\repo'],
            ['/.claude/worktrees/x', '/'],
            ['C:\\.claude\\worktrees\\x', 'C:\\'],
            ['/repo/.claude/worktreesX/y', '/repo/.claude/worktreesX/y'],
            ['/repo/.claude', '/repo/.claude'],
            ['/', '/'],
        ];
        assert.deepStrictEqual(
            cases.map(([cwd]) => sessionRoot(cwd)),
            cases.map(([, root]) => root),
        );
    });

    test('paths compare as their platform folds them', () => {
        // fsPath lower-cases a drive letter that a recorded cwd keeps upper.
        assert.ok(isWithin('C:\\Users\\m\\repo\\pkg', 'c:\\users\\m\\repo', 'win32'));
        assert.ok(isWithin('C:/Users/m/repo', 'C:\\Users\\m\\repo\\', 'win32'));
        assert.ok(isWithin('\\\\srv\\share\\repo', '\\\\srv\\share\\', 'win32'));
        assert.ok(isWithin('D:\\x', 'D:\\', 'win32'));
        assert.ok(!isWithin('C:\\x', 'D:\\', 'win32'));
        // APFS folds case and Unicode normalisation by default; ext4 neither.
        assert.ok(isWithin('/Repo/a', '/repo', 'darwin'));
        assert.ok(!isWithin('/Repo/a', '/repo', 'linux'));
        assert.ok(isWithin('/caf\u00e9', '/cafe\u0301', 'darwin'));
        assert.ok(!isWithin('/caf\u00e9', '/cafe\u0301', 'linux'));
        // A shared prefix is not a parent folder.
        assert.ok(!isWithin('/repo2', '/repo', 'linux'));
        assert.ok(isWithin('/anything', '/', 'linux'));
        assert.strictEqual(comparablePath('/repo///', 'linux'), '/repo');
    });

    test('a project is labelled by its last folder, or as Unattributed', () => {
        assert.strictEqual(projectLabel({ kind: 'root', path: '/repo/app' }), 'app');
        assert.strictEqual(projectLabel({ kind: 'root', path: 'C:\\work\\api' }), 'api');
        assert.strictEqual(projectLabel({ kind: 'root', path: '/' }), '/');
        assert.strictEqual(projectLabel({ kind: 'unattributed', projectDir: '-repo-app' }), 'Unattributed (-repo-app)');
    });
});

suite('usage report', () => {
    let tmp: string;
    let stores: UsageStore[] = [];

    function freshStore(): UsageStore {
        assert.ok(sqlite, 'this runtime has no node:sqlite');
        const result = UsageStore.open(sqlite, path.join(tmp, 'store', `usage-${stores.length}.sqlite`));
        assert.strictEqual(result.status, 'ready');
        stores.push(result.store);
        return result.store;
    }

    /** A query on this machine's paths as they are, unresolved: the fixture's folders do not exist. */
    const query = (overrides: Partial<ReportQuery> = {}): ReportQuery => ({
        range: 'coverage',
        zone: 'Europe/Rome',
        workspaceFolders: null,
        now: FIXTURE_NOW,
        platform: 'linux',
        realpath: p => p,
        ...overrides,
    });

    /** Write `records` as `<tmp>/root/projects/<dir>/<file>`. */
    function transcript(dir: string, file: string, records: object[]): void {
        const full = path.join(tmp, 'root', 'projects', dir, file);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, records.map(line).join(''));
    }

    setup(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-tokenizer-report-'));
    });

    teardown(() => {
        for (const store of stores) {
            store.close();
        }
        stores = [];
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    test('the fixtures report the totals worked out by hand', async () => {
        const store = freshStore();
        await importRoots(store, [FIXTURE_ROOT]);
        const report = queryReport(store, query());

        assert.deepStrictEqual([report.from, report.to, report.zone, report.scope], ['2026-10-09', '2026-10-10', 'Europe/Rome', 'all']);
        assert.deepStrictEqual(
            [report.totals.input, report.totals.cacheCreation, report.totals.cacheRead, report.totals.output, report.totals.processed],
            [197, 61, 917, 103, 1_278],
        );
        assert.strictEqual(report.totals.coverage.requests, 4);
        assert.deepStrictEqual(report.days.map(d => [d.date, d.totals.processed]), [['2026-10-09', 1_262], ['2026-10-10', 16]]);
        assert.deepStrictEqual(report.models.map(m => [m.model, m.variant, m.totals.processed]), [
            ['claude-opus-5-5', null, 1_068],
            ['claude-opus-5-5', '1m', 210],
        ]);
        assert.deepStrictEqual(report.kinds.map(k => [k.kind, k.totals.processed]), [['main', 1_240], ['task', 22], ['workflow', 16]]);
        assert.deepStrictEqual(report.efforts.map(e => [e.effort, e.totals.processed]), [[null, 1_068], ['high', 210]]);
        assert.deepStrictEqual(report.projects.map(p => [p.label, p.project, p.sessions, p.totals.processed]), [
            ['app', { kind: 'root', path: '/repo/app' }, 1, 1_278],
        ]);
        const [session] = report.sessions;
        assert.deepStrictEqual(
            [session.sessionId, session.firstTs, session.lastTs, session.totals.processed],
            ['sess-main-1', Date.parse('2026-10-09T10:00:06.000Z'), Date.parse('2026-10-09T23:30:00.000Z'), 1_278],
        );
        assert.deepStrictEqual(session.compactions.map(c => [c.trigger, c.preTokens, c.postTokens]), [['auto', 160_000, 12_000]]);
        assert.deepStrictEqual(report.limitWindows, [
            { limitType: 'five_hour', resetsAt: 1791561600, hits: 1, firstTs: Date.parse('2026-10-09T10:06:00.000Z'), date: '2026-10-09' },
        ]);
        assert.deepStrictEqual(report.omitted, { sessions: 0, projects: 0, models: 0, efforts: 0, dayModels: 0, limitWindows: 0 });
        assert.deepStrictEqual([report.coverage.requests, report.coverage.files], [4, 4]);
    });

    test('a range starts on its local day, and Today is where the reader is', async () => {
        const store = freshStore();
        await importRoots(store, [FIXTURE_ROOT]);
        const processed = (range: RangeKey, zone: string) => {
            const report = queryReport(store, query({ range, zone }));
            return [report.from, report.totals.processed];
        };
        // R4, at 23:30 UTC on the 9th, is already the 10th in Rome.
        assert.deepStrictEqual(processed('today', 'Europe/Rome'), ['2026-10-10', 16]);
        assert.deepStrictEqual(processed('today', 'UTC'), ['2026-10-10', 0]);
        assert.deepStrictEqual(processed('7d', 'Europe/Rome'), ['2026-10-04', 1_278]);
        assert.deepStrictEqual(processed('30d', 'UTC'), ['2026-09-11', 1_278]);

        const since = rangeSince('today', 'Europe/Rome', FIXTURE_NOW);
        assert.strictEqual(since % BUCKET_MS, 0);
        assert.ok(since <= Date.parse('2026-10-09T22:00:00.000Z'), 'the bound cuts into the first local day');
    });

    test('15-minute buckets fold into the same days as the requests themselves, in every zone', () => {
        // Around the April and October changes, in zones with half- and
        // quarter-hour offsets and the two extremes, ±14 and −11.
        const random = seeded(2026);
        const windows = [Date.UTC(2026, 2, 20), Date.UTC(2026, 9, 15)];
        const span = 27 * 86_400_000;
        const requests: UsageRequest[] = Array.from({ length: 400 }, (_, i) =>
            request({
                messageId: `m${i}`,
                sessionId: `s${i % 7}`,
                kind: (['main', 'task', 'workflow'] as const)[i % 3],
                model: i % 5 === 0 ? 'claude-sonnet-5-5' : 'claude-opus-5-5',
                timestamp: windows[i % 2] + Math.floor(random() * span),
                input: i % 11 === 0 ? null : Math.floor(random() * 1000),
                output: Math.floor(random() * 500),
                thinking: i % 4 === 0 ? 7 : null,
            }),
        );
        const store = freshStore();
        store.transaction(() => store.upsertRequests(requests));
        const zones = ['UTC', 'Europe/Rome', 'Asia/Kathmandu', 'Australia/Lord_Howe', 'America/St_Johns', 'Pacific/Kiritimati', 'Pacific/Pago_Pago'];

        for (const zone of zones) {
            const expected = [...byDay(requests, zone)].sort(([a], [b]) => (a < b ? -1 : 1));
            for (const range of ['coverage', 'today', '7d', '30d'] as const) {
                // A `now` near the end of each window, so each range cuts
                // through requests.
                for (const now of windows.map(w => w + span - 3 * 3_600_000)) {
                    const report = buildReport(
                        {
                            sums: store.bucketSums(rangeSince(range, zone, now)),
                            sessions: [],
                            compactions: [],
                            limitHits: [],
                            coverage: store.coverage(),
                        },
                        { range, zone, now, scope: 'all' },
                    );
                    const kept = expected.filter(([date]) => report.from === null || date >= report.from);
                    assert.deepStrictEqual(
                        report.days.map(d => [d.date, d.totals]),
                        kept,
                        `${zone}, ${range}, now ${new Date(now).toISOString()}`,
                    );
                }
            }
        }
        assert.strictEqual(localDate(windows[0], 'Pacific/Kiritimati'), '2026-03-20');
    });

    test('This workspace holds the sessions whose root is in one of its folders, each once', async () => {
        // Real paths: on macOS the temporary folder is reached through the
        // /var symlink, and the workspace folder is given as /private/var.
        const repo = path.join(tmp, 'repo');
        fs.mkdirSync(path.join(repo, 'packages', 'app'), { recursive: true });
        fs.mkdirSync(path.join(tmp, 'elsewhere'));
        transcript('-repo', 'a.jsonl', [userRecord('a', repo, '2026-10-09T10:00:00Z'), assistantRecord('a', 'ma', '2026-10-09T10:00:01Z', 1)]);
        transcript('-repo-packages-app', 'b.jsonl', [
            userRecord('b', path.join(repo, 'packages', 'app'), '2026-10-09T10:00:00Z'),
            assistantRecord('b', 'mb', '2026-10-09T10:00:01Z', 10),
        ]);
        transcript('-repo--claude-worktrees-feat', 'c.jsonl', [
            userRecord('c', path.join(repo, '.claude', 'worktrees', 'feat'), '2026-10-09T10:00:00Z'),
            assistantRecord('c', 'mc', '2026-10-09T10:00:01Z', 100),
        ]);
        transcript('-elsewhere', 'd.jsonl', [userRecord('d', path.join(tmp, 'elsewhere'), '2026-10-09T10:00:00Z'), assistantRecord('d', 'md', '2026-10-09T10:00:01Z', 1000)]);
        // A session whose main transcript is gone: only its subagent remains.
        transcript('-repo', path.join('e', 'subagents', 'agent-x.jsonl'), [assistantRecord('e', 'me', '2026-10-09T10:00:01Z', 10_000)]);

        const store = freshStore();
        await importRoots(store, [path.join(tmp, 'root')]);
        const folders = [fs.realpathSync(repo), fs.realpathSync(path.join(repo, 'packages'))];
        const report = queryReport(store, query({ workspaceFolders: folders, platform: process.platform, realpath: undefined }));

        // a (1), b (10) and c (100): nested folders count each session once.
        assert.strictEqual(report.totals.output, 111);
        assert.deepStrictEqual(report.projects.map(p => [p.label, p.sessions, p.totals.output]), [
            ['repo', 2, 101],
            ['app', 1, 10],
        ]);
        const all = queryReport(store, query({ platform: process.platform, realpath: undefined }));
        assert.deepStrictEqual(all.projects.map(p => [p.label, p.totals.output]), [
            ['Unattributed (-repo)', 10_000],
            ['elsewhere', 1_000],
            ['repo', 101],
            ['app', 10],
        ]);
    });

    test('two cwds that encode to one folder are two projects', async () => {
        transcript('-x-a-b', 's1.jsonl', [userRecord('s1', '/x/a-b', '2026-10-09T10:00:00Z'), assistantRecord('s1', 'm1', '2026-10-09T10:00:01Z')]);
        transcript('-x-a-b', 's2.jsonl', [userRecord('s2', '/x/a/b', '2026-10-09T10:00:00Z'), assistantRecord('s2', 'm2', '2026-10-09T10:00:01Z')]);
        const store = freshStore();
        await importRoots(store, [path.join(tmp, 'root')]);
        assert.deepStrictEqual(
            queryReport(store, query())
                .projects.map(p => p.project)
                .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
            [
                { kind: 'root', path: '/x/a-b' },
                { kind: 'root', path: '/x/a/b' },
            ],
        );
    });

    test('the earliest cwd is the session root, whatever order its files are read in', async () => {
        // `/cd` moved the session: its later transcript sorts first by path.
        transcript('-a-moved', 's.jsonl', [userRecord('s', '/a/moved', '2026-10-09T11:00:00Z'), assistantRecord('s', 'm2', '2026-10-09T11:00:01Z')]);
        transcript('-z-start', 's.jsonl', [userRecord('s', '/z/start', '2026-10-09T10:00:00Z'), assistantRecord('s', 'm1', '2026-10-09T10:00:01Z')]);
        const store = freshStore();
        await importRoots(store, [path.join(tmp, 'root')]);
        assert.deepStrictEqual(
            store.sessions().map(s => [s.sessionId, s.cwd]),
            [['s', '/z/start']],
        );

        // In the store, by time, then by text, and a known time beats none.
        const sighting = (cwd: string | null, cwdTs: number | null) => ({
            sessionId: 't', root: '/r', cwd, cwdTs, projectDir: 'p', firstTs: null, lastTs: null,
        });
        const orders: [string | null, number | null][][] = [
            [['/late', 2], ['/early', 1]],
            [['/early', 1], ['/late', 2]],
            [['/b', 1], ['/a', 1]],
            [['/timed', 5], ['/untimed', null]],
            [['/untimed', null], ['/timed', 5]],
            [[null, null], ['/only', 9]],
        ];
        const winners = orders.map(order => {
            const s = freshStore();
            s.transaction(() => order.forEach(([cwd, ts]) => s.upsertSession('claude-code', sighting(cwd, ts))));
            return s.sessions()[0].cwd;
        });
        assert.deepStrictEqual(winners, ['/early', '/early', '/a', '/timed', '/timed', '/only']);
    });

    test('a request copied from an earlier session is kept under that session', async () => {
        // A resumed transcript opening with a record of the session it resumed.
        transcript('-repo', 'new.jsonl', [
            userRecord('new', '/repo', '2026-10-09T10:00:00Z'),
            assistantRecord('old', 'm-old', '2026-10-09T09:00:00Z', 5),
            assistantRecord('new', 'm-new', '2026-10-09T10:00:01Z', 7),
        ]);
        const store = freshStore();
        await importRoots(store, [path.join(tmp, 'root')]);
        assert.deepStrictEqual(
            store.sessions().map(s => [s.sessionId, s.cwd, s.firstTs]),
            [
                ['new', '/repo', Date.parse('2026-10-09T10:00:01Z')],
                ['old', null, Date.parse('2026-10-09T09:00:00Z')],
            ],
        );
        const report = queryReport(store, query());
        assert.deepStrictEqual(report.sessions.map(s => [s.sessionId, s.label, s.totals.output]).sort(), [
            ['new', 'repo', 7],
            ['old', 'Unattributed (-repo)', 5],
        ]);
    });

    test('rows are capped, the rest counted, and the totals keep everything', () => {
        const store = freshStore();
        store.transaction(() =>
            store.upsertRequests([request({ messageId: 'a', sessionId: 's1', output: 5 }), request({ messageId: 'b', sessionId: 's2', output: 9 })]),
        );
        const report = buildReport(
            { sums: store.bucketSums(0), sessions: [], compactions: [], limitHits: [], coverage: store.coverage() },
            { range: 'coverage', zone: 'UTC', now: FIXTURE_NOW, scope: 'all', maxSessions: 1 },
        );
        assert.deepStrictEqual(report.sessions.map(s => s.sessionId), ['s2']);
        assert.deepStrictEqual([report.omitted.sessions, report.totals.output], [1, 14]);
    });

    test('the model and effort lists are capped too, the largest kept', () => {
        const store = freshStore();
        const pad = (i: number) => String(i).padStart(2, '0');
        store.transaction(() =>
            store.upsertRequests(
                Array.from({ length: 60 }, (_, i) =>
                    request({ messageId: `m${i}`, model: `model-${pad(i)}`, effort: `effort-${pad(i % 25)}`, output: 100 + i }),
                ),
            ),
        );
        const report = buildReport(
            { sums: store.bucketSums(0), sessions: [], compactions: [], limitHits: [], coverage: store.coverage() },
            { range: 'coverage', zone: 'UTC', now: FIXTURE_NOW, scope: 'all' },
        );
        assert.deepStrictEqual([report.models.length, report.omitted.models], [50, 10]);
        assert.deepStrictEqual([report.models[0].model, report.models.at(-1)?.model], ['model-59', 'model-10']);
        assert.deepStrictEqual([report.efforts.length, report.omitted.efforts], [20, 5]);
        assert.strictEqual(report.totals.output, 60 * 100 + (59 * 60) / 2);
    });

    test('within a day, the day-and-model rows are listed largest first', () => {
        const store = freshStore();
        store.transaction(() =>
            store.upsertRequests([
                request({ messageId: 'h', model: 'claude-haiku-4-5', output: 10 }),
                request({ messageId: 'o', model: 'claude-opus-4-6', output: 900 }),
                request({ messageId: 's', model: 'claude-sonnet-4-6', output: 300 }),
            ]),
        );
        const report = buildReport(
            { sums: store.bucketSums(0), sessions: [], compactions: [], limitHits: [], coverage: store.coverage() },
            { range: 'coverage', zone: 'UTC', now: FIXTURE_NOW, scope: 'all' },
        );
        assert.deepStrictEqual(report.dayModels.map(r => r.model), ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5']);
    });

    test('day-and-model rows are capped at the newest, the rest counted', () => {
        const store = freshStore();
        const day = (d: number) => Date.UTC(2025, 0, 1 + d, 12);
        const date = (d: number) => new Date(day(d)).toISOString().slice(0, 10);
        // Ten models a day for 501 days.
        store.transaction(() =>
            store.upsertRequests(
                Array.from({ length: 5_010 }, (_, i) => request({ messageId: `m${i}`, model: `model-${i % 10}`, timestamp: day(Math.floor(i / 10)) })),
            ),
        );
        const report = buildReport(
            { sums: store.bucketSums(0), sessions: [], compactions: [], limitHits: [], coverage: store.coverage() },
            { range: 'coverage', zone: 'UTC', now: FIXTURE_NOW, scope: 'all' },
        );
        assert.deepStrictEqual([report.dayModels.length, report.omitted.dayModels], [5_000, 10]);
        // Listed oldest first: the first day's rows are the ones left out.
        assert.deepStrictEqual([report.dayModels[0].date, report.dayModels.at(-1)?.date], [date(1), date(500)]);
        assert.strictEqual(report.totals.coverage.requests, 5_010);
    });

    test('limit windows are capped at the newest, the rest counted', () => {
        const store = freshStore();
        const hits = Array.from({ length: 210 }, (_, i) => ({
            uuid: `l${i}`,
            sessionId: 's',
            timestamp: Date.UTC(2026, 9, 1) + i * 60_000,
            limitType: 'five_hour',
            resetsAt: 1_791_000_000 + i * 3_600,
        }));
        const report = buildReport(
            { sums: store.bucketSums(0), sessions: [], compactions: [], limitHits: hits, coverage: store.coverage() },
            { range: '30d', zone: 'UTC', now: FIXTURE_NOW, scope: 'all' },
        );
        assert.deepStrictEqual([report.limitWindows.length, report.omitted.limitWindows], [200, 10]);
        assert.deepStrictEqual([report.limitWindows[0].firstTs, report.limitWindows.at(-1)?.firstTs], [hits[10].timestamp, hits[209].timestamp]);
    });

    test("a report is read from one snapshot, whatever another window commits during it", () => {
        const window = (): UsageStore => {
            assert.ok(sqlite, 'this runtime has no node:sqlite');
            const result = UsageStore.open(sqlite, path.join(tmp, 'store', 'shared.sqlite'));
            assert.strictEqual(result.status, 'ready');
            stores.push(result.store);
            return result.store;
        };
        const store = window();
        const other = window();
        store.transaction(() => store.upsertRequests([request({ messageId: 'a' })]));
        // Another window commits a request just after the sums are read.
        const sums = store.bucketSums.bind(store);
        store.bucketSums = since => {
            const read = sums(since);
            other.transaction(() => other.upsertRequests([request({ messageId: 'b' })]));
            return read;
        };
        const report = queryReport(store, query());
        assert.deepStrictEqual([report.totals.coverage.requests, report.coverage.requests], [1, 1]);
        assert.strictEqual(queryReport(store, query()).coverage.requests, 2);
    });

    test('limit windows are account-wide, never narrowed to the workspace', async () => {
        const store = freshStore();
        await importRoots(store, [FIXTURE_ROOT]);
        const report = queryReport(store, query({ workspaceFolders: ['/elsewhere'] }));
        assert.strictEqual(report.totals.processed, 0);
        assert.strictEqual(report.limitWindows.length, 1);
    });

    test('a missing counter makes the report a lower bound', () => {
        const store = freshStore();
        store.transaction(() => store.upsertRequests([request({ messageId: 'a', input: null }), request({ messageId: 'b' })]));
        const report = buildReport(
            { sums: store.bucketSums(0), sessions: reportSessions(store.sessions(), query()), compactions: [], limitHits: [], coverage: store.coverage() },
            { range: 'coverage', zone: 'UTC', now: FIXTURE_NOW, scope: 'all' },
        );
        assert.deepStrictEqual(
            [report.totals.provenance, report.totals.coverage.incompleteRequests, report.totals.input],
            ['partial', 1, 1],
        );
    });
});

suite('usage worker queries', () => {
    const WORKER = path.join(__dirname, '..', '..', '..', 'out', 'usageWorker.js');
    let tmp: string;
    const hosts: WorkerHost<UsageWorkerRequest, UsageWorkerResponse>[] = [];
    const host = (workerData?: { busyTimeoutMs?: number }) => {
        const h = new WorkerHost<UsageWorkerRequest, UsageWorkerResponse>(WORKER, {
            name: 'usage',
            fallback: 'showing nothing',
            log: { error: () => undefined, warn: () => undefined },
            workerData,
        });
        hosts.push(h);
        return h;
    };
    const ask = (storeFile: string, overrides: Partial<Extract<UsageWorkerRequest, { type: 'query' }>> = {}): UsageWorkerRequest => ({
        type: 'query',
        id: 0,
        storeFile,
        range: 'coverage',
        zone: 'Europe/Rome',
        workspaceFolders: null,
        ...overrides,
    });

    setup(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-tokenizer-usage-query-'));
    });

    teardown(async () => {
        await Promise.all(hosts.splice(0).map(h => h.dispose()));
        // Windows lets a folder go only once nothing in it is open.
        fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    });

    test('a query is answered between an import\u2019s files, not after the whole import', async () => {
        const projects = path.join(tmp, 'root', 'projects', 'p');
        fs.mkdirSync(projects, { recursive: true });
        for (let i = 0; i < 120; i++) {
            fs.writeFileSync(path.join(projects, `s${i}.jsonl`), line(assistantRecord(`s${i}`, `m${i}`, '2026-10-09T10:00:00Z')));
        }
        const storeFile = path.join(tmp, 'store', 'usage.sqlite');
        const worker = host();
        const order: string[] = [];
        const [imported] = await Promise.all([
            worker.send({ type: 'import', id: 0, storeFile, roots: [path.join(tmp, 'root')] }).then(r => (order.push(r.type), r)),
            worker.send(ask(storeFile)).then(r => order.push(r.type)),
        ]);
        assert.deepStrictEqual(order, ['report', 'imported']);
        // Only a Clear or a close cancels an import; a query leaves it be.
        assert.ok(imported.type === 'imported' && imported.summary?.read === 120 && !imported.summary.cancelled, JSON.stringify(imported));
    });

    test('the fixtures, through the worker; a newer version\u2019s history can still be read', async () => {
        const storeFile = path.join(tmp, 'store', 'usage.sqlite');
        const worker = host();
        assert.strictEqual((await worker.send({ type: 'import', id: 0, storeFile, roots: [FIXTURE_ROOT] })).type, 'imported');
        const first = await worker.send(ask(storeFile));
        assert.ok(first.type === 'report' && first.report.totals.processed === 1_278, JSON.stringify(first).slice(0, 200));
        await worker.send({ type: 'close', id: 0 });

        assert.ok(sqlite, 'this runtime has no node:sqlite');
        const raw = new sqlite.DatabaseSync(historyIn(storeFile));
        raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
        raw.close();
        const again = await worker.send(ask(storeFile));
        assert.ok(again.type === 'report' && again.report.totals.processed === 1_278, JSON.stringify(again).slice(0, 200));
        const refused = await worker.send({ type: 'import', id: 0, storeFile, roots: [FIXTURE_ROOT] });
        assert.deepStrictEqual(refused.type === 'failed' && refused.failure, 'store-read-only');
    });

    test('a history set aside is named once, by its file name, in the next answer', async () => {
        const storeFile = path.join(tmp, 'store', 'usage.sqlite');
        fs.mkdirSync(path.dirname(storeFile), { recursive: true });
        fs.writeFileSync(storeFile, 'this is not a database, '.repeat(400));
        const worker = host();
        const first = await worker.send(ask(storeFile));
        const moved = first.type === 'report' ? first.recovered : undefined;
        // Left where it is, under its own name: never renamed, never reused.
        assert.strictEqual(moved, 'usage.sqlite', JSON.stringify(first).slice(0, 200));
        assert.ok(fs.readFileSync(storeFile, 'utf8').startsWith('this is not a database'), 'the corrupt history was touched');
        assert.notStrictEqual(historyIn(storeFile), storeFile, 'the new history took the corrupt one\'s name');
        const again = await worker.send(ask(storeFile));
        assert.ok(again.type === 'report' && !('recovered' in again), JSON.stringify(again).slice(0, 200));
    });

    test("a Clear another window's read held off is finished by the worker's next request", async () => {
        const storeFile = path.join(tmp, 'store', 'usage.sqlite');
        const projects = path.join(tmp, 'root', 'projects', 'p');
        fs.mkdirSync(projects, { recursive: true });
        for (let i = 0; i < 50; i++) {
            fs.writeFileSync(path.join(projects, `s${i}.jsonl`), line(userRecord(`s${i}`, `/Secret-Client-0xFACE/repo-${i}`, '2026-10-09T09:59:00Z')) + line(assistantRecord(`s${i}`, `m${i}`, '2026-10-09T10:00:00Z')));
        }
        const worker = host({ busyTimeoutMs: 50 });
        await worker.send({ type: 'import', id: 0, storeFile, roots: [path.join(tmp, 'root')] });
        // Another window, in the middle of a read.
        assert.ok(sqlite, 'this runtime has no node:sqlite');
        const reader = new sqlite.DatabaseSync(historyIn(storeFile));
        reader.exec('BEGIN');
        reader.prepare('SELECT count(*) FROM requests').get();
        const cleared = await worker.send({ type: 'clear', id: 0, storeFile });
        reader.exec('COMMIT');
        reader.close();
        assert.ok(cleared.type === 'cleared' && !cleared.settled, JSON.stringify(cleared));
        await worker.send(ask(storeFile));
        const holding = fs.readdirSync(path.dirname(storeFile)).filter(name => fs.readFileSync(path.join(path.dirname(storeFile), name)).includes('Secret-Client-0xFACE'));
        assert.deepStrictEqual(holding, [], 'what Clear deleted is still on disk');
    });

    test('a Clear as the first request on a corrupt history names no copy after it', async () => {
        const storeFile = path.join(tmp, 'store', 'usage.sqlite');
        fs.mkdirSync(path.dirname(storeFile), { recursive: true });
        fs.writeFileSync(storeFile, 'this is not a database, '.repeat(400));
        const worker = host();
        assert.strictEqual((await worker.send({ type: 'clear', id: 0, storeFile })).type, 'cleared');
        const after = await worker.send(ask(storeFile));
        assert.ok(after.type === 'report' && !after.recovered && !after.aside, JSON.stringify(after).slice(0, 200));
    });

    test('every window, and every reload, is told of a copy set aside, until Clear removes it', async () => {
        const storeFile = path.join(tmp, 'store', 'usage.sqlite');
        fs.mkdirSync(path.dirname(storeFile), { recursive: true });
        fs.writeFileSync(storeFile, 'this is not a database, '.repeat(400));
        const first = await host().send(ask(storeFile));
        assert.ok(first.type === 'report' && first.recovered && first.aside === first.recovered, JSON.stringify(first).slice(0, 200));
        // Another window, or this one reloaded: nothing was moved by it.
        const other = host();
        const told = await other.send(ask(storeFile));
        assert.ok(told.type === 'report' && !told.recovered && told.aside === first.aside, JSON.stringify(told).slice(0, 200));
        await other.send({ type: 'clear', id: 0, storeFile });
        const cleared = await other.send(ask(storeFile));
        assert.ok(cleared.type === 'report' && cleared.aside === undefined);
    });

    test('a history deleted or replaced under a resident worker: the one at the path is the history', async () => {
        const storeFile = path.join(tmp, 'store', 'usage.sqlite');
        const worker = host();
        await worker.send({ type: 'import', id: 0, storeFile, roots: [FIXTURE_ROOT] });
        const processed = async () => {
            const r = await worker.send(ask(storeFile));
            return r.type === 'report' ? r.report.totals.processed : -1;
        };
        assert.strictEqual(await processed(), 1_278);
        if (process.platform !== 'win32') {
            // Deleted, as 2.1.2's Clear Downloaded Tokenizers deletes the storage.
            fs.rmSync(path.dirname(storeFile), { recursive: true, force: true });
            assert.strictEqual(await processed(), 0, 'it went on showing a deleted history');
            // Replaced, as another window replaces a corrupt one: a new
            // history, and the pointer at it.
            await worker.send({ type: 'import', id: 0, storeFile, roots: [FIXTURE_ROOT] });
            assert.ok(sqlite);
            const fresh = UsageStore.open(sqlite, startHistory(path.dirname(storeFile)));
            assert.strictEqual(fresh.status, 'ready');
            fresh.store.close();
            assert.strictEqual(await processed(), 0, 'it went on showing a replaced history');
        }
    });

    test('a range or zone the worker does not know is refused', async () => {
        const storeFile = path.join(tmp, 'store', 'usage.sqlite');
        const worker = host();
        for (const request of [ask(storeFile, { zone: 'Mars/Olympus' }), ask(storeFile, { range: 'forever' as RangeKey })]) {
            const response = await worker.send(request);
            assert.deepStrictEqual(response.type === 'failed' && response.failure, 'bad-request');
        }
    });
});
