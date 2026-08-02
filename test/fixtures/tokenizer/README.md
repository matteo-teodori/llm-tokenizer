A deliberately tiny byte-level BPE tokenizer, used to exercise the Hugging Face
code path in tests without downloading a real 2–19 MB `tokenizer.json`.

Its vocabulary is `a b c ab` with a single merge (`a` + `b` → `ab`), so counts
are small and predictable:

| input | tokens |
|-------|--------|
| `a`   | 1      |
| `ab`  | 1 (the merge fires) |
| `abc` | 2      |
