/**
 * Build script.
 *
 * Produces, as scripts/bundles.mjs lists:
 *
 *   out/extension.js      the extension host entrypoint
 *   out/usage.js          the Claude Code usage feature, loaded by the
 *                         extension only once the feature is on or one of
 *                         its commands runs
 *   out/worker.js         the tokenizer worker thread
 *   out/usageWorker.js    the usage worker thread
 *   out/encodings/*.js    one self-contained tiktoken encoding each
 *
 * The encodings are separate files on purpose. Each one builds its rank tables
 * at module load, so bundling all three into the worker would cost about
 * 120 ms and 34 MB of heap at startup, measured; loading only the active
 * model's encoding costs 25-60 ms and 9-16 MB. The worker requires them by path
 * at runtime.
 *
 * Usage: node build.mjs [--watch] [--production]
 */

import * as esbuild from 'esbuild';
import { rmSync } from 'node:fs';

import { SHIPPED_BUNDLES } from './scripts/bundles.mjs';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

// esbuild overwrites but never deletes. Without this, a production build after
// a development one leaves the development source maps behind, and they are
// then packaged — shipping the full TypeScript source inside the VSIX.
if (production) {
    rmSync('out', { recursive: true, force: true });
}

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
    // Deliberately conservative. The engines floor, VS Code 1.105, ships
    // Electron 37.6 / Node 22.19, and current builds Node 24.
    target: 'node20',
    minify: production,
    sourcemap: production ? false : 'linked',
    logLevel: 'silent',
    plugins: [reportProblems],
};

const targets = [
    // What ships, listed once in scripts/bundles.mjs so the notices and the
    // audit scan the same bundles this builds.
    ...SHIPPED_BUNDLES.map(bundle => ({ ...shared, ...bundle })),
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
