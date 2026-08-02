import * as assert from 'assert';
import * as vscode from 'vscode';

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

    test('a walk of the fixture workspace counts exactly the right files', async () => {
        // The fixture is built to be awkward on purpose: a node_modules tree, a
        // directory excluded by the fixture's own .gitignore, a file excluded
        // by a glob, and a file containing NUL bytes.
        const folder = vscode.workspace.workspaceFolders?.[0];
        assert.ok(folder);

        const { FolderContext, shouldCount, shouldDescend, isDirectory, isFile, looksBinary } =
            await import('../../src/scan');
        const context = await FolderContext.create(folder, true);

        const counted: string[] = [];
        const excluded: string[] = [];

        const walk = async (dir: vscode.Uri, prefix: string): Promise<void> => {
            for (const [name, type] of await vscode.workspace.fs.readDirectory(dir)) {
                const child = vscode.Uri.joinPath(dir, name);
                const label = prefix ? `${prefix}/${name}` : name;

                if (isDirectory(type)) {
                    if (shouldDescend(name, child, context)) {
                        await walk(child, label);
                    } else {
                        excluded.push(`${label}/`);
                    }
                    continue;
                }
                if (!isFile(type)) {
                    continue;
                }

                const size = (await vscode.workspace.fs.stat(child)).size;
                if (shouldCount(child, size, context)) {
                    excluded.push(label);
                } else if (looksBinary(await vscode.workspace.fs.readFile(child))) {
                    excluded.push(label);
                } else {
                    counted.push(label);
                }
            }
        };

        await walk(folder.uri, '');

        assert.deepStrictEqual(
            counted.sort(),
            ['.gitignore', 'README.md', 'src/a.txt', 'src/b.ts'],
            'unexpected set of counted files',
        );

        for (const expected of ['node_modules/', 'vendor/', 'scratch.tmp', 'src/blob.png']) {
            assert.ok(
                excluded.some(e => e === expected),
                `${expected} should have been excluded, got: ${excluded.sort().join(', ')}`,
            );
        }
    });
});
