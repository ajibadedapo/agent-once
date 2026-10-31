# Changelog

All notable changes are listed here. The project follows [Semantic Versioning](https://semver.org/). The npm package `agent-once` and the PyPI package `once-guard` are released together with the same version.

## 0.1.0 (unreleased)

First release.

- **Guarantee:** at most once by default, exactly once wherever a reconciler can confirm the outcome.
- **MCP proxy:** `agent-once mcp -- <server command>` guards any stdio MCP server for any MCP client, using tool annotations and an optional JSON config. Includes the `agent_once_resolve` tool, MCP elicitation, an optional signed approval webhook, and `agent-once resolve` and `agent-once ledger list` for people.
- **Browser rules:** page-aware guarding for `@playwright/mcp` and `chrome-devtools-mcp` clicks and submits, with labels from snapshots, success and failure markers, captured values and read-back.
- **Ledger format v1:** an append-only SQLite ledger shared by the TypeScript and Python cores, specified in `spec/ledger-v1.md` with shared test vectors.
- **TypeScript core:** `Guard`, SQLite and memory ledgers, `guardedFetch` with `Idempotency-Key`, JSONL and OpenTelemetry evidence.
- **Python core (`once-guard`, import `agent_once`):** `Guard`, the `@guard.tool` decorator for sync and async functions, SQLite and memory ledgers, idempotency headers, and a pytest plugin.
- **Integrations:** Claude Agent SDK helpers (`guardMcpServers`, `guardSdkTool`, `agentOnceElicitationHandler`) and a Playwright MCP preset.
- **Chaos suite:** four reference targets with ground truth and fault injection, scripted agents, external agents by command, `agent-once chaos run`, vitest matchers, pytest fixtures and a GitHub Action.
- **Benchmark:** `RESULTS.md` with measured guard overhead and duplicate rates with and without the guard, including the known limitation `connection_reset_after_commit`.
