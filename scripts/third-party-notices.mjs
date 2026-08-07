/**
 * Generates THIRD-PARTY-NOTICES.md from what esbuild actually inlines.
 *
 * The VSIX ships no node_modules: build.mjs bundles every dependency straight
 * into out/*.js, and minification drops the upstream comments along the way.
 * The result is a redistributed artifact containing Apache-2.0 and MIT code
 * with none of the attribution those licences require, so the notices have to
 * be reproduced somewhere — this file.
 *
 *   node scripts/third-party-notices.mjs           rewrite the notices
 *   node scripts/third-party-notices.mjs --check   fail if out of date (CI)
 *
 * The package list is derived from esbuild metafiles rather than from
 * package.json, so a dependency that stops being bundled drops out and a new
 * one cannot be forgotten. Run `npm run build` first — the entry points are
 * read from source, but the encodings list comes from the built output.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import * as esbuild from 'esbuild';

const check = process.argv.includes('--check');
const root = new URL('..', import.meta.url);
const noticesPath = new URL('THIRD-PARTY-NOTICES.md', root);

// The same three bundles build.mjs produces. Only one encoding is scanned:
// they are all entry points into the same package.
const BUNDLES = [
    { entryPoints: ['src/extension.ts'], external: ['vscode'] },
    { entryPoints: ['src/worker.ts'], external: ['vscode'] },
    { entryPoints: ['gpt-tokenizer/encoding/o200k_base'], external: [] },
];

const bundled = new Set();

for (const { entryPoints, external } of BUNDLES) {
    const result = await esbuild.build({
        entryPoints,
        external,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node20',
        write: false,
        metafile: true,
        logLevel: 'silent',
        absWorkingDir: new URL('.', root).pathname,
    });

    for (const input of Object.keys(result.metafile.inputs)) {
        const at = input.lastIndexOf('node_modules/');
        if (at < 0) {
            continue;
        }
        const parts = input.slice(at + 'node_modules/'.length).split('/');
        bundled.add(parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]);
    }
}

if (bundled.size === 0) {
    console.error('No bundled dependencies found — the metafile scan is broken.');
    process.exit(1);
}

const sections = [...bundled].sort().map(name => {
    const dir = new URL(`node_modules/${name}/`, root);
    const manifest = JSON.parse(readFileSync(new URL('package.json', dir), 'utf8'));

    const licenceFile = readdirSync(dir).find(f => /^(LICEN[CS]E|COPYING)/i.test(f));
    if (!licenceFile) {
        console.error(`${name} ships no licence file; its terms cannot be reproduced.`);
        process.exit(1);
    }

    const text = readFileSync(new URL(licenceFile, dir), 'utf8').trim();
    const homepage = manifest.homepage ?? `https://www.npmjs.com/package/${name}`;

    return [
        `## ${name} ${manifest.version}`,
        '',
        `${manifest.license} · ${homepage}`,
        '',
        '```',
        text,
        '```',
    ].join('\n');
});

const updated = `${[
    '# Third-party notices',
    '',
    'The extension is shipped as a bundle: every dependency is compiled into',
    '`out/*.js` and no `node_modules` directory is packaged. The licences of the',
    'code compiled in are reproduced in full below. The extension itself is MIT;',
    'see LICENSE.',
    '',
    'This file is generated — run `npm run notices` after changing dependencies.',
    '',
    ...sections,
].join('\n')}\n`;

if (check) {
    const current = existsSync(noticesPath) ? readFileSync(noticesPath, 'utf8') : '';
    if (current !== updated) {
        console.error('THIRD-PARTY-NOTICES.md is out of date.');
        console.error('Run `npm run notices` and commit the result.');
        process.exit(1);
    }
    console.log(`Third-party notices are up to date (${bundled.size} bundled packages).`);
} else {
    writeFileSync(noticesPath, updated);
    console.log(`Wrote notices for ${bundled.size} bundled packages: ${[...bundled].sort().join(', ')}.`);
}
