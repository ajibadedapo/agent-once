# agent-once: exactly-once side effects for AI agents

Date: 2026-10-31. Owner: Hammed Ajibade. Status: draft for approval. Part of Agent Mandates (github.com/ajibadedapo/agent-mandates), shipped as its own package.

## Why

AI agents now take real actions: pay, order, book, email, submit, deploy. When an action's response is lost (timeout, dropped connection, crashed run), the agent cannot tell whether it happened. Retrying can do it twice; giving up can leave it undone.

Evidence (all checked 30 to 31 Oct 2026):
- UndoBench: naive retry caused duplicate mutations in 53.33% of fault-injected runs.
- CUA-Recovery (arXiv 2610.27645): agents recognised inherited errors at most 44.0% of the time.
- Idempotency comes up in 131 LangGraph issues, 97 Claude Code issues and 82 browser-use issues (GitHub full-text search, noisy).
- Developers write about it ("Your AI Agent Will Double-Charge on a Lost Response", dev.to 2026), but there are only 20 HN stories on "agent idempotency" and 0 Stack Overflow questions. The demand is real but latent, so the product must prevent the problem by default, not only detect it.
- Host audiences: @playwright/mcp 25.6M npm downloads per month, browser-use 8.06M PyPI downloads per month, @modelcontextprotocol/sdk 258M npm per month.

Hammed's bar: "the final product, good enough for even Anthropic to want to use."

## What it is

Two things in one package, guard first:

1. **Guard (prevention, the main product).** A thin layer between an agent and the tools that change the world. Every side-effecting action gets a stable identity and an entry in an action ledger. Before an action runs, the guard checks the ledger: done means return the recorded result; in doubt (sent, no response) means reconcile first; new means run it and record the outcome. Result: each intended action happens at most once, and lost responses are resolved instead of blindly retried.
2. **Chaos (proof and CI).** A fault injector and checker that makes the failures happen on purpose (lost response after commit, slow commit, timeout before commit, stale element, crash mid-run) and then checks the real target state for duplicate or missing effects. It proves the guard works and lets anyone test their own agent in CI.

## Where it plugs in (decided: all three, in this order)

1. **MCP proxy** (`npx agent-once mcp -- <server command>`): wraps any MCP server, starting with @playwright/mcp and chrome-devtools-mcp. Uses MCP tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`) to decide what to guard, with a config file to override. Works with Claude Code, Claude Desktop, the Claude Agent SDK, Cursor, and any MCP client, with zero code changes.
2. **SDK middleware** for agents that call tools in code: TypeScript (`@agent-once/core`) and Python (`agent-once`), with adapters for the Claude Agent SDK, the Anthropic Messages tool loop, the OpenAI Agents SDK, LangGraph and browser-use.
3. **HTTP layer:** sets and honours `Idempotency-Key` on outbound requests the agent makes through the guard, so services that support keys (Stripe, many payment and booking APIs) get end-to-end protection.

## Core concepts (decided)

- **Action identity:** run or mandate id + tool name + a canonical hash of the arguments that matter (configurable per tool; defaults drop volatile fields such as timestamps and element refs). Agent Mandates ids are used when present.
- **Ledger:** append-only, states `intended`, `sent`, `confirmed`, `failed`, `reconciled`. Default store is SQLite (zero setup); Postgres and Redis adapters for teams. Entries expire after a configurable window (default 24 hours).
- **Reconciliation:** when an action is `sent` with no confirmed outcome, the guard calls a reconciler before any retry. Built in: an idempotency-key replay for HTTP, a "read back" check for MCP tools that declare a matching read tool, and a pause that asks the agent or a human to confirm. Never a silent retry.
- **Policy:** per tool, `guard` (default for destructive or non-idempotent), `pass` (read-only), or `block-on-doubt` (never retry without confirmation, for payments).
- **Evidence:** every decision is logged as a structured event (OpenTelemetry spans plus a JSONL file) so teams can audit exactly what happened.

## Chaos and the benchmark (decided)

- A reference target suite: a fake checkout, a booking form, an email sender and a ticket creator, each with a ground-truth state API.
- Fault scenarios as code. One command runs a chosen agent (Claude via the Agent SDK with Playwright MCP, OpenAI CUA, browser-use, or any MCP client) through each scenario with and without the guard and reports duplicate-effect and missing-effect rates.
- A GitHub Action and a pytest and vitest plugin so the same checks run in CI.
- Published results (`RESULTS.md`): numbers per agent and model, with and without the guard, reproducible with one command. Honest numbers only; failures are published too.

## Quality bar ("Anthropic would use it")

- Zero config for the MCP proxy path; first useful result within 60 seconds of `npx`.
- No change to the tools' behaviour when nothing goes wrong: latency overhead under 5 ms per guarded call (measured and published).
- Never introduces a duplicate or a lost action itself: property-based tests and the chaos suite run against the guard in CI on every change.
- Typed APIs, full docs site, examples for each integration, semantic versioning, signed releases, security policy, no telemetry by default.
- Licence: Apache 2.0 (patent grant, which larger companies prefer).

## Naming and discoverability (decided from the research)

- Package and repo: `agent-once` (npm and PyPI availability to be confirmed at build time; fallbacks `once-guard`, `mcp-once`). First README line in users' words: "Stop your AI agent from charging, booking or sending twice."
- Keywords and GitHub topics: idempotency, exactly-once, double charge, fault injection, chaos engineering, browser agent, computer use, mcp, agent-testing.
- Distribution: skills.sh listing, official MCP registry, PRs offering examples to @playwright/mcp and browser-use, Show HN with the double-charge demo, a dev.to and Reddit write-up, a talk (Agent Mandates follow-up).
- llms.txt shipped (cheap, unproven).

## Non-goals

- Not an agent, not an eval dashboard (promptfoo and Langfuse own that), not a general workflow engine (Temporal owns durable execution; we integrate, not compete).
- No hosted service in version 1.

## Anti-goals

- A guard that ever causes a duplicate or loses an action.
- Noticeable slowdown or setup friction.
- Inflated benchmark numbers.

## Delivery

Own public repo under github.com/ajibadedapo (personal open source, no company branding), kept private until Hammed approves the launch. Version 1 is complete when: the MCP proxy, TS and Python cores, Claude Agent SDK and Playwright MCP integrations, the chaos suite with four targets, the GitHub Action, docs and RESULTS.md all exist and pass CI. Other adapters follow in 1.x.

## Left to the builder

Internal module layout, canonical hashing details, SQLite schema, docs tooling, exact fault timing.

## Decisions after the builder check (Claude's calls, 31 Oct 2026; Hammed to confirm on approval)

1. **Session identity on the proxy path.** Identity = session key + tool + canonical args + occurrence. The session key comes from, in order: an Agent Mandates id in MCP `_meta`, the `AGENT_ONCE_SESSION` env var, else a stable default of client name + working directory. The ledger is on disk, so it survives proxy and run restarts within the expiry window. That makes the crash-then-rerun case dedupe.
2. **Repeat versus a genuinely new identical action.** The guard does not block every identical call. It blocks a repeat only when the earlier attempt is still in doubt (sent, no confirmed outcome) or the new call arrives as a retry inside a short window (default 120 s) after an error or timeout result. A confirmed action repeated later is allowed and logged as a deliberate repeat. Agents and SDK users can pass an explicit intent key to make intent exact. This removes the risk of blocking a real second order.
3. **Guarantee wording and doubt policy.** The promise is "at most once by default, exactly once wherever a reconciler can confirm the outcome". When in doubt with no reconciler: tools in the `money` and `irreversible` classes block and ask; everything else returns a clear "outcome unknown" result telling the agent not to retry until confirmed. Never a silent retry, never a silent drop; every case is logged.
4. **How the pause is delivered.** MCP elicitation where the client supports it; otherwise a structured tool error with exact instructions; plus an optional approval webhook for human sign-off. Because agents notice inherited errors poorly, the guard enforces the block itself rather than relying on the agent to obey.
5. **Browser side effects.** Version 1 ships page-aware rules for browser MCP servers: a click or form submit is treated as a side effect when the URL, button text or form matches configurable patterns (defaults cover pay, buy, checkout, book, confirm, submit, send, delete, publish). Other clicks pass through.
6. **Read-back mappings.** Shipped for the four reference targets and for common Playwright read actions (read the page and check a marker), plus documented config for users. There is no MCP-level declaration; it is config.
7. **One ledger format.** A versioned ledger schema spec is written first and shared by the TypeScript and Python cores.

### Corrections to earlier claims
- MCP annotations are untrusted hints; unannotated tools default to guarded (MCP defaults are destructive and non-idempotent). The builder records which @playwright/mcp and chrome-devtools-mcp tools actually set them.
- The proxy's main value is stopping agent-level retries: an agent that gets an error or timeout result and calls the tool again. That is the dominant duplicate path for browser agents. The proxy cannot see a lost response between the browser and the remote site, so reconciliation there relies on page-aware read-back.
- `tools/call` has no idempotency field; keys are only added on the HTTP path, which covers direct API calls, not browser form posts.
- Latency target: under 5 ms per guarded call on SQLite with WAL and synchronous=NORMAL, measured and published; Postgres is reported separately.
- All public numbers (UndoBench 53.33%, arXiv 2610.27645, npm figures) are re-verified at launch time before going into the README.
