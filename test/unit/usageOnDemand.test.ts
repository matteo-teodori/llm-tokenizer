import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { CLAUDE_CODE_INSTALLED, registerClaudeCodeUsage } from '../../src/usage/onDemand';
import type { UsageCommands, startClaudeCodeUsage } from '../../src/usage/usageService';

type Start = typeof startClaudeCodeUsage;

suite('usage, loaded on demand', () => {
    const commands = vscode.commands as unknown as Record<string, unknown>;
    const workspace = vscode.workspace as unknown as Record<string, unknown>;
    const window = vscode.window as unknown as Record<string, unknown>;
    const originals: Record<string, unknown> = {};
    let handlers: Map<string, () => unknown>;
    let listener: ((event: Pick<vscode.ConfigurationChangeEvent, 'affectsConfiguration'>) => void) | undefined;
    /** The feature's setting as settings.json holds it, of any type. */
    let enabled: unknown;
    /** Claude Code's VS Code extension, when installed and enabled. */
    let claudeCode: unknown;
    let extensionsChanged: vscode.EventEmitter<void>;
    /** Every setContext the registration ran. */
    let contexts: unknown[][];
    const calls = { loads: 0, starts: 0, show: 0, settingsChanged: 0 };
    /** Loads that fail before one works, as a broken install's would. */
    let failingLoads: number;
    let errors: string[];
    let shownErrors: string[];

    /** The bundle as the loader sees it: counted, and doing nothing. */
    const load = (): Start => {
        calls.loads++;
        if (failingLoads > 0) {
            failingLoads--;
            throw new Error("Cannot find module '/ext/out/usage.js'");
        }
        return (): UsageCommands => {
            calls.starts++;
            return {
                show: () => void calls.show++,
                refresh: () => Promise.resolve(),
                clear: () => Promise.resolve(),
                settingsChanged: () => void calls.settingsChanged++,
            };
        };
    };

    /** A settings change, of the feature's settings or of another. */
    const change = (key: string) => listener?.({ affectsConfiguration: section => section === key });

    const register = () =>
        registerClaudeCodeUsage(
            { subscriptions: [] } as unknown as vscode.ExtensionContext,
            { error: (message: string) => void errors.push(message) } as unknown as vscode.LogOutputChannel,
            Promise.resolve(),
            load,
            {
                getExtension: (id: string) => (id === 'anthropic.claude-code' ? claudeCode : undefined),
                onDidChange: extensionsChanged.event,
            } as unknown as typeof vscode.extensions,
        );

    setup(() => {
        for (const key of Object.keys(calls) as (keyof typeof calls)[]) {
            calls[key] = 0;
        }
        handlers = new Map();
        listener = undefined;
        enabled = false;
        claudeCode = undefined;
        // A registration of an earlier test would answer as well.
        extensionsChanged = new vscode.EventEmitter<void>();
        contexts = [];
        failingLoads = 0;
        errors = [];
        shownErrors = [];
        originals.executeCommand = commands.executeCommand;
        commands.executeCommand = (...args: unknown[]) => (contexts.push(args), Promise.resolve(undefined));
        originals.showErrorMessage = window.showErrorMessage;
        window.showErrorMessage = (message: string) => (shownErrors.push(message), Promise.resolve(undefined));
        originals.registerCommand = commands.registerCommand;
        originals.onDidChangeConfiguration = workspace.onDidChangeConfiguration;
        originals.getConfiguration = workspace.getConfiguration;
        // This extension's own commands are registered already: the fakes stand in.
        commands.registerCommand = (id: string, handler: () => unknown) => (handlers.set(id, handler), new vscode.Disposable(() => undefined));
        workspace.onDidChangeConfiguration = (fn: typeof listener) => ((listener = fn), new vscode.Disposable(() => undefined));
        workspace.getConfiguration = () => ({ get: <T>(_key: string, fallback?: T) => (enabled as T) ?? fallback });
    });

    teardown(() => {
        commands.executeCommand = originals.executeCommand;
        window.showErrorMessage = originals.showErrorMessage;
        commands.registerCommand = originals.registerCommand;
        workspace.onDidChangeConfiguration = originals.onDidChangeConfiguration;
        workspace.getConfiguration = originals.getConfiguration;
    });

    test('off, nothing of the feature is loaded, whatever setting changes, until a command runs', () => {
        register();
        change('editor.fontSize');
        change('llm-tokenizer.claudeCodeDataDirectory');
        assert.deepStrictEqual([calls.loads, [...handlers.keys()].length], [0, 3]);
        handlers.get('llm-tokenizer.showClaudeCodeUsage')?.();
        handlers.get('llm-tokenizer.showClaudeCodeUsage')?.();
        assert.deepStrictEqual([calls.loads, calls.starts, calls.show], [1, 1, 2]);
    });

    test('on at activation, it is loaded at once', () => {
        enabled = true;
        register();
        assert.deepStrictEqual([calls.loads, calls.starts], [1, 1]);
    });

    test('only true turns it on: a setting written as "false", or as 1, loads nothing', () => {
        // T-4: VS Code's get() checks no type, and "false" is truthy.
        for (const value of ['false', 1, 'true']) {
            enabled = value;
            register();
            change('llm-tokenizer.enableClaudeCodeUsage');
        }
        assert.strictEqual(calls.loads, 0);
    });

    test("the T shows for whoever has Claude Code's extension, as it comes and goes, and that loads nothing", () => {
        register();
        claudeCode = { id: 'anthropic.claude-code' };
        extensionsChanged.fire();
        claudeCode = undefined;
        extensionsChanged.fire();
        assert.deepStrictEqual(contexts, [
            ['setContext', CLAUDE_CODE_INSTALLED, false],
            ['setContext', CLAUDE_CODE_INSTALLED, true],
            ['setContext', CLAUDE_CODE_INSTALLED, false],
        ]);
        assert.strictEqual(calls.loads, 0, "the feature was loaded for the T's sake");
    });

    test("the key it sets is the one the editor title's T is shown by", () => {
        const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8')) as {
            contributes: { menus: Record<string, { command: string; when?: string }[]> };
        };
        const title = manifest.contributes.menus['editor/title']?.find(item => item.command === 'llm-tokenizer.showClaudeCodeUsage');
        assert.strictEqual(title?.when, `config.llm-tokenizer.enableClaudeCodeUsage || ${CLAUDE_CODE_INSTALLED}`);
    });

    test('turned on, it is loaded and starts from the settings as they are; later changes are passed on', () => {
        register();
        enabled = true;
        change('llm-tokenizer.enableClaudeCodeUsage');
        assert.deepStrictEqual([calls.loads, calls.settingsChanged], [1, 0]);
        change('llm-tokenizer.showClaudeCodeUsageInStatusBar');
        change('editor.fontSize');
        assert.deepStrictEqual([calls.loads, calls.settingsChanged], [1, 1]);
    });

    test('a bundle that fails to load fails no activation: it is logged, and the next command tries again', async () => {
        enabled = true;
        failingLoads = 2;
        assert.doesNotThrow(register);
        assert.deepStrictEqual([calls.loads, calls.starts], [1, 0]);
        assert.ok(errors.some(e => e.includes('could not be loaded') && e.includes('usage.js')), errors.join(' | '));
        // The command says so, rather than throwing.
        await handlers.get('llm-tokenizer.showClaudeCodeUsage')?.();
        assert.deepStrictEqual(shownErrors, ['LLM Tokenizer: Claude Code usage could not be loaded; see the log.']);
        await handlers.get('llm-tokenizer.showClaudeCodeUsage')?.();
        assert.deepStrictEqual([calls.loads, calls.starts, calls.show, shownErrors.length], [3, 1, 1, 1]);
    });
});
