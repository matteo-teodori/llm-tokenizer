import * as assert from 'assert';
import * as path from 'path';

import {
    buildFileTree,
    buildProcessedFilesHtml,
    buildSkippedFilesHtml,
    renderTreeAsHtml,
} from '../../src/fileTree';

/** Every `<li>` in the rendered listing. */
function countListItems(html: string): number {
    return (html.match(/<li /g) ?? []).length;
}

/**
 * A platform-native absolute path.
 *
 * buildFileTree splits on `path.sep`, so hardcoded POSIX paths collapse to a
 * single node on Windows — the tree assertions would still pass, but for the
 * wrong reason, and would stop testing anything at all.
 */
function p(...segments: string[]): string {
    return path.resolve(path.sep, ...segments);
}

suite('file tree', () => {
    test('folder totals are the sum of their descendants', () => {
        const tree = buildFileTree([
            { path: p('repo', 'src', 'a.ts'), tokens: 10 },
            { path: p('repo', 'src', 'nested', 'b.ts'), tokens: 5 },
            { path: p('repo', 'README.md'), tokens: 7 },
        ]);
        assert.strictEqual(tree.tokens, 22);
    });

    test('an empty listing renders nothing at all', () => {
        assert.strictEqual(buildProcessedFilesHtml([]), '');
        assert.strictEqual(buildSkippedFilesHtml([]), '');
    });

    test('file names are escaped in the rendered tree', () => {
        // A file may legitimately be named this on macOS and Linux, and the
        // webview runs with scripts enabled.
        const tree = buildFileTree([{ path: p('repo', '<img src=x onerror=alert(1)>.ts'), tokens: 1 }]);
        const html = renderTreeAsHtml(tree, true);

        assert.ok(!html.includes('<img'), 'raw tag reached the document');
        assert.ok(html.includes('&lt;img'), 'name should be escaped');
    });

    test('a skip reason of undefined does not render the string "undefined"', () => {
        const tree = buildFileTree([{ path: p('repo', 'a.bin') }]);
        const html = renderTreeAsHtml(tree, true);
        assert.ok(!html.includes('undefined'), html);
    });

    test('large listings are capped, and the cap is disclosed', () => {
        // The panel retains its context, so an uncapped listing held a
        // multi-megabyte string and one DOM node per file for the lifetime of
        // the window.
        const files = Array.from({ length: 2500 }, (_, i) => ({
            path: p('repo', 'src', `file-${i}.ts`),
            tokens: i,
        }));

        const html = buildProcessedFilesHtml(files);

        assert.ok(html.includes('Processed Files (2500)'), 'the true total must still be reported');
        assert.ok(html.includes('1,500 more'), 'the omission must be disclosed');
        // 1000 files plus their folder nodes, nowhere near 2500.
        assert.ok(countListItems(html) < 1200, `rendered ${countListItems(html)} items`);
    });

    test('the cap keeps the largest files', () => {
        const files = Array.from({ length: 1500 }, (_, i) => ({
            path: p('repo', `f${i}.ts`),
            tokens: i,
        }));
        const html = buildProcessedFilesHtml(files);

        assert.ok(html.includes('f1499.ts'), 'the largest file should be listed');
        assert.ok(!html.includes('>f0.ts<'), 'the smallest file should have been dropped');
    });

    test('a listing at exactly the cap is not truncated', () => {
        const files = Array.from({ length: 1000 }, (_, i) => ({ path: p('repo', `f${i}.ts`), tokens: 1 }));
        assert.ok(!buildProcessedFilesHtml(files).includes('more, not listed'));
    });
});
