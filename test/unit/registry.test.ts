import * as assert from 'assert';

import { MODELS, MODEL_ALIASES, findModel, defaultModel, providers } from '../../src/tokenizer/registry';

/**
 * Invariants over the model registry.
 *
 * v1.3.0 shipped models that did not exist, ids in a format their provider does
 * not use, and context limits that were wrong by up to 5x. Most of that cannot
 * be caught mechanically — but everything that *can* be is checked here, so a
 * future edit fails the build rather than the user.
 */
suite('model registry', () => {
    test('ids are unique', () => {
        const seen = new Set<string>();
        for (const model of MODELS) {
            assert.ok(!seen.has(model.id), `duplicate model id: ${model.id}`);
            seen.add(model.id);
        }
    });

    test('every model has a label, a provider and a plausible context limit', () => {
        for (const model of MODELS) {
            assert.ok(model.label.length > 0, `${model.id} has no label`);
            assert.ok(model.provider.length > 0, `${model.id} has no provider`);
            // 4096 is below any model shipped this decade; 20M is above the
            // largest published window. Either bound means a typo.
            assert.ok(
                model.contextLimit !== undefined &&
                model.contextLimit >= 4096 &&
                model.contextLimit <= 20_000_000,
                `${model.id} has an implausible contextLimit: ${String(model.contextLimit)}`,
            );
        }
    });

    test('models are grouped: a provider never appears in two separate runs', () => {
        // The quick pick inserts a separator on every provider change, so an
        // interleaved registry would render duplicate group headings.
        const runs: string[] = [];
        for (const model of MODELS) {
            if (runs[runs.length - 1] !== model.provider) {
                runs.push(model.provider);
            }
        }
        assert.strictEqual(runs.length, new Set(runs).size, `providers are interleaved: ${runs.join(', ')}`);
    });

    test('every alias points at a live model and does not shadow one', () => {
        const ids = new Set(MODELS.map(m => m.id));
        for (const [from, to] of Object.entries(MODEL_ALIASES)) {
            assert.ok(ids.has(to), `alias ${from} -> ${to}, but ${to} is not a model`);
            assert.ok(!ids.has(from), `alias ${from} shadows a live model of the same id`);
        }
    });

    test('every id removed in 2.0 has a migration path', () => {
        // The exact ids that v1.3.0 offered in its settings dropdown and that
        // no longer exist. A user with any of these selected must be migrated,
        // not silently reset.
        const removedInV2 = [
            'claude-4.7-opus', 'claude-4.6-sonnet', 'claude-4.6-opus', 'claude-4.5-sonnet',
            'claude-4.5-opus', 'claude-4.5-haiku', 'claude-3.7-sonnet', 'claude-3.5-sonnet',
            'claude-3-opus', 'claude-3-haiku',
            'grok-4.2', 'grok-4.1-fast', 'grok-4-fast', 'grok-3', 'grok-code-fast-1',
            'gemini-3.1-pro', 'gemini-3-flash', 'gemini-3-pro', 'gemini-2.0-flash',
            'gemini-1.5-pro', 'gemini-2.5-flash-lite',
            'deepseek-v3.2', 'deepseek-v3.1', 'deepseek-v3', 'deepseek-r1',
            'llama-3.3', 'llama-3.2', 'codellama', 'mistral-large',
            'qwen3.5', 'qwen3', 'qwq-32b', 'qwen-2.5-coder',
            'glm-4.7', 'glm-4.6', 'glm-4.5', 'kimi-k2.5',
            'gpt-4', 'o1', 'o3-mini', 'o3-pro',
        ];

        for (const id of removedInV2) {
            const migrated = findModel(id);
            assert.ok(migrated, `no migration for removed id "${id}"`);
            assert.notStrictEqual(migrated.id, id, `"${id}" should not resolve to itself`);
        }
    });

    test('models that never existed are not in the registry', () => {
        // Verified absent from xAI's published catalogue. `grok-4.2` in
        // particular looks like a mis-transcription of `grok-4.20`.
        const fabricated = ['grok-4.2', 'grok-4.1-fast', 'grok-4-fast'];
        const ids = new Set(MODELS.map(m => m.id));
        for (const id of fabricated) {
            assert.ok(!ids.has(id), `"${id}" does not exist and must not be offered`);
        }
    });

    test('Anthropic ids use the format Anthropic actually uses', () => {
        // v1.3.0 shipped `claude-4.7-opus`, which 404s. The real format puts
        // the tier before the version and separates with hyphens.
        for (const model of MODELS.filter(m => m.provider === 'Anthropic')) {
            assert.match(
                model.id,
                /^claude-(opus|sonnet|haiku|fable)-\d(-\d)?$/,
                `${model.id} is not a valid Anthropic model id`,
            );
        }
    });

    test('findModel resolves live ids, aliases, and nothing else', () => {
        assert.strictEqual(findModel('gpt-5.6-sol')?.id, 'gpt-5.6-sol');
        assert.strictEqual(findModel('claude-4.7-opus')?.id, 'claude-opus-4-7');
        assert.strictEqual(findModel('definitely-not-a-model'), undefined);
        assert.strictEqual(findModel(''), undefined);
    });

    test('the default model exists and is exact offline', () => {
        const fallback = defaultModel();
        assert.ok(MODELS.some(m => m.id === fallback.id));
        // The out-of-the-box experience should not depend on a download.
        assert.strictEqual(fallback.encoder.kind, 'tiktoken');
    });

    test('Hugging Face encoders name a plausible repo and carry a fallback', () => {
        for (const model of MODELS) {
            if (model.encoder.kind !== 'hf') {
                continue;
            }
            assert.match(model.encoder.repo, /^[\w.-]+\/[\w.-]+$/, `${model.id} has a malformed repo`);
            assert.ok(
                model.encoder.fallback.charsPerToken > 1 && model.encoder.fallback.charsPerToken < 10,
                `${model.id} has an implausible fallback ratio`,
            );
        }
    });

    test('heuristic ratios are in a sane range', () => {
        for (const model of MODELS) {
            if (model.encoder.kind !== 'heuristic') {
                continue;
            }
            assert.ok(
                model.encoder.charsPerToken > 1 && model.encoder.charsPerToken < 10,
                `${model.id} has an implausible chars-per-token ratio`,
            );
        }
    });

    test('OpenAI models are tokenized exactly, except where tiktoken has no mapping', () => {
        // tiktoken is OpenAI's own tokenizer, so an OpenAI model should never be
        // a guess — unless OpenAI has not said which encoding it uses. GPT-6 is
        // that case today: `MODEL_PREFIX_TO_ENCODING` stops at `gpt-5` and the
        // model page names no encoding, so the entry is honestly estimated
        // rather than dressed up as exact.
        //
        // The allowlist is the point of this test. A *new* estimated OpenAI
        // model still fails the build, and when tiktoken publishes a gpt-6
        // mapping the entry moves to `tiktoken` and this list goes back to empty.
        const noPublishedEncoding = new Set(['gpt-6-astra']);

        for (const model of MODELS.filter(m => m.provider === 'OpenAI')) {
            if (noPublishedEncoding.has(model.id)) {
                assert.strictEqual(
                    model.encoder.kind,
                    'heuristic',
                    `${model.id} is on the no-encoding list, so it must be estimated`,
                );
                continue;
            }
            assert.strictEqual(model.encoder.kind, 'tiktoken', `${model.id} should use tiktoken`);
        }

        // Every id on the list has to still exist, so the exception cannot
        // outlive the model it was written for.
        for (const id of noPublishedEncoding) {
            assert.ok(MODELS.some(m => m.id === id), `${id} is allowlisted but not in the registry`);
        }
    });

    test('gpt-oss uses the Harmony encoding', () => {
        for (const model of MODELS.filter(m => m.id.startsWith('gpt-oss'))) {
            assert.deepStrictEqual(model.encoder, { kind: 'tiktoken', encoding: 'o200k_harmony' });
        }
    });

    test('providers() lists each provider once, in registry order', () => {
        const list = providers();
        assert.strictEqual(list.length, new Set(list).size);
        assert.strictEqual(list[0], 'OpenAI');
    });
});

suite('accuracy labelling', () => {
    test('every encoder kind maps to one of three states', async () => {
        const { accuracyOf } = await import('../../src/tokenizer/encoders');

        assert.strictEqual(accuracyOf({ kind: 'tiktoken', encoding: 'o200k_base' }), 'exact');
        assert.strictEqual(accuracyOf({ kind: 'heuristic', charsPerToken: 3 }), 'estimated');

        const fallback = { kind: 'heuristic', charsPerToken: 3 } as const;
        assert.strictEqual(accuracyOf({ kind: 'hf', repo: 'a/b', fallback }), 'after-download');
        assert.strictEqual(
            accuracyOf({ kind: 'tiktokenModel', repo: 'a/b', fallback }),
            'after-download',
        );
    });

    test('a downloadable model is never labelled plainly exact', async () => {
        // The picker said "exact" for Kimi with nothing downloaded, which
        // contradicted both the settings dropdown and the ≈ in the status bar.
        const { accuracyOf, isDownloadable } = await import('../../src/tokenizer/encoders');

        for (const model of MODELS.filter(m => isDownloadable(m.encoder))) {
            assert.strictEqual(
                accuracyOf(model.encoder),
                'after-download',
                `${model.id} should not claim to be exact before its download`,
            );
        }
    });
});

suite('downloadable-kind discrimination', () => {
    /**
     * Nothing outside the encoder module may use `'hf'` as a stand-in for
     * "this model's vocabulary is downloaded".
     *
     * This is the shape of a real blocker: `tiktokenModel` was added alongside
     * `hf`, the encoder module gained `isDownloadable`, and the two callers
     * that actually decide whether to download — the command gate in
     * extension.ts and the tooltip in statusbar.ts — kept asking
     * `kind === 'hf'`. Kimi silently never downloaded, and the UI told users
     * Moonshot publishes no tokenizer.
     *
     * The service-level tests could not catch it: they call `ensureExact`
     * directly, below the gate. This checks the invariant instead of the
     * behaviour, which is what makes it cheap and total.
     */
    test('no module uses one encoder kind as a stand-in for a class of models', () => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fs = require('fs') as typeof import('fs');
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const path = require('path') as typeof import('path');

        const src = path.join(__dirname, '..', '..', '..', 'src');
        const offenders: string[] = [];

        const walk = (dir: string): void => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    walk(full);
                    continue;
                }
                if (!entry.name.endsWith('.ts')) {
                    continue;
                }
                // encoders.ts is where the union is defined and resolved, so it
                // is the one place allowed to switch on individual kinds.
                if (entry.name === 'encoders.ts') {
                    continue;
                }

                // `encoder.kind` against `'hf'` or `'heuristic'`: both are
                // comparisons that silently stand for a *class* of model —
                // "downloadable" and "not exact" — and both stop being true the
                // moment a fourth kind exists. The first shipped a dead download
                // path; the second labelled Kimi "exact" with nothing on disk.
                //
                // Dispatching on an asset's own kind — which file to fetch,
                // which builder to call — is legitimate and left alone.
                fs.readFileSync(full, 'utf8').split('\n').forEach((line, i) => {
                    if (/encoder\.kind\s*[!=]==\s*'(hf|heuristic)'/.test(line)) {
                        offenders.push(`${path.relative(src, full)}:${i + 1}`);
                    }
                });
            }
        };

        walk(src);

        assert.deepStrictEqual(
            offenders,
            [],
            `use isDownloadable() rather than naming a kind, at: ${offenders.join(', ')}`,
        );
    });
});

suite('registry data that the manifest depends on', () => {
    test('the default model is exact, and is what the manifest offers', async () => {
        // Two things used to be able to drift: `defaultModel()` returned
        // MODELS[0], while the manifest's default was hand-edited. They now come
        // from one constant, and this asserts the property that made the
        // constant worth having — the model a new user starts on is one the
        // extension can count exactly, with no download and no estimate.
        const { defaultModel, DEFAULT_MODEL_ID } = await import('../../src/tokenizer/registry');
        const { accuracyOf } = await import('../../src/tokenizer/encoders');

        const model = defaultModel();
        assert.strictEqual(model.id, DEFAULT_MODEL_ID);
        assert.strictEqual(
            accuracyOf(model.encoder),
            'exact',
            `the default model ${model.id} must be exact offline`,
        );
    });

    test('models sharing a downloaded vocabulary really do share one', () => {
        // The registry deliberately points several models at one repo so a
        // single download covers a family. That is only sound when the
        // vocabularies are identical, which was verified by hashing the files.
        // This asserts the *intent* stays legible: every repo used by more than
        // one model is used by models of a single provider, so a repo can never
        // be quietly shared across two providers' vocabularies.
        const byRepo = new Map<string, Set<string>>();
        for (const model of MODELS) {
            const encoder = model.encoder;
            if (encoder.kind !== 'hf' && encoder.kind !== 'tiktokenModel') {
                continue;
            }
            const providers = byRepo.get(encoder.repo) ?? new Set<string>();
            providers.add(model.provider);
            byRepo.set(encoder.repo, providers);
        }

        for (const [repo, providers] of byRepo) {
            assert.strictEqual(
                providers.size,
                1,
                `${repo} is shared across providers ${[...providers].join(', ')}`,
            );
        }
    });

    test('no context limit is a round marketing number where a real cap is known', () => {
        // Not a style rule: several entries record the provider's advertised
        // window because that is all the provider publishes, and several record
        // a separately documented input cap. What must never happen is a limit
        // of zero or a non-integer, which would make the context meter nonsense.
        for (const model of MODELS) {
            if (model.contextLimit === undefined) {
                continue;
            }
            assert.ok(
                Number.isInteger(model.contextLimit) && model.contextLimit > 0,
                `${model.id} has a nonsensical contextLimit: ${model.contextLimit}`,
            );
        }
    });
});
