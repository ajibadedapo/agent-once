# How it works

agent-once promises at most once by default, exactly once wherever a reconciler can confirm the outcome. This page explains how a guarded call gets there. The normative details are in [spec/ledger-v1.md](../spec/ledger-v1.md); both the TypeScript and the Python core pass the same test vectors.

## Policy and class

Every call gets a policy and a class before anything else.

| Policy | Meaning |
|---|---|
| `pass` | Not guarded. Read-only tools, and browser actions that do not match a side-effect pattern. |
| `guard` | Guarded. When the outcome is in doubt the agent is told not to retry and may check and resolve it. |
| `block-on-doubt` | Guarded. When the outcome is in doubt only a person (elicitation, the approval webhook or `agent-once resolve`) can release it. |

| Class | Matched words (case-insensitive, whole words in the tool name, title or element label) | Default policy |
|---|---|---|
| `money` | pay, buy, checkout, purchase, charge, order, payment, transfer | `block-on-doubt` |
| `irreversible` | delete, publish, send, deploy | `block-on-doubt` |
| `standard` | everything else that is guarded | `guard` |

On the MCP proxy a tool passes when its `readOnlyHint` is true, or when it declares `destructiveHint: false` together with `idempotentHint: true`. Every other tool, including tools without annotations, is guarded, because the MCP defaults are destructive and non-idempotent. Annotations are untrusted hints from the server; a config rule overrides them ([configuration.md](configuration.md)). Browser servers get page-aware rules instead ([browser.md](browser.md)).

## Identity

A guarded call is identified by its intent:

```
intent_hash = SHA-256(JCS(["agent-once/v1", session_key, tool, projected_args]))
```

- `projected_args` are the arguments with volatile keys removed at any depth (`timestamp`, `ts`, `nonce`, `request_id`, `requestId`, `idempotency_key`, `idempotencyKey`, `trace_id`, `traceId`, `_meta`) and the tool's identity rule applied (`include` or `exclude` top-level keys).
- JCS is RFC 8785 canonical JSON, so key order and number formatting do not change the hash.
- An explicit intent key replaces the arguments: `["agent-once/v1/intent", session_key, tool, intent_key]`.
- Each attempt at an intent is an occurrence (0, 1, 2, ...). The action id `ao_...` names one occurrence and is what agent-once forwards upstream as the idempotency key.

The session key scopes intents. On the proxy it is, in order: an Agent Mandates id in `_meta["io.github.ajibadedapo.agent-mandates/mandate-id"]`, `_meta["io.github.ajibadedapo/agent-once-session"]`, the `AGENT_ONCE_SESSION` environment variable (or `--session`), and otherwise the default `clientInfo.name + ":" + cwd`. The first three are explicit; the default is not.

Arguments with `NaN` or `Infinity` cannot be canonicalized: the call is reported as an error and is not dispatched. On the TypeScript side, MCP messages are parsed with `JSON.parse`, so integers above 2^53 are already rounded before identity is computed, as in any JavaScript MCP stack. Python refuses integers that a double cannot represent exactly; pass large ids as strings.

## The ledger

Every guarded call appends events to an append-only SQLite ledger (`~/.agent-once/ledger.db`, or `$AGENT_ONCE_HOME/ledger.db`):

```
intended -> sent -> confirmed
                 -> failed
intended | sent | failed -> reconciled
```

- `intended` is written before dispatch, in the same transaction as the decision, so two processes sharing a ledger cannot both claim an occurrence.
- `sent` is written just before the tool is called. If the process dies now, the action stays in doubt.
- `confirmed` holds the result (results over 256 KiB are kept as a marker; a replay then says the effect is confirmed but the result was too large to keep).
- `failed` records an error result, a transport error or `not_dispatched` (the tool provably did nothing, for example a stale element reference).
- `reconciled` records an answer established after doubt, and who gave it (reconciler, agent, human or webhook).

Events expire after 24 hours and are pruned when the ledger opens. The ledger uses WAL with `synchronous=NORMAL` and a 5 s busy timeout. If it cannot be opened or written (locked past the timeout, unwritable, corrupt, or written by a newer schema), guarded calls fail closed with an "agent-once ledger unavailable" error and are not dispatched; `pass` tools keep working.

Two identical calls at the same time in one process join: the tool runs once and both get the same answer.

## The decision

For each guarded call the guard reads the latest event of the intent and decides:

| Latest event | Condition | Decision | Reason |
|---|---|---|---|
| none | | run | `new` |
| expired | | run | `expired` |
| `intended` or `sent` | | in doubt | `outcome_unknown` |
| `failed` (not dispatched) | | run | `not_dispatched` |
| `failed` | policy `block-on-doubt` | in doubt | `failed_block_on_doubt` |
| `failed` | within the retry window (120 s) | in doubt | `failed_within_window` |
| `failed` | after the retry window | run | `failed_after_window` |
| `confirmed` or happened | explicit intent key | replay | `replay_explicit_intent` |
| `confirmed` or happened | the caller never got the result, or it was reconciled, within the window | replay | `replay_undelivered` |
| `confirmed` or happened | different run, explicit session | replay | `replay_rerun_explicit_session` |
| `confirmed` or happened | different run, default session, within the window | replay | `replay_rerun_within_window` |
| `confirmed` or happened | otherwise | run again | `deliberate_repeat` |
| reconciled, not happened | | run | `reconciled_not_happened` |

So:

- A retry after an error or timeout is held, not repeated.
- A crashed run that is started again replays its completed actions: within 24 h with an explicit session, within the retry window with the default session.
- A confirmed action that the same run repeats is treated as deliberate and runs. Pass an explicit intent key when "the same arguments" really means "the same action".
- A failed money or irreversible action stays in doubt until someone resolves it.

A "run" is one guard instance: one proxy process, or one `Guard` object in your code.

## In doubt

When the decision is in doubt:

1. If the tool has a reconciler (a read-back), the guard runs it. `happened` is recorded and the stored result is replayed. `not_happened` is accepted only after the settle window (10 s since the last in-doubt event), so an effect that is still arriving is not mistaken for a missing one; then the call runs as a new occurrence.
2. Otherwise, policy `guard` returns an "outcome unknown" result. Through the proxy, the agent can check (read the page, list the records) and call `agent_once_resolve`.
3. Policy `block-on-doubt` asks a person: MCP elicitation if the client supports it, then the approval webhook if one is configured. Without an answer the call is blocked.

The agent may resolve only `standard` actions, and may not say `not_happened` inside the settle window. People and webhooks may resolve anything at any time.

A failed action past the retry window that has a reconciler is checked before it runs again, so a late retry does not duplicate an effect that did land.

## Idempotency keys

The key forwarded upstream is the action id. A late retry (`failed_after_window` or `not_dispatched`) reuses the previous occurrence's key, so a service that honours idempotency keys can deduplicate agent-once's own retries. A consequence: if the earlier attempt returned an error and the service caches error responses per key, the retry gets the same error back. Use an explicit intent key or a new session when you want a fresh key.

## Evidence

Every decision, state change, reconciliation and resolution is emitted as a structured event: JSONL (`~/.agent-once/events.jsonl` by default for the CLI) and, in TypeScript, OpenTelemetry span events on the active span through `OtelEvidenceSink` (needs `@opentelemetry/api`; see [typescript.md](typescript.md#evidence)). The ledger itself is inspectable with `agent-once ledger list` ([ledger.md](ledger.md)).
