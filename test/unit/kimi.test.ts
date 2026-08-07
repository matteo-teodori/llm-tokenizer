import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import { countWithCore, evictKimiCore, kimiCore, parseRankFile, splitRegex } from '../../src/tokenizer/kimi';

const FIXTURES = path.join(__dirname, '..', '..', '..', 'test', 'fixtures', 'kimi');
const rankFile = (): string => fs.readFileSync(path.join(FIXTURES, 'tiktoken.model'), 'utf8');

suite('Kimi pre-tokenizer', () => {
    /**
     * Moonshot's pattern uses three constructs JavaScript does not have as
     * written — `&&` class intersection, `\p{Han}` as a bare property, and
     * `(?i:…)` inline flags — so it had to be translated. The split decides
     * which pieces the merges run over, so a translation that is merely close
     * gives counts that are merely close.
     *
     * These are the splits Moonshot's own pattern produces, captured from the
     * reference engine. Every case must match exactly.
     */
    const reference = JSON.parse(
        fs.readFileSync(path.join(FIXTURES, 'reference-splits.json'), 'utf8'),
    ) as { text: string; pieces: string[] }[];

    test('reproduces the reference splits exactly', () => {
        assert.ok(reference.length >= 20, 'the reference set should be substantial');

        for (const { text, pieces } of reference) {
            const mine = [...text.matchAll(splitRegex())].map(m => m[0]);
            assert.deepStrictEqual(
                mine,
                pieces,
                `split differs for ${JSON.stringify(text.slice(0, 40))}`,
            );
        }
    });

    test('keeps Han apart from surrounding script', () => {
        // The whole point of the `--[\p{Script=Han}]` difference: Han runs are
        // their own piece and never merge into a neighbouring Latin word.
        const pieces = [...'ab漢字cd'.matchAll(splitRegex())].map(m => m[0]);
        assert.ok(pieces.includes('漢字'), pieces.join('|'));
    });

    test('matches contractions in either case', () => {
        // `(?i:'s|'t|…)` has no JavaScript equivalent, so both cases are
        // spelled out; dropping one would split "CAN'T" differently to "can't".
        for (const [text, expected] of [["don't", "don't"], ["DON'T", "DON'T"]] as const) {
            const pieces = [...text.matchAll(splitRegex())].map(m => m[0]);
            assert.deepStrictEqual(pieces, [expected]);
        }
    });

    test('the regex is rebuilt per call, so matching is not stateful', () => {
        // A shared /g regex carries lastIndex between calls and would silently
        // skip the start of the second string.
        const once = [...'hello'.matchAll(splitRegex())].map(m => m[0]);
        const twice = [...'hello'.matchAll(splitRegex())].map(m => m[0]);
        assert.deepStrictEqual(once, twice);
    });
});

suite('Kimi rank file', () => {
    test('parses base64 tokens into an array indexed by rank', () => {
        const ranks = parseRankFile('IQ== 0\nIg== 1\nIw== 2\n');
        assert.deepStrictEqual(ranks, ['!', '"', '#']);
    });

    test('keeps tokens that are not valid UTF-8 as bytes', () => {
        // Kimi's real table has 1,172 of these — mostly lone continuation
        // bytes, which have no string form and would otherwise be mangled.
        const ranks = parseRankFile(`${Buffer.from([0xa1]).toString('base64')} 0\n`);
        assert.deepStrictEqual(ranks, [[0xa1]]);
    });

    test('ignores blank and malformed lines rather than throwing', () => {
        const ranks = parseRankFile('IQ== 0\n\ngarbage\nIg== 1\n');
        assert.deepStrictEqual(ranks, ['!', '"']);
    });

    test('rejects a file with nothing usable in it', () => {
        // A truncated download should fail loudly at load, not produce an
        // encoder that silently counts everything as one token.
        assert.throws(() => parseRankFile(''), /no usable entries/);
        assert.throws(() => parseRankFile('not a rank file\n'), /no usable entries/);
    });
});

suite('Kimi counting', () => {
    teardown(() => evictKimiCore('fixture'));

    test('counts one token per byte when the table has no useful merges', () => {
        // The fixture is all 256 single bytes plus merges for "lo" and "He",
        // so these counts are derivable by hand rather than taken on trust.
        const core = kimiCore('fixture', rankFile());

        // "world!" has no merge available: 6 bytes, 6 tokens.
        assert.strictEqual(countWithCore(core, 'world!'), 6);
        // "" is nothing at all.
        assert.strictEqual(countWithCore(core, ''), 0);
    });

    test('applies merges from the table', () => {
        const core = kimiCore('fixture', rankFile());

        // "Hello" is He + l + lo — both merges fire, so 5 bytes become 3.
        assert.strictEqual(countWithCore(core, 'Hello'), 3);
        // The same length with no merge available stays at one token per byte.
        assert.strictEqual(countWithCore(core, 'wxyzq'), 5);
        // And a string where only "He" applies loses exactly one.
        assert.strictEqual(countWithCore(core, 'Hexxx'), 4);
    });

    test('caches the parsed table per repo, and releases it on eviction', () => {
        const first = kimiCore('fixture', rankFile());
        assert.strictEqual(kimiCore('fixture', rankFile()), first, 'should be the same instance');

        evictKimiCore('fixture');
        assert.notStrictEqual(kimiCore('fixture', rankFile()), first, 'eviction should drop it');
    });

    test('counts without materialising the token array', () => {
        // A 10 MB file would otherwise build a throwaway array of millions of
        // numbers purely to read its length.
        const core = kimiCore('fixture', rankFile());
        const big = 'world! '.repeat(20_000);
        assert.strictEqual(countWithCore(core, big), 7 * 20_000);
    });
});
