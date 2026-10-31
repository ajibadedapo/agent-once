# agent-once benchmark results

Generated 2026-10-31T23:25:48.505Z. Every measured number in this file comes from this run, made with the commands below on the machine listed under Guard overhead. The cost estimate under Not run is not a measurement: it uses a dated price table (Anthropic's model pricing table as cached on 2026-10-06; re-verify before running) and the token-usage assumptions listed with it.

Reproduce with one command from the repository root: `npm ci && npm run build && npx playwright install chromium && npm run bench && npm run bench:browser`

## Guard overhead

Measured at 2026-10-31T22:25:35.501Z by `npm run bench`.

Target: p50 under 5 ms per guarded call on SQLite WAL with synchronous NORMAL. Met: yes (core p50 0.102 ms, proxy p50 0.104 ms, Python p50 0.160 ms).

Overhead is the paired difference between a guarded call and the same call without the guard, over 5000 iterations after 500 warm-up calls. Every guarded call is a new action, so each one writes intended, sent and confirmed to a ledger file. Core and Python wrap a no-op; the proxy row compares a guarded tool with a pass tool on the same in-process proxy and upstream.

| Measurement | p50 ms | p99 ms | mean ms | Over 1 ms | Iterations |
|---|---|---|---|---|---|
| Core: Guard.run on SQLite WAL | 0.102 | 2.992 | 0.162 | 2.0% (98/5000) | 5000 |
| Proxy: guarded tools/call through the in-process MCP proxy | 0.104 | 3.314 | 0.172 | 2.0% (99/5000) | 5000 |
| Python: Guard.run on sqlite3 WAL | 0.160 | 3.243 | 0.242 | 2.0% (102/5000) | 5000 |

Tail probe, core only, 3 interleaved repeats of 5000 guarded calls per mode, calls over 1 ms: default WAL auto-checkpoint 107, 100, 98; wal_autocheckpoint = 0: 62, 51, 15; in-memory ledger: 0, 2, 0. In every repeat turning off WAL auto-checkpoint left fewer slow calls (at most 62, against at least 98), so that difference is attributed to WAL auto-checkpoint. The slow calls that remain with it off are not attributed to a cause.

Machine: Apple M3 (8 cores), darwin 25.6.0 arm64. Node v22.23.4, SQLite 3.53.4 (node:sqlite). Python 3.12.13, SQLite 3.50.4 (sqlite3).

## API path

Measured at 2026-10-31T22:25:35.726Z by `npm run bench`.

Scripted agents call the four reference targets through the targets MCP server, with and without the guard, on a manual clock, so the mean durations are simulated time. The scripted agents are deterministic, so each cell runs once: repeating a cell gives the same result. scripted:naive retries every error after a growing delay of simulated time; scripted:obedient checks the list tool and resolves the action when the guard reports doubt.

Totals: without the guard 24 duplicates and 0 missing effects in 48 runs; with the guard 0 duplicates and 0 missing effects in 48 runs.

| Agent | Scenario | Target | Runs, guard off | Duplicate rate, guard off | Missing rate, guard off | Runs, guard on | Duplicate rate, guard on | Missing rate, guard on | Mean duration, guard off | Mean duration, guard on |
|---|---|---|---|---|---|---|---|---|---|---|
| scripted:naive | lost_response_after_commit | checkout | 1 | 100.0% (1/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) | 2.0 s | 2.0 s |
| scripted:naive | lost_response_after_commit | booking | 1 | 100.0% (1/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) | 2.0 s | 2.0 s |
| scripted:naive | lost_response_after_commit | email | 1 | 100.0% (1/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) | 2.0 s | 2.0 s |
| scripted:naive | lost_response_after_commit | ticket | 1 | 100.0% (1/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) | 2.0 s | 2.0 s |
| scripted:naive | slow_commit | checkout | 1 | 100.0% (1/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) | 2.0 s | 6.0 s |
| scripted:naive | slow_commit | booking | 1 | 100.0% (1/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) | 2.0 s | 6.0 s |
| scripted:naive | slow_commit | email | 1 | 100.0% (1/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) | 2.0 s | 6.0 s |
| scripted:naive | slow_commit | ticket | 1 | 100.0% (1/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) | 2.0 s | 6.0 s |
| scripted:naive | timeout_before_commit | checkout | 1 | 0.0% (0/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) | 2.0 s | 14.0 s |
| scripted:naive | timeout_before_commit | booking | 1 | 0.0% (0/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) | 2.0 s | 14.0 s |
| scripted:naive | timeout_before_commit | email | 1 | 0.0% (0/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) | 2.0 s | 14.0 s |
| scripted:naive | timeout_before_commit | ticket | 1 | 0.0% (0/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) | 2.0 s | 14.0 s |
| scripted:naive | stale_element | checkout | 1 | 0.0% (0/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) | 2.0 s | 2.0 s |
| scripted:naive | stale_element | booking | 1 | 0.0% (0/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) | 2.0 s | 2.0 s |
| scripted:naive | stale_element | email | 1 | 0.0% (0/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) | 2.0 s | 2.0 s |
| scripted:naive | stale_element | ticket | 1 | 0.0% (0/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) | 2.0 s | 2.0 s |
| scripted:naive | crash_mid_run | checkout | 1 | 100.0% (1/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) | 6.0 s | 6.0 s |
| scripted:naive | crash_mid_run | booking | 1 | 100.0% (1/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) | 6.0 s | 6.0 s |
| scripted:naive | crash_mid_run | email | 1 | 100.0% (1/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) | 6.0 s | 6.0 s |
| scripted:naive | crash_mid_run | ticket | 1 | 100.0% (1/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) | 6.0 s | 6.0 s |
| scripted:naive | no_fault | checkout | 1 | 0.0% (0/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) | 0.0 s | 0.0 s |
| scripted:naive | no_fault | booking | 1 | 0.0% (0/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) | 0.0 s | 0.0 s |
| scripted:naive | no_fault | email | 1 | 0.0% (0/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) | 0.0 s | 0.0 s |
| scripted:naive | no_fault | ticket | 1 | 0.0% (0/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) | 0.0 s | 0.0 s |
| scripted:obedient | lost_response_after_commit | checkout | 1 | 100.0% (1/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) | 2.0 s | 2.0 s |
| scripted:obedient | lost_response_after_commit | booking | 1 | 100.0% (1/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) | 2.0 s | 2.0 s |
| scripted:obedient | lost_response_after_commit | email | 1 | 100.0% (1/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) | 2.0 s | 2.0 s |
| scripted:obedient | lost_response_after_commit | ticket | 1 | 100.0% (1/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) | 2.0 s | 2.0 s |
| scripted:obedient | slow_commit | checkout | 1 | 100.0% (1/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) | 2.0 s | 17.0 s |
| scripted:obedient | slow_commit | booking | 1 | 100.0% (1/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) | 2.0 s | 17.0 s |
| scripted:obedient | slow_commit | email | 1 | 100.0% (1/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) | 2.0 s | 17.0 s |
| scripted:obedient | slow_commit | ticket | 1 | 100.0% (1/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) | 2.0 s | 17.0 s |
| scripted:obedient | timeout_before_commit | checkout | 1 | 0.0% (0/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) | 2.0 s | 17.0 s |
| scripted:obedient | timeout_before_commit | booking | 1 | 0.0% (0/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) | 2.0 s | 17.0 s |
| scripted:obedient | timeout_before_commit | email | 1 | 0.0% (0/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) | 2.0 s | 17.0 s |
| scripted:obedient | timeout_before_commit | ticket | 1 | 0.0% (0/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) | 2.0 s | 17.0 s |
| scripted:obedient | stale_element | checkout | 1 | 0.0% (0/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) | 2.0 s | 2.0 s |
| scripted:obedient | stale_element | booking | 1 | 0.0% (0/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) | 2.0 s | 2.0 s |
| scripted:obedient | stale_element | email | 1 | 0.0% (0/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) | 2.0 s | 2.0 s |
| scripted:obedient | stale_element | ticket | 1 | 0.0% (0/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) | 2.0 s | 2.0 s |
| scripted:obedient | crash_mid_run | checkout | 1 | 100.0% (1/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) | 6.0 s | 6.0 s |
| scripted:obedient | crash_mid_run | booking | 1 | 100.0% (1/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) | 6.0 s | 6.0 s |
| scripted:obedient | crash_mid_run | email | 1 | 100.0% (1/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) | 6.0 s | 6.0 s |
| scripted:obedient | crash_mid_run | ticket | 1 | 100.0% (1/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) | 6.0 s | 6.0 s |
| scripted:obedient | no_fault | checkout | 1 | 0.0% (0/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) | 0.0 s | 0.0 s |
| scripted:obedient | no_fault | booking | 1 | 0.0% (0/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) | 0.0 s | 0.0 s |
| scripted:obedient | no_fault | email | 1 | 0.0% (0/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) | 0.0 s | 0.0 s |
| scripted:obedient | no_fault | ticket | 1 | 0.0% (0/1) | 0.0% (0/1) | 1 | 0.0% (0/1) | 0.0% (0/1) | 0.0 s | 0.0 s |

## Browser path

Measured at 2026-10-31T22:08:29.385Z by `npm run bench:browser`.

A scripted browser agent (scripted-browser:naive) drives the real @playwright/mcp 0.0.83 server (playwright-core 1.64.0-alpha-1790635538000) with headless Chromium 155.0.8059.12 (revision 1247) against the four reference targets on the real clock. Each attempt navigates to the form, takes a snapshot, and clicks the submit button; after anything but a confirmation page or a guard replay it waits 1, 2, 4, 4 s and tries again (a naive retry). Faults that hold a commit hold it for 2000 ms and the guard's settle window is 3 s, so a run stays short. With the guard on, the agent talks to the agent-once proxy wrapping the same Playwright MCP command, configured with the chaos targets preset (browser read-back from each history page).

Runs per cell: 3.

Totals: without the guard 36 duplicates, 12 of which are the known limitation connection_reset_after_commit, and 0 missing effects in 72 runs; with the guard 12 duplicates, 12 of which are the known limitation connection_reset_after_commit, and 0 missing effects in 72 runs.

| Agent | Scenario | Target | Runs, guard off | Duplicate rate, guard off | Missing rate, guard off | Runs, guard on | Duplicate rate, guard on | Missing rate, guard on | Mean duration, guard off | Mean duration, guard on |
|---|---|---|---|---|---|---|---|---|---|---|
| scripted-browser:naive | no_fault | checkout | 3 | 0.0% (0/3) | 0.0% (0/3) | 3 | 0.0% (0/3) | 0.0% (0/3) | 1.5 s | 1.5 s |
| scripted-browser:naive | no_fault | booking | 3 | 0.0% (0/3) | 0.0% (0/3) | 3 | 0.0% (0/3) | 0.0% (0/3) | 1.3 s | 1.4 s |
| scripted-browser:naive | no_fault | email | 3 | 0.0% (0/3) | 0.0% (0/3) | 3 | 0.0% (0/3) | 0.0% (0/3) | 1.4 s | 1.4 s |
| scripted-browser:naive | no_fault | ticket | 3 | 0.0% (0/3) | 0.0% (0/3) | 3 | 0.0% (0/3) | 0.0% (0/3) | 1.2 s | 1.5 s |
| scripted-browser:naive | lost_response_after_commit | checkout | 3 | 100.0% (3/3) | 0.0% (0/3) | 3 | 0.0% (0/3) | 0.0% (0/3) | 2.9 s | 2.5 s |
| scripted-browser:naive | lost_response_after_commit | booking | 3 | 100.0% (3/3) | 0.0% (0/3) | 3 | 0.0% (0/3) | 0.0% (0/3) | 2.9 s | 2.4 s |
| scripted-browser:naive | lost_response_after_commit | email | 3 | 100.0% (3/3) | 0.0% (0/3) | 3 | 0.0% (0/3) | 0.0% (0/3) | 2.8 s | 2.4 s |
| scripted-browser:naive | lost_response_after_commit | ticket | 3 | 100.0% (3/3) | 0.0% (0/3) | 3 | 0.0% (0/3) | 0.0% (0/3) | 2.8 s | 2.6 s |
| scripted-browser:naive | slow_commit | checkout | 3 | 100.0% (3/3) | 0.0% (0/3) | 3 | 0.0% (0/3) | 0.0% (0/3) | 2.8 s | 4.5 s |
| scripted-browser:naive | slow_commit | booking | 3 | 100.0% (3/3) | 0.0% (0/3) | 3 | 0.0% (0/3) | 0.0% (0/3) | 3.5 s | 4.5 s |
| scripted-browser:naive | slow_commit | email | 3 | 100.0% (3/3) | 0.0% (0/3) | 3 | 0.0% (0/3) | 0.0% (0/3) | 2.9 s | 4.5 s |
| scripted-browser:naive | slow_commit | ticket | 3 | 100.0% (3/3) | 0.0% (0/3) | 3 | 0.0% (0/3) | 0.0% (0/3) | 2.8 s | 4.5 s |
| scripted-browser:naive | timeout_before_commit | checkout | 3 | 0.0% (0/3) | 0.0% (0/3) | 3 | 0.0% (0/3) | 0.0% (0/3) | 2.8 s | 9.1 s |
| scripted-browser:naive | timeout_before_commit | booking | 3 | 0.0% (0/3) | 0.0% (0/3) | 3 | 0.0% (0/3) | 0.0% (0/3) | 2.9 s | 9.1 s |
| scripted-browser:naive | timeout_before_commit | email | 3 | 0.0% (0/3) | 0.0% (0/3) | 3 | 0.0% (0/3) | 0.0% (0/3) | 2.9 s | 9.1 s |
| scripted-browser:naive | timeout_before_commit | ticket | 3 | 0.0% (0/3) | 0.0% (0/3) | 3 | 0.0% (0/3) | 0.0% (0/3) | 2.8 s | 9.1 s |
| scripted-browser:naive | stale_element | checkout | 3 | 0.0% (0/3) | 0.0% (0/3) | 3 | 0.0% (0/3) | 0.0% (0/3) | 2.8 s | 9.1 s |
| scripted-browser:naive | stale_element | booking | 3 | 0.0% (0/3) | 0.0% (0/3) | 3 | 0.0% (0/3) | 0.0% (0/3) | 2.8 s | 9.6 s |
| scripted-browser:naive | stale_element | email | 3 | 0.0% (0/3) | 0.0% (0/3) | 3 | 0.0% (0/3) | 0.0% (0/3) | 2.9 s | 9.3 s |
| scripted-browser:naive | stale_element | ticket | 3 | 0.0% (0/3) | 0.0% (0/3) | 3 | 0.0% (0/3) | 0.0% (0/3) | 2.8 s | 9.1 s |
| scripted-browser:naive | connection_reset_after_commit | checkout | 3 | 100.0% (3/3) | 0.0% (0/3) | 3 | 100.0% (3/3) | 0.0% (0/3) | 1.4 s | 1.3 s |
| scripted-browser:naive | connection_reset_after_commit | booking | 3 | 100.0% (3/3) | 0.0% (0/3) | 3 | 100.0% (3/3) | 0.0% (0/3) | 1.9 s | 1.3 s |
| scripted-browser:naive | connection_reset_after_commit | email | 3 | 100.0% (3/3) | 0.0% (0/3) | 3 | 100.0% (3/3) | 0.0% (0/3) | 1.3 s | 1.3 s |
| scripted-browser:naive | connection_reset_after_commit | ticket | 3 | 100.0% (3/3) | 0.0% (0/3) | 3 | 100.0% (3/3) | 0.0% (0/3) | 1.2 s | 1.3 s |

## Known limitations

- connection_reset_after_commit on the browser path, scripted agents: measured duplicate rate 100.0% (12/12) without the guard and 100.0% (12/12) with it. Chromium re-sends the POST below the MCP layer when the connection resets after the commit, so the server sees two submissions from one click. The guard only sees one browser_click and cannot stop a retry it never receives.

## Not run

- Claude via the Claude Agent SDK (claude-agent-sdk), API and browser paths: no API key in the environment; needs the maintainer's approval and an API key (run `npm run bench:real -- --confirm-spend --max-spend-usd <dollars>` with ANTHROPIC_API_KEY set)
- OpenAI via the Chat Completions API (openai), API and browser paths: no API key in the environment; needs the maintainer's approval and an API key (run `npm run bench:real -- --confirm-spend --max-spend-usd <dollars>` with OPENAI_API_KEY, AGENT_ONCE_OPENAI_MODEL, AGENT_ONCE_OPENAI_INPUT_USD_PER_MTOK, AGENT_ONCE_OPENAI_OUTPUT_USD_PER_MTOK set)
- crash_mid_run on the browser path: there is no crash harness for the browser path in this release; it is measured on the API path only.
- Postgres and Redis ledgers: not part of v1, so not measured. Every overhead number above is SQLite.

Real-model runs planned: claude-agent-sdk, openai, 3 runs per cell, with and without the guard.

Cost estimate (an estimate, not a measurement) for the claude-agent-sdk share of the planned runs: 288 runs (API path 144, browser path 144). Prices: Anthropic's model pricing table as cached on 2026-10-06; re-verify before running.

Assumed: 8 model turns per run, 20000 tokens of system prompt and tool definitions per turn (read from the prompt cache after the first turn when caching works; the first turn is priced as plain input, without any cache-write surcharge), 2000 tokens of conversation per turn and 500 output tokens per turn. These are assumptions, not measurements.

| Model | Input per MTok | Output per MTok | Cache read per MTok | Per run, with caching | Per run, without caching | 288 runs, with caching | 288 runs, without caching |
|---|---|---|---|---|---|---|---|
| Claude Sonnet 5.5 | $2.00 | $10.00 | $0.20 | $0.14 | $0.39 | $40 | $113 |
| Claude Opus 5.5 | $4.00 | $20.00 | $0.20 | $0.25 | $0.78 | $73 | $226 |

- openai: the cost depends on the model and the prices set in AGENT_ONCE_OPENAI_INPUT_USD_PER_MTOK and AGENT_ONCE_OPENAI_OUTPUT_USD_PER_MTOK, so it is not estimated here.
- Suggested first step: a capped pilot on Claude Sonnet 5.5. Set AGENT_ONCE_CLAUDE_MODEL to its model id and run `npm run bench:real -- --confirm-spend --max-spend-usd 25`; bench:real stops launching runs once the cap is reached and this file reports the runs that finished.

Token-usage inputs for planning, from the scripted runs and stated assumptions:

- runs: API path: 48 cells x 3 runs x 2 agents = 288 runs; browser path: 48 cells x 3 runs x 2 agents = 288 runs
- API tool calls per run: mean 2.2, max 5 (scripted agents)
- browser tool calls per run: mean 6.3, max 12 (scripted browser agent)
- browser tool response size: mean 475 characters per call, about 119 tokens at an assumed 4 characters per token; the largest run returned 5672 characters in total
- browser_snapshot size: mean 546 characters, about 137 tokens at the same assumed ratio; largest 626 characters, about 157 tokens, over 300 snapshots of the reference pages (small forms; snapshots of other sites were not measured)
- input tokens per model turn: the system prompt and tool definitions (not measured here) plus the whole conversation so far, so turn k of a run re-sends the k - 1 earlier tool results; per run that is about C x B + R x C x (C - 1) / 2 tokens for C turns of one tool call each, B fixed tokens and R tokens per tool result
- output tokens per model turn: assumed 500 (the tool call, its arguments and any text around it), as in the cost estimate above; not measured
- a real model may call more or fewer tools than the scripted agents; the scripted counts above are a starting point, not a measurement of any model

## Failures

Every guarded run that duplicated or lost an effect, and every run whose agent failed. Unguarded duplicates are the problem the guard exists to stop and are reported in the tables above, not here.

- duplicate: browser path, scripted-browser:naive, guard on, connection_reset_after_commit, checkout, 2 effects (known limitation: Chromium re-sends the POST below the MCP layer when the connection resets after the commit, so the server sees two submissions from one click)
- duplicate: browser path, scripted-browser:naive, guard on, connection_reset_after_commit, checkout, 2 effects (known limitation: Chromium re-sends the POST below the MCP layer when the connection resets after the commit, so the server sees two submissions from one click)
- duplicate: browser path, scripted-browser:naive, guard on, connection_reset_after_commit, checkout, 2 effects (known limitation: Chromium re-sends the POST below the MCP layer when the connection resets after the commit, so the server sees two submissions from one click)
- duplicate: browser path, scripted-browser:naive, guard on, connection_reset_after_commit, booking, 2 effects (known limitation: Chromium re-sends the POST below the MCP layer when the connection resets after the commit, so the server sees two submissions from one click)
- duplicate: browser path, scripted-browser:naive, guard on, connection_reset_after_commit, booking, 2 effects (known limitation: Chromium re-sends the POST below the MCP layer when the connection resets after the commit, so the server sees two submissions from one click)
- duplicate: browser path, scripted-browser:naive, guard on, connection_reset_after_commit, booking, 2 effects (known limitation: Chromium re-sends the POST below the MCP layer when the connection resets after the commit, so the server sees two submissions from one click)
- duplicate: browser path, scripted-browser:naive, guard on, connection_reset_after_commit, email, 2 effects (known limitation: Chromium re-sends the POST below the MCP layer when the connection resets after the commit, so the server sees two submissions from one click)
- duplicate: browser path, scripted-browser:naive, guard on, connection_reset_after_commit, email, 2 effects (known limitation: Chromium re-sends the POST below the MCP layer when the connection resets after the commit, so the server sees two submissions from one click)
- duplicate: browser path, scripted-browser:naive, guard on, connection_reset_after_commit, email, 2 effects (known limitation: Chromium re-sends the POST below the MCP layer when the connection resets after the commit, so the server sees two submissions from one click)
- duplicate: browser path, scripted-browser:naive, guard on, connection_reset_after_commit, ticket, 2 effects (known limitation: Chromium re-sends the POST below the MCP layer when the connection resets after the commit, so the server sees two submissions from one click)
- duplicate: browser path, scripted-browser:naive, guard on, connection_reset_after_commit, ticket, 2 effects (known limitation: Chromium re-sends the POST below the MCP layer when the connection resets after the commit, so the server sees two submissions from one click)
- duplicate: browser path, scripted-browser:naive, guard on, connection_reset_after_commit, ticket, 2 effects (known limitation: Chromium re-sends the POST below the MCP layer when the connection resets after the commit, so the server sees two submissions from one click)
