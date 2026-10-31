from __future__ import annotations

import json
import threading
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
    is_unresolved_event,
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
        self._lock = threading.RLock()

    def transact(self, fn: Callable[[LedgerTx], T]) -> T:
        with self._lock:
            return self._transact_locked(fn)

    def _transact_locked(self, fn: Callable[[LedgerTx], T]) -> T:
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
        with self._lock:
            return self._find_action_locked(action_id)

    def _find_action_locked(self, action_id: str) -> LedgerEvent | None:
        self._assert_open()
        for stored in reversed(self._events):
            if stored.event.action_id == action_id:
                return stored.materialize()
        return None

    def list_in_doubt(self, now_ms: int) -> list[LedgerEvent]:
        with self._lock:
            return self._list_in_doubt_locked(now_ms)

    def _list_in_doubt_locked(self, now_ms: int) -> list[LedgerEvent]:
        self._assert_open()
        latest_by_intent: dict[str, _Stored] = {}
        for stored in self._events:
            latest = latest_by_intent.get(stored.event.intent_hash)
            if latest is None or stored.event.occurrence >= latest.event.occurrence:
                latest_by_intent[stored.event.intent_hash] = stored
        ordered = sorted(latest_by_intent.values(), key=lambda stored: stored.seq)
        events = [stored.materialize() for stored in ordered]
        return [event for event in events if is_unresolved_event(event, now_ms)]

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
