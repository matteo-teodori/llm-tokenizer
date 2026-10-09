Stand-in tokenizer workers for `test/integration/tokenizer.test.ts`. They speak
the same message protocol as `src/worker.ts`, but answer only `count`, with
the text's length, and crash on purpose:

- `crash-async.js` throws asynchronously on the text `CRASH`, without
  replying. Node emits `error` for the worker and then, a turn later, `exit`.
  The next count spawns a replacement in between, so this reproduces the late
  `exit` that used to discard the replacement.
- `crash-load.js` throws as it loads. It records each start in the file named
  by `LLM_TOKENIZER_TEST_SPAWN_LOG`, so the test can count respawns.
