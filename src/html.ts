/**
 * HTML escaping for the summary webview.
 *
 * Everything the webview renders — file names, folder names, skip reasons — is
 * workspace-controlled. On macOS and Linux a file may legitimately be named
 * `<img src=x onerror=alert(1)>.ts`, and the webview runs with `enableScripts`
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
