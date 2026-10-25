import * as assert from 'assert';
import * as vscode from 'vscode';

import {
    CountCache,
    DocumentCounts,
    isBinaryOutcome,
    type CachedCount,
    type CachedOutcome,
} from '../../src/countCache';
import { findModel, type ModelInfo } from '../../src/tokenizer/registry';

const A = vscode.Uri.file('/repo/src/a.ts');
const B = vscode.Uri.file('/repo/src/b.ts');

/**
 * Read back a cached count, asserting it is a count and not a binary verdict.
 *
 * `get` returns a union now that the cache also remembers "this file is
 * binary"; these tests are all about the count arm.
 */
function counted(outcome: CachedOutcome | undefined): CachedCount {
    assert.ok(outcome, 'nothing was cached');
    assert.ok(!isBinaryOutcome(outcome), 'expected a count, got a binary verdict');
    return outcome;
}

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
        assert.strictEqual(counted(cache.get('claude-opus-5', A, 100)).exact, false);
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
        // The key used to join the two, where a naive separator would let one
        // pair's key equal another's and serve the wrong count.
        cache.set('a', vscode.Uri.file('/b'), 1, { count: 111, exact: true });
        cache.set('a\nfile:///b', vscode.Uri.file('/c'), 1, { count: 222, exact: true });

        assert.strictEqual(counted(cache.get('a', vscode.Uri.file('/b'), 1)).count, 111);
    });

    test('clear empties it', () => {
        cache.set('gpt-5.6-sol', A, 100, { count: 1, exact: true });
        cache.clear();
        assert.strictEqual(cache.size, 0);
        assert.strictEqual(cache.get('gpt-5.6-sol', A, 100), undefined);
    });

    test('a file counted under a second model keeps the first one\'s count', () => {
        // A file's one entry is kept as it is, and becomes a map of them only
        // when a second model counts it.
        cache.set('gpt-5.6-sol', A, 100, { count: 1, exact: true });
        cache.set('claude-opus-5', A, 100, { count: 2, exact: false });
        cache.set('gemini-2.5-pro', A, 100, { binary: true });

        assert.deepStrictEqual(cache.get('gpt-5.6-sol', A, 100), { count: 1, exact: true });
        assert.deepStrictEqual(cache.get('claude-opus-5', A, 100), { count: 2, exact: false });
        assert.deepStrictEqual(cache.get('gemini-2.5-pro', A, 100), { binary: true });
        assert.strictEqual(cache.get('kimi-k3', A, 100), undefined);

        cache.set('claude-opus-5', A, 200, { count: 3, exact: false });
        assert.deepStrictEqual(cache.get('claude-opus-5', A, 200), { count: 3, exact: false });
        assert.strictEqual(cache.size, 3);
    });

    test('size counts every entry, across files and models', () => {
        cache.set('gpt-5.6-sol', A, 100, { count: 1, exact: true });
        cache.set('claude-opus-5', A, 100, { count: 2, exact: false });
        cache.set('gpt-5.6-sol', B, 100, { count: 3, exact: true });
        // A file counted again replaces its entry rather than adding one.
        cache.set('gpt-5.6-sol', A, 101, { count: 4, exact: true });
        assert.strictEqual(cache.size, 3);

        cache.deleteFile(A);
        assert.strictEqual(cache.size, 1);
        cache.deleteFile(vscode.Uri.file('/repo/never-cached.ts'));
        assert.strictEqual(cache.size, 1);
    });

    test('forgetting a file does not walk the whole cache', () => {
        // The watcher forgets each file a checkout touches, synchronously on
        // the extension host's thread, and every one used to walk the whole
        // cache: 2,000 of them against 20,000 entries took 2.5 s, measured.
        // They take about a millisecond now.
        const uris = Array.from({ length: 10_000 }, (_, i) => vscode.Uri.file(`/repo/packages/p${i % 100}/src/f${i}.ts`));
        for (const uri of uris) {
            cache.set('gpt-5.6-sol', uri, 1, { count: 1, exact: true });
            cache.set('claude-opus-5', uri, 1, { count: 1, exact: false });
        }

        const started = performance.now();
        for (const uri of uris.slice(0, 2_000)) {
            cache.deleteFile(uri);
        }
        const took = performance.now() - started;

        assert.ok(took < 250, `2,000 files took ${took.toFixed(0)} ms to forget`);
        assert.strictEqual(cache.size, 16_000);
        assert.strictEqual(cache.get('gpt-5.6-sol', uris[0], 1), undefined);
        assert.ok(cache.get('gpt-5.6-sol', uris[2_000], 1), 'a file not forgotten was lost');
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

suite('count cache: binary verdicts', () => {
    let cache: CountCache;

    setup(() => {
        cache = new CountCache();
    });

    test('a binary verdict is remembered and read back as one', () => {
        // Reaching the verdict costs a full read of the file — up to the 10 MB
        // cap — and BINARY_EXTENSIONS cannot list every binary format, so
        // .wasm, .parquet, .pt and friends were re-read end to end on every
        // project scan, which re-runs seconds after every save.
        cache.set('gpt-5.6-sol', A, 100, { binary: true });

        const outcome = cache.get('gpt-5.6-sol', A, 100);
        assert.ok(outcome);
        assert.ok(isBinaryOutcome(outcome), 'a binary verdict came back as a count');
    });

    test('a binary verdict expires with the mtime, like a count', () => {
        cache.set('gpt-5.6-sol', A, 100, { binary: true });
        assert.strictEqual(cache.get('gpt-5.6-sol', A, 101), undefined);
    });

    test('a binary verdict does not leak across models', () => {
        cache.set('gpt-5.6-sol', A, 100, { binary: true });
        assert.strictEqual(cache.get('claude-opus-5', A, 100), undefined);
    });

    test('a file that stops being binary is recounted', () => {
        // Overwriting a placeholder with real text keeps the path and changes
        // the mtime; the stale verdict must not survive.
        cache.set('gpt-5.6-sol', A, 100, { binary: true });
        cache.set('gpt-5.6-sol', A, 200, { count: 12, exact: true });

        const outcome = cache.get('gpt-5.6-sol', A, 200);
        assert.ok(outcome && !isBinaryOutcome(outcome));
        assert.strictEqual(outcome.count, 12);
    });
});

suite('document counts', () => {
    /** A stand-in for the tokenizer worker that records what it is asked. */
    function counter(exact = true) {
        const asked: { text: string; model: string }[] = [];
        const counts = new DocumentCounts((text, model) => {
            asked.push({ text, model: model.id });
            return Promise.resolve({ count: text.length, exact });
        });
        return { asked, counts };
    }

    /** An open document: what the status bar counts, by identity and version. */
    function document(text: string, version = 1) {
        return { version, getText: () => text };
    }

    function model(id: string): ModelInfo {
        const found = findModel(id);
        assert.ok(found, `test refers to unknown model ${id}`);
        return found;
    }

    test('an unchanged document is counted once, however often it is asked for', async () => {
        // Every cursor stop and every return to a tab sent the whole document
        // to the worker again: half a second a time with Llama 3.3's tokenizer
        // on a 1.9 MB file, and every count queued behind it waited.
        const { asked, counts } = counter();
        const doc = document('const x = 42;\n');
        const gpt = model('gpt-5.6-sol');

        for (let i = 0; i < 5; i++) {
            assert.deepStrictEqual(await counts.count(doc, gpt), { count: 14, exact: true });
        }
        assert.strictEqual(asked.length, 1, `counted ${asked.length} times`);
    });

    test('an edit, or another model, counts it again', async () => {
        const { asked, counts } = counter();
        const doc = document('one');
        await counts.count(doc, model('gpt-5.6-sol'));

        doc.version = 2;
        doc.getText = () => 'one two';
        assert.strictEqual((await counts.count(doc, model('gpt-5.6-sol'))).count, 7);
        assert.strictEqual((await counts.count(doc, model('claude-opus-5'))).count, 7);

        assert.deepStrictEqual(asked, [
            { text: 'one', model: 'gpt-5.6-sol' },
            { text: 'one two', model: 'gpt-5.6-sol' },
            { text: 'one two', model: 'claude-opus-5' },
        ]);
    });

    test('a count still in flight is shared, not posted again', async () => {
        const { asked, counts } = counter();
        const doc = document('shared');
        const gpt = model('gpt-5.6-sol');

        const [first, second] = await Promise.all([counts.count(doc, gpt), counts.count(doc, gpt)]);
        assert.deepStrictEqual(first, second);
        assert.strictEqual(asked.length, 1);
    });

    test('documents are told apart by identity, not by name or version', async () => {
        // A document closed and opened again starts at version 1 again, and
        // may hold other text by then.
        const { asked, counts } = counter();
        const gpt = model('gpt-5.6-sol');
        await counts.count(document('before'), gpt);
        assert.strictEqual((await counts.count(document('after, and longer'), gpt)).count, 17);
        assert.strictEqual(asked.length, 2);
    });

    test('a degraded count is asked for again, while an estimate that is the answer is kept', async () => {
        // An estimate from a model that counts exactly means the worker
        // crashed, timed out or errored; kept, it would stay on the status bar
        // until the next edit.
        const { asked, counts } = counter(false);
        const doc = document('text');
        for (const id of ['gpt-5.6-sol', 'gemini-2.5-pro', 'claude-opus-5']) {
            await counts.count(doc, model(id));
            await counts.count(doc, model(id));
        }
        assert.deepStrictEqual(asked.map(a => a.model), [
            'gpt-5.6-sol', 'gpt-5.6-sol',
            // Downloadable: whether its vocabulary is there would cost a read
            // to find out, so it is asked again too.
            'gemini-2.5-pro', 'gemini-2.5-pro',
            // No tokenizer is published: the estimate is all there is.
            'claude-opus-5',
        ]);
    });

    test('clear forgets every document', async () => {
        // A vocabulary downloaded or deleted changes the answer for an
        // unchanged document, and the accuracy event clears this with the cache.
        const { asked, counts } = counter();
        const doc = document('text');
        const gpt = model('gpt-5.6-sol');
        await counts.count(doc, gpt);
        counts.clear();
        await counts.count(doc, gpt);
        assert.strictEqual(asked.length, 2);
    });
});
