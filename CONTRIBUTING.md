# Contributing

Thanks for taking the time. Bug reports and pull requests are both welcome.

## Getting set up

```sh
npm install
npm run compile     # type-check + bundle
npm test            # runs the suite in a real VS Code instance
```

Press <kbd>F5</kbd> in VS Code to launch the extension in a development host.
The **Run Extension (fixture workspace)** launch configuration opens the small
test workspace under `test/fixtures/`, which is usually easier to reason about
than a real repository.

## Layout

```
src/              extension source, bundled by esbuild into out/
  extension.ts    activation, commands, event wiring
  tokenizer/      the tokenizer engine: registry, encoders, store, worker protocol
  worker.ts       the tokenizer worker thread
  workerHost.ts   starting a worker, correlating its requests, surviving its crashes
  scan.ts         workspace traversal, gitignore handling, file eligibility
  countCache.ts   per-file counts, keyed on model and file version
  statusbar.ts    the file and project items, and their context-limit colouring
  webview.ts      the summary panel and the messages it handles
  summary/        the summary page: aggregation, languages, rendering
  html.ts         escaping, the webview CSP, and the text helpers a page script runs
  charts.ts       the theme tokens, meter and ranked bars the pages share
  usage/          Claude Code usage: finding and reading its records, the history
                  store, the rollups and reports, the panel and the status item
  usageWorker.ts  the usage worker: the one thread that reads Claude Code's records
                  or touches the history
test/
  unit/           logic that does not need a real workspace
  integration/    drives the extension host and the bundled worker
  fixtures/       a deliberately awkward workspace the tests assert against, the
                  crashing workers, and a stand-in for ~/.claude whose totals are
                  worked out by hand in its README
scripts/          build-time tooling; bundles.mjs lists the bundles that ship
build.mjs         the bundler
```

`out/` holds the shipped bundles. `.test-out/` holds compiled tests and is never
packaged.

## Commands

| Command | What it does |
|---|---|
| `npm run build` | Bundle into `out/` |
| `npm run watch` | Rebuild on change |
| `npm run check-types` | Type-check without emitting |
| `npm run lint` | ESLint, type-aware |
| `npm test` | Compile the tests and run them in the current VS Code |
| `npm run test:floor` | The same suite on VS Code 1.105.0, the oldest `package.json` accepts |
| `npm run sync-manifest` | Regenerate the settings dropdown from the registry |
| `npm run notices` | Regenerate `THIRD-PARTY-NOTICES.md` from the packages the bundles inline |
| `npm run audit-bundled` | Audit only the packages the bundles inline, which is what ships |
| `npm run package` | Type-check, production build, and the manifest and notices checks |
| `npm run release` | `package`, then the VSIX itself; nothing is published |

To debug a test, use the **Extension Tests** launch configuration. Like
`npm test`, it runs in a profile of its own, without the login shell's
environment, and with `CLAUDE_CONFIG_DIR` pointed at a fixture; its entry
point refuses to run if that points anywhere else, so no test can read your own
Claude Code data.

## Adding or changing a model

**Check the provider's own documentation first — do not write a model id from
memory.** Version 1.3.0 shipped models that did not exist, ids in a format their
provider had never used, and context limits that were wrong by up to a factor of
five. All of it looked plausible, which is exactly why it survived several
releases.

1. Add the entry to `src/tokenizer/models.ts`.
2. If you removed or renamed an id, add a `MODEL_ALIASES` entry pointing at the
   nearest live model. Users should be migrated, never silently reset.
3. Run `npm run sync-manifest` to regenerate `package.json`. CI fails if the two
   disagree.
4. `contextLimit` is the **usable input** limit, not the advertised window.

For the encoder:

- **`tiktoken`** if it is an OpenAI model.
- **`hf`** if a `tokenizer.json` is downloadable **anonymously**. Check first —
  Meta's Llama repositories (`meta-llama/`) and Google's Gemma 3 ones return
  401 without an account, so the registry points at ungated mirrors for those.
  Models may share a repo only when their `tokenizer.json` files are
  byte-identical: compare sha256 hashes, never sizes. An API model that
  publishes no tokenizer of its own may use an open checkpoint's repo only when
  the provider says first-hand that it is, or is based on, that checkpoint:
  Qwen's "official version based on", Zhipu documenting FlashX under Flash's
  model code, Google's SDK mapping a Gemini model to a Gemma vocabulary.
- **`heuristic`** if no tokenizer is public. Say so in a comment, and give a
  ratio you have actually measured the way the others are: on a published
  relative's vocabulary if there is one, counted with the bundled libraries
  over the corpus `models.ts` describes (UTF-16 code units divided by tokens,
  less each tokenizer's empty-string baseline), and rounded down to one
  decimal.

Never present an estimate as exact. Counts that quietly disagree with the
provider's billing are worse than no counts.

## Pull requests

- Keep the change focused; separate mechanical refactors from behaviour changes.
- Add a test that fails without your fix.
- Run `npm run lint && npm test` before pushing; CI also runs
  `npm run test:floor`.
- Add a `CHANGELOG.md` entry under the release in progress: a dated section,
  `## [x.y.z] - YYYY-MM-DD`, opened by the first change that needs an entry,
  whose date is set again when it is tagged. Leave `version` in `package.json`
  alone — releases set it.

Commit messages explain *why*, not what. The diff already says what.
