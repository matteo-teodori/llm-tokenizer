/**
 * Remove build output directories.
 *
 * A script file rather than `node -e "…"` inside package.json: npm runs scripts
 * through cmd.exe on Windows, where nested quoting is where portability breaks.
 * This has none.
 *
 *   node scripts/clean.mjs .test-out out
 */
import { rmSync } from 'node:fs';

for (const target of process.argv.slice(2)) {
    rmSync(target, { recursive: true, force: true });
}
