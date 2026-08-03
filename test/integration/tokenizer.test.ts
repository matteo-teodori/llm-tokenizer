import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { TokenizerService } from '../../src/tokenizer/tokenizerService';
import { TokenizerStore } from '../../src/tokenizer/tokenizerStore';
import { findModel } from '../../src/tokenizer/registry';
import type { ModelInfo } from '../../src/tokenizer/registry';

/** The bundled worker, as the extension host loads it. */
const WORKER = path.join(__dirname, '..', '..', '..', 'out', 'worker.js');

function model(id: string): ModelInfo {
    const found = findModel(id);
    assert.ok(found, `test refers to unknown model ${id}`);
    return found;
}

/**
 * Place the fixture tokenizer in the store as if it had been downloaded.
 *
 * Mirrors TokenizerStore's on-disk layout: one directory per repo, with the
 * slash flattened.
 */
async function seedTokenizer(
    storage: vscode.Uri,
    repo: string,
    fixtureName = 'tokenizer',
): Promise<void> {
    const fixture = vscode.Uri.file(path.join(__dirname, '..', '..', '..', 'test', 'fixtures', fixtureName));
    const target = vscode.Uri.joinPath(storage, repo.replace(/[/\\]/g, '--'));
    await vscode.workspace.fs.createDirectory(target);

    for (const name of ['tokenizer.json', 'tokenizer_config.json']) {
        await vscode.workspace.fs.copy(
            vscode.Uri.joinPath(fixture, name),
            vscode.Uri.joinPath(target, name),
            { overwrite: true },
        );
    }
}

suite('tokenizer service', () => {
    let log: vscode.LogOutputChannel;
    let store: TokenizerStore;
    let tokenizer: TokenizerService;
    let storageUri: vscode.Uri;
    let testIndex = 0;

    setup(() => {
        log = vscode.window.createOutputChannel('LLM Tokenizer (test)', { log: true });
        // A fresh directory per test: one of these seeds a tokenizer, and the
        // others assert that nothing has been downloaded.
        storageUri = vscode.Uri.file(
            path.join(os.tmpdir(), `llm-tokenizer-test-${process.pid}-${testIndex++}`),
        );
        store = new TokenizerStore(storageUri);
        tokenizer = new TokenizerService(WORKER, store, log);
    });

    teardown(async () => {
        tokenizer.dispose();
        log.dispose();
        try {
            await vscode.workspace.fs.delete(storageUri, { recursive: true, useTrash: false });
        } catch {
            // Never created, which is the common case.
        }
    });

    test('counts OpenAI models exactly, with known values', async () => {
        // Golden values from tiktoken itself. A change here means the encoding
        // tables shifted, which would silently move every OpenAI count.
        const cases: [string, string, number][] = [
            ['gpt-5.6-sol', 'Hello world!', 3],
            ['gpt-4-turbo', 'Hello world!', 3],
            ['gpt-5.6-sol', 'const x = 42;', 6],
        ];

        for (const [id, text, expected] of cases) {
            const result = await tokenizer.count(text, model(id));
            assert.strictEqual(result.count, expected, `${id} on "${text}"`);
            assert.strictEqual(result.exact, true);
        }
    });

    test('the three bundled encodings all load', async () => {
        // Each encoding is a separate lazily-required bundle; a packaging
        // mistake shows up as one of these failing to load.
        for (const id of ['gpt-5.6-sol', 'gpt-oss-120b', 'gpt-4-turbo']) {
            const result = await tokenizer.count('token counting', model(id));
            assert.ok(result.count > 0, `${id} produced no tokens`);
            assert.strictEqual(result.exact, true, `${id} should be exact`);
        }
    });

    test('empty input is zero tokens and costs no round trip', async () => {
        const result = await tokenizer.count('', model('gpt-5.6-sol'));
        assert.deepStrictEqual(result, { count: 0, exact: true });
    });

    test('models with no public tokenizer are counted, but marked estimated', async () => {
        // Anthropic and xAI publish no tokenizer. Returning a number is fine;
        // presenting it as exact is not.
        for (const id of ['claude-opus-5', 'grok-4.5']) {
            const result = await tokenizer.count('some text to count', model(id));
            assert.ok(result.count > 0);
            assert.strictEqual(result.exact, false, `${id} must not claim exactness`);
        }
    });

    test('Claude 4.7+ counts higher than Claude 4.6 for the same text', async () => {
        // Anthropic changed tokenizer at Opus 4.7; the same text costs roughly
        // a third more. Inferring the tokenizer from the version number is
        // wrong (Sonnet 4.6 shipped later and uses the old one), so the split
        // is hardcoded — this guards that it stays applied.
        const text = 'The quick brown fox jumps over the lazy dog. '.repeat(20);
        const current = await tokenizer.count(text, model('claude-opus-4-7'));
        const legacy = await tokenizer.count(text, model('claude-opus-4-6'));
        assert.ok(
            current.count > legacy.count,
            `expected Opus 4.7 (${current.count}) to exceed Opus 4.6 (${legacy.count})`,
        );
    });

    test('Sonnet 4.6 uses the legacy tokenizer despite its version number', async () => {
        const text = 'x'.repeat(1000);
        const sonnet46 = await tokenizer.count(text, model('claude-sonnet-4-6'));
        const opus46 = await tokenizer.count(text, model('claude-opus-4-6'));
        assert.strictEqual(sonnet46.count, opus46.count);
    });

    test('a model whose tokenizer has not been downloaded still returns a count', async () => {
        // Degrading to an estimate keeps the extension usable offline; failing
        // the count would leave the status bar blank.
        const result = await tokenizer.count('some text', model('llama-3.3-70b'));
        assert.ok(result.count > 0);
        assert.strictEqual(result.exact, false);
    });

    test('isExact reflects what can be counted without a download', async () => {
        assert.strictEqual(await tokenizer.isExact(model('gpt-5.6-sol')), true);
        assert.strictEqual(await tokenizer.isExact(model('claude-opus-5')), false);
        assert.strictEqual(await tokenizer.isExact(model('llama-3.3-70b')), false);
    });

    test('concurrent counts are correlated to the right request', async () => {
        // Every response carries an id; mixing them up would attribute one
        // file's count to another.
        const inputs = Array.from({ length: 40 }, (_, i) => 'word '.repeat(i + 1));
        const results = await Promise.all(inputs.map(t => tokenizer.count(t, model('gpt-5.6-sol'))));

        for (let i = 1; i < results.length; i++) {
            assert.ok(
                results[i].count > results[i - 1].count,
                `result ${i} (${results[i].count}) should exceed ${i - 1} (${results[i - 1].count})`,
            );
        }
    });

    test('counting survives a disposed and re-created service', () => {
        tokenizer.dispose();
        tokenizer = new TokenizerService(WORKER, store, log);
        return tokenizer.count('after restart', model('gpt-5.6-sol')).then(result => {
            assert.ok(result.count > 0);
        });
    });

    test('counting after dispose falls back instead of hanging', async () => {
        // v1.3.0 captured a `reject` it never called, so a dead worker left
        // every pending count unresolved and froze the status bar forever.
        tokenizer.dispose();
        const result = await tokenizer.count('still answers', model('gpt-5.6-sol'));
        assert.ok(result.count > 0);
        assert.strictEqual(result.exact, false, 'a fallback count is an estimate');
    });

    test('an undownloaded model stays an estimate, and never fetches mid-count', async () => {
        const llama = model('llama-3.3-70b');
        assert.strictEqual(llama.encoder.kind, 'hf');

        const result = await tokenizer.count('text', llama);
        assert.strictEqual(result.exact, false);
        assert.ok(Number.isFinite(result.count) && result.count > 0);
        assert.strictEqual(
            await store.isDownloaded(llama.encoder.repo),
            false,
            'counting must not trigger a download on its own',
        );
    });

    test('a downloaded tokenizer is used, and survives the worker restarting', async () => {
        // Seeded from a tiny fixture rather than the network: the earlier
        // version of this test never put a tokenizer in the store at all, so it
        // asserted that an estimate stayed an estimate and proved nothing about
        // the path it claimed to cover.
        const llama = model('llama-3.3-70b');
        assert.strictEqual(llama.encoder.kind, 'hf');
        await seedTokenizer(storageUri, llama.encoder.repo);

        // The fixture merges "a"+"b", so "abc" is exactly two tokens and no
        // character heuristic would land on that number.
        const first = await tokenizer.count('abc', llama);
        assert.strictEqual(first.exact, true, 'a seeded tokenizer should give an exact count');
        assert.strictEqual(first.count, 2);

        // The worker forgets its loaded tokenizers when it dies. Without
        // re-hydration every later count silently degrades to an estimate —
        // correctly labelled, but permanently.
        tokenizer.dispose();
        tokenizer = new TokenizerService(WORKER, store, log);

        const afterRestart = await tokenizer.count('abc', llama);
        assert.strictEqual(afterRestart.exact, true, 'exactness must survive a worker restart');
        assert.strictEqual(afterRestart.count, 2);
    });

    test('an explicit download overrides an earlier "not on disk" result', async () => {
        // Counting remembers which tokenizers are absent so it stops asking the
        // file system once per file. That memo must not outlive an actual
        // download, or the command would appear to succeed and change nothing.
        const llama = model('llama-3.3-70b');
        assert.strictEqual(llama.encoder.kind, 'hf');

        const before = await tokenizer.count('abc', llama);
        assert.strictEqual(before.exact, false);

        await seedTokenizer(storageUri, llama.encoder.repo);
        assert.strictEqual(await tokenizer.ensureExact(llama), true);

        const after = await tokenizer.count('abc', llama);
        assert.strictEqual(after.exact, true);
        assert.strictEqual(after.count, 2);
    });

    test('special tokens are not counted as file content', async () => {
        // Some tokenizers prepend a beginning-of-sequence token — Mistral's
        // does. Counting it made every file one token heavy, and the result was
        // still labelled exact. The fixture's vocabulary is identical to the
        // plain one, so the corrected count must match it exactly.
        const llama = model('llama-3.3-70b');
        assert.strictEqual(llama.encoder.kind, 'hf');
        await seedTokenizer(storageUri, llama.encoder.repo, 'tokenizer-bos');

        const result = await tokenizer.count('abc', llama);
        assert.strictEqual(result.exact, true);
        assert.strictEqual(result.count, 2, 'the BOS token must not be counted');

        // And an empty file is still zero, not one.
        assert.deepStrictEqual(await tokenizer.count('', llama), { count: 0, exact: true });
    });

    test('large input is counted without blocking the host', async () => {
        const big = 'lorem ipsum dolor sit amet '.repeat(20_000); // ~540 KB
        const started = Date.now();
        const result = await tokenizer.count(big, model('gpt-5.6-sol'));
        assert.ok(result.count > 100_000, `unexpectedly few tokens: ${result.count}`);
        assert.ok(Date.now() - started < 30_000, 'counting took implausibly long');
    });
});
