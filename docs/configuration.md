# Configuration

The proxy runs with sensible defaults and no file. To change them, write a JSON file and pass it with `--config`:

```bash
npx agent-once mcp --config ./agent-once.config.json -- node ./shop-server.js
```

There is no automatic discovery. Relative paths in the file are resolved against the file's directory. The file is validated strictly before the server starts: an unknown key, a wrong type, an unknown policy or class, or an invalid regular expression stops the proxy with exit code 2 and a message naming the file and the JSON pointer, for example `agent-once config error in /work/agent-once.config.json at /tools/place_order/policy: expected one of guard, pass, block-on-doubt, got "always"`.

## Full example

```json
{
  "ledger": {
    "path": ".agent-once/ledger.db",
    "expiryHours": 24,
    "retryWindowSeconds": 120,
    "settleSeconds": 10,
    "storeArgs": true
  },
  "evidence": { "jsonl": ".agent-once/events.jsonl" },
  "approvalWebhook": {
    "url": "https://approvals.example.com/agent-once",
    "timeoutSeconds": 120,
    "secretEnv": "AGENT_ONCE_WEBHOOK_SECRET"
  },
  "exposeResolveTool": true,
  "tools": {
    "place_order": {
      "class": "money",
      "identity": { "include": ["item", "qty"] },
      "readBack": {
        "steps": [{ "tool": "list_orders", "args": {} }],
        "happened": "\"clientRef\":\"{{idempotency_key}}\"",
        "notHappened": "^\\["
      },
      "notDispatchedErrors": ["stale form: nothing was submitted"]
    },
    "search_*": { "policy": "pass" },
    "deploy_*": { "policy": "block-on-doubt", "class": "irreversible" }
  },
  "browser": {
    "enabled": "auto",
    "successMarkers": ["order (number|#|confirmed)", "your booking is confirmed"]
  }
}
```

## `ledger`

| Key | Default | Meaning |
|---|---|---|
| `path` | `$AGENT_ONCE_HOME/ledger.db`, else `~/.agent-once/ledger.db` | The SQLite ledger. Proxies that share a file share their history. |
| `expiryHours` | `24` | How long events are kept. Expired events are pruned when the ledger opens. |
| `retryWindowSeconds` | `120` | A failed call retried inside this window is held as in doubt. It is also how long a rerun with the default session replays. |
| `settleSeconds` | `10` | How long after the last in-doubt event a `not_happened` answer from a reconciler or the agent is accepted. Must not exceed `retryWindowSeconds`. |
| `storeArgs` | `true` | Store each call's arguments in the ledger. Set to `false` to keep only hashes; `ledger list` then shows `null` arguments. |

## `evidence`

| Key | Default | Meaning |
|---|---|---|
| `jsonl` | `events.jsonl` next to the default ledger | Append one JSON line per decision, state change, reconciliation and resolution. `null` turns it off. |

## `approvalWebhook`

Optional. `url` (http or https), `timeoutSeconds` (default 120) and `secretEnv` (the name of an environment variable holding the HMAC secret). See [mcp-proxy.md](mcp-proxy.md#approval-webhook) for the request, the signature and the expected answer.

## `exposeResolveTool`

Default `true`: the proxy adds the `agent_once_resolve` tool so the agent can record whether a `standard` in-doubt action happened. With `false`, the in-doubt message tells the agent to ask the user to run `agent-once resolve` instead.

## `tools`

Keys are tool names or globs (`*` matches any run of characters, `?` one character). An exact name wins; otherwise the first matching glob in file order applies. Each rule may set:

| Key | Meaning |
|---|---|
| `policy` | `guard`, `pass` or `block-on-doubt`. Overrides annotations and browser rules. |
| `class` | `money`, `irreversible` or `standard`. Without `policy`, a read-only annotated tool still passes; otherwise `money` and `irreversible` mean `block-on-doubt` and `standard` means `guard`. |
| `identity` | `{"include": [...]}` or `{"exclude": [...]}`: which top-level arguments make up the intent. Use it to ignore arguments that vary between retries of the same action (a client timestamp under a custom name, a free-text note). |
| `readBack` | A reconciler built from upstream tool calls (below). |
| `notDispatchedErrors` | Regular expressions. An error result whose text matches one means the tool provably did nothing, so the next attempt runs at once. |

## Read-back

A read-back tells agent-once how to check whether an in-doubt action happened, using the server's own read tools:

```json
{
  "tools": {
    "create_ticket": {
      "readBack": {
        "steps": [{ "tool": "list_tickets", "args": { "title": "{{args.title}}" } }],
        "happened": "\"clientRef\":\"{{idempotency_key}}\"",
        "notHappened": "^\\[\\]$"
      }
    }
  }
}
```

- `steps` run in order through the same server, without being guarded. Their text results are joined.
- `happened` and `notHappened` are regular expressions (case-insensitive) tested against that text, `happened` first. If neither matches, or a step fails, the outcome is unknown and the doubt stands.
- Templates in step arguments and patterns: `{{args.<path>}}` (the original call's arguments), `{{action_id}}`, `{{idempotency_key}}` (the key forwarded upstream in `_meta["io.github.ajibadedapo/agent-once-action"]`), and for browser rules `{{captured}}` and `{{origin}}`. A whole-string placeholder in step arguments keeps its JSON type; inside patterns, values are regex-escaped.
- The strongest read-back looks for the idempotency key, because it proves this exact attempt landed. That needs a server that stores the key it receives.

Browser read-backs are keyed by URL instead of tool name; see [browser.md](browser.md#read-back).

## `browser`

| Key | Default |
|---|---|
| `enabled` | `"auto"`: on for detected Playwright and chrome-devtools servers. `true` applies the rules by tool name, `false` turns them off. |
| `sideEffectPatterns` | pay, buy, checkout, book, confirm, submit, send, delete, publish, order, purchase, place, create, post |
| `moneyPatterns` | pay, buy, checkout, purchase, charge, order, payment, transfer |
| `irreversiblePatterns` | delete, publish, send, deploy |
| `notDispatchedErrors` | `Ref \S+ not found`, `Element uid \S+ not found`, `No element`, `not attached`, `Element is not visible`, `stale` |
| `successMarkers` | `order (number\|#\|confirmed)`, `booking (confirmed\|reference)`, `(message\|email) sent`, `ticket .* created`, `thank you for your (order\|purchase\|booking)` |
| `failureMarkers` | `ERR_[A-Z_]+`, `This site can.t be reached`, `(502\|503\|504) `, `timed out` |
| `capture` | `[]`: `{ "urlPattern", "regex" }` values to read from the page before an action |
| `readBack` | `[]`: `{ "urlPattern", "steps", "happened", "notHappened" }` |

Word patterns match whole words, case-insensitively. A list you set replaces the default list, so include the defaults you still want. A rule in `tools` for a browser tool name (for example `"browser_click": {"policy": "pass"}`) overrides the page-aware decision for that tool.

## Environment

| Variable | Meaning |
|---|---|
| `AGENT_ONCE_HOME` | Directory for the default ledger and evidence file. |
| `AGENT_ONCE_SESSION` | Explicit session key (the `--session` flag sets it). |
