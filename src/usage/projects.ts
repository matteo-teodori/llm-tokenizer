/**
 * Which project a session belongs to, and whether it is in the open workspace.
 *
 * A session's project is its session root: the earliest cwd of its main
 * transcript, cut at the first `.claude/worktrees/` segment, so a session
 * started in a worktree (`claude -w`, EnterWorktree) counts for its
 * repository. Per-record cwd would be wrong: measured, it gave 47 "projects"
 * against 9 real session roots, since Bash `cd` moves about 13 % of main
 * requests into subfolders. A session whose main transcript was never read
 * is Unattributed, under its encoded project folder, which is lossy and never
 * decoded.
 *
 * Pure: the caller resolves real paths, so every platform's rules can be
 * tested on any.
 */

/** A session's project: its session root, or its encoded folder when it has none. */
export type ProjectRef = { kind: 'root'; path: string } | { kind: 'unattributed'; projectDir: string };

const WORKTREES = /[\\/]\.claude[\\/]worktrees(?:[\\/]|$)/;

/**
 * The session root of a session whose main transcript started in `cwd`.
 *
 * Cut at the first `.claude/worktrees/` segment, not the last: a worktree
 * made from inside another worktree still belongs to the outer repository.
 * None of the 13 real main transcripts measured started in a worktree, so
 * this rests on the layout Claude Code documents.
 */
export function sessionRoot(cwd: string): string {
    const cut = WORKTREES.exec(cwd);
    if (!cut) {
        return trimSeparators(cwd);
    }
    const before = cwd.slice(0, cut.index);
    // At a filesystem root, keep its separator: `/` rather than nothing, `C:\` rather than `C:`.
    return trimSeparators(before === '' || /^[A-Za-z]:$/.test(before) ? cwd.slice(0, cut.index + 1) : before);
}

/** The project a session counts for. */
export function projectOf(sessionRootPath: string | null, projectDir: string): ProjectRef {
    return sessionRootPath ? { kind: 'root', path: sessionRootPath } : { kind: 'unattributed', projectDir };
}

/**
 * A path in the form two paths are compared in: one separator, none
 * trailing, and folded where the platform's default filesystem is
 * insensitive to it. Windows folds case and `/`, which also covers `fsPath`
 * lower-casing drive letters; macOS folds case and Unicode normalisation,
 * as APFS does.
 */
export function comparablePath(p: string, platform: NodeJS.Platform): string {
    if (platform === 'win32') {
        return withoutTrailing(p.replace(/\//g, '\\')).toLowerCase();
    }
    const trimmed = withoutTrailing(p);
    return platform === 'darwin' ? trimmed.normalize('NFC').toLowerCase() : trimmed;
}

/** Whether `child` is `folder` or inside it, both already resolved. */
export function isWithin(child: string, folder: string, platform: NodeJS.Platform): boolean {
    const c = comparablePath(child, platform);
    const f = comparablePath(folder, platform);
    if (c === f) {
        return true;
    }
    const separator = platform === 'win32' ? '\\' : '/';
    return c.startsWith(f.endsWith(separator) ? f : f + separator);
}

/** The last segment of a session root, for a label: `app` for `/repo/app`. */
export function projectLabel(project: ProjectRef): string {
    if (project.kind === 'unattributed') {
        return `Unattributed (${project.projectDir})`;
    }
    const segments = project.path.split(/[\\/]/).filter(s => s.length > 0);
    return segments.length > 0 ? segments[segments.length - 1] : project.path;
}

/** `p` without trailing separators, keeping a lone `/`: `C:\` becomes `C:`. */
function withoutTrailing(p: string): string {
    let end = p.length;
    while (end > 1 && (p[end - 1] === '/' || p[end - 1] === '\\')) {
        end--;
    }
    return p.slice(0, end);
}

/**
 * `p` without trailing separators, for display, but never shorter than a
 * filesystem root: `/`, `C:\` and `\\server\share\` stay as they are.
 */
function trimSeparators(p: string): string {
    let end = p.length;
    while (end > 1 && (p[end - 1] === '/' || p[end - 1] === '\\') && !isRoot(p.slice(0, end))) {
        end--;
    }
    return p.slice(0, end);
}

function isRoot(p: string): boolean {
    return /^[\\/]$/.test(p) || /^[A-Za-z]:[\\/]$/.test(p) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+[\\/]$/.test(p);
}
