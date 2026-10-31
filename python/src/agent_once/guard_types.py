from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Literal, Protocol

from .canonical import JsonValue
from .identity import IdentityRule
from .ledger import LedgerEvent, ToolClass

OutcomeKind = Literal["ok", "error_result", "transport_error", "not_dispatched"]
ReconcileKind = Literal["happened", "not_happened", "unknown"]
HumanResolution = Literal["happened", "not_happened", "unresolved"]
ResolvedBy = Literal["agent", "human", "webhook"]
CallPolicy = Literal["pass", "guard", "block-on-doubt"]
GuardStatus = Literal["executed", "passed", "replayed", "in_doubt", "blocked", "ledger_unavailable"]


@dataclass(frozen=True)
class ToolOutcome:
    kind: OutcomeKind
    result: JsonValue = None
    error: str = ""

    @classmethod
    def ok(cls, result: JsonValue) -> ToolOutcome:
        return cls("ok", result=result)

    @classmethod
    def error_result(cls, result: JsonValue) -> ToolOutcome:
        return cls("error_result", result=result)

    @classmethod
    def transport_error(cls, error: str) -> ToolOutcome:
        return cls("transport_error", error=error)

    @classmethod
    def not_dispatched(cls, error: str) -> ToolOutcome:
        return cls("not_dispatched", error=error)


@dataclass(frozen=True)
class ReconcileOutcome:
    outcome: ReconcileKind
    result: JsonValue = None
    reason: str = ""

    @classmethod
    def happened(cls, result: JsonValue = None) -> ReconcileOutcome:
        return cls("happened", result=result)

    @classmethod
    def not_happened(cls) -> ReconcileOutcome:
        return cls("not_happened")

    @classmethod
    def unknown(cls, reason: str) -> ReconcileOutcome:
        return cls("unknown", reason=reason)


@dataclass(frozen=True)
class ReconcileContext:
    tool: str
    args: Mapping[str, object]
    action_id: str
    event: LedgerEvent


Reconciler = Callable[[ReconcileContext], ReconcileOutcome | Awaitable[ReconcileOutcome]]


@dataclass(frozen=True)
class DoubtInfo:
    action_id: str
    tool: str
    args: Mapping[str, object]
    tool_class: ToolClass
    reason: str
    since_ms: int


class HumanResolver(Protocol):
    def resolve(self, doubt: DoubtInfo) -> object: ...


class CancelSignal(Protocol):
    def is_set(self) -> bool: ...


@dataclass(frozen=True)
class GuardedCall:
    tool: str
    args: Mapping[str, object]
    session_key: str
    session_explicit: bool
    policy: CallPolicy
    tool_class: ToolClass
    intent_key: str | None = None
    identity_rule: IdentityRule | None = None
    volatile_keys: Sequence[str] | None = None
    extra_identity: Mapping[str, JsonValue] | None = None
    reconciler: Reconciler | None = None
    captured: str | None = None
    signal: CancelSignal | None = None


@dataclass(frozen=True)
class ExecuteContext:
    action_id: str | None = None
    idempotency_key: str | None = None


@dataclass(frozen=True)
class GuardResult:
    status: GuardStatus
    action_id: str | None = None
    outcome: ToolOutcome | None = None
    recorded: bool = True
    result: JsonValue = None
    result_truncated: bool = False
    reason: str | None = None
    doubt: DoubtInfo | None = None
    error: str | None = None


@dataclass(frozen=True)
class ResolveResult:
    ok: bool
    event: LedgerEvent | None = None
    reason: str | None = None
    error: str | None = None


class ActionInDoubt(Exception):
    def __init__(self, doubt: DoubtInfo, blocked: bool) -> None:
        verdict = (
            "blocked until someone confirms whether it happened"
            if blocked
            else "in doubt; resolve it before retrying"
        )
        super().__init__(
            f"agent-once: {doubt.tool} action {doubt.action_id} is {verdict} ({doubt.reason})"
        )
        self.doubt = doubt
        self.blocked = blocked


class GuardedCallFailedError(Exception):
    pass
