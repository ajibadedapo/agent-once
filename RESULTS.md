# agent-once benchmark results

Generated 2026-10-31T22:12:29.937Z. Every result in this file was measured by the commands below on the machine listed under Guard overhead. Nothing here is taken from another source. The only figures that are not measurements are the token-usage assumptions under Not run, and each is marked as an assumption.

Reproduce with one command from the repository root: `npm ci && npm run build && npx playwright install chromium && npm run bench && npm run bench:browser`

## Guard overhead

Measured at 2026-10-31T22:12:29.718Z by `npm run bench`.

Target: p50 under 5 ms per guarded call on SQLite WAL with synchronous NORMAL. Met: yes (core p50 0.100 ms, proxy p50 0.102 ms, Python p50 0.155 ms).

Overhead is the paired difference between a guarded call and the same call without the guard, over 5000 iterations after 500 warm-up calls. Every guarded call is a new action, so each one writes intended, sent and confirmed to a ledger file. Core and Python wrap a no-op; the proxy row compares a guarded tool with a pass tool on the same in-process proxy and upstream.

| Measurement | p50 ms | p99 ms | mean ms | Iterations |
|---|---|---|---|---|
| Core: Guard.run on SQLite WAL | 0.100 | 2.812 | 0.159 | 5000 |
| Proxy: guarded tools/call through the in-process MCP proxy | 0.102 | 3.151 | 0.166 | 5000 |
| Python: Guard.run on sqlite3 WAL | 0.155 | 2.936 | 0.213 | 5000 |

Machine: Apple M3 (8 cores), darwin 25.6.0 arm64. Node v22.23.4, SQLite 3.53.4 (node:sqlite). Python 3.12.13, SQLite 3.50.4 (sqlite3).

## API path

Measured at 2026-10-31T22:12:29.936Z by `npm run bench`.

Scripted agents call the four reference targets through the targets MCP server, with and without the guard, on a manual clock. The scripted agents are deterministic, so each cell runs once: repeating a cell gives the same result. scripted:naive retries every error after a growing delay of simulated time; scripted:obedient checks the list tool and resolves the action when the guard reports doubt.

Totals: without the guard 24 duplicates and 0 missing effects in 48 runs; with the guard 0 duplicates and 0 missing effects in 48 runs.

| Agent | Scenario | Target | Runs, guard off | Duplicate rate, guard off | Missing rate, guard off | Runs, guard on | Duplicate rate, guard on | Missing rate, guard on |
|---|---|---|---|---|---|---|---|---|
| scripted:naive | lost_response_after_commit | checkout | 1 | 100.0% (1/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) |
| scripted:naive | lost_response_after_commit | booking | 1 | 100.0% (1/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) |
| scripted:naive | lost_response_after_commit | email | 1 | 100.0% (1/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) |
| scripted:naive | lost_response_after_commit | ticket | 1 | 100.0% (1/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) |
| scripted:naive | slow_commit | checkout | 1 | 100.0% (1/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) |
| scripted:naive | slow_commit | booking | 1 | 100.0% (1/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) |
| scripted:naive | slow_commit | email | 1 | 100.0% (1/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) |
| scripted:naive | slow_commit | ticket | 1 | 100.0% (1/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) |
| scripted:naive | timeout_before_commit | checkout | 1 | 0.0% (0/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) |
| scripted:naive | timeout_before_commit | booking | 1 | 0.0% (0/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) |
| scripted:naive | timeout_before_commit | email | 1 | 0.0% (0/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) |
| scripted:naive | timeout_before_commit | ticket | 1 | 0.0% (0/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) |
| scripted:naive | stale_element | checkout | 1 | 0.0% (0/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) |
| scripted:naive | stale_element | booking | 1 | 0.0% (0/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) |
| scripted:naive | stale_element | email | 1 | 0.0% (0/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) |
| scripted:naive | stale_element | ticket | 1 | 0.0% (0/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) |
| scripted:naive | crash_mid_run | checkout | 1 | 100.0% (1/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) |
| scripted:naive | crash_mid_run | booking | 1 | 100.0% (1/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) |
| scripted:naive | crash_mid_run | email | 1 | 100.0% (1/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) |
| scripted:naive | crash_mid_run | ticket | 1 | 100.0% (1/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) |
| scripted:naive | no_fault | checkout | 1 | 0.0% (0/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) |
| scripted:naive | no_fault | booking | 1 | 0.0% (0/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) |
| scripted:naive | no_fault | email | 1 | 0.0% (0/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) |
| scripted:naive | no_fault | ticket | 1 | 0.0% (0/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) |
| scripted:obedient | lost_response_after_commit | checkout | 1 | 100.0% (1/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) |
| scripted:obedient | lost_response_after_commit | booking | 1 | 100.0% (1/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) |
| scripted:obedient | lost_response_after_commit | email | 1 | 100.0% (1/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) |
| scripted:obedient | lost_response_after_commit | ticket | 1 | 100.0% (1/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) |
| scripted:obedient | slow_commit | checkout | 1 | 100.0% (1/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) |
| scripted:obedient | slow_commit | booking | 1 | 100.0% (1/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) |
| scripted:obedient | slow_commit | email | 1 | 100.0% (1/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) |
| scripted:obedient | slow_commit | ticket | 1 | 100.0% (1/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) |
| scripted:obedient | timeout_before_commit | checkout | 1 | 0.0% (0/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) |
| scripted:obedient | timeout_before_commit | booking | 1 | 0.0% (0/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) |
| scripted:obedient | timeout_before_commit | email | 1 | 0.0% (0/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) |
| scripted:obedient | timeout_before_commit | ticket | 1 | 0.0% (0/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) |
| scripted:obedient | stale_element | checkout | 1 | 0.0% (0/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) |
| scripted:obedient | stale_element | booking | 1 | 0.0% (0/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) |
| scripted:obedient | stale_element | email | 1 | 0.0% (0/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) |
| scripted:obedient | stale_element | ticket | 1 | 0.0% (0/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) |
| scripted:obedient | crash_mid_run | checkout | 1 | 100.0% (1/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) |
| scripted:obedient | crash_mid_run | booking | 1 | 100.0% (1/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) |
| scripted:obedient | crash_mid_run | email | 1 | 100.0% (1/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) |
| scripted:obedient | crash_mid_run | ticket | 1 | 100.0% (1/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) |
| scripted:obedient | no_fault | checkout | 1 | 0.0% (0/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) |
| scripted:obedient | no_fault | booking | 1 | 0.0% (0/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) |
| scripted:obedient | no_fault | email | 1 | 0.0% (0/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) |
| scripted:obedient | no_fault | ticket | 1 | 0.0% (0/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) |

## Browser path

Measured at 2026-10-31T22:08:29.385Z by `npm run bench:browser`.

A scripted browser agent (scripted-browser:naive) drives the real @playwright/mcp 0.0.83 server (playwright-core 1.64.0-alpha-1790635538000) with headless Chromium 155.0.8059.12 (revision 1247) against the four reference targets on the real clock. Each attempt navigates to the form, takes a snapshot, and clicks the submit button; after anything but a confirmation page or a guard replay it waits 1, 2, 4, 4 s and tries again (a naive retry). Faults that hold a commit hold it for 2000 ms and the guard's settle window is 3 s, so a run stays short. With the guard on, the agent talks to the agent-once proxy wrapping the same Playwright MCP command, configured with the chaos targets preset (browser read-back from each history page).

Runs per cell: 3.

Totals: without the guard 36 duplicates, 12 of which are the known limitation connection_reset_after_commit, and 0 missing effects in 72 runs; with the guard 12 duplicates, 12 of which are the known limitation connection_reset_after_commit, and 0 missing effects in 72 runs.

| Agent | Scenario | Target | Runs, guard off | Duplicate rate, guard off | Missing rate, guard off | Runs, guard on | Duplicate rate, guard on | Missing rate, guard on |
|---|---|---|---|---|---|---|---|---|
| scripted-browser:naive | no_fault | checkout | 3 | 0.0% (0/3) | 0.0% (0/3) | 3 | 0.0% (0/3) | 0.0% (0/3) |
| scripted-browser:naive | no_fault | booking | 3 | 0.0% (0/3) | 0.0% (0/3) | 3 | 0.0% (0/3) | 0.0% (0/3) |
| scripted-browser:naive | no_fault | email | 3 | 0.0% (0/3) | 0.0% (0/3) | 3 | 0.0% (0/3) | 0.0% (0/3) |
| scripted-browser:naive | no_fault | ticket | 3 | 0.0% (0/3) | 0.0% (0/3) | 3 | 0.0% (0/3) | 0.0% (0/3) |
| scripted-browser:naive | lost_response_after_commit | checkout | 3 | 100.0% (3/3) | 0.0% (0/3) | 3 | 0.0% (0/3) | 0.0% (0/3) |
| scripted-browser:naive | lost_response_after_commit | booking | 3 | 100.0% (3/3) | 0.0% (0/3) | 3 | 0.0% (0/3) | 0.0% (0/3) |
| scripted-browser:naive | lost_response_after_commit | email | 3 | 100.0% (3/3) | 0.0% (0/3) | 3 | 0.0% (0/3) | 0.0% (0/3) |
| scripted-browser:naive | lost_response_after_commit | ticket | 3 | 100.0% (3/3) | 0.0% (0/3) | 3 | 0.0% (0/3) | 0.0% (0/3) |
| scripted-browser:naive | slow_commit | checkout | 3 | 100.0% (3/3) | 0.0% (0/3) | 3 | 0.0% (0/3) | 0.0% (0/3) |
| scripted-browser:naive | slow_commit | booking | 3 | 100.0% (3/3) | 0.0% (0/3) | 3 | 0.0% (0/3) | 0.0% (0/3) |
| scripted-browser:naive | slow_commit | email | 3 | 100.0% (3/3) | 0.0% (0/3) | 3 | 0.0% (0/3) | 0.0% (0/3) |
| scripted-browser:naive | slow_commit | ticket | 3 | 100.0% (3/3) | 0.0% (0/3) | 3 | 0.0% (0/3) | 0.0% (0/3) |
| scripted-browser:naive | timeout_before_commit | checkout | 3 | 0.0% (0/3) | 0.0% (0/3) | 3 | 0.0% (0/3) | 0.0% (0/3) |
| scripted-browser:naive | timeout_before_commit | booking | 3 | 0.0% (0/3) | 0.0% (0/3) | 3 | 0.0% (0/3) | 0.0% (0/3) |
| scripted-browser:naive | timeout_before_commit | email | 3 | 0.0% (0/3) | 0.0% (0/3) | 3 | 0.0% (0/3) | 0.0% (0/3) |
| scripted-browser:naive | timeout_before_commit | ticket | 3 | 0.0% (0/3) | 0.0% (0/3) | 3 | 0.0% (0/3) | 0.0% (0/3) |
| scripted-browser:naive | stale_element | checkout | 3 | 0.0% (0/3) | 0.0% (0/3) | 3 | 0.0% (0/3) | 0.0% (0/3) |
| scripted-browser:naive | stale_element | booking | 3 | 0.0% (0/3) | 0.0% (0/3) | 3 | 0.0% (0/3) | 0.0% (0/3) |
| scripted-browser:naive | stale_element | email | 3 | 0.0% (0/3) | 0.0% (0/3) | 3 | 0.0% (0/3) | 0.0% (0/3) |
| scripted-browser:naive | stale_element | ticket | 3 | 0.0% (0/3) | 0.0% (0/3) | 3 | 0.0% (0/3) | 0.0% (0/3) |
| scripted-browser:naive | connection_reset_after_commit | checkout | 3 | 100.0% (3/3) | 0.0% (0/3) | 3 | 100.0% (3/3) | 0.0% (0/3) |
| scripted-browser:naive | connection_reset_after_commit | booking | 3 | 100.0% (3/3) | 0.0% (0/3) | 3 | 100.0% (3/3) | 0.0% (0/3) |
| scripted-browser:naive | connection_reset_after_commit | email | 3 | 100.0% (3/3) | 0.0% (0/3) | 3 | 100.0% (3/3) | 0.0% (0/3) |
| scripted-browser:naive | connection_reset_after_commit | ticket | 3 | 100.0% (3/3) | 0.0% (0/3) | 3 | 100.0% (3/3) | 0.0% (0/3) |

## Known limitations

- connection_reset_after_commit on the browser path, scripted agents: measured duplicate rate 100.0% (12/12) without the guard and 100.0% (12/12) with it. Chromium re-sends the POST below the MCP layer when the connection resets after the commit, so the server sees two submissions from one click. The guard only sees one browser_click and cannot stop a retry it never receives.

## Not run

- Claude via the Claude Agent SDK (claude-agent-sdk), API and browser paths: no API key in the environment; needs Hammed's approval (run `npm run bench:real -- --confirm-spend` with ANTHROPIC_API_KEY set)
- OpenAI via the Chat Completions API (openai), API and browser paths: no API key in the environment; needs Hammed's approval (run `npm run bench:real -- --confirm-spend` with OPENAI_API_KEY set)
- crash_mid_run on the browser path: there is no crash harness for the browser path in this release; it is measured on the API path only.
- Postgres and Redis ledgers: not part of v1, so not measured. Every overhead number above is SQLite.

Real-model runs planned: claude-agent-sdk, openai, 3 runs per cell, with and without the guard.

Cost estimate: to be filled in before approval. Token-usage assumptions for that estimate:

- runs: API path: 48 cells x 3 runs x 2 agents = 288 runs; browser path: 48 cells x 3 runs x 2 agents = 288 runs
- API tool calls per run: mean 2.2, max 5 (scripted agents)
- browser tool calls per run: mean 6.3, max 12 (scripted browser agent)
- browser tool response size: mean 475 characters per call, about 119 tokens at an assumed 4 characters per token; the largest run returned 5672 characters in total
- browser_snapshot size: mean 546 characters, about 137 tokens at the same assumed ratio; largest 626 characters, about 157 tokens, over 300 snapshots of the reference pages (small forms; snapshots of other sites were not measured)
- input tokens per model call: the system prompt and tool definitions (not measured here) plus the whole conversation so far, so call k of a run re-sends the k - 1 earlier tool results; per run that is about C x B + R x C x (C - 1) / 2 tokens for C calls, B fixed tokens and R tokens per tool result
- output tokens per model call: assumed about 100 (one tool call with short arguments); not measured
- a real model may call more or fewer tools than the scripted agents; the scripted counts above are a starting point, not a measurement of any model

## Failures

Every guarded run that duplicated or lost an effect, and every run whose agent failed. Unguarded duplicates are the problem the guard exists to stop and are reported in the tables above, not here.

- duplicate: browser path, scripted-browser:naive, connection_reset_after_commit, checkout, 2 effects (known limitation: Chromium re-sends the POST below the MCP layer when the connection resets after the commit, so the server sees two submissions from one click)
- duplicate: browser path, scripted-browser:naive, connection_reset_after_commit, checkout, 2 effects (known limitation: Chromium re-sends the POST below the MCP layer when the connection resets after the commit, so the server sees two submissions from one click)
- duplicate: browser path, scripted-browser:naive, connection_reset_after_commit, checkout, 2 effects (known limitation: Chromium re-sends the POST below the MCP layer when the connection resets after the commit, so the server sees two submissions from one click)
- duplicate: browser path, scripted-browser:naive, connection_reset_after_commit, booking, 2 effects (known limitation: Chromium re-sends the POST below the MCP layer when the connection resets after the commit, so the server sees two submissions from one click)
- duplicate: browser path, scripted-browser:naive, connection_reset_after_commit, booking, 2 effects (known limitation: Chromium re-sends the POST below the MCP layer when the connection resets after the commit, so the server sees two submissions from one click)
- duplicate: browser path, scripted-browser:naive, connection_reset_after_commit, booking, 2 effects (known limitation: Chromium re-sends the POST below the MCP layer when the connection resets after the commit, so the server sees two submissions from one click)
- duplicate: browser path, scripted-browser:naive, connection_reset_after_commit, email, 2 effects (known limitation: Chromium re-sends the POST below the MCP layer when the connection resets after the commit, so the server sees two submissions from one click)
- duplicate: browser path, scripted-browser:naive, connection_reset_after_commit, email, 2 effects (known limitation: Chromium re-sends the POST below the MCP layer when the connection resets after the commit, so the server sees two submissions from one click)
- duplicate: browser path, scripted-browser:naive, connection_reset_after_commit, email, 2 effects (known limitation: Chromium re-sends the POST below the MCP layer when the connection resets after the commit, so the server sees two submissions from one click)
- duplicate: browser path, scripted-browser:naive, connection_reset_after_commit, ticket, 2 effects (known limitation: Chromium re-sends the POST below the MCP layer when the connection resets after the commit, so the server sees two submissions from one click)
- duplicate: browser path, scripted-browser:naive, connection_reset_after_commit, ticket, 2 effects (known limitation: Chromium re-sends the POST below the MCP layer when the connection resets after the commit, so the server sees two submissions from one click)
- duplicate: browser path, scripted-browser:naive, connection_reset_after_commit, ticket, 2 effects (known limitation: Chromium re-sends the POST below the MCP layer when the connection resets after the commit, so the server sees two submissions from one click)
