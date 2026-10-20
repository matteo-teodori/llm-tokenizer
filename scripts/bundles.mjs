/**
 * The bundles that ship in the VSIX, in one place.
 *
 * build.mjs builds them, and scripts/bundled-packages.mjs scans them for the
 * npm packages they inline, which the third-party notices attribute and the
 * dependency audit gates on. With the list written out in both, a bundle added
 * to the build alone would ship packages that neither of them checks.
 *
 * Side-effect free on purpose, so anything can import it: importing build.mjs
 * runs a build, and a production one deletes out/ first.
 */

/**
 * tiktoken encodings we ship. Keep in sync with `TiktokenEncoding`.
 *
 * `p50k_base` and `r50k_base` are excluded: no model in the 2026 registry uses
 * them, and they would add ~400 KB gzipped to the VSIX for nothing.
 */
export const ENCODINGS = ['o200k_harmony', 'o200k_base', 'cl100k_base'];

/** esbuild options for each shipped bundle, before build.mjs's shared ones. */
export const SHIPPED_BUNDLES = [
    {
        entryPoints: ['src/extension.ts'],
        outfile: 'out/extension.js',
        // Provided by the extension host at runtime, never bundled.
        external: ['vscode'],
    },
    {
        entryPoints: ['src/worker.ts'],
        outfile: 'out/worker.js',
        external: ['vscode'],
    },
    {
        // The Claude Code usage feature, loaded only once it is on or one of
        // its commands runs: off, activation parses none of it.
        entryPoints: ['src/usage/usageService.ts'],
        outfile: 'out/usage.js',
        external: ['vscode'],
    },
    {
        // Built only from node: built-ins, so it inlines no package.
        // node:sqlite is required at run time, never bundled.
        entryPoints: ['src/usageWorker.ts'],
        outfile: 'out/usageWorker.js',
        external: ['vscode', 'node:sqlite'],
    },
    {
        entryPoints: Object.fromEntries(
            ENCODINGS.map(name => [name, `gpt-tokenizer/encoding/${name}`]),
        ),
        outdir: 'out/encodings',
        external: [],
        // Always minified: these are 1–2.6 MB of rank tables and are never
        // worth debugging.
        minify: true,
        sourcemap: false,
    },
];
