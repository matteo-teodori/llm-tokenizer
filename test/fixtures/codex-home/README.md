A stand-in for `~/.codex`. Every test configuration (`.vscode-test.mjs` and
the **Extension Tests** launch configuration) points `CODEX_HOME` here, so
that nothing a test runs can read the developer's own Codex data, and
`test/index.ts` refuses to run the suite when it points anywhere else.

`sessions/` holds one synthetic rollout, laid out as Codex lays out its own:
the line shapes are Codex's own (codex-rs at rust-v0.169.0: `RolloutLineRef`,
`SessionMeta`, `TurnContextItem`, `TokenUsageRecord`, `TokenCountEvent`),
the values invented, and the totals can be worked out by hand.

| Line | Pins |
|---|---|
| `session_meta` | the thread, its session, its cwd (`/repo/codex-app`), Codex 0.169.0 |
| `turn_context` | the model, `gpt-5.5`, and the effort, `medium` |
| `response_item` | a message's content: never parsed |
| two `token_usage_record` | the two responses, `resp_c1` and `resp_c2`: what counts |
| two `token_count` | running totals and a rate-limit snapshot: counted nothing, as records are there |

Totals, as (input, cache creation, cache read, output) = processed, input being
what is left of Codex's `input_tokens` once the cached tokens are taken out:

- resp_c1 = (600, 0, 400, 100) = 1,100, 40 of its output thinking;
- resp_c2 = (500, 0, 1,500, 200) = 2,200, 50 of it thinking;
- the session, on 2026-10-09 UTC: (1,100, 0, 1,900, 300) = 3,300.
