import * as assert from 'assert';
import * as vscode from 'vscode';

import { StatusBarManager } from '../../src/statusbar';
import { findModel } from '../../src/tokenizer/registry';
import type { ModelInfo } from '../../src/tokenizer/registry';

function model(id: string): ModelInfo {
    const found = findModel(id);
    assert.ok(found, `test refers to unknown model ${id}`);
    return found;
}

/**
 * A minimal stand-in for ExtensionContext.
 *
 * StatusBarManager only ever pushes its two items onto `subscriptions`.
 */
function fakeContext(): { context: vscode.ExtensionContext; dispose: () => void } {
    const subscriptions: { dispose(): unknown }[] = [];
    return {
        context: { subscriptions } as unknown as vscode.ExtensionContext,
        dispose: () => subscriptions.forEach(d => void d.dispose()),
    };
}

/** Read the theme colour id off an item, or undefined when unset. */
function colourId(value: vscode.ThemeColor | string | undefined): string | undefined {
    if (value === undefined || typeof value === 'string') {
        return value;
    }
    return (value as unknown as { id: string }).id;
}

suite('status bar colouring', () => {
    let manager: StatusBarManager;
    let ctx: ReturnType<typeof fakeContext>;
    let items: vscode.StatusBarItem[];

    setup(() => {
        ctx = fakeContext();
        manager = new StatusBarManager(ctx.context);
        items = ctx.context.subscriptions as unknown as vscode.StatusBarItem[];
    });

    teardown(() => ctx.dispose());

    /** The file item is the first one the manager creates. */
    const fileItem = (): vscode.StatusBarItem => items[0];

    // gpt-4-turbo has a 128,000 token limit, so these are easy to reason about.
    const under = 1_000;
    const warning = 110_000; // ~86%
    const over = 200_000; // ~156%

    function show(count: number): void {
        manager.showFileCount({
            count,
            exact: true,
            model: model('gpt-4-turbo'),
            projectScanEnabled: false,
        });
    }

    test('over the limit uses a background, never a bare white foreground', () => {
        // VS Code registers statusBarItem.errorForeground as plain white for
        // every theme, because it is meant to sit on the error background.
        // Setting it alone painted white text on the normal status bar, which
        // is invisible on a light theme — exactly when you most need to see it.
        show(over);

        assert.strictEqual(
            colourId(fileItem().backgroundColor),
            'statusBarItem.errorBackground',
            'an over-limit count must use the error background',
        );
        assert.strictEqual(
            colourId(fileItem().color),
            undefined,
            'the foreground must be left to VS Code, which guarantees readability',
        );
    });

    test('approaching the limit uses the warning background', () => {
        show(warning);
        assert.strictEqual(colourId(fileItem().backgroundColor), 'statusBarItem.warningBackground');
        assert.strictEqual(colourId(fileItem().color), undefined);
    });

    test('comfortably within the limit is left unstyled', () => {
        show(under);
        assert.strictEqual(colourId(fileItem().backgroundColor), undefined);
        assert.strictEqual(colourId(fileItem().color), undefined);
    });

    test('the badge is cleared when a later count is back within limits', () => {
        // Status bar items are reused, so a background left set would follow
        // the user from an over-limit file to a small one.
        show(over);
        assert.ok(fileItem().backgroundColor, 'precondition: badge is set');

        show(under);
        assert.strictEqual(colourId(fileItem().backgroundColor), undefined);
    });

    test('a model with no published limit never shows a badge', () => {
        const unlimited = { ...model('gpt-4-turbo'), contextLimit: undefined };
        manager.showFileCount({
            count: 10_000_000,
            exact: true,
            model: unlimited,
            projectScanEnabled: false,
        });

        assert.strictEqual(colourId(fileItem().backgroundColor), undefined);
    });
});
