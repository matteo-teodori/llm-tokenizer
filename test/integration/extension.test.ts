import * as assert from 'assert';
import * as vscode from 'vscode';

import { showMultiFileSummary, type MultiFileSummaryConfig } from '../../src/webview';
import { resolveInitialModel, settingsChangeEffects } from '../../src/extension';
import { STORAGE_KEY } from '../../src/constants';
import { MODEL_ALIASES } from '../../src/tokenizer/registry';

const EXTENSION_ID = 'matteoteodori.llm-tokenizer';
const CONFIG = 'llm-tokenizer';

/**
 * A log channel that only records. VS Code hands back the existing channel for
 * a name, and a real one disposed before it has finished opening, as a
 * synchronous test does, stays registered but closed: every later channel of
 * that name throws "Channel has been closed", failing whatever suite runs next.
 */
function recordingChannel(lines: string[] = []): vscode.LogOutputChannel {
    const record = (message: string): void => {
        lines.push(message);
    };
    return { trace: record, debug: record, info: record, warn: record, error: record } as unknown as vscode.LogOutputChannel;
}

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
        const channel = recordingChannel();

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
        }
    });

    test('a change of case alone migrates a saved choice without a notice', () => {
        // MiniMax's ids were re-cased in 2.1.2 to the form its API documents.
        // The model is the same, so telling the user it is "no longer
        // available" and switching them to it would be false.
        const writes: [string, unknown][] = [];
        const notices: string[] = [];
        const context = (saved: string): vscode.ExtensionContext =>
            ({
                globalState: {
                    get: (key: string) => (key === STORAGE_KEY ? saved : undefined),
                    update: (key: string, value: unknown) => {
                        writes.push([key, value]);
                        return Promise.resolve();
                    },
                },
            } as unknown as vscode.ExtensionContext);
        const notify = (message: string) => notices.push(message);
        const logged: string[] = [];
        const channel = recordingChannel(logged);

        const aliases = Object.entries(MODEL_ALIASES);
        const recased = aliases.find(([from, to]) => from.toLowerCase() === to.toLowerCase());
        const replaced = aliases.find(([from, to]) => from.toLowerCase() !== to.toLowerCase());
        assert.ok(recased && replaced, 'the registry should carry both kinds of alias to test with');

        assert.strictEqual(resolveInitialModel(context(recased[0]), channel, notify).id, recased[1]);
        assert.deepStrictEqual(writes, [[STORAGE_KEY, recased[1]]]);
        assert.strictEqual(notices.length, 0, `a re-cased id notified: ${JSON.stringify(notices)}`);
        assert.ok(logged.some(line => line.includes(`"${recased[0]}" is now "${recased[1]}"`)), logged.join('\n'));

        // A model that really was replaced still says so.
        resolveInitialModel(context(replaced[0]), channel, notify);
        assert.strictEqual(notices.length, 1, `expected one notice, got ${JSON.stringify(notices)}`);
        assert.ok(notices[0].includes(`"${replaced[0]}" is no longer available`), notices[0]);
    });

    test('only a setting that changes a count or the display rescans the workspace', () => {
        // Every llm-tokenizer.* change rescanned the whole workspace, a toggle
        // of downloadTokenizers included, which changes neither; turning it on
        // instead waited for a reload to start the download.
        const changed = (...keys: string[]) => ({
            affectsConfiguration: (section: string) =>
                keys.some(key => key === section || key.startsWith(`${section}.`)),
        });

        assert.deepStrictEqual(settingsChangeEffects(changed(`${CONFIG}.downloadTokenizers`)), {
            rescan: false,
            download: true,
        });
        for (const key of ['ignoreGitignoredFiles', 'defaultModel', 'statusBarDisplay', 'enableProjectScan']) {
            assert.deepStrictEqual(
                settingsChangeEffects(changed(`${CONFIG}.${key}`)),
                { rescan: true, download: false },
                key,
            );
        }
        assert.deepStrictEqual(settingsChangeEffects(changed('editor.fontSize')), {
            rescan: false,
            download: false,
        });

        // A setting added later must be given an effect here too, or changing
        // it would do nothing until the window reloads.
        const manifest = vscode.extensions.getExtension(EXTENSION_ID)?.packageJSON as {
            contributes: { configuration: { properties: Record<string, unknown> } };
        };
        for (const key of Object.keys(manifest.contributes.configuration.properties)) {
            const effects = settingsChangeEffects(changed(key));
            assert.ok(effects.rescan || effects.download, `changing ${key} has no effect`);
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
        // The list used to be written out here by hand, so a command added to
        // the manifest and never registered would still have passed: the class
        // of bug that blocked 2.1.0, with manifest and code disagreeing and
        // nothing to catch it. The manifest is now the list.
        const manifest = vscode.extensions.getExtension(EXTENSION_ID)?.packageJSON as {
            contributes: { commands: { command: string }[] };
        };
        const contributed = manifest.contributes.commands.map(c => c.command);
        assert.ok(contributed.length > 0, 'the manifest contributes no commands');

        const registered = new Set(await vscode.commands.getCommands(true));
        for (const command of contributed) {
            assert.ok(registered.has(command), `${command} is contributed but not registered`);
        }
    });

    test('every contributed setting is readable with its declared type', () => {
        // `llm-tokenizer.defaultModel` was contributed, documented, and offered
        // 69 values in the settings UI while no code ever read it. This asserts
        // that each setting the manifest declares resolves to its type, and to
        // one of its values where it has an enum.
        const manifest = vscode.extensions.getExtension(EXTENSION_ID)?.packageJSON as {
            contributes: {
                configuration: { properties: Record<string, { type: string; enum?: unknown[] }> };
            };
        };
        const properties = Object.entries(manifest.contributes.configuration.properties);
        assert.ok(properties.length > 0, 'the manifest contributes no settings');

        const config = vscode.workspace.getConfiguration(CONFIG);
        for (const [key, schema] of properties) {
            assert.ok(key.startsWith(`${CONFIG}.`), `${key} is outside the ${CONFIG} section`);
            const value = config.get<unknown>(key.slice(CONFIG.length + 1));
            const expected = { integer: 'number', array: 'object' }[schema.type] ?? schema.type;
            assert.strictEqual(typeof value, expected, `${key} does not resolve to a ${schema.type}`);
            if (schema.enum) {
                assert.ok(schema.enum.includes(value), `${key} resolves to ${String(value)}, outside its enum`);
            }
        }
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
                    properties: Record<
                        string,
                        { enum?: string[]; enumItemLabels?: string[]; enumDescriptions?: string[] }
                    >;
                };
            };
        };

        const setting = manifest.contributes.configuration.properties[`${CONFIG}.defaultModel`];
        assert.deepStrictEqual(setting.enum, MODELS.map(m => m.id));
        assert.deepStrictEqual(setting.enumItemLabels, MODELS.map(m => m.label));

        // enumDescriptions was the one array nothing compared, and it is the one
        // that carries the accuracy claim — the sentence telling a user whether
        // a model is counted exactly or estimated. A registry entry could change
        // encoder kind and the dropdown would keep making the old promise.
        const { accuracyOf } = await import('../../src/tokenizer/encoders');
        const wording = {
            exact: 'exact',
            'after-download': 'exact once the tokenizer is downloaded',
            estimated: 'estimated — no public tokenizer',
        } as const;

        assert.strictEqual(setting.enumDescriptions?.length, MODELS.length);
        MODELS.forEach((model, index) => {
            const description = setting.enumDescriptions?.[index] ?? '';
            assert.ok(
                description.startsWith(`${model.provider} · `),
                `${model.id}: "${description}" does not name its provider`,
            );
            assert.ok(
                description.endsWith(` · ${wording[accuracyOf(model.encoder)]}`),
                `${model.id}: "${description}" does not match its encoder's accuracy`,
            );
        });
    });

    test('the manifest default and defaultModel() are the same model', async () => {
        // These were independent: MODELS[0] on one side, a hand-edited manifest
        // value on the other, corrected only when it named a model that had been
        // removed. They could therefore point at two different models with
        // nothing failing — and after GPT-6 Astra was added at the top of the
        // registry, MODELS[0] stopped being the right default at all.
        const { defaultModel } = await import('../../src/tokenizer/registry');
        const manifest = vscode.extensions.getExtension(EXTENSION_ID)?.packageJSON as {
            contributes: {
                configuration: { properties: Record<string, { default?: string }> };
            };
        };

        const setting = manifest.contributes.configuration.properties[`${CONFIG}.defaultModel`];
        assert.strictEqual(setting.default, defaultModel().id);
    });

    test('outermost workspace roots cover every file exactly once', async () => {
        // The nested-root fix shipped in 2.1.0 lived inside refreshProjectCount,
        // which no test reached: reverting it left all 150 tests green while
        // every file under a nested root was counted twice in the workspace
        // total, colouring the badge against a limit the project had not hit.
        const { outermostFolders } = await import('../../src/extension');
        const folder = (p: string, index: number): vscode.WorkspaceFolder => ({
            uri: vscode.Uri.file(p),
            name: p,
            index,
        });

        const names = (folders: readonly vscode.WorkspaceFolder[]): string[] =>
            outermostFolders(folders).map(f => f.uri.path);

        // A nested root is dropped; its files are covered by the outer walk.
        assert.deepStrictEqual(
            names([folder('/repo', 0), folder('/repo/packages/web', 1), folder('/other', 2)]),
            ['/repo', '/other'],
        );
        // The same URI twice contributes one root, not two.
        assert.deepStrictEqual(names([folder('/repo', 0), folder('/repo', 1)]), ['/repo']);
        // A shared prefix is not containment: /repo/src does not contain /repo/src-gen.
        assert.deepStrictEqual(
            names([folder('/repo/src', 0), folder('/repo/src-gen', 1)]),
            ['/repo/src', '/repo/src-gen'],
        );
        // Order of declaration does not matter.
        assert.deepStrictEqual(
            names([folder('/repo/packages/web', 0), folder('/repo', 1)]),
            ['/repo'],
        );
        assert.deepStrictEqual(names([]), []);
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
