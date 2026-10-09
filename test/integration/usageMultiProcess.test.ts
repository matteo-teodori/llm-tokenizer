import * as assert from 'assert';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { totalsOf } from '../../src/usage/aggregate';
import { PARSER_VERSION } from '../../src/usage/transcripts';
import { UsageStore, loadSqlite } from '../../src/usage/store';

const FIXTURE_ROOT = path.join(__dirname, '..', '..', '..', 'test', 'fixtures', 'claude-config');
/** The compiled modules, as a separate process loads them. */
const COMPILED = path.join(__dirname, '..', '..', 'src', 'usage');

/**
 * A process that opens the store and imports the fixtures, or takes the
 * lease and exits holding it. Run with this host's own runtime as Node.
 */
const CHILD = `
const path = require('path');
// With -e there is no script path: the arguments start at argv[1].
const [compiled, storeFile, root, mode, parserVersion] = process.argv.slice(1);
const { UsageStore, loadSqlite } = require(path.join(compiled, 'store.js'));
const { importRoots } = require(path.join(compiled, 'importer.js'));
const opened = UsageStore.open(loadSqlite(), storeFile);
if (opened.status !== 'ready') { console.log(JSON.stringify({ status: opened.status })); process.exit(1); }
if (mode === 'hold-and-die') {
    console.log(JSON.stringify({ leased: opened.store.acquireLease('import', 'dying-' + process.pid, Number(parserVersion)) }));
    process.exit(0);
}
importRoots(opened.store, [root]).then(summary => {
    console.log(JSON.stringify({ read: summary.read, files: summary.files }));
    opened.store.close();
});
`;

function run(script: string, args: string[]): Promise<{ code: number | null; out: string; err: string }> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['-e', script, ...args], {
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        let err = '';
        child.stdout.on('data', chunk => (out += String(chunk)));
        child.stderr.on('data', chunk => (err += String(chunk)));
        child.on('error', reject);
        child.on('close', code => resolve({ code, out, err }));
    });
}

suite('Claude Code usage, two processes on one history', () => {
    let tmp: string;

    setup(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-tokenizer-two-processes-'));
    });

    teardown(() => {
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    test('two processes importing into a fresh history at once converge to the fixture totals', async function () {
        this.timeout(60_000);
        const storeFile = path.join(tmp, 'store', 'usage.sqlite');
        const results = await Promise.all([1, 2].map(() => run(CHILD, [COMPILED, storeFile, FIXTURE_ROOT, 'import'])));
        for (const { code, out, err } of results) {
            assert.strictEqual(code, 0, `${out}\n${err.slice(0, 600)}`);
        }

        const sqlite = loadSqlite();
        assert.ok(sqlite, 'this runtime has no node:sqlite');
        const opened = UsageStore.open(sqlite, storeFile);
        assert.strictEqual(opened.status, 'ready');
        try {
            const totals = totalsOf(opened.store.requests());
            assert.deepStrictEqual([totals.processed, totals.coverage.requests], [1_278, 4]);
        } finally {
            opened.store.close();
        }
    });

    test('a lease left by a process that died is taken at once, not after its heartbeat ages out', async function () {
        this.timeout(60_000);
        const storeFile = path.join(tmp, 'store', 'usage.sqlite');
        const dying = await run(CHILD, [COMPILED, storeFile, FIXTURE_ROOT, 'hold-and-die', String(PARSER_VERSION)]);
        assert.strictEqual(dying.code, 0, dying.err.slice(0, 600));
        assert.deepStrictEqual(JSON.parse(dying.out), { leased: true });

        const sqlite = loadSqlite();
        assert.ok(sqlite, 'this runtime has no node:sqlite');
        const opened = UsageStore.open(sqlite, storeFile);
        assert.strictEqual(opened.status, 'ready');
        try {
            assert.ok(opened.store.acquireLease('import', 'this-window', PARSER_VERSION), 'the dead holder kept the lease');
        } finally {
            opened.store.close();
        }
    });
});
