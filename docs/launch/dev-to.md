# dev.to draft

Status: draft. Not posted. Every external figure is marked "Re-verify before posting:" and must be checked against its source; all other numbers come from RESULTS.md.

Title: agent-once: stop your AI agent from charging, booking or sending twice

Tags: ai, mcp, testing, opensource

---

A tool call times out. Did the order go through? Your agent does not know, and neither does the tool layer. So the agent does what a naive HTTP client does: it tries again. Sometimes that is fine. Sometimes it is a second charge, a second booking, or a second email to a customer.

I wanted two things: a guard that stops that by default, and a way to prove it on my own agent instead of trusting a README. That became [agent-once](https://github.com/ajibadedapo/agent-once).

## The idea

Every side-effecting call gets a stable identity: the session, the tool name and the canonical arguments (for a browser click, the page and the button label instead of a snapshot ref that changes on every load). Before the call runs, agent-once writes `intended` to a local SQLite ledger, then `sent`, then `confirmed` or `failed`.

When the same call comes back:

- if it already succeeded and this is a rerun of a crashed run, the recorded result is returned;
- if its outcome is unknown (sent with no answer, or an error inside a 120 second retry window), it is not repeated. If you told agent-once how to check (a "read-back": a list tool, a history page), it checks. Otherwise the agent is told not to retry, and for money or irreversible actions a person is asked;
- if it succeeded and the same run calls it again later, that is a deliberate repeat and it runs.

The guarantee is at most once by default, exactly once wherever a reconciler can confirm the outcome. I chose that wording because it is the strongest one I can defend.

## Zero-code setup for MCP

```bash
claude mcp add playwright -- npx agent-once mcp -- npx @playwright/mcp@latest
```

The proxy reads tool annotations, passes read-only tools through, and for browser servers uses page-aware rules: a click is guarded when its label or the page matches words like pay, buy, checkout, book, confirm, submit, send, delete, publish or order.

## Proving it

The repository ships four tiny reference sites with ground-truth records and fault injection. The benchmark drives them with scripted agents, with and without the guard:

| Path | Duplicates without the guard | Duplicates with the guard |
|---|---|---|
| API (two scripted agents, 48 runs each way) | 24 | 0 |
| Browser (real @playwright/mcp and Chromium, 72 runs each way) | 36 | 12, all the known limitation below |

Overhead per guarded call on SQLite WAL: p50 0.102 ms (core), 0.104 ms (proxy), 0.160 ms (Python).

You can run the same suite on your agent:

```bash
npx agent-once chaos run --agent "node ./my-agent.js" --guard both --fail-on-duplicates
```

## The limitation I could not fix

When a site commits a form POST and then resets the connection, Chromium re-sends the POST on its own. The server sees two submissions from one click, and nothing above the browser's network stack ever sees the second one. I measured 12 duplicates in 12 runs with the guard and without it. If you run the site, deduplicate resubmitted forms on the server.

## What is not measured yet

Real models. The harness, spend cap and cost estimate are in place, but the published numbers are scripted agents only, and RESULTS.md says so.

## Why now

- Re-verify before posting: UndoBench reports that naive retry produced duplicate external effects in 53.33% of trials (512 of 960) in its lost-acknowledgment study; the paper reports other naive-retry rates for other settings, so quote this one with its setting. Source: "UndoBench: Separating Task Competence from Recovery Capability in Tool-Using AI Agents", Dolly Sah, Tanmay Sah, Harshul Jain and Tanya Sah, arXiv 2610.05622, https://arxiv.org/abs/2610.05622
- Re-verify before posting: CUA-Recovery found that agents recognised inherited errors (its Error Awareness Rate) at most 44.0% of the time across six agents. Source: "CUA-Recovery: Benchmarking Error Recovery in Long-Horizon Computer-Use Agents", Xu Hu et al., arXiv 2610.27645, https://arxiv.org/abs/2610.27645
- Re-verify before posting: the post "Your AI Agent Will Double-Charge on a Lost Response" describes the same failure. Source: DEV Community, author 0012303, https://dev.to/0012303/your-ai-agent-will-double-charge-on-a-lost-response-5eed

agent-once is Apache 2.0, has no telemetry, and has a TypeScript package (`agent-once`) and a Python one (`once-guard`). Issues and odd MCP servers welcome.
