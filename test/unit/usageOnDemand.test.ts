import * as assert from 'assert';
import * as vscode from 'vscode';

import { registerClaudeCodeUsage } from '../../src/usage/onDemand';
import type { UsageCommands, startClaudeCodeUsage } from '../../src/usage/usageService';

type Start = typeof startClaudeCodeUsage;

suite('usage, loaded on demand', () => {
    const commands = vscode.commands as unknown as Record<string, unknown>;
    const workspace = vscode.workspace as unknown as Record<string, unknown>;
    const originals: Record<string, unknown> = {};
    let handlers: Map<string, () => unknown>;
    let listener: ((event: Pick<vscode.ConfigurationChangeEvent, 'affectsConfiguration'>) => void) | undefined;
    let enabled: boolean;
    const calls = { loads: 0, starts: 0, show: 0, settingsChanged: 0 };

    /** The bundle as the loader sees it: counted, and doing nothing. */
    const load = (): Start => {
        calls.loads++;
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
            {} as vscode.LogOutputChannel,
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
        originals.registerCommand = commands.registerCommand;
        originals.onDidChangeConfiguration = workspace.onDidChangeConfiguration;
        originals.getConfiguration = workspace.getConfiguration;
        // This extension's own commands are registered already: the fakes stand in.
        commands.registerCommand = (id: string, handler: () => unknown) => (handlers.set(id, handler), new vscode.Disposable(() => undefined));
        workspace.onDidChangeConfiguration = (fn: typeof listener) => ((listener = fn), new vscode.Disposable(() => undefined));
        workspace.getConfiguration = () => ({ get: <T>(_key: string, fallback?: T) => (enabled as unknown as T) ?? fallback });
    });

    teardown(() => {
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
});
