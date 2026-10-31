from __future__ import annotations

import dataclasses
import json
import shutil
import sqlite3
import subprocess
from collections.abc import Callable
from pathlib import Path
from typing import Any, TypeVar

import pytest

from agent_once import (
    DEFAULT_VOLATILE_KEYS,
    DecisionCall,
    EvidenceEvent,
    ExecuteContext,
    Guard,
    GuardedCall,
    LedgerEvent,
    LedgerStore,
    LedgerTx,
    ManualClock,
    SqliteLedgerStore,
    ToolOutcome,
    decide,
    intent_hash,
    project_args,
)

REPO = Path(__file__).resolve().parents[2]
SCRIPT = Path(__file__).resolve().parent / "interop_write.mjs"
DIST = REPO / "packages" / "agent-once" / "dist" / "index.js"
START_MS = 1_761_912_345_678
SCENARIO: dict[str, Any] = {
    "start_ms": START_MS,
    "step_ms": 1_234,
    "read_at_ms": START_MS + 5_678,
    "retry_window_ms": 120_000,
    "session_key": "interop:/work",
    "writer_run_instance": "writer-run",
    "reader_run_instance": "reader-run",
    "confirmed": {
        "tool": "create_ticket",
        "args": {
            "title": "Printer jam",
            "priority": 2,
            "note": "café \U0001f600",
            "ratio": 0.1,
            "nonce": "n-1",
        },
        "tool_class": "standard",
        "policy": "guard",
        "result": {"ticket": "T-1", "big": 1e21, "tiny": 1e-7, "items": [None, True, -0.5]},
    },
    "sent": {
        "tool": "pay_invoice",
        "args": {"invoice": "INV-7", "amount": 12.5},
        "tool_class": "money",
        "policy": "block-on-doubt",
    },
}
NAMES = ("confirmed", "sent")
T = TypeVar("T")


class Silent:
    def emit(self, event: EvidenceEvent) -> None:
        return None


class CrashingAfterDispatch:
    def __init__(self, inner: LedgerStore) -> None:
        self._inner = inner
        self._transactions = 0

    def transact(self, fn: Callable[[LedgerTx], T]) -> T:
        self._transactions += 1
        if self._transactions == 3:
            raise RuntimeError("the process died before recording the outcome")
        return self._inner.transact(fn)

    def find_action(self, action_id: str) -> LedgerEvent | None:
        return self._inner.find_action(action_id)

    def list_in_doubt(self, now_ms: int) -> list[LedgerEvent]:
        return self._inner.list_in_doubt(now_ms)

    def close(self) -> None:
        self._inner.close()


def call_for(name: str) -> GuardedCall:
    spec = SCENARIO[name]
    return GuardedCall(
        tool=spec["tool"],
        args=spec["args"],
        session_key=SCENARIO["session_key"],
        session_explicit=True,
        policy=spec["policy"],
        tool_class=spec["tool_class"],
    )


def hash_for(name: str) -> str:
    call = call_for(name)
    return intent_hash(
        call.session_key, call.tool, project_args(call.args, None, DEFAULT_VOLATILE_KEYS)
    )


def run_node(mode: str, db: Path) -> dict[str, Any]:
    node = shutil.which("node")
    if node is None:
        pytest.fail("the interop test needs Node 22.13 or later on PATH to run the TypeScript core")
    if not DIST.exists():
        pytest.fail(
            f"the TypeScript build is missing at {DIST}; "
            "run npm run build in the repository root first"
        )
    completed = subprocess.run(
        [node, str(SCRIPT), mode, str(db), json.dumps(SCENARIO)],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr
    report: dict[str, Any] = json.loads(completed.stdout)
    return report


def python_write(db: Path) -> None:
    clock = ManualClock(START_MS)
    store = SqliteLedgerStore.open(str(db), clock)
    try:
        writer = Guard(store, clock, SCENARIO["writer_run_instance"], Silent())
        writer.run(
            call_for("confirmed"), lambda _context: ToolOutcome.ok(SCENARIO["confirmed"]["result"])
        )
        clock.advance(SCENARIO["step_ms"])
        crashing = Guard(
            CrashingAfterDispatch(store), clock, SCENARIO["writer_run_instance"], Silent()
        )
        outcome = crashing.run(call_for("sent"), lambda _context: ToolOutcome.ok(None))
        assert outcome.recorded is False
    finally:
        store.close()


def python_report(db: Path) -> dict[str, Any]:
    store = SqliteLedgerStore.open(str(db), ManualClock(SCENARIO["read_at_ms"]))
    try:
        intents: dict[str, Any] = {}
        for name in NAMES:
            hashed = hash_for(name)
            latest = store.transact(lambda tx, hashed=hashed: tx.latest(hashed))
            decision = decide(
                latest,
                SCENARIO["read_at_ms"],
                SCENARIO["retry_window_ms"],
                DecisionCall(
                    run_instance=SCENARIO["reader_run_instance"],
                    session_explicit=True,
                    intent_key_explicit=False,
                    policy=SCENARIO[name]["policy"],
                ),
            )
            intents[name] = {
                "intent_hash": hashed,
                "latest": None if latest is None else dataclasses.asdict(latest),
                "decision": {
                    "kind": decision.kind,
                    "reason": decision.reason,
                    "occurrence": decision.occurrence,
                },
            }
        return intents
    finally:
        store.close()


def python_guard_outcomes(db: Path) -> dict[str, Any]:
    clock = ManualClock(SCENARIO["read_at_ms"])
    store = SqliteLedgerStore.open(str(db), clock)
    dispatched: list[str | None] = []

    def execute(context: ExecuteContext) -> ToolOutcome:
        dispatched.append(context.action_id)
        return ToolOutcome.ok(None)

    try:
        guard = Guard(store, clock, SCENARIO["reader_run_instance"], Silent())
        results: dict[str, Any] = {}
        for name in NAMES:
            result = guard.run(call_for(name), execute)
            reason = (
                result.reason
                if result.reason is not None
                else (result.doubt.reason if result.doubt else None)
            )
            results[name] = {"status": result.status, "reason": reason, "result": result.result}
        return {"results": results, "dispatched": len(dispatched)}
    finally:
        store.close()


EXPECTED_GUARD = {
    "results": {
        "confirmed": {
            "status": "replayed",
            "reason": "replay_rerun_explicit_session",
            "result": SCENARIO["confirmed"]["result"],
        },
        "sent": {"status": "blocked", "reason": "outcome_unknown", "result": None},
    },
    "dispatched": 0,
}


def assert_expected_ledger(report: dict[str, Any]) -> None:
    confirmed = report["confirmed"]
    sent = report["sent"]
    assert confirmed["latest"]["state"] == "confirmed"
    assert confirmed["latest"]["detail"]["result"] == SCENARIO["confirmed"]["result"]
    assert confirmed["decision"] == {
        "kind": "replay",
        "reason": "replay_rerun_explicit_session",
        "occurrence": 0,
    }
    assert sent["latest"]["state"] == "sent"
    assert sent["latest"]["at_ms"] == START_MS + SCENARIO["step_ms"]
    assert sent["decision"] == {"kind": "in_doubt", "reason": "outcome_unknown", "occurrence": 0}


def test_ts_written_ledger_reads_and_decides_identically(tmp_path: Path) -> None:
    db = tmp_path / "ledger.db"
    ts_report = run_node("write", db)
    py_report = python_report(db)
    assert py_report == ts_report["intents"]
    assert_expected_ledger(py_report)
    assert python_guard_outcomes(db) == EXPECTED_GUARD


def test_python_written_ledger_reads_in_ts(tmp_path: Path) -> None:
    db = tmp_path / "ledger.db"
    python_write(db)
    py_report = python_report(db)
    ts_report = run_node("read", db)
    assert ts_report["intents"] == py_report
    assert_expected_ledger(py_report)
    assert ts_report["guard"] == EXPECTED_GUARD


def test_both_cores_write_byte_identical_ledger_rows(tmp_path: Path) -> None:
    ts_db = tmp_path / "ts.db"
    py_db = tmp_path / "py.db"
    run_node("write", ts_db)
    python_write(py_db)
    query = "SELECT * FROM events ORDER BY seq"
    rows = []
    for db in (ts_db, py_db):
        connection = sqlite3.connect(str(db))
        try:
            rows.append(connection.execute(query).fetchall())
        finally:
            connection.close()
    assert rows[0] == rows[1]
    assert len(rows[0]) == 5
