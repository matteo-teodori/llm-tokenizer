import * as assert from 'assert';
import { contentSecurityPolicy, createNonce, escapeHtml } from '../../src/html';

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
        // Inline styles are the only inline content allowed.
        assert.ok(!/script-src[^;]*unsafe-inline/.test(csp));
    });

    test('nonces are unpredictable and unique per render', () => {
        const nonces = new Set(Array.from({ length: 50 }, () => createNonce()));
        assert.strictEqual(nonces.size, 50);
        assert.ok([...nonces].every(n => n.length >= 16));
    });
});
