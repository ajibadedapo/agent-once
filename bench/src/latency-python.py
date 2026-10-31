from __future__ import annotations

import argparse
import json
import os
import platform
import sqlite3
import sys
import time

from agent_once import (
    EvidenceEvent,
    ExecuteContext,
    Guard,
    GuardedCall,
    SqliteLedgerStore,
    SystemClock,
    ToolOutcome,
)


class NoEvidence:
    def emit(self, event: EvidenceEvent) -> None:
        return None


def execute(_context: ExecuteContext) -> ToolOutcome:
    return ToolOutcome.ok(None)


def bench_call(index: int) -> GuardedCall:
    return GuardedCall(
        tool="place_order",
        args={"item": "Blue mug", "n": index},
        session_key="bench",
        session_explicit=True,
        policy="guard",
        tool_class="standard",
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--iterations", type=int, required=True)
    parser.add_argument("--warmup", type=int, required=True)
    parser.add_argument("--ledger-dir", required=True)
    options = parser.parse_args()
    clock = SystemClock()
    store = SqliteLedgerStore.open(os.path.join(options.ledger_dir, "python.db"), clock)
    guard = Guard(store, clock, "bench-python", NoEvidence())
    guarded: list[float] = []
    direct: list[float] = []
    try:
        for index in range(options.warmup + options.iterations):
            start = time.perf_counter_ns()
            execute(ExecuteContext())
            middle = time.perf_counter_ns()
            result = guard.run(bench_call(index), execute)
            end = time.perf_counter_ns()
            if result.status != "executed":
                print(f"python benchmark call {index} was {result.status}", file=sys.stderr)
                return 1
            if index < options.warmup:
                continue
            direct.append((middle - start) / 1_000_000)
            guarded.append((end - middle) / 1_000_000)
    finally:
        store.close()
    output = {
        "guarded": guarded,
        "direct": direct,
        "python": platform.python_version(),
        "sqlite": sqlite3.sqlite_version,
    }
    print(json.dumps(output))
    return 0


if __name__ == "__main__":
    sys.exit(main())
