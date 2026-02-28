<div align="center">
  <img src="https://raw.githubusercontent.com/matteo-teodori/llm-tokenizer/main/icon.png" alt="LLM Tokenizer Icon" width="128" />
  <h1>LLM Tokenizer</h1>
  <p>
    <b>The ultimate AI token counter for your IDE.</b><br>
    Supports 35+ models including GPT, Claude, Gemini, DeepSeek, and Llama.
  </p>
  
  <p>
    <a href="https://marketplace.visualstudio.com/items?itemName=matteoteodori.llm-tokenizer">
      <img src="https://img.shields.io/badge/Install-VS%20Code-blue?style=for-the-badge&logo=visual-studio-code" alt="Install from VS Code Marketplace">
    </a>
  </p>
</div>

---


---

**Optimized for developers building with LLMs.**

LLM Tokenizer gives you **instant visibility** into your token usage directly within your IDE. Whether you're optimizing prompts, estimating API costs, or ensuring your context window limits aren't exceeded, LLM Tokenizer removes the guesswork.

- **Check Context Limits**: Know instantly if your file fits within the context window of your favorite AI model.
- **Estimate Costs**: Get a clear sense of input token volume before sending requests to expensive APIs.
- **Optimize RAG Pipelines**: Analyze folder-level token counts to better chunk your knowledge base.

Stop copying and pasting into web calculators. Get precise counts right where you code.



## Features

### 🎯 Core Features
- **Real-time Token Count**: View the token count of the active file in the Status Bar
- **Uncompromised Performance**: Uses background Node.js `worker_threads` for heavy asynchronous processing, ensuring VS Code never freezes even on massive 100MB+ files or entire workspaces
- **Context Limit Warnings**: Visual indicators (⚠️ 80%, 🔴 100%) when approaching model limits
- **Project-wide Counting**: Track total tokens across your entire workspace with smart caching
- **Multi-file Selection**: Select multiple files/folders in explorer for batch token counting
- **35+ AI Models**: OpenAI, Anthropic, Google, xAI, DeepSeek, Meta, and more
- **Selection Counting**: Count tokens in selected text within the editor
- **Folder Analysis**: Right-click a folder to count tokens recursively
- **Grouped Model Selection**: Models organized by provider for easy switching
- **Persistent Preferences**: Selected model is remembered across sessions

### ⚙️ Configuration
- `llm-tokenizer.defaultModel`: Choose your preferred AI model
- `llm-tokenizer.statusBarDisplay`: Display mode - "file", "project", or "both"
- `llm-tokenizer.ignoreGitignoredFiles`: Exclude gitignored files from project-wide and directory token counting

## Supported Models

| Provider   | Models                                                                 |
|------------|------------------------------------------------------------------------|
| OpenAI     | GPT-5.2, GPT-OSS 120B, GPT-4o, GPT-4o Mini, o1, o3-mini               |
| Anthropic  | Claude Sonnet/Opus 4.6, Claude Sonnet/Opus/Haiku 4.5, Claude 3.5 Sonnet, Claude 3 Opus/Haiku  |
| Google     | Gemini 3 Flash/Pro, Gemini 2.5 Flash/Pro/Lite, Gemini 2.0/1.5        |
| xAI        | Grok 4.1 Fast, Grok 4 Fast, Grok Code Fast 1                          |
| DeepSeek   | DeepSeek V3.2, DeepSeek V3                                            |
| Meta       | Llama 3.2, CodeLlama                                                  |
| Zhipu      | GLM 4.7, GLM 4.6, GLM 4.5                                             |
| Others     | Mistral Large, Qwen 2.5 Coder, Kimi K2.5, MiMo-V2-Flash, MiniMax M2.5/M2.1 |

## Usage

### Basic Operations
1. **Open a file**: Token count appears in Status Bar (bottom right)
2. **Click Status Bar item** to change model
3. **Right-click a single file** → **Count Tokens** (shows a popup notification with the token count)
4. **Right-click a folder** (or multiple files) → **Count Tokens** (opens a detailed Tree View summary)
5. **Select text** in editor → **Count Tokens** to count only the selection

### Configuration
Open Settings (Ctrl/Cmd+,) and search for "LLM Tokenizer":
- **Status Bar Display**: Choose between "file", "project", or "both" (default is "both")
- **Default Model**: Set your preferred model for token counting
- **Ignore Gitignored Files**: Exclude `.gitignore` matched files from counts (checked by default)

### Context Warnings
- **Green** 🤖: Normal usage (< 80% of context limit)
- **Yellow** ⚠️: Approaching limit (80-99%)
- **Red** 🔴: Exceeds context limit (≥ 100%)

## Accuracy Notes

| Provider | Method | Accuracy |
|----------|--------|----------|
| OpenAI | tiktoken (exact) | ~100% |
| Claude | cl100k_base + 1.05x | ~95% |
| Gemini | 4 chars/token | ~90% |
| DeepSeek | 3.33 chars/token | ~90% |
| Others | cl100k_base proxy | ~85-95% |

## Requirements

VS Code 1.85.0+

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for detailed release notes.

---

**Author**: [Matteo Teodori](https://github.com/matteo-teodori)
