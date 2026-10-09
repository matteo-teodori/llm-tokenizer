A stand-in for `~/.claude`. Every test configuration (`.vscode-test.mjs` and
the **Extension Tests** launch configuration) points `CLAUDE_CONFIG_DIR` here,
so that nothing a test runs can read the developer's own Claude Code data, and
`test/index.ts` refuses to run the suite when it points anywhere else.

`projects/` holds synthetic transcripts, laid out as Claude Code lays out its
own. Every record shape below was observed in Claude Code 2.1.220–2.1.292; the
values are invented, and the totals can be worked out by hand.

| File | Shape | Pins |
|---|---|---|
| `-repo-app/sess-main-1.jsonl` | main transcript: a user record with the session's cwd (`/repo/app`), R1 in two streaming snapshots (output 20, then 60 with 25 thinking tokens), R2 with `effort` and `requestedModel: claude-opus-5-5[1m]`, a `<synthetic>` placeholder carrying `quotaLimits`, a `system/api_error`, a `system/compact_boundary` | the oracle; the largest-output snapshot wins whole; the variant kept apart; limit hits come from synthetic records, which are not requests |
| `-repo-app/sess-main-1.orphaned-1791000000-abc.jsonl` | a documented set-aside copy, holding R2 again | the global key counts R2 once |
| `-repo-app/sess-main-1/subagents/agent-a1.jsonl` | a Task subagent, `isSidechain: true`: R3 in two snapshots (output 3, then 9) | subagents are inside the total, once |
| `-repo-app/sess-main-1/subagents/workflows/wf_run1/agent-w1.jsonl` | a workflow agent: R4 at 23:30 UTC, then a malformed line | the run id from the path; a malformed line is counted, never quoted; R4 falls on 10 October in Rome |
| `…/wf_run1/journal.jsonl` | a workflow journal | skipped |
| `-repo-app/sess-main-1/tool-results/decoy.jsonl` | an assistant record under `tool-results/` | never read |

Totals, as (input, cache creation, cache read, output) = processed:

- R1 = (120, 50, 800, 60) = 1,030; R2 = (70, 10, 100, 30) = 210; the main
  transcript, the oracle's session: (190, 60, 900, 90) = 1,240.
- R3 = (5, 1, 7, 9) = 22, kind `task`. R4 = (2, 0, 10, 4) = 16, kind
  `workflow`.
- Everything: (197, 61, 917, 103) = 1,278 over 4 requests. Cache writes are
  all 5-minute: 61. Thinking: 25.
- By day in UTC: 2026-10-09, 1,278. In Europe/Rome: 2026-10-09, 1,262 and
  2026-10-10, 16.
- One limit hit (`five_hour`, resets at 1791561600), one compaction (auto,
  160,000 → 12,000 tokens), one synthetic record, one API error, one
  malformed line (`json-syntax`).
