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

suite('status bar visibility', () => {
    // The method that decides which of the two items is visible encodes two
    // documented past bugs — the code default disagreeing with the manifest
    // default, and 'project' mode hiding everything when project scanning is
    // off — and nothing asserted either. These items are spies rather than real
    // ones so visibility can be read back; StatusBarManager only ever pushes
    // them onto `subscriptions`.
    const CONFIG = 'llm-tokenizer';

    let manager: StatusBarManager;
    let ctx: ReturnType<typeof fakeContext>;
    let shown: Map<vscode.StatusBarItem, boolean>;
    let original: string | undefined;

    function display(display: Partial<Parameters<StatusBarManager['showFileCount']>[0]> = {}) {
        return {
            count: 100,
            exact: true,
            model: model('gpt-5.6-sol'),
            projectScanEnabled: true,
            ...display,
        };
    }

    /** [fileVisible, projectVisible] */
    function visibility(): [boolean, boolean] {
        const items = [...shown.keys()];
        return [shown.get(items[0]) ?? false, shown.get(items[1]) ?? false];
    }

    async function setMode(mode: string): Promise<void> {
        await vscode.workspace
            .getConfiguration(CONFIG)
            .update('statusBarDisplay', mode, vscode.ConfigurationTarget.Global);
    }

    setup(() => {
        original = vscode.workspace
            .getConfiguration(CONFIG)
            .inspect<string>('statusBarDisplay')?.globalValue;

        shown = new Map();
        const create = vscode.window.createStatusBarItem.bind(vscode.window);
        // Wrap the real factory so show()/hide() are observable.
        (vscode.window as unknown as { createStatusBarItem: unknown }).createStatusBarItem = (
            ...args: unknown[]
        ) => {
            const item = (create as (...a: unknown[]) => vscode.StatusBarItem)(...args);
            shown.set(item, false);
            const realShow = item.show.bind(item);
            const realHide = item.hide.bind(item);
            item.show = () => { shown.set(item, true); realShow(); };
            item.hide = () => { shown.set(item, false); realHide(); };
            return item;
        };

        ctx = fakeContext();
        manager = new StatusBarManager(ctx.context);
        (vscode.window as unknown as { createStatusBarItem: unknown }).createStatusBarItem = create;
    });

    teardown(async () => {
        ctx.dispose();
        await vscode.workspace
            .getConfiguration(CONFIG)
            .update('statusBarDisplay', original, vscode.ConfigurationTarget.Global);
    });

    test("the code's default display mode matches the manifest's", () => {
        // These disagreed once: the manifest said 'both' and the code fell back
        // to 'file', so a user who had never touched the setting saw one item.
        const manifest = vscode.extensions.getExtension('matteoteodori.llm-tokenizer')
            ?.packageJSON as {
                contributes: { configuration: { properties: Record<string, { default?: string }> } };
            };
        const declared = manifest.contributes.configuration.properties[`${CONFIG}.statusBarDisplay`];

        // With the setting unset, both counts present, the manifest default of
        // 'both' must be what actually happens.
        assert.strictEqual(declared.default, 'both');
        manager.showFileCount(display());
        manager.showProjectCount(display());
        assert.deepStrictEqual(visibility(), [true, true]);
    });

    test('each mode shows what it says, and project mode degrades rather than emptying', async () => {
        manager.showFileCount(display());
        manager.showProjectCount(display());

        await setMode('file');
        manager.applyDisplayMode(true);
        assert.deepStrictEqual(visibility(), [true, false], "'file' should show only the file item");

        await setMode('project');
        manager.applyDisplayMode(true);
        assert.deepStrictEqual(visibility(), [false, true], "'project' should show only the total");

        // The bug this guards: reading 'project' naively with scanning off hides
        // both items, and the extension looks uninstalled.
        manager.applyDisplayMode(false);
        assert.deepStrictEqual(
            visibility(),
            [true, false],
            "'project' with scanning off should fall back to the file item",
        );
    });

    test('clearing the total re-derives visibility instead of just hiding', async () => {
        // clearProjectCount used to hide its own item directly, so in 'project'
        // mode the same logical state rendered as an empty status bar when
        // reached by clearing and as the file item when reached by
        // applyDisplayMode. Switching model clears the total, so this is the
        // ordinary path, not a corner case.
        await setMode('project');
        manager.showFileCount(display());
        manager.showProjectCount(display());
        assert.deepStrictEqual(visibility(), [false, true]);

        manager.clearProjectCount();
        assert.deepStrictEqual(
            visibility(),
            [true, false],
            'clearing the total should leave the file count visible, not an empty bar',
        );
    });

    test('with no file counted the file item stays hidden in every mode', async () => {
        // Re-showing it would resurrect the number last written to it, which
        // belongs to a file the user has since closed.
        for (const mode of ['both', 'file', 'project']) {
            await setMode(mode);
            manager.applyDisplayMode(true);
            assert.strictEqual(visibility()[0], false, `mode ${mode} showed a stale file count`);
        }
    });
});
