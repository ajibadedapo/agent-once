from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass
from typing import TypeVar

from .canonical import canonicalize
from .clock import Clock
from .ledger import (
    NESTED_TRANSACT,
    LedgerConflictError,
    LedgerEvent,
    LedgerTx,
    LedgerUnavailableError,
    LedgerUsageError,
    NewLedgerEvent,
    is_in_doubt_state,
    reject_awaitable,
    stored_event,
)

T = TypeVar("T")


@dataclass(frozen=True)
class _Stored:
    event: NewLedgerEvent
    seq: int
    detail_json: str

    def materialize(self) -> LedgerEvent:
        return stored_event(self.event, self.seq, json.loads(self.detail_json))


class _MemoryTx:
    def __init__(self, store: MemoryLedgerStore) -> None:
        self._store = store

    def latest(self, intent_hash: str) -> LedgerEvent | None:
        return self._store._latest(intent_hash)

    def append(self, event: NewLedgerEvent) -> LedgerEvent:
        return self._store._append(event)


class MemoryLedgerStore:
    def __init__(self, clock: Clock) -> None:
        self._events: list[_Stored] = []
        self._next_seq = 1
        self._closed = False
        self._in_transaction = False

    def transact(self, fn: Callable[[LedgerTx], T]) -> T:
        self._assert_open()
        if self._in_transaction:
            raise LedgerUsageError(NESTED_TRANSACT)
        rollback_length = len(self._events)
        rollback_seq = self._next_seq
        self._in_transaction = True
        try:
            result = fn(_MemoryTx(self))
            reject_awaitable(result)
            return result
        except BaseException:
            del self._events[rollback_length:]
            self._next_seq = rollback_seq
            raise
        finally:
            self._in_transaction = False

    def find_action(self, action_id: str) -> LedgerEvent | None:
        self._assert_open()
        for stored in reversed(self._events):
            if stored.event.action_id == action_id:
                return stored.materialize()
        return None

    def list_in_doubt(self, now_ms: int) -> list[LedgerEvent]:
        self._assert_open()
        newest: dict[str, _Stored] = {}
        for stored in self._events:
            newest[stored.event.action_id] = stored
        candidates = [
            stored
            for stored in newest.values()
            if is_in_doubt_state(stored.event.state) and stored.event.expires_at_ms > now_ms
        ]
        return [
            stored.materialize() for stored in sorted(candidates, key=lambda stored: stored.seq)
        ]

    def close(self) -> None:
        self._closed = True

    def _latest(self, intent_hash: str) -> LedgerEvent | None:
        latest: _Stored | None = None
        for stored in self._events:
            if stored.event.intent_hash != intent_hash:
                continue
            if latest is None or stored.event.occurrence >= latest.event.occurrence:
                latest = stored
        return None if latest is None else latest.materialize()

    def _append(self, event: NewLedgerEvent) -> LedgerEvent:
        detail_json = canonicalize(event.detail)
        claimed = event.state == "intended" and any(
            stored.event.state == "intended"
            and stored.event.intent_hash == event.intent_hash
            and stored.event.occurrence == event.occurrence
            for stored in self._events
        )
        if claimed:
            raise LedgerConflictError(event.intent_hash, event.occurrence)
        stored = _Stored(event, self._next_seq, detail_json)
        self._next_seq += 1
        self._events.append(stored)
        return stored.materialize()

    def _assert_open(self) -> None:
        if self._closed:
            raise LedgerUnavailableError("the ledger is closed")
