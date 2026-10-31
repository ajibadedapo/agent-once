from __future__ import annotations

import inspect
from collections.abc import Callable
from dataclasses import dataclass, fields
from typing import Literal, Protocol, TypeVar

from .canonical import JsonValue

LEDGER_SCHEMA_VERSION = 1
NESTED_TRANSACT = "transact cannot be nested; finish the current transaction first"
AWAITABLE_RESULT = "the transact callback must be synchronous but returned an awaitable"

LedgerState = Literal["intended", "sent", "confirmed", "failed", "reconciled"]
ToolClass = Literal["money", "irreversible", "standard"]
GuardPolicy = Literal["guard", "block-on-doubt"]

T = TypeVar("T")


@dataclass(frozen=True)
class NewLedgerEvent:
    action_id: str
    intent_hash: str
    occurrence: int
    state: LedgerState
    at_ms: int
    expires_at_ms: int
    session_key: str
    session_explicit: bool
    intent_key_explicit: bool
    run_instance: str
    tool: str
    tool_class: ToolClass
    policy: GuardPolicy
    args_json: str | None
    detail: dict[str, JsonValue]


@dataclass(frozen=True)
class LedgerEvent(NewLedgerEvent):
    seq: int


def stored_event(event: NewLedgerEvent, seq: int, detail: dict[str, JsonValue]) -> LedgerEvent:
    values = {item.name: getattr(event, item.name) for item in fields(NewLedgerEvent)}
    values["detail"] = detail
    return LedgerEvent(**values, seq=seq)


class LedgerTx(Protocol):
    def latest(self, intent_hash: str) -> LedgerEvent | None: ...

    def append(self, event: NewLedgerEvent) -> LedgerEvent: ...


class LedgerStore(Protocol):
    def transact(self, fn: Callable[[LedgerTx], T]) -> T: ...

    def find_action(self, action_id: str) -> LedgerEvent | None: ...

    def list_in_doubt(self, now_ms: int) -> list[LedgerEvent]: ...

    def close(self) -> None: ...


class LedgerUnavailableError(Exception):
    def __init__(self, reason: str) -> None:
        super().__init__(f"agent-once ledger unavailable: {reason}")


class LedgerSchemaTooNewError(LedgerUnavailableError):
    def __init__(self, found: int, known: int) -> None:
        super().__init__(
            f"schema_version {found} is newer than the supported version {known}; "
            "upgrade agent-once to open it"
        )
        self.found = found


class LedgerConflictError(Exception):
    def __init__(self, intent_hash: str, occurrence: int) -> None:
        super().__init__(f"occurrence {occurrence} of intent {intent_hash} is already intended")
        self.intent_hash = intent_hash
        self.occurrence = occurrence


class LedgerUsageError(Exception):
    pass


def is_in_doubt_state(state: LedgerState) -> bool:
    return state in ("intended", "sent")


def reject_awaitable(result: object) -> None:
    if not inspect.isawaitable(result):
        return
    if inspect.iscoroutine(result):
        result.close()
    raise TypeError(AWAITABLE_RESULT)
