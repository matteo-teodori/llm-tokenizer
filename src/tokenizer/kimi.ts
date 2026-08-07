/**
 * Moonshot's Kimi tokenizer.
 *
 * Moonshot publishes `tiktoken.model` — a plain BPE rank table — plus a Python
 * `tokenization_kimi.py`, and no `tokenizer.json`. The Hugging Face loader
 * cannot read that, which is why the whole Kimi family was estimated rather
 * than counted.
 *
 * The rank table is fed to the same byte-pair engine that drives the OpenAI
 * encodings, with Moonshot's own pre-tokenizer pattern translated to
 * JavaScript. Counts were checked against the reference implementation
 * (`tiktoken` with Moonshot's `pat_str`) across Latin, Han, Kana, Hangul,
 * Cyrillic, emoji, contractions and real source files: identical throughout.
 */

// A published entry point, not a reach into internals: the package's exports
// map exposes every module under "./*". TypeScript is told where its types live
// via `paths` in tsconfig.json, because this project resolves modules the
// classic way and that does not read exports maps.
import { BytePairEncodingCore } from 'gpt-tokenizer/BytePairEncodingCore';

/**
 * Moonshot's pre-tokenizer, translated from the pattern in
 * `tokenization_kimi.py`.
 *
 * Four constructs there have no JavaScript equivalent as written:
 *
 *   `[A&&[^B]]`  set intersection with a negation — expressed here as the
 *                difference `[[A]--[B]]`, which needs the `v` flag;
 *   `\p{Han}`    Han is a *Script*, not a General_Category, so JavaScript
 *                needs `\p{Script=Han}`;
 *   `(?i:x|y)`   JavaScript has no inline group flags, so the alternatives are
 *                spelled out in both cases;
 *   `\s`         Rust's `\s` is `\p{White_Space}`; JavaScript's is a different
 *                set that excludes U+0085 and includes U+FEFF. Those two code
 *                points are the whole difference, and spelling the property out
 *                closes it — `\S` likewise becomes `[^\p{White_Space}]`.
 *
 * The split decides which pieces the merges run over, so a translation that is
 * merely close would produce counts that are merely close. It is exact.
 */
const NOT_HAN = String.raw`--[\p{Script=Han}]]`;
const CONTRACTIONS = String.raw`(?:'[sS]|'[tT]|'[rR][eE]|'[vV][eE]|'[mM]|'[lL][lL]|'[dD])?`;
const UPPERISH = String.raw`[[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}]` + NOT_HAN;
const LOWERISH = String.raw`[[\p{Ll}\p{Lm}\p{Lo}\p{M}]` + NOT_HAN;

export const SPLIT_PATTERN = [
    String.raw`[\p{Script=Han}]+`,
    String.raw`[^\r\n\p{L}\p{N}]?${UPPERISH}*${LOWERISH}+${CONTRACTIONS}`,
    String.raw`[^\r\n\p{L}\p{N}]?${UPPERISH}+${LOWERISH}*${CONTRACTIONS}`,
    String.raw`\p{N}{1,3}`,
    String.raw` ?[^\p{White_Space}\p{L}\p{N}]+[\r\n]*`,
    String.raw`\p{White_Space}*[\r\n]+`,
    String.raw`\p{White_Space}+(?![^\p{White_Space}])`,
    String.raw`\p{White_Space}+`,
].join('|');

/** The compiled pre-tokenizer, exported so its translation can be tested. */
export function splitRegex(): RegExp {
    return new RegExp(SPLIT_PATTERN, 'gv');
}

/** Rank tables are large; parsing one takes a moment, so each is kept. */
const cache = new Map<string, BytePairEncodingCore>();

/**
 * Parse a `tiktoken.model` file: one `<base64 token> <rank>` per line.
 *
 * The result is indexed by rank. A token whose bytes are not valid UTF-8 — 1172
 * of them in Kimi's table, mostly lone continuation bytes — is kept as a byte
 * array, which is the shape the engine expects for exactly this case.
 */
export function parseRankFile(text: string): (string | number[])[] {
    const ranks: (string | number[])[] = [];
    const strict = new TextDecoder('utf-8', { fatal: true });

    for (const line of text.split('\n')) {
        const space = line.indexOf(' ');
        if (space <= 0) {
            continue;
        }

        const rank = Number(line.slice(space + 1));
        if (!Number.isInteger(rank) || rank < 0) {
            continue;
        }

        const bytes = Uint8Array.from(Buffer.from(line.slice(0, space), 'base64'));
        try {
            ranks[rank] = strict.decode(bytes);
        } catch {
            ranks[rank] = Array.from(bytes);
        }
    }

    if (ranks.length === 0) {
        throw new Error('the rank file contained no usable entries');
    }
    return ranks;
}

/** Build (or reuse) the encoder for a repo's rank table. */
export function kimiCore(repo: string, rankFile: string): BytePairEncodingCore {
    const existing = cache.get(repo);
    if (existing) {
        return existing;
    }

    const core = new BytePairEncodingCore({
        bytePairRankDecoder: parseRankFile(rankFile),
        tokenSplitRegex: new RegExp(SPLIT_PATTERN, 'gv'),
    });

    cache.set(repo, core);
    return core;
}

/** Release a parsed rank table. */
export function evictKimiCore(repo: string): void {
    cache.delete(repo);
}

/**
 * Count tokens without materialising them.
 *
 * `countNative`, not `encodeNative`: despite the name the latter returns a
 * fully built `number[]`, so iterating it still allocates one number per token.
 * Measured on a 1.4 MB input that is ~60 MB of heap for an array read once for
 * its length — and files up to 10 MB reach here during a scan.
 */
export function countWithCore(core: BytePairEncodingCore, text: string): number {
    return core.countNative(text, new Set());
}
