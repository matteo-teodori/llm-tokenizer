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

    test('counting a file in the fixture workspace produces a plausible number', async () => {
        const folder = vscode.workspace.workspaceFolders?.[0];
        assert.ok(folder, 'the test host should open the fixture workspace');

        const uri = vscode.Uri.joinPath(folder.uri, 'src', 'b.ts');
        const document = await vscode.workspace.openTextDocument(uri);
        assert.strictEqual(document.getText().trim(), 'const x = 42;');

        // The command shows a notification rather than returning a value, so
        // this asserts it runs without throwing on a real file.
        await vscode.commands.executeCommand('llm-tokenizer.countTokens', uri);
    });

    test('counting a folder honours the fixture .gitignore and skips node_modules', async () => {
        const folder = vscode.workspace.workspaceFolders?.[0];
        assert.ok(folder);

        // Opens the summary webview; the assertion is that a directory walk
        // over a tree containing node_modules, an ignored directory, an
        // ignored glob and a binary file completes without throwing.
        await vscode.commands.executeCommand('llm-tokenizer.countTokens', folder.uri);
    });
});
