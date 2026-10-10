/**
 * Claude Code usage at activation: its three commands and one settings
 * listener, and nothing more. The feature itself is a bundle of its own,
 * out/usage.js, loaded the first time it is needed: at activation if it is
 * on, when it is turned on, or when one of its commands runs. Off, none of
 * its code is parsed, which kept activation within a millisecond of what it
 * was before the feature (the plan's KC2).
 */

import * as path from 'path';
import * as vscode from 'vscode';

import { CONFIG_SECTION, affectsUsage } from './settings';
import type { UsageCommands, startClaudeCodeUsage } from './usageService';

type Start = typeof startClaudeCodeUsage;

/**
 * The feature's bundle, beside this one in out/, as the encoders are: an
 * absolute path is opaque to the bundler, so the bundle is loaded at run
 * time rather than inlined.
 */
function bundled(): Start {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require(path.join(__dirname, 'usage.js')) as { startClaudeCodeUsage: Start }).startClaudeCodeUsage;
}

/** Register the commands and the listener; `load` is the bundle's loader, which a test replaces. */
export function registerClaudeCodeUsage(
    context: vscode.ExtensionContext,
    log: vscode.LogOutputChannel,
    startupSettled: Thenable<unknown>,
    load: () => Start = bundled,
): void {
    let feature: UsageCommands | undefined;
    const started = (): UsageCommands => (feature ??= load()(context, log, startupSettled));
    const enabled = () => vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>('enableClaudeCodeUsage', false);
    context.subscriptions.push(
        // Always registered: while the feature is off, the panel says what turning it on does.
        vscode.commands.registerCommand('llm-tokenizer.showClaudeCodeUsage', () => started().show()),
        vscode.commands.registerCommand('llm-tokenizer.refreshClaudeCodeUsage', () => started().refresh()),
        vscode.commands.registerCommand('llm-tokenizer.clearClaudeCodeUsageHistory', () => started().clear()),
        vscode.workspace.onDidChangeConfiguration(event => {
            if (!affectsUsage(event)) {
                return;
            }
            if (feature) {
                feature.settingsChanged();
            } else if (enabled()) {
                // Started with the settings as they now are: nothing more to tell it.
                started();
            }
        }),
    );
    if (enabled()) {
        started();
    }
}
