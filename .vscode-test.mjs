import { fileURLToPath } from 'node:url';
import { defineConfig } from '@vscode/test-cli';

/** An absolute path in this repository, wherever the runner was started. */
const here = relative => fileURLToPath(new URL(relative, import.meta.url));

/** One test run against the given VS Code, in a profile of its own. */
function run(label, version) {
    return {
        label,
        version,
        files: '.test-out/test/**/*.test.js',
        mocha: {
            ui: 'tdd',
            timeout: 60_000, // building a Hugging Face tokenizer can take a few seconds
            color: true,
        },
        // A deterministic, empty workspace: the discovery tests assert on exact
        // file sets, so they must not see whatever happens to be open.
        workspaceFolder: './test/fixtures/workspace',
        launchArgs: [
            '--disable-extensions',
            '--disable-gpu',
            // Otherwise the host resolves the login shell's environment, and that
            // overrides `env` below.
            '--force-disable-user-env',
            // A profile of its own rather than test-electron's shared default, and
            // one per run so neither sees the other's state. The path stays short,
            // so the IPC socket inside it fits macOS's 103-character limit.
            `--user-data-dir=${here(`.vscode-test/ud-${label}`)}`,
        ],
        env: {
            // A stand-in for ~/.claude, so that nothing a test runs can read the
            // developer's own Claude Code data.
            CLAUDE_CONFIG_DIR: here('test/fixtures/claude-config'),
        },
    };
}

export default defineConfig([
    // `npm test`.
    run('stable', 'stable'),
    // `npm run test:floor`: the oldest VS Code that package.json's engines
    // accepts, whose runtime (Electron 37.6, Node 22.19) is older than the one
    // the suite otherwise sees.
    run('floor', '1.105.0'),
]);
