from __future__ import annotations

import asyncio
import dataclasses
import math
import threading
from collections.abc import Awaitable, Callable
from typing import Any

import pytest
from harness import START_MS, RecordingSink, RecordingStore, Scripted, guarded_call

from agent_once import (
    DEFAULT_VOLATILE_KEYS,
    ActionInDoubt,
    CanonicalizationError,
    DoubtInfo,
    EvidenceEvent,
    ExecuteContext,
    Guard,
    GuardedCallFailedError,
    GuardResult,
    LedgerEvent,
    ManualClock,
    MemoryLedgerStore,
    ReconcileContext,
    ReconcileOutcome,
    SqliteLedgerStore,
    ToolOutcome,
    action_id,
    intent_hash,
    project_args,
)

OK = ToolOutcome.ok({"ticket": "T-1"})
TRANSPORT = ToolOutcome.transport_error("upstream closed the connection")


@dataclasses.dataclass
class Setup:
    clock: ManualClock
    ledger: RecordingStore
    evidence: RecordingSink
    guard: Guard


def setup(**options: Any) -> Setup:
    clock = ManualClock(START_MS)
    ledger = RecordingStore(MemoryLedgerStore(clock))
    evidence = RecordingSink()
    guard = Guard(ledger, clock, "run-1", evidence, **options)
    return Setup(clock, ledger, evidence, guard)


def expect_status(result: GuardResult, status: str) -> GuardResult:
    assert result.status == status, result
    return result


class HumanAnswering:
    def __init__(self, answer: str) -> None:
        self.answer = answer
        self.asked: list[DoubtInfo] = []

    def resolve(self, doubt: DoubtInfo) -> str:
        self.asked.append(doubt)
        return self.answer


class ThrowingStore:
    def transact(self, fn: Any) -> Any:
        raise AssertionError("the ledger must not be touched")

    def find_action(self, action_id: str) -> LedgerEvent | None:
        raise AssertionError("the ledger must not be touched")

    def list_in_doubt(self, now_ms: int) -> list[LedgerEvent]:
        raise AssertionError("the ledger must not be touched")

    def close(self) -> None:
        return None


def reconciler_returning(
    outcome: ReconcileOutcome, seen: list[str] | None = None
) -> Callable[[ReconcileContext], ReconcileOutcome]:
    def reconcile(context: ReconcileContext) -> ReconcileOutcome:
        if seen is not None:
            seen.append(context.action_id)
        return outcome

    return reconcile


def test_executes_a_new_action_once_and_records_intended_sent_confirmed() -> None:
    s = setup()
    tool = Scripted(OK)
    call = guarded_call()
    result = expect_status(s.guard.run(call, tool.execute), "executed")
    hashed = intent_hash(
        call.session_key, call.tool, project_args(call.args, None, DEFAULT_VOLATILE_KEYS)
    )
    assert result.action_id == action_id(hashed, 0, START_MS)
    assert result.outcome == OK
    assert result.recorded is True
    assert tool.calls == [result.action_id]
    assert tool.keys == [result.action_id]
    assert s.ledger.states() == ["intended", "sent", "confirmed"]
    assert s.ledger.last().detail == {
        "result": {"ticket": "T-1"},
        "result_truncated": False,
        "delivery": "delivered",
    }
    assert s.ledger.last().args_json == '{"priority":2,"title":"Printer jam"}'


def test_records_the_captured_value_on_intended_and_sent() -> None:
    s = setup()
    result = s.guard.run(guarded_call(captured="ORD-1001"), Scripted(OK).execute)
    assert [event.detail for event in s.ledger.appended[:2]] == [
        {"captured": "ORD-1001", "idempotency_key": result.action_id},
        {"captured": "ORD-1001", "idempotency_key": result.action_id},
    ]


def test_a_failed_outcome_repeats_the_captured_value() -> None:
    s = setup()
    result = s.guard.run(guarded_call(captured="ORD-1001"), Scripted(TRANSPORT).execute)
    assert s.ledger.last().detail == {
        "captured": "ORD-1001",
        "failure_kind": "transport_error",
        "error": "upstream closed the connection",
        "result": None,
        "idempotency_key": result.action_id,
    }


def test_store_args_false_keeps_args_out_of_the_ledger() -> None:
    s = setup(store_args=False)
    s.guard.run(guarded_call(), Scripted(OK).execute)
    assert all(event.args_json is None for event in s.ledger.appended)


def test_a_retry_after_a_transport_error_within_the_window_is_in_doubt() -> None:
    s = setup()
    tool = Scripted(TRANSPORT, OK)
    first = expect_status(s.guard.run(guarded_call(), tool.execute), "executed")
    assert first.outcome == TRANSPORT
    assert s.ledger.last().detail == {
        "failure_kind": "transport_error",
        "error": "upstream closed the connection",
        "result": None,
        "idempotency_key": first.action_id,
    }
    s.clock.advance(119_999)
    second = expect_status(s.guard.run(guarded_call(), tool.execute), "in_doubt")
    assert second.doubt == DoubtInfo(
        action_id=first.action_id or "",
        tool="create_ticket",
        args={"title": "Printer jam", "priority": 2},
        tool_class="standard",
        reason="failed_within_window",
        since_ms=START_MS,
    )
    assert len(tool.calls) == 1


def test_a_retry_after_the_window_executes_a_new_occurrence() -> None:
    s = setup()
    tool = Scripted(TRANSPORT, OK)
    first = s.guard.run(guarded_call(), tool.execute)
    s.clock.advance(120_000)
    second = expect_status(s.guard.run(guarded_call(), tool.execute), "executed")
    assert second.action_id != first.action_id
    assert (s.ledger.last().occurrence, s.ledger.last().state) == (1, "confirmed")
    assert len(tool.calls) == 2


def test_an_error_result_is_recorded_as_failed_with_its_result() -> None:
    s = setup()
    outcome = ToolOutcome.error_result({"isError": True, "text": "card declined"})
    result = s.guard.run(guarded_call(), Scripted(outcome).execute)
    assert s.ledger.last().detail == {
        "failure_kind": "error_result",
        "error": "the tool returned an error result",
        "result": {"isError": True, "text": "card declined"},
        "idempotency_key": result.action_id,
    }


def test_not_dispatched_allows_an_immediate_retry() -> None:
    s = setup()
    tool = Scripted(ToolOutcome.not_dispatched("stale element ref"), OK)
    s.guard.run(guarded_call(), tool.execute)
    second = expect_status(s.guard.run(guarded_call(), tool.execute), "executed")
    assert second.outcome == OK
    assert len(tool.calls) == 2
    assert s.ledger.last().occurrence == 1


def test_execute_raising_is_a_transport_error() -> None:
    s = setup()

    def boom(_context: ExecuteContext) -> ToolOutcome:
        raise ConnectionError("socket hang up")

    result = expect_status(s.guard.run(guarded_call(), boom), "executed")
    assert result.outcome == ToolOutcome.transport_error("socket hang up")
    assert s.ledger.last().detail["failure_kind"] == "transport_error"
    assert s.guard.run(guarded_call(), Scripted(OK).execute).status == "in_doubt"


def test_an_async_execute_passed_to_run_is_not_dispatched() -> None:
    s = setup()
    tool = Scripted(OK)
    result = expect_status(s.guard.run(guarded_call(), tool.aexecute), "executed")
    assert result.outcome is not None and result.outcome.kind == "not_dispatched"
    assert "arun" in result.outcome.error
    assert s.ledger.last().detail["failure_kind"] == "not_dispatched"
    assert expect_status(s.guard.run(guarded_call(), tool.execute), "executed").outcome == OK


def test_reconciler_happened_turns_doubt_into_a_replay_without_dispatch() -> None:
    s = setup()
    tool = Scripted(TRANSPORT, OK)
    first = s.guard.run(guarded_call(), tool.execute)
    seen: list[str] = []
    reconciler = reconciler_returning(ReconcileOutcome.happened({"ticket": "T-9"}), seen)
    second = s.guard.run(guarded_call(reconciler=reconciler), tool.execute)
    assert second == GuardResult(
        status="replayed",
        action_id=first.action_id,
        result={"ticket": "T-9"},
        result_truncated=False,
        reason="replay_undelivered",
    )
    assert seen == [first.action_id]
    assert len(tool.calls) == 1
    assert s.ledger.last().detail == {
        "outcome": "happened",
        "resolved_by": "reconciler",
        "result": {"ticket": "T-9"},
        "result_truncated": False,
    }


def test_reconciler_not_happened_inside_the_settle_window_is_unknown() -> None:
    s = setup()
    tool = Scripted(TRANSPORT, OK)
    s.guard.run(guarded_call(), tool.execute)
    s.clock.advance(9_999)
    reconciler = reconciler_returning(ReconcileOutcome.not_happened())
    second = expect_status(
        s.guard.run(guarded_call(reconciler=reconciler), tool.execute), "in_doubt"
    )
    assert second.doubt is not None and second.doubt.reason == "failed_within_window"
    assert len(tool.calls) == 1
    assert s.ledger.states() == ["intended", "sent", "failed"]
    assert s.evidence.of_kind("reconcile")[-1].detail == {
        "outcome": "unknown",
        "reason": "too_soon",
    }


def test_reconciler_not_happened_after_the_settle_window_dispatches_once() -> None:
    s = setup()
    tool = Scripted(TRANSPORT, OK)
    s.guard.run(guarded_call(), tool.execute)
    s.clock.advance(10_000)
    reconciler = reconciler_returning(ReconcileOutcome.not_happened())
    second = expect_status(
        s.guard.run(guarded_call(reconciler=reconciler), tool.execute), "executed"
    )
    assert second.outcome == OK
    assert len(tool.calls) == 2
    assert s.ledger.states() == [
        "intended",
        "sent",
        "failed",
        "reconciled",
        "intended",
        "sent",
        "confirmed",
    ]
    assert s.ledger.appended[3].detail == {
        "outcome": "not_happened",
        "resolved_by": "reconciler",
        "result": None,
        "result_truncated": False,
    }
    assert s.ledger.last().occurrence == 1


def test_the_settle_window_runs_from_the_latest_in_doubt_event() -> None:
    s = setup()
    tool = Scripted(TRANSPORT, OK)
    s.guard.run(guarded_call(), tool.execute)
    s.clock.advance(5_000)
    s.ledger.inner.transact(
        lambda tx: tx.append(dataclasses.replace(s.ledger.last(), at_ms=s.clock.now_ms()))
    )
    s.clock.advance(5_000)
    reconciler = reconciler_returning(ReconcileOutcome.not_happened())
    assert s.guard.run(guarded_call(reconciler=reconciler), tool.execute).status == "in_doubt"
    s.clock.advance(5_000)
    assert s.guard.run(guarded_call(reconciler=reconciler), tool.execute).status == "executed"


def test_a_reconciler_that_raises_or_returns_garbage_is_unknown() -> None:
    s = setup()
    tool = Scripted(TRANSPORT, OK)
    s.guard.run(guarded_call(), tool.execute)

    def broken(_context: ReconcileContext) -> ReconcileOutcome:
        raise RuntimeError("status endpoint down")

    def garbage(_context: ReconcileContext) -> Any:
        return "happened"

    assert s.guard.run(guarded_call(reconciler=broken), tool.execute).status == "in_doubt"
    assert s.evidence.of_kind("reconcile")[-1].detail == {
        "outcome": "unknown",
        "reason": "reconciler failed: status endpoint down",
    }
    assert s.guard.run(guarded_call(reconciler=garbage), tool.execute).status == "in_doubt"
    assert s.evidence.of_kind("reconcile")[-1].detail == {
        "outcome": "unknown",
        "reason": "invalid reconciler outcome",
    }
    assert len(tool.calls) == 1


def test_an_async_reconciler_under_run_is_unknown() -> None:
    s = setup()
    tool = Scripted(TRANSPORT, OK)
    s.guard.run(guarded_call(), tool.execute)

    async def reconcile(_context: ReconcileContext) -> ReconcileOutcome:
        return ReconcileOutcome.happened()

    assert s.guard.run(guarded_call(reconciler=reconcile), tool.execute).status == "in_doubt"
    assert "arun" in str(s.evidence.of_kind("reconcile")[-1].detail["reason"])


def test_a_failed_action_past_the_window_asks_the_reconciler_before_repeating() -> None:
    s = setup()
    tool = Scripted(TRANSPORT, OK)
    s.guard.run(guarded_call(), tool.execute)
    s.clock.advance(120_000)
    reconciler = reconciler_returning(ReconcileOutcome.happened({"ticket": "T-1"}))
    assert s.guard.run(guarded_call(reconciler=reconciler), tool.execute).status == "replayed"
    assert len(tool.calls) == 1


def test_a_failed_action_past_the_window_repeats_when_the_reconciler_cannot_tell() -> None:
    s = setup()
    tool = Scripted(TRANSPORT, OK)
    s.guard.run(guarded_call(), tool.execute)
    s.clock.advance(120_000)
    reconciler = reconciler_returning(ReconcileOutcome.unknown("no status endpoint"))
    assert s.guard.run(guarded_call(reconciler=reconciler), tool.execute).status == "executed"
    assert len(tool.calls) == 2


def test_block_on_doubt_asks_the_human_and_blocks_when_unresolved() -> None:
    human = HumanAnswering("unresolved")
    s = setup(human_resolver=human)
    call = guarded_call(policy="block-on-doubt", tool_class="money")
    tool = Scripted(TRANSPORT, OK)
    first = s.guard.run(call, tool.execute)
    second = expect_status(s.guard.run(call, tool.execute), "blocked")
    assert second.doubt is not None
    assert (second.doubt.action_id, second.doubt.tool_class, second.doubt.reason) == (
        first.action_id,
        "money",
        "failed_block_on_doubt",
    )
    assert human.asked == [second.doubt]
    assert len(tool.calls) == 1


def test_block_on_doubt_without_a_human_resolver_blocks() -> None:
    s = setup()
    call = guarded_call(policy="block-on-doubt", tool_class="money")
    tool = Scripted(TRANSPORT, OK)
    s.guard.run(call, tool.execute)
    assert s.guard.run(call, tool.execute).status == "blocked"


def test_human_happened_replays_and_records_reconciled_by_human() -> None:
    s = setup(human_resolver=HumanAnswering("happened"))
    call = guarded_call(policy="block-on-doubt", tool_class="irreversible")
    tool = Scripted(TRANSPORT, OK)
    first = s.guard.run(call, tool.execute)
    second = expect_status(s.guard.run(call, tool.execute), "replayed")
    assert (second.action_id, second.result, second.result_truncated) == (
        first.action_id,
        None,
        False,
    )
    assert s.ledger.last().detail == {
        "outcome": "happened",
        "resolved_by": "human",
        "result": None,
        "result_truncated": False,
    }
    assert len(tool.calls) == 1


def test_human_not_happened_executes_the_next_occurrence() -> None:
    s = setup(human_resolver=HumanAnswering("not_happened"))
    call = guarded_call(policy="block-on-doubt", tool_class="money")
    tool = Scripted(TRANSPORT, OK)
    s.guard.run(call, tool.execute)
    assert s.guard.run(call, tool.execute).status == "executed"
    assert len(tool.calls) == 2


def test_a_human_resolver_that_raises_leaves_the_call_blocked() -> None:
    class Broken:
        def resolve(self, doubt: DoubtInfo) -> str:
            raise RuntimeError("webhook down")

    s = setup(human_resolver=Broken())
    call = guarded_call(policy="block-on-doubt", tool_class="money")
    tool = Scripted(TRANSPORT, OK)
    s.guard.run(call, tool.execute)
    assert s.guard.run(call, tool.execute).status == "blocked"


def test_two_concurrent_identical_aruns_dispatch_once_and_share_the_outcome() -> None:
    async def scenario() -> None:
        s = setup()
        gate = asyncio.Event()
        dispatched: list[int] = []

        entered = asyncio.Event()

        async def execute(_context: ExecuteContext) -> ToolOutcome:
            dispatched.append(1)
            entered.set()
            await gate.wait()
            return OK

        first = asyncio.ensure_future(s.guard.arun(guarded_call(), execute))
        second = asyncio.ensure_future(s.guard.arun(guarded_call(), execute))
        await entered.wait()
        gate.set()
        a, b = await asyncio.gather(first, second)
        assert len(dispatched) == 1
        assert a == b
        assert a.status == "executed" and a.outcome == OK
        assert s.ledger.states() == ["intended", "sent", "confirmed"]

    asyncio.run(scenario())


def test_arun_with_async_reconciler_and_human() -> None:
    class AsyncHuman:
        async def resolve(self, doubt: DoubtInfo) -> str:
            return "not_happened"

    async def scenario() -> None:
        s = setup(human_resolver=AsyncHuman())
        tool = Scripted(TRANSPORT, OK)
        call = guarded_call(policy="block-on-doubt", tool_class="money")
        await s.guard.arun(call, tool.aexecute)

        async def unknown(_context: ReconcileContext) -> ReconcileOutcome:
            return ReconcileOutcome.unknown("no status endpoint")

        result = await s.guard.arun(dataclasses.replace(call, reconciler=unknown), tool.aexecute)
        assert result.status == "executed" and result.outcome == OK
        assert len(tool.calls) == 2

    asyncio.run(scenario())


def test_a_call_whose_client_went_away_records_delivery_cancelled_and_the_retry_replays() -> None:
    s = setup()
    cancelled = threading.Event()
    tool = Scripted(OK)

    def execute(context: ExecuteContext) -> ToolOutcome:
        cancelled.set()
        return tool.execute(context)

    assert s.guard.run(guarded_call(signal=cancelled), execute).status == "executed"
    assert s.ledger.last().detail["delivery"] == "cancelled"
    retry = expect_status(s.guard.run(guarded_call(), tool.execute), "replayed")
    assert (retry.result, retry.reason) == ({"ticket": "T-1"}, "replay_undelivered")
    assert len(tool.calls) == 1


def test_pass_policy_dispatches_without_touching_the_ledger() -> None:
    clock = ManualClock(START_MS)
    guard = Guard(ThrowingStore(), clock, "run-1", RecordingSink())
    tool = Scripted(OK)
    result = guard.run(guarded_call(policy="pass"), tool.execute)
    assert result == GuardResult(status="passed", outcome=OK)
    assert tool.calls == [None]
    assert tool.keys == [None]


def test_a_result_over_max_result_bytes_is_stored_truncated() -> None:
    s = setup(max_result_bytes=64)
    big = ToolOutcome.ok({"image": "x" * 100})
    call = guarded_call(intent_key="screenshot-1")
    first = s.guard.run(call, Scripted(big).execute)
    assert first.outcome == big
    assert s.ledger.last().detail == {
        "result": None,
        "result_truncated": True,
        "delivery": "delivered",
    }
    replay = expect_status(s.guard.run(call, Scripted(OK).execute), "replayed")
    assert (replay.result, replay.result_truncated, replay.reason) == (
        None,
        True,
        "replay_explicit_intent",
    )


def test_a_result_exactly_at_max_result_bytes_is_kept() -> None:
    s = setup(max_result_bytes=13)
    s.guard.run(guarded_call(), Scripted(ToolOutcome.ok({"a": "xxxxx"})).execute)
    assert s.ledger.last().detail["result"] == {"a": "xxxxx"}
    assert s.ledger.last().detail["result_truncated"] is False


def test_non_finite_args_raise_without_dispatch_or_ledger_access() -> None:
    s = setup()
    tool = Scripted(OK)
    with pytest.raises(CanonicalizationError):
        s.guard.run(guarded_call(args={"amount": math.nan}), tool.execute)
    with pytest.raises(CanonicalizationError):
        s.guard.run(guarded_call(args={"nested": {"ts": math.inf}}), tool.execute)
    assert tool.calls == []
    assert s.ledger.transaction_count == 0


def test_an_unavailable_ledger_returns_ledger_unavailable_without_dispatch() -> None:
    clock = ManualClock(START_MS)
    store = MemoryLedgerStore(clock)
    store.close()
    guard = Guard(store, clock, "run-1", RecordingSink())
    tool = Scripted(OK)
    result = expect_status(guard.run(guarded_call(), tool.execute), "ledger_unavailable")
    assert result.error == "agent-once ledger unavailable: the ledger is closed"
    assert tool.calls == []


def test_a_resolution_that_lands_between_claim_and_send_is_honoured() -> None:
    s = setup()
    tool = Scripted(OK)

    def interfere() -> None:
        intended = next((event for event in s.ledger.appended if event.state == "intended"), None)
        if intended is None or s.ledger.transaction_count != 2:
            return
        s.ledger.inner.transact(
            lambda tx: tx.append(
                dataclasses.replace(
                    intended,
                    state="reconciled",
                    detail={"outcome": "not_happened", "resolved_by": "human", "result": None},
                )
            )
        )

    s.ledger.before_transact = interfere
    result = s.guard.run(guarded_call(), tool.execute)
    assert tool.calls == [result.action_id]
    assert (s.ledger.last().occurrence, s.ledger.last().state) == (1, "confirmed")


def test_the_outcome_is_returned_when_recording_it_fails_and_the_action_stays_in_doubt() -> None:
    s = setup()
    tool = Scripted(OK)

    def fail_third() -> None:
        if s.ledger.transaction_count == 3:
            raise OSError("disk full")

    s.ledger.before_transact = fail_third
    result = s.guard.run(guarded_call(), tool.execute)
    assert (result.status, result.outcome, result.recorded) == ("executed", OK, False)
    s.ledger.before_transact = None
    assert s.guard.run(guarded_call(), tool.execute).status == "in_doubt"
    assert len(tool.calls) == 1


class FailingSink:
    def __init__(self, error: Exception) -> None:
        self.error = error

    def emit(self, event: EvidenceEvent) -> None:
        raise self.error


def test_evidence_sink_failures_reach_on_evidence_error() -> None:
    clock = ManualClock(START_MS)
    failure = OSError("evidence disk full")
    seen: list[tuple[BaseException, str]] = []
    guard = Guard(
        MemoryLedgerStore(clock),
        clock,
        "run-1",
        FailingSink(failure),
        on_evidence_error=lambda error, event: seen.append((error, event.kind)),
    )
    result = guard.run(guarded_call(), Scripted(OK).execute)
    assert (result.status, result.outcome) == ("executed", OK)
    assert [kind for _, kind in seen] == ["decision", "state", "state", "state"]
    assert all(error is failure for error, _ in seen)


def test_a_raising_on_evidence_error_never_loses_the_outcome() -> None:
    clock = ManualClock(START_MS)

    def explode(_error: BaseException, _event: EvidenceEvent) -> None:
        raise RuntimeError("hook broke")

    guard = Guard(
        MemoryLedgerStore(clock),
        clock,
        "run-1",
        FailingSink(OSError("x")),
        on_evidence_error=explode,
    )
    assert guard.run(guarded_call(), Scripted(OK).execute).outcome == OK


def test_evidence_sink_failures_go_to_stderr_by_default(capsys: pytest.CaptureFixture[str]) -> None:
    clock = ManualClock(START_MS)
    guard = Guard(
        MemoryLedgerStore(clock), clock, "run-1", FailingSink(OSError("evidence disk full"))
    )
    guard.run(guarded_call(), Scripted(OK).execute)
    assert "agent-once: evidence sink failed: evidence disk full\n" in capsys.readouterr().err


def test_emits_decision_and_state_evidence_with_v_1() -> None:
    s = setup()
    result = s.guard.run(guarded_call(), Scripted(OK).execute)
    assert [
        (event.kind, event.detail.get("decision", event.detail.get("state")))
        for event in s.evidence.events
    ] == [
        ("decision", "execute"),
        ("state", "intended"),
        ("state", "sent"),
        ("state", "confirmed"),
    ]
    assert s.evidence.events[0] == EvidenceEvent(
        v=1,
        at_ms=START_MS,
        kind="decision",
        action_id=result.action_id,
        tool="create_ticket",
        session_key="client:/work",
        detail={"decision": "execute", "reason": "new", "occurrence": 0},
    )


def test_a_late_retry_after_the_window_reuses_the_idempotency_key() -> None:
    s = setup()
    tool = Scripted(TRANSPORT, TRANSPORT, OK)
    first = s.guard.run(guarded_call(), tool.execute)
    s.clock.advance(120_000)
    s.guard.run(guarded_call(), tool.execute)
    s.clock.advance(120_000)
    s.guard.run(guarded_call(), tool.execute)
    assert len(set(tool.calls)) == 3
    assert tool.keys == [first.action_id] * 3


def test_a_retry_after_not_dispatched_reuses_the_idempotency_key() -> None:
    s = setup()
    tool = Scripted(ToolOutcome.not_dispatched("stale ref"), OK)
    first = s.guard.run(guarded_call(), tool.execute)
    s.guard.run(guarded_call(), tool.execute)
    assert tool.keys == [first.action_id] * 2


def test_a_late_retry_the_reconciler_cannot_settle_reuses_the_idempotency_key() -> None:
    s = setup()
    tool = Scripted(TRANSPORT, OK)
    first = s.guard.run(guarded_call(), tool.execute)
    s.clock.advance(120_000)
    reconciler = reconciler_returning(ReconcileOutcome.unknown("no status endpoint"))
    s.guard.run(guarded_call(reconciler=reconciler), tool.execute)
    assert tool.keys == [first.action_id] * 2


def test_the_sent_event_of_a_late_retry_repeats_the_inherited_key() -> None:
    s = setup()
    tool = Scripted(TRANSPORT, OK)
    first = s.guard.run(guarded_call(), tool.execute)
    s.clock.advance(120_000)
    reconciler = reconciler_returning(ReconcileOutcome.unknown("no status endpoint"))
    s.guard.run(guarded_call(reconciler=reconciler), tool.execute)
    sent = [event for event in s.ledger.appended if event.state == "sent" and event.occurrence == 1]
    assert len(sent) == 1
    assert sent[0].action_id != first.action_id
    assert sent[0].detail == {"idempotency_key": first.action_id}


def test_a_deliberate_repeat_and_a_reconciled_not_happened_get_fresh_keys() -> None:
    s = setup()
    tool = Scripted(OK, TRANSPORT, OK)
    s.guard.run(guarded_call(), tool.execute)
    s.guard.run(guarded_call(), tool.execute)
    s.clock.advance(10_000)
    s.guard.run(
        guarded_call(reconciler=reconciler_returning(ReconcileOutcome.not_happened())), tool.execute
    )
    assert tool.keys == tool.calls
    assert len(set(tool.keys)) == 3


def test_a_settle_window_longer_than_the_retry_window_is_rejected() -> None:
    clock = ManualClock(START_MS)
    with pytest.raises(ValueError):
        Guard(
            MemoryLedgerStore(clock),
            clock,
            "run-1",
            RecordingSink(),
            retry_window_ms=5_000,
            settle_window_ms=5_001,
        )


def in_doubt(tool_class: str) -> tuple[Setup, str]:
    s = setup()
    first = s.guard.run(
        guarded_call(tool_class=tool_class, tool=f"tool_{tool_class}"), Scripted(TRANSPORT).execute
    )
    return s, first.action_id or ""


@pytest.mark.parametrize("tool_class", ["money", "irreversible"])
def test_resolve_by_agent_refuses_money_and_irreversible(tool_class: str) -> None:
    s, ident = in_doubt(tool_class)
    s.clock.advance(10_000)
    assert s.guard.resolve(ident, "happened", "agent").reason == "agent_cannot_resolve_class"
    assert s.guard.resolve(ident, "not_happened", "agent").reason == "agent_cannot_resolve_class"
    assert s.guard.resolve(ident, "happened", "human").ok is True


def test_resolve_by_agent_happened_is_accepted_and_the_next_call_replays() -> None:
    s, ident = in_doubt("standard")
    resolved = s.guard.resolve(ident, "happened", "agent")
    assert resolved.ok is True and resolved.event is not None
    assert resolved.event.state == "reconciled"
    assert resolved.event.detail == {
        "outcome": "happened",
        "resolved_by": "agent",
        "result": None,
        "result_truncated": False,
    }
    assert s.evidence.of_kind("resolve")[-1].detail == {
        "outcome": "happened",
        "by": "agent",
        "ok": True,
    }
    tool = Scripted(OK)
    assert s.guard.run(guarded_call(tool="tool_standard"), tool.execute).status == "replayed"
    assert tool.calls == []


def test_resolve_not_happened_by_agent_inside_the_settle_window_is_too_soon() -> None:
    s, ident = in_doubt("standard")
    s.clock.advance(9_999)
    refused = s.guard.resolve(ident, "not_happened", "agent")
    assert (refused.ok, refused.reason) == (False, "too_soon")
    s.clock.advance(1)
    assert s.guard.resolve(ident, "not_happened", "agent").ok is True
    tool = Scripted(OK)
    assert s.guard.run(guarded_call(tool="tool_standard"), tool.execute).status == "executed"
    assert len(tool.calls) == 1


def test_humans_and_webhooks_resolve_not_happened_at_once() -> None:
    s, ident = in_doubt("money")
    assert s.guard.resolve(ident, "not_happened", "webhook").ok is True


def test_unknown_and_settled_actions_are_refused() -> None:
    s, ident = in_doubt("standard")
    assert (
        s.guard.resolve("ao_000000000000000000000000", "happened", "human").reason
        == "unknown_action"
    )
    assert s.guard.resolve(ident, "happened", "human").ok is True
    assert s.guard.resolve(ident, "happened", "human").reason == "not_in_doubt"


def test_a_not_dispatched_failure_is_not_in_doubt() -> None:
    s = setup()
    first = s.guard.run(guarded_call(), Scripted(ToolOutcome.not_dispatched("stale ref")).execute)
    assert s.guard.resolve(first.action_id or "", "happened", "human").reason == "not_in_doubt"


def test_resolve_reports_an_unavailable_ledger_as_a_result() -> None:
    clock = ManualClock(START_MS)
    store = MemoryLedgerStore(clock)
    store.close()
    guard = Guard(store, clock, "run-1", RecordingSink())
    refused = guard.resolve("ao_000000000000000000000000", "happened", "human")
    assert (refused.ok, refused.reason, refused.error) == (
        False,
        "ledger_unavailable",
        "agent-once ledger unavailable: the ledger is closed",
    )


def test_decorator_dedupes_sync_and_async() -> None:
    s = setup()
    calls: list[str] = []

    @s.guard.tool(intent_key="ticket-a")
    def create_ticket(title: str, priority: int = 2) -> dict[str, Any]:
        calls.append(title)
        return {"ticket": title, "priority": priority}

    @s.guard.tool(name="create_ticket_async", intent_key="ticket-b")
    async def create_ticket_async(title: str) -> dict[str, Any]:
        calls.append(title)
        return {"ticket": title}

    assert create_ticket("a") == {"ticket": "a", "priority": 2}
    assert create_ticket("a") == {"ticket": "a", "priority": 2}
    assert asyncio.run(create_ticket_async("b")) == {"ticket": "b"}
    assert asyncio.run(create_ticket_async("b")) == {"ticket": "b"}
    assert calls == ["a", "b"]
    assert create_ticket.__name__ == "create_ticket"
    tools = {event.tool for event in s.ledger.appended}
    assert tools == {"create_ticket", "create_ticket_async"}


def test_decorator_without_an_intent_key_hashes_bound_arguments() -> None:
    s = setup()
    calls: list[int] = []

    @s.guard.tool(session_key="mandate-7")
    def charge(amount: int, currency: str = "GBP") -> str:
        calls.append(amount)
        return f"charged {amount}"

    charge(5)
    event = s.ledger.last()
    assert event.args_json == '{"amount":5,"currency":"GBP"}'
    assert (event.session_key, event.session_explicit, event.tool_class) == (
        "mandate-7",
        True,
        "standard",
    )
    other = Guard(s.ledger, s.clock, "run-2", RecordingSink())
    charge_again = other.tool(name="charge", session_key="mandate-7")(
        lambda amount, currency="GBP": calls.append(-1)
    )
    assert charge_again(amount=5) == "charged 5"
    assert calls == [5]


def test_decorator_raises_action_in_doubt_and_rethrows_the_tool_error() -> None:
    s = setup()
    failure = ConnectionError("socket hang up")

    @s.guard.tool()
    def create_ticket(title: str) -> None:
        raise failure

    with pytest.raises(ConnectionError) as first:
        create_ticket("a")
    assert first.value is failure
    with pytest.raises(ActionInDoubt) as doubt:
        create_ticket("a")
    assert doubt.value.blocked is False
    assert doubt.value.doubt.reason == "failed_within_window"

    @s.guard.tool(policy="block-on-doubt", tool_class="money")
    async def pay(n: int) -> None:
        raise failure

    with pytest.raises(ConnectionError):
        asyncio.run(pay(1))
    with pytest.raises(ActionInDoubt) as blocked:
        asyncio.run(pay(1))
    assert blocked.value.blocked is True
    assert "blocked" in str(blocked.value)


def test_decorator_reports_an_unavailable_ledger() -> None:
    clock = ManualClock(START_MS)
    store = MemoryLedgerStore(clock)
    store.close()
    guard = Guard(store, clock, "run-1", RecordingSink())

    @guard.tool()
    def create_ticket(title: str) -> str:
        return title

    with pytest.raises(GuardedCallFailedError, match="ledger unavailable"):
        create_ticket("a")


def gated() -> tuple[asyncio.Event, asyncio.Event]:
    return asyncio.Event(), asyncio.Event()


def two_guards() -> tuple[ManualClock, RecordingStore, Guard, Guard]:
    clock = ManualClock(START_MS)
    store = RecordingStore(MemoryLedgerStore(clock))
    return (
        clock,
        store,
        Guard(store, clock, "proc-a", RecordingSink()),
        Guard(store, clock, "proc-b", RecordingSink()),
    )


def blocking(
    gate: asyncio.Event, dispatched: asyncio.Event, outcome: ToolOutcome, effects: list[int]
) -> Callable[[ExecuteContext], Awaitable[ToolOutcome]]:
    async def execute(_context: ExecuteContext) -> ToolOutcome:
        effects.append(1)
        dispatched.set()
        await gate.wait()
        return outcome

    return execute


def test_a_late_failed_outcome_never_overwrites_a_resolution_made_meanwhile() -> None:
    async def scenario() -> None:
        clock, store, a, b = two_guards()
        call = guarded_call(session_explicit=True)
        effects: list[int] = []
        gate, dispatched = gated()
        in_flight = asyncio.ensure_future(
            a.arun(call, blocking(gate, dispatched, TRANSPORT, effects))
        )
        await dispatched.wait()
        clock.advance(15_000)
        doubt = expect_status(await b.arun(call, Scripted(OK).aexecute), "in_doubt")
        assert doubt.doubt is not None
        assert b.resolve(doubt.doubt.action_id, "happened", "agent").ok is True
        gate.set()
        assert (await in_flight).status == "executed"
        assert (store.last().state, store.last().detail["outcome"]) == ("reconciled", "happened")
        clock.advance(120_000)

        async def again(_context: ExecuteContext) -> ToolOutcome:
            effects.append(1)
            return OK

        assert (await a.arun(call, again)).status == "replayed"
        assert len(effects) == 1

    asyncio.run(scenario())


def test_a_slow_human_answer_never_becomes_a_repeat_when_another_process_resolved() -> None:
    async def scenario() -> None:
        clock = ManualClock(START_MS)
        store = MemoryLedgerStore(clock)
        answer: asyncio.Future[str] = asyncio.get_running_loop().create_future()
        asked = asyncio.Event()

        class SlowHuman:
            async def resolve(self, doubt: DoubtInfo) -> str:
                asked.set()
                return await answer

        a = Guard(store, clock, "proc-a", RecordingSink())
        b = Guard(store, clock, "proc-b", RecordingSink(), human_resolver=SlowHuman())
        call = guarded_call(policy="block-on-doubt", tool_class="money")
        tool = Scripted(TRANSPORT, OK)
        first = await a.arun(call, tool.aexecute)
        clock.advance(1_000)
        waiting = asyncio.ensure_future(b.arun(call, tool.aexecute))
        await asked.wait()
        assert a.resolve(first.action_id or "", "happened", "human").ok is True
        clock.advance(200_000)
        answer.set_result("happened")
        assert (await waiting).status == "replayed"
        assert len(tool.calls) == 1

    asyncio.run(scenario())


def test_a_late_confirmed_outcome_is_always_recorded() -> None:
    async def scenario() -> None:
        clock, store, a, b = two_guards()
        call = guarded_call(session_explicit=True)
        gate, dispatched = gated()
        in_flight = asyncio.ensure_future(a.arun(call, blocking(gate, dispatched, OK, [])))
        await dispatched.wait()
        clock.advance(15_000)
        doubt = await b.arun(call, Scripted(OK).aexecute)
        assert doubt.doubt is not None
        assert b.resolve(doubt.doubt.action_id, "happened", "agent").ok is True
        gate.set()
        await in_flight
        assert (store.last().state, store.last().detail["result"]) == (
            "confirmed",
            {"ticket": "T-1"},
        )

    asyncio.run(scenario())


def test_a_reconciled_result_over_max_result_bytes_replays_as_truncated() -> None:
    s = setup(max_result_bytes=64)
    tool = Scripted(TRANSPORT, OK)
    s.guard.run(guarded_call(), tool.execute)
    reconciler = reconciler_returning(ReconcileOutcome.happened({"image": "x" * 100}))
    replay = expect_status(
        s.guard.run(guarded_call(reconciler=reconciler), tool.execute), "replayed"
    )
    assert (replay.result, replay.result_truncated) == (None, True)
    assert s.ledger.last().detail == {
        "outcome": "happened",
        "resolved_by": "reconciler",
        "result": None,
        "result_truncated": True,
    }


def test_a_result_that_cannot_be_canonicalized_is_a_result_error_not_truncated() -> None:
    s = setup()
    outcome = ToolOutcome.ok({"ratio": math.nan})
    result = s.guard.run(guarded_call(), Scripted(outcome).execute)
    assert result.outcome is outcome
    assert s.ledger.last().detail == {
        "result": None,
        "result_truncated": False,
        "result_error": "cannot canonicalize the non-finite number NaN at $.ratio",
        "delivery": "delivered",
    }


class Abort(BaseException):
    pass


def test_a_cancelled_leader_leaves_its_joiner_with_the_ledger_answer() -> None:
    async def scenario() -> None:
        s = setup()
        entered = asyncio.Event()
        dispatched: list[int] = []

        async def execute(_context: ExecuteContext) -> ToolOutcome:
            dispatched.append(1)
            entered.set()
            await asyncio.Event().wait()
            return OK

        leader = asyncio.ensure_future(s.guard.arun(guarded_call(), execute))
        joiner = asyncio.ensure_future(s.guard.arun(guarded_call(), execute))
        await entered.wait()
        leader.cancel()
        joined = await joiner
        assert (joined.status, joined.doubt and joined.doubt.reason) == (
            "in_doubt",
            "outcome_unknown",
        )
        with pytest.raises(asyncio.CancelledError):
            await leader
        assert len(dispatched) == 1
        assert s.guard._in_flight == {}

    asyncio.run(scenario())


def test_a_leader_aborting_during_dispatch_leaves_its_joiner_in_doubt() -> None:
    async def scenario() -> None:
        s = setup()
        entered = asyncio.Event()
        release = asyncio.Event()

        async def execute(_context: ExecuteContext) -> ToolOutcome:
            entered.set()
            await release.wait()
            raise Abort()

        leader = asyncio.ensure_future(s.guard.arun(guarded_call(), execute))
        joiner = asyncio.ensure_future(s.guard.arun(guarded_call(), execute))
        await entered.wait()
        release.set()
        with pytest.raises(Abort):
            await leader
        assert (await joiner).status == "in_doubt"
        assert s.guard._in_flight == {}

    asyncio.run(scenario())


def test_a_leader_raising_an_error_passes_it_to_its_joiner() -> None:
    async def scenario() -> None:
        s = setup()
        entered = asyncio.Event()
        release = asyncio.Event()

        async def execute(_context: ExecuteContext) -> ToolOutcome:
            entered.set()
            await release.wait()
            return OK

        def broken_store() -> None:
            if s.ledger.transaction_count == 3:
                raise_unexpected()

        s.ledger.before_transact = broken_store
        leader = asyncio.ensure_future(s.guard.arun(guarded_call(), execute))
        joiner = asyncio.ensure_future(s.guard.arun(guarded_call(), execute))
        await entered.wait()
        release.set()
        leader_result = await leader
        assert leader_result.recorded is False
        assert await joiner is leader_result
        assert s.guard._in_flight == {}

    asyncio.run(scenario())


def raise_unexpected() -> None:
    raise RuntimeError("unexpected store failure")


def test_decorating_a_callable_that_returns_an_awaitable_records_not_dispatched() -> None:
    s = setup()
    ran: list[str] = []

    class AsyncCallable:
        async def __call__(self, title: str) -> str:
            ran.append(title)
            return title

    create = s.guard.tool(name="create_ticket")(AsyncCallable())
    with pytest.raises(GuardedCallFailedError, match="arun"):
        create("a")
    assert ran == []
    assert s.ledger.last().state == "failed"
    assert s.ledger.last().detail["failure_kind"] == "not_dispatched"


def test_decorated_methods_leave_self_out_of_the_identity() -> None:
    s = setup()

    class Tickets:
        def __init__(self, prefix: str) -> None:
            self.prefix = prefix

        @s.guard.tool(name="create_ticket")
        def create(self, title: str) -> str:
            return self.prefix + title

        @classmethod
        @s.guard.tool(name="create_ticket_cls")
        def create_cls(cls, title: str) -> str:
            return title

    assert Tickets("T-").create("a") == "T-a"
    assert s.ledger.last().args_json == '{"title":"a"}'
    assert Tickets.create_cls("b") == "b"
    assert s.ledger.last().args_json == '{"title":"b"}'


@pytest.mark.parametrize("kind", ["memory", "sqlite"])
def test_a_guarded_call_from_a_worker_thread_works(kind: str, tmp_path: Any) -> None:
    clock = ManualClock(START_MS)
    store = (
        MemoryLedgerStore(clock)
        if kind == "memory"
        else SqliteLedgerStore.open(str(tmp_path / "ledger.db"), clock)
    )
    guard = Guard(store, clock, "run-1", RecordingSink())
    results: list[GuardResult] = []
    worker = threading.Thread(
        target=lambda: results.append(guard.run(guarded_call(), Scripted(OK).execute))
    )
    worker.start()
    worker.join(timeout=30)
    store.close()
    assert [result.status for result in results] == ["executed"]


@pytest.mark.parametrize("kind", ["memory", "sqlite"])
def test_two_threads_racing_one_intent_dispatch_exactly_once(kind: str, tmp_path: Any) -> None:
    clock = ManualClock(START_MS)
    store = (
        MemoryLedgerStore(clock)
        if kind == "memory"
        else SqliteLedgerStore.open(str(tmp_path / "ledger.db"), clock)
    )
    guard = Guard(store, clock, "run-1", RecordingSink())
    entered = threading.Event()
    second_done = threading.Event()
    dispatched: list[str | None] = []
    results: dict[str, GuardResult] = {}

    def execute(context: ExecuteContext) -> ToolOutcome:
        dispatched.append(context.action_id)
        entered.set()
        second_done.wait(timeout=30)
        return OK

    first = threading.Thread(
        target=lambda: results.update(first=guard.run(guarded_call(), execute))
    )
    first.start()
    assert entered.wait(timeout=30)
    second = threading.Thread(
        target=lambda: results.update(second=guard.run(guarded_call(), execute))
    )
    second.start()
    second.join(timeout=30)
    second_done.set()
    first.join(timeout=30)
    store.close()
    assert len(dispatched) == 1
    assert results["first"].status == "executed"
    assert results["second"].status == "in_doubt"


def test_a_store_serialises_transactions_across_threads() -> None:
    clock = ManualClock(START_MS)
    store = MemoryLedgerStore(clock)
    inside = threading.Event()
    release = threading.Event()
    order: list[str] = []

    def hold(_tx: Any) -> None:
        order.append("first-start")
        inside.set()
        release.wait(timeout=30)
        order.append("first-end")

    holder = threading.Thread(target=lambda: store.transact(hold))
    holder.start()
    assert inside.wait(timeout=30)
    contender = threading.Thread(target=lambda: store.transact(lambda _tx: order.append("second")))
    contender.start()
    release.set()
    holder.join(timeout=30)
    contender.join(timeout=30)
    assert order == ["first-start", "first-end", "second"]
