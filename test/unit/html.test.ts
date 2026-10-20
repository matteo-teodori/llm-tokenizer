import * as assert from 'assert';
import * as vm from 'vm';
import { PAGE_TEXT_HELPERS, contentSecurityPolicy, createNonce, embed, escapeHtml } from '../../src/html';

suite('escapeHtml', () => {
    test('neutralises the script-injection payloads a file name can carry', () => {
        // On macOS and Linux these are all legal file names, and every one of
        // them used to reach the webview verbatim.
        const payloads = [
            '<img src=x onerror=alert(1)>.ts',
            '</script><script>alert(1)</script>.ts',
            '" onmouseover="alert(1)',
            "' onfocus='alert(1)",
        ];

        for (const payload of payloads) {
            const escaped = escapeHtml(payload);
            assert.ok(!escaped.includes('<'), `unescaped < in ${escaped}`);
            assert.ok(!escaped.includes('>'), `unescaped > in ${escaped}`);
            assert.ok(!escaped.includes('"'), `unescaped " in ${escaped}`);
            assert.ok(!escaped.includes("'"), `unescaped ' in ${escaped}`);
        }
    });

    test('escapes ampersands first so entities are not double-decoded', () => {
        assert.strictEqual(escapeHtml('&lt;'), '&amp;lt;');
    });

    test('leaves ordinary file names alone', () => {
        assert.strictEqual(escapeHtml('src/tokenizer/registry.ts'), 'src/tokenizer/registry.ts');
        assert.strictEqual(escapeHtml('componente-àccentato.tsx'), 'componente-àccentato.tsx');
    });

    test('handles backslashes in Windows paths without mangling them', () => {
        // The old escapePathForHtml doubled backslashes, which corrupted the
        // path that came back from the webview.
        assert.strictEqual(escapeHtml('C:\\repo\\src\\main.ts'), 'C:\\repo\\src\\main.ts');
    });
});

suite('content security policy', () => {
    test('denies everything by default and only re-allows the nonced script', () => {
        const nonce = createNonce();
        const csp = contentSecurityPolicy(nonce);

        assert.ok(csp.includes("default-src 'none'"));
        assert.ok(csp.includes(`script-src 'nonce-${nonce}'`));
        assert.ok(!csp.includes('unsafe-eval'));
        // Not covered by default-src.
        assert.ok(csp.includes("form-action 'none'") && csp.includes("base-uri 'none'"));
        // Inline styles are the only inline content allowed.
        assert.ok(!/script-src[^;]*unsafe-inline/.test(csp));
    });

    test('nonces are unpredictable and unique per render', () => {
        const nonces = new Set(Array.from({ length: 50 }, () => createNonce()));
        assert.strictEqual(nonces.size, 50);
        assert.ok([...nonces].every(n => n.length >= 16));
    });
});

suite('embed', () => {
    test('data cannot close the script block it is embedded in', () => {
        const embedded = embed({ name: '</script><script>alert(1)</script>' });
        assert.ok(!embedded.includes('</script'), embedded);
        assert.ok(!embedded.includes('<'), embedded);
    });

    test('line and paragraph separators cannot end a statement early', () => {
        // Legal inside a JSON string, but line terminators in JavaScript.
        const embedded = embed('a\u2028b\u2029c');
        assert.ok(!/[\u2028\u2029]/.test(embedded), 'a raw separator survived');
    });

    test('what is embedded reads back unchanged', () => {
        const value = { path: 'src/<a>.ts', tokens: 12, note: 'x\u2028y', nested: [1, null, 'é'] };
        assert.deepStrictEqual(JSON.parse(embed(value)), value);
    });
});

suite('page text helpers', () => {
    // The snippet runs inside the page, so it is tested by running it.
    const helpers = vm.runInNewContext(`${PAGE_TEXT_HELPERS}; ({ escapeText, cell, csv, pasteCell })`) as {
        escapeText(s: string): string;
        cell(value: unknown): string;
        csv(value: unknown): string;
        pasteCell(value: unknown): string;
    };

    test('escapeText escapes exactly as escapeHtml does', () => {
        for (const text of ['<img src=x onerror=alert(1)>', '" onmouseover="x', "' x", '&lt;', 'plain/path.ts']) {
            assert.strictEqual(helpers.escapeText(text), escapeHtml(text), text);
        }
    });

    test('a tab or line break in a name cannot act as a separator', () => {
        assert.strictEqual(helpers.cell('a\tb'), 'a b');
        assert.strictEqual(helpers.cell('a\r\nb\n\nc'), 'a b c');
        assert.strictEqual(helpers.cell(42), '42');
    });

    test('a CSV field is quoted and cannot be read as a formula', () => {
        for (const lead of ['=', '+', '-', '@']) {
            assert.strictEqual(helpers.csv(`${lead}cmd`), `"'${lead}cmd"`, lead);
        }
        assert.strictEqual(helpers.csv('a=b'), '"a=b"', 'only a leading sign is defused');
        assert.strictEqual(helpers.csv('say "hi"'), '"say ""hi"""');
        assert.strictEqual(helpers.csv('a\tb\nc'), '"a b c"');
        assert.strictEqual(helpers.csv(7), '"7"');
    });

    test('a copied cell cannot be pasted into a spreadsheet as a formula either', () => {
        // Copy is tab-separated, and pasted it is read cell by cell.
        for (const lead of ['=', '+', '-', '@']) {
            assert.strictEqual(helpers.pasteCell(`${lead}HYPERLINK("x")`), `'${lead}HYPERLINK("x")`, lead);
        }
        assert.strictEqual(helpers.pasteCell('a=b'), 'a=b');
        assert.strictEqual(helpers.pasteCell('a\tb'), 'a b');
    });

    test('the guard looks past spaces and invisible characters, at full-width signs, and at a leading quote', () => {
        // A paste reads "…" as one quoted cell, and the formula inside it.
        for (const text of ['"=1+1"', ' =1+1', '\t=1+1', '\u200b=1+1', '\ufeff=1+1', '\u3000+1', '\uff1d1+1', '\uff0b1', '\uff0d1', '\uff20A1', '\uff02=1']) {
            assert.ok(helpers.pasteCell(text).startsWith("'"), JSON.stringify(text));
        }
        // Controls, direction and other format marks, combining marks, blank letters.
        const leads = ['\u0001', '\u0008', '\u000e', '\u001f', '\u007f', '\u0085', '\u00ad', '\u200e', '\u200f', '\u202a', '\u202e', '\u2061', '\u2066', '\u3164', '\ufe0f', '\u0301', '\u115f', '\uffa0', '\u2800'];
        for (const lead of leads) {
            assert.ok(helpers.pasteCell(`${lead}=1+1`).startsWith("'"), JSON.stringify(lead));
        }
        // The signs in their small, raised and lowered forms, and the minus sign.
        for (const sign of ['\ufe62', '\ufe63', '\ufe66', '\ufe6b', '\u207a', '\u207c', '\u208c', '\u2212']) {
            assert.ok(helpers.pasteCell(`${sign}1`).startsWith("'"), JSON.stringify(sign));
        }
        // A control anywhere is a space, as a tab is.
        assert.strictEqual(helpers.cell('a\u0001b\u007fc'), 'a b c');
        for (const text of ['claude-opus-5-5', 'a "quoted" word', '1278', 'repo']) {
            assert.strictEqual(helpers.pasteCell(text), text);
        }
        // The CSV, built on it, keeps its quoting as well.
        assert.strictEqual(helpers.csv('"=2+2"'), `"'""=2+2"""`);
    });
});
