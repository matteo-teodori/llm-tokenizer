/**
 * The README's images, from a real VS Code running the packaged extension on
 * an invented home, which demo.mjs writes first:
 *
 *   node capture.mjs <work dir> <vsix> <VS Code .app> <out dir> [dark|light|gif]
 *
 * Writes token-summary-{dark,light}.png, usage-panel-{dark,light}.png,
 * usage-status-{dark,light}.png and the GIF's frames, gif-NN.png with gif.txt
 * and gif-final-delay.txt for gif.sh, to <out dir>. The last argument makes
 * only those.
 *
 * Nothing of the developer's own reaches it, and it checks that:
 * - HOME and CLAUDE_CONFIG_DIR are the demo home's, the profile and the
 *   extensions folder are new, the keychain is a mock and the login shell's
 *   environment is not read; it refuses to run where Claude Code's managed
 *   settings could name another data folder;
 * - before any page of the usage panel is captured, it must show exactly the
 *   demo's requests, sessions and projects, and the extension must have read
 *   one data folder, the demo's;
 * - no text shown, the webviews' and the input boxes' included, may name this
 *   machine, its user or a real path, before the capture or after it.
 */

import { chromium } from 'playwright-core';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { claimWork, refuseEarlyHours } from './guard.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const MODES = ['dark', 'light', 'gif'];
if (process.argv.length < 6 || (process.argv[6] !== undefined && !MODES.includes(process.argv[6]))) {
    throw new Error('usage: node capture.mjs <work dir> <vsix> <VS Code .app> <out dir> [dark|light|gif]');
}
const [work, vsix, app, out] = process.argv.slice(2, 6).map(p => resolve(p));
const only = process.argv[6];

// ── Refusals, before anything is written ──────────────────────────────────
const realHome = os.homedir();
const home = join(work, 'home');
refuseEarlyHours();
// Claude Code's managed settings are read wherever HOME is, and can name
// another CLAUDE_CONFIG_DIR: with them on this machine, the demo home would
// not be the only data folder the extension finds.
for (const managed of ['/Library/Application Support/ClaudeCode', '/etc/claude-code']) {
    if (existsSync(managed)) {
        throw new Error(`${managed} exists: its settings could point the extension at real records`);
    }
}
claimWork(work);
mkdirSync(out, { recursive: true });

// The invented home, written now: its records are dated from now, and the
// running session has to be today's when the pages are drawn.
const demo = JSON.parse(execFileSync(process.execPath, [join(here, 'demo.mjs'), work], { encoding: 'utf8' }));
const claude = join(home, '.claude');
const workspace = demo.workspace;

// ── What would give this machine away, were it shown ──────────────────────
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function giveaways() {
    const run = (cmd, args) => {
        try {
            return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        } catch {
            return '';
        }
    };
    const real = p => {
        try {
            return realpathSync(p);
        } catch {
            return p;
        }
    };
    const tmp = process.env.TMPDIR ?? '';
    // Paths, found anywhere in a text.
    const paths = [realHome, work, real(work), tmp, tmp && real(tmp), '/users/', '/private/', '/var/folders/', 'claude-501'];
    // Names, found as words: "ken" is in "tokens", and must still be found alone.
    const names = [
        os.hostname(),
        os.hostname().split('.')[0],
        os.userInfo().username,
        run('id', ['-F']),
        run('git', ['-C', here, 'config', 'user.name']),
        run('git', ['-C', here, 'config', 'user.email']),
        run('git', ['config', '--global', 'user.name']),
        run('git', ['config', '--global', 'user.email']),
        run('scutil', ['--get', 'ComputerName']),
        run('scutil', ['--get', 'LocalHostName']),
    ];
    const clean = list => [...new Set(list.filter(s => s && s.length >= 2).map(s => s.toLowerCase().replace(/\/+$/, '')))];
    return {
        paths: clean(paths),
        names: clean(names).map(n => new RegExp(`(^|[^\\p{L}\\p{N}])${escape(n)}($|[^\\p{L}\\p{N}])`, 'u')),
    };
}
const GIVEAWAYS = giveaways();

const env = {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: home,
    CLAUDE_CONFIG_DIR: claude,
    // The system's own: VS Code's sockets in it must fit in 103 characters.
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    TZ: 'UTC',
    LANG: 'en_US.UTF-8',
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const contents = join(app, 'Contents');
const extensions = join(work, 'ext');

// ── Everything started here is stopped, however the script ends ───────────
const children = new Set();
const browsers = new Set();
const scratch = new Set();
let sessionFile;
function stopAll() {
    for (const child of children) {
        try {
            child.kill('SIGKILL');
        } catch {
            // Gone already.
        }
    }
    if (sessionFile) {
        rmSync(sessionFile, { force: true });
    }
    for (const folder of scratch) {
        rmSync(folder, { recursive: true, force: true });
    }
}
process.on('exit', stopAll);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
        // The DevTools connections first, so Playwright removes its own temporary files.
        const closing = [...browsers].map(b => b.close().catch(() => undefined));
        void Promise.race([Promise.all(closing), sleep(3_000)]).finally(() => process.exit(130));
    });
}

/** Stop a child: asked first, killed after 5 s. */
async function stop(child) {
    if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        const ended = await Promise.race([child.exited.then(() => true), sleep(5_000).then(() => false)]);
        if (!ended) {
            child.kill('SIGKILL');
            await child.exited;
        }
    }
    children.delete(child);
}

function install() {
    rmSync(extensions, { recursive: true, force: true });
    const profile = mkdtempSync(join(os.tmpdir(), 'llmt-install-'));
    scratch.add(profile);
    try {
        execFileSync(join(contents, 'Resources', 'app', 'bin', 'code'), ['--install-extension', vsix, '--force', `--extensions-dir=${extensions}`, `--user-data-dir=${profile}`], {
            env,
            stdio: 'inherit',
        });
    } finally {
        rmSync(profile, { recursive: true, force: true });
        scratch.delete(profile);
    }
}

function settings(theme) {
    return {
        'workbench.colorTheme': theme === 'dark' ? 'Default Dark Modern' : 'Default Light Modern',
        'workbench.startupEditor': 'none',
        'workbench.tips.enabled': false,
        'workbench.welcomePage.walkthroughs.openOnInstall': false,
        'workbench.secondarySideBar.defaultVisibility': 'hidden',
        'workbench.editor.enablePreview': false,
        'workbench.enableExperiments': false,
        'workbench.settings.enableNaturalLanguageSearch': false,
        'chat.disableAIFeatures': true,
        'chat.commandCenter.enabled': false,
        'window.menuStyle': 'custom',
        'window.restoreWindows': 'none',
        'window.commandCenter': true,
        'security.workspace.trust.enabled': false,
        'telemetry.telemetryLevel': 'off',
        'update.mode': 'none',
        'update.showReleaseNotes': false,
        'extensions.autoUpdate': false,
        'extensions.autoCheckUpdates': false,
        'extensions.ignoreRecommendations': true,
        'git.enabled': false,
        'npm.autoDetect': 'off',
        'json.schemaDownload.enable': false,
        'typescript.disableAutomaticTypeAcquisition': true,
        'editor.minimap.enabled': false,
        'editor.lightbulb.enabled': 'off',
        'editor.hover.enabled': false,
        'editor.cursorBlinking': 'solid',
        'llm-tokenizer.enableClaudeCodeUsage': true,
        'llm-tokenizer.showClaudeCodeUsageInStatusBar': true,
        'llm-tokenizer.downloadTokenizers': false,
        'llm-tokenizer.defaultModel': 'gpt-5.6-sol',
    };
}

/** A running process for the live session to name: the status item shows only a running session. */
function liveSession() {
    const holder = spawn('/bin/sleep', ['3600'], { stdio: 'ignore' });
    holder.exited = new Promise(r => holder.once('exit', r));
    children.add(holder);
    sessionFile = join(claude, 'sessions', `${holder.pid}.json`);
    writeFileSync(sessionFile, JSON.stringify({ pid: holder.pid, pidDomain: process.platform, sessionId: demo.liveSession, cwd: workspace, status: 'busy', updatedAt: Date.now() }));
    return holder;
}

/**
 * A profile of its own for each run. Beside this script when its IPC socket,
 * `<profile>/<version>-main.sock`, fits in the 103 characters macOS allows,
 * in the system's temporary folder when it does not, removed after the run.
 */
function profileFor(name) {
    const beside = join(here, '.p', name);
    if (`${beside}/1.14-main.sock`.length <= 100) {
        rmSync(beside, { recursive: true, force: true });
        mkdirSync(join(beside, 'User'), { recursive: true });
        return { profile: beside, temporary: false };
    }
    const profile = mkdtempSync(join(os.tmpdir(), `llmt-${name}-`));
    scratch.add(profile);
    mkdirSync(join(profile, 'User'), { recursive: true });
    return { profile, temporary: true };
}

/** Every text shown in every frame, the input boxes' too: none may name this machine. */
async function checkShown(page, what, mustRead) {
    const read = new Set();
    for (const frame of page.frames()) {
        let text;
        for (let attempt = 0; attempt < 2 && text === undefined; attempt++) {
            try {
                text = await frame.evaluate(() => {
                    const boxes = [...document.querySelectorAll('input, textarea')].map(i => `${i.value} ${i.placeholder ?? ''}`);
                    return [document.body?.innerText ?? '', ...boxes].join('\n');
                });
            } catch (error) {
                if (frame.isDetached()) {
                    break;
                }
                if (attempt === 1) {
                    throw new Error(`${what}: a frame could not be read`, { cause: error });
                }
                await sleep(300);
            }
        }
        if (text === undefined) {
            continue;
        }
        read.add(frame);
        const lower = text.toLowerCase();
        if (GIVEAWAYS.paths.some(p => lower.includes(p)) || GIVEAWAYS.names.some(n => n.test(lower))) {
            throw new Error(`${what}: the page shows a path or a name of this machine`);
        }
    }
    for (const frame of mustRead) {
        if (!read.has(frame)) {
            throw new Error(`${what}: the page's own frame was not read`);
        }
    }
    // Text drawn on a canvas is not in any frame's text: a terminal's prompt.
    if (await page.locator('.xterm').count()) {
        throw new Error(`${what}: a terminal is open`);
    }
}

/** The webview frame holding `selector`, drawn at the scale the PNGs are made at. */
async function webview(page, selector, timeout = 30_000) {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
        for (const frame of page.frames()) {
            let found = false;
            try {
                found = (await frame.$(selector)) !== null;
            } catch {
                // A frame that went while it was asked.
            }
            if (found) {
                const ratio = await frame.evaluate(() => devicePixelRatio);
                if (ratio !== 2) {
                    throw new Error(`a webview is drawn at ${ratio}x, not 2x`);
                }
                return frame;
            }
        }
        await sleep(200);
    }
    throw new Error(`no webview with ${selector}`);
}

/**
 * VS Code started on its own, and reached through its DevTools port: a
 * release build refuses the Node inspector that Playwright's Electron
 * launcher needs. Every renderer, the webviews' included, draws at 2x, as on
 * a Retina display, and in sRGB, whatever display this runs on.
 */
async function launch(theme, size) {
    const { profile, temporary } = profileFor(`${theme[0]}${size.width}`);
    writeFileSync(join(profile, 'User', 'settings.json'), JSON.stringify(settings(theme), null, 4));
    const logFile = join(work, `code-${theme}-${size.width}.log`);
    const log = openSync(logFile, 'w');
    const child = spawn(
        join(contents, 'MacOS', 'Code'),
        [
            workspace,
            `--user-data-dir=${profile}`,
            `--extensions-dir=${extensions}`,
            '--remote-debugging-port=0',
            '--force-device-scale-factor=2',
            '--force-color-profile=srgb',
            '--use-mock-keychain',
            '--force-disable-user-env',
            '--disable-workspace-trust',
            '--skip-welcome',
            '--skip-release-notes',
            '--disable-telemetry',
        ],
        { env, stdio: ['ignore', log, log] },
    );
    child.exited = new Promise(r => child.once('exit', r));
    children.add(child);
    let browser;
    const close = async () => {
        if (browser) {
            await browser.close().catch(() => undefined);
            browsers.delete(browser);
        }
        await stop(child);
        if (temporary) {
            rmSync(profile, { recursive: true, force: true });
            scratch.delete(profile);
        }
    };
    try {
        // Port 0: the port the system gave, as VS Code's log says it.
        let url;
        for (let i = 0; i < 120 && !url; i++) {
            await sleep(500);
            url = /DevTools listening on (ws:\/\/\S+)/.exec(readFileSync(logFile, 'utf8'))?.[1];
            if (child.exitCode !== null) {
                throw new Error(`VS Code ended (${child.exitCode}); see ${logFile}`);
            }
        }
        if (!url) {
            throw new Error('VS Code opened no DevTools port');
        }
        browser = await chromium.connectOverCDP(url);
        browsers.add(browser);
        let page;
        for (let i = 0; i < 120 && !page; i++) {
            page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes('workbench'));
            if (!page) {
                await sleep(500);
            }
        }
        if (!page) {
            throw new Error('VS Code opened no window');
        }
        await page.waitForSelector('.monaco-workbench', { timeout: 90_000 });
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: 2, mobile: false });
        sessions.set(page, cdp);
        // The extension's status items: the workspace total, and the session's context.
        const started = Date.now();
        for (;;) {
            const texts = (await page.locator('.statusbar-item').allInnerTexts()).join(' | ');
            if (/K tokens/.test(texts) && texts.includes('532.8K')) {
                break;
            }
            if (Date.now() - started > 60_000) {
                throw new Error(`the status items did not show: ${texts}`);
            }
            await sleep(250);
        }
        return { page, profile, close };
    } catch (error) {
        await close();
        throw error;
    }
}

/** Each page's DevTools session, which captures at the emulated scale where Playwright's capture does not. */
const sessions = new WeakMap();

/**
 * Where the mouse rests between steps: the activity bar's empty stretch,
 * which shows no hover. Over the explorer, its folder actions would show.
 */
async function rest(page) {
    await page.mouse.move(24, 500);
    await sleep(900);
}

/**
 * Checked, captured, and checked again: what changed in between is caught
 * too. `crop`, in CSS px, is cut out of the whole capture afterwards: a
 * capture clipped by DevTools lost the status item's hover background.
 */
async function shoot(page, file, { crop, frames = [] } = {}) {
    await checkShown(page, file, frames);
    const { data } = await sessions.get(page).send('Page.captureScreenshot', { format: 'png' });
    await checkShown(page, file, frames);
    if (crop) {
        const whole = join(work, `whole-${file}`);
        writeFileSync(whole, Buffer.from(data, 'base64'));
        const [x, y, w, h] = [crop.x, crop.y, crop.width, crop.height].map(v => v * 2);
        execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', whole, '-vf', `crop=${w}:${h}:${x}:${y}`, join(out, file)]);
        rmSync(whole, { force: true });
    } else {
        writeFileSync(join(out, file), Buffer.from(data, 'base64'));
    }
    console.log(`captured ${file}`);
}

const row = (page, name) => page.locator(`.explorer-folders-view .monaco-list-row[aria-label="${name}"]`).first();

/** The explorer as the images show it: docs and src open, cart.ts open in an editor, which has the focus. */
async function openCart(page) {
    for (const folder of ['docs', 'src']) {
        const r = row(page, folder);
        await r.waitFor();
        if ((await r.getAttribute('aria-expanded')) !== 'true') {
            await r.click();
        }
    }
    await row(page, 'cart.ts').click();
    await page.locator('.tabs-container .tab', { hasText: 'cart.ts' }).first().waitFor();
    // The editor's focus, not the explorer's, whose folder actions would show.
    await page.keyboard.press('Meta+1');
    // The file's own count beside the workspace total.
    const counts = page.locator('.statusbar-item', { hasText: / tokens/ });
    for (let i = 0; (await counts.count()) < 2; i++) {
        if (i === 100) {
            throw new Error("the file's own count did not show");
        }
        await sleep(100);
    }
    await sleep(800);
}

/**
 * No row cut by the page's bottom edge: shown whole if that costs at most
 * `down` px of the space at the top, else pushed below the edge. A table's
 * rows touch, so the edge is put on the line between two of them; what a
 * fraction of a pixel leaves of the next row is its padding.
 */
async function uncut(frame, down) {
    const left = await frame.evaluate(margin => {
        const cutRow = () =>
            [...document.querySelectorAll('tbody tr, .row')].find(r => {
                const box = r.getBoundingClientRect();
                return box.height > 0 && box.top < innerHeight - 1 && box.bottom > innerHeight + 1;
            });
        const cut = cutRow();
        if (cut) {
            const box = cut.getBoundingClientRect();
            window.scrollBy(0, box.bottom - innerHeight <= margin ? Math.ceil(box.bottom - innerHeight) : -Math.ceil(innerHeight - box.top));
        }
        return cutRow() !== undefined;
    }, down);
    if (left) {
        throw new Error('a row is still cut by the bottom edge');
    }
    await sleep(400);
}

async function tokenSummary(page, theme) {
    await row(page, 'docs').click();
    if ((await row(page, 'docs').getAttribute('aria-expanded')) !== 'true') {
        await row(page, 'docs').click();
    }
    await row(page, 'README.md').click({ modifiers: ['Shift'] });
    await row(page, 'README.md').click({ button: 'right' });
    await page.locator('.context-view .action-item', { hasText: 'Count Tokens' }).first().click();
    const summary = await webview(page, 'input#filter');
    await summary.waitForFunction(count => new RegExp(`(^|\\n)${count}\\nCounted`).test(document.body.innerText), demo.workspaceFiles);
    // The page's own top padding takes the nudge.
    await uncut(summary, 24);
    await rest(page);
    await shoot(page, `token-summary-${theme}.png`, { frames: [summary] });
    await page.keyboard.press('Meta+W');
    await sleep(500);
}

async function openUsage(page) {
    await row(page, 'cart.ts').click();
    await sleep(300);
    await page.locator('.editor-actions [aria-label="Show Claude Code Usage"]').first().click();
    return webview(page, 'button[data-range="30d"]');
}

/** Days drawn as columns, per range: what shows that the page holds the chosen range's figures. */
const COLUMNS = { today: 1, '7d': 7, '30d': 30 };

/** Until the history is read, and the page shows a total: Refresh not busy, no total marked as a lower bound. */
async function readThrough(usage) {
    await usage.waitForSelector('.hero-value', { timeout: 60_000 });
    await usage.waitForSelector('button[data-action="refresh"]:not([aria-disabled="true"])', { timeout: 60_000 });
    await usage.waitForFunction(() => !(document.querySelector('.hero-value')?.textContent ?? '').includes('≥'), undefined, { timeout: 60_000 });
}

async function setRange(usage, range) {
    await usage.click(`button[data-range="${range}"]`);
    await usage.waitForSelector(`button[data-range="${range}"][aria-pressed="true"]`);
    await usage.waitForFunction(n => document.querySelectorAll('.column').length === n, COLUMNS[range]);
    await readThrough(usage);
    await sleep(700);
}

async function setScope(usage, scope) {
    await usage.click(`button[data-scope="${scope}"]`);
    await usage.waitForSelector(`button[data-scope="${scope}"][aria-pressed="true"]`);
    await readThrough(usage);
    await sleep(700);
}

/** The total's line says `requests` and `sessions`, as the demo wrote them. */
async function expectCounts(usage, requests, sessions, what) {
    const meta = await usage.locator('.hero-meta').first().innerText();
    for (const said of [`${requests.toLocaleString('en-US')} requests`, `${sessions.toLocaleString('en-US')} sessions`]) {
        if (!meta.includes(said)) {
            throw new Error(`${what} does not show the demo's ${said}: ${meta}`);
        }
    }
}

/**
 * The panel shows the demo's history and nothing else, and the extension read
 * the demo's one data folder. At 30 days, which hold all of it.
 */
async function checkDemo(usage, profile) {
    await setRange(usage, '30d');
    await setScope(usage, 'all');
    await expectCounts(usage, demo.requests, demo.sessions, 'the panel');
    const projects = await usage.evaluate(() => {
        const section = [...document.querySelectorAll('h2')].find(h => h.textContent?.trim() === 'Projects')?.closest('section');
        return [...(section?.querySelectorAll('tbody tr') ?? [])].map(r => r.querySelector('td')?.textContent?.trim() ?? '').sort();
    });
    if (JSON.stringify(projects) !== JSON.stringify(demo.projects)) {
        throw new Error(`the panel's projects are not the demo's: ${projects.length} of them`);
    }
    const logs = join(profile, 'logs');
    const found = readdirSync(logs, { recursive: true }).filter(f => String(f).endsWith('LLM Tokenizer.log'));
    const text = found.map(f => readFileSync(join(logs, String(f)), 'utf8')).join('\n');
    if (!text.includes(`read ${demo.files} of ${demo.files} files in 1 root`)) {
        throw new Error('the extension did not read the demo home alone');
    }
}

async function statusTooltip(page) {
    const item = page.locator('.statusbar-item', { hasText: '532.8K' }).first();
    await item.hover();
    const hover = page.locator('.workbench-hover, .monaco-hover').filter({ hasText: 'Claude Code, in this workspace' }).first();
    await hover.waitFor({ timeout: 10_000 });
    await opaque(hover);
    if ((await hover.innerText()).includes('Still reading')) {
        throw new Error('the tooltip still says the history is being read');
    }
    await stillHovered(item);
    return item;
}

/** The item the tooltip points at shows as hovered, as it does under the pointer. */
async function stillHovered(item) {
    if (!(await item.evaluate(el => el.matches(':hover')))) {
        throw new Error('the status item is not hovered');
    }
}

/** A hover fades in: shot before, it shows at a third of its opacity. */
async function opaque(locator) {
    for (let i = 0; i < 40; i++) {
        const opacity = await locator.evaluate(el => {
            let o = 1;
            for (let e = el; e; e = e.parentElement) {
                o *= Number(getComputedStyle(e).opacity);
            }
            return o;
        });
        if (opacity >= 0.999) {
            await sleep(150);
            return;
        }
        await sleep(100);
    }
    throw new Error('a hover never became opaque');
}

async function stills(theme) {
    const vscode = await launch(theme, { width: 1440, height: 900 });
    const { page } = vscode;
    try {
        await openCart(page);
        await tokenSummary(page, theme);
        const usage = await openUsage(page);
        await checkDemo(usage, vscode.profile);
        await rest(page);
        await uncut(usage, 20);
        await shoot(page, `usage-panel-${theme}.png`, { frames: [usage] });
        const item = await statusTooltip(page);
        await shoot(page, `usage-status-${theme}.png`, { crop: { x: 940, y: 670, width: 500, height: 230 }, frames: [usage] });
        await stillHovered(item);
    } finally {
        await vscode.close();
    }
}

/** Scroll the panel to the section headed `heading`, a little below its top, and off any row the bottom edge would cut. */
async function scrollTo(usage, heading) {
    const found = await usage.evaluate(text => {
        const h = [...document.querySelectorAll('h2')].find(e => e.textContent?.trim().toLowerCase() === text);
        h?.scrollIntoView({ block: 'start' });
        window.scrollBy(0, -28);
        return h !== undefined;
    }, heading);
    if (!found) {
        throw new Error(`the panel has no section headed "${heading}"`);
    }
    await uncut(usage, 20);
}

async function gif() {
    const vscode = await launch('dark', { width: 1280, height: 800 });
    const { page } = vscode;
    const frames = [];
    const frame = async (seconds, shown = []) => {
        const file = `gif-${String(frames.length + 1).padStart(2, '0')}.png`;
        await shoot(page, file, { frames: shown });
        frames.push([file, seconds]);
    };
    try {
        await openCart(page);
        await rest(page);
        await frame(1.4);
        await page.locator('.editor-actions [aria-label="Show Claude Code Usage"]').first().hover();
        const tip = page.locator('.workbench-hover, .monaco-hover').filter({ hasText: 'Show Claude Code Usage' }).first();
        await tip.waitFor({ timeout: 10_000 });
        await opaque(tip);
        await frame(1.2);
        const usage = await openUsage(page);
        // Checked before any of the panel is captured, then back to Today.
        await checkDemo(usage, vscode.profile);
        await setRange(usage, 'today');
        await rest(page);
        await uncut(usage, 20);
        await frame(2.0, [usage]);
        await setRange(usage, '7d');
        await uncut(usage, 20);
        await frame(1.6, [usage]);
        await setRange(usage, '30d');
        await expectCounts(usage, demo.requests, demo.sessions, 'the 30 days frame');
        await uncut(usage, 20);
        await frame(2.0, [usage]);
        await setScope(usage, 'workspace');
        const own = demo.byProject['acme-storefront'];
        await expectCounts(usage, own.requests, own.sessions, 'the workspace frame');
        await uncut(usage, 20);
        await frame(2.0, [usage]);
        await setScope(usage, 'all');
        await expectCounts(usage, demo.requests, demo.sessions, 'the all projects frame');
        await uncut(usage, 20);
        await frame(1.2, [usage]);
        await scrollTo(usage, 'projects');
        await frame(2.6, [usage]);
        await scrollTo(usage, 'what was processed');
        const item = await statusTooltip(page);
        await frame(3.2, [usage]);
        await stillHovered(item);
    } finally {
        await vscode.close();
    }
    // Each frame held until the next; the last one's hold is the GIF's final delay.
    const list = ['ffconcat version 1.0', ...frames.flatMap(([file, s]) => [`file '${file}'`, `duration ${s}`])];
    writeFileSync(join(out, 'gif.txt'), list.join('\n') + '\n');
    writeFileSync(join(out, 'gif-final-delay.txt'), `${Math.round(frames[frames.length - 1][1] * 100)}\n`);
}

install();
liveSession();
try {
    for (const theme of ['dark', 'light']) {
        if (!only || only === theme) {
            await stills(theme);
        }
    }
    if (!only || only === 'gif') {
        await gif();
    }
} finally {
    stopAll();
}
