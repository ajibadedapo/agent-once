from __future__ import annotations

import asyncio
import functools
import inspect
import os
import sys
from collections.abc import Awaitable, Callable, Generator
from dataclasses import dataclass
from typing import Any, Literal, ParamSpec, TypeVar, cast

from .canonical import JsonValue, canonicalize
from .clock import Clock
from .decide import DecisionCall, decide
from .evidence import EvidenceEvent, EvidenceKind, EvidenceSink
from .guard_types import (
    ActionInDoubt,
    CallPolicy,
    DoubtInfo,
    ExecuteContext,
    GuardedCall,
    GuardedCallFailedError,
    GuardResult,
    HumanResolution,
    HumanResolver,
    ReconcileContext,
    ReconcileOutcome,
    Reconciler,
    ResolvedBy,
    ResolveResult,
    ToolOutcome,
)
from .identity import DEFAULT_VOLATILE_KEYS, IdentityRule, action_id, intent_hash, project_args
from .ledger import (
    GuardPolicy,
    LedgerConflictError,
    LedgerEvent,
    LedgerState,
    LedgerStore,
    LedgerTx,
    LedgerUnavailableError,
    NewLedgerEvent,
    ToolClass,
)
from .result_cap import DEFAULT_MAX_RESULT_BYTES, stored_result_detail

DEFAULT_RETRY_WINDOW_MS = 120_000
DEFAULT_EXPIRY_MS = 86_400_000
DEFAULT_SETTLE_WINDOW_MS = 10_000

ERROR_RESULT_MESSAGE = "the tool returned an error result"
SYNC_EXECUTE_AWAITABLE = "execute returned an awaitable; use Guard.arun for async tools"
SYNC_RECONCILER_AWAITABLE = (
    "the reconciler returned an awaitable; use Guard.arun for async reconcilers"
)
INHERITED_KEY_REASONS = frozenset({"failed_after_window", "not_dispatched"})
RECONCILE_KINDS = frozenset({"happened", "not_happened", "unknown"})
HUMAN_ANSWERS = frozenset({"happened", "not_happened"})
SESSION_ENV = "AGENT_ONCE_SESSION"

P = ParamSpec("P")
R = TypeVar("R")

Execute = Callable[[ExecuteContext], ToolOutcome | Awaitable[ToolOutcome]]
EvidenceErrorHook = Callable[[BaseException, EvidenceEvent], None]


@dataclass(frozen=True)
class _Identity:
    hash: str
    args_json: str | None


@dataclass(frozen=True)
class _Claim:
    kind: Literal["execute", "verify", "replay", "in_doubt"]
    event: LedgerEvent
    reason: str


@dataclass(frozen=True)
class _Resolution:
    event: LedgerEvent
    outcome: Literal["happened", "not_happened"]
    by: Literal["reconciler", "human"]
    result: JsonValue = None


@dataclass(frozen=True)
class _Dispatch:
    context: ExecuteContext


@dataclass(frozen=True)
class _Reconcile:
    reconciler: Reconciler
    context: ReconcileContext


@dataclass(frozen=True)
class _AskHuman:
    doubt: DoubtInfo


_Effect = _Dispatch | _Reconcile | _AskHuman
_Flow = Generator[_Effect, object, GuardResult]


def _report_to_stderr(error: BaseException, _event: EvidenceEvent) -> None:
    sys.stderr.write(f"agent-once: evidence sink failed: {error}\n")


def _idempotency_key_of(event: LedgerEvent) -> str:
    key = event.detail.get("idempotency_key")
    return key if isinstance(key, str) else event.action_id


def _unavailable(error: LedgerUnavailableError) -> GuardResult:
    return GuardResult("ledger_unavailable", error=str(error))


def _captured_detail(call: GuardedCall) -> dict[str, JsonValue]:
    return {} if call.captured is None else {"captured": call.captured}


def _is_unresolved(event: LedgerEvent, now_ms: int) -> bool:
    if event.expires_at_ms <= now_ms:
        return False
    if event.state in ("intended", "sent"):
        return True
    return event.state == "failed" and event.detail.get("failure_kind") != "not_dispatched"


def _replayed(event: LedgerEvent, reason: str) -> GuardResult:
    return GuardResult(
        "replayed",
        action_id=event.action_id,
        result=event.detail.get("result"),
        result_truncated=event.detail.get("result_truncated") is True,
        reason=reason,
    )


def _discard_awaitable(value: object) -> None:
    if inspect.iscoroutine(value):
        value.close()


def _checked_outcome(value: object) -> ToolOutcome:
    if isinstance(value, ToolOutcome):
        return value
    return ToolOutcome.transport_error(
        f"execute returned {type(value).__name__}, not a ToolOutcome"
    )


def _checked_reconcile(value: object) -> ReconcileOutcome:
    if isinstance(value, ReconcileOutcome) and value.outcome in RECONCILE_KINDS:
        return value
    return ReconcileOutcome.unknown("invalid reconciler outcome")


def _checked_human(value: object) -> HumanResolution:
    if value == "happened":
        return "happened"
    if value == "not_happened":
        return "not_happened"
    return "unresolved"


def _default_session(session_key: str | None) -> tuple[str, bool]:
    if session_key is not None:
        return session_key, True
    from_env = os.environ.get(SESSION_ENV)
    if from_env:
        return from_env, True
    return f"python:{os.getcwd()}", False


def _returned(result: GuardResult, thrown: list[BaseException]) -> Any:
    if result.status in ("executed", "passed") and result.outcome is not None:
        if result.outcome.kind == "ok":
            return result.outcome.result
        if thrown:
            raise thrown[0]
        message = (
            ERROR_RESULT_MESSAGE if result.outcome.kind == "error_result" else result.outcome.error
        )
        raise GuardedCallFailedError(message)
    if result.status == "replayed":
        return result.result
    if result.status in ("in_doubt", "blocked") and result.doubt is not None:
        raise ActionInDoubt(result.doubt, result.status == "blocked")
    raise GuardedCallFailedError(result.error or f"unexpected guard status {result.status}")


class Guard:
    def __init__(
        self,
        store: LedgerStore,
        clock: Clock,
        run_instance: str,
        evidence: EvidenceSink,
        *,
        human_resolver: HumanResolver | None = None,
        retry_window_ms: int = DEFAULT_RETRY_WINDOW_MS,
        expiry_ms: int = DEFAULT_EXPIRY_MS,
        settle_window_ms: int = DEFAULT_SETTLE_WINDOW_MS,
        store_args: bool = True,
        max_result_bytes: int = DEFAULT_MAX_RESULT_BYTES,
        on_evidence_error: EvidenceErrorHook | None = None,
    ) -> None:
        if settle_window_ms > retry_window_ms:
            raise ValueError(
                f"settle_window_ms ({settle_window_ms}) must not exceed "
                f"retry_window_ms ({retry_window_ms})"
            )
        self._store = store
        self._clock = clock
        self._run_instance = run_instance
        self._evidence = evidence
        self._human_resolver = human_resolver
        self._retry_window_ms = retry_window_ms
        self._expiry_ms = expiry_ms
        self._settle_window_ms = settle_window_ms
        self._store_args = store_args
        self._max_result_bytes = max_result_bytes
        self._on_evidence_error = on_evidence_error or _report_to_stderr
        self._in_flight: dict[str, asyncio.Future[GuardResult]] = {}

    def run(self, call: GuardedCall, execute: Execute) -> GuardResult:
        if call.policy == "pass":
            return GuardResult("passed", outcome=self._invoke_sync(execute, ExecuteContext()))
        flow = self._protected(call, self._identify(call))
        try:
            effect = next(flow)
            while True:
                effect = flow.send(self._perform_sync(effect, execute))
        except StopIteration as stop:
            return cast(GuardResult, stop.value)

    async def arun(self, call: GuardedCall, execute: Execute) -> GuardResult:
        if call.policy == "pass":
            return GuardResult(
                "passed", outcome=await self._invoke_async(execute, ExecuteContext())
            )
        identity = self._identify(call)
        loop = asyncio.get_running_loop()
        joined = self._in_flight.get(identity.hash)
        if joined is not None and joined.get_loop() is loop:
            try:
                return await asyncio.shield(joined)
            except asyncio.CancelledError:
                if not joined.cancelled():
                    raise
            return await self.arun(call, execute)
        shared: asyncio.Future[GuardResult] = loop.create_future()
        self._in_flight[identity.hash] = shared
        try:
            result = await self._drive_async(self._protected(call, identity), execute)
        except Exception as error:
            shared.set_exception(error)
            shared.exception()
            raise
        except BaseException:
            shared.cancel()
            raise
        else:
            shared.set_result(result)
            return result
        finally:
            if self._in_flight.get(identity.hash) is shared:
                del self._in_flight[identity.hash]

    def resolve(
        self, action_id: str, outcome: Literal["happened", "not_happened"], by: ResolvedBy
    ) -> ResolveResult:
        try:
            return self._resolve_in_ledger(action_id, outcome, by)
        except LedgerUnavailableError as error:
            return ResolveResult(False, reason="ledger_unavailable", error=str(error))

    def tool(
        self,
        name: str | None = None,
        *,
        policy: CallPolicy = "guard",
        tool_class: ToolClass = "standard",
        identity_rule: IdentityRule | None = None,
        reconciler: Reconciler | None = None,
        session_key: str | None = None,
        intent_key: str | None = None,
    ) -> Callable[[Callable[P, R]], Callable[P, R]]:
        def decorate(fn: Callable[P, R]) -> Callable[P, R]:
            tool_name = name if name is not None else str(getattr(fn, "__name__", "tool"))
            signature = inspect.signature(fn)
            parameters = list(signature.parameters)
            bound_first = parameters[0] if parameters[:1] in (["self"], ["cls"]) else None

            def call_for(args: tuple[object, ...], kwargs: dict[str, object]) -> GuardedCall:
                bound = signature.bind(*args, **kwargs)
                bound.apply_defaults()
                identity_args = dict(bound.arguments)
                if bound_first is not None:
                    identity_args.pop(bound_first, None)
                session, explicit = _default_session(session_key)
                return GuardedCall(
                    tool=tool_name,
                    args=identity_args,
                    session_key=session,
                    session_explicit=explicit,
                    policy=policy,
                    tool_class=tool_class,
                    intent_key=intent_key,
                    identity_rule=identity_rule,
                    reconciler=reconciler,
                )

            if inspect.iscoroutinefunction(fn):

                @functools.wraps(fn)
                async def async_wrapper(*args: P.args, **kwargs: P.kwargs) -> Any:
                    thrown: list[BaseException] = []

                    async def execute(_context: ExecuteContext) -> ToolOutcome:
                        try:
                            return ToolOutcome.ok(
                                await cast(Awaitable[JsonValue], fn(*args, **kwargs))
                            )
                        except Exception as error:
                            thrown.append(error)
                            return ToolOutcome.transport_error(str(error))

                    return _returned(await self.arun(call_for(args, kwargs), execute), thrown)

                return cast(Callable[P, R], async_wrapper)

            @functools.wraps(fn)
            def sync_wrapper(*args: P.args, **kwargs: P.kwargs) -> R:
                thrown: list[BaseException] = []

                def execute(_context: ExecuteContext) -> ToolOutcome:
                    try:
                        value = fn(*args, **kwargs)
                    except Exception as error:
                        thrown.append(error)
                        return ToolOutcome.transport_error(str(error))
                    if inspect.isawaitable(value):
                        _discard_awaitable(value)
                        return ToolOutcome.not_dispatched(SYNC_EXECUTE_AWAITABLE)
                    return ToolOutcome.ok(cast(JsonValue, value))

                return cast(R, _returned(self.run(call_for(args, kwargs), execute), thrown))

            return sync_wrapper

        return decorate

    def _identify(self, call: GuardedCall) -> _Identity:
        args_json = canonicalize(dict(call.args))
        volatile = DEFAULT_VOLATILE_KEYS if call.volatile_keys is None else call.volatile_keys
        projected = project_args(call.args, call.identity_rule, volatile, call.extra_identity)
        hashed = intent_hash(call.session_key, call.tool, projected, call.intent_key)
        return _Identity(hashed, args_json if self._store_args else None)

    def _invoke_sync(self, execute: Execute, context: ExecuteContext) -> ToolOutcome:
        try:
            value = execute(context)
        except Exception as error:
            return ToolOutcome.transport_error(str(error))
        if inspect.isawaitable(value):
            _discard_awaitable(value)
            return ToolOutcome.not_dispatched(SYNC_EXECUTE_AWAITABLE)
        return _checked_outcome(value)

    async def _invoke_async(self, execute: Execute, context: ExecuteContext) -> ToolOutcome:
        try:
            value: object = execute(context)
            if inspect.isawaitable(value):
                value = await value
        except Exception as error:
            return ToolOutcome.transport_error(str(error))
        return _checked_outcome(value)

    def _perform_sync(self, effect: _Effect, execute: Execute) -> object:
        if isinstance(effect, _Dispatch):
            return self._invoke_sync(execute, effect.context)
        if isinstance(effect, _Reconcile):
            try:
                answer = effect.reconciler(effect.context)
            except Exception as error:
                return ReconcileOutcome.unknown(f"reconciler failed: {error}")
            if inspect.isawaitable(answer):
                _discard_awaitable(answer)
                return ReconcileOutcome.unknown(SYNC_RECONCILER_AWAITABLE)
            return _checked_reconcile(answer)
        if self._human_resolver is None:
            return "unresolved"
        try:
            reply = self._human_resolver.resolve(effect.doubt)
        except Exception:
            return "unresolved"
        if inspect.isawaitable(reply):
            _discard_awaitable(reply)
            return "unresolved"
        return _checked_human(reply)

    async def _perform_async(self, effect: _Effect, execute: Execute) -> object:
        if isinstance(effect, _Dispatch):
            return await self._invoke_async(execute, effect.context)
        if isinstance(effect, _Reconcile):
            try:
                answer: object = effect.reconciler(effect.context)
                if inspect.isawaitable(answer):
                    answer = await answer
            except Exception as error:
                return ReconcileOutcome.unknown(f"reconciler failed: {error}")
            return _checked_reconcile(answer)
        if self._human_resolver is None:
            return "unresolved"
        try:
            reply: object = self._human_resolver.resolve(effect.doubt)
            if inspect.isawaitable(reply):
                reply = await reply
        except Exception:
            return "unresolved"
        return _checked_human(reply)

    async def _drive_async(self, flow: _Flow, execute: Execute) -> GuardResult:
        try:
            effect = next(flow)
            while True:
                effect = flow.send(await self._perform_async(effect, execute))
        except StopIteration as stop:
            return cast(GuardResult, stop.value)

    def _protected(self, call: GuardedCall, identity: _Identity) -> _Flow:
        arrived_ms = self._clock.now_ms()
        verified_seq: int | None = None
        pending: _Resolution | None = None
        while True:
            step = functools.partial(
                self._resolve_and_claim,
                call=call,
                identity=identity,
                arrived_ms=arrived_ms,
                verified_seq=verified_seq,
                pending=pending,
            )
            try:
                claim, resolved = self._store.transact(step)
            except LedgerConflictError:
                continue
            except LedgerUnavailableError as error:
                return _unavailable(error)
            pending = None
            if resolved is not None:
                self._emit_state(resolved)
            self._emit_decision(call, claim)
            if claim.kind == "execute":
                self._emit_state(claim.event)
                dispatched = yield from self._dispatch(call, claim.event)
                if dispatched is not None:
                    return dispatched
            elif claim.kind == "replay":
                return _replayed(claim.event, claim.reason)
            elif claim.kind == "in_doubt":
                handled = yield from self._handle_doubt(call, claim.event, claim.reason)
                if isinstance(handled, GuardResult):
                    return handled
                pending = handled
            else:
                checked = yield from self._reconcile(call, claim.event)
                if checked.outcome == "unknown":
                    verified_seq = claim.event.seq
                else:
                    pending = _Resolution(
                        claim.event, checked.outcome, "reconciler", checked.result
                    )

    def _resolve_and_claim(
        self,
        tx: LedgerTx,
        *,
        call: GuardedCall,
        identity: _Identity,
        arrived_ms: int,
        verified_seq: int | None,
        pending: _Resolution | None,
    ) -> tuple[_Claim, LedgerEvent | None]:
        resolved = None if pending is None else self._apply_resolution(tx, pending)
        return self._decide_and_claim(tx, call, identity, arrived_ms, verified_seq), resolved

    def _decide_and_claim(
        self,
        tx: LedgerTx,
        call: GuardedCall,
        identity: _Identity,
        arrived_ms: int,
        verified_seq: int | None,
    ) -> _Claim:
        policy = cast(GuardPolicy, call.policy)
        latest = tx.latest(identity.hash)
        now_ms = self._clock.now_ms()
        decision = decide(
            latest,
            arrived_ms,
            self._retry_window_ms,
            DecisionCall(
                self._run_instance, call.session_explicit, call.intent_key is not None, policy
            ),
        )
        if decision.kind != "execute":
            assert decision.event is not None
            return _Claim(decision.kind, decision.event, decision.reason)
        needs_verification = (
            decision.reason == "failed_after_window" and call.reconciler is not None
        )
        if latest is not None and needs_verification and latest.seq != verified_seq:
            return _Claim("verify", latest, decision.reason)
        new_action_id = action_id(identity.hash, decision.occurrence, now_ms)
        inherits = latest is not None and decision.reason in INHERITED_KEY_REASONS
        key = _idempotency_key_of(latest) if inherits and latest is not None else new_action_id
        intended = tx.append(
            NewLedgerEvent(
                action_id=new_action_id,
                intent_hash=identity.hash,
                occurrence=decision.occurrence,
                state="intended",
                at_ms=now_ms,
                expires_at_ms=now_ms + self._expiry_ms,
                session_key=call.session_key,
                session_explicit=call.session_explicit,
                intent_key_explicit=call.intent_key is not None,
                run_instance=self._run_instance,
                tool=call.tool,
                tool_class=call.tool_class,
                policy=policy,
                args_json=identity.args_json,
                detail={**_captured_detail(call), "idempotency_key": key},
            )
        )
        return _Claim("execute", intended, decision.reason)

    def _apply_resolution(self, tx: LedgerTx, resolution: _Resolution) -> LedgerEvent | None:
        latest = tx.latest(resolution.event.intent_hash)
        if latest is None or latest.seq != resolution.event.seq:
            return None
        stored = stored_result_detail(resolution.result, self._max_result_bytes)
        detail: dict[str, JsonValue] = {
            "outcome": resolution.outcome,
            "resolved_by": resolution.by,
            **stored,
        }
        return tx.append(self._follow_up(resolution.event, "reconciled", detail))

    def _dispatch(
        self, call: GuardedCall, intended: LedgerEvent
    ) -> Generator[_Effect, object, GuardResult | None]:
        try:
            sent = self._append_if_latest(intended, "sent", _captured_detail(call))
        except LedgerUnavailableError as error:
            return _unavailable(error)
        if sent is None:
            return None
        self._emit_state(sent)
        key = _idempotency_key_of(intended)
        outcome = _checked_outcome((yield _Dispatch(ExecuteContext(intended.action_id, key))))
        recorded = self._record_outcome(call, sent, key, outcome)
        return GuardResult(
            "executed", action_id=intended.action_id, outcome=outcome, recorded=recorded
        )

    def _record_outcome(
        self, call: GuardedCall, sent: LedgerEvent, key: str, outcome: ToolOutcome
    ) -> bool:
        def record(tx: LedgerTx) -> LedgerEvent | None:
            if outcome.kind != "ok":
                latest = tx.latest(sent.intent_hash)
                if latest is None or latest.seq != sent.seq:
                    return None
            state: LedgerState = "confirmed" if outcome.kind == "ok" else "failed"
            return tx.append(self._follow_up(sent, state, self._outcome_detail(call, key, outcome)))

        try:
            recorded = self._store.transact(record)
        except Exception as error:
            self._emit(
                sent.action_id,
                sent.tool,
                sent.session_key,
                "state",
                {
                    "state": "unrecorded",
                    "occurrence": sent.occurrence,
                    "outcome": outcome.kind,
                    "error": str(error),
                },
            )
            return False
        if recorded is None:
            self._emit(
                sent.action_id,
                sent.tool,
                sent.session_key,
                "state",
                {"state": "superseded", "occurrence": sent.occurrence, "outcome": outcome.kind},
            )
        else:
            self._emit_state(recorded)
        return True

    def _outcome_detail(
        self, call: GuardedCall, key: str, outcome: ToolOutcome
    ) -> dict[str, JsonValue]:
        if outcome.kind == "ok":
            delivery = (
                "cancelled" if call.signal is not None and call.signal.is_set() else "delivered"
            )
            return {
                **stored_result_detail(outcome.result, self._max_result_bytes),
                "delivery": delivery,
            }
        if outcome.kind == "error_result":
            stored = stored_result_detail(outcome.result, self._max_result_bytes)
            detail: dict[str, JsonValue] = {
                **_captured_detail(call),
                "failure_kind": "error_result",
                "error": ERROR_RESULT_MESSAGE,
                "result": stored["result"],
            }
            if "result_error" in stored:
                detail["result_error"] = stored["result_error"]
            detail["idempotency_key"] = key
            return detail
        return {
            **_captured_detail(call),
            "failure_kind": outcome.kind,
            "error": outcome.error,
            "result": None,
            "idempotency_key": key,
        }

    def _handle_doubt(
        self, call: GuardedCall, event: LedgerEvent, reason: str
    ) -> Generator[_Effect, object, GuardResult | _Resolution]:
        doubt = DoubtInfo(
            event.action_id, call.tool, call.args, call.tool_class, reason, event.at_ms
        )
        if call.reconciler is not None:
            checked = yield from self._reconcile(call, event)
            if checked.outcome != "unknown":
                return _Resolution(event, checked.outcome, "reconciler", checked.result)
        if call.policy == "guard":
            return GuardResult("in_doubt", doubt=doubt)
        answer = _checked_human((yield _AskHuman(doubt)))
        if answer == "unresolved":
            return GuardResult("blocked", doubt=doubt)
        return _Resolution(event, answer, "human")

    def _reconcile(
        self, call: GuardedCall, event: LedgerEvent
    ) -> Generator[_Effect, object, ReconcileOutcome]:
        assert call.reconciler is not None
        context = ReconcileContext(call.tool, call.args, event.action_id, event)
        outcome = _checked_reconcile((yield _Reconcile(call.reconciler, context)))
        if (
            outcome.outcome == "not_happened"
            and self._clock.now_ms() - event.at_ms < self._settle_window_ms
        ):
            outcome = ReconcileOutcome.unknown("too_soon")
        detail: dict[str, JsonValue] = (
            {"outcome": "unknown", "reason": outcome.reason}
            if outcome.outcome == "unknown"
            else {"outcome": outcome.outcome}
        )
        self._emit(event.action_id, event.tool, event.session_key, "reconcile", detail)
        return outcome

    def _resolve_in_ledger(
        self, target: str, outcome: Literal["happened", "not_happened"], by: ResolvedBy
    ) -> ResolveResult:
        found = self._store.find_action(target)
        if found is None:
            return ResolveResult(False, reason="unknown_action")

        def settle(tx: LedgerTx) -> ResolveResult:
            latest = tx.latest(found.intent_hash)
            now_ms = self._clock.now_ms()
            if latest is None or latest.action_id != target or not _is_unresolved(latest, now_ms):
                return ResolveResult(False, reason="not_in_doubt")
            if by == "agent" and latest.tool_class != "standard":
                return ResolveResult(False, reason="agent_cannot_resolve_class")
            if (
                by == "agent"
                and outcome == "not_happened"
                and now_ms - latest.at_ms < self._settle_window_ms
            ):
                return ResolveResult(False, reason="too_soon")
            detail: dict[str, JsonValue] = {
                "outcome": outcome,
                "resolved_by": by,
                "result": None,
                "result_truncated": False,
            }
            return ResolveResult(
                True, event=tx.append(self._follow_up(latest, "reconciled", detail))
            )

        result = self._store.transact(settle)
        summary: dict[str, JsonValue] = {"outcome": outcome, "by": by, "ok": result.ok}
        if not result.ok:
            summary["reason"] = result.reason
        self._emit(found.action_id, found.tool, found.session_key, "resolve", summary)
        if result.event is not None:
            self._emit_state(result.event)
        return result

    def _append_if_latest(
        self, basis: LedgerEvent, state: LedgerState, detail: dict[str, JsonValue]
    ) -> LedgerEvent | None:
        def append(tx: LedgerTx) -> LedgerEvent | None:
            latest = tx.latest(basis.intent_hash)
            if latest is None or latest.seq != basis.seq:
                return None
            return tx.append(self._follow_up(basis, state, detail))

        return self._store.transact(append)

    def _follow_up(
        self, basis: LedgerEvent, state: LedgerState, detail: dict[str, JsonValue]
    ) -> NewLedgerEvent:
        at_ms = self._clock.now_ms()
        return NewLedgerEvent(
            action_id=basis.action_id,
            intent_hash=basis.intent_hash,
            occurrence=basis.occurrence,
            state=state,
            at_ms=at_ms,
            expires_at_ms=at_ms + self._expiry_ms,
            session_key=basis.session_key,
            session_explicit=basis.session_explicit,
            intent_key_explicit=basis.intent_key_explicit,
            run_instance=self._run_instance,
            tool=basis.tool,
            tool_class=basis.tool_class,
            policy=basis.policy,
            args_json=basis.args_json,
            detail=detail,
        )

    def _emit_decision(self, call: GuardedCall, claim: _Claim) -> None:
        decision = "execute" if claim.kind == "execute" else claim.kind
        self._emit(
            claim.event.action_id,
            call.tool,
            call.session_key,
            "decision",
            {"decision": decision, "reason": claim.reason, "occurrence": claim.event.occurrence},
        )

    def _emit_state(self, event: LedgerEvent) -> None:
        summary = {
            key: value for key, value in event.detail.items() if key not in ("result", "captured")
        }
        self._emit(
            event.action_id,
            event.tool,
            event.session_key,
            "state",
            {"state": event.state, "occurrence": event.occurrence, **summary},
        )

    def _emit(
        self,
        action: str | None,
        tool: str,
        session_key: str,
        kind: EvidenceKind,
        detail: dict[str, JsonValue],
    ) -> None:
        event = EvidenceEvent(
            v=1,
            at_ms=self._clock.now_ms(),
            kind=kind,
            tool=tool,
            session_key=session_key,
            detail=detail,
            action_id=action,
        )
        try:
            self._evidence.emit(event)
        except Exception as error:
            try:
                self._on_evidence_error(error, event)
            except Exception:
                return
