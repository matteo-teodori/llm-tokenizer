import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { TokenizerService } from '../../src/tokenizer/tokenizerService';
import { TokenizerStore, writeWhole } from '../../src/tokenizer/tokenizerStore';
import { findModel } from '../../src/tokenizer/registry';
import type { ModelInfo } from '../../src/tokenizer/registry';
import { MAX_TOKENIZED_FILE_BYTES } from '../../src/constants';

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

/** Place the synthetic Kimi rank table in the store as if downloaded. */
async function seedRankTable(storage: vscode.Uri, repo: string): Promise<void> {
    const fixture = vscode.Uri.file(
        path.join(__dirname, '..', '..', '..', 'test', 'fixtures', 'kimi', 'tiktoken.model'),
    );
    const target = vscode.Uri.joinPath(storage, repo.replace(/[/\\]/g, '--'));
    await vscode.workspace.fs.createDirectory(target);
    await vscode.workspace.fs.copy(fixture, vscode.Uri.joinPath(target, 'tiktoken.model'), {
        overwrite: true,
    });
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

    test('every tiktoken encoding the registry names is actually shipped', async () => {
        // build.mjs writes one file per encoding into out/encodings/ and
        // encoders.ts requires them by path at runtime. The two lists are
        // maintained by hand in different files — the TiktokenEncoding union
        // says "must stay in sync with ENCODINGS in build.mjs" and nothing
        // checked it. A registry entry naming an encoding that was not built
        // throws MODULE_NOT_FOUND inside the worker, which the service catches
        // and turns into a silent estimate for every OpenAI model.
        const { MODELS } = await import('../../src/tokenizer/registry');
        const encodings = new Set(
            MODELS.map(m => m.encoder).flatMap(e => (e.kind === 'tiktoken' ? [e.encoding] : [])),
        );
        assert.ok(encodings.size > 0, 'no model uses a bundled encoding');

        const dir = vscode.Uri.file(path.join(__dirname, '..', '..', '..', 'out', 'encodings'));
        const built = new Set(
            (await vscode.workspace.fs.readDirectory(dir))
                .filter(([, type]) => type === vscode.FileType.File)
                .map(([name]) => name.replace(/\.js$/, '')),
        );

        for (const encoding of encodings) {
            assert.ok(built.has(encoding), `${encoding} is in the registry but was not built`);
        }
    });

    test('a file containing a special-token literal still counts exactly', async () => {
        // gpt-tokenizer disallows every special token by default and *throws* on
        // input containing one. A prompt template, a tokenizer_config.json or a
        // fine-tuning dataset holding the literal `<|endoftext|>` therefore
        // failed to count, and failed invisibly: the service swallowed the error
        // and returned a character estimate. Worse, the project scan folds
        // `exact &&=` across files, so one such file relabelled an entire exact
        // workspace as estimated.
        //
        // Entered through TokenizerService rather than the encoding module, so
        // the whole chain — worker, protocol, error path — is under test. Both
        // shipped OpenAI encodings are covered because their special-token sets
        // differ (Harmony adds <|start|>, <|message|>, <|channel|> and friends).
        const cases: [string, string][] = [
            ['gpt-5.6-sol', '<|endoftext|>'],
            ['gpt-4-turbo', '<|endoftext|>'],
            ['gpt-oss-120b', '<|start|>system<|message|>hi<|end|>'],
        ];

        for (const [id, literal] of cases) {
            const target = model(id);
            const text = `prefix ${literal} suffix`;

            const result = await tokenizer.count(text, target);

            assert.ok(result.exact, `${id} degraded to an estimate on ${literal}`);
            // The literal must be encoded as text, so it costs more than one
            // token — a special token would be exactly one.
            const plain = await tokenizer.count('prefix  suffix', target);
            assert.ok(
                result.count > plain.count + 1,
                `${id} counted ${literal} as ${result.count - plain.count} token(s); it should be encoded as text`,
            );
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
            await store.isDownloaded(llama.encoder.repo, 'hf'),
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

    test('Kimi is estimated until its rank table is present, then exact', async () => {
        // Moonshot publishes a tiktoken rank table rather than a
        // tokenizer.json, so this is a different download path to the Hugging
        // Face one — and the whole family was estimated before it existed.
        const kimi = model('kimi-k3');
        assert.strictEqual(kimi.encoder.kind, 'tiktokenModel');

        const before = await tokenizer.count('Hello', kimi);
        assert.strictEqual(before.exact, false);

        await seedRankTable(storageUri, kimi.encoder.repo);
        assert.strictEqual(await tokenizer.ensureExact(kimi), true);

        // The fixture merges "He" and "lo", so "Hello" is exactly three.
        const after = await tokenizer.count('Hello', kimi);
        assert.strictEqual(after.exact, true);
        assert.strictEqual(after.count, 3);
    });

    test('every Kimi model shares one downloaded rank table', async () => {
        // The rank file is byte-identical across the family, so the registry
        // points them all at one repo: downloading once must serve all three.
        const repos = ['kimi-k3', 'kimi-k2.7-code', 'kimi-k2.6'].map(id => {
            const m = model(id);
            assert.strictEqual(m.encoder.kind, 'tiktokenModel');
            return m.encoder.kind === 'tiktokenModel' ? m.encoder.repo : '';
        });
        assert.strictEqual(new Set(repos).size, 1, `expected one repo, got ${repos.join(', ')}`);

        await seedRankTable(storageUri, repos[0]);
        for (const id of ['kimi-k3', 'kimi-k2.7-code', 'kimi-k2.6']) {
            const result = await tokenizer.count('Hello', model(id));
            assert.strictEqual(result.exact, true, `${id} should be exact`);
            assert.strictEqual(result.count, 3, id);
        }
    });

    test('forgetting loaded vocabularies reverts counts to estimates', async () => {
        // Clearing the store alone left the worker holding its parsed
        // tokenizer, so the download command afterwards said "already
        // downloaded" and did nothing, while the ~150 MB rank table stayed
        // resident until the window reloaded.
        const kimi = model('kimi-k3');
        assert.strictEqual(kimi.encoder.kind, 'tiktokenModel');
        await seedRankTable(storageUri, kimi.encoder.repo);
        assert.strictEqual(await tokenizer.ensureExact(kimi), true);
        assert.strictEqual((await tokenizer.count('Hello', kimi)).exact, true);

        await store.clear();
        await tokenizer.forgetLoaded();

        const after = await tokenizer.count('Hello', kimi);
        assert.strictEqual(after.exact, false, 'the worker should have forgotten it too');
        assert.strictEqual(await tokenizer.isExact(kimi), false);
    });

    test('a cache file is never left half-written', async () => {
        // A rank table parses line by line, so a torn write leaves a plausible
        // but short table that reads back as an exact tokenizer for as long as
        // it sits on disk. The write goes to a sibling and is renamed, so the
        // target either does not exist or is whole.
        const dir = vscode.Uri.joinPath(storageUri, 'atomic-write');
        await vscode.workspace.fs.createDirectory(dir);
        const target = vscode.Uri.joinPath(dir, 'tiktoken.model');

        await writeWhole(dir, 'tiktoken.model', 'IQ== 0\nIg== 1\n');
        assert.strictEqual(
            new TextDecoder().decode(await vscode.workspace.fs.readFile(target)),
            'IQ== 0\nIg== 1\n',
        );

        // Overwriting an existing file works, and leaves no scratch behind.
        await writeWhole(dir, 'tiktoken.model', 'IQ== 0\n');
        assert.strictEqual(
            new TextDecoder().decode(await vscode.workspace.fs.readFile(target)),
            'IQ== 0\n',
        );

        const left = (await vscode.workspace.fs.readDirectory(dir)).map(([name]) => name);
        assert.deepStrictEqual(left, ['tiktoken.model'], `scratch files left behind: ${left.join(', ')}`);
    });

    test('clearing the cache is not undone by a download already in flight', async () => {
        // The download resolves after the clear. It used to repopulate the
        // in-memory cache behind the "cleared" message, so counts stayed exact
        // and the download command reported "already downloaded".
        const kimi = model('kimi-k3');
        assert.strictEqual(kimi.encoder.kind, 'tiktokenModel');
        await seedRankTable(storageUri, kimi.encoder.repo);
        assert.strictEqual(await store.isDownloaded(kimi.encoder.repo, 'tiktokenModel'), true);

        await store.clear();

        assert.strictEqual(
            await store.isDownloaded(kimi.encoder.repo, 'tiktokenModel'),
            false,
            'the store still reports a tokenizer after being cleared',
        );
    });

    test('text past the file cap is estimated, not tokenized', async () => {
        // The scan caps file size before reading, but an open editor hands over
        // a document that is already in memory, so nothing stopped a 30 MB file
        // reaching the tokenizer — 8.5 s and a 3.3 GB spike on the Hugging Face
        // backend, repeated on every debounced keystroke.
        const gpt = model('gpt-5.6-sol');
        const over = 'a'.repeat(MAX_TOKENIZED_FILE_BYTES + 1);

        const result = await tokenizer.count(over, gpt);
        assert.strictEqual(result.exact, false, 'an uncounted estimate must not claim to be exact');
        assert.ok(result.count > 0);

        // Just under the cap still goes to the worker and counts exactly.
        const under = await tokenizer.count('a'.repeat(1_000), gpt);
        assert.strictEqual(under.exact, true);
    });

    test('large input is counted without blocking the host', async () => {
        const big = 'lorem ipsum dolor sit amet '.repeat(20_000); // ~540 KB
        const started = Date.now();
        const result = await tokenizer.count(big, model('gpt-5.6-sol'));
        assert.ok(result.count > 100_000, `unexpectedly few tokens: ${result.count}`);
        assert.ok(Date.now() - started < 30_000, 'counting took implausibly long');
    });
});
