import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
    ALL_ACCOUNTS,
    NOT_RECORDED,
    accountKey,
    accountLabels,
    givenNames,
    isAccountFilter,
    isAccountId,
    isAccountKey,
    nameReplaces,
    numberAccounts,
    showable,
    type AccountSeen,
} from '../../src/usage/accounts';
import { MAX_CONFIG_BYTES, readClaudeAccounts, topLevel } from '../../src/usage/claudeAccounts';
import { resolveRoots } from '../../src/usage/roots';
import type { SessionOwner } from '../../src/usage/types';

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

    /** An account as the history numbered it: its numbers, how many organizations its account has, and its first use. */
    const seenAs = (owner: SessionOwner | null, ordinal: number | null = null, organization: number | null = 1, organizations = 1, firstTs = 0): AccountSeen => ({
        key: accountKey(owner),
        owner,
        firstTs,
        ordinal: owner ? ordinal : null,
        organizationOrdinal: owner ? organization : null,
        organizations: owner ? organizations : 0,
    });
    const ownerOf = (accountUuid: string, organizationUuid: string | null = null): SessionOwner => ({ accountUuid, organizationUuid });

    test("labels are Claude Code's own: the email, and the organization's name unless it is a personal account's", () => {
        const labels = accountLabels(
            [seenAs(ownerOf(A, ORG_A), 1), seenAs(ownerOf(B), 2), seenAs(null)],
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

    test('an account with no name is named by its number, whatever is named meanwhile; a name you give stands for its email', () => {
        const seen = [seenAs(ownerOf(C), 3), seenAs(ownerOf(A, ORG_A), 1), seenAs(ownerOf(B), 2)];
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

    test("an account's number is the one the history gave it, never a place among the accounts left", () => {
        // A, number 1, has no session left: B and C keep theirs.
        const labels = accountLabels([seenAs(ownerOf(B), 2), seenAs(ownerOf(C), 3)], [], {});
        assert.deepStrictEqual([labels.get(`${B}/`)?.label, labels.get(`${C}/`)?.label], ['Account 2', 'Account 3']);
    });

    test("an account's second organization, unnamed, is told apart by its own number, and a label is cut where Claude Code cuts it", () => {
        const seen = [seenAs(ownerOf(A, ORG_A), 1, 1, 2), seenAs(ownerOf(A, ORG_A2), 1, 2, 2)];
        const names = [{ accountUuid: A, organizationUuid: ORG_A, email: 'a@example.com', organizationName: null }];
        const labels = accountLabels(seen, names, {});
        assert.deepStrictEqual([labels.get(`${A}/${ORG_A}`)?.label, labels.get(`${A}/${ORG_A2}`)?.label], ['a@example.com (organization 1)', 'a@example.com (organization 2)']);
        // The first one's sessions gone: the second keeps its number.
        assert.strictEqual(accountLabels(seen.slice(1), names, {}).get(`${A}/${ORG_A2}`)?.label, 'a@example.com (organization 2)');
        const long = accountLabels([seenAs(ownerOf(A, ORG_A), 1)], [{ accountUuid: A, organizationUuid: ORG_A, email: `${'x'.repeat(90)}@example.com`, organizationName: null }], {});
        const label = long.get(`${A}/${ORG_A}`)?.label ?? '';
        assert.deepStrictEqual([[...label].length, label.endsWith('…')], [80, true]);
    });

    test("accounts are numbered once, by first use, after those numbered; an account's new organization takes its account's number and the next of its own", () => {
        const numbered = new Map([
            [`${A}/${ORG_A}`, { ordinal: 1, organization: 1 }],
            [`${B}/`, { ordinal: 2, organization: 1 }],
        ]);
        const given = numberAccounts(numbered, [ownerOf(C), ownerOf(A, ORG_A2), ownerOf(A, ORG_A), ownerOf(C), ownerOf(B, ORG_A)]);
        assert.deepStrictEqual(Object.fromEntries(given), {
            [`${C}/`]: { ordinal: 3, organization: 1 },
            [`${A}/${ORG_A2}`]: { ordinal: 1, organization: 2 },
            [`${B}/${ORG_A}`]: { ordinal: 2, organization: 2 },
        });
        assert.deepStrictEqual(Object.fromEntries(numberAccounts(new Map(), [ownerOf(B), ownerOf(A)])), {
            [`${B}/`]: { ordinal: 1, organization: 1 },
            [`${A}/`]: { ordinal: 2, organization: 1 },
        });
        // Whatever order the numbers kept come in: after the highest.
        const kept = new Map([
            [`${B}/`, { ordinal: 2, organization: 1 }],
            [`${A}/${ORG_A2}`, { ordinal: 1, organization: 2 }],
            [`${A}/${ORG_A}`, { ordinal: 1, organization: 1 }],
        ]);
        assert.deepStrictEqual(Object.fromEntries(numberAccounts(kept, [ownerOf(A), ownerOf(C)])), {
            [`${A}/`]: { ordinal: 1, organization: 3 },
            [`${C}/`]: { ordinal: 3, organization: 1 },
        });
    });

    test('labels that would read alike are told apart by the first digits of what differs', () => {
        const seen = [seenAs(ownerOf(A, ORG_A), 1, 1, 2), seenAs(ownerOf(A, ORG_A2), 1, 2, 2), seenAs(ownerOf(B), 2), seenAs(ownerOf(C), 3)];
        const names = [
            { accountUuid: A, organizationUuid: ORG_A, email: 'a@example.com', organizationName: 'Acme' },
            { accountUuid: A, organizationUuid: ORG_A2, email: 'a@example.com', organizationName: 'Acme' },
            { accountUuid: B, organizationUuid: null, email: 'b@example.com', organizationName: null },
        ];
        // Two organizations of one name, and a name you gave that is another account's email.
        const labels = accountLabels(seen, names, { [C]: 'b@example.com' });
        assert.deepStrictEqual(seen.map(x => labels.get(x.key)?.label), [
            `a@example.com (Acme) · ${A.slice(0, 8)}/${ORG_A.slice(0, 8)}`,
            `a@example.com (Acme) · ${A.slice(0, 8)}/${ORG_A2.slice(0, 8)}`,
            `b@example.com · ${B.slice(0, 8)}`,
            `b@example.com · ${C.slice(0, 8)}`,
        ]);
        // A name you gave that reads as the sessions that record none.
        const plain = accountLabels([seenAs(ownerOf(B), 1), seenAs(null)], [], { [B]: 'Not recorded' });
        assert.deepStrictEqual([plain.get(`${B}/`)?.label, plain.get('none')?.label], [`Not recorded · ${B.slice(0, 8)}`, 'Not recorded']);
    });

    test('labels told apart stay apart: two accounts in one organization, one with another of that name too, none without one, and digits alike', () => {
        // A in X and in Y, B in X, all three 'Work (Acme)'.
        const mixed = accountLabels(
            [seenAs(ownerOf(A, ORG_A), 1, 1, 2), seenAs(ownerOf(A, ORG_A2), 1, 2, 2), seenAs(ownerOf(B, ORG_A), 2)],
            [
                { accountUuid: A, organizationUuid: ORG_A, email: null, organizationName: 'Acme' },
                { accountUuid: A, organizationUuid: ORG_A2, email: null, organizationName: 'Acme' },
                { accountUuid: B, organizationUuid: ORG_A, email: null, organizationName: 'Acme' },
            ],
            { [A]: 'Work', [B]: 'Work' },
        );
        assert.deepStrictEqual(
            [...mixed.values()].map(l => l.label),
            [`Work (Acme) · ${A.slice(0, 8)}/${ORG_A.slice(0, 8)}`, `Work (Acme) · ${A.slice(0, 8)}/${ORG_A2.slice(0, 8)}`, `Work (Acme) · ${B.slice(0, 8)}`],
        );
        // An organization whose name reads as A's own with none, and two
        // accounts whose ids begin alike: the whole ids for those alone.
        const D = '11111111-9999-4333-8444-555555555555';
        const labels = accountLabels(
            [seenAs(ownerOf(A, ORG_A2), 1, 1, 2), seenAs(ownerOf(A), 1, 2, 2), seenAs(ownerOf(C), 2), seenAs(ownerOf(D), 3)],
            [{ accountUuid: A, organizationUuid: ORG_A2, email: null, organizationName: 'organization 2' }],
            { [A]: 'Work', [C]: 'Home', [D]: 'Home' },
        );
        assert.deepStrictEqual(
            [...labels.values()].map(l => l.label),
            [`Work (organization 2) · ${A.slice(0, 8)}/${ORG_A2.slice(0, 8)}`, `Work (organization 2) · ${A.slice(0, 8)}/no organization`, `Home · ${C}`, `Home · ${D}`],
        );
        // A name you gave that reads as another's label once told apart.
        const told = [...accountLabels([seenAs(ownerOf(B), 1), seenAs(ownerOf(C), 2), seenAs(ownerOf(A), 3)], [], { [B]: 'Work', [C]: 'Work', [A]: `Work · ${B.slice(0, 8)}` }).values()].map(l => l.label);
        assert.deepStrictEqual(told, [`Work · ${B}`, `Work · ${C}`, `Work · ${B.slice(0, 8)}`]);
    });

    test('an account the history has not numbered yet is told by the first digits of its id, an organization of it likewise', () => {
        const labels = accountLabels(
            [seenAs(ownerOf(A, ORG_A), null, null, 3), seenAs(ownerOf(A), null, null, 3), seenAs(ownerOf(B), 2)],
            [],
            {},
        );
        assert.deepStrictEqual(
            [labels.get(`${A}/${ORG_A}`)?.label, labels.get(`${A}/`)?.label, labels.get(`${B}/`)?.label],
            [`Account ${A.slice(0, 8)} (organization ${ORG_A.slice(0, 8)})`, `Account ${A.slice(0, 8)} (no organization)`, 'Account 2'],
        );
        const numberedOrganization = accountLabels([seenAs(ownerOf(A, ORG_A), 1, 2, 2)], [], {}).get(`${A}/${ORG_A}`);
        assert.deepStrictEqual([numberedOrganization?.label, numberedOrganization?.organization], ['Account 1 (organization 2)', 'organization 2']);
        assert.strictEqual(accountLabels([seenAs(ownerOf(B), 1)], [], {}).get(`${B}/`)?.organization, null);
        // Named by you, the organization it names is said as well.
        const given = accountLabels([seenAs(ownerOf(A, ORG_A), 1)], [{ accountUuid: A, organizationUuid: ORG_A, email: 'a@example.com', organizationName: 'Acme' }], { [A]: 'Work' });
        assert.deepStrictEqual([given.get(`${A}/${ORG_A}`)?.label, given.get(`${A}/${ORG_A}`)?.organization], ['Work (Acme)', 'Acme']);
    });

    test("labels that read alike in another style or case are told apart too, and none takes the filter's own", () => {
        const styled = String.fromCodePoint(0x1d5a0, 0x1d5bc, 0x1d5c6, 0x1d5be);
        const labels = accountLabels([seenAs(ownerOf(A), 1), seenAs(ownerOf(B), 2), seenAs(ownerOf(C), 3)], [], { [A]: 'Acme', [B]: styled, [C]: 'ACME' });
        assert.deepStrictEqual([...labels.values()].map(l => l.label), [`Acme · ${A.slice(0, 8)}`, `${styled} · ${B.slice(0, 8)}`, `ACME · ${C.slice(0, 8)}`]);
        const all = accountLabels([seenAs(ownerOf(A), 1), seenAs(ownerOf(B), 2)], [], { [A]: 'All accounts' });
        assert.deepStrictEqual([all.get(`${A}/`)?.label, all.get(`${B}/`)?.label], [`All accounts · ${A.slice(0, 8)}`, 'Account 2']);
    });

    test('a name you give stands in place of the email, as its labels show it, else of its number', () => {
        const seen = [seenAs(ownerOf(A, ORG_A), 2)];
        assert.strictEqual(nameReplaces(A, seen, [{ accountUuid: A, organizationUuid: ORG_A2, email: 'a@example.com', organizationName: 'Beta' }]), 'a@example.com');
        assert.strictEqual(nameReplaces(A, seen, [{ accountUuid: A, organizationUuid: ORG_A, email: null, organizationName: "p@example.com's Organization" }]), 'p@example.com');
        assert.strictEqual(nameReplaces(A, seen, []), 'Account 2');
        assert.strictEqual(nameReplaces(B, seen, []), 'its number');
    });

    test("a personal organization's name gives its email where nothing else does, and a long email is cut before its organization", () => {
        const seen = [seenAs(ownerOf(A, ORG_A), 1)];
        const personal = accountLabels(seen, [{ accountUuid: A, organizationUuid: ORG_A, email: null, organizationName: "a@example.com's Organization" }], {});
        assert.strictEqual(personal.get(`${A}/${ORG_A}`)?.label, 'a@example.com');
        const long = accountLabels(seen, [{ accountUuid: A, organizationUuid: ORG_A, email: `${'x'.repeat(90)}@example.com`, organizationName: 'Acme Corp' }], {});
        const label = long.get(`${A}/${ORG_A}`)?.label ?? '';
        assert.ok(label.endsWith('… (Acme Corp)') && [...label].length === 80, label);
    });

    test('a name keeps nothing that could hide or reorder what it shows, and the names you give are only ids with a name', () => {
        const hidden = `Wo${char(0x202e)}rk${char(0x200b)}${char(0x0007)}\n\t  Org`;
        assert.strictEqual(showable(hidden, 60), 'Work Org');
        // Invisible tags, a Mongolian vowel separator and interlinear annotations, past the basic plane or not.
        assert.strictEqual(showable(`Work${char(0xe0041)}${char(0xe007f)}${char(0x180e)}${char(0xfff9)}`, 60), 'Work');
        // And every other character that draws nothing, assigned or not: a
        // grapheme joiner, variation selectors, fillers, unassigned tags.
        for (const code of [0x034f, 0xfe0f, 0xe0100, 0x115f, 0x17b4, 0x2065, 0x3164, 0xffa0, 0xe0000, 0xe0002]) {
            assert.strictEqual(showable(`Ac${char(code)}me`, 60), 'Acme', code.toString(16));
        }
        // One normal form: a letter and its accent read as the letter they make.
        assert.strictEqual(showable(`Caf${char(0x65)}${char(0x301)}`, 60), `Caf${char(0xe9)}`);
        // The blank Braille cell draws as a space, and is one.
        assert.strictEqual(showable(`Acme${char(0x2800)}`, 60), 'Acme');
        assert.strictEqual(showable(char(0x2800), 60), null);
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

    test("names from every file, the one Claude Code wrote last first; only those said to tell which account it is signed in to now", () => {
        // An older file, signed in to B, that knew A's organization's name;
        // a newer one, signed in to A, that leaves the name out.
        const older = write('older.json', {
            oauthAccount: { accountUuid: B, emailAddress: 'b@example.com' },
            knownAccounts: { [A]: { emailAddress: 'old@example.com', organizations: { [ORG_A]: 'Acme' } } },
        });
        const newer = write('newer.json', { oauthAccount: { accountUuid: A, emailAddress: 'a@example.com', organizationUuid: ORG_A } });
        const at = (file: string, seconds: number) => fs.utimesSync(file, new Date(seconds * 1000), new Date(seconds * 1000));
        at(older, 1_900_000_000);
        at(newer, 2_000_000_000);
        // Listed older first, as two roots' files can be: the newer's name stands all the same.
        const read = readClaudeAccounts([older, newer], [newer]);
        assert.deepStrictEqual(
            read.names.map(n => [n.accountUuid, n.organizationUuid, n.email, n.organizationName]),
            [
                [A, ORG_A, 'a@example.com', 'Acme'],
                [B, null, 'b@example.com', null],
            ],
        );
        assert.deepStrictEqual(read.current, [{ accountUuid: A, organizationUuid: ORG_A }]);
        // Every file, where none is said.
        assert.deepStrictEqual(readClaudeAccounts([older, newer]).current.map(o => o.accountUuid).sort(), [A, B].sort());
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
        const resolveAll = (env: NodeJS.ProcessEnv = {}) => {
            const resolved = resolveRoots({ setting: '', editorEnvironment: undefined, env, home, platform: process.platform, confineTo: [tmp] });
            const relative = (files: string[]) => files.map(f => path.relative(fs.realpathSync(tmp), f));
            return { names: relative(resolved.accountFiles), signedIn: relative(resolved.signedInFiles) };
        };
        const resolve = (env: NodeJS.ProcessEnv = {}) => resolveAll(env).names;
        // ~/.claude read without CLAUDE_CONFIG_DIR: ~/.claude.json.
        assert.deepStrictEqual(resolveAll(), { names: [path.join('home', '.claude.json')], signedIn: [path.join('home', '.claude.json')] });
        // A folder CLAUDE_CONFIG_DIR names: its own, besides ~/.claude's, each saying who is signed in there.
        const both = [path.join('custom', '.claude.json'), path.join('home', '.claude.json')];
        assert.deepStrictEqual(resolveAll({ CLAUDE_CONFIG_DIR: custom }), { names: both, signedIn: both });
        // ~/.claude named by CLAUDE_CONFIG_DIR at times, and not at others:
        // both its files name accounts, the one Claude Code wrote last first,
        // and only that one says which is signed in now.
        fs.writeFileSync(path.join(claude, '.claude.json'), '{}');
        const at = (file: string, seconds: number) => fs.utimesSync(file, new Date(seconds * 1000), new Date(seconds * 1000));
        at(path.join(claude, '.claude.json'), 2_000_000_000);
        at(path.join(home, '.claude.json'), 1_900_000_000);
        assert.deepStrictEqual(resolveAll(), {
            names: [path.join('home', '.claude', '.claude.json'), path.join('home', '.claude.json')],
            signedIn: [path.join('home', '.claude', '.claude.json')],
        });
        at(path.join(home, '.claude.json'), 2_100_000_000);
        assert.deepStrictEqual(resolveAll(), {
            names: [path.join('home', '.claude.json'), path.join('home', '.claude', '.claude.json')],
            signedIn: [path.join('home', '.claude.json')],
        });
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
