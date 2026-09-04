/**
 * Audits the dependencies that are actually redistributed in the VSIX.
 *
 *   node scripts/audit-bundled.mjs
 *
 * `npm audit --omit=dev` audits nothing here: every dependency is a
 * devDependency, because the three libraries that ship — gpt-tokenizer,
 * @huggingface/tokenizers and ignore — are inlined into out/*.js by esbuild
 * rather than installed alongside the extension. So the production tree is
 * empty and that gate could only ever report zero, for precisely the code it
 * exists to protect.
 *
 * Auditing the whole tree is the opposite failure: it fails a release because
 * the test runner's diff library has a denial-of-service advisory, or because
 * the packaging tool's URL parser does. Neither is in the VSIX, and neither is
 * within this project's power to fix — @vscode/test-cli pins its own mocha, so
 * upgrading mocha adds a second copy rather than removing the first.
 *
 * This gates on the shipped closure and reports the rest without failing.
 */

import { execFileSync } from 'node:child_process';
import { bundledPackages, dependencyClosure } from './bundled-packages.mjs';

const root = new URL('..', import.meta.url);

const shipped = dependencyClosure(root, await bundledPackages(root));

// `npm audit` exits non-zero whenever anything is found, so the exit code is
// not the signal here — the report is.
let report;
try {
    report = execFileSync('npm', ['audit', '--json'], {
        cwd: new URL('.', root).pathname,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
    });
} catch (error) {
    report = error.stdout;
}

let vulnerabilities;
try {
    ({ vulnerabilities } = JSON.parse(report));
} catch {
    console.error('Could not parse `npm audit --json`. Raw output:');
    console.error(String(report).slice(0, 2000));
    process.exit(1);
}

const RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
const FAIL_AT = RANK.high;

const entries = Object.values(vulnerabilities ?? {});
const inShipped = entries.filter(v => shipped.has(v.name));
const elsewhere = entries.filter(v => !shipped.has(v.name));

console.log(`Shipped packages: ${[...shipped].sort().join(', ')}`);

if (elsewhere.length > 0) {
    console.log(`\n${elsewhere.length} advisor${elsewhere.length === 1 ? 'y' : 'ies'} in build and test tooling (not shipped):`);
    for (const v of elsewhere.sort((a, b) => RANK[b.severity] - RANK[a.severity])) {
        console.log(`  ${v.severity.padEnd(8)} ${v.name}`);
    }
}

const blocking = inShipped.filter(v => RANK[v.severity] >= FAIL_AT);

if (inShipped.length === 0) {
    console.log('\nNo advisories against the code that ships.');
    process.exit(0);
}

console.log(`\n${inShipped.length} advisor${inShipped.length === 1 ? 'y' : 'ies'} against SHIPPED code:`);
for (const v of inShipped) {
    console.log(`  ${v.severity.padEnd(8)} ${v.name}  ${v.range ?? ''}`);
}

if (blocking.length > 0) {
    console.error(`\n::error::${blocking.length} high or critical advisor${blocking.length === 1 ? 'y' : 'ies'} in code shipped to users.`);
    process.exit(1);
}
