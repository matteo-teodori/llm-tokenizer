import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import {
    FolderContext,
    buildExcludeGlob,
    dedupeSelection,
    describeSkipReason,
    isDirectory,
    isFile,
    looksBinary,
    shouldCount,
    shouldDescend,
} from '../../src/scan';
import { MAX_TOKENIZED_FILE_BYTES } from '../../src/constants';

const roots: vscode.Uri[] = [];

/**
 * A FolderContext over a real temporary directory.
 *
 * The .gitignore is written to disk rather than stubbed, so these tests
 * exercise the same read path the extension uses. Pass `undefined` to build a
 * context with gitignore support switched off.
 */
async function contextFor(gitignore?: string): Promise<{ context: FolderContext; root: vscode.Uri }> {
    const root = vscode.Uri.file(
        path.join(os.tmpdir(), `llm-tokenizer-scan-${process.pid}-${roots.length}`),
    );
    await vscode.workspace.fs.createDirectory(root);
    roots.push(root);

    if (gitignore !== undefined) {
        await vscode.workspace.fs.writeFile(
            vscode.Uri.joinPath(root, '.gitignore'),
            new TextEncoder().encode(gitignore),
        );
    }

    const folder: vscode.WorkspaceFolder = { uri: root, name: 'fixture', index: 0 };
    return { context: await FolderContext.create(folder, gitignore !== undefined), root };
}

suiteTeardown(async () => {
    for (const root of roots) {
        try {
            await vscode.workspace.fs.delete(root, { recursive: true, useTrash: false });
        } catch {
            // Best effort; the OS reclaims the temp directory anyway.
        }
    }
});

suite('gitignore handling', () => {
    test('matches files', async () => {
        const { context, root } = await contextFor('*.log\n');
        assert.strictEqual(context.isIgnored(vscode.Uri.joinPath(root, 'app.log'), false), true);
        assert.strictEqual(context.isIgnored(vscode.Uri.joinPath(root, 'app.ts'), false), false);
    });

    test('directory rules prune the directory', async () => {
        // `ignore` matches `build/` against "build/" but not against "build",
        // so without the trailing slash whole ignored trees were walked in full
        // and rendered as tens of thousands of rows in the summary.
        const { context, root } = await contextFor('build/\n');
        const build = vscode.Uri.joinPath(root, 'build');
        assert.strictEqual(context.isIgnored(build, true), true);
        assert.strictEqual(shouldDescend('build', build, context), false);
    });

    test('reads .git/info/exclude as well as .gitignore', async () => {
        const { context, root } = await contextFor('*.log\n');
        // Written after the context above; build a second one that sees both.
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root, '.git', 'info'));
        await vscode.workspace.fs.writeFile(
            vscode.Uri.joinPath(root, '.git', 'info', 'exclude'),
            new TextEncoder().encode('*.bak\n'),
        );
        const second = await FolderContext.create(
            { uri: root, name: 'fixture', index: 0 },
            true,
        );

        assert.strictEqual(second.isIgnored(vscode.Uri.joinPath(root, 'a.bak'), false), true);
        assert.strictEqual(second.isIgnored(vscode.Uri.joinPath(root, 'a.log'), false), true);
        assert.strictEqual(context.isIgnored(vscode.Uri.joinPath(root, 'a.bak'), false), false);
    });

    test('paths outside the folder are never reported as ignored', async () => {
        // The multi-root crash: anchoring on one folder while searching all of
        // them produced `../otherRoot/x.ts`, which `ignore` rejects by throwing
        // — and the throw escaped the per-file try/catch, aborting the scan for
        // the rest of the session.
        const { context } = await contextFor('*.log\n');
        const outside = vscode.Uri.file('/somewhere/else/app.log');
        assert.doesNotThrow(() => context.isIgnored(outside, false));
        assert.strictEqual(context.isIgnored(outside, false), false);
    });

    test('an empty ignore instance does not throw on an outside path', async () => {
        const { context } = await contextFor('');
        assert.doesNotThrow(() => context.isIgnored(vscode.Uri.file('/elsewhere/x.ts'), false));
    });

    test('the folder root itself is not ignored', async () => {
        const { context, root } = await contextFor('*\n');
        assert.strictEqual(context.isIgnored(root, true), false);
    });

    test('nothing is ignored when the setting is off', async () => {
        const { context, root } = await contextFor();
        assert.strictEqual(context.isIgnored(vscode.Uri.joinPath(root, 'app.log'), false), false);
    });

    test('negation patterns are honoured', async () => {
        const { context, root } = await contextFor('*.log\n!keep.log\n');
        assert.strictEqual(context.isIgnored(vscode.Uri.joinPath(root, 'drop.log'), false), true);
        assert.strictEqual(context.isIgnored(vscode.Uri.joinPath(root, 'keep.log'), false), false);
    });
});

suite('file eligibility', () => {
    test('binary extensions are skipped', async () => {
        const { context, root } = await contextFor();
        assert.strictEqual(shouldCount(vscode.Uri.joinPath(root, 'icon.png'), 100, context), 'binary');
        assert.strictEqual(shouldCount(vscode.Uri.joinPath(root, 'a.ts'), 100, context), undefined);
    });

    test('oversized files are skipped rather than tokenized', async () => {
        // Tokenizing costs ~4.5 heap bytes per input byte; an unguarded read of
        // a large data file was enough to take the extension host down.
        const { context, root } = await contextFor();
        assert.strictEqual(
            shouldCount(vscode.Uri.joinPath(root, 'huge.csv'), MAX_TOKENIZED_FILE_BYTES + 1, context),
            'too-large',
        );
        assert.strictEqual(
            shouldCount(vscode.Uri.joinPath(root, 'fine.csv'), MAX_TOKENIZED_FILE_BYTES, context),
            undefined,
        );
    });

    test('empty files are countable, not skipped', async () => {
        const { context, root } = await contextFor();
        assert.strictEqual(shouldCount(vscode.Uri.joinPath(root, 'empty.ts'), 0, context), undefined);
    });

    test('gitignored files are reported separately from skipped ones', async () => {
        const { context, root } = await contextFor('*.log\n');
        assert.strictEqual(shouldCount(vscode.Uri.joinPath(root, 'app.log'), 10, context), 'gitignored');
    });

    test('every skip reason has a description', () => {
        for (const reason of ['binary', 'too-large', 'unreadable', 'gitignored'] as const) {
            assert.ok(describeSkipReason(reason).length > 0);
        }
    });
});

suite('binary content sniffing', () => {
    const bytes = (s: string) => new TextEncoder().encode(s);

    test('text is not binary', () => {
        assert.strictEqual(looksBinary(bytes('const x = 42;\n')), false);
        assert.strictEqual(looksBinary(bytes('')), false);
        assert.strictEqual(looksBinary(bytes('emoji 🚀 and accents àèìòù')), false);
        assert.strictEqual(looksBinary(bytes('日本語のテキスト')), false);
    });

    test('a NUL byte marks content as binary', () => {
        // The extension list can only catch what it knows: .dat, .pack, a
        // renamed binary, and extensionless files all reached the tokenizer.
        assert.strictEqual(looksBinary(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d])), true);
        assert.strictEqual(looksBinary(new Uint8Array([0x00])), true);
    });

    test('only the head of the file is inspected', () => {
        // A NUL far past the sniff window does not make a large text file
        // binary — and, more importantly, sniffing stays O(1) per file.
        const big = new Uint8Array(64 * 1024);
        big.fill(0x41); // 'A'
        big[50_000] = 0;
        assert.strictEqual(looksBinary(big), false);

        const early = new Uint8Array(64 * 1024);
        early.fill(0x41);
        early[10] = 0;
        assert.strictEqual(looksBinary(early), true);
    });
});

suite('directory traversal', () => {
    test('well-known build directories are never descended into', async () => {
        const { context, root } = await contextFor();
        for (const name of ['node_modules', '.git', 'dist', 'out', '__pycache__']) {
            assert.strictEqual(
                shouldDescend(name, vscode.Uri.joinPath(root, name), context),
                false,
                `${name} should not be walked`,
            );
        }
        assert.strictEqual(shouldDescend('src', vscode.Uri.joinPath(root, 'src'), context), true);
    });

    test('the exclude glob covers .git, which findFiles would otherwise walk', () => {
        // Passing an explicit exclude to findFiles *replaces* VS Code's
        // defaults, so omitting .git re-enabled it — and loose git objects have
        // no extension, so they passed the binary check and were tokenized.
        const glob = buildExcludeGlob();
        assert.ok(glob.includes('**/.git/**'), glob);
        assert.ok(glob.includes('**/node_modules/**'), glob);
    });

    test('FileType is treated as a bitmask, so symlinks are not dropped', () => {
        // A symlinked directory is Directory|SymbolicLink === 66, which an
        // equality check misses entirely.
        assert.strictEqual(isDirectory(vscode.FileType.Directory | vscode.FileType.SymbolicLink), true);
        assert.strictEqual(isFile(vscode.FileType.File | vscode.FileType.SymbolicLink), true);
        assert.strictEqual(isDirectory(vscode.FileType.Directory), true);
        assert.strictEqual(isFile(vscode.FileType.File), true);
        assert.strictEqual(isDirectory(vscode.FileType.File), false);
        assert.strictEqual(isFile(vscode.FileType.Directory), false);
    });
});

suite('selection deduplication', () => {
    test('a file inside a selected folder is not counted twice', () => {
        // Uri.path is always POSIX-shaped, even on Windows, so these are safe
        // to compare literally.
        const deduped = dedupeSelection([
            vscode.Uri.file('/repo/src'),
            vscode.Uri.file('/repo/src/a.ts'),
            vscode.Uri.file('/repo/README.md'),
        ]).map(u => u.path).sort();

        assert.deepStrictEqual(deduped, ['/repo/README.md', '/repo/src']);
    });

    test('identical uris collapse', () => {
        const uri = vscode.Uri.file('/repo/a.ts');
        assert.strictEqual(dedupeSelection([uri, uri, uri]).length, 1);
    });

    test('sibling directories with a shared prefix are both kept', () => {
        // "/repo/src" must not be treated as containing "/repo/src-gen".
        assert.strictEqual(
            dedupeSelection([vscode.Uri.file('/repo/src'), vscode.Uri.file('/repo/src-gen')]).length,
            2,
        );
    });

    test('nesting is collapsed regardless of input order', () => {
        const deduped = dedupeSelection([
            vscode.Uri.file('/repo/a/b/c.ts'),
            vscode.Uri.file('/repo/a'),
        ]);
        assert.deepStrictEqual(deduped.map(u => u.path), ['/repo/a']);
    });

    test('an empty selection stays empty', () => {
        assert.deepStrictEqual(dedupeSelection([]), []);
    });
});
