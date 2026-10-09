Stand-in tokenizer workers for `test/integration/tokenizer.test.ts`. They crash
on purpose:

- `crash-async.js` answers every count with the text's length, and throws
  asynchronously on the text `CRASH`, without replying. Node emits `error` for
  the worker and then, usually a turn later, `exit`. The next count spawns a
  replacement in between, so this reproduces the late `exit` that used to
  discard the replacement.
- `crash-load.js` throws as it loads. It records each start in the file named
  by `LLM_TOKENIZER_TEST_SPAWN_LOG`, so the test can count respawns.
- `crash-first-start.js` throws on its first start only, counted the same way,
  and runs the real bundled `out/worker.js` on every later start. It
  reproduces a crash in the middle of loading a downloaded vocabulary.
- `crash-on-demand.js` runs the real bundled worker, but throws asynchronously,
  without replying, on a count of the text `CRASH`. That count settles only
  once the service has handled the crash, so a test can crash the worker at a
  moment of its choosing between real loads and counts.
