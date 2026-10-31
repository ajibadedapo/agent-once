from __future__ import annotations

import dataclasses
from collections.abc import Callable
from typing import Any, TypeVar

from agent_once import (
    EvidenceEvent,
    ExecuteContext,
    GuardedCall,
    LedgerEvent,
    LedgerStore,
    LedgerTx,
    NewLedgerEvent,
    ToolOutcome,
)

START_MS = 1_761_912_345_678
EXPIRY_MS = 86_400_000

T = TypeVar("T")


class RecordingSink:
    def __init__(self) -> None:
        self.events: list[EvidenceEvent] = []

    def emit(self, event: EvidenceEvent) -> None:
        self.events.append(event)

    def of_kind(self, kind: str) -> list[EvidenceEvent]:
        return [event for event in self.events if event.kind == kind]


class _RecordingTx:
    def __init__(self, inner: LedgerTx, pending: list[LedgerEvent]) -> None:
        self._inner = inner
        self._pending = pending

    def latest(self, intent_hash: str) -> LedgerEvent | None:
        return self._inner.latest(intent_hash)

    def append(self, event: NewLedgerEvent) -> LedgerEvent:
        stored = self._inner.append(event)
        self._pending.append(stored)
        return stored


class RecordingStore:
    def __init__(self, inner: LedgerStore) -> None:
        self.inner = inner
        self.appended: list[LedgerEvent] = []
        self.before_transact: Callable[[], None] | None = None
        self.transaction_count = 0

    def transact(self, fn: Callable[[LedgerTx], T]) -> T:
        self.transaction_count += 1
        if self.before_transact is not None:
            self.before_transact()
        pending: list[LedgerEvent] = []
        result = self.inner.transact(lambda tx: fn(_RecordingTx(tx, pending)))
        self.appended.extend(pending)
        return result

    def find_action(self, action_id: str) -> LedgerEvent | None:
        return self.inner.find_action(action_id)

    def list_in_doubt(self, now_ms: int) -> list[LedgerEvent]:
        return self.inner.list_in_doubt(now_ms)

    def close(self) -> None:
        self.inner.close()

    def states(self) -> list[str]:
        return [event.state for event in self.appended]

    def last(self) -> LedgerEvent:
        if not self.appended:
            raise AssertionError("nothing was appended")
        return self.appended[-1]


def guarded_call(**overrides: Any) -> GuardedCall:
    base = GuardedCall(
        tool="create_ticket",
        args={"title": "Printer jam", "priority": 2},
        session_key="client:/work",
        session_explicit=False,
        policy="guard",
        tool_class="standard",
    )
    return dataclasses.replace(base, **overrides)


class Scripted:
    def __init__(self, *outcomes: ToolOutcome) -> None:
        self._outcomes = outcomes
        self.calls: list[str | None] = []
        self.keys: list[str | None] = []

    def _next(self, context: ExecuteContext) -> ToolOutcome:
        self.calls.append(context.action_id)
        self.keys.append(context.idempotency_key)
        return self._outcomes[min(len(self.calls) - 1, len(self._outcomes) - 1)]

    def execute(self, context: ExecuteContext) -> ToolOutcome:
        return self._next(context)

    async def aexecute(self, context: ExecuteContext) -> ToolOutcome:
        return self._next(context)


def new_event(**overrides: Any) -> NewLedgerEvent:
    at_ms = overrides.get("at_ms", START_MS)
    base = NewLedgerEvent(
        action_id="ao_000000000000000000000001",
        intent_hash="a" * 64,
        occurrence=0,
        state="intended",
        at_ms=at_ms,
        expires_at_ms=at_ms + EXPIRY_MS,
        session_key="client:/work",
        session_explicit=False,
        intent_key_explicit=False,
        run_instance="run-1",
        tool="pay_invoice",
        tool_class="money",
        policy="block-on-doubt",
        args_json='{"amount":12}',
        detail={},
    )
    return dataclasses.replace(base, **overrides)
