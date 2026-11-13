import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ALL_ACCOUNTS, NOT_RECORDED, accountKey, accountLabels, givenNames, isAccountFilter, isAccountId, isAccountKey, showable } from '../../src/usage/accounts';
import { MAX_CONFIG_BYTES, readClaudeAccounts, topLevel } from '../../src/usage/claudeAccounts';
import { resolveRoots } from '../../src/usage/roots';

const A = '0f1e2d3c-4b5a-4968-8776-655443322110';
const ORG_A = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const ORG_A2 = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e';
const B = '9e8d7c6b-5a49-4837-a625-140f0e0d0c0b';
const C = '11111111-2222-4333-8444-555555555555';

/** A character by its code point, so that no invisible one has to be written in this file. */
const char = (code: number) => String.fromCodePoint(code);

suite('usage accounts: keys and labels', () => {
    test('a key is an account and its organization, empty where it names none; a filter is a key or every account', () => {
        assert.strictEqual(accountKey({ accountUuid: A, organizationUuid: ORG_A }), `${A}/${ORG_A}`);
        assert.strictEqual(accountKey({ accountUuid: A, organizationUuid: null }), `${A}/`);
        assert.strictEqual(accountKey(null), NOT_RECORDED);
        for (const good of [`${A}/${ORG_A}`, `${A}/`, NOT_RECORDED]) {
            assert.ok(isAccountKey(good) && isAccountFilter(good), good);
        }
        assert.ok(isAccountFilter(ALL_ACCOUNTS) && !isAccountKey(ALL_ACCOUNTS));
        // What the page could post that is not one: never a filter.
        for (const bad of [A, `${A.toUpperCase()}/`, `${A}/x`, `/${ORG_A}`, `${A}/${ORG_A}/`, '', 'ALL', 42, null, undefined]) {
            assert.ok(!isAccountFilter(bad), String(bad));
        }
        assert.ok(isAccountId(A) && !isAccountId(`${A}/`) && !isAccountId(A.toUpperCase()));
    });

    test("labels are Claude Code's own: the email, and the organization's name unless it is a personal account's", () => {
        const labels = accountLabels(
            [
                { key: `${A}/${ORG_A}`, owner: { accountUuid: A, organizationUuid: ORG_A }, firstTs: 1 },
                { key: `${B}/`, owner: { accountUuid: B, organizationUuid: null }, firstTs: 2 },
                { key: NOT_RECORDED, owner: null, firstTs: 0 },
            ],
            [
                { accountUuid: A, organizationUuid: ORG_A, email: 'a@example.com', organizationName: 'Acme' },
                { accountUuid: B, organizationUuid: null, email: 'b@example.com', organizationName: "b@example.com's Organization" },
            ],
            {},
        );
        assert.deepStrictEqual(Object.fromEntries([...labels].map(([key, l]) => [key, l.label])), {
            [`${A}/${ORG_A}`]: 'a@example.com (Acme)',
            [`${B}/`]: 'b@example.com',
            [NOT_RECORDED]: 'Not recorded',
        });
    });

    test('an account with no name is numbered by first use, whatever is named meanwhile; a name you give stands for its email', () => {
        const seen = [
            { key: `${C}/`, owner: { accountUuid: C, organizationUuid: null }, firstTs: 30 },
            { key: `${A}/${ORG_A}`, owner: { accountUuid: A, organizationUuid: ORG_A }, firstTs: 10 },
            { key: `${B}/`, owner: { accountUuid: B, organizationUuid: null }, firstTs: 20 },
        ];
        const none = accountLabels(seen, [], {});
        assert.deepStrictEqual([...seen].map(s => none.get(s.key)?.label), ['Account 3', 'Account 1', 'Account 2']);
        // B named by Claude Code, A by you: C keeps its number.
        const named = accountLabels(seen, [{ accountUuid: B, organizationUuid: null, email: 'b@example.com', organizationName: null }], { [A]: 'Work' });
        assert.deepStrictEqual(
            [...seen].map(s => [named.get(s.key)?.label, named.get(s.key)?.named, named.get(s.key)?.claudeName]),
            [['Account 3', false, null], ['Work', true, null], ['b@example.com', false, null]],
        );
        // Named by you where Claude Code names it too: its name is kept beside yours.
        const both = accountLabels(seen, [{ accountUuid: A, organizationUuid: ORG_A, email: 'a@example.com', organizationName: 'Acme' }], { [A]: 'Work' });
        assert.deepStrictEqual([both.get(`${A}/${ORG_A}`)?.label, both.get(`${A}/${ORG_A}`)?.claudeName], ['Work (Acme)', 'a@example.com (Acme)']);
    });

    test("an account's second organization, unnamed, is told apart by number, and a label is cut where Claude Code cuts it", () => {
        const seen = [
            { key: `${A}/${ORG_A}`, owner: { accountUuid: A, organizationUuid: ORG_A }, firstTs: 1 },
            { key: `${A}/${ORG_A2}`, owner: { accountUuid: A, organizationUuid: ORG_A2 }, firstTs: 2 },
        ];
        const labels = accountLabels(seen, [{ accountUuid: A, organizationUuid: ORG_A, email: 'a@example.com', organizationName: null }], {});
        assert.deepStrictEqual([labels.get(`${A}/${ORG_A}`)?.label, labels.get(`${A}/${ORG_A2}`)?.label], ['a@example.com (organization 1)', 'a@example.com (organization 2)']);
        const long = accountLabels(seen.slice(0, 1), [{ accountUuid: A, organizationUuid: ORG_A, email: `${'x'.repeat(90)}@example.com`, organizationName: null }], {});
        const label = long.get(`${A}/${ORG_A}`)?.label ?? '';
        assert.deepStrictEqual([[...label].length, label.endsWith('…')], [80, true]);
    });

    test('a name keeps nothing that could hide or reorder what it shows, and the names you give are only ids with a name', () => {
        const hidden = `Wo${char(0x202e)}rk${char(0x200b)}${char(0x0007)}\n\t  Org`;
        assert.strictEqual(showable(hidden, 60), 'Wo rk Org');
        assert.strictEqual(showable(`  ${char(0x2028)} `, 60), null);
        assert.strictEqual(showable(42, 60), null);
        assert.strictEqual(showable('x'.repeat(70), 60)?.length, 60);
        assert.deepStrictEqual(givenNames({ [A.toUpperCase()]: ' Work ', [B]: '', [C]: 7, 'not-an-id': 'X' }), { [A]: 'Work' });
        assert.deepStrictEqual(givenNames(['Work']), {});
        assert.deepStrictEqual(givenNames('Work'), {});
    });
});

suite("usage accounts: Claude Code's configuration", () => {
    let tmp: string;

    setup(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-tokenizer-accounts-'));
    });

    teardown(() => {
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    const write = (name: string, value: string | object): string => {
        const file = path.join(tmp, name);
        fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
        return file;
    };

    test('only the two keys at the top are taken: the same names nested deeper, and every other value, are skipped unparsed', () => {
        const config = JSON.stringify({
            numStartups: 12,
            projects: { '/repo': { oauthAccount: { accountUuid: B }, history: ['{"oauthAccount":', '\\"}', '}]'] } },
            'oauth\\Account': 'escaped key',
            empty: {},
            list: [1, [2, { a: '}' }], 'x'],
            flag: true,
            nothing: null,
            oauthAccount: { accountUuid: A, emailAddress: 'a@example.com', organizationUuid: ORG_A, organizationName: 'Acme', fullName: 'kept nowhere' },
            knownAccounts: { [B]: { emailAddress: 'b@example.com', organizations: { '': null, [ORG_A2]: 'Other' } } },
        });
        const found = topLevel(Buffer.from(config), new Set(['oauthAccount', 'knownAccounts', 'empty', 'flag', 'nothing', 'list']));
        assert.deepStrictEqual(found.get('oauthAccount'), JSON.parse(config).oauthAccount);
        assert.deepStrictEqual([found.get('empty'), found.get('flag'), found.get('nothing'), found.get('list')], [{}, true, null, [1, [2, { a: '}' }], 'x']]);
        assert.ok(found.has('knownAccounts'));
        // A key given twice is its last value, as JSON.parse takes it.
        assert.deepStrictEqual(topLevel(Buffer.from('{"a": 1, "a": 2}'), new Set(['a'])).get('a'), 2);
        // A byte order mark is let pass; what cannot be read keeps what came before it.
        assert.deepStrictEqual(topLevel(Buffer.from(`${char(0xfeff)}{"a": 1, "b": [}`), new Set(['a', 'b'])), new Map([['a', 1]]));
        assert.deepStrictEqual(topLevel(Buffer.from('["a"]'), new Set(['a'])).size, 0);
        assert.deepStrictEqual(topLevel(Buffer.from('{"a": "unclosed'), new Set(['a'])).size, 0);
        assert.deepStrictEqual(topLevel(Buffer.from(''), new Set(['a'])).size, 0);
    });

    test('the account signed in now and every one Claude Code has known, each field checked, the rest of the file ignored', () => {
        const file = write('.claude.json', {
            oauthAccount: { accountUuid: A.toUpperCase(), emailAddress: `a@example.com${char(0x202e)}`, organizationUuid: ORG_A, organizationName: 'Acme' },
            knownAccounts: {
                [A]: { emailAddress: 'a@example.com', organizations: { [ORG_A]: 'Acme Old', [ORG_A2]: null } },
                [B]: { emailAddress: 'b@example.com', organizations: { '': null, 'not-an-id': 'X' } },
                'not-an-id': { emailAddress: 'x@example.com', organizations: { '': null } },
                [C]: 'not an object',
            },
        });
        const read = readClaudeAccounts([file]);
        assert.deepStrictEqual(read.current, [{ accountUuid: A, organizationUuid: ORG_A }]);
        assert.deepStrictEqual(read.names, [
            // The one signed in now first: its name wins.
            { accountUuid: A, organizationUuid: ORG_A, email: 'a@example.com', organizationName: 'Acme' },
            { accountUuid: A, organizationUuid: ORG_A2, email: 'a@example.com', organizationName: null },
            { accountUuid: B, organizationUuid: null, email: 'b@example.com', organizationName: null },
        ]);
        // What the account signed in now leaves out, its list may say, as Claude Code itself takes it.
        const partial = write('partial.json', {
            oauthAccount: { accountUuid: A, emailAddress: 'a@example.com', organizationUuid: ORG_A },
            knownAccounts: { [A]: { emailAddress: 'a@example.com', organizations: { [ORG_A]: 'Acme' } } },
        });
        assert.deepStrictEqual(readClaudeAccounts([partial]).names, [{ accountUuid: A, organizationUuid: ORG_A, email: 'a@example.com', organizationName: 'Acme' }]);
    });

    test('a file missing, not a file, too large or not JSON says nothing; one unchanged is not read again', () => {
        assert.deepStrictEqual(readClaudeAccounts([path.join(tmp, 'missing.json'), tmp, write('bad.json', '{"oauthAccount": {')]), { names: [], current: [] });
        // Past the cap, a file is not read, whatever it would have said.
        const signedIn = JSON.stringify({ oauthAccount: { accountUuid: A, emailAddress: 'a@example.com' } });
        const big = write('big.json', `${signedIn.slice(0, -1)}, "pad": "${' '.repeat(MAX_CONFIG_BYTES - signedIn.length)}"}`);
        assert.ok(fs.statSync(big).size > MAX_CONFIG_BYTES);
        assert.deepStrictEqual(readClaudeAccounts([big]), { names: [], current: [] });
        fs.truncateSync(big, signedIn.length - 1);
        fs.appendFileSync(big, '}');
        assert.strictEqual(readClaudeAccounts([big]).names.length, 1, 'the same file under the cap');

        const file = write('.claude.json', { oauthAccount: { accountUuid: A, emailAddress: 'a@example.com' } });
        assert.strictEqual(readClaudeAccounts([file]).names[0]?.email, 'a@example.com');
        // Changed under it, as Claude Code rewrites it at a login: read again.
        fs.writeFileSync(file, JSON.stringify({ oauthAccount: { accountUuid: B, emailAddress: 'b@example.com' } }));
        fs.utimesSync(file, new Date(), new Date(Date.now() + 5_000));
        assert.strictEqual(readClaudeAccounts([file]).names[0]?.email, 'b@example.com');
    });

    test("each root's configuration file is found as Claude Code finds its own, and only those that are files", () => {
        const home = path.join(tmp, 'home');
        const claude = path.join(home, '.claude');
        const custom = path.join(tmp, 'custom');
        for (const dir of [path.join(claude, 'projects'), path.join(custom, 'projects')]) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(path.join(home, '.claude.json'), '{}');
        fs.writeFileSync(path.join(custom, '.claude.json'), '{}');
        const resolve = (env: NodeJS.ProcessEnv = {}) =>
            resolveRoots({ setting: '', editorEnvironment: undefined, env, home, platform: process.platform, confineTo: [tmp] }).accountFiles.map(f =>
                path.relative(fs.realpathSync(tmp), f),
            );
        // ~/.claude read without CLAUDE_CONFIG_DIR: ~/.claude.json.
        assert.deepStrictEqual(resolve(), [path.join('home', '.claude.json')]);
        // A folder CLAUDE_CONFIG_DIR names: its own, besides ~/.claude's.
        assert.deepStrictEqual(resolve({ CLAUDE_CONFIG_DIR: custom }), [path.join('custom', '.claude.json'), path.join('home', '.claude.json')]);
        // ~/.claude named by CLAUDE_CONFIG_DIR too, at times: both places.
        fs.writeFileSync(path.join(claude, '.claude.json'), '{}');
        assert.deepStrictEqual(resolve(), [path.join('home', '.claude', '.claude.json'), path.join('home', '.claude.json')]);
        // The older name, while it holds something, is the one Claude Code reads.
        fs.writeFileSync(path.join(custom, '.config.json'), '{}');
        assert.deepStrictEqual(resolve({ CLAUDE_CONFIG_DIR: custom })[0], path.join('custom', '.config.json'));
        fs.writeFileSync(path.join(custom, '.config.json'), '');
        assert.deepStrictEqual(resolve({ CLAUDE_CONFIG_DIR: custom })[0], path.join('custom', '.claude.json'));
    });

    test('under test, a configuration file outside the fixtures is never named, a link that leads out included', function () {
        if (process.platform === 'win32') {
            // Links need privileges there.
            this.skip();
        }
        const home = path.join(tmp, 'home');
        fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-tokenizer-outside-'));
        try {
            fs.writeFileSync(path.join(outside, 'real.json'), '{}');
            fs.symlinkSync(path.join(outside, 'real.json'), path.join(home, '.claude.json'));
            const resolved = resolveRoots({ setting: '', editorEnvironment: undefined, env: {}, home, platform: process.platform, confineTo: [tmp] });
            assert.deepStrictEqual([resolved.roots.length, resolved.accountFiles], [1, []]);
        } finally {
            fs.rmSync(outside, { recursive: true, force: true });
        }
    });
});
