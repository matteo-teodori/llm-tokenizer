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
 * under a root, and from a root's `settings.json` only its `env` entries for
 * the three variables below: `~/.claude/ide` holds auth lock files.
 */

import * as fs from 'fs';
import * as os from 'os';
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
    /**
     * CLAUDE_CODE_SKIP_PROMPT_HISTORY is set where Claude Code would see it:
     * the environment, Claude Code's environmentVariables setting, or the
     * `env` of a root's settings.json. Then it keeps no transcripts, and
     * there is nothing to read.
     */
    historyDisabled: boolean;
    /** CLAUDE_CODE_DISABLE_1M_CONTEXT is set there: every model is held to a 200K window. */
    largeContextDisabled: boolean;
}

/**
 * This machine's inputs, besides the two settings. Under test the home is a
 * folder in the fixtures that does not exist, so `~/.claude` and its settings
 * file resolve to nothing, and every root must lie in the fixtures or the
 * temporary folder: no test can read the developer's own records.
 */
export function machineRootInputs(test?: { fixtures: string }): Omit<RootInputs, 'setting' | 'editorEnvironment'> {
    return {
        env: process.env,
        home: test ? path.join(test.fixtures, 'claude-home') : os.homedir(),
        platform: process.platform,
        confineTo: test ? [test.fixtures, os.tmpdir()] : undefined,
    };
}

/** settings.json is read for three keys; a file this large is not a settings file. */
const MAX_SETTINGS_BYTES = 1 << 20;

/** The only `env` entries of a settings.json that are kept. */
const SETTINGS_VARIABLES = ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_SKIP_PROMPT_HISTORY', 'CLAUDE_CODE_DISABLE_1M_CONTEXT'] as const;
type SettingsEnv = Partial<Record<(typeof SETTINGS_VARIABLES)[number], string>>;

/** The roots to read, with every candidate and where it came from. */
export function resolveRoots(inputs: RootInputs): ResolvedRoots {
    const homeSettings = settingsEnv(path.join(inputs.home, '.claude', 'settings.json'));
    const proposed: { path: string | null; source: RootSource }[] = [
        { path: inputs.setting.trim() || null, source: 'setting' },
        { path: editorConfigDir(inputs.editorEnvironment, inputs.platform), source: 'editor-environment' },
        { path: inputs.env.CLAUDE_CONFIG_DIR ?? null, source: 'process-environment' },
        { path: homeSettings.CLAUDE_CONFIG_DIR ?? null, source: 'claude-settings' },
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
        // Under test, what is read under the root must stay inside too: its
        // projects or sessions folder, or its settings.json, can be a link
        // that leads out. One that does not exist reads nothing; a link that
        // leads nowhere now could lead out later, so it counts as outside.
        const confined = (p: string, mustExist: boolean) => {
            if (!inputs.confineTo) {
                return true;
            }
            if (!exists(p)) {
                return !mustExist;
            }
            const real = resolved(p);
            return real !== undefined && inputs.confineTo.some(allowed => isInside(real, realPath(allowed)));
        };
        const read = ['projects', 'sessions', 'settings.json'].map(name => path.join(candidate.path, name));
        if (!confined(candidate.path, true) || !read.every(p => confined(p, false))) {
            refused.push(candidate);
            continue;
        }
        const identity = realPath(candidate.path);
        if (!seen.has(identity)) {
            seen.add(identity);
            roots.push(candidate);
        }
    }
    // A root is a configuration folder, read with its own settings.json;
    // ~/.claude's is among them whenever it exists.
    const rootSettings = roots.map(root => settingsEnv(path.join(root.path, 'settings.json')));
    const flag = (name: Exclude<(typeof SETTINGS_VARIABLES)[number], 'CLAUDE_CONFIG_DIR'>) =>
        [inputs.env[name], editorVariable(inputs.editorEnvironment, inputs.platform, name), ...rootSettings.map(e => e[name])].some(isTruthy);
    return {
        candidates,
        roots,
        refused,
        historyDisabled: flag('CLAUDE_CODE_SKIP_PROMPT_HISTORY'),
        largeContextDisabled: flag('CLAUDE_CODE_DISABLE_1M_CONTEXT'),
    };
}

/** What chose a root, in words, for the diagnostics. */
export function sourceLabel(source: RootSource): string {
    switch (source) {
        case 'setting':
            return 'the Claude Code Data Directory setting';
        case 'editor-environment':
            return "CLAUDE_CONFIG_DIR in Claude Code's environmentVariables setting";
        case 'process-environment':
            return 'CLAUDE_CONFIG_DIR';
        case 'claude-settings':
            return 'env.CLAUDE_CONFIG_DIR in ~/.claude/settings.json';
        case 'default':
            return 'the default';
    }
}

/** `p` with the home folder shown as `~`, for display only. */
export function tildePath(p: string, home: string = os.homedir()): string {
    const relative = path.relative(home, p);
    return relative === '' ? '~' : relative.startsWith('..') || path.isAbsolute(relative) ? p : `~${path.sep}${relative}`;
}

/** A flag counts as set when it is 1, true, yes or on, ignoring case: only a hint, for an empty state. */
function isTruthy(value: string | undefined | null): boolean {
    return typeof value === 'string' && ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

/**
 * The CLAUDE_CONFIG_DIR entry of `claudeCode.environmentVariables`: the last
 * absolute one, whether the setting is a list of `{ name, value }` or an
 * object, with the name upper-cased on Windows. Nothing else from the setting
 * is kept.
 */
function editorConfigDir(setting: unknown, platform: NodeJS.Platform): string | null {
    return editorVariable(setting, platform, 'CLAUDE_CONFIG_DIR', v => path.isAbsolute(v));
}

/** The last value of `variable` in `claudeCode.environmentVariables` that `accept` takes. */
function editorVariable(
    setting: unknown,
    platform: NodeJS.Platform,
    variable: string,
    accept: (value: string) => boolean = () => true,
): string | null {
    const wanted = (name: unknown) =>
        typeof name === 'string' && (platform === 'win32' ? name.toUpperCase() : name) === variable;
    let found: string | null = null;
    const consider = (value: unknown) => {
        if (typeof value === 'string' && accept(value)) {
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

/** The `env` entries of a Claude Code settings file that are kept, and nothing else from it. */
function settingsEnv(file: string): SettingsEnv {
    const kept: SettingsEnv = {};
    let fd: number | undefined;
    try {
        // A regular file only: reading a FIFO would block the extension host.
        // Opened without blocking, then checked and read by the descriptor,
        // so that nothing swapped in after a check is read, and no more than
        // the size checked.
        fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size > MAX_SETTINGS_BYTES) {
            return kept;
        }
        const bytes = Buffer.alloc(stat.size);
        const read = fs.readSync(fd, bytes, 0, stat.size, 0);
        const parsed = JSON.parse(bytes.subarray(0, read).toString('utf8')) as unknown;
        const env = (parsed as { env?: unknown } | null)?.env;
        if (typeof env === 'object' && env !== null) {
            for (const name of SETTINGS_VARIABLES) {
                const value = (env as Record<string, unknown>)[name];
                if (typeof value === 'string') {
                    kept[name] = value;
                }
            }
        }
    } catch {
        // Missing, unreadable or not JSON: nothing set there.
    } finally {
        if (fd !== undefined) {
            fs.closeSync(fd);
        }
    }
    return kept;
}

/** Anything at all at `p`, a broken link included. */
function exists(p: string): boolean {
    try {
        fs.lstatSync(p);
        return true;
    } catch {
        return false;
    }
}

function isDirectory(candidate: string): boolean {
    try {
        return fs.statSync(candidate).isDirectory();
    } catch {
        return false;
    }
}

/**
 * The path as the file system holds it. The native call returns the case on
 * disk, so a folder typed in another case on Windows or macOS, as a picked
 * folder or the drive letter often is, is still one root.
 */
function realPath(candidate: string): string {
    try {
        return fs.realpathSync.native(candidate);
    } catch {
        return candidate;
    }
}

/** The path as the file system holds it, or undefined where it leads nowhere. */
function resolved(candidate: string): string | undefined {
    try {
        return fs.realpathSync.native(candidate);
    } catch {
        return undefined;
    }
}

/** Whether `child` is `parent` or inside it, both already resolved. */
function isInside(child: string, parent: string): boolean {
    const relative = path.relative(parent, child);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
