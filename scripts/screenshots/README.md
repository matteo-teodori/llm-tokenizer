# README images

How the images in `docs/images/` are made. They must show the UI as it
ships: make them again in the same change as anything that shows on them, and
update the README's alt texts to the figures they then show.

Everything shown is invented. `demo.mjs` writes a home holding the demo
workspace, acme-storefront (the files git tracks in `workspace/`), and 30 days
of Claude Code records for it and four other invented projects, from a seeded
generator. No one's own usage is read, and `capture.mjs` checks that.

## Prerequisites

- macOS, with ffmpeg on the PATH (`brew install ffmpeg`).
- `npm ci` at the repository's root, and `npm test` once, which downloads the
  VS Code build under `.vscode-test/`: `vscode-darwin-arm64-<version>` on
  Apple silicon, `vscode-darwin-<version>` on Intel.
- Here: `npm ci --ignore-scripts` (playwright-core, pinned by
  `package-lock.json`; nothing here is part of the extension).

## Run

From the repository's root, in a subshell, so that a failed step stops the
rest and leaves your shell as it was:

```sh
(
    set -e
    S=$(mktemp -d)
    rm -rf out && npx @vscode/vsce package -o "$S/llm-tokenizer.vsix"
    node scripts/screenshots/capture.mjs "$S/work" "$S/llm-tokenizer.vsix" \
        "$PWD/.vscode-test/vscode-darwin-arm64-<version>/Visual Studio Code.app" "$S/out"
    bash scripts/screenshots/gif.sh "$S/out"
    cp "$S"/out/{token-summary,usage-panel,usage-status}-{dark,light}.png "$S/out/usage.gif" docs/images/
)
```

`capture.mjs` writes the demo home itself, dated from that moment, with
today's two sessions in the hours before it: run it after 02:00 UTC, or it
says so and stops. The demo workspace is the files git has in `workspace/`, so
a file added there is used once it is committed or staged. The work folder
must be new or empty, or one it made before. A last argument, `dark`, `light`
or `gif`, makes only those images.

It leaves the work folder (the demo home, the installed VSIX, VS Code's logs)
and the profiles in `.p/` here, about 75 MB, both for looking into a run;
neither is tracked.

## What keeps it to the demo

- HOME and CLAUDE_CONFIG_DIR are the demo home's, and TZ is UTC.
- Each run has a new profile, in `.p/` here (a profile's IPC socket must fit in
  103 characters; in the system's temporary folder, removed after the run,
  when this path is too long), and a new extensions folder, into which VS
  Code's own CLI installs the VSIX.
- `--use-mock-keychain` and `--force-disable-user-env`; workspace trust,
  telemetry, updates and AI features off.
- `guard.mjs`, which both scripts run before they write anything, refuses a
  work folder that is or holds the home, that is in `~/.claude` or in
  `$CLAUDE_CONFIG_DIR` (links resolved, case aside, as macOS compares paths),
  that is inside any folder named `projects`, which a data folder named in a
  setting would read, or that holds files it did not make; and both refuse to
  run before 02:00 UTC. `capture.mjs` also refuses to run where Claude Code's
  managed settings exist (`/Library/Application Support/ClaudeCode`,
  `/etc/claude-code`), which could name another data folder.
- Before any page of the usage panel is captured, the panel must show exactly
  the demo's requests, sessions and projects, and the extension's log must say
  it read the demo's files in one data folder. Each GIF frame's range and
  scope must show their own figures.
- Every state captured is checked, before the capture and after it, for this
  machine's home, temporary and scratch paths anywhere in the text, and for
  its user, full, host and computer names and the git user and email as
  words, in every frame, the webviews' included, and in every input box. A
  frame that cannot be read stops the run, and so does an open terminal,
  whose text is drawn on a canvas.

What it starts is stopped however it ends, short of a kill -9: VS Code, the
process the live session names, and the live-session file.

## How it captures

A release build refuses the Node inspector that Playwright's Electron launcher
needs, so VS Code is started on its own with `--remote-debugging-port=0` and
reached at the address its log gives. `--force-device-scale-factor=2` makes
every renderer, the webviews' included, draw at twice the size whatever the
display, and `--force-color-profile=srgb` in sRGB.
`Emulation.setDeviceMetricsOverride` lays the window out at 1440 by 900 (the
GIF's at 1280 by 800), and `Page.captureScreenshot` keeps the scale, where
Playwright's own capture does not: the pages are 2880 by 1800, the status
crops 1000 by 460, cut out of a whole capture with the item still hovered, the
GIF's frames 2560 by 1600, and each webview is checked to draw at 2x. No row of
a table or a chart is cut by a page's bottom edge. ffmpeg halves the GIF's nine frames to 1280 by 800 with a box
filter and a palette per frame, each held as long as `gif.txt` says.
