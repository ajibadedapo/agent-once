from __future__ import annotations

import time

import pytest

from agent_once import ManualClock, SystemClock

START = 1_761_912_345_678


def test_now_ms_starts_at_the_given_time_and_moves_only_on_advance() -> None:
    clock = ManualClock(START)
    assert clock.now_ms() == START
    clock.advance(250)
    assert clock.now_ms() == START + 250


def test_timers_fire_in_order_on_advance_and_never_early() -> None:
    clock = ManualClock(START)
    fired: list[tuple[str, int]] = []
    clock.set_timer(300, lambda: fired.append(("c", clock.now_ms())))
    clock.set_timer(100, lambda: fired.append(("a", clock.now_ms())))
    clock.set_timer(200, lambda: fired.append(("b1", clock.now_ms())))
    clock.set_timer(200, lambda: fired.append(("b2", clock.now_ms())))
    clock.advance(99)
    assert fired == []
    clock.advance(150)
    assert fired == [("a", START + 100), ("b1", START + 200), ("b2", START + 200)]
    assert clock.now_ms() == START + 249
    clock.advance(51)
    assert fired[-1] == ("c", START + 300)


def test_a_timer_scheduled_by_a_timer_runs_within_the_same_advance() -> None:
    clock = ManualClock(START)
    fired: list[tuple[str, int]] = []

    def outer() -> None:
        fired.append(("outer", clock.now_ms()))
        clock.set_timer(50, lambda: fired.append(("inner", clock.now_ms())))
        clock.set_timer(500, lambda: fired.append(("late", clock.now_ms())))

    clock.set_timer(100, outer)
    clock.set_timer(120, lambda: fired.append(("middle", clock.now_ms())))
    clock.advance(200)
    assert fired == [("outer", START + 100), ("middle", START + 120), ("inner", START + 150)]


def test_a_cancelled_timer_never_fires_and_zero_delay_waits_for_advance() -> None:
    clock = ManualClock(START)
    fired: list[str] = []
    clock.set_timer(10, lambda: fired.append("cancelled")).cancel()
    clock.set_timer(0, lambda: fired.append("zero"))
    assert fired == []
    clock.advance(0)
    clock.advance(100)
    assert fired == ["zero"]


def test_a_throwing_timer_leaves_the_clock_at_the_target() -> None:
    clock = ManualClock(START)
    later: list[bool] = []

    def boom() -> None:
        raise RuntimeError("boom")

    clock.set_timer(100, boom)
    clock.set_timer(150, lambda: later.append(True))
    with pytest.raises(RuntimeError, match="boom"):
        clock.advance(200)
    assert clock.now_ms() == START + 200
    assert later == []
    clock.advance(0)
    assert later == [True]


def test_advance_rejects_a_negative_duration() -> None:
    with pytest.raises(ValueError):
        ManualClock(START).advance(-1)


def test_system_clock_reads_wall_time_in_ms() -> None:
    before = time.time_ns() // 1_000_000
    now = SystemClock().now_ms()
    assert isinstance(now, int)
    assert before <= now <= time.time_ns() // 1_000_000
