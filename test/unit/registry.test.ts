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

    test('OpenAI models are tokenized exactly, never estimated', () => {
        // tiktoken is OpenAI's own tokenizer; there is no reason to guess.
        for (const model of MODELS.filter(m => m.provider === 'OpenAI')) {
            assert.strictEqual(model.encoder.kind, 'tiktoken', `${model.id} should use tiktoken`);
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
