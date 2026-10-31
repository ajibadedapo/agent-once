# Contributing

Thanks for helping. Bug reports with a reproduction, chaos scenarios that break the guard, and read-back configs for real sites are the most valuable contributions.

## Setup

You need Node.js 22.13 or later (see `.nvmrc`), npm, and [uv](https://docs.astral.sh/uv/) for the Python package.

```bash
npm ci
npm run build
npm test
```

`npm test` at the root runs everything except the browser end-to-end tests: the style checks, the spec vectors, the TypeScript tests, the bench harness tests, the GitHub Action and docs checks, and the Python tests.

| Command | What it runs |
|---|---|
| `npm run build` | Compiles `packages/agent-once` to `dist/` |
| `npm run typecheck` | Type checks the package, the examples and the bench |
| `npm run check:style` | The no-comments and no-em-dash rules for TypeScript, JavaScript and Python |
| `npm test --workspace agent-once` | vitest for the TypeScript package |
| `npm run test:browser` | End-to-end tests with the real `@playwright/mcp` and Chromium (run `npx playwright install chromium` first) |
| `uv run --project python pytest python/tests` | pytest for the Python package |
| `cd python && uv run ruff check . && uv run mypy --strict src` | Python lint and types |
| `node --test scripts/check-docs.test.mjs` | Docs checks: README first line, links, TypeScript blocks, numbers quoted from RESULTS.md |

Notes:

- The vitest config builds the package with `tsc` before every run (a global setup step), because several tests start the built CLI.
- `pretest:browser` checks that the Chromium revision for `@playwright/mcp` 0.0.83 is installed. Bump the pinned `@playwright/mcp` version, that check and its test together.
- The Python chaos tests start the Node CLI; build the package first or set `AGENT_ONCE_CLI`.

## Rules the checks enforce

- **No code comments** of any kind in TypeScript, JavaScript or Python: no inline or block comments, no docstrings, no JSDoc. Names and structure carry the meaning. `npm run check:style` fails on them.
- **No em dashes** (U+2014) anywhere in the repository, including docs and commit messages.
- **README line 1** stays `Stop your AI agent from charging, booking or sending twice.`, and the guarantee is always worded "at most once by default, exactly once wherever a reconciler can confirm the outcome".
- **RESULTS.md is generated.** Never edit it by hand. `npm run bench` and `npm run bench:browser` measure and rewrite it; `npm run bench:results` re-renders it from the stored measurements in `bench/results/`. The README quotes figures from it, and the docs check fails if they drift.

## How changes are made

- Every behaviour change comes with a test that fails without it. Use injected time (`ManualClock` in TypeScript, `ManualClock` in Python) with non-zero milliseconds, for example `1_761_912_345_678`; no sleeps or real timers in unit tests.
- The ledger format is shared by both cores. A change to identity, the schema or the decision table starts in [spec/ledger-v1.md](spec/ledger-v1.md) and the vectors in `spec/vectors/`, and lands in both cores in the same change. `uv run --project python python scripts/gen_identity_vectors.py --check` verifies the identity vectors.
- A guard bug that could duplicate or lose an action gets a chaos scenario or property test as well as a unit test.
- Commit messages read `<area>: <what changed>`, with areas spec, core, py, proxy, browser, chaos, integrations, ci, bench and docs.

## Reporting

- Bugs and feature requests: GitHub issues. Include the agent-once version, the MCP server and client, and the config.
- Security problems: privately, as described in [SECURITY.md](SECURITY.md).

By contributing you agree that your contribution is licensed under the Apache License 2.0 ([LICENSE](LICENSE)). Please follow the [code of conduct](CODE_OF_CONDUCT.md).
