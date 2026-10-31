from __future__ import annotations

import asyncio
import dataclasses
from typing import Any

from harness import START_MS, RecordingSink, guarded_call
from hypothesis import HealthCheck, example, given, settings
from hypothesis import strategies as st

from agent_once import (
    DoubtInfo,
    ExecuteContext,
    Guard,
    GuardResult,
    ManualClock,
    MemoryLedgerStore,
    ReconcileContext,
    ReconcileOutcome,
    ToolOutcome,
)

SETTLE_WINDOW_MS = 10_000
LANDING_DELAY_MS = 4_321
MAX_INTENTS = 3
GUARDS = 2
FAULTS = (
    "none",
    "lost_after_commit",
    "timeout_before_commit",
    "slow_commit_then_land",
    "not_dispatched",
)
PROPERTY_SETTINGS = settings(
    max_examples=300,
    derandomize=True,
    deadline=None,
    suppress_health_check=[HealthCheck.too_slow, HealthCheck.data_too_large],
)

guard_index = st.integers(min_value=0, max_value=GUARDS - 1)
intent_index = st.integers(min_value=0, max_value=MAX_INTENTS - 1)

dispatch_command = st.tuples(
    st.sampled_from(["call", "call", "call", "start", "start"]),
    guard_index,
    intent_index,
    st.sampled_from(FAULTS),
)
release_command = st.tuples(st.just("release"), st.integers(min_value=0, max_value=7))
advance_command = st.tuples(st.just("advance"), st.integers(min_value=0, max_value=200_000))
resolve_command = st.tuples(st.just("resolve"), guard_index, intent_index)
command = st.one_of(
    *(
        [dispatch_command] * 5
        + [release_command] * 2
        + [advance_command] * 2
        + [resolve_command] * 3
    )
)


@dataclasses.dataclass(frozen=True)
class Scenario:
    intents: int
    policy: str
    with_reconciler: bool
    commands: list[tuple[Any, ...]]


def scenarios(with_reconciler: st.SearchStrategy[bool]) -> st.SearchStrategy[Scenario]:
    return st.builds(
        Scenario,
        intents=st.integers(min_value=1, max_value=MAX_INTENTS),
        policy=st.sampled_from(["guard", "block-on-doubt"]),
        with_reconciler=with_reconciler,
        commands=st.integers(min_value=0, max_value=40).flatmap(
            lambda size: st.lists(command, min_size=size, max_size=size)
        ),
    )


def tool_for(intent: int) -> str:
    return f"create_ticket_{intent}"


class Unresolved:
    async def resolve(self, doubt: DoubtInfo) -> str:
        return "unresolved"


@dataclasses.dataclass
class Gated:
    gate: asyncio.Event
    settled: asyncio.Future[None]


class World:
    def __init__(self, scenario: Scenario) -> None:
        self.scenario = scenario
        self.clock = ManualClock(START_MS)
        self.evidence = RecordingSink()
        self.store = MemoryLedgerStore(self.clock)
        self.guards = [
            Guard(
                self.store,
                self.clock,
                f"proc-{index}",
                self.evidence,
                settle_window_ms=SETTLE_WINDOW_MS,
                human_resolver=Unresolved(),
            )
            for index in range(GUARDS)
        ]
        self.effects = [0] * scenario.intents
        self.done = [False] * scenario.intents
        self.doubts: list[str | None] = [None] * scenario.intents
        self.gated: list[Gated] = []
        self.waiting: list[asyncio.Future[None]] = []
        self.in_flight: dict[str, int] = {}

    async def call(self, guard_number: int, intent: int, fault: str, start: bool) -> None:
        guard = self.guards[guard_number % GUARDS]
        key = f"{guard_number}:{intent}"
        gate = asyncio.Event()
        dispatched = asyncio.Event()
        joins_gated = self.in_flight.get(key, 0) > 0
        is_gated = start and not joins_gated
        if is_gated:
            self.in_flight[key] = self.in_flight.get(key, 0) + 1

        async def reconcile(_context: ReconcileContext) -> ReconcileOutcome:
            return self.truth(intent)

        async def execute(_context: ExecuteContext) -> ToolOutcome:
            outcome = self.perform(intent, fault)
            dispatched.set()
            if is_gated:
                await gate.wait()
            return outcome

        call = guarded_call(
            tool=tool_for(intent),
            args={"intent": intent},
            policy=self.scenario.policy,
            reconciler=reconcile if self.scenario.with_reconciler else None,
        )

        async def run() -> None:
            result = await guard.arun(call, execute)
            if is_gated:
                self.in_flight[key] = self.in_flight.get(key, 1) - 1
            self.observe(intent, result)

        settled = asyncio.ensure_future(run())
        if is_gated:
            self.gated.append(Gated(gate, settled))
            waiter = asyncio.ensure_future(dispatched.wait())
            await asyncio.wait({settled, waiter}, return_when=asyncio.FIRST_COMPLETED)
            waiter.cancel()
        elif joins_gated:
            self.waiting.append(settled)
        else:
            await settled

    async def release(self, slot: int) -> None:
        if not self.gated:
            return
        entry = self.gated.pop(slot % len(self.gated))
        entry.gate.set()
        await entry.settled

    async def release_all(self) -> None:
        while self.gated:
            await self.release(0)
        waiting, self.waiting = self.waiting, []
        await asyncio.gather(*waiting)

    def resolve(self, guard_number: int, intent: int) -> None:
        doubt = self.doubts[intent]
        if doubt is None:
            return
        outcome = "happened" if self.truth(intent).outcome == "happened" else "not_happened"
        if not self.guards[guard_number % GUARDS].resolve(doubt, outcome, "agent").ok:
            return
        self.doubts[intent] = None
        if outcome == "happened":
            self.done[intent] = True

    def repeats_decided(self, intent: int) -> int:
        happened: set[int] = set()
        count = 0
        for event in self.evidence.events:
            if event.tool != tool_for(intent):
                continue
            raw_occurrence = event.detail.get("occurrence")
            occurrence = raw_occurrence if isinstance(raw_occurrence, int) else -1
            state = event.detail.get("state")
            if event.kind == "state" and (
                state == "confirmed"
                or (state == "reconciled" and event.detail.get("outcome") == "happened")
            ):
                happened.add(occurrence)
            if event.kind != "decision" or event.detail.get("decision") != "execute":
                continue
            reason = event.detail.get("reason")
            if reason == "deliberate_repeat":
                count += 1
            if reason == "failed_after_window" and occurrence - 1 not in happened:
                count += 1
        return count

    def observe(self, intent: int, result: GuardResult) -> None:
        executed_ok = (
            result.status == "executed"
            and result.outcome is not None
            and result.outcome.kind == "ok"
        )
        if executed_ok or result.status == "replayed":
            self.done[intent] = True
            self.doubts[intent] = None
        if result.status in ("in_doubt", "blocked") and result.doubt is not None:
            self.doubts[intent] = result.doubt.action_id

    def truth(self, intent: int) -> ReconcileOutcome:
        if self.effects[intent] > 0:
            return ReconcileOutcome.happened({"intent": intent})
        return ReconcileOutcome.not_happened()

    def perform(self, intent: int, fault: str) -> ToolOutcome:
        def land() -> None:
            self.effects[intent] += 1

        if fault == "none":
            land()
            return ToolOutcome.ok({"intent": intent})
        if fault == "lost_after_commit":
            land()
            return ToolOutcome.transport_error("connection reset after commit")
        if fault == "timeout_before_commit":
            return ToolOutcome.transport_error("timed out before commit")
        if fault == "slow_commit_then_land":
            self.clock.set_timer(LANDING_DELAY_MS, land)
            return ToolOutcome.transport_error("timed out, commit still in flight")
        return ToolOutcome.not_dispatched("stale element ref")


async def play(world: World, scenario: Scenario, stop_when_done: bool) -> None:
    for step in scenario.commands:
        kind = step[0]
        if kind == "advance":
            world.clock.advance(step[1])
        elif kind == "release":
            await world.release(step[1])
        elif kind == "resolve":
            world.resolve(step[1], step[2] % scenario.intents)
        else:
            intent = step[2] % scenario.intents
            if not (stop_when_done and world.done[intent]):
                await world.call(step[1], intent, step[3], kind == "start")
    await world.release_all()


LATE_FAILURE_AFTER_AGENT_RESOLUTION = Scenario(
    intents=1,
    policy="guard",
    with_reconciler=False,
    commands=[
        ("start", 0, 0, "lost_after_commit"),
        ("advance", 15_000),
        ("call", 1, 0, "none"),
        ("resolve", 1, 0),
        ("release", 0),
        ("advance", 130_000),
        ("call", 0, 0, "none"),
    ],
)


@PROPERTY_SETTINGS
@given(scenarios(st.booleans()))
@example(LATE_FAILURE_AFTER_AGENT_RESOLUTION)
def test_effects_per_intent_never_exceed_one_unless_a_repeat_was_decided(
    scenario: Scenario,
) -> None:
    async def body() -> None:
        world = World(scenario)
        await play(world, scenario, False)
        world.clock.advance(SETTLE_WINDOW_MS)
        for intent in range(scenario.intents):
            assert world.effects[intent] <= 1 + world.repeats_decided(intent)

    asyncio.run(body())


@PROPERTY_SETTINGS
@given(scenarios(st.just(True)))
def test_with_retries_past_the_settle_window_every_intent_ends_with_exactly_one_effect(
    scenario: Scenario,
) -> None:
    async def body() -> None:
        world = World(scenario)
        await play(world, scenario, True)
        for intent in range(scenario.intents):
            attempt = 0
            while attempt < 4 and not world.done[intent]:
                world.clock.advance(SETTLE_WINDOW_MS)
                await world.call(0, intent, "none", False)
                attempt += 1
        world.clock.advance(SETTLE_WINDOW_MS)
        assert world.done == [True] * scenario.intents
        assert world.effects == [1] * scenario.intents

    asyncio.run(body())
