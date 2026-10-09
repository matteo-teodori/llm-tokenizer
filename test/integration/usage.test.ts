import * as assert from 'assert';
import * as vscode from 'vscode';

/** The usage panel's tabs; a webview tab's view type carries a prefix of VS Code's own. */
function usageTabs(): vscode.Tab[] {
    return vscode.window.tabGroups.all
        .flatMap(group => group.tabs)
        .filter(tab => tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith('llmTokenizer.claudeCodeUsage'));
}

async function until(condition: () => boolean, ms = 3_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!condition() && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 25));
    }
}

suite('Claude Code usage, in the editor', () => {
    teardown(async () => {
        await vscode.window.tabGroups.close(usageTabs());
    });

    test('Show Claude Code Usage opens one panel, and reuses it, while the feature is off', async () => {
        assert.strictEqual(vscode.workspace.getConfiguration('llm-tokenizer').get('enableClaudeCodeUsage'), false);
        await vscode.commands.executeCommand('llm-tokenizer.showClaudeCodeUsage');
        await vscode.commands.executeCommand('llm-tokenizer.showClaudeCodeUsage');
        await until(() => usageTabs().length > 0);
        assert.deepStrictEqual(
            usageTabs().map(tab => tab.label),
            ['Claude Code Usage'],
        );
    });
});
