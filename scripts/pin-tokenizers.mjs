/**
 * Checks the commit and hash every downloadable vocabulary is pinned to, and
 * says where each repository's main branch has moved since.
 *
 *   npm run compile && node scripts/pin-tokenizers.mjs
 *   node scripts/pin-tokenizers.mjs owner/name [owner/name:tiktoken.model …]
 *
 * With repos named, it prints the pin each would take at its main branch, for
 * a model not in the registry yet. For a registry refresh, not for CI: it downloads every vocabulary the
 * registry names, 3–35 MB each, from huggingface.co. For each repository it
 * prints whether the pinned file is still the one the registry names, and,
 * when main has moved, whether the vocabulary there differs, with the pin it
 * would take: the commit, `keptSha256` (see `PinnedSource` in
 * src/tokenizer/encoders.ts), and the published file's own hash, which is
 * the one the notes in models.ts quote. Exits non-zero when a pinned file
 * does not match.
 */

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const HF = 'https://huggingface.co';
const sha256 = text => createHash('sha256').update(text).digest('hex');
const mainOf = async repo => (await (await fetch(`${HF}/api/models/${repo}/revision/main`)).json()).sha;

/** The file at `revision`, with both hashes. */
async function vocabulary(repo, kind, revision) {
    const file = kind === 'tiktokenModel' ? 'tiktoken.model' : 'tokenizer.json';
    const response = await fetch(`${HF}/${repo}/resolve/${revision}/${file}`);
    if (!response.ok) {
        throw new Error(`${file} at ${revision.slice(0, 12)}: HTTP ${response.status}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const text = bytes.toString('utf8');
    // As the store keeps it: tokenizer.json written out again once parsed.
    const kept = kind === 'tiktokenModel' ? text : JSON.stringify(JSON.parse(text));
    return { kept: sha256(kept), published: sha256(bytes) };
}

const named = process.argv.slice(2);
if (named.length > 0) {
    for (const spec of named) {
        const [repo, file] = spec.split(':');
        const kind = file === 'tiktoken.model' ? 'tiktokenModel' : 'hf';
        const main = await mainOf(repo);
        const pin = await vocabulary(repo, kind, main);
        console.log(`${repo}\n    revision: '${main}', keptSha256: '${pin.kept}' (published ${pin.published})`);
    }
    process.exit(0);
}

let MODELS;
try {
    ({ MODELS } = require('../.build/models-meta.cjs'));
} catch {
    console.error('Could not load the compiled registry. Run `npm run compile` first.');
    process.exit(1);
}

const sources = new Map();
for (const { encoder } of MODELS) {
    if (encoder.kind === 'hf' || encoder.kind === 'tiktokenModel') {
        sources.set(encoder.repo, encoder);
    }
}

let mismatches = 0;
for (const { repo, kind, revision, keptSha256 } of sources.values()) {
    try {
        const pinned = await vocabulary(repo, kind, revision);
        if (pinned.kept !== keptSha256) {
            mismatches++;
            console.log(`✗ ${repo}: the file at ${revision.slice(0, 12)} is not the one pinned`);
            continue;
        }
        const main = await mainOf(repo);
        if (main === revision) {
            console.log(`✓ ${repo}: pinned at main`);
            continue;
        }
        const now = await vocabulary(repo, kind, main);
        console.log(
            now.kept === keptSha256
                ? `✓ ${repo}: main has moved to ${main}, with the same vocabulary`
                : `• ${repo}: main has moved to ${main}, with another vocabulary\n    revision: '${main}', keptSha256: '${now.kept}' (published ${now.published})`,
        );
    } catch (error) {
        mismatches++;
        console.log(`✗ ${repo}: ${error instanceof Error ? error.message : String(error)}`);
    }
}
process.exit(mismatches === 0 ? 0 : 1);
