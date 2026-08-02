/**
 * Test entry point for `--extensionTestsPath`.
 *
 * `npm test` goes through @vscode/test-cli and never touches this file. It
 * exists so the **Extension Tests** launch configuration works: that flag
 * requires a module exporting `run()`, and without one the debug host opens and
 * immediately errors. Having it means tests can be run with breakpoints from
 * the editor.
 *
 * Keep the Mocha options here in step with `.vscode-test.mjs`.
 */

import * as fs from 'fs';
import * as path from 'path';
import Mocha from 'mocha';

/** Compiled test files, relative to `root`. */
function findTests(root: string, prefix = ''): string[] {
    const found: string[] = [];

    for (const entry of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) {
        const relative = path.join(prefix, entry.name);
        if (entry.isDirectory()) {
            found.push(...findTests(root, relative));
        } else if (entry.name.endsWith('.test.js')) {
            found.push(relative);
        }
    }

    return found;
}

export function run(): Promise<void> {
    const mocha = new Mocha({
        ui: 'tdd',
        color: true,
        // Building a Hugging Face tokenizer can take a few seconds.
        timeout: 60_000,
    });

    const root = __dirname;
    for (const file of findTests(root)) {
        mocha.addFile(path.join(root, file));
    }

    return new Promise((resolve, reject) => {
        try {
            mocha.run(failures => {
                if (failures > 0) {
                    reject(new Error(`${failures} test${failures === 1 ? '' : 's'} failed`));
                } else {
                    resolve();
                }
            });
        } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
        }
    });
}
