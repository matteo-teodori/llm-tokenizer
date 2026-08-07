<div align="center">
  <img src="https://raw.githubusercontent.com/matteo-teodori/llm-tokenizer/main/icon.png" alt="LLM Tokenizer Icon" width="120" />

  <h1>LLM Tokenizer</h1>

  <p><b>The ultimate AI token counter for your IDE.</b><br>
  Token counting for 71 models — exact where the tokenizer is public, honestly labelled where it is not.</p>

  <p>
    <a href="https://marketplace.visualstudio.com/items?itemName=matteoteodori.llm-tokenizer">
      <img src="https://vsmarketplacebadges.dev/version-short/matteoteodori.llm-tokenizer.svg?style=for-the-badge&colorA=555555&colorB=0078d4&label=VS%20Marketplace" alt="VS Code Marketplace Version">
    </a>
    <a href="https://open-vsx.org/extension/matteoteodori/llm-tokenizer">
      <img src="https://img.shields.io/open-vsx/v/matteoteodori/llm-tokenizer?style=for-the-badge&label=Open%20VSX&color=a855f7" alt="Open VSX Version">
    </a>
    <a href="https://github.com/matteo-teodori/llm-tokenizer/blob/main/LICENSE">
      <img src="https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge" alt="MIT License">
    </a>
  </p>
</div>

---

**Optimized for developers building with LLMs.**

LLM Tokenizer gives you **instant visibility** into your token usage directly within your IDE. Whether you're optimizing prompts, estimating API costs, or ensuring your context window limits aren't exceeded, LLM Tokenizer removes the guesswork.

- **Check Context Limits**: Know instantly if your file fits within the context window of your favorite AI model.
- **Estimate Costs**: Get a clear sense of input token volume before sending requests to expensive APIs.
- **Optimize RAG Pipelines**: Analyze folder-level token counts to better chunk your knowledge base.

Stop copying and pasting into web calculators. Get precise counts right where you code.



## Features

### 🎯 Core Features
- **Exact counts, not guesses**: 52 of the 71 supported models are tokenized with the model's own tokenizer. The rest are clearly marked with `≈`.
- **Real-time Token Count**: The active file's token count in the Status Bar
- **Context Limit Warnings**: Indicators at 80% and 100% of the model's *usable input* limit
- **Project-wide Counting**: Workspace totals with caching, cancellation, and multi-root support
- **Multi-file Selection**: Select multiple files or folders in the explorer for a batch count
- **Folder Analysis**: Right-click a folder to count recursively
- **Selection Counting**: Count only the text you highlighted
- **Runs off the UI thread**: Tokenizing happens in a worker thread, so the editor never blocks
- **Persistent Preferences**: Your model choice is remembered

### 🔒 Privacy
**Your code never leaves your machine.** There is no telemetry and no network
request that contains file contents. The only network access is a one-time
download of a model's *vocabulary file* from huggingface.co, which you can turn
off with `llm-tokenizer.downloadTokenizers`.

### ⚙️ Configuration
- `llm-tokenizer.defaultModel`: Model used until you pick one
- `llm-tokenizer.statusBarDisplay`: `"file"`, `"project"`, or `"both"`
- `llm-tokenizer.ignoreGitignoredFiles`: Exclude gitignored files from folder and workspace totals
- `llm-tokenizer.enableProjectScan`: Turn off workspace-wide counting on very large repositories
- `llm-tokenizer.downloadTokenizers`: Allow the one-time tokenizer download that makes counts exact

## Supported Models

71 models across 13 providers. Every id is checked against the provider's own
documentation; models that a provider has retired are removed, and your setting
is migrated automatically.

| Provider   | Models | Accuracy |
|------------|--------|----------|
| OpenAI     | GPT-5.6 Sol/Terra/Luna, GPT-5.5, GPT-5.4 (+mini), GPT-5.3 Codex, GPT-5.2, GPT-5.1, GPT-5, GPT-4.1, GPT-4o (+mini), o3, o4-mini, gpt-oss 120b/20b, GPT-4 Turbo, GPT-3.5 Turbo | Exact |
| Anthropic  | Claude Opus 5, Sonnet 5, Fable 5, Opus 4.8/4.7/4.6/4.5, Sonnet 4.6/4.5, Haiku 4.5 | Estimated |
| Google     | Gemini 3.5 Flash, 3.1 Pro, 3.1 Flash-Lite, 3 Flash, 2.5 Pro/Flash, Gemma 4 | Exact¹ |
| Google     | Gemini 3.6 Flash, 3.5 Flash-Lite | Estimated² |
| xAI        | Grok 4.5, Grok 4.3, Grok 4.20, Grok Build 0.1 | Estimated |
| DeepSeek   | DeepSeek V4 Pro, V4 Flash | Exact¹ |
| Meta       | Llama 4 Scout, Llama 4 Maverick, Llama 3.3 70B, Llama 3.1 8B | Exact¹ |
| Mistral    | Mistral Large 3, Medium 3.5, Small 4 | Exact¹ |
| Alibaba    | Qwen3.7 Max/Plus, Qwen3.6 Plus, Qwen3.6 27B, Qwen3.6 35B-A3B | Exact¹ / estimated |
| Zhipu      | GLM-5.2, GLM-5.1, GLM-5, GLM-5-Turbo | Exact¹ |
| MiniMax    | MiniMax M3, M2.7, M2.5, M2.1 | Exact¹ |
| Moonshot   | Kimi K3, K2.7 Code, K2.6 | Exact¹ |
| Xiaomi     | MiMo V2.5 Pro, MiMo V2 Flash | Exact¹ |
| Tencent    | Hunyuan Hy3 | Exact¹ |

¹ after a one-time tokenizer download
² these two releases are too recent for Google's SDK to map them to a published
vocabulary, so they fall back to a character estimate

## Usage

### Basic Operations
1. **Open a file**: Token count appears in Status Bar (bottom right)
2. **Click Status Bar item** to change model
3. **Right-click a single file** → **Count Tokens** (shows a popup notification with the token count)
4. **Right-click a folder** (or multiple files) → **Count Tokens** (opens a summary showing where the tokens are, by folder and by language)
5. **Select text** in editor → **Count Tokens** to count only the selection

### Configuration
Open Settings (Ctrl/Cmd+,) and search for "LLM Tokenizer":
- **Default Model**: the model used until you pick one from the status bar
- **Status Bar Display**: `"file"`, `"project"`, or `"both"` (default `"both"`)
- **Ignore Gitignored Files**: exclude `.gitignore` matches from counts (on by default)
- **Enable Project Scan**: turn off workspace-wide counting on very large repositories
- **Download Tokenizers**: allow the one-time download that makes counts exact

### Context Warnings
- **Normal**: under 80% of the model's usable input limit
- **Warning**: 80–99%
- **Error**: at or over 100%

A leading `≈` means the count is an estimate rather than an exact tokenization.

## Accuracy

There are three tiers, and the status bar tells you which one you are in.
Two vocabulary formats are published in the wild — a Hugging Face
`tokenizer.json`, and a bare tiktoken rank table (Moonshot ships the latter) —
and both are read.

| Tier | Shown as | Method | Models |
|------|----------|--------|--------|
| **Exact, offline** | `12,340` | OpenAI's own BPE, bundled | All OpenAI models |
| **Exact after one download** | `≈` → `12,340` | The model's published vocabulary (~2–19 MB, cached) | Llama, Gemma/Gemini, DeepSeek, Qwen, Mistral, GLM, MiniMax, MiMo, Hunyuan, Kimi |
| **Estimated** | `≈12,340` | Calibrated characters per token | Claude, Grok, closed Qwen |

**Why some models are only estimated.** Anthropic and xAI do not publish a
tokenizer for any current model, and Anthropic explicitly advises against
approximating Claude with OpenAI's tokenizer. An honest estimate is better than
a confident wrong number, so those models are marked rather than dressed up.

The per-family ratios are measured against real corpora where a tokenizer
exists to measure against. Grok is the exception: no Grok tokenizer has ever
been published, so its ratio is inferred rather than measured, and it is the
least reliable number here.

**Known limitation:** only the `.gitignore` at the root of each workspace
folder is read, plus `.git/info/exclude`. Nested `.gitignore` files deeper in
the tree are not applied.

Earlier versions approximated everything with `cl100k_base` and a fudge factor.
Measured against the real tokenizers, that undercounted Gemini on JSON by 27%
and Mistral on source code by 24% — errors in the direction that tells you your
prompt fits when it does not.

## Requirements

VS Code 1.105.0+

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for detailed release notes.

---

**Author**: [Matteo Teodori](https://github.com/matteo-teodori)
