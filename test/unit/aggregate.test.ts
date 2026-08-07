import * as assert from 'assert';

import {
    MAX_SLICES,
    byFolder,
    byLanguage,
    commonRoot,
    displayPath,
    extensionOf,
    languageOf,
    largestFirst,
    type CountedFile,
} from '../../src/summary/aggregate';

const file = (path: string, tokens: number): CountedFile => ({ path, tokens });

/** Shares must always describe the whole, or the breakdown is lying. */
function assertSharesSumToOne(slices: { share: number }[]): void {
    const total = slices.reduce((sum, s) => sum + s.share, 0);
    assert.ok(
        Math.abs(total - 1) < 1e-9,
        `shares sum to ${total}, not 1 — the breakdown does not cover the whole`,
    );
}

suite('common root', () => {
    test('is the deepest shared directory', () => {
        assert.deepStrictEqual(
            commonRoot([file('/repo/src/a.ts', 1), file('/repo/src/b.ts', 1)]),
            ['repo', 'src'],
        );
    });

    test('stops where the paths diverge', () => {
        assert.deepStrictEqual(
            commonRoot([file('/repo/src/a.ts', 1), file('/repo/docs/b.md', 1)]),
            ['repo'],
        );
    });

    test('handles a single file, and none at all', () => {
        assert.deepStrictEqual(commonRoot([file('/repo/src/a.ts', 1)]), ['repo', 'src']);
        assert.deepStrictEqual(commonRoot([]), []);
    });

    test('handles Windows separators', () => {
        assert.deepStrictEqual(
            commonRoot([file('C:\\repo\\src\\a.ts', 1), file('C:\\repo\\src\\b.ts', 1)]),
            ['C:', 'repo', 'src'],
        );
    });

    test('is empty when paths share nothing', () => {
        assert.deepStrictEqual(commonRoot([file('/a/x.ts', 1), file('/b/y.ts', 1)]), []);
    });
});

suite('breakdown by folder', () => {
    test('groups by the first segment below the shared root', () => {
        const slices = byFolder([
            file('/repo/src/a.ts', 60),
            file('/repo/src/deep/b.ts', 20),
            file('/repo/docs/c.md', 20),
        ]);

        assert.deepStrictEqual(
            slices.map(s => [s.label, s.tokens, s.files]),
            [['src', 80, 2], ['docs', 20, 1]],
        );
        assertSharesSumToOne(slices);
    });

    test('ranks largest first', () => {
        const slices = byFolder([
            file('/repo/small/a.ts', 1),
            file('/repo/big/b.ts', 100),
        ]);
        assert.strictEqual(slices[0].label, 'big');
    });

    test('files sitting in the shared root are kept, not dropped', () => {
        // Otherwise the shares silently fail to add up to the total.
        const slices = byFolder([
            file('/repo/README.md', 30),
            file('/repo/src/a.ts', 70),
        ]);

        assert.ok(slices.some(s => s.label === '(root)' && s.tokens === 30), JSON.stringify(slices));
        assertSharesSumToOne(slices);
    });

    test('folds the tail into a single Other row', () => {
        const files = Array.from({ length: MAX_SLICES + 5 }, (_, i) =>
            file(`/repo/dir${i}/a.ts`, 100 - i),
        );
        const slices = byFolder(files);

        assert.strictEqual(slices.length, MAX_SLICES + 1);
        assert.strictEqual(slices[slices.length - 1].label, 'Other');
        assert.strictEqual(slices[slices.length - 1].files, 5);
        assertSharesSumToOne(slices);
    });

    test('an empty run produces no rows rather than a divide by zero', () => {
        assert.deepStrictEqual(byFolder([]), []);
    });

    test('files that are all zero tokens do not produce NaN shares', () => {
        const slices = byFolder([file('/repo/src/a.ts', 0), file('/repo/docs/b.md', 0)]);
        assert.ok(slices.every(s => Number.isFinite(s.share)), JSON.stringify(slices));
    });
});

suite('language detection', () => {
    test('maps known extensions to names', () => {
        assert.strictEqual(languageOf('/repo/a.ts'), 'TypeScript');
        assert.strictEqual(languageOf('/repo/a.py'), 'Python');
        assert.strictEqual(languageOf('/repo/a.md'), 'Markdown');
    });

    test('falls back to the extension when unknown', () => {
        assert.strictEqual(languageOf('/repo/a.wibble'), '.wibble');
    });

    test('treats a leading dot as a name, not an extension', () => {
        assert.strictEqual(extensionOf('/repo/.gitignore'), '');
        assert.strictEqual(languageOf('/repo/.gitignore'), '.gitignore');
    });

    test('handles extensionless files', () => {
        assert.strictEqual(languageOf('/repo/Makefile'), 'No extension');
    });

    test('is case-insensitive', () => {
        assert.strictEqual(languageOf('/repo/A.TS'), 'TypeScript');
    });

    test('groups variants of one language together', () => {
        const slices = byLanguage([
            file('/repo/a.ts', 10),
            file('/repo/b.tsx', 10),
            file('/repo/c.mts', 10),
        ]);
        assert.deepStrictEqual(slices.map(s => [s.label, s.tokens]), [['TypeScript', 30]]);
    });
});

suite('file ranking and display', () => {
    test('largestFirst is stable on ties', () => {
        const ranked = largestFirst([
            file('/repo/b.ts', 10),
            file('/repo/a.ts', 10),
            file('/repo/c.ts', 20),
        ]);
        assert.deepStrictEqual(ranked.map(f => f.path), ['/repo/c.ts', '/repo/a.ts', '/repo/b.ts']);
    });

    test('largestFirst does not mutate its input', () => {
        const input = [file('/a.ts', 1), file('/b.ts', 2)];
        const before = input.map(f => f.path);
        largestFirst(input);
        assert.deepStrictEqual(input.map(f => f.path), before);
    });

    test('displayPath strips the shared root', () => {
        assert.strictEqual(displayPath('/repo/src/a.ts', ['repo', 'src']), 'a.ts');
        assert.strictEqual(displayPath('/repo/src/deep/a.ts', ['repo']), 'src/deep/a.ts');
    });

    test('displayPath leaves a path that is not under the root alone', () => {
        // Skipped and ignored entries can sit outside what the counted files
        // share; blindly slicing would mangle them.
        assert.strictEqual(displayPath('/elsewhere/a.ts', ['repo', 'src']), 'elsewhere/a.ts');
    });

    test('displayPath normalises Windows separators for display', () => {
        assert.strictEqual(displayPath('C:\\repo\\src\\a.ts', ['C:', 'repo']), 'src/a.ts');
    });
});
