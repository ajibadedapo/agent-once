# Chaos suite

The chaos suite makes the failures behind duplicate side effects happen on purpose, then counts the real effects from the target's own records. It proves the guard works and lets you test your own agent with and without it.

```bash
npx agent-once chaos run --guard both
```

This runs the two built-in scripted agents through every scenario against every target, once with the guard and once without, and prints a Markdown report. The whole matrix takes about a second because scripted agents use simulated time.

## Targets

Four small reference services, each with an HTML form, a JSON API, an MCP front end and a ground-truth record:

| Target | Form | MCP tool | Read tool | Form button |
|---|---|---|---|---|
| checkout | `/checkout` | `place_order` | `list_orders` | Place order |
| booking | `/booking` | `book_slot` | `list_bookings` | Book slot |
| email | `/email` | `send_email` | `list_sent_emails` | Send message |
| ticket | `/ticket` | `create_ticket` | `list_tickets` | Create ticket |

Each form shows a reference (`Reference F-...`) and each target has a history page (`/checkout/history` and so on). The API is `POST /api/<target>` with a JSON body.

```bash
npx agent-once chaos serve --port 4100
```

prints `agent-once chaos targets listening on http://127.0.0.1:4100` and serves them until interrupted. Control endpoints:

| Request | Effect |
|---|---|
| `POST /__faults` with a JSON plan | Sets the faults, for example `[{"target":"checkout","nth":1,"kind":"slow_commit","holdMs":5000}]` (the first checkout submission commits after 5 s and gets no answer) |
| `GET /__truth` | The effects each target recorded |
| `POST /__reset` | Clears effects and faults |

`--honour-idempotency-key` makes the API deduplicate requests that carry the same `Idempotency-Key` header, to model a service that supports keys. `npx agent-once chaos targets-mcp --url <url>` starts the MCP front end for a running server on stdio.

## Faults and scenarios

| Fault | What the target does |
|---|---|
| `lost_response_after_commit` | Commits, then drops the connection without answering |
| `slow_commit` | Drops the connection without answering and commits `holdMs` later |
| `timeout_before_commit` | Drops the connection without answering and never commits |
| `stale_element` | Rejects the submission as stale (HTTP 409, nothing committed) |
| `connection_reset_after_commit` | Commits, then resets the connection (browser path only, see below) |

On the form path, the three faults that drop the connection answer `504 Gateway Timeout` instead, as a gateway in front of the site would.

| Scenario | Fault | Notes |
|---|---|---|
| `lost_response_after_commit` | as named | |
| `slow_commit` | `slow_commit`, 5 s | |
| `timeout_before_commit` | as named, 5 s | |
| `stale_element` | as named | |
| `crash_mid_run` | `slow_commit`, 5 s | The agent is killed while the call is in flight and started again with the same session |
| `no_fault` | none | Checks that the guard changes nothing when nothing goes wrong |

A run is a duplicate when the target recorded more effects than the task asked for, and missing when it recorded fewer.

## `chaos run`

```
agent-once chaos run [--agent scripted:naive|scripted:obedient|"<command>"] [--scenarios a,b] [--targets a,b]
                     [--guard on|off|both] [--runs <n>] [--json <file>] [--markdown <file>] [--fail-on-duplicates]
```

| Flag | Default | Meaning |
|---|---|---|
| `--agent` | both scripted agents | Repeat for several agents |
| `--scenarios` | all except `no_fault` | Comma-separated |
| `--targets` | all four | Comma-separated |
| `--guard` | `both` | `on`, `off` or `both` |
| `--runs` | `1` | Runs per scenario, target and guard mode |
| `--json`, `--markdown` | none | Also write the report to a file |
| `--fail-on-duplicates` | off | Exit 1 when any guarded run duplicated an effect |

The scripted agents are deterministic. `scripted:naive` retries every error after a growing delay; `scripted:obedient` checks the list tool and calls `agent_once_resolve` when the guard reports doubt.

## Your own agent

Pass a command with `--agent "<command>"`. For each run, agent-once starts the targets and runs your command with:

| Variable | Value |
|---|---|
| `AGENT_ONCE_CHAOS_MCP` | A JSON array: the command and arguments of the stdio MCP server to connect to. With the guard on, it is already wrapped by the proxy. |
| `AGENT_ONCE_TASK` | The instruction, for example `Place the order exactly once with the place_order tool, arguments {"item":"Blue mug","qty":1}. Check with list_orders if unsure.` |
| `AGENT_ONCE_SESSION` | The session for this run |
| `AGENT_ONCE_CHAOS_URL` | The targets' base URL |
| `AGENT_ONCE_HOME` | A fresh directory for this run's ledger |

Your agent connects to the server in `AGENT_ONCE_CHAOS_MCP`, does the task, and exits 0. A non-zero exit is reported as an agent failure. Each run is stopped after 5 minutes. External agents run on the real clock in their own process group; `crash_mid_run` kills the group once the call reaches the target and starts the command again.

```bash
npx agent-once chaos run --agent "node ./my-agent.js" --scenarios lost_response_after_commit,crash_mid_run --targets checkout --runs 3
```

## The benchmark

`RESULTS.md` is produced by the bench workspace in this repository, not by hand:

```bash
npm ci && npm run build && npx playwright install chromium && npm run bench && npm run bench:browser
```

`npm run bench` measures the guard overhead and runs the scripted API matrix; `npm run bench:browser` drives the real `@playwright/mcp` server with headless Chromium. Real-model runs (`npm run bench:real -- --confirm-spend --max-spend-usd <dollars>`) need API keys and an explicit spend cap; RESULTS.md lists them under Not run with a cost estimate until they are run.

## Known limitation

On the browser path, `connection_reset_after_commit` duplicates every time, with or without the guard: Chromium re-sends the form POST by itself when the connection resets after the server committed, so one click becomes two submissions below the MCP layer. agent-once cannot see that second request. RESULTS.md reports it as measured (12 duplicates in 12 runs in both modes) and counts it separately in the totals.
