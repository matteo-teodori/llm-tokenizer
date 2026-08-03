import * as assert from 'assert';
import * as vscode from 'vscode';

import { CountCache } from '../../src/countCache';

const A = vscode.Uri.file('/repo/src/a.ts');
const B = vscode.Uri.file('/repo/src/b.ts');

suite('count cache', () => {
    let cache: CountCache;

    setup(() => {
        cache = new CountCache();
    });

    test('round-trips the count', () => {
        cache.set('gpt-5.6-sol', A, 100, { count: 42, exact: true });
        assert.deepStrictEqual(cache.get('gpt-5.6-sol', A, 100), { count: 42, exact: true });
    });

    test('an estimate stays an estimate when read back', () => {
        // The cache used to store only the count and report every hit as exact,
        // so the first read of an estimated model showed ≈ and every read after
        // it dropped the marker while the number stayed a guess. This is the
        // whole reason the cache is its own module.
        cache.set('claude-opus-5', A, 100, { count: 42, exact: false });
        assert.strictEqual(cache.get('claude-opus-5', A, 100)?.exact, false);
    });

    test('a different model does not read another model\'s count', () => {
        // Keyed on path alone, switching from GPT to Gemini kept serving the
        // old model's numbers forever: mtimes were unchanged, so no rescan
        // ever corrected it.
        cache.set('gpt-5.6-sol', A, 100, { count: 42, exact: true });
        assert.strictEqual(cache.get('gemini-3.5-flash', A, 100), undefined);
    });

    test('a modified file misses', () => {
        cache.set('gpt-5.6-sol', A, 100, { count: 42, exact: true });
        assert.strictEqual(cache.get('gpt-5.6-sol', A, 101), undefined);
    });

    test('an unknown file misses', () => {
        cache.set('gpt-5.6-sol', A, 100, { count: 42, exact: true });
        assert.strictEqual(cache.get('gpt-5.6-sol', B, 100), undefined);
    });

    test('deleting a file forgets it under every model', () => {
        cache.set('gpt-5.6-sol', A, 100, { count: 1, exact: true });
        cache.set('claude-opus-5', A, 100, { count: 2, exact: false });
        cache.set('gpt-5.6-sol', B, 100, { count: 3, exact: true });

        cache.deleteFile(A);

        assert.strictEqual(cache.get('gpt-5.6-sol', A, 100), undefined);
        assert.strictEqual(cache.get('claude-opus-5', A, 100), undefined);
        assert.deepStrictEqual(cache.get('gpt-5.6-sol', B, 100), { count: 3, exact: true });
    });

    test('deleting a file does not affect one whose path it prefixes', () => {
        const dir = vscode.Uri.file('/repo/src');
        cache.set('gpt-5.6-sol', dir, 100, { count: 1, exact: true });
        cache.set('gpt-5.6-sol', A, 100, { count: 2, exact: true });

        cache.deleteFile(dir);

        assert.strictEqual(cache.get('gpt-5.6-sol', dir, 100), undefined);
        assert.ok(cache.get('gpt-5.6-sol', A, 100), 'a file under the deleted path should survive');
    });

    test('a model id cannot collide with a uri across the separator', () => {
        // The key joins the two; a naive separator would let one pair's key
        // equal another's and serve the wrong count.
        cache.set('a', vscode.Uri.file('/b'), 1, { count: 111, exact: true });
        cache.set('a\nfile:///b', vscode.Uri.file('/c'), 1, { count: 222, exact: true });

        assert.strictEqual(cache.get('a', vscode.Uri.file('/b'), 1)?.count, 111);
    });

    test('clear empties it', () => {
        cache.set('gpt-5.6-sol', A, 100, { count: 1, exact: true });
        cache.clear();
        assert.strictEqual(cache.size, 0);
        assert.strictEqual(cache.get('gpt-5.6-sol', A, 100), undefined);
    });

    test('the source file contains no NUL bytes', async () => {
        // The key separator used to be a literal NUL. It worked, but grep,
        // ripgrep and most editors then treated extension.ts as binary and
        // skipped it entirely — searching the largest file in the project
        // silently returned nothing.
        const here = vscode.Uri.file(__dirname);
        const src = vscode.Uri.joinPath(here, '..', '..', '..', 'src', 'extension.ts');
        const bytes = await vscode.workspace.fs.readFile(src);
        assert.ok(!bytes.includes(0), 'src/extension.ts must not contain a NUL byte');
    });
});
