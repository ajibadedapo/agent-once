# Show HN draft

Status: draft. Not posted. Every external figure below is marked "Re-verify before posting:" and must be checked against its source on the day; all other numbers come from RESULTS.md in the repository.

## Title

Show HN: agent-once, stop your AI agent from charging, booking or sending twice

## URL

https://github.com/ajibadedapo/agent-once

## Text

Hi HN, I'm Hammed. I built agent-once after watching browser agents do the obvious thing when a checkout page times out: click "Place order" again.

The problem is old (lost responses, retries, idempotency), but agents make it worse. When a tool call errors or times out, the agent has no idea whether the side effect happened, and its usual move is to try again.

agent-once is a small layer between the agent and the tools that change things:

- An MCP proxy: `claude mcp add playwright -- npx agent-once mcp -- npx @playwright/mcp@latest`. No code changes, works with any stdio MCP server and client.
- Every guarded call gets an identity (session, tool, canonical arguments; for browsers the page and the button label) and is written to a local SQLite ledger before it runs.
- On a repeat it returns the recorded result, runs a read-back you configured to check what happened, or stops: the agent gets "do not retry, check and resolve", and money or irreversible actions wait for a person (MCP elicitation, a signed webhook, or `npx agent-once resolve`).
- The guarantee I can actually defend: at most once by default, exactly once wherever a reconciler can confirm the outcome.

It also ships the thing I wanted first: a chaos suite. Four small reference sites (checkout, booking, email, ticket) with ground-truth records and fault injection (lost response after commit, slow commit, timeout before commit, stale element, crash mid-run). `npx agent-once chaos run --agent "<your agent>"` runs your agent through them with and without the guard and counts real duplicates. There's a GitHub Action, vitest matchers and pytest fixtures.

What I measured (scripted agents, not models; RESULTS.md has every cell):

- API path: 24 duplicates in 48 runs without the guard, 0 in 48 with it.
- Browser path (real @playwright/mcp and headless Chromium): 36 duplicates in 72 runs without the guard, 12 with it, and all 12 are one known limitation.
- Overhead per guarded call on SQLite WAL: p50 0.102 ms in the core, 0.104 ms through the proxy, 0.160 ms in Python.

The limitation, because it matters: if a site commits a form POST and then resets the connection, Chromium re-sends the POST by itself, below the MCP layer. One click, two orders, and the proxy never sees the second request. I measured it at 12 out of 12 with and without the guard. The fix there is on the server.

I have not run real models through the benchmark yet; that costs money and I wanted the harness, the spend cap and the scripted baselines solid first. RESULTS.md says so and has the cost estimate.

There's a TypeScript library and a Python one (`pip install once-guard`; `agent-once` on PyPI is someone else's project, a decorator in the same space). Both share one ledger format with test vectors. Apache 2.0, no telemetry.

I'd love to hear where the identity rules are wrong for your tools, and about any MCP server where the annotations lie.

## Background figures for replies

- Re-verify before posting: UndoBench reports that naive retry produced duplicate external effects in 53.33% of trials (512 of 960) in its lost-acknowledgment study; the paper reports other naive-retry rates for other settings, so quote this one with its setting. Source: "UndoBench: Separating Task Competence from Recovery Capability in Tool-Using AI Agents", Dolly Sah, Tanmay Sah, Harshul Jain and Tanya Sah, arXiv 2610.05622, https://arxiv.org/abs/2610.05622
- Re-verify before posting: CUA-Recovery found that agents recognised inherited errors (its Error Awareness Rate) at most 44.0% of the time across six agents. Source: "CUA-Recovery: Benchmarking Error Recovery in Long-Horizon Computer-Use Agents", Xu Hu et al., arXiv 2610.27645, https://arxiv.org/abs/2610.27645
- Re-verify before posting: @playwright/mcp has about 25.6M npm downloads per month. Source: npm downloads API, https://api.npmjs.org/downloads/point/last-month/@playwright/mcp
