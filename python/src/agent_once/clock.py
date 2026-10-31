from __future__ import annotations

import itertools
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Protocol


class Clock(Protocol):
    def now_ms(self) -> int: ...


class SystemClock:
    def now_ms(self) -> int:
        return time.time_ns() // 1_000_000


@dataclass(eq=False)
class _Timer:
    due_ms: int
    order: int
    fn: Callable[[], None] = field(repr=False)


class TimerHandle:
    def __init__(self, clock: ManualClock, timer: _Timer) -> None:
        self._clock = clock
        self._timer = timer

    def cancel(self) -> None:
        self._clock._pending.discard(self._timer)


class ManualClock:
    def __init__(self, start_ms: int) -> None:
        self._current_ms = start_ms
        self._order = itertools.count()
        self._pending: set[_Timer] = set()

    def now_ms(self) -> int:
        return self._current_ms

    def set_timer(self, ms: int, fn: Callable[[], None]) -> TimerHandle:
        timer = _Timer(self._current_ms + max(0, ms), next(self._order), fn)
        self._pending.add(timer)
        return TimerHandle(self, timer)

    def advance(self, ms: int) -> None:
        if not ms >= 0:
            raise ValueError(f"ManualClock cannot advance by {ms} ms")
        target_ms = self._current_ms + ms
        try:
            timer = self._earliest_due_by(target_ms)
            while timer is not None:
                self._pending.discard(timer)
                self._current_ms = timer.due_ms
                timer.fn()
                timer = self._earliest_due_by(target_ms)
        finally:
            self._current_ms = target_ms

    def _earliest_due_by(self, limit_ms: int) -> _Timer | None:
        due = [timer for timer in self._pending if timer.due_ms <= limit_ms]
        return min(due, key=lambda timer: (timer.due_ms, timer.order), default=None)
