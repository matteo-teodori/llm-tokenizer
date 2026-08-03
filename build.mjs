/**
 * Build script.
 *
 * Produces three kinds of output:
 *
 *   out/extension.js      the extension host entrypoint
 *   out/worker.js         the tokenizer worker thread
 *   out/encodings/*.js    one self-contained tiktoken encoding each
 *
 * The encodings are separate files on purpose. Each one builds its rank tables
 * at module load, so bundling all five into the worker would cost ~250 ms and
 * ~200 MB of heap at startup; loading only the active model's encoding costs
 * ~70 ms and ~30 MB. The worker requires them by path at runtime.
 *
 * Usage: node build.mjs [--watch] [--production]
 */

import * as esbuild from 'esbuild';
import { rmSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

// esbuild overwrites but never deletes. Without this, a production build after
// a development one leaves the development source maps behind, and they are
// then packaged — shipping the full TypeScript source inside the VSIX.
if (production) {
    rmSync('out', { recursive: true, force: true });
}

/**
 * tiktoken encodings we ship. Keep in sync with `TiktokenEncoding`.
 *
 * `p50k_base` and `r50k_base` are excluded: no model in the 2026 registry uses
 * them, and they would add ~400 KB gzipped to the VSIX for nothing.
 */
const ENCODINGS = ['o200k_harmony', 'o200k_base', 'cl100k_base'];

/** Reports build results in watch mode, where esbuild otherwise stays silent. */
const reportProblems = {
    name: 'report-problems',
    setup(build) {
        build.onEnd(result => {
            for (const { text, location } of result.errors) {
                console.error(`✘ ${location?.file ?? '?'}:${location?.line ?? '?'} ${text}`);
            }
            if (result.errors.length === 0) {
                console.log(`✓ built ${build.initialOptions.outfile ?? build.initialOptions.outdir}`);
            }
        });
    },
};

/** @type {import('esbuild').BuildOptions} */
const shared = {
    bundle: true,
    platform: 'node',
    format: 'cjs',
    // VS Code 1.104 ships Electron 34 / Node 20.
    target: 'node20',
    minify: production,
    sourcemap: production ? false : 'linked',
    logLevel: 'silent',
    plugins: [reportProblems],
};

const targets = [
    {
        ...shared,
        entryPoints: ['src/extension.ts'],
        outfile: 'out/extension.js',
        // Provided by the extension host at runtime, never bundled.
        external: ['vscode'],
    },
    {
        ...shared,
        entryPoints: ['src/worker.ts'],
        outfile: 'out/worker.js',
        external: ['vscode'],
    },
    {
        ...shared,
        entryPoints: Object.fromEntries(
            ENCODINGS.map(name => [name, `gpt-tokenizer/encoding/${name}`]),
        ),
        outdir: 'out/encodings',
        // Always minified: these are 1–2.6 MB of rank tables and are never
        // worth debugging.
        minify: true,
        sourcemap: false,
    },
    {
        // Plain-CommonJS view of the registry so scripts/sync-manifest.mjs can
        // read it without a TypeScript loader. Deliberately *not* under out/:
        // that directory holds exactly what ships, and nothing at runtime
        // imports this.
        ...shared,
        entryPoints: ['src/tokenizer/models.ts'],
        outfile: '.build/models-meta.cjs',
        minify: false,
        sourcemap: false,
    },
];

const contexts = await Promise.all(targets.map(t => esbuild.context(t)));

if (watch) {
    await Promise.all(contexts.map(c => c.watch()));
    console.log('watching…');
} else {
    await Promise.all(contexts.map(c => c.rebuild()));
    await Promise.all(contexts.map(c => c.dispose()));
}
