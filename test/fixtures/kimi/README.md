Two fixtures for the Kimi tokenizer.

**`reference-splits.json`** — how Moonshot's own pre-tokenizer pattern splits a
set of strings, produced by running that pattern through Python's `regex` in V1
mode (where `&&` is a real set operation, as it is in the Rust engine `tiktoken`
uses). The pattern had to be translated to JavaScript, and the split decides
which pieces the merges run over, so a translation that is merely close would
produce counts that are merely close.

**`tiktoken.model`** — a synthetic rank table: all 256 single bytes, plus merges
for `lo` and `He`. Nothing about it is realistic, and that is the point — with
one token per byte the expected counts are derivable by hand, and the two merges
prove that merging happens at all. The real table is 2.7 MB and is downloaded at
runtime.

Both were checked against the real thing: the translated pattern reproduces
Moonshot's splits exactly on 20 cases, and counts from the real 163,584-entry
table match `tiktoken` exactly on 28 cases spanning Latin, Han, Kana, Hangul,
Cyrillic, emoji, contractions and source files.
