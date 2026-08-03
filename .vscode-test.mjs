import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
    files: '.test-out/test/**/*.test.js',
    version: 'stable',
    mocha: {
        ui: 'tdd',
        timeout: 60_000, // building a Hugging Face tokenizer can take a few seconds
        color: true,
    },
    // A deterministic, empty workspace: the project-scan tests assert on exact
    // totals, so they must not see whatever happens to be open.
    workspaceFolder: './test/fixtures/workspace',
    launchArgs: ['--disable-extensions', '--disable-gpu'],
});
