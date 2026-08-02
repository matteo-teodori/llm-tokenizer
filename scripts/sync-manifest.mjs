/**
 * Generates the model dropdown in package.json from the registry.
 *
 * v1.3.0 kept the model ids and labels in two places — `MODEL_REGISTRY` in the
 * source and `enum`/`enumItemLabels` in the manifest — and they drifted. This
 * makes the registry authoritative.
 *
 *   node scripts/sync-manifest.mjs           rewrite package.json
 *   node scripts/sync-manifest.mjs --check   fail if it is out of date (CI)
 *
 * The registry is read from the compiled output so this script does not need a
 * TypeScript loader; run `npm run compile` first.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const check = process.argv.includes('--check');

let MODELS;
let MODEL_ALIASES;
try {
    ({ MODELS, MODEL_ALIASES } = require('../.build/models-meta.cjs'));
} catch (error) {
    console.error('Could not load the compiled registry. Run `npm run compile` first.');
    console.error(error.message);
    process.exit(1);
}

// ── invariants worth failing the build over ──────────────────────────────────

const problems = [];
const ids = new Set();

for (const model of MODELS) {
    if (ids.has(model.id)) {
        problems.push(`duplicate model id: ${model.id}`);
    }
    ids.add(model.id);

    if (!model.label || !model.provider) {
        problems.push(`${model.id} is missing a label or provider`);
    }
    if (model.contextLimit !== undefined && !(model.contextLimit > 0)) {
        problems.push(`${model.id} has a nonsensical contextLimit: ${model.contextLimit}`);
    }
    if (model.encoder?.kind === 'hf' && !model.encoder.repo?.includes('/')) {
        problems.push(`${model.id} has an hf encoder without a valid repo`);
    }
}

for (const [from, to] of Object.entries(MODEL_ALIASES ?? {})) {
    if (!ids.has(to)) {
        problems.push(`alias ${from} -> ${to}, but ${to} is not a model`);
    }
    if (ids.has(from)) {
        problems.push(`alias ${from} shadows a live model id`);
    }
}

if (problems.length > 0) {
    console.error('Registry problems:');
    for (const problem of problems) {
        console.error(`  • ${problem}`);
    }
    process.exit(1);
}

// ── regenerate the manifest ──────────────────────────────────────────────────

const manifestPath = new URL('../package.json', import.meta.url);
const original = readFileSync(manifestPath, 'utf8');
const manifest = JSON.parse(original);

const setting = manifest.contributes.configuration.properties['llm-tokenizer.defaultModel'];
setting.enum = MODELS.map(m => m.id);
setting.enumItemLabels = MODELS.map(m => m.label);
setting.enumDescriptions = MODELS.map(m => {
    const limit = m.contextLimit ? `${(m.contextLimit / 1000).toLocaleString('en-US')}K context` : 'no published limit';
    const accuracy = {
        tiktoken: 'exact',
        hf: 'exact once the tokenizer is downloaded',
        heuristic: 'estimated — no public tokenizer',
    }[m.encoder.kind];
    return `${m.provider} · ${limit} · ${accuracy}`;
});

if (!setting.enum.includes(setting.default)) {
    setting.default = MODELS[0].id;
}

const updated = `${JSON.stringify(manifest, null, 2)}\n`;

if (check) {
    if (updated !== original) {
        console.error('package.json is out of sync with the model registry.');
        console.error('Run `npm run sync-manifest` and commit the result.');
        process.exit(1);
    }
    console.log(`package.json is in sync (${MODELS.length} models).`);
} else {
    writeFileSync(manifestPath, updated);
    console.log(`Synced ${MODELS.length} models into package.json.`);
}
