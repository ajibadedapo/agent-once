# MCP proxy

```
agent-once mcp [--config <file>] [--session <key>] -- <command> [args...]
```

The proxy starts the MCP server given after `--` as a child process over stdio, speaks MCP to your client on its own stdin and stdout, and relays everything. Only `tools/call` requests for guarded tools go through the guard. Server stderr is passed through, and agent-once's own messages go to stderr with the prefix `agent-once:`.

```bash
claude mcp add playwright -- npx agent-once mcp -- npx @playwright/mcp@latest
claude mcp add shop -- npx agent-once@0.1.0 mcp --config ./agent-once.config.json --session checkout-bot -- node ./shop-server.js
```

Pin the agent-once version (`agent-once@0.1.0`) in anything you depend on; `npx agent-once` resolves the latest release each time npx refreshes its cache.

## Options

| Option | Meaning |
|---|---|
| `--config <file>` | A JSON config file ([configuration.md](configuration.md)). Without it, defaults apply. There is no automatic config discovery. |
| `--session <key>` | Sets `AGENT_ONCE_SESSION` for the guard and the child process, making the session explicit. |

Before the server starts, the config is validated. A bad file (invalid JSON, an unknown key, an unknown policy, an invalid regular expression) exits with code 2 and names the file and the JSON pointer of the problem; the server is never started unguarded.

| Exit code | Meaning |
|---|---|
| the server's code | The wrapped server exited (code 1 if it exited without one). |
| 1 | The server could not be started. |
| 2 | Usage or config error. |
| 3 | The ledger could not be opened. |

## Which tools are guarded

Before the first guarded decision, and again after the server reports a tool list change, the proxy reads the server's tool annotations from `tools/list` (it waits up to 30 s; if the list is not available, tools without known annotations are guarded). A tool passes when it is `readOnlyHint: true`, or `destructiveHint: false` with `idempotentHint: true`. Everything else is guarded, with class and policy from its name and title (see [how-it-works.md](how-it-works.md#policy-and-class)). A rule in the config file wins over annotations. Browser servers (`@playwright/mcp`, `chrome-devtools-mcp`) get page-aware rules ([browser.md](browser.md)).

## Sessions and intent keys

The session key decides which calls count as the same intent. In order:

1. `_meta["io.github.ajibadedapo.agent-mandates/mandate-id"]` on the `tools/call` request
2. `_meta["io.github.ajibadedapo/agent-once-session"]`
3. the `AGENT_ONCE_SESSION` environment variable, or `--session`
4. the default, `clientInfo.name + ":" + cwd`

With an explicit session (1 to 3), a rerun of a crashed agent replays completed actions for 24 hours. With the default session it replays them only within the 120 s retry window, because two separate tasks in the same directory are otherwise likely to be genuinely different.

A client that knows the intent exactly can send `_meta["io.github.ajibadedapo/agent-once-intent"]`: the arguments are then ignored for identity and a repeat with the same intent key always replays.

## What the agent sees

Executed and replayed results carry `_meta["io.github.ajibadedapo/agent-once"] = { "status": ..., "action_id": ... }` (and `class` on in-doubt and blocked results). Statuses: `executed`, `replayed`, `in_doubt`, `blocked`, `retry_by_agent`.

- **Replayed:** the recorded result, preceded by "agent-once: this action already happened (action ao_...); returning the recorded result instead of repeating it."
- **In doubt (`guard` policy):** an error result: "agent-once stopped this call: an earlier identical ... call (action ao_...) may already have taken effect and its outcome is unknown. Do not retry it." followed by how to resolve it.
- **Blocked (`block-on-doubt`):** an error result saying a person must confirm, with the exact `npx agent-once resolve ao_... --happened` command for the user.
- **Ledger unavailable:** an error result; the call is not dispatched.

The upstream request carries the idempotency key in `_meta["io.github.ajibadedapo/agent-once-action"]`, for servers that want to deduplicate on it.

If the server exits while a guarded call is in flight, the action stays `sent` (in doubt, never confirmed), the pending request gets an error result saying it may or may not have taken effect, and the proxy exits with the server's code.

## The resolve tool

Unless `exposeResolveTool` is false, the proxy adds a tool named `agent_once_resolve` to the server's tool list (if the server does not already have one):

```json
{ "action_id": "ao_0123456789abcdef01234567", "outcome": "happened" }
```

The agent uses it after checking whether an in-doubt action happened. It may resolve only `standard` actions, and `not_happened` is refused within the settle window (10 s) because the effect may still be arriving. Money and irreversible actions answer with the blocked result instead.

## Asking a person

For `block-on-doubt` actions the proxy asks a person, in order:

1. **MCP elicitation**, when the client declared the `elicitation` capability in `initialize`. The question is "Did it happen?" with the answers happened and not happened. It waits up to 300 s, or the webhook timeout when a webhook is configured. Clients without the capability skip this step.
2. **The approval webhook**, when `approvalWebhook` is configured.

Without an answer the call is blocked, and the user can resolve it later from a terminal:

```bash
npx agent-once ledger list
npx agent-once resolve ao_0123456789abcdef01234567 --not-happened
```

Pass the same `--config` to `resolve` and `ledger` as to the proxy when the config changes the ledger path.

### Approval webhook

```json
{
  "approvalWebhook": {
    "url": "https://approvals.example.com/agent-once",
    "timeoutSeconds": 120,
    "secretEnv": "AGENT_ONCE_WEBHOOK_SECRET"
  }
}
```

agent-once sends one `POST` with `Content-Type: application/json`:

```json
{
  "type": "agent-once.approval_request",
  "action_id": "ao_0123456789abcdef01234567",
  "tool": "browser_click",
  "args": { "element": "Place order button", "target": "e12" },
  "class": "money",
  "reason": "failed_block_on_doubt",
  "since_ms": 1761912345678
}
```

- With `secretEnv`, the request has `X-Agent-Once-Signature: sha256=<hex>`, the HMAC-SHA256 of the exact body bytes with the secret read from that environment variable. The proxy refuses to start if the variable is not set. Verify the signature with a constant-time comparison.
- The answer must be HTTP 200 with a JSON body `{"outcome": "happened"}`, `{"outcome": "not_happened"}` or `{"outcome": "unresolved"}`, at most 4 KiB. Anything else counts as unresolved and is logged.
- Redirects are not followed: a 3xx answer fails the request. Point `url` at the final address.
- After `timeoutSeconds` (default 120) the request is abandoned and the call is blocked.
- The body includes the tool arguments, so treat the endpoint as handling the same data your agent does.

## Limits

- Only stdio servers are wrapped. Remote (HTTP or SSE) MCP servers are not supported in this release.
- agent-once starts the server without a shell. On Windows, `npx` is a `.cmd` shim, so use `cmd /c npx ...` or the full path to the executable.
- Upstream calls the proxy makes for itself (read-back steps, the post-action snapshot) have no timeout of their own: a server that hangs on them keeps the guarded call open until the client cancels it. A cancelled call leaves the action in doubt.
- JSON numbers above 2^53 in tool arguments are rounded by `JSON.parse` before identity, as in any JavaScript MCP stack.
