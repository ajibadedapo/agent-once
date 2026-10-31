# Ledger

The ledger is an append-only SQLite file that records every guarded call. Its format, identity rules and decision table are specified in [spec/ledger-v1.md](../spec/ledger-v1.md), with shared test vectors in [spec/vectors](../spec/vectors). The npm package and the Python package implement the same spec, so the proxy, a TypeScript agent and a Python agent can share one file.

## Where it lives

| File | Default |
|---|---|
| Ledger | `$AGENT_ONCE_HOME/ledger.db`, else `~/.agent-once/ledger.db` |
| Evidence (CLI and proxy) | `events.jsonl` in the same directory |

Override them with `ledger.path` and `evidence.jsonl` in the proxy config, or open any path from code. SQLite creates `ledger.db-wal` and `ledger.db-shm` next to the file while it is open.

## Inspecting it

```bash
npx agent-once ledger list
npx agent-once ledger list --in-doubt
npx agent-once ledger list --json
```

`ledger list` prints the latest state of every unexpired action, newest last, with its action id, state, tool, class, time and session. `--in-doubt` shows only actions whose dispatch has no recorded outcome (`intended` or `sent`). An action whose last state is `failed` can also be held in doubt (within the retry window, or always for `block-on-doubt`); it appears in the plain `ledger list` with state `failed`, and `resolve` accepts it. `--json` prints an array of objects with `action_id`, `state`, `tool`, `tool_class`, `policy`, `occurrence`, `session_key`, `at_ms` and `args` (`null` when `storeArgs` is off).

```bash
npx agent-once resolve ao_0123456789abcdef01234567 --happened
npx agent-once resolve ao_0123456789abcdef01234567 --not-happened
```

records a person's answer for an action in doubt (`reconciled`, resolved by `human`). It refuses unknown actions and actions that are not in doubt. All three commands take `--config <file>` to use the ledger path from a proxy config. Exit codes: 0 done, 1 refused, 2 usage or config error, 3 ledger unavailable.

The file is plain SQLite, so `sqlite3 ~/.agent-once/ledger.db 'select seq, action_id, state, tool from events order by seq'` works too. Read it, but do not write to it by hand.

## Retention and versions

- Events expire after `expiryHours` (24 by default) and are deleted when the ledger is next opened.
- `meta.schema_version` is `1`. A ledger written by a newer schema is refused with the version in the message rather than modified. A missing or malformed version is treated as unavailable.
- When the ledger is unavailable (locked past the 5 s busy timeout, unwritable, corrupt), guarded calls fail closed and are not dispatched; `pass` tools keep working.

## What it contains

Arguments (unless `storeArgs` is false), results up to 256 KiB, captured page values, session keys and idempotency keys. Treat it as application data; see [SECURITY.md](../SECURITY.md).
