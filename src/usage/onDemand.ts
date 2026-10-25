/**
 * Claude Code usage at activation: its three commands, one settings
 * listener, and the context key that shows the editor title's T, and
 * nothing more. The feature itself is a bundle of its own, out/usage.js,
 * loaded the first time it is needed: at activation if it is on, when it is
 * turned on, or when one of its commands runs. Off, none of its code is
 * parsed, which kept activation within a millisecond of what it was before
 * the feature (the plan's KC2).
 */

import * as path from 'path';
import * as vscode from 'vscode';

import { CONFIG_SECTION, affectsUsage } from './settings';
import type { UsageCommands, startClaudeCodeUsage } from './usageService';

type Start = typeof startClaudeCodeUsage;

/** Claude Code's VS Code extension; its id is compared without regard to case. */
const CLAUDE_CODE_EXTENSION = 'anthropic.claude-code';

/**
 * True while Claude Code's VS Code extension is installed and enabled. The
 * T shows then, or while the feature is on: for the people who use Claude
 * Code, not for everyone who counts tokens for other models. Claude Code's
 * is a workspace extension, as this one is, so the two run in one extension
 * host, locally and in a remote window alike, which is where the stable
 * getExtension looks. Claude Code used only as its CLI is not seen; Show
 * Claude Code Usage opens the panel all the same.
 */
export const CLAUDE_CODE_INSTALLED = 'llm-tokenizer.claudeCodeInstalled';

/**
 * The feature's bundle, beside this one in out/, as the encoders are: an
 * absolute path is opaque to the bundler, so the bundle is loaded at run
 * time rather than inlined.
 */
function bundled(): Start {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require(path.join(__dirname, 'usage.js')) as { startClaudeCodeUsage: Start }).startClaudeCodeUsage;
}

/**
 * Register the commands, the listener and the context key; `load` is the
 * bundle's loader, and `extensions` where Claude Code's is looked for, which
 * a test replaces. A bundle that fails to load or start, as a broken
 * install's would, is logged and tried again by the next command, and never
 * fails the extension's activation.
 */
export function registerClaudeCodeUsage(
    context: vscode.ExtensionContext,
    log: vscode.LogOutputChannel,
    startupSettled: Thenable<unknown>,
    load: () => Start = bundled,
    extensions: Pick<typeof vscode.extensions, 'getExtension' | 'onDidChange'> = vscode.extensions,
): void {
    let feature: UsageCommands | undefined;
    const started = (): UsageCommands | undefined => {
        if (!feature) {
            let start: Start;
            try {
                start = load();
            } catch (error) {
                log.error(`Claude Code usage could not be loaded: ${error instanceof Error ? error.message : String(error)}`);
                return undefined;
            }
            try {
                feature = start(context, log, startupSettled);
            } catch (error) {
                // The name only: what the feature had read could be in the message.
                log.error(`Claude Code usage could not be started (${error instanceof Error ? error.name : 'Error'})`);
                return undefined;
            }
        }
        return feature;
    };
    /** The feature for a command, or why there is none. */
    const forCommand = (): UsageCommands | undefined => {
        const commands = started();
        if (!commands) {
            void vscode.window.showErrorMessage('LLM Tokenizer: Claude Code usage could not be loaded; see the log.');
        }
        return commands;
    };
    // As written in settings.json, of any type: only `true` is consent, never a "false" string.
    const enabled = () => vscode.workspace.getConfiguration(CONFIG_SECTION).get<unknown>('enableClaudeCodeUsage') === true;
    // Not kept between sessions: the T shows once activation has run.
    const markClaudeCode = () =>
        void vscode.commands.executeCommand('setContext', CLAUDE_CODE_INSTALLED, extensions.getExtension(CLAUDE_CODE_EXTENSION) !== undefined);
    markClaudeCode();
    context.subscriptions.push(
        extensions.onDidChange(markClaudeCode),
        // Always registered: while the feature is off, the panel says what turning it on does.
        vscode.commands.registerCommand('llm-tokenizer.showClaudeCodeUsage', () => forCommand()?.show()),
        vscode.commands.registerCommand('llm-tokenizer.refreshClaudeCodeUsage', () => forCommand()?.refresh()),
        vscode.commands.registerCommand('llm-tokenizer.clearClaudeCodeUsageHistory', () => forCommand()?.clear()),
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
