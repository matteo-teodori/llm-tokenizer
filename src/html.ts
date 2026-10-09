/**
 * HTML escaping for the extension's webview pages.
 *
 * Everything a page renders — file names, folder names, skip reasons — is
 * workspace-controlled. On macOS and Linux a file may legitimately be named
 * `<img src=x onerror=alert(1)>.ts`, and the webviews run with `enableScripts`
 * enabled, so unescaped interpolation is script execution inside the extension's
 * own webview context.
 */

import * as crypto from 'crypto';

const HTML_ESCAPES: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
};

/**
 * Escape text for interpolation into element content or a quoted attribute.
 *
 * Both `"` and `'` are escaped so the result is safe in either quoting style.
 */
export function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, char => HTML_ESCAPES[char]);
}

/** A fresh nonce for the webview's Content-Security-Policy. */
export function createNonce(): string {
    return crypto.randomBytes(16).toString('base64');
}

/**
 * The webview's CSP.
 *
 * `default-src 'none'` denies everything, then only the inline script bearing
 * `nonce` and VS Code's own theme styles are allowed back in. No network, no
 * remote images, no eval.
 */
export function contentSecurityPolicy(nonce: string): string {
    return [
        "default-src 'none'",
        "style-src 'unsafe-inline'",
        `script-src 'nonce-${nonce}'`,
    ].join('; ');
}

/**
 * Embed data for a page's own script.
 *
 * `</script>` inside a string would end the block early, and U+2028/9 are line
 * terminators in JavaScript but legal inside JSON strings.
 */
export function embed(value: unknown): string {
    return JSON.stringify(value)
        .replace(/</g, '\\u003c')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
}

/**
 * Text helpers for a page's own script, as source to paste into it. A page
 * that builds rows from embedded data escapes its own text, and its exports
 * must not let a file name act as a separator or a formula.
 *
 * - `escapeText(s)` escapes as `escapeHtml` does, for `innerHTML`.
 * - `cell(value)` turns tabs and line breaks into a space. A path is whatever
 *   the file system allowed, which on Unix includes tabs and newlines; left
 *   in, one such name shifts every following column or splits the row in two.
 * - `csv(value)` quotes a CSV field. Quoting alone does not stop a spreadsheet
 *   treating a cell as a formula: a file named `=cmd|'/c calc'!A1.ts` is
 *   executable content once the export is opened, so a leading `= + - @` gets
 *   an apostrophe, which forces it to text.
 */
export const PAGE_TEXT_HELPERS = `
    function escapeText(s) {
        return s.replace(/[&<>"']/g, c =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function cell(value) {
        return String(value).replace(/[\\t\\r\\n]+/g, ' ');
    }

    function csv(value) {
        const text = cell(value);
        const escaped = /^[=+\\-@]/.test(text) ? "'" + text : text;
        return '"' + escaped.replace(/"/g, '""') + '"';
    }
`;
