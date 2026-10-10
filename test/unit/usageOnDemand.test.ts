import * as assert from 'assert';
import * as vscode from 'vscode';

import { registerClaudeCodeUsage } from '../../src/usage/onDemand';
import type { UsageCommands, startClaudeCodeUsage } from '../../src/usage/usageService';

type Start = typeof startClaudeCodeUsage;

suite('usage, loaded on demand', () => {
    const commands = vscode.commands as unknown as Record<string, unknown>;
    const workspace = vscode.workspace as unknown as Record<string, unknown>;
    const window = vscode.window as unknown as Record<string, unknown>;
    const originals: Record<string, unknown> = {};
    let handlers: Map<string, () => unknown>;
    let listener: ((event: Pick<vscode.ConfigurationChangeEvent, 'affectsConfiguration'>) => void) | undefined;
    let enabled: boolean;
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
        );

    setup(() => {
        for (const key of Object.keys(calls) as (keyof typeof calls)[]) {
            calls[key] = 0;
        }
        handlers = new Map();
        listener = undefined;
        enabled = false;
        failingLoads = 0;
        errors = [];
        shownErrors = [];
        originals.showErrorMessage = window.showErrorMessage;
        window.showErrorMessage = (message: string) => (shownErrors.push(message), Promise.resolve(undefined));
        originals.registerCommand = commands.registerCommand;
        originals.onDidChangeConfiguration = workspace.onDidChangeConfiguration;
        originals.getConfiguration = workspace.getConfiguration;
        // This extension's own commands are registered already: the fakes stand in.
        commands.registerCommand = (id: string, handler: () => unknown) => (handlers.set(id, handler), new vscode.Disposable(() => undefined));
        workspace.onDidChangeConfiguration = (fn: typeof listener) => ((listener = fn), new vscode.Disposable(() => undefined));
        workspace.getConfiguration = () => ({ get: <T>(_key: string, fallback?: T) => (enabled as unknown as T) ?? fallback });
    });

    teardown(() => {
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
