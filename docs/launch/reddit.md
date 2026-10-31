# Reddit draft

Status: draft. Not posted. Candidate subreddits: r/ClaudeAI, r/mcp, r/LocalLLaMA (check each subreddit's self-promotion rules first). External figures are marked "Re-verify before posting:"; all other numbers come from RESULTS.md.

Title: I built an MCP proxy that stops agents from repeating a checkout after a timeout, and a chaos suite to prove it

---

I kept seeing the same failure with browser agents: the "Place order" click times out, the agent cannot tell whether it went through, and it clicks again.

So I built agent-once. You put it in front of any stdio MCP server:

```bash
claude mcp add playwright -- npx agent-once mcp -- npx @playwright/mcp@latest
```

It records every side-effecting call in a local SQLite ledger before it runs. If the same call comes back while its outcome is unknown, it does not run it again: it checks with a read-back if you configured one, tells the agent not to retry, or (for money and irreversible actions) asks you. Completed actions replay when a crashed run restarts. Normal repeats still run.

Numbers from the repo's benchmark (scripted agents, not LLMs yet):

- API path: 24 duplicates in 48 runs without the guard, 0 with it
- Browser path with real @playwright/mcp: 36 in 72 without, 12 with, and all 12 are one known limitation (Chromium re-sends a form POST by itself after a connection reset; nothing at the MCP layer can see it)
- p50 overhead per guarded call: 0.102 ms in the core, 0.104 ms through the proxy, 0.160 ms in Python

There's a chaos suite you can point at your own agent (`npx agent-once chaos run --agent "..."`), a GitHub Action, and TS and Python libraries. Apache 2.0, no telemetry.

Repo: https://github.com/ajibadedapo/agent-once

Happy to hear where it guards too much or too little on your MCP servers.

Background if anyone asks:

- Re-verify before posting: UndoBench reports that naive retry produced duplicate external effects in 53.33% of trials (512 of 960) in its lost-acknowledgment study; the paper reports other naive-retry rates for other settings, so quote this one with its setting. Source: "UndoBench: Separating Task Competence from Recovery Capability in Tool-Using AI Agents", Dolly Sah, Tanmay Sah, Harshul Jain and Tanya Sah, arXiv 2610.05622, https://arxiv.org/abs/2610.05622
- Re-verify before posting: CUA-Recovery found that agents recognised inherited errors (its Error Awareness Rate) at most 44.0% of the time across six agents. Source: "CUA-Recovery: Benchmarking Error Recovery in Long-Horizon Computer-Use Agents", Xu Hu et al., arXiv 2610.27645, https://arxiv.org/abs/2610.27645
