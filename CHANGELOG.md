# Change Log

All notable changes to the "LLM Tokenizer" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

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
