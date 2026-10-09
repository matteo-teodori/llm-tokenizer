/**
 * Where Claude Code keeps its data: the one module that reads the home
 * directory or CLAUDE_CONFIG_DIR. Everything downstream takes roots as
 * arguments, which a source-invariant test enforces.
 *
 * Claude Code 2.1.295 builds its panel's environment from `process.env`, then
 * lets the last absolute CLAUDE_CONFIG_DIR entry of its
 * `claudeCode.environmentVariables` setting override it, and also honours
 * `env.CLAUDE_CONFIG_DIR` in `~/.claude/settings.json`. A terminal CLI can
 * write somewhere else again, so every distinct root that exists is read; the
 * global key makes any overlap harmless. Only `<root>/projects` is ever read
 * under a root: `~/.claude/ide` holds auth lock files.
 */

import * as fs from 'fs';
import * as path from 'path';

export type RootSource = 'setting' | 'editor-environment' | 'process-environment' | 'claude-settings' | 'default';

export interface RootCandidate {
    path: string;
    source: RootSource;
    exists: boolean;
}

export interface RootInputs {
    /** `llm-tokenizer.claudeCodeDataDirectory`. */
    setting: string;
    /**
     * The user-level value of `claudeCode.environmentVariables`, from
     * `inspect().globalValue`: never `get()`, which without Claude Code
     * installed returned a cloned repository's workspace value.
     */
    editorEnvironment: unknown;
    env: NodeJS.ProcessEnv;
    /** `os.homedir()`, or a fixture under test. */
    home: string;
    platform: NodeJS.Platform;
    /** Under test, the only folders a root may be inside. */
    confineTo?: string[];
}

export interface ResolvedRoots {
    /** Every candidate considered, in order, for diagnostics. */
    candidates: RootCandidate[];
    /** The distinct ones that exist: what is read. */
    roots: RootCandidate[];
    /** Candidates outside `confineTo`, never read. */
    refused: RootCandidate[];
}

/** settings.json is read for one key; a file this large is not a settings file. */
const MAX_SETTINGS_BYTES = 1 << 20;

/** The roots to read, with every candidate and where it came from. */
export function resolveRoots(inputs: RootInputs): ResolvedRoots {
    const proposed: { path: string | null; source: RootSource }[] = [
        { path: inputs.setting.trim() || null, source: 'setting' },
        { path: editorConfigDir(inputs.editorEnvironment, inputs.platform), source: 'editor-environment' },
        { path: inputs.env.CLAUDE_CONFIG_DIR ?? null, source: 'process-environment' },
        { path: settingsConfigDir(path.join(inputs.home, '.claude', 'settings.json')), source: 'claude-settings' },
        { path: path.join(inputs.home, '.claude'), source: 'default' },
    ];

    const candidates: RootCandidate[] = [];
    for (const { path: candidate, source } of proposed) {
        // Each is accepted only as an absolute path, as Claude Code does.
        if (candidate && path.isAbsolute(candidate)) {
            const resolved = path.resolve(candidate);
            candidates.push({ path: resolved, source, exists: isDirectory(resolved) });
        }
    }

    const roots: RootCandidate[] = [];
    const refused: RootCandidate[] = [];
    const seen = new Set<string>();
    for (const candidate of candidates) {
        if (!candidate.exists) {
            continue;
        }
        if (inputs.confineTo && !inputs.confineTo.some(allowed => isInside(candidate.path, allowed))) {
            refused.push(candidate);
            continue;
        }
        const identity = realPath(candidate.path);
        if (!seen.has(identity)) {
            seen.add(identity);
            roots.push(candidate);
        }
    }
    return { candidates, roots, refused };
}

/**
 * The CLAUDE_CONFIG_DIR entry of `claudeCode.environmentVariables`: the last
 * absolute one, whether the setting is a list of `{ name, value }` or an
 * object, with the name upper-cased on Windows. Nothing else from the setting
 * is kept.
 */
function editorConfigDir(setting: unknown, platform: NodeJS.Platform): string | null {
    const wanted = (name: unknown) =>
        typeof name === 'string' && (platform === 'win32' ? name.toUpperCase() : name) === 'CLAUDE_CONFIG_DIR';
    let found: string | null = null;
    const consider = (value: unknown) => {
        if (typeof value === 'string' && path.isAbsolute(value)) {
            found = value;
        }
    };
    if (Array.isArray(setting)) {
        for (const entry of setting) {
            if (typeof entry === 'object' && entry !== null && wanted((entry as { name?: unknown }).name)) {
                consider((entry as { value?: unknown }).value);
            }
        }
    } else if (typeof setting === 'object' && setting !== null) {
        for (const [name, value] of Object.entries(setting)) {
            if (wanted(name)) {
                consider(value);
            }
        }
    }
    return found;
}

/** `env.CLAUDE_CONFIG_DIR` from Claude Code's settings file, and nothing else. */
function settingsConfigDir(file: string): string | null {
    try {
        if (fs.statSync(file).size > MAX_SETTINGS_BYTES) {
            return null;
        }
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
        const env = (parsed as { env?: unknown } | null)?.env;
        const value = typeof env === 'object' && env !== null ? (env as Record<string, unknown>).CLAUDE_CONFIG_DIR : undefined;
        return typeof value === 'string' ? value : null;
    } catch {
        return null;
    }
}

function isDirectory(candidate: string): boolean {
    try {
        return fs.statSync(candidate).isDirectory();
    } catch {
        return false;
    }
}

function realPath(candidate: string): string {
    try {
        return fs.realpathSync(candidate);
    } catch {
        return candidate;
    }
}

function isInside(child: string, parent: string): boolean {
    const relative = path.relative(realPath(parent), realPath(child));
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
