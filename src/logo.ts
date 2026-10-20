/**
 * The logo's T at icon size, which scripts/logo-icons.mjs makes from
 * icon.png: the tab icon of the extension's pages. The manifest names the
 * same files for the editor title's Show Claude Code Usage.
 */

import * as vscode from 'vscode';

export function logoIcon(extensionUri: vscode.Uri): { light: vscode.Uri; dark: vscode.Uri } {
    return {
        light: vscode.Uri.joinPath(extensionUri, 'media', 'logo-light.png'),
        dark: vscode.Uri.joinPath(extensionUri, 'media', 'logo-dark.png'),
    };
}
