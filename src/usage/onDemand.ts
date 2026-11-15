/**
 * Agent usage at activation: its three commands, one settings
 * listener, and the context key that shows the editor title's T, and
 * nothing more. The feature itself is a bundle of its own, out/usage.js,
 * loaded the first time it is needed: at activation if it is on, when it is
 * turned on, or when one of its commands runs. Off, none of its code is
 * parsed, which kept activation within a millisecond of what it was before
 * the feature (the plan's KC2).
 */

import * as path from 'path';
import * as vscode from 'vscode';

import { AGENT_SWITCHES, CONFIG_SECTION, affectsUsage } from './settings';
import type { UsageCommands, startClaudeCodeUsage } from './usageService';

type Start = typeof startClaudeCodeUsage;

/** The VS Code extensions of the agents the panel reads, Claude Code's and Codex's; ids compare without regard to case. */
const AGENT_EXTENSIONS = ['anthropic.claude-code', 'openai.chatgpt'];

/**
 * True while the VS Code extension of an agent the panel reads is installed
 * and enabled: Claude Code's, or Codex's. The T shows then, or while the
 * feature is on: for the people who use those agents, not for everyone who
 * counts tokens for other models. Both are workspace extensions, as this one
 * is, so they run in one extension host, locally and in a remote window
 * alike, which is where the stable getExtension looks. An agent used only as
 * its CLI is not seen; Show Agent Usage opens the panel all the same.
 */
export const AGENT_INSTALLED = 'llm-tokenizer.agentInstalled';

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
                log.error(`Agent usage could not be loaded: ${error instanceof Error ? error.message : String(error)}`);
                return undefined;
            }
            try {
                feature = start(context, log, startupSettled);
            } catch (error) {
                // The name only: what the feature had read could be in the message.
                log.error(`Agent usage could not be started (${error instanceof Error ? error.name : 'Error'})`);
                return undefined;
            }
        }
        return feature;
    };
    /** The feature for a command, or why there is none. */
    const forCommand = (): UsageCommands | undefined => {
        const commands = started();
        if (!commands) {
            void vscode.window.showErrorMessage('LLM Tokenizer: agent usage could not be loaded; see the log.');
        }
        return commands;
    };
    // As written in settings.json, of any type: only `true` is consent, never a "false" string.
    const enabled = () => {
        const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
        return AGENT_SWITCHES.some(key => config.get<unknown>(key) === true);
    };
    // Not kept between sessions: the T shows once activation has run.
    const markAgents = () =>
        void vscode.commands.executeCommand('setContext', AGENT_INSTALLED, AGENT_EXTENSIONS.some(id => extensions.getExtension(id) !== undefined));
    markAgents();
    context.subscriptions.push(
        extensions.onDidChange(markAgents),
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
