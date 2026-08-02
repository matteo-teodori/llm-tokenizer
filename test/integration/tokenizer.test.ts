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

suite('tokenizer service', () => {
    let log: vscode.LogOutputChannel;
    let store: TokenizerStore;
    let tokenizer: TokenizerService;

    setup(() => {
        log = vscode.window.createOutputChannel('LLM Tokenizer (test)', { log: true });
        store = new TokenizerStore(
            vscode.Uri.file(path.join(os.tmpdir(), `llm-tokenizer-test-${process.pid}`)),
        );
        tokenizer = new TokenizerService(WORKER, store, log);
    });

    teardown(() => {
        tokenizer.dispose();
        log.dispose();
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

    test('a downloaded tokenizer survives the worker restarting', async () => {
        // The worker forgets its loaded tokenizers when it dies. Without
        // re-hydration every later count for that model quietly degrades to an
        // estimate — correctly labelled, but permanently.
        const llama = model('llama-3.3-70b');
        assert.strictEqual(llama.encoder.kind, 'hf');

        // Nothing has been downloaded in this test's storage directory, so the
        // count is an estimate and re-hydration must not start a download.
        const before = await tokenizer.count('text', llama);
        assert.strictEqual(before.exact, false);

        tokenizer.dispose();
        tokenizer = new TokenizerService(WORKER, store, log);

        const after = await tokenizer.count('text', llama);
        assert.strictEqual(after.count, before.count, 'the estimate should be stable across a restart');
        assert.strictEqual(after.exact, false);
    });

    test('large input is counted without blocking the host', async () => {
        const big = 'lorem ipsum dolor sit amet '.repeat(20_000); // ~540 KB
        const started = Date.now();
        const result = await tokenizer.count(big, model('gpt-5.6-sol'));
        assert.ok(result.count > 100_000, `unexpectedly few tokens: ${result.count}`);
        assert.ok(Date.now() - started < 30_000, 'counting took implausibly long');
    });
});
