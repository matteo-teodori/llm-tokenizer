/**
 * The npm packages esbuild actually inlines into the VSIX.
 *
 * The VSIX ships no node_modules — build.mjs bundles the runtime dependencies
 * straight into out/*.js — so "what ships" is not the same set as "what is
 * installed", and it cannot be read off package.json: every dependency here is
 * a devDependency precisely because none of them are installed alongside the
 * extension. Deriving the list from esbuild's own metafile means a dependency
 * that stops being bundled drops out and a new one cannot be forgotten.
 *
 * Two consumers rely on this being the same list: the third-party notices,
 * which must attribute exactly what is redistributed, and the dependency audit,
 * which must gate on exactly what is redistributed.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

// The same three bundles build.mjs produces. Only one encoding is scanned:
// they are all entry points into the same package.
const BUNDLES = [
    { entryPoints: ['src/extension.ts'], external: ['vscode'] },
    { entryPoints: ['src/worker.ts'], external: ['vscode'] },
    { entryPoints: ['gpt-tokenizer/encoding/o200k_base'], external: [] },
];

/** Package names inlined into the shipped bundles. */
export async function bundledPackages(root) {
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
            absWorkingDir: fileURLToPath(root),
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
        throw new Error('No bundled dependencies found — the metafile scan is broken.');
    }

    return bundled;
}

/**
 * Every package reachable from `names`, including `names` themselves.
 *
 * The bundled packages are dependency-free today, so this closure is currently
 * just the three of them — but a dependency added upstream would be inlined
 * too, and would need auditing with them.
 */
export function dependencyClosure(root, names) {
    const seen = new Set();
    const queue = [...names];

    while (queue.length > 0) {
        const name = queue.pop();
        if (seen.has(name)) {
            continue;
        }
        seen.add(name);

        try {
            const manifest = JSON.parse(
                readFileSync(new URL(`node_modules/${name}/package.json`, root), 'utf8'),
            );
            queue.push(...Object.keys(manifest.dependencies ?? {}));
        } catch {
            // Not installed at the top level; npm audit will still name it if
            // it is vulnerable, and the caller reports what it could not read.
        }
    }

    return seen;
}
