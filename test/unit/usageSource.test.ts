import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/** The usage sources, read as text. */
const USAGE = path.join(__dirname, '..', '..', '..', 'src', 'usage');

function sources(): { name: string; text: string }[] {
    return fs
        .readdirSync(USAGE)
        .filter(name => name.endsWith('.ts'))
        .map(name => ({ name, text: fs.readFileSync(path.join(USAGE, name), 'utf8') }));
}

/** The modules whose rules must hold without a file system or an editor. */
const CORE = ['types.ts', 'provenance.ts', 'modelIds.ts', 'accounting.ts', 'aggregate.ts', 'projects.ts', 'report.ts'];

suite('usage source invariants', () => {
    test('usage never goes through the tokenizer side of the registry', () => {
        // Aliases map retired ids onto different live models, and the
        // tokenizer's types describe counts the extension makes itself, not
        // ones Claude Code reported. Labels come from modelById.
        for (const { name, text } of sources()) {
            for (const banned of ['findModel', 'defaultModel', 'MODEL_ALIASES', 'TokenCount', 'TokenizerService']) {
                assert.ok(!new RegExp(`\\b${banned}\\b`).test(text), `${name} refers to ${banned}`);
            }
        }
    });

    test('the core imports nothing but itself: no file system, no editor', () => {
        const all = sources().map(s => s.name);
        for (const name of CORE) {
            assert.ok(all.includes(name), `${name} is missing`);
        }
        for (const { name, text } of sources().filter(s => CORE.includes(s.name))) {
            const imports = [...text.matchAll(/from\s+'([^']+)'/g)].map(m => m[1]);
            for (const module of imports) {
                assert.ok(module.startsWith('./'), `${name} imports ${module}`);
            }
        }
    });
});
