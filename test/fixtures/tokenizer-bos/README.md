The same tiny BPE as `../tokenizer`, plus a `TemplateProcessing` post-processor
that prepends a `<s>` beginning-of-sequence token — which is what Mistral's real
`tokenizer.json` does.

It exists to prove that special tokens are not counted as file content:

| input | raw ids     | reported |
|-------|-------------|----------|
| `""`  | `[7]`       | 0        |
| `abc` | `[7, 4, 3]` | 2        |

Without the correction every file counted with such a tokenizer came back one
token heavy, and was labelled exact.
