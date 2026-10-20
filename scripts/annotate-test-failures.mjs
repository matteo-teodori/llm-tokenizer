/**
 * Names each failing test of a suite run as a GitHub annotation, which anyone
 * can read on the run's page or through the API, where its log needs a token.
 *
 *   node scripts/annotate-test-failures.mjs test-output.log
 *
 * For CI, after a test step that failed: it reads mocha's failure summary from
 * the step's saved output and prints one `::error::` per failure, ten at most,
 * as GitHub keeps no more for a step.
 */

import { readFileSync } from 'node:fs';

const MAX_ANNOTATIONS = 10;
const LINES_PER_FAILURE = 40;

const text = readFileSync(process.argv[2], 'utf8')
    // The colours mocha writes.
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\r/g, '');
// Workflow commands take their message on one line.
const escape = s => s.replace(/%/g, '%25').replace(/\n/g, '%0A');

const start = text.search(/^\s*\d+ failing/m);
if (start < 0) {
    console.log('::error title=Tests::the run failed before mocha reported its failures; the log says why');
    process.exit(0);
}
// "  1) suite\n       test:\n     Error: ...", up to the next "  2) ".
const failures = text.slice(start).split(/^ {2}\d+\) /m).slice(1);
for (const [i, failure] of failures.slice(0, MAX_ANNOTATIONS).entries()) {
    const shown = failure.split('\n').slice(0, LINES_PER_FAILURE).join('\n').trimEnd();
    console.log(`::error title=Failing test ${i + 1} of ${failures.length}::${escape(shown)}`);
}
