# Change Log

All notable changes to the "LLM Tokenizer" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

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
