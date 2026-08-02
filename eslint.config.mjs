// ESLint 10 flat config. Replaces the missing .eslintrc that made `npm run
// lint` fail outright on every run.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    { ignores: ['out/**', 'dist/**', 'node_modules/**', '.vscode-test/**'] },

    js.configs.recommended,

    {
        // Type-aware rules are scoped to the TypeScript sources. Applying them
        // globally makes ESLint try to type-check build.mjs, which is not in
        // the tsconfig, and every run dies on the first rule that needs types.
        files: ['src/**/*.ts'],
        extends: [tseslint.configs.recommendedTypeChecked],
        languageOptions: {
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            // The two that would have caught real bugs here: a floating
            // project-scan promise, and an `updateFileStatusBar` whose result
            // nobody awaited.
            '@typescript-eslint/no-floating-promises': 'error',
            '@typescript-eslint/no-misused-promises': 'error',

            // v1.3.0 destructured a `reject` it never called, which is how a
            // dead worker left every pending count hanging forever.
            '@typescript-eslint/no-unused-vars': [
                'error',
                { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
            ],

            eqeqeq: ['error', 'always', { null: 'ignore' }],
            curly: 'error',
            'no-console': 'error', // use the LogOutputChannel
        },
    },

    {
        // Build and tooling scripts: plain Node ESM, outside the TS project.
        files: ['*.mjs', 'scripts/**/*.mjs'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'module',
            globals: { console: 'readonly', process: 'readonly', URL: 'readonly' },
        },
        rules: { 'no-console': 'off' },
    },
);
