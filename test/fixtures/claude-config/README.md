A stand-in for `~/.claude`. Every test configuration (`.vscode-test.mjs` and
the **Extension Tests** launch configuration) points `CLAUDE_CONFIG_DIR` here,
so that nothing a test runs can read the developer's own Claude Code data, and
`test/index.ts` refuses to run the suite when it points anywhere else.

Transcript fixtures for the usage tests go under this directory, laid out as
Claude Code lays out its own.
