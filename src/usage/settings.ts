/**
 * The usage feature's settings, kept apart from the feature itself: the
 * extension reads them at activation without loading the feature's bundle.
 */

import type * as vscode from 'vscode';

export const CONFIG_SECTION = 'llm-tokenizer';

/**
 * This feature's settings: each agent's own switch and data folder, and the
 * status item's. A change to any of them, or to where Claude Code writes, is
 * the feature's to handle.
 */
export const USAGE_SETTINGS = ['enableClaudeCodeUsage', 'claudeCodeDataDirectory', 'showClaudeCodeUsageInStatusBar', 'enableCodexUsage', 'codexDataDirectory'] as const;

/** The settings that turn on reading an agent's records: the feature runs while any of them is `true`. */
export const AGENT_SWITCHES = ['enableClaudeCodeUsage', 'enableCodexUsage'] as const;

export function affectsUsage(event: Pick<vscode.ConfigurationChangeEvent, 'affectsConfiguration'>): boolean {
    return (
        USAGE_SETTINGS.some(key => event.affectsConfiguration(`${CONFIG_SECTION}.${key}`)) ||
        event.affectsConfiguration('claudeCode.environmentVariables')
    );
}
