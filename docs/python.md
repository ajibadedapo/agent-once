# Python

```bash
pip install once-guard
```

The distribution is called `once-guard` because the name `agent-once` on PyPI belongs to an unrelated project. The import name is `agent_once`. Python 3.10 or later, no runtime dependencies.

The Python package is the core, not a second proxy: it guards functions in your own Python agent, and it reads and writes the same ledger format as the npm package ([spec/ledger-v1.md](../spec/ledger-v1.md)). To guard an MCP server, use the npm proxy ([mcp-proxy.md](mcp-proxy.md)); both can share one ledger file.

## A guard

```python
import os
import uuid

from agent_once import Guard, JsonlEvidence, SqliteLedgerStore, SystemClock, default_ledger_path

clock = SystemClock()
store = SqliteLedgerStore.open(default_ledger_path(os.environ, os.path.expanduser("~")), clock)
guard = Guard(store, clock, str(uuid.uuid4()), JsonlEvidence("agent-once-events.jsonl"))
```

`Guard(store, clock, run_instance, evidence, *, human_resolver=None, retry_window_ms=120_000, expiry_ms=86_400_000, settle_window_ms=10_000, store_args=True, max_result_bytes=262_144, on_evidence_error=None)`. The options mean the same as in TypeScript ([typescript.md](typescript.md#a-guard)); `settle_window_ms` greater than `retry_window_ms` raises `ValueError`. `SqliteLedgerStore.open(path, clock, busy_timeout_ms=5000)` creates the directory and the schema; `MemoryLedgerStore(clock)` is for tests.

## The decorator

```python
from agent_once import ActionInDoubt, Guard, JsonlEvidence, ManualClock, MemoryLedgerStore

clock = ManualClock(1_761_912_345_678)
guard = Guard(MemoryLedgerStore(clock), clock, "run-1", JsonlEvidence("agent-once-events.jsonl"))


@guard.tool(policy="block-on-doubt", tool_class="money", session_key="order-run-42")
def place_order(item: str, qty: int) -> dict[str, object]:
    return {"order": "ORD-1", "item": item, "qty": qty}


@guard.tool(session_key="helpdesk-run-9")
async def create_ticket(title: str, body: str) -> dict[str, object]:
    return {"ticket": "TCK-1", "title": title}


try:
    print(place_order("Blue mug", 1))
except ActionInDoubt as doubt:
    print("ask a person:", doubt.doubt.action_id, "blocked:", doubt.blocked)
```

`@guard.tool(name=None, *, policy="guard", tool_class="standard", identity_rule=None, reconciler=None, session_key=None, intent_key=None)` works on sync and async functions. The arguments, bound to parameter names with defaults applied, are the identity.

- The wrapped function returns the result, the recorded result on a replay, or raises: `ActionInDoubt` (with `.doubt` and `.blocked`) when in doubt or blocked, the function's own exception, or `GuardedCallFailedError`.
- Without `session_key`, the session is `AGENT_ONCE_SESSION` when set (explicit), else `python:<cwd>` (default).
- On methods, `self` or `cls` is left out of identity: two instances calling the same method with equal arguments share an intent (a replay, never a duplicate). Pass `session_key` or `intent_key` when instances stand for different intents.
- A sync function that returns an awaitable is refused (recorded as not dispatched); decorate the `async def` instead.
- Arguments and return values should be JSON values. Arguments that cannot be canonicalized, including integers a double cannot represent exactly (many above 2^53), raise `CanonicalizationError` before anything runs, because both cores hash numbers as IEEE 754 doubles; pass large ids as strings. A return value that cannot be canonicalized is still returned, but the ledger stores no result for it (`result_error`), so a later replay returns `None`.

## Running a call

`guard.run(call, execute)` (sync) and `await guard.arun(call, execute)` (async) take a `GuardedCall` and return a `GuardResult` with `status` `executed`, `passed`, `replayed`, `in_doubt`, `blocked` or `ledger_unavailable`. The execute function receives an `ExecuteContext` with `action_id` and `idempotency_key`:

```python
import json
import urllib.error
import urllib.request

from agent_once import ExecuteContext, GuardedCall, ToolOutcome, idempotency_headers

order = {"item": "Blue mug", "qty": 1}
call = GuardedCall(
    tool="create_charge",
    args=order,
    session_key="shopper-17",
    session_explicit=True,
    policy="block-on-doubt",
    tool_class="money",
)


def execute(context: ExecuteContext) -> ToolOutcome:
    request = urllib.request.Request(
        "https://payments.example.com/v1/charges",
        data=json.dumps(order).encode(),
        headers={"Content-Type": "application/json", **idempotency_headers(context.idempotency_key or "")},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return ToolOutcome.ok({"status": response.status, "body": response.read().decode()})
    except urllib.error.HTTPError as error:
        return ToolOutcome.error_result({"status": error.code, "body": error.read().decode()})


result = guard.run(call, execute)
print(result.status)
```

An exception from `execute` is recorded as a transport error, so the action stays in doubt. `ToolOutcome.not_dispatched(reason)` says the effect provably did not happen, and the next attempt runs at once.

## Reconcilers and resolution

A reconciler (sync or async) receives a `ReconcileContext` (`tool`, `args`, `action_id`, `event`) and returns `ReconcileOutcome.happened(result)`, `ReconcileOutcome.not_happened()` or `ReconcileOutcome.unknown(reason)`. Pass it with `reconciler=` on the decorator or on `GuardedCall`. The settle window applies as in TypeScript.

`guard.resolve(action_id, "happened" | "not_happened", "human" | "webhook" | "agent")` records an answer. A `human_resolver` is any object with `resolve(doubt)` returning `"happened"`, `"not_happened"` or `"unresolved"` (or an awaitable of one in async code).

## pytest

Installing `once-guard` registers a pytest plugin with these fixtures:

| Fixture | What it gives you |
|---|---|
| `once_clock` | A `ManualClock` at `1_761_912_345_678` |
| `once_guard` | A `Guard` on a fresh SQLite ledger in `tmp_path`, using `once_clock` |
| `chaos_targets` | The chaos reference targets (a session-wide server, reset before each test), with `url`, `set_faults(plan)`, `truth()`, `assert_no_duplicates()` and `assert_exactly_one(target)` |

```python
def test_a_retry_after_a_lost_response_is_not_repeated(once_guard, once_clock):
    calls = []

    @once_guard.tool(intent_key="order-1")
    def place_order(item):
        calls.append(item)
        return {"order": len(calls)}

    assert place_order("Blue mug") == {"order": 1}
    once_clock.advance(1_234)
    assert place_order("Blue mug") == {"order": 1}
    assert calls == ["Blue mug"]
```

`chaos_targets` needs Node.js 22.13 or later: it runs `agent-once chaos serve` through `npx --yes agent-once@<this version>`, or the command in `AGENT_ONCE_CLI` (for example `AGENT_ONCE_CLI="node /path/to/agent-once/dist/cli/main.js"`). Tests that use it can be marked `@pytest.mark.chaos`.

```python
import json
import urllib.request

import pytest


@pytest.mark.chaos
def test_one_order(chaos_targets):
    request = urllib.request.Request(
        chaos_targets.url + "/api/checkout",
        data=json.dumps({"item": "Blue mug", "qty": "1"}).encode(),
        headers={"content-type": "application/json"},
        method="POST",
    )
    urllib.request.urlopen(request).close()
    chaos_targets.assert_exactly_one("checkout")
```
