import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { byDay, rollup, totalsOf } from '../../src/usage/aggregate';
import { importPaths, importRoots, importUnderLease } from '../../src/usage/importer';
import { machineRootInputs, resolveRoots } from '../../src/usage/roots';
import { UsageStore, loadSqlite, type OpenOptions } from '../../src/usage/store';
import { execFileSync } from 'child_process';
import { Worker } from 'worker_threads';

import { queryReport } from '../../src/usage/queries';
import {
    MAX_COUNTER,
    MAX_LINE_BYTES,
    MAX_PARSED_LINE_BYTES,
    PARSER_VERSION,
    newerVersion,
    readTranscript,
    walkProjects,
    type TranscriptFile,
} from '../../src/usage/transcripts';
import type { UsageWorkerRequest, UsageWorkerResponse } from '../../src/usage/protocol';
import { WorkerHost } from '../../src/workerHost';

/** The fixture root: test/fixtures/claude-config, a stand-in for ~/.claude. */
const FIXTURE_ROOT = path.join(__dirname, '..', '..', '..', 'test', 'fixtures', 'claude-config');
const sqlite = loadSqlite();

function line(record: object): string {
    return JSON.stringify(record) + '\n';
}

/**
 * An assistant record in Claude Code's own key order: the message, with its
 * own `type` and typed content blocks, before the record's `type`.
 */
function assistant(id: string, output: number, extra: Record<string, unknown> = {}): object {
    return {
        parentUuid: null,
        isSidechain: false,
        message: {
            model: 'claude-opus-5-5',
            id,
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'Done.' }],
            usage: { input_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, output_tokens: output },
        },
        type: 'assistant',
        uuid: `u-${id}-${output}`,
        timestamp: '2026-10-09T12:00:00.000Z',
        cwd: '/work',
        sessionId: 's1',
        version: '2.1.292',
        ...extra,
    };
}

suite('usage transcripts', () => {
    let tmp: string;
    let stores: UsageStore[] = [];

    /** The store under `tmp`; a second call opens a second connection to it. */
    function freshStore(options: OpenOptions = {}): UsageStore {
        assert.ok(sqlite, 'this runtime has no node:sqlite');
        const result = UsageStore.open(sqlite, path.join(tmp, 'store', 'usage.sqlite'), options);
        assert.strictEqual(result.status, 'ready');
        stores.push(result.store);
        return result.store;
    }

    /** A main transcript file record for `file` in a temporary root. */
    function mainFile(file: string): TranscriptFile {
        return { path: file, root: tmp, projectDir: 'p', kind: 'main', sessionId: 's1', agentId: null, runId: null };
    }

    /** `count` one-request transcripts in project `p` under `tmp`; their real paths. */
    function transcripts(count: number): string[] {
        const dir = path.join(tmp, 'projects', 'p');
        fs.mkdirSync(dir, { recursive: true });
        const files = Array.from({ length: count }, (_, i) => path.join(dir, `s${i}.jsonl`));
        files.forEach((file, i) => fs.writeFileSync(file, line(assistant(`m${i}`, 1))));
        return files.map(file => fs.realpathSync(file));
    }

    setup(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-tokenizer-transcripts-'));
    });

    teardown(() => {
        for (const store of stores) {
            store.close();
        }
        stores = [];
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    test('the walk classifies by path, skips journals, and never reads tool results', () => {
        const report = walkProjects(FIXTURE_ROOT);
        const found = report.files
            .map(f => [path.relative(path.join(FIXTURE_ROOT, 'projects'), f.path), f.kind, f.sessionId, f.agentId, f.runId])
            .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
        const join = (...parts: string[]) => path.join(...parts);
        assert.deepStrictEqual(found, [
            [join('-repo-app', 'sess-main-1.jsonl'), 'main', 'sess-main-1', null, null],
            [join('-repo-app', 'sess-main-1.orphaned-1791000000-abc.jsonl'), 'main', null, null, null],
            [join('-repo-app', 'sess-main-1', 'subagents', 'agent-a1.jsonl'), 'task', 'sess-main-1', 'a1', null],
            [join('-repo-app', 'sess-main-1', 'subagents', 'workflows', 'wf_run1', 'agent-w1.jsonl'), 'workflow', 'sess-main-1', 'w1', 'run1'],
        ]);
        assert.strictEqual(report.journals, 1);
        assert.strictEqual(walkProjects(path.join(tmp, 'nothing-here')).projects, null);
    });

    test('importing the fixtures gives the totals worked out by hand', async () => {
        const store = freshStore();
        const summary = await importRoots(store, [FIXTURE_ROOT]);
        const requests = [...store.requests()];
        const totals = totalsOf(requests);

        assert.deepStrictEqual(
            [totals.input, totals.cacheCreation, totals.cacheRead, totals.output, totals.processed, requests.length],
            [197, 61, 917, 103, 1_278, 4],
        );
        assert.strictEqual(totals.cacheWrite5m, 61);
        assert.strictEqual(totals.thinking, 25);
        const byKind = Object.fromEntries([...rollup(requests, r => r.kind)].map(([k, t]) => [k, t.processed]));
        assert.deepStrictEqual(byKind, { main: 1_240, task: 22, workflow: 16 });
        assert.deepStrictEqual([...byDay(requests, 'Europe/Rome')].map(([d, t]) => [d, t.processed]), [
            ['2026-10-09', 1_262],
            ['2026-10-10', 16],
        ]);
        assert.deepStrictEqual([...byDay(requests, 'UTC')].map(([d, t]) => [d, t.processed]), [['2026-10-09', 1_278]]);

        const r2 = requests.find(r => r.messageId === 'msg_R2');
        assert.strictEqual(r2?.variant, '1m');
        assert.strictEqual(r2?.effort, 'high');
        assert.strictEqual(r2?.model, 'claude-opus-5-5');

        assert.deepStrictEqual(store.limitHits().map(h => [h.limitType, h.resetsAt]), [['five_hour', 1791561600]]);
        assert.deepStrictEqual(store.compactions().map(c => [c.trigger, c.preTokens, c.postTokens]), [['auto', 160000, 12000]]);
        assert.deepStrictEqual(store.sessions().map(s => [s.sessionId, s.cwd, s.projectDir]), [['sess-main-1', '/repo/app', '-repo-app']]);
        assert.strictEqual(summary.synthetic, 1);
        assert.strictEqual(summary.apiErrors, 1);
        assert.deepStrictEqual(summary.malformed, { 'json-syntax': 1 });
        assert.strictEqual(summary.journals, 1);

        // A second pass reads nothing and changes nothing.
        const again = await importRoots(store, [FIXTURE_ROOT]);
        assert.strictEqual(again.read, 0);
        assert.strictEqual(again.unchanged, 4);
        assert.strictEqual(totalsOf(store.requests()).processed, 1_278);
    });

    test('a line still being written is read once it is finished', async () => {
        // F05. Only whole lines are consumed, and the checkpoint never passes
        // the last newline.
        const file = path.join(tmp, 'projects', 'p', 's1.jsonl');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const first = line(assistant('m1', 5));
        const second = line(assistant('m2', 7));
        fs.writeFileSync(file, first + second.slice(0, 40));

        const store = freshStore();
        await importRoots(store, [tmp]);
        assert.deepStrictEqual([...store.requests()].map(r => r.messageId), ['m1']);
        // Stored under its real path: the walk resolves projects/ first.
        assert.strictEqual(store.getFile('claude-code', fs.realpathSync(file))?.offset, Buffer.byteLength(first));

        fs.appendFileSync(file, second.slice(40));
        await importRoots(store, [tmp]);
        assert.deepStrictEqual([...store.requests()].map(r => r.messageId).sort(), ['m1', 'm2']);
    });

    test('a truncated, replaced or rewritten file is read again from the start', () => {
        // F06.
        const file = path.join(tmp, 's1.jsonl');
        const a = line(assistant('m1', 5));
        const b = line(assistant('m2', 7));
        fs.writeFileSync(file, a + b);
        const first = readTranscript(mainFile(file), undefined);
        assert.strictEqual(first.restarted, 'new');

        // Grown with the same start: carried on from the checkpoint.
        fs.appendFileSync(file, line(assistant('m3', 9)));
        const grown = readTranscript(mainFile(file), first.checkpoint);
        assert.strictEqual(grown.restarted, null);
        assert.deepStrictEqual(grown.requests.map(r => r.messageId), ['m3']);

        // Truncated below the checkpoint.
        fs.writeFileSync(file, a);
        assert.strictEqual(readTranscript(mainFile(file), grown.checkpoint).restarted, 'truncated');

        // Rewritten in place, same length: one of the 64 bytes before the
        // checkpoint differs, here the version at the end of the last record.
        // (A change further back is not looked for; this is one small read,
        // for filesystems whose inodes cannot be trusted.)
        fs.writeFileSync(file, a + b + line(assistant('m3', 9, { version: '2.1.293' })));
        assert.strictEqual(readTranscript(mainFile(file), { ...grown.checkpoint, size: -1 }).restarted, 'rewritten');

        // Rewritten so that the checkpoint no longer falls after a newline.
        fs.writeFileSync(file, ' ' + a + b + line(assistant('m3', 9)));
        assert.strictEqual(readTranscript(mainFile(file), { ...grown.checkpoint, size: -1 }).restarted, 'rewritten');

        // A new file at the same path: a different inode.
        const replacement = path.join(tmp, 'replacement.jsonl');
        fs.writeFileSync(replacement, a + b + line(assistant('m4', 1)) + line(assistant('m5', 1)));
        fs.renameSync(replacement, file);
        const replaced = readTranscript(mainFile(file), grown.checkpoint);
        if (process.platform !== 'win32') {
            assert.strictEqual(replaced.restarted, 'replaced');
        }
        assert.ok(replaced.restarted !== null);
    });

    test('a pass says it is at work between files, and within a long read', async () => {
        // The usage worker turns these calls into messages, so its host never
        // takes a long first import for a silent worker.
        const files = transcripts(5);
        const record = line(assistant('m1', 5, { pad: 'x'.repeat(1_000) }));
        fs.writeFileSync(files[0], record.repeat(Math.ceil((3 << 20) / record.length)));
        let calls = 0;
        readTranscript(mainFile(files[0]), undefined, () => calls++);
        assert.ok(calls >= 3, `${calls} calls for 3 MiB`);

        // Once per file and once per MiB read: 5 + 3 at least.
        const store = freshStore();
        calls = 0;
        await importRoots(store, [tmp], { progress: () => calls++ });
        assert.ok(calls >= files.length + 3, `${calls} calls reading ${files.length} files`);
        // Nothing to read, and still once per file.
        calls = 0;
        await importRoots(store, [tmp], { progress: () => calls++ });
        assert.ok(calls >= files.length, `${calls} calls for ${files.length} unchanged files`);
    });

    test('a line too long to be a record is skipped, and reading carries on', () => {
        const file = path.join(tmp, 's1.jsonl');
        const huge = `{"type":"assistant","pad":"${'x'.repeat(MAX_LINE_BYTES + 10)}"}\n`;
        fs.writeFileSync(file, line(assistant('m1', 5)) + huge + line(assistant('m2', 7)));
        const result = readTranscript(mainFile(file), undefined);
        assert.deepStrictEqual(result.requests.map(r => r.messageId), ['m1', 'm2']);
        assert.strictEqual(result.oversize, 1);
        assert.strictEqual(result.checkpoint.offset, fs.statSync(file).size);
    });

    test('bad counters are refused one by one, and a malformed line is never quoted', async () => {
        // F12. A counter that is not a safe, non-negative integer becomes
        // unknown; it never becomes 0 and never takes the record with it.
        const sentinel = 'sk-FAKE-SENTINEL-4242';
        const file = path.join(tmp, 'projects', 'p', 's1.jsonl');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const bad = (id: string, usage: Record<string, unknown>) =>
            line({ ...assistant(id, 0), message: { model: 'claude-opus-5-5', id, type: 'message', role: 'assistant', content: [], usage } });
        fs.writeFileSync(
            file,
            bad('neg', { input_tokens: -1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 }) +
                bad('frac', { input_tokens: 1.5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 }) +
                bad('str', { input_tokens: '7', cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 }) +
                bad('big', { input_tokens: 2 ** 53, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 }) +
                `{"type":"assistant","token":"${sentinel}", broken\n` +
                `{"type":"type":"assistant", broken\n` +
                `[{"type":"assistant","token":"${sentinel}"}]\n` +
                line(assistant('ok', 3)),
        );

        const store = freshStore();
        const summary = await importRoots(store, [tmp]);
        const requests = [...store.requests()];
        assert.deepStrictEqual(requests.map(r => [r.messageId, r.input]).sort(), [
            ['big', null],
            ['frac', null],
            ['neg', null],
            ['ok', 1],
            ['str', null],
        ]);
        assert.deepStrictEqual(summary.malformed, { 'bad-field:input_tokens': 4, 'json-syntax': 2, 'not-object': 1 });
        assert.strictEqual(totalsOf(requests).provenance, 'partial');
        assert.ok(!JSON.stringify(summary).includes(sentinel), 'the summary quoted a record');
        for (const r of requests) {
            assert.ok(!JSON.stringify(r).includes(sentinel), 'a stored row holds record text');
        }
    });

    test('CRLF lines and Unicode or spaced folder names read like any other', async () => {
        // F21.
        const dir = path.join(tmp, 'projects', '-Users-é model space', 'sub dir');
        const file = path.join(tmp, 'projects', '-Users-é model space', 's é 1.jsonl');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, line(assistant('m1', 5)).replace('\n', '\r\n') + line(assistant('m2', 6)).replace('\n', '\r\n'));
        const store = freshStore();
        await importRoots(store, [tmp]);
        assert.deepStrictEqual([...store.requests()].map(r => r.messageId).sort(), ['m1', 'm2']);
    });

    test('a symlinked folder is never followed, and an unreadable one is only counted', function () {
        // F11. readdir's recursive option followed links out of the root and
        // looped; one unreadable folder made it throw for everything.
        const projects = path.join(tmp, 'projects');
        const inside = path.join(projects, 'p');
        fs.mkdirSync(inside, { recursive: true });
        fs.writeFileSync(path.join(inside, 's1.jsonl'), line(assistant('m1', 5)));
        fs.symlinkSync(projects, path.join(inside, 'loop'), process.platform === 'win32' ? 'junction' : 'dir');

        let locked: string | undefined;
        if (process.platform !== 'win32' && process.getuid?.() !== 0) {
            locked = path.join(projects, 'locked');
            fs.mkdirSync(locked);
            fs.chmodSync(locked, 0);
        }
        try {
            const report = walkProjects(tmp);
            assert.strictEqual(report.files.length, 1);
            assert.strictEqual(report.symlinkedFolders, 1);
            if (locked) {
                assert.strictEqual(report.unreadableFolders, 1);
            }
        } finally {
            if (locked) {
                fs.chmodSync(locked, 0o755);
            }
        }
    });

    test('a pass over named paths reads only those transcripts, and only inside the projects folder', async () => {
        const [s0, s1, s2] = transcripts(3);
        const outside = path.join(tmp, 'elsewhere', 'x.jsonl');
        const decoy = path.join(tmp, 'projects', 'p', 's9', 'tool-results', 'r.jsonl');
        const journal = path.join(tmp, 'projects', 'p', 's9', 'subagents', 'workflows', 'wf_1', 'journal.jsonl');
        for (const file of [outside, decoy, journal]) {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, line(assistant(`m-${path.basename(file)}`, 1)));
        }
        const store = freshStore();
        const summary = await importPaths(store, [tmp], [s0, outside, decoy, journal, path.join(tmp, 'projects', 'p', 'gone.jsonl'), s2]);
        assert.strictEqual(summary.files, 2);
        assert.deepStrictEqual([...store.requests()].map(r => r.messageId).sort(), ['m0', 'm2']);

        // Their checkpoints are the ones a full pass would leave.
        const full = await importRoots(store, [tmp]);
        assert.deepStrictEqual([full.read, full.unchanged], [1, 2]);
        assert.ok(store.getFile('claude-code', s1));
    });

    test('a path named through a symlink is read as the transcript it leads to, under the same checkpoint', async () => {
        // A watcher names files by the path it watches, which can lead
        // through a link; the walk knows them by their real path.
        const [s0] = transcripts(1);
        const link = path.join(tmp, 'linked');
        fs.symlinkSync(path.join(tmp, 'projects'), link, 'junction');
        const store = freshStore();
        const summary = await importPaths(store, [tmp], [path.join(link, 'p', path.basename(s0))]);
        assert.strictEqual(summary.read, 1);
        const full = await importRoots(store, [tmp]);
        assert.deepStrictEqual([full.read, full.unchanged], [0, 1], 'one file, checkpointed twice');
    });

    test('a Clear in another window mid-pass leaves nothing behind it: every file is read again', async () => {
        // Window B reads files against their checkpoints, then window A
        // clears, then B writes. Unchecked, B's tails landed under end-of-file
        // checkpoints and the rows before them never came back.
        const files = transcripts(3);
        const a = freshStore();
        const b = freshStore();
        await importRoots(b, [tmp]);
        for (const [i, file] of files.entries()) {
            fs.appendFileSync(file, line(assistant(`late${i}`, 1)));
        }
        let seen = 0;
        const summary = await importRoots(b, [tmp], {
            isCancelled: () => {
                if (++seen === 3) {
                    a.clear();
                }
                return false;
            },
        });
        assert.ok(summary.cancelled, 'the pass went on after the Clear');
        assert.strictEqual([...b.requests()].length, 0, 'rows were written after the Clear');

        await importRoots(b, [tmp]);
        assert.deepStrictEqual([...b.requests()].map(r => r.messageId).sort(), ['late0', 'late1', 'late2', 'm0', 'm1', 'm2']);
    });

    test("a file a newer parser read is left alone, and no parser restart goes downward", async () => {
        const [file] = transcripts(1);
        const store = freshStore();
        await importRoots(store, [tmp]);
        const checkpoint = store.getFile('claude-code', file);
        assert.ok(checkpoint);
        const [row] = [...store.requests()];
        store.transaction(() => {
            store.putFile({ ...checkpoint, parserVersion: PARSER_VERSION + 1 });
            store.upsertRequests([{ ...row, parserVersion: PARSER_VERSION + 1 }]);
        });
        fs.appendFileSync(file, line(assistant('later', 1)));

        const summary = await importRoots(store, [tmp]);
        assert.deepStrictEqual([summary.read, summary.skipped], [0, { newer: 1 }]);
        assert.deepStrictEqual([...store.requests()].map(r => [r.messageId, r.parserVersion]), [['m0', PARSER_VERSION + 1]]);
        const read = readTranscript(mainFile(file), { ...checkpoint, parserVersion: PARSER_VERSION + 1 });
        assert.deepStrictEqual([read.unchanged, read.restarted], [true, null]);
    });

    test('the import lease is held for the pass, and free as soon as it ends', async () => {
        transcripts(2);
        const a = freshStore();
        const b = freshStore();
        assert.ok(await importUnderLease(a, [tmp], 'window-a'));
        assert.ok(b.acquireLease('import', 'window-b', PARSER_VERSION), "the finished pass kept the lease");
    });

    test('a counter past any real request is refused, so no sum can overflow a report', async () => {
        // Two near 2^53 in one bucket made every report throw, and Clear could
        // not help: the records were read again from disk.
        const file = path.join(tmp, 'projects', 'p', 's1.jsonl');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const huge = (id: string, value: number) =>
            line({ ...assistant(id, 1), message: { model: 'claude-opus-5-5', id, type: 'message', role: 'assistant', content: [], usage: { input_tokens: value, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } });
        fs.writeFileSync(file, huge('a', Number.MAX_SAFE_INTEGER) + huge('b', Number.MAX_SAFE_INTEGER) + huge('c', MAX_COUNTER) + huge('d', MAX_COUNTER + 1));
        const store = freshStore();
        const summary = await importRoots(store, [tmp]);
        assert.deepStrictEqual(summary.malformed, { 'bad-field:input_tokens': 3 });
        const report = queryReport(store, { range: 'coverage', zone: 'UTC', workspaceFolders: null, now: Date.UTC(2026, 9, 10), platform: process.platform });
        assert.deepStrictEqual([report.totals.input, report.totals.provenance], [MAX_COUNTER, 'partial']);
    });

    test('times before 2023 or from 2100 on are not records; one ahead of this clock is kept, and counted once the clock reaches it', async () => {
        const file = path.join(tmp, 'projects', 'p', 's1.jsonl');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const iso = (ms: number) => new Date(ms).toISOString();
        fs.writeFileSync(
            file,
            line(assistant('ancient', 1, { timestamp: '-271821-04-20T00:00:00.000Z' })) +
                line(assistant('roman', 1, { timestamp: '0001-01-01T00:00:00.000Z' })) +
                // A wrong clock, here or there: counted from its day, never in every range.
                line(assistant('future', 1, { timestamp: '2099-06-01T00:00:00.000Z' })) +
                line(assistant('ahead', 1, { timestamp: iso(Date.now() + 2 * 24 * 60 * 60 * 1000) })) +
                // A clock an hour ahead is another machine's, and its record counts.
                line(assistant('skewed', 1, { timestamp: iso(Date.now() + 60 * 60 * 1000) })) +
                line(assistant('ok', 1)) +
                line({ ...assistant('q', 0), uuid: 'q', message: { model: '<synthetic>', id: 'q', usage: {} }, quotaLimits: { rateLimitType: 'five_hour', resetsAt: 1e13 } }),
        );
        const store = freshStore();
        const summary = await importRoots(store, [tmp]);
        assert.deepStrictEqual(summary.malformed, { 'bad-field:timestamp': 2 });
        assert.deepStrictEqual([...store.requests()].map(r => r.messageId).sort(), ['ahead', 'future', 'ok', 'skewed']);
        assert.deepStrictEqual(store.limitHits().map(h => h.resetsAt), [null]);
        const at = (now: number) => queryReport(store, { range: 'coverage', zone: 'UTC', workspaceFolders: null, now, platform: process.platform });
        // An hour ahead is another machine's clock, and counts; days ahead do not, yet.
        const now = at(Date.now());
        assert.deepStrictEqual([now.totals.coverage.requests, now.coverage.ahead, now.from], [2, 2, '2026-10-09']);
        // Once this clock reaches them they count: nothing was dropped.
        const later = at(Date.UTC(2099, 5, 2));
        assert.deepStrictEqual([later.totals.coverage.requests, later.coverage.ahead], [4, 0]);
    });

    test('a line too long to parse safely is skipped as oversize, and reading carries on', () => {
        const file = path.join(tmp, 'projects', 'p', 's1.jsonl');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const dense = `{"type":"assistant","message":{"model":"m","id":"x","usage":{}},"timestamp":"2026-10-09T10:00:00Z","sessionId":"s1","pad":[${'{},'.repeat(Math.ceil(MAX_PARSED_LINE_BYTES * 2 / 3))}0]}\n`;
        fs.writeFileSync(file, line(assistant('before', 1)) + dense + line(assistant('after', 1)));
        const result = readTranscript(mainFile(file), undefined);
        assert.deepStrictEqual([result.requests.map(r => r.messageId), result.oversize], [['before', 'after'], 1]);
    });

    test('a FIFO is never opened: not named by a watcher, not as a transcript, not as settings', async function () {
        if (process.platform === 'win32') {
            this.skip();
        }
        const [real] = transcripts(1);
        const fifo = path.join(tmp, 'projects', 'p', 'pipe.jsonl');
        execFileSync('mkfifo', [fifo]);
        const started = Date.now();
        const store = freshStore();
        const summary = await importPaths(store, [tmp], [fifo, real]);
        assert.strictEqual(summary.files, 1);
        assert.throws(() => readTranscript(mainFile(fifo), undefined), (error: NodeJS.ErrnoException) => error.code === 'ENOTREG');
        const home = path.join(tmp, 'home');
        fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
        execFileSync('mkfifo', [path.join(home, '.claude', 'settings.json')]);
        resolveRoots({ setting: '', editorEnvironment: undefined, env: {}, home, platform: process.platform });
        assert.ok(Date.now() - started < 2_000, 'something waited on a FIFO');
    });

    test('a read left unfinished counts as a crash only when the window saw one', async () => {
        // A window reloaded mid-read, or one whose worker it stopped, leaves the
        // same trace as a crash, and must not keep a file out for a day.
        const [file] = transcripts(1);
        const store = freshStore();
        const interrupted = () =>
            store.transaction(() =>
                store.putReadGuard({ provider: 'claude-code', path: file, inProgress: true, crashCount: 1, lastCrash: 1 }),
            );
        interrupted();
        let summary = await importRoots(store, [tmp], { guardedReadBytes: 0, countCrashes: false });
        // Met either way, so the window knows its crash flag has done its work.
        assert.deepStrictEqual([summary.read, summary.skipped, summary.interrupted], [1, {}, 1]);
        fs.appendFileSync(file, line(assistant('m9', 1)));
        interrupted();
        summary = await importRoots(store, [tmp], { guardedReadBytes: 0, countCrashes: true, now: () => 2 });
        assert.deepStrictEqual([summary.read, summary.skipped, summary.interrupted], [0, { crashed: 1 }, 1]);
        fs.appendFileSync(file, line(assistant('m10', 1)));
        summary = await importRoots(store, [tmp], { guardedReadBytes: 0, countCrashes: true, now: () => 2 });
        assert.strictEqual(summary.interrupted, 0, 'a guard settled by its pass was met again');
    });

    test('a read is guarded by the bytes it will take, not by the size of the file', async () => {
        const [file] = transcripts(1);
        fs.appendFileSync(file, line({ ...assistant('pad', 1), pad: 'x'.repeat(2 << 20) }));
        const store = freshStore();
        const crashedOnce = () =>
            store.transaction(() =>
                store.putReadGuard({ provider: 'claude-code', path: file, inProgress: true, crashCount: 1, lastCrash: 1 }),
            );
        // New, 2 MiB to read: guarded, so the second crash keeps it out.
        crashedOnce();
        let summary = await importRoots(store, [tmp], { guardedReadBytes: 1 << 20, now: () => 2 });
        assert.deepStrictEqual(summary.skipped, { crashed: 1 });
        store.transaction(() => store.deleteReadGuard('claude-code', file));
        await importRoots(store, [tmp], { guardedReadBytes: 1 << 20 });
        // The same 2 MiB file with a line more: a small read, not guarded.
        fs.appendFileSync(file, line(assistant('tail', 1)));
        crashedOnce();
        summary = await importRoots(store, [tmp], { guardedReadBytes: 1 << 20, now: () => 2 });
        assert.deepStrictEqual([summary.read, summary.skipped], [1, {}]);
    });

    test('a newer parser drops the rows its file no longer gives', async () => {
        const [file] = transcripts(1);
        const store = freshStore();
        await importRoots(store, [tmp]);
        // As an older parser would have left it: a row the current one does
        // not produce from this file.
        const checkpoint = store.getFile('claude-code', file);
        assert.ok(checkpoint);
        const [kept] = [...store.requests()];
        store.transaction(() => {
            store.putFile({ ...checkpoint, parserVersion: PARSER_VERSION - 1 });
            store.upsertRequests([{ ...kept, messageId: 'gone', parserVersion: PARSER_VERSION - 1 }]);
        });

        const summary = await importRoots(store, [tmp]);
        assert.strictEqual(summary.restarted, 1);
        assert.deepStrictEqual([...store.requests()].map(r => [r.messageId, r.parserVersion]), [['m0', PARSER_VERSION]]);
    });

    test('an unchanged file is not even opened', async function () {
        if (process.platform === 'win32' || process.getuid?.() === 0) {
            this.skip();
        }
        const [file] = transcripts(1);
        const store = freshStore();
        await importRoots(store, [tmp]);
        // Unreadable now, though as the checkpoint left it: a pass that
        // opened it would count it unreadable.
        fs.chmodSync(file, 0);
        try {
            const again = await importRoots(store, [tmp]);
            assert.deepStrictEqual([again.unchanged, again.skipped], [1, {}]);
        } finally {
            fs.chmodSync(file, 0o644);
        }
    });

    test('a large file that crashed the reader twice is skipped for a day, then read again', async () => {
        // Every file counts as large here. A crash cannot be staged in a test,
        // so the guard is left as a read that never finished leaves it.
        const [file] = transcripts(1);
        let now = 1_791_000_000_000;
        const options = { guardedReadBytes: 0, now: () => now };
        const store = freshStore();
        const crashed = (crashCount: number) =>
            store.transaction(() =>
                store.putReadGuard({ provider: 'claude-code', path: file, inProgress: true, crashCount, lastCrash: null }),
            );

        // One crash: read again, and the guard goes once the read is written.
        crashed(0);
        let summary = await importRoots(store, [tmp], options);
        assert.deepStrictEqual([summary.read, summary.skipped], [1, {}]);
        assert.strictEqual(store.getReadGuard('claude-code', file), undefined);

        // Two: skipped, the second crash recorded once rather than recounted.
        fs.appendFileSync(file, line(assistant('m1', 1)));
        crashed(1);
        summary = await importRoots(store, [tmp], options);
        assert.deepStrictEqual([summary.read, summary.skipped], [0, { crashed: 1 }]);
        const lastCrash = now;
        assert.deepStrictEqual(store.getReadGuard('claude-code', file), {
            provider: 'claude-code',
            path: file,
            inProgress: false,
            crashCount: 2,
            lastCrash,
        });
        now += 23 * 3_600_000;
        summary = await importRoots(store, [tmp], options);
        assert.deepStrictEqual([summary.read, summary.skipped], [0, { crashed: 1 }]);

        // A day after the last crash, it is read once more: never skipped for
        // good, since Claude Code deletes its records after 30 days.
        now = lastCrash + 24 * 3_600_000;
        summary = await importRoots(store, [tmp], options);
        assert.deepStrictEqual([summary.read, summary.skipped], [1, {}]);
        assert.deepStrictEqual([...store.requests()].map(r => r.messageId).sort(), ['m0', 'm1']);
        assert.strictEqual(store.getReadGuard('claude-code', file), undefined);
    });

    test('a guarded read is written before the next file is read, so a crash there is not blamed on it', async () => {
        const [first] = transcripts(2);
        const store = freshStore();
        const seen: unknown[] = [];
        await importRoots(store, [tmp], {
            guardedReadBytes: 0,
            isCancelled: () => {
                seen.push(store.getReadGuard('claude-code', first));
                return false;
            },
        });
        assert.deepStrictEqual(seen, [undefined, undefined]);
    });

    test('a file the reader could not open is skipped, not counted as a crash', async function () {
        if (process.platform === 'win32' || process.getuid?.() === 0) {
            this.skip();
        }
        const [file] = transcripts(1);
        const store = freshStore();
        fs.chmodSync(file, 0);
        try {
            const summary = await importRoots(store, [tmp], { guardedReadBytes: 0 });
            assert.deepStrictEqual(summary.skipped, { unreadable: 1 });
            assert.strictEqual(store.getReadGuard('claude-code', file), undefined);
        } finally {
            fs.chmodSync(file, 0o644);
        }
    });

    test('an import renews its lease as it goes, and stops once a newer parser takes it', async () => {
        transcripts(8);
        let now = 1_000_000;
        const a = freshStore({ now: () => now });
        const b = freshStore({ now: () => now });
        const attempts: boolean[] = [];
        let yields = 0;
        const summary = await importUnderLease(a, [tmp], 'window-a', {
            filesPerYield: 2,
            pause: () => {
                now += 15_000;
                yields++;
                if (yields === 2) {
                    // 30 s in: taken over, unless renewed at 15 s.
                    attempts.push(b.acquireLease('import', 'window-b', PARSER_VERSION));
                } else if (yields === 3) {
                    attempts.push(b.acquireLease('import', 'window-b', PARSER_VERSION + 1));
                }
                return Promise.resolve();
            },
        });
        assert.deepStrictEqual(attempts, [false, true]);
        assert.deepStrictEqual([summary?.read, summary?.cancelled], [6, true]);
        assert.strictEqual(await importUnderLease(a, [tmp], 'window-a'), null, 'the outdated window took the lease back');
    });

    test('Claude Code versions compare by number, not as text', () => {
        assert.strictEqual(newerVersion('2.1.99', '2.1.100'), '2.1.100');
        assert.strictEqual(newerVersion('2.1.292', '2.1.220'), '2.1.292');
        assert.strictEqual(newerVersion(null, '2.1.1'), '2.1.1');
        assert.strictEqual(newerVersion('2.1.1', 'garbage'), '2.1.1');
    });
});

suite('usage worker', () => {
    // The bundle the extension ships, as built by pretest.
    const WORKER = path.join(__dirname, '..', '..', '..', 'out', 'usageWorker.js');
    let tmp: string;
    const logged: string[] = [];
    const log = { error: (m: string) => logged.push(m), warn: (m: string) => logged.push(m) };
    const hosts: WorkerHost<UsageWorkerRequest, UsageWorkerResponse>[] = [];
    const host = () => {
        const h = new WorkerHost<UsageWorkerRequest, UsageWorkerResponse>(WORKER, { name: 'usage', fallback: 'showing nothing', log });
        hosts.push(h);
        return h;
    };

    setup(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-tokenizer-usage-worker-'));
        logged.length = 0;
    });

    /** Stores a test opens on this thread: closed here even when an assertion failed first. */
    const direct: UsageStore[] = [];

    teardown(async () => {
        for (const store of direct.splice(0)) {
            try {
                store.close();
            } catch {
                // Closed by the test.
            }
        }
        await Promise.all(hosts.splice(0).map(h => h.dispose()));
        // Windows lets a folder go only once nothing in it is open.
        fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    });

    test("imports in its own thread, and a finished pass leaves the next window's free to run", async () => {
        const storeFile = path.join(tmp, 'store', 'usage.sqlite');
        const a = host();
        const b = host();

        const first = await a.send({ type: 'import', id: 0, storeFile, roots: [FIXTURE_ROOT], holder: 'window-a' });
        assert.strictEqual(first.type, 'imported', JSON.stringify(first));
        assert.ok(first.type === 'imported' && !first.leaseHeldElsewhere && first.summary.read === 4);

        // The lease lasts one pass: the second window imports at once, and
        // finds nothing left to read.
        const second = await b.send({ type: 'import', id: 0, storeFile, roots: [FIXTURE_ROOT], holder: 'window-b' });
        assert.ok(second.type === 'imported' && !second.leaseHeldElsewhere && second.summary.unchanged === 4, JSON.stringify(second));

        const cleared = await a.send({ type: 'clear', id: 0, storeFile });
        assert.deepStrictEqual(cleared, { type: 'cleared', id: cleared.id, generation: 1, settled: true, copiesLeft: 0 });
    });

    /** More one-request transcripts than one yield's worth, under `tmp/root`. */
    function manyTranscripts(): string {
        const projects = path.join(tmp, 'root', 'projects', 'p');
        fs.mkdirSync(projects, { recursive: true });
        for (let i = 0; i < 120; i++) {
            fs.writeFileSync(path.join(projects, `s${i}.jsonl`), line(assistant(`m${i}`, 1)));
        }
        return path.join(tmp, 'root');
    }

    test('while it imports it keeps telling its host it is at work', async () => {
        // The host gives up on a worker silent for two minutes, and a first
        // import of a large history can take longer than that. With a beat
        // every millisecond, an import of 120 files beats again and again;
        // one that beat only once would be cut off again.
        const root = manyTranscripts();
        const storeFile = path.join(tmp, 'store', 'usage.sqlite');
        const worker = new Worker(WORKER, { workerData: { beatMs: 1 } });
        try {
            const seen: string[] = [];
            const imported = new Promise<void>(resolve =>
                worker.on('message', (message: UsageWorkerResponse) => {
                    seen.push(`${message.type}:${message.id}`);
                    if (message.type === 'imported') {
                        resolve();
                    }
                }),
            );
            worker.postMessage({ type: 'import', id: 7, storeFile, roots: [root] } satisfies UsageWorkerRequest);
            await imported;
            const beats = seen.slice(0, seen.indexOf('imported:7')).filter(m => m === 'progress:0').length;
            assert.ok(beats >= 2, `${beats} beats before the answer: ${seen.join(' ')}`);
        } finally {
            await worker.terminate();
        }
    });

    test('requests are handled one at a time: a second import waits for the first', async () => {
        // Unqueued, the second would start in the first one's yield and read
        // the files the first had not reached yet.
        const root = manyTranscripts();
        const storeFile = path.join(tmp, 'store', 'usage.sqlite');
        const worker = host();
        const [first, second] = await Promise.all([
            worker.send({ type: 'import', id: 0, storeFile, roots: [root] }),
            worker.send({ type: 'import', id: 0, storeFile, roots: [root] }),
        ]);
        assert.ok(first.type === 'imported' && second.type === 'imported');
        assert.deepStrictEqual([first.summary?.read, second.summary?.read, second.summary?.unchanged], [120, 0, 120]);
    });

    test('a Clear sent during an import cancels it, and the history ends empty', async () => {
        // Mid-pass when the Clear arrives, whichever way the two messages are
        // delivered.
        const root = manyTranscripts();
        const storeFile = path.join(tmp, 'store', 'usage.sqlite');
        const worker = host();
        const [imported, cleared] = await Promise.all([
            worker.send({ type: 'import', id: 0, storeFile, roots: [root] }),
            worker.send({ type: 'clear', id: 0, storeFile }),
        ]);
        assert.ok(imported.type === 'imported' && imported.summary?.cancelled, JSON.stringify(imported));
        assert.strictEqual(cleared.type === 'cleared' && cleared.generation, 1);

        assert.ok(sqlite, 'this runtime has no node:sqlite');
        const opened = UsageStore.open(sqlite, storeFile);
        assert.strictEqual(opened.status, 'ready');
        try {
            assert.strictEqual([...opened.store.requests()].length, 0, 'the import went on writing after the Clear');
        } finally {
            opened.store.close();
        }
    });

    test('named paths go through the worker, and anything but a short list of strings is refused', async () => {
        const root = manyTranscripts();
        const storeFile = path.join(tmp, 'store', 'usage.sqlite');
        const worker = host();
        const named = await worker.send({ type: 'import', id: 0, storeFile, roots: [root], paths: [path.join(root, 'projects', 'p', 's7.jsonl')] });
        assert.ok(named.type === 'imported' && named.summary?.files === 1, JSON.stringify(named).slice(0, 200));
        for (const paths of ['nope', [42], Array.from({ length: 1001 }, () => 'x')]) {
            const response = await worker.send({ type: 'import', id: 0, storeFile, roots: [root], paths: paths as string[] });
            assert.deepStrictEqual(response.type === 'failed' && response.failure, 'bad-request', JSON.stringify(paths).slice(0, 40));
        }
    });

    test("8 MiB of dense JSON in one record's line is skipped, not fatal, within the worker's 128 MB heap", async function () {
        // It exhausted the heap on every pass: every file after it went unread.
        this.timeout(60_000);
        const root = path.join(tmp, 'dense-root');
        const project = path.join(root, 'projects', 'p');
        fs.mkdirSync(project, { recursive: true });
        const dense = `{"type":"assistant","message":{"model":"m","id":"x","usage":{}},"timestamp":"2026-10-09T10:00:00Z","sessionId":"s1","pad":[${'{},'.repeat((8 << 20) / 3)}0]}\n`;
        fs.writeFileSync(path.join(project, 'a.jsonl'), line(assistant('before', 1)) + dense);
        fs.writeFileSync(path.join(project, 'b.jsonl'), line(assistant('after', 1)));
        const limited = new WorkerHost<UsageWorkerRequest, UsageWorkerResponse>(WORKER, {
            name: 'usage',
            fallback: 'showing nothing',
            log,
            resourceLimits: { maxOldGenerationSizeMb: 128 },
        });
        hosts.push(limited);
        const response = await limited.send({ type: 'import', id: 0, storeFile: path.join(tmp, 'store', 'usage.sqlite'), roots: [root] });
        assert.ok(response.type === 'imported' && response.summary?.read === 2 && response.summary.oversizeLines === 1, JSON.stringify(response).slice(0, 300));
    });

    test("the worker counts a read left unfinished as a crash only when its window says one happened", async () => {
        // A 5 MiB transcript: past the guard's 4 MiB, so its read is guarded.
        const root = path.join(tmp, 'big-root');
        const file = path.join(root, 'projects', 'p', 's1.jsonl');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, line(assistant('m1', 1)) + line({ ...assistant('pad', 1), pad: 'x'.repeat(5 << 20) }));
        const storeFile = path.join(tmp, 'store', 'usage.sqlite');
        assert.ok(sqlite, 'this runtime has no node:sqlite');
        const opened = UsageStore.open(sqlite, storeFile);
        assert.strictEqual(opened.status, 'ready');
        direct.push(opened.store);
        const unfinished = () =>
            opened.store.transaction(() =>
                opened.store.putReadGuard({ provider: 'claude-code', path: fs.realpathSync(file), inProgress: true, crashCount: 1, lastCrash: Date.now() }),
            );
        unfinished();
        const worker = host();
        const reloaded = await worker.send({ type: 'import', id: 0, storeFile, roots: [root] });
        assert.ok(reloaded.type === 'imported' && reloaded.summary?.read === 1, JSON.stringify(reloaded).slice(0, 300));

        fs.appendFileSync(file, line(assistant('m2', 1)) + line({ ...assistant('pad2', 1), pad: 'y'.repeat(5 << 20) }));
        unfinished();
        const crashed = await worker.send({ type: 'import', id: 0, storeFile, roots: [root], crashed: true });
        assert.ok(crashed.type === 'imported' && crashed.summary?.skipped.crashed === 1, JSON.stringify(crashed).slice(0, 300));
        opened.store.close();
    });

    test('a failed open is tried again on the next request, not kept', async () => {
        const storeFile = path.join(tmp, 'store', 'usage.sqlite');
        // A file where the history's folder should be.
        fs.writeFileSync(path.dirname(storeFile), 'x');
        const worker = host();
        const first = await worker.send({ type: 'import', id: 0, storeFile, roots: [FIXTURE_ROOT] });
        assert.deepStrictEqual(first.type === 'failed' && first.failure, 'store-io', JSON.stringify(first));
        fs.rmSync(path.dirname(storeFile));
        const second = await worker.send({ type: 'import', id: 0, storeFile, roots: [FIXTURE_ROOT] });
        assert.ok(second.type === 'imported' && second.summary?.read === 4, JSON.stringify(second));
    });

    test("a worker holds the lease as its window, and an older parser's import is refused as outdated", async () => {
        assert.ok(sqlite, 'this runtime has no node:sqlite');
        const storeFile = path.join(tmp, 'store', 'usage.sqlite');
        const opened = UsageStore.open(sqlite, storeFile);
        assert.strictEqual(opened.status, 'ready');
        direct.push(opened.store);
        // The window's earlier worker died holding it.
        assert.ok(opened.store.acquireLease('import', 'window-1', PARSER_VERSION));
        const worker = host();
        const other = await worker.send({ type: 'import', id: 0, storeFile, roots: [FIXTURE_ROOT], holder: 'window-2' });
        assert.ok(other.type === 'imported' && other.leaseHeldElsewhere, JSON.stringify(other));
        const same = await worker.send({ type: 'import', id: 0, storeFile, roots: [FIXTURE_ROOT], holder: 'window-1' });
        assert.ok(same.type === 'imported' && !same.leaseHeldElsewhere && same.summary.read === 4, JSON.stringify(same));

        assert.ok(opened.store.acquireLease('import', 'reloaded', PARSER_VERSION + 1));
        opened.store.releaseLease('import', 'reloaded');
        opened.store.close();
        const outdated = await worker.send({ type: 'import', id: 0, storeFile, roots: [FIXTURE_ROOT], holder: 'window-1' });
        assert.deepStrictEqual(outdated.type === 'failed' && outdated.failure, 'outdated', JSON.stringify(outdated));
    });

    test('nothing a record says reaches a message or the log', async () => {
        const sentinel = 'sk-FAKE-SENTINEL-9876';
        const file = path.join(tmp, 'root', 'projects', 'p', 's1.jsonl');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `{"type":"assistant","secret":"${sentinel}", broken\n` + line(assistant('ok', 1)));

        const response = await host().send({ type: 'import', id: 0, storeFile: path.join(tmp, 'store', 'usage.sqlite'), roots: [path.join(tmp, 'root')] });
        assert.strictEqual(response.type, 'imported');
        assert.ok(!JSON.stringify(response).includes(sentinel), 'a worker message quoted a record');
        assert.ok(!logged.join('\n').includes(sentinel), 'the log quoted a record');
    });
});

suite('usage roots', () => {
    let home: string;

    setup(() => {
        // As the file system spells it, as roots are read: /private/var on macOS.
        home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'llm-tokenizer-home-')));
    });

    teardown(() => {
        fs.rmSync(home, { recursive: true, force: true });
    });

    const dir = (name: string) => {
        const p = path.join(home, name);
        fs.mkdirSync(p, { recursive: true });
        return p;
    };

    test('every distinct root that exists is read, in Claude Code order', () => {
        const fromSetting = dir('from-setting');
        const fromEditor = dir('from-editor');
        const fromEnv = dir('from-env');
        const fromSettings = dir('from-settings');
        dir('.claude');
        fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ env: { CLAUDE_CONFIG_DIR: fromSettings, SECRET: 'x' } }));

        const resolved = resolveRoots({
            setting: fromSetting,
            editorEnvironment: [{ name: 'OTHER', value: '/nope' }, { name: 'CLAUDE_CONFIG_DIR', value: fromEditor }],
            env: { CLAUDE_CONFIG_DIR: fromEnv },
            home,
            platform: 'linux',
        });
        assert.deepStrictEqual(
            resolved.roots.map(r => [r.source, r.path]),
            [
                ['setting', fromSetting],
                ['editor-environment', fromEditor],
                ['process-environment', fromEnv],
                ['claude-settings', fromSettings],
                ['default', path.join(home, '.claude')],
            ],
        );
    });

    test('relative or missing paths are not roots, and one folder counts once', () => {
        const shared = dir('shared');
        const resolved = resolveRoots({
            setting: 'relative/path',
            editorEnvironment: { CLAUDE_CONFIG_DIR: shared },
            env: { CLAUDE_CONFIG_DIR: shared },
            home,
            platform: 'darwin',
        });
        assert.deepStrictEqual(resolved.roots.map(r => r.source), ['editor-environment']);
        assert.ok(!resolved.candidates.some(c => c.source === 'setting'), 'a relative path was considered');
        assert.ok(resolved.candidates.some(c => c.source === 'default' && !c.exists));
    });

    test('a folder named in another case is one root, read under the spelling on disk', () => {
        // Choose Folder can give `c:\…` where the default is `C:\…`. Where
        // case matters, the other spelling is simply not found. Read under
        // the typed spelling, every transcript would be read again from the
        // start, under new keys.
        const real = dir('CaseDir');
        const resolved = resolveRoots({
            setting: path.join(home, 'casedir'),
            editorEnvironment: undefined,
            env: { CLAUDE_CONFIG_DIR: real },
            home,
            platform: process.platform,
        });
        assert.deepStrictEqual(resolved.roots.map(r => r.path), [real], JSON.stringify(resolved.roots));
    });

    test('a mapped drive is read under its letter, never as the share the editor may refuse', () => {
        // What Windows gives for a mapped drive, simulated: the native real
        // path is \\server\share\…, while the drive's own path is served.
        // The module itself, as roots.ts sees it, not this file's view of it.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const shared = require('fs') as { realpathSync: typeof fs.realpathSync };
        const original = shared.realpathSync;
        const share = '\\\\server\\share\\mapped';
        const stub = (js: (p: string) => string) =>
            Object.assign((p: string) => js(p), { native: (p: string) => (p.startsWith(home) ? share : original.native(p)) }) as unknown as typeof fs.realpathSync;
        // Named through a link, so that the path given and the path resolved differ.
        const target = dir('mapped');
        const given = path.join(home, 'drive');
        fs.symlinkSync(target, given, 'junction');
        const roots = () => resolveRoots({ setting: given, editorEnvironment: undefined, env: {}, home, platform: process.platform }).roots.map(r => r.path);
        try {
            shared.realpathSync = stub(p => original(p));
            assert.deepStrictEqual(roots(), [target]);
            // A link that leads to a share itself: kept as it was given.
            shared.realpathSync = stub(p => (p.startsWith(home) ? share : original(p)));
            assert.deepStrictEqual(roots(), [given]);
        } finally {
            shared.realpathSync = original;
        }
    });

    test("Claude Code's two flags are read wherever it reads them, its settings files included", () => {
        const custom = dir('custom');
        const read = (env: NodeJS.ProcessEnv, editorEnvironment: unknown = undefined) => {
            const r = resolveRoots({ setting: '', editorEnvironment, env, home, platform: 'linux' });
            return [r.historyDisabled, r.largeContextDisabled];
        };
        assert.deepStrictEqual(read({}), [false, false]);
        assert.deepStrictEqual(read({ CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1', CLAUDE_CODE_DISABLE_1M_CONTEXT: 'true' }), [true, true]);
        assert.deepStrictEqual(read({}, [{ name: 'CLAUDE_CODE_DISABLE_1M_CONTEXT', value: 'on' }]), [false, true]);

        // ~/.claude/settings.json, and a root's own.
        dir('.claude');
        const settings = (folder: string, env: object) => fs.writeFileSync(path.join(folder, 'settings.json'), JSON.stringify({ env }));
        settings(path.join(home, '.claude'), { CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1' });
        assert.deepStrictEqual(read({}), [true, false]);
        settings(path.join(home, '.claude'), { CLAUDE_CODE_SKIP_PROMPT_HISTORY: '0' });
        settings(custom, { CLAUDE_CODE_DISABLE_1M_CONTEXT: '1' });
        assert.deepStrictEqual(read({}), [false, false], 'a folder that is not a root was read');
        assert.deepStrictEqual(read({ CLAUDE_CONFIG_DIR: custom }), [false, true]);
    });

    test("on Windows the editor setting's names are case-insensitive", () => {
        const fromEditor = dir('from-editor');
        const lower = resolveRoots({ setting: '', editorEnvironment: { claude_config_dir: fromEditor }, env: {}, home, platform: 'win32' });
        assert.deepStrictEqual(lower.roots.map(r => r.source), ['editor-environment']);
        const unix = resolveRoots({ setting: '', editorEnvironment: { claude_config_dir: fromEditor }, env: {}, home, platform: 'linux' });
        assert.deepStrictEqual(unix.roots.map(r => r.source), []);
    });

    test("in the test host, the fixtures are the only root, and the real ~/.claude is never a candidate", () => {
        // test/index.ts points CLAUDE_CONFIG_DIR at the fixtures before any test runs.
        const fixtures = path.join(__dirname, '..', '..', '..', 'test', 'fixtures');
        const resolved = resolveRoots({ ...machineRootInputs({ fixtures }), setting: '', editorEnvironment: undefined });
        assert.deepStrictEqual(resolved.roots.map(r => fs.realpathSync(r.path)), [fs.realpathSync(FIXTURE_ROOT)]);
        const realDefault = path.join(os.homedir(), '.claude');
        assert.ok(!resolved.candidates.some(c => c.path === realDefault), 'the real ~/.claude was considered');
    });

    test('under test, a root whose projects or sessions folder leads outside the allowed folders is refused', () => {
        const allowed = dir('allowed');
        const outside = dir('outside');
        for (const folder of ['projects', 'sessions']) {
            const root = dir(path.join('allowed', `through-${folder}`));
            fs.symlinkSync(outside, path.join(root, folder), 'junction');
            const resolved = resolveRoots({ setting: root, editorEnvironment: undefined, env: {}, home, platform: 'linux', confineTo: [allowed] });
            assert.deepStrictEqual([resolved.roots, resolved.refused.map(r => r.path)], [[], [root]], folder);
        }
    });

    test('under test, a root whose settings.json leads out, or whose projects link leads nowhere yet, is refused', () => {
        const allowed = dir('allowed');
        const outside = dir('outside');
        fs.writeFileSync(path.join(outside, 'settings.json'), JSON.stringify({ env: { CLAUDE_CODE_DISABLE_1M_CONTEXT: '1' } }));
        const linkedSettings = dir(path.join('allowed', 'linked-settings'));
        fs.symlinkSync(path.join(outside, 'settings.json'), path.join(linkedSettings, 'settings.json'), 'file');
        // A link to nothing could lead out once its target appears.
        const dangling = dir(path.join('allowed', 'dangling'));
        fs.symlinkSync(path.join(outside, 'later'), path.join(dangling, 'projects'), 'junction');
        for (const root of [linkedSettings, dangling]) {
            const resolved = resolveRoots({ setting: root, editorEnvironment: undefined, env: {}, home, platform: 'linux', confineTo: [allowed] });
            assert.deepStrictEqual([resolved.roots, resolved.refused.map(r => r.path), resolved.largeContextDisabled], [[], [root], false], root);
        }
    });

    test('under test, a root outside the allowed folders is refused', () => {
        const allowed = dir('allowed');
        const outside = dir('outside');
        const resolved = resolveRoots({ setting: outside, editorEnvironment: undefined, env: { CLAUDE_CONFIG_DIR: allowed }, home, platform: 'linux', confineTo: [allowed] });
        assert.deepStrictEqual(resolved.roots.map(r => r.path), [allowed]);
        assert.deepStrictEqual(resolved.refused.map(r => r.path), [outside]);
    });
});

suite('usage source invariants, for the reader', () => {
    test('only roots.ts finds the home directory or CLAUDE_CONFIG_DIR', () => {
        const usage = path.join(__dirname, '..', '..', '..', 'src', 'usage');
        const files = [...fs.readdirSync(usage).map(f => path.join(usage, f)), path.join(usage, '..', 'usageWorker.ts')];
        for (const file of files.filter(f => f.endsWith('.ts') && path.basename(f) !== 'roots.ts')) {
            // Code only: comments may name what they do not touch.
            const code = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
            assert.ok(!/homedir|CLAUDE_CONFIG_DIR|process\.env/.test(code), `${path.basename(file)} reads the home or the environment`);
        }
    });
});
