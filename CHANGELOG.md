# Change Log

All notable changes to the "LLM Tokenizer" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [2.1.0] - 2026-08-07

### Added
- **Kimi is counted exactly.** Moonshot publishes a tiktoken rank table instead
  of a `tokenizer.json`, which no loader here could read, so the whole family
  was estimated. K3, K2.7 Code and K2.6 now use Moonshot's real vocabulary —
  and because the rank file is byte-identical across the family, one download
  covers all three.

  Moonshot's pre-tokenizer uses three constructs JavaScript does not have, so
  it had to be translated. The translation was checked against the reference
  implementation both ways: identical splits on 20 cases, and identical counts
  on 28 spanning Latin, Han, Kana, Hangul, Cyrillic, emoji, contractions and
  source files. It needs a recent JavaScript engine; on an older one Kimi
  simply stays an estimate rather than failing.
- **The multi-file summary is now a dashboard.** Counting a folder answers the
  question you actually had — *what is eating my context?* — instead of only
  *how much is it?*
  - The total leads as a headline figure, with context use as a filled meter
    that turns amber past 80% and red past 100%.
  - **Where the tokens are**: a ranked breakdown by folder. The old tree was
    ordered by name, so the folder eating half your context looked like every
    other row.
  - **By language**: the same breakdown by file type.
  - The file list is a sortable, filterable table, with a button to copy it or
    export it as CSV.
- Paths are shown relative to what the selection shares, so counting one deep
  folder no longer repeats the same long prefix on every row.

### Changed
- The summary's colours come entirely from VS Code's own theme tokens, so the
  panel follows the editor into any theme, high-contrast ones included.

### Internal
- The aggregation behind the summary is pure and separately tested, and the
  downloaded-vocabulary path is now one code path serving two published shapes.
  The suite is up to 139 tests.

## [2.0.1] - 2026-08-03

### Fixed
- **The context-limit warning was unreadable on light themes.** Over the limit,
  the status bar showed white text on the ordinary background — VS Code
  registers `statusBarItem.errorForeground` as plain white for every theme,
  because it is meant to sit on the matching red background, and only the
  foreground was being set. The status bar now sets the background instead and
  lets VS Code pick a foreground that stays readable, so an over-limit count
  reads as a red badge and an approaching one as amber, on any theme.

## [2.0.0] - 2026-08-02

A correctness and accuracy release. Counts that were silently wrong are now
either exact or visibly marked as estimates.

### Added
- **Exact tokenization for ~50 models.** Special tokens are excluded, so a
  tokenizer that prepends a beginning-of-sequence marker (Mistral's does) no
  longer adds one token to every file. OpenAI models use OpenAI's own BPE,
  bundled and offline. Llama, Gemma, DeepSeek, Qwen, Mistral, GLM, MiniMax,
  MiMo and Hunyuan use the model's real `tokenizer.json`, downloaded once from
  Hugging Face and cached on disk. No file contents ever leave your machine.
- **Estimates are labelled.** Models with no public tokenizer — Claude, Grok,
  and a few closed-weight models — show `≈` and explain why in the tooltip.
- `llm-tokenizer.enableProjectScan` turns workspace-wide counting off on very
  large repositories. Per-file and per-folder counting keeps working.
  Proposed by [@tivnantu](https://github.com/tivnantu) in #1.
- `llm-tokenizer.downloadTokenizers` controls the one-time tokenizer download.
- Commands to download the exact tokenizer for the current model and to clear
  the download cache.
- An **LLM Tokenizer** output channel, replacing `console.log`.

### Fixed
- **Multi-root workspaces never produced a project count.** The `.gitignore`
  was anchored to the first folder while the search covered all of them, so any
  file in a second root threw and aborted the scan for the rest of the session.
- **The whole `.git` directory was being counted.** Supplying an explicit
  exclude to `findFiles` replaces VS Code's defaults, so `.git` was traversed
  and loose git objects were tokenized as text.
- **Switching models kept showing the previous model's numbers.** The cache was
  keyed on path and mtime only, so it never invalidated on a model change.
- **`llm-tokenizer.defaultModel` did nothing.** It was documented and offered
  69 values in the settings UI, but no code read it.
- **A crashed tokenizer worker hung every count forever.** Pending requests are
  now rejected, the worker restarts, and requests time out.
- The worker thread and its rank tables leaked on every window reload.
- Concurrent workspace scans could overlap, with the older one overwriting the
  newer result.
- Directory patterns in `.gitignore` (`build/`) no longer match, so ignored
  trees were walked in full.
- Symlinked files and directories were silently dropped from every total. A
  directory reached through a symlink is now counted once, not once per path
  that reaches it — `docs/latest -> ../v2` used to count that tree twice.
- A deleted file mid-scan discarded all work completed so far.
- Very large files are skipped instead of exhausting memory.
- Changing a setting now takes effect immediately.
- Selecting a folder and a file inside it no longer double-counts the file.
- `.git/info/exclude` is honoured alongside the root `.gitignore`.
- Counting a file that belongs to no workspace folder reported a total of zero;
  it was being dropped before it was ever read.
- Counting an unsaved or untitled editor reported an error; it now counts what
  is on screen rather than what is on disk.
- Switching model during a multi-file count mixed two models' numbers into one
  total. The model is fixed for the duration of an operation.
- "Download Exact Tokenizer" said nothing at all when the download failed —
  offline, behind a proxy, or on a gated repository it was indistinguishable
  from a broken command.
- Binary files without a known extension — `.dat`, `.pack`, a renamed binary,
  anything extensionless — were tokenized as text. Content is now sniffed too.
- In a multi-root workspace, files with the same relative path in two roots
  collided into one row in the summary, showing one file's count under a total
  that included both.
- The summary's Skipped and Ignored sections capped their listings at 1,000 but
  reported the capped number as the total, contradicting the count directly
  above them. Both now show the true total and disclose what they left out.
- A summary with nothing to count said "No file matches that filter" when no
  filter had been typed.
- The summary rendered one row and one click listener per file and held them
  for the lifetime of the window. Listings are capped at 1,000 entries, largest
  first, with the omission stated; totals still cover every file.
- **Progress during a multi-file count now means something.** It reported per
  *selected item*, so right-clicking a single folder of 5,000 files showed
  "1/1: foldername" and then sat motionless for the entire scan. Files are
  discovered first — a cheap pass — and the count then reports "1,234 of 5,678
  files" against a real total.

### Security
- The summary view escaped nothing. A file named `<img src=x onerror=…>.ts`
  — a legal name on macOS and Linux — executed script in the webview. All
  workspace-controlled values are escaped, a strict Content-Security-Policy
  with a per-render nonce is applied, and the webview may now only ask to open
  files it actually listed.

### Changed
- **The model list was rebuilt against live provider documentation.** Several
  models that shipped in 1.3.0 never existed (`grok-4.2`, `grok-4.1-fast`,
  `grok-4-fast`), several ids were in a format their provider does not use
  (every Anthropic entry), and many context limits were wrong — `gpt-5.5` was
  listed at 200K against an actual 922K. Removed and renamed ids are migrated
  automatically on first run.
- Context limits are now the **usable input** limit rather than the advertised
  window, so the 80% warning fires at a number that means something.
- Token counting is **~50× faster** and the extension no longer opens every
  file in the workspace as a text document during a scan.
- The packaged extension is bundled and ships no dependency tree: **~10 MB →
  2.6 MB**.
- Status bar uses themed icons instead of emoji.
- Declares `untrustedWorkspaces` support, so it no longer disables itself in
  Restricted Mode.
- The icon was a JPEG named `.png` at 1024×1024; it is now a real 256×256 PNG.
- Minimum VS Code version is now 1.105 (was 1.85), for the logging and status
  bar APIs this release uses.

### Internal
- A test suite: 89 tests running in a real VS Code instance, written against
  the specific defects fixed above.
- ESLint and the type checker run again, and the suite runs in CI on Linux,
  Windows and macOS.
- The settings dropdown is generated from the model registry, so the two can no
  longer drift.

### Removed
- Models that were retired by their providers or that never existed. Each has a
  migration entry, so an affected setting is moved to the nearest live model
  with a one-time notice.

## [1.3.0] - 2026-05-02

### Added
- **30+ New AI Models**: Comprehensive model registry update across all major providers:
  - **OpenAI**: GPT-5.5, GPT-5.4, GPT-5.3 Codex, GPT-5, o3, o3-pro, o4-mini
  - **Anthropic**: Claude Opus 4.7, Claude 3.7 Sonnet
  - **Google**: Gemini 3.1 Pro
  - **xAI**: Grok 4.3, Grok 4.2, Grok 3
  - **DeepSeek**: DeepSeek R1, DeepSeek V3.1, DeepSeek V4 Pro, DeepSeek V4 Flash
  - **Meta**: Llama 4 Scout, Llama 4 Maverick, Llama 3.3
  - **Mistral**: Mistral Large 3, Mistral Small 4
  - **Alibaba**: Qwen3, QwQ 32B, Qwen 3.5, Qwen 3.6 Plus
  - **Moonshot**: Kimi K2.6 (256K context)
  - **MiniMax**: MiniMax M2.7 (204,800 context)
  - **Zhipu**: GLM-5, GLM-5.1

### Changed
- Updated extension description to reflect 60+ supported models
- Updated README with professional badge banner and full model table

## [1.2.1] - 2026-02-28

### Added
- **Performance Improvements (Web Worker)**: Token counting is now fully offloaded to Node.js `worker_threads` to ensure the VS Code UI (main thread) never freezes or stutters even when processing massive 100MB+ files or counting tokens across large workspaces.

### Fixed
- **Selection Counting**: Fixed an issue where using "Count Tokens" from the context menu on a selected block of text incorrectly counted the entire file instead of the selection.

## [1.2.0] - 2026-02-28

### Added
- **.gitignore Support**: The extension now automatically excludes files matching the project's `.gitignore` rules from both workspace-wide and folder-level token counting, providing much more accurate results.
- **Gitignore Setting**: Added a new VS Code setting (`llm-tokenizer.ignoreGitignoredFiles`) to toggle this behavior (enabled by default).
- **Ignored Files UI**: The Multi-file Token Summary webview now includes a dedicated "Ignored Files" section to clearly show which files were skipped due to `.gitignore` rules.
- **New AI Models**: Added support for the latest models including:
  - Anthropic: Claude 4.6 Sonnet, Claude 4.6 Opus
  - MiniMax: MiniMax M2.5

## [1.1.0] - 2026-02-04

### Added
- **Context Limit Warnings**: Visual indicators (⚠️ at 80%, 🔴 at 100%) when approaching or exceeding model context limits
- **Project-wide Token Count**: New status bar option for entire workspace token counting with smart caching
- **Multi-file Tree View**: Interactive summary with hierarchical folder structure, clickable files, and folder token totals
- **Folder Token Totals**: Each folder in the tree view now displays its total token count

### Changed
- **Codebase Refactoring**: Reorganized into modular architecture for better maintainability
- **Model Accuracy**: Updated model registry with verified 2026 specifications, including precise context limits (e.g., Grok 4 at 2M, Gemini 3 at ~1M) and corrected token factors

### Fixed
- **Empty Files**: Empty files now correctly show as 0 tokens instead of being marked as binary

## [1.0.2] - 2026-02-01

### Added
- **Selection Token Count**: When text is selected in the editor, "Count Tokens" now counts only the selection instead of the entire file.

### Fixed
- **Folder Counting**: Binary files (images, PDFs, executables) are now correctly skipped when counting tokens in folders.

## [1.0.1] - 2026-02-01

### Fixed
- **Marketplace Icon**: Fixed icon not displaying in VS Code Marketplace and Open VSX by using absolute GitHub URL.

### Changed
- **Compatibility**: Lowered minimum VS Code version to 1.85.0 for broader IDE support (Cursor, VSCodium, etc.).

## [1.0.0] - 2026-02-01

### Added
- **Initial Release**: Launched LLM Tokenizer for VS Code! 🎉
- **Multi-Model Support**: Added support for 37+ AI models including:
    - OpenAI: GPT-5.2, GPT-4o, o1, o3-mini.
    - Anthropic: Claude Sonnet 4.5, Opus 4.5.
    - Google: Gemini 3 Flash/Pro.
    - DeepSeek V3, Llama 3, Grok, and more.
- **Folder Analysis**: Recursive token counting for entire directories via context menu.
- **Status Bar Integration**: Real-time token counter for the active file.
- **Binary File Detection**: Graceful handling of unsupported file types (images, PDFs, etc.).
- **Smart Caching**: Persistent model selection across sessions.
