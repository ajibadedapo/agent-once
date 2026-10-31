# FAQ

**Does agent-once block my agent from doing the same thing twice on purpose?**
No. A call that succeeded and is repeated later by the same run is treated as a deliberate repeat and runs. agent-once holds a repeat only when the earlier attempt is still in doubt (sent with no answer, or an error or timeout within the 120 s retry window), and replays completed actions when a crashed run is started again. To make "same arguments" mean "same action" for good, send an explicit intent key ([how-it-works.md](how-it-works.md#identity)).

**Does it slow tools down?**
The measured overhead per guarded call is in [RESULTS.md](../RESULTS.md#guard-overhead), well under the 5 ms target at the median. Tools that pass are relayed without touching the ledger. Browser side effects may add one snapshot call when the tool result carries no page text.

**Which MCP clients work?**
Any client that starts stdio MCP servers: Claude Code, Claude Desktop, Cursor, the Claude Agent SDK and others. Elicitation questions appear only in clients that declare the elicitation capability; others get a structured error result with the resolve command. Remote (HTTP or SSE) servers are not wrapped in this release.

**Does it work with servers other than Playwright?**
Yes. Any stdio MCP server can be wrapped. Tools are guarded from their annotations and names, and you can set policies, identity rules and read-backs per tool in the config ([configuration.md](configuration.md)). The page-aware browser rules exist for `@playwright/mcp` and `chrome-devtools-mcp`.

**What does the agent see when a call is held?**
An error result that says the earlier call may already have taken effect, that it must not retry, and what to do: check and call `agent_once_resolve` (standard actions), or ask the user to run `npx agent-once resolve` (money and irreversible actions). The guard enforces the hold itself; it does not rely on the agent obeying.

**Can the agent lie to unblock itself?**
For money and irreversible actions, no: only a person, the approval webhook or a configured reconciler can resolve them. For standard actions the agent can record an answer; set `exposeResolveTool` to `false` if you do not want that.

**What if the ledger is locked, corrupt or on a read-only disk?**
Guarded calls fail closed with "agent-once ledger unavailable" and are not dispatched. Read-only tools keep working. A ledger written by a newer version is refused, not modified.

**Can several agents share a ledger?**
Yes. SQLite in WAL mode with a busy timeout lets several proxy processes and libraries use one file, and the ledger's unique index ensures that only one of two identical concurrent calls is dispatched. Sharing a ledger also shares history: use distinct session keys for independent agents.

**Does it work with Python agents?**
Yes, with the `once-guard` package (import `agent_once`), which writes the same ledger format ([python.md](python.md)). The MCP proxy itself is the npm package.

**Why does the Python package have a different name?**
`agent-once` on PyPI is an unrelated project, so the Python distribution is `once-guard`.

**Does agent-once replace idempotency keys on my API?**
No, it complements them. When the API supports `Idempotency-Key`, `guardedFetch` sends the guard's key, and late retries reuse the earlier key so the API can deduplicate them. When the API does not, agent-once still stops the agent from retrying blindly.

**Is anything sent to a server?**
No telemetry. agent-once talks only to the server it wraps, a webhook you configure, and the local chaos targets.

**Why did my browser click count as failed when it worked?**
After a guarded browser action, the page must match a success marker for the action to be recorded as confirmed; otherwise it is recorded as failed, which is the cautious choice. Add `browser.successMarkers` for your sites ([browser.md](browser.md#did-the-click-work)).

**What can it not prevent?**
Retries below the MCP layer, such as Chromium re-sending a form POST after a connection reset (measured in [RESULTS.md](../RESULTS.md#known-limitations)), and duplicates created by the remote service itself. See the limits in [browser.md](browser.md#limits) and [mcp-proxy.md](mcp-proxy.md#limits).
