import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';
import * as vscode from 'vscode';

import { countFile, type FileCounting } from '../../src/extension';
import { CountCache } from '../../src/countCache';
import { MAX_TOKENIZED_FILE_BYTES } from '../../src/constants';
import { findModel, type ModelInfo } from '../../src/tokenizer/registry';

function model(id: string): ModelInfo {
    const found = findModel(id);
    assert.ok(found, `test refers to unknown model ${id}`);
    return found;
}

/**
 * A stand-in for the tokenizer worker, counting characters and reporting
 * `exact` as told, with a cache of its own. `asked` is how many files reached it.
 */
function counting(exact: boolean): FileCounting & { asked: number } {
    const using = {
        asked: 0,
        cache: new CountCache(),
        count: (text: string) => {
            using.asked++;
            return Promise.resolve({ count: text.length, exact });
        },
        debug: () => undefined,
    };
    return using;
}

suite('counting a file', () => {
    let dir: string;

    suiteSetup(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-tokenizer-count-'));
    });

    suiteTeardown(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });

    /** A file on disk, and the stat a scan would hand over with it. */
    async function file(name: string, text: string): Promise<{ uri: vscode.Uri; stat: vscode.FileStat }> {
        const uri = vscode.Uri.file(path.join(dir, name));
        await fs.writeFile(uri.fsPath, text);
        return { uri, stat: await vscode.workspace.fs.stat(uri) };
    }

    /** Count the same unchanged file as three scans would, and say how often the worker was asked. */
    async function threeScans(name: string, id: string, exactNow: boolean, exact: boolean): Promise<number> {
        const using = counting(exact);
        const { uri, stat } = await file(name, 'const a = 1;');
        for (let scan = 0; scan < 3; scan++) {
            assert.deepStrictEqual(await countFile(uri, stat, model(id), exactNow, () => true, using), { count: 12, exact });
        }
        return using.asked;
    }

    test('a downloadable model without its vocabulary keeps its estimate, so a rescan reads nothing again', async () => {
        // Downloads turned off, offline, or a proxy in the way: the estimate
        // is the model's answer until a vocabulary arrives, and the accuracy
        // event that comes with one empties the cache. Kept only for a model
        // with no published tokenizer, every rescan read every file again and
        // sent it to the worker to divide its length: measured on 10,000
        // files, 1.6-1.9 s of each warm rescan against 0.5 s.
        assert.strictEqual(await threeScans('hf.ts', 'gemini-2.5-pro', false, false), 1);
        assert.strictEqual(await threeScans('rank.ts', 'kimi-k3', false, false), 1);
    });

    test('an estimate from a model that can count exactly is a degraded count, and is asked for again', async () => {
        // The worker crashed, timed out or errored. A bundled model fires no
        // event that would clear the guess, and a downloadable one whose
        // vocabulary is there has nothing to wait for either.
        assert.strictEqual(await threeScans('tiktoken.ts', 'gpt-5.6-sol', true, false), 3);
        assert.strictEqual(await threeScans('loaded.ts', 'gemini-2.5-pro', true, false), 3);
    });

    test('an exact count, and an estimate from a model with no published tokenizer, are kept', async () => {
        assert.strictEqual(await threeScans('exact.ts', 'gpt-5.6-sol', true, true), 1);
        assert.strictEqual(await threeScans('heuristic.ts', 'claude-opus-5', false, false), 1);
    });

    test('a superseded scan caches nothing', async () => {
        const using = counting(true);
        const { uri, stat } = await file('superseded.ts', 'const a = 1;');
        await countFile(uri, stat, model('gpt-5.6-sol'), true, () => false, using);
        assert.strictEqual(using.cache.size, 0);
    });

    test('the stat it is given is the one it goes by', async () => {
        // The project scan has one already; a second stat of every file in
        // here doubled what a warm rescan spent on them for the same answer.
        const using = counting(true);
        const gpt = model('gpt-5.6-sol');
        const { uri, stat } = await file('given.ts', 'const a = 1;');

        // Too large, or not a regular file, by the stat it was handed: refused
        // without a read, though the file on disk is small and plain.
        const handed = (type: vscode.FileType, size: number): vscode.FileStat => ({ type, size, mtime: stat.mtime, ctime: stat.ctime });
        assert.deepStrictEqual(await countFile(uri, handed(stat.type, MAX_TOKENIZED_FILE_BYTES + 1), gpt, true, () => true, using), { skip: 'too-large' });
        assert.deepStrictEqual(await countFile(uri, handed(vscode.FileType.Unknown, stat.size), gpt, true, () => true, using), { skip: 'unreadable' });
        assert.strictEqual(using.asked, 0);

        // And a cached count is served by the stat's mtime alone, without
        // going back to the disk, where the file has since gone.
        await countFile(uri, stat, gpt, true, () => true, using);
        await fs.rm(uri.fsPath);
        assert.deepStrictEqual(await countFile(uri, stat, gpt, true, () => true, using), { count: 12, exact: true });
        assert.strictEqual(using.asked, 1);
    });
});
