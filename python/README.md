# once-guard

Stop your AI agent from charging, booking or sending twice.

`once-guard` is the Python core of [agent-once](https://github.com/ajibadedapo/agent-once). It gives every side-effecting function your agent calls a stable identity, records it in a local SQLite ledger before it runs, and on a repeat either returns the recorded result, checks what really happened, or stops and asks. The promise: at most once by default, exactly once wherever a reconciler can confirm the outcome.

```bash
pip install once-guard
```

The distribution is named `once-guard` because `agent-once` on PyPI is an unrelated project; the import name is `agent_once`. Python 3.10 or later, no runtime dependencies.

```python
import os
import uuid

from agent_once import Guard, JsonlEvidence, SqliteLedgerStore, SystemClock, default_ledger_path

clock = SystemClock()
store = SqliteLedgerStore.open(default_ledger_path(os.environ, os.path.expanduser("~")), clock)
guard = Guard(store, clock, str(uuid.uuid4()), JsonlEvidence("agent-once-events.jsonl"))


@guard.tool(policy="block-on-doubt", tool_class="money", session_key="order-run-42")
def place_order(item: str, qty: int) -> dict[str, object]:
    return {"order": "ORD-1", "item": item, "qty": qty}


place_order("Blue mug", 1)
```

A repeat of a call whose outcome is unknown raises `ActionInDoubt` instead of running again. Reconcilers, `guard.run` and `guard.arun` with idempotency keys, and the pytest fixtures (`once_guard`, `once_clock`, `agent_once_chaos_targets`) are described in the [Python guide](https://github.com/ajibadedapo/agent-once/blob/main/docs/python.md).

The ledger format is shared with the npm package `agent-once`, which provides the MCP proxy for Claude Code, Claude Desktop, Cursor and any other MCP client. Both can use the same ledger file ([format spec](https://github.com/ajibadedapo/agent-once/blob/main/spec/ledger-v1.md)).

No telemetry. Licence: Apache 2.0.
