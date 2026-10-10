import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';

import type { PanelFragments } from '../../src/usage/render';

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

/** A webview panel that records what the extension posts to it, and passes on what the page would send. */
function fakePanel() {
    const viewState = new vscode.EventEmitter<vscode.WebviewPanelOnDidChangeViewStateEvent>();
    const disposed = new vscode.EventEmitter<void>();
    const messages = new vscode.EventEmitter<unknown>();
    const posted: PanelFragments[] = [];
    let gone = false;
    const panel = {
        visible: true,
        webview: {
            html: '',
            postMessage: (message: { fragments: PanelFragments }) => {
                posted.push(message.fragments);
                return Promise.resolve(true);
            },
            onDidReceiveMessage: messages.event,
        },
        onDidChangeViewState: viewState.event,
        onDidDispose: disposed.event,
        reveal: () => undefined,
        dispose: () => {
            if (!gone) {
                gone = true;
                disposed.fire();
            }
        },
    };
    return { panel, posted, send: (message: unknown) => messages.fire(message) };
}

/** The tokens a CSV export would add up to: input, cache writes, cache reads and output of every row. */
function processedInCsv(fragments: PanelFragments | undefined): number {
    return (fragments?.csv.rows ?? []).reduce((sum, r) => sum + Number(r[4]) + Number(r[5]) + Number(r[8]) + Number(r[9]), 0);
}

type Shown = { kind: 'info' | 'warning'; message: string; items: unknown[] };

suite('Claude Code usage, turned on, in the editor', () => {
    const config = () => vscode.workspace.getConfiguration('llm-tokenizer');
    const window = vscode.window as unknown as Record<string, unknown>;
    const originals: Record<string, unknown> = {};
    let page: ReturnType<typeof fakePanel>;
    let shown: Shown[];
    /** What the next modal question is answered with. */
    let answer: string | undefined;

    setup(async () => {
        page = fakePanel();
        shown = [];
        answer = undefined;
        for (const name of ['createWebviewPanel', 'showInformationMessage', 'showWarningMessage']) {
            originals[name] = window[name];
        }
        window.createWebviewPanel = () => page.panel;
        window.showInformationMessage = (message: string, ...items: unknown[]) => (shown.push({ kind: 'info', message, items }), Promise.resolve(undefined));
        window.showWarningMessage = (message: string, ...items: unknown[]) => {
            shown.push({ kind: 'warning', message, items });
            return Promise.resolve(typeof items[0] === 'object' ? answer : undefined);
        };
        await config().update('enableClaudeCodeUsage', true, vscode.ConfigurationTarget.Global);
    });

    teardown(async () => {
        page.panel.dispose();
        // Cleared, so the next run starts from an empty history too.
        answer = 'Clear History';
        await vscode.commands.executeCommand('llm-tokenizer.clearClaudeCodeUsageHistory');
        await config().update('enableClaudeCodeUsage', undefined, vscode.ConfigurationTarget.Global);
        Object.assign(window, originals);
    });

    test("its panel shows the fixtures' totals, read through the test host's own roots", async () => {
        await vscode.commands.executeCommand('llm-tokenizer.showClaudeCodeUsage');
        page.send({ type: 'setRange', range: 'coverage' });
        // 1,278 tokens processed, worked out by hand in the fixtures' README.
        await until(() => processedInCsv(page.posted.at(-1)) === 1_278, 20_000);
        assert.strictEqual(processedInCsv(page.posted.at(-1)), 1_278, `the last export added up to ${processedInCsv(page.posted.at(-1))}`);
        const diagnostics = page.posted.at(-1)?.diagnostics ?? '';
        assert.ok(diagnostics.includes(`fixtures${path.sep}claude-config`), 'the fixture root is not the one read');
    });

    test('Refresh says what it read, and while off offers the setting instead', async () => {
        await vscode.commands.executeCommand('llm-tokenizer.refreshClaudeCodeUsage');
        assert.ok(shown.some(s => s.kind === 'info' && /^LLM Tokenizer: read \d+ changed of 4 Claude Code transcripts\.$/.test(s.message)), JSON.stringify(shown));

        await config().update('enableClaudeCodeUsage', false, vscode.ConfigurationTarget.Global);
        shown = [];
        await vscode.commands.executeCommand('llm-tokenizer.refreshClaudeCodeUsage');
        assert.deepStrictEqual(shown.map(s => [s.message, s.items]), [['Claude Code usage is off.', ['Open Settings']]]);
    });

    test('Clear asks first, and clears only when told to', async () => {
        await vscode.commands.executeCommand('llm-tokenizer.refreshClaudeCodeUsage');
        shown = [];
        answer = undefined;
        await vscode.commands.executeCommand('llm-tokenizer.clearClaudeCodeUsageHistory');
        assert.deepStrictEqual(shown.map(s => s.kind), ['warning'], 'cleared without being told to');
        assert.ok((shown[0].items[0] as { modal?: boolean }).modal);

        answer = 'Clear History';
        await vscode.commands.executeCommand('llm-tokenizer.clearClaudeCodeUsageHistory');
        assert.deepStrictEqual(shown.at(-1)?.message, 'LLM Tokenizer: Claude Code usage history cleared.');
        // Read again from what is still on disk.
        shown = [];
        await vscode.commands.executeCommand('llm-tokenizer.refreshClaudeCodeUsage');
        assert.ok(shown.some(s => /read 4 changed of 4/.test(s.message)), JSON.stringify(shown));
    });
});
