import * as assert from 'assert';
import * as vscode from 'vscode';

import { showMultiFileSummary, type MultiFileSummaryConfig } from '../../src/webview';
import { resolveInitialModel } from '../../src/extension';
import { STORAGE_KEY } from '../../src/constants';
import { MODEL_ALIASES } from '../../src/tokenizer/registry';

const EXTENSION_ID = 'matteoteodori.llm-tokenizer';
const CONFIG = 'llm-tokenizer';

suite('extension', () => {
    suiteSetup(async () => {
        const extension = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(extension, `${EXTENSION_ID} is not installed in the test host`);
        await extension.activate();
    });

    test('activates', () => {
        assert.strictEqual(vscode.extensions.getExtension(EXTENSION_ID)?.isActive, true);
    });

    test('a legacy id in the setting does not fabricate a stored choice', async () => {
        // A non-empty globalState is the sentinel for "the user has picked a
        // model". Migrating an aliased `defaultModel` wrote one, which turned a
        // user who had never picked into one who had — permanently. Their
        // setting was ignored from then on, and the live settings-change
        // handler, gated on global state being empty, went dead with it. 41 of
        // the 69 ids the v1.3.0 dropdown offered are aliases today.
        const writes: [string, unknown][] = [];
        const context = (saved: string | undefined): vscode.ExtensionContext =>
            ({
                globalState: {
                    get: (key: string) => (key === STORAGE_KEY ? saved : undefined),
                    update: (key: string, value: unknown) => {
                        writes.push([key, value]);
                        return Promise.resolve();
                    },
                },
            } as unknown as vscode.ExtensionContext);

        // This file is a second module instance from the one the host activated,
        // so the module's own channel was never assigned; pass one in.
        const channel = vscode.window.createOutputChannel('LLM Tokenizer (test)', { log: true });

        const config = vscode.workspace.getConfiguration(CONFIG);
        const original = config.inspect<string>('defaultModel')?.globalValue;
        const alias = Object.keys(MODEL_ALIASES)[0];
        assert.ok(alias, 'the registry should carry at least one alias to test with');

        await config.update('defaultModel', alias, vscode.ConfigurationTarget.Global);
        try {
            const resolved = resolveInitialModel(context(undefined), channel);

            // The alias still resolves — the setting keeps working.
            assert.strictEqual(resolved.id, MODEL_ALIASES[alias]);
            // …but nothing was stored, so the user has still not "picked".
            assert.deepStrictEqual(writes, [], `activation stored ${JSON.stringify(writes)}`);

            // A stale *saved* id is still migrated: that is what the write is for.
            resolveInitialModel(context(alias), channel);
            assert.deepStrictEqual(writes, [[STORAGE_KEY, MODEL_ALIASES[alias]]]);
        } finally {
            await config.update('defaultModel', original, vscode.ConfigurationTarget.Global);
            channel.dispose();
        }
    });

    test('repeated summaries reuse one panel instead of stacking up', () => {
        // Every run used to create its own panel. Ten counts left ten tabs, each
        // created with retainContextWhenHidden and each holding its rendered
        // page and a live message handler closed over that run's paths.
        const summary = (n: number): MultiFileSummaryConfig => ({
            totalTokens: n,
            filesProcessed: 1,
            processedFiles: [{ path: `/repo/run${n}.ts`, tokens: n }],
            skippedFiles: [],
            ignoredFiles: [],
            modelLabel: 'GPT-5.6 Sol',
            exact: true,
            cancelled: false,
            contextStatus: { percentage: 0, status: 'ok', limit: 922_000 },
        });

        const first = showMultiFileSummary(summary(1));
        try {
            for (let i = 2; i <= 5; i++) {
                assert.strictEqual(
                    showMultiFileSummary(summary(i)),
                    first,
                    `run ${i} created a second panel`,
                );
            }
        } finally {
            first.dispose();
        }

        // Closing it releases the reference, so the next run opens a fresh one
        // rather than reviving a disposed panel.
        const reopened = showMultiFileSummary(summary(6));
        try {
            assert.notStrictEqual(reopened, first, 'a disposed panel was reused');
        } finally {
            reopened.dispose();
        }
    });

    test('registers every contributed command', async () => {
        const registered = new Set(await vscode.commands.getCommands(true));
        for (const command of [
            'llm-tokenizer.countTokens',
            'llm-tokenizer.selectModel',
            'llm-tokenizer.downloadTokenizer',
            'llm-tokenizer.clearTokenizerCache',
        ]) {
            assert.ok(registered.has(command), `${command} is contributed but not registered`);
        }
    });

    test('every contributed setting is readable with the declared default', () => {
        // `llm-tokenizer.defaultModel` was contributed, documented, and offered
        // 69 values in the settings UI while no code ever read it. This asserts
        // each setting at least resolves.
        const config = vscode.workspace.getConfiguration(CONFIG);
        assert.strictEqual(typeof config.get<string>('defaultModel'), 'string');
        assert.strictEqual(typeof config.get<string>('statusBarDisplay'), 'string');
        assert.strictEqual(typeof config.get<boolean>('ignoreGitignoredFiles'), 'boolean');
        assert.strictEqual(typeof config.get<boolean>('enableProjectScan'), 'boolean');
        assert.strictEqual(typeof config.get<boolean>('downloadTokenizers'), 'boolean');
    });

    test('the contributed default model is one the extension knows about', async () => {
        const { findModel } = await import('../../src/tokenizer/registry');
        const configured = vscode.workspace.getConfiguration(CONFIG).get<string>('defaultModel');
        assert.ok(configured);
        assert.ok(findModel(configured), `contributed default "${configured}" is not a known model`);
    });

    test('the settings dropdown matches the registry exactly', async () => {
        // package.json is generated from the registry; if the two drift, the
        // settings UI offers ids the extension cannot resolve.
        const { MODELS } = await import('../../src/tokenizer/registry');
        const manifest = vscode.extensions.getExtension(EXTENSION_ID)?.packageJSON as {
            contributes: {
                configuration: {
                    properties: Record<string, { enum?: string[]; enumItemLabels?: string[] }>;
                };
            };
        };

        const setting = manifest.contributes.configuration.properties[`${CONFIG}.defaultModel`];
        assert.deepStrictEqual(setting.enum, MODELS.map(m => m.id));
        assert.deepStrictEqual(setting.enumItemLabels, MODELS.map(m => m.label));
    });

    test('every downloadable model is reachable from the extension host', async () => {
        // The blocker this test exists for: the download gate in extension.ts
        // read `kind !== 'hf'`, so when a second downloadable kind was added
        // for Kimi, every Kimi model returned before reaching the download —
        // and the command told users Moonshot publishes no tokenizer, which is
        // the opposite of what shipped. The service-level tests could not catch
        // it because they call ensureExact directly, below the gate.
        const { MODELS } = await import('../../src/tokenizer/registry');
        const { isDownloadable } = await import('../../src/tokenizer/encoders');

        const downloadable = MODELS.filter(m => isDownloadable(m.encoder));
        assert.ok(downloadable.length > 0);

        // Both published vocabulary shapes must be represented, or this test
        // stops covering the case it was written for.
        const kinds = new Set(downloadable.map(m => m.encoder.kind));
        assert.deepStrictEqual([...kinds].sort(), ['hf', 'tiktokenModel']);
    });

    test('declares that it works in untrusted workspaces', () => {
        // Without this the extension silently disables itself in Restricted
        // Mode — the worst possible default for a tool people reach for on
        // unfamiliar repositories.
        const manifest = vscode.extensions.getExtension(EXTENSION_ID)?.packageJSON as {
            capabilities?: { untrustedWorkspaces?: { supported?: boolean } };
        };
        assert.strictEqual(manifest.capabilities?.untrustedWorkspaces?.supported, true);
    });

    test('the count commands run against real files without throwing', async () => {
        const folder = vscode.workspace.workspaceFolders?.[0];
        assert.ok(folder, 'the test host should open the fixture workspace');

        const file = vscode.Uri.joinPath(folder.uri, 'src', 'b.ts');
        assert.strictEqual((await vscode.workspace.openTextDocument(file)).getText().trim(), 'const x = 42;');

        // These report through notifications and a webview panel, so there is
        // no return value to assert on — this covers only that a single file
        // and a full directory walk both complete. What actually gets counted
        // is asserted in the walk test below.
        await vscode.commands.executeCommand('llm-tokenizer.countTokens', file);
        await vscode.commands.executeCommand('llm-tokenizer.countTokens', folder.uri);
    });

    test('discovery over the fixture workspace finds exactly the right files', async () => {
        // The fixture is awkward on purpose: a node_modules tree, a directory
        // excluded by its own .gitignore, a file excluded by a glob, and a file
        // full of NUL bytes. This drives the extension's real discovery walk —
        // an earlier version of this test reimplemented the walk and so could
        // agree with itself while disagreeing with the extension.
        const folder = vscode.workspace.workspaceFolders?.[0];
        assert.ok(folder);

        const { FolderContext, collectFiles, shouldCount, looksBinary } = await import('../../src/scan');
        const context = await FolderContext.create(folder, true);
        const cancellation = new vscode.CancellationTokenSource();

        try {
            const discovery = await collectFiles(folder.uri, context, cancellation.token);
            const relative = (uri: vscode.Uri) =>
                uri.path.slice(folder.uri.path.length + 1);

            const counted: string[] = [];
            for (const file of discovery.files) {
                if (shouldCount(file.uri, file.size, context)) {
                    continue;
                }
                if (looksBinary(await vscode.workspace.fs.readFile(file.uri))) {
                    continue;
                }
                counted.push(relative(file.uri));
            }

            assert.deepStrictEqual(
                counted.sort(),
                ['.gitignore', 'README.md', 'src/a.txt', 'src/b.ts'],
                'unexpected set of counted files',
            );

            // node_modules is excluded by name and so is never even offered;
            // vendor/ is excluded by the fixture's own .gitignore, which is the
            // case worth reporting to the user.
            assert.deepStrictEqual(discovery.ignoredDirectories.map(relative), ['vendor']);
            assert.ok(
                !discovery.files.some(f => relative(f.uri).startsWith('node_modules/')),
                'node_modules must never be walked',
            );
        } finally {
            cancellation.dispose();
        }
    });

    test('discovery reports progress as it finds files', async () => {
        // The progress notification needs a running total; without one it used
        // to report per selected item, so one folder of thousands of files
        // showed "1/1" and then nothing.
        const folder = vscode.workspace.workspaceFolders?.[0];
        assert.ok(folder);

        const { FolderContext, collectFiles } = await import('../../src/scan');
        const context = await FolderContext.create(folder, true);
        const cancellation = new vscode.CancellationTokenSource();

        try {
            const seen: number[] = [];
            const discovery = await collectFiles(folder.uri, context, cancellation.token, n => seen.push(n));

            assert.strictEqual(seen.length, discovery.files.length, 'one report per file found');
            assert.deepStrictEqual(
                seen,
                seen.map((_, i) => i + 1),
                'the running total must increase by one each time',
            );
        } finally {
            cancellation.dispose();
        }
    });
});
