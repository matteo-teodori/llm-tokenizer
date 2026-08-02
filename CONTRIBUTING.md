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
src/            extension source, bundled by esbuild into out/
  tokenizer/    the tokenizer engine: registry, encoders, worker protocol
  scan.ts       workspace traversal, gitignore handling, file eligibility
  extension.ts  activation, commands, event wiring
test/
  unit/         logic that does not need a real workspace
  integration/  drives the extension host and the bundled worker
  fixtures/     a deliberately awkward workspace the tests assert against
scripts/        build-time tooling
build.mjs       the bundler
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
| `npm test` | Compile the tests and run them in VS Code |
| `npm run sync-manifest` | Regenerate the settings dropdown from the registry |
| `npm run package` | Everything a release needs, without publishing |

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
  Meta's and Google's own repositories return 401 without an account, so the
  registry points at ungated mirrors.
- **`heuristic`** if no tokenizer is public. Say so in a comment, and give a
  ratio you have actually measured.

Never present an estimate as exact. Counts that quietly disagree with the
provider's billing are worse than no counts.

## Pull requests

- Keep the change focused; separate mechanical refactors from behaviour changes.
- Add a test that fails without your fix.
- Run `npm run lint && npm test` before pushing.
- Add a `CHANGELOG.md` entry under `## [Unreleased]`. Leave `version` in
  `package.json` alone — releases set it.

Commit messages explain *why*, not what. The diff already says what.
