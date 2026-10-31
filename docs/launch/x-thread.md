# X thread draft

Status: draft. Not posted. External figures are marked "Re-verify before posting:"; all other numbers come from RESULTS.md. Keep each post under 280 characters.

1/
Your agent clicks "Place order". The page times out. Did it go through?

The agent doesn't know. So it clicks again.

I built agent-once to stop that: an MCP proxy that makes side effects happen at most once.
https://github.com/ajibadedapo/agent-once

2/
One line in Claude Code:

claude mcp add playwright -- npx agent-once mcp -- npx @playwright/mcp@latest

Every side-effecting call is recorded in a local ledger before it runs. A repeat with an unknown outcome is held, checked, or sent to you. Never retried blindly.

3/
The promise, worded carefully: at most once by default, exactly once wherever a reconciler can confirm the outcome.

Money and irreversible actions wait for a person. Normal repeats still run. Crashed runs replay what they already did.

4/
Measured with scripted agents against 4 reference sites:

API: 24 duplicates in 48 runs without the guard, 0 with it.
Browser (real Playwright MCP + Chromium): 36 in 72 without, 12 with.
Overhead: p50 0.10 to 0.16 ms per guarded call.

5/
Those 12 are a limitation I can't fix from the MCP layer: when a site commits a form POST and resets the connection, Chromium re-sends the POST on its own. One click, two orders. 12 out of 12, with or without the guard.

It's in RESULTS.md, not hidden.

6/
It also ships the chaos suite: lost responses, slow commits, timeouts, stale elements, crashes. Point it at your own agent:

npx agent-once chaos run --agent "node my-agent.js"

GitHub Action, vitest and pytest included. TS + Python. Apache 2.0. No telemetry.

Background for replies:

- Re-verify before posting: UndoBench reports that naive retry produced duplicate external effects in 53.33% of trials (512 of 960) in its lost-acknowledgment study; the paper reports other naive-retry rates for other settings, so quote this one with its setting. Source: "UndoBench: Separating Task Competence from Recovery Capability in Tool-Using AI Agents", Dolly Sah, Tanmay Sah, Harshul Jain and Tanya Sah, arXiv 2610.05622, https://arxiv.org/abs/2610.05622
- Re-verify before posting: CUA-Recovery found that agents recognised inherited errors (its Error Awareness Rate) at most 44.0% of the time across six agents. Source: "CUA-Recovery: Benchmarking Error Recovery in Long-Horizon Computer-Use Agents", Xu Hu et al., arXiv 2610.27645, https://arxiv.org/abs/2610.27645
