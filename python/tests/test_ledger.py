from __future__ import annotations

import os
import sqlite3
import stat
import sys
from collections.abc import Callable, Generator, Iterator
from pathlib import Path
from typing import Any

import pytest
from harness import EXPIRY_MS, START_MS, new_event

from agent_once import (
    LedgerConflictError,
    LedgerSchemaTooNewError,
    LedgerStore,
    LedgerUnavailableError,
    LedgerUsageError,
    ManualClock,
    MemoryLedgerStore,
    SqliteLedgerStore,
    canonicalize,
    default_ledger_path,
)
from agent_once import sqlite_store as sqlite_module

SPEC_SQL = Path(__file__).resolve().parents[2] / "spec" / "ledger-v1.sql"

OpenStore = Callable[..., LedgerStore]


@pytest.fixture(params=["memory", "sqlite"])
def open_store(request: pytest.FixtureRequest, tmp_path: Path) -> Iterator[OpenStore]:
    opened: list[LedgerStore] = []

    def factory(clock: ManualClock | None = None) -> LedgerStore:
        chosen = clock or ManualClock(START_MS)
        store: LedgerStore
        if request.param == "memory":
            store = MemoryLedgerStore(chosen)
        else:
            store = SqliteLedgerStore.open(str(tmp_path / "ledger.db"), chosen)
        opened.append(store)
        return store

    yield factory
    for store in opened:
        store.close()


@pytest.fixture
def sqlite_open(tmp_path: Path) -> Iterator[Callable[..., SqliteLedgerStore]]:
    opened: list[SqliteLedgerStore] = []

    def factory(
        path: Path | None = None, clock: ManualClock | None = None, **options: Any
    ) -> SqliteLedgerStore:
        store = SqliteLedgerStore.open(
            str(path or tmp_path / "ledger.db"), clock or ManualClock(START_MS), **options
        )
        opened.append(store)
        return store

    yield factory
    for store in opened:
        store.close()


def raw_query(path: Path, sql: str) -> list[tuple[Any, ...]]:
    connection = sqlite3.connect(str(path))
    try:
        return connection.execute(sql).fetchall()
    finally:
        connection.close()


def raw_exec(path: Path, sql: str) -> None:
    connection = sqlite3.connect(str(path), isolation_level=None)
    try:
        connection.execute(sql)
    finally:
        connection.close()


def test_latest_returns_the_highest_occurrences_newest_event(open_store: OpenStore) -> None:
    ledger = open_store()

    def fill(tx: Any) -> None:
        tx.append(new_event(occurrence=0, state="intended", action_id="ao_a0"))
        tx.append(new_event(occurrence=0, state="sent", action_id="ao_a0", at_ms=START_MS + 1))
        tx.append(new_event(occurrence=0, state="confirmed", action_id="ao_a0", at_ms=START_MS + 2))
        tx.append(new_event(occurrence=1, state="intended", action_id="ao_a1", at_ms=START_MS + 3))
        tx.append(new_event(occurrence=1, state="sent", action_id="ao_a1", at_ms=START_MS + 4))
        tx.append(
            new_event(intent_hash="b" * 64, occurrence=5, action_id="ao_b5", at_ms=START_MS + 5)
        )

    ledger.transact(fill)
    latest = ledger.transact(lambda tx: tx.latest("a" * 64))
    assert latest is not None
    assert (latest.occurrence, latest.state, latest.action_id, latest.at_ms) == (
        1,
        "sent",
        "ao_a1",
        START_MS + 4,
    )
    assert ledger.transact(lambda tx: tx.latest("c" * 64)) is None


def test_latest_still_returns_an_expired_latest_event(open_store: OpenStore) -> None:
    clock = ManualClock(START_MS)
    ledger = open_store(clock)

    def fill(tx: Any) -> None:
        tx.append(new_event(action_id="ao_a0", expires_at_ms=START_MS + 10))
        tx.append(
            new_event(
                state="failed", action_id="ao_a0", at_ms=START_MS + 1, expires_at_ms=START_MS + 11
            )
        )

    ledger.transact(fill)
    clock.advance(1_000)
    latest = ledger.transact(lambda tx: tx.latest("a" * 64))
    assert latest is not None
    assert (latest.state, latest.expires_at_ms) == ("failed", START_MS + 11)
    with pytest.raises(LedgerConflictError):
        ledger.transact(
            lambda tx: tx.append(new_event(action_id="ao_reused", at_ms=clock.now_ms()))
        )


def test_append_is_visible_to_latest_in_the_same_transaction(open_store: OpenStore) -> None:
    ledger = open_store()

    def body(tx: Any) -> tuple[Any, Any, Any]:
        before = tx.latest("a" * 64)
        appended = tx.append(new_event())
        return before, appended, tx.latest("a" * 64)

    before, appended, after = ledger.transact(body)
    assert before is None
    assert after == appended
    assert appended.seq > 0


def test_appends_get_increasing_seq_numbers(open_store: OpenStore) -> None:
    ledger = open_store()
    first, second = ledger.transact(
        lambda tx: (tx.append(new_event()), tx.append(new_event(state="sent", at_ms=START_MS + 1)))
    )
    assert second.seq > first.seq


def test_a_second_intended_for_the_same_occurrence_raises(open_store: OpenStore) -> None:
    ledger = open_store()
    ledger.transact(lambda tx: tx.append(new_event()))
    with pytest.raises(LedgerConflictError) as caught:
        ledger.transact(lambda tx: tx.append(new_event(action_id="ao_other", at_ms=START_MS + 7)))
    assert (caught.value.intent_hash, caught.value.occurrence) == ("a" * 64, 0)
    ledger.transact(lambda tx: tx.append(new_event(occurrence=1, action_id="ao_next")))
    ledger.transact(lambda tx: tx.append(new_event(state="sent")))


def test_a_raising_transaction_rolls_back_its_appends(open_store: OpenStore) -> None:
    ledger = open_store()

    def body(tx: Any) -> None:
        tx.append(new_event())
        raise RuntimeError("decide failed")

    with pytest.raises(RuntimeError, match="decide failed"):
        ledger.transact(body)
    assert ledger.transact(lambda tx: tx.latest("a" * 64)) is None
    assert ledger.find_action("ao_000000000000000000000001") is None


def test_a_nested_transact_is_rejected_and_the_outer_rolls_back(open_store: OpenStore) -> None:
    ledger = open_store()
    nested: list[BaseException] = []

    def body(tx: Any) -> None:
        tx.append(new_event())
        try:
            ledger.transact(lambda inner: inner.latest("a" * 64))
        except Exception as error:
            nested.append(error)
            raise

    with pytest.raises(LedgerUsageError):
        ledger.transact(body)
    assert isinstance(nested[0], LedgerUsageError)
    assert not isinstance(nested[0], LedgerUnavailableError)
    assert ledger.find_action("ao_000000000000000000000001") is None
    assert ledger.transact(lambda tx: tx.append(new_event())).state == "intended"


class CustomAwaitable:
    def __await__(self) -> Generator[Any, None, str]:
        yield None
        return "late"


async def later() -> str:
    return "late"


@pytest.mark.parametrize("make_result", [later, CustomAwaitable], ids=["coroutine", "awaitable"])
def test_a_callback_returning_an_awaitable_is_rejected_after_rolling_back(
    open_store: OpenStore, make_result: Callable[[], Any]
) -> None:
    ledger = open_store()

    def body(tx: Any) -> Any:
        tx.append(new_event())
        return make_result()

    with pytest.raises(TypeError, match="synchronous"):
        ledger.transact(body)
    assert ledger.find_action("ao_000000000000000000000001") is None
    assert ledger.transact(lambda tx: tx.append(new_event())).state == "intended"


def test_find_action_returns_the_newest_event_for_an_action_id(open_store: OpenStore) -> None:
    ledger = open_store()

    def fill(tx: Any) -> None:
        tx.append(new_event(action_id="ao_x"))
        tx.append(new_event(action_id="ao_x", state="sent", at_ms=START_MS + 1))
        tx.append(new_event(action_id="ao_y", occurrence=1, at_ms=START_MS + 2))

    ledger.transact(fill)
    found = ledger.find_action("ao_x")
    assert found is not None and (found.state, found.at_ms) == ("sent", START_MS + 1)
    other = ledger.find_action("ao_y")
    assert other is not None and (other.state, other.occurrence) == ("intended", 1)
    assert ledger.find_action("ao_missing") is None


def test_list_in_doubt_returns_the_unexpired_latest_event_of_each_intent_that_resolve_accepts(
    open_store: OpenStore,
) -> None:
    ledger = open_store()
    now = START_MS + 1_000

    def fill(tx: Any) -> None:
        tx.append(new_event(intent_hash="1" * 64, action_id="ao_intended"))
        tx.append(new_event(intent_hash="2" * 64, action_id="ao_sent"))
        tx.append(
            new_event(intent_hash="2" * 64, action_id="ao_sent", state="sent", at_ms=START_MS + 1)
        )
        tx.append(new_event(intent_hash="3" * 64, action_id="ao_done"))
        tx.append(
            new_event(intent_hash="3" * 64, action_id="ao_done", state="sent", at_ms=START_MS + 2)
        )
        tx.append(
            new_event(
                intent_hash="3" * 64,
                action_id="ao_done",
                state="confirmed",
                at_ms=START_MS + 3,
                detail={"result": None, "result_truncated": False, "delivery": "delivered"},
            )
        )
        tx.append(new_event(intent_hash="4" * 64, action_id="ao_expired", expires_at_ms=now))
        for action_id, intent, kind in [
            ("ao_failed", "5", "error_result"),
            ("ao_not_dispatched", "6", "not_dispatched"),
            ("ao_superseded", "7", "transport_error"),
        ]:
            tx.append(new_event(intent_hash=intent * 64, action_id=action_id))
            tx.append(
                new_event(
                    intent_hash=intent * 64,
                    action_id=action_id,
                    state="failed",
                    at_ms=START_MS + 4,
                    detail={"failure_kind": kind, "error": "HTTP 504", "result": None},
                )
            )
        tx.append(
            new_event(intent_hash="7" * 64, action_id="ao_retry", occurrence=1, at_ms=START_MS + 5)
        )
        tx.append(
            new_event(
                intent_hash="7" * 64,
                action_id="ao_retry",
                occurrence=1,
                state="confirmed",
                at_ms=START_MS + 6,
                detail={"result": None, "result_truncated": False, "delivery": "delivered"},
            )
        )

    ledger.transact(fill)
    assert [(event.action_id, event.state) for event in ledger.list_in_doubt(now)] == [
        ("ao_intended", "intended"),
        ("ao_sent", "sent"),
        ("ao_failed", "failed"),
    ]


def test_events_round_trip_every_field(open_store: OpenStore) -> None:
    ledger = open_store()
    event = new_event(
        session_explicit=True,
        intent_key_explicit=True,
        tool_class="irreversible",
        policy="guard",
        args_json=None,
        state="reconciled",
        detail={
            "outcome": "happened",
            "resolved_by": "human",
            "result": {"ok": True, "ids": [1, 2.5, "x"]},
        },
    )
    stored = ledger.transact(lambda tx: tx.append(event))
    for name in (
        "action_id",
        "intent_hash",
        "occurrence",
        "state",
        "at_ms",
        "expires_at_ms",
        "session_key",
        "session_explicit",
        "intent_key_explicit",
        "run_instance",
        "tool",
        "tool_class",
        "policy",
        "args_json",
        "detail",
    ):
        assert getattr(stored, name) == getattr(event, name)
    assert ledger.find_action(event.action_id) == stored


def test_a_stored_event_is_not_changed_by_mutating_the_appended_input(
    open_store: OpenStore,
) -> None:
    ledger = open_store()
    event = new_event(detail={"captured": "ORD-1"})
    ledger.transact(lambda tx: tx.append(event))
    event.detail["captured"] = "ORD-2"
    found = ledger.find_action(event.action_id)
    assert found is not None and found.detail == {"captured": "ORD-1"}


def test_a_closed_store_is_unavailable(open_store: OpenStore) -> None:
    ledger = open_store()
    ledger.close()
    ledger.close()
    with pytest.raises(LedgerUnavailableError, match="the ledger is closed"):
        ledger.transact(lambda tx: tx.append(new_event()))
    with pytest.raises(LedgerUnavailableError):
        ledger.find_action("ao_x")
    with pytest.raises(LedgerUnavailableError):
        ledger.list_in_doubt(START_MS)


def test_the_embedded_schema_is_the_spec_sql_verbatim() -> None:
    assert sqlite_module.LEDGER_V1_SQL == SPEC_SQL.read_text(encoding="utf-8")


def test_uses_wal_synchronous_normal_and_a_5000_ms_busy_timeout(
    sqlite_open: Callable[..., SqliteLedgerStore], tmp_path: Path
) -> None:
    settings = sqlite_open().settings()
    assert (settings.journal_mode, settings.synchronous, settings.busy_timeout_ms) == (
        "wal",
        1,
        5000,
    )
    assert raw_query(tmp_path / "ledger.db", "PRAGMA journal_mode") == [("wal",)]


def test_creates_the_schema_and_a_missing_parent_directory(
    sqlite_open: Callable[..., SqliteLedgerStore], tmp_path: Path
) -> None:
    path = tmp_path / "nested" / "home" / "ledger.db"
    sqlite_open(path)
    assert raw_query(path, "SELECT value FROM meta WHERE key = 'schema_version'") == [("1",)]


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX file modes")
def test_creates_the_home_0o700_and_the_database_wal_and_shm_files_0o600(
    sqlite_open: Callable[..., SqliteLedgerStore], tmp_path: Path
) -> None:
    home = tmp_path / "home"
    path = home / "ledger.db"
    store = sqlite_open(path)
    store.transact(lambda tx: tx.append(new_event(intent_hash="7" * 64)))
    assert stat.S_IMODE(home.stat().st_mode) == 0o700
    for file in (path, Path(f"{path}-wal"), Path(f"{path}-shm")):
        assert file.exists()
        assert stat.S_IMODE(file.stat().st_mode) == 0o600


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX file modes")
def test_keeps_an_existing_stricter_directory_mode(
    sqlite_open: Callable[..., SqliteLedgerStore], tmp_path: Path
) -> None:
    home = tmp_path / "home"
    sqlite_open(home / "ledger.db").close()
    home.chmod(0o300)
    try:
        sqlite_open(home / "ledger.db").close()
        mode = stat.S_IMODE(home.stat().st_mode)
    finally:
        home.chmod(0o700)
    assert mode == 0o300


def test_prunes_expired_rows_on_open(
    sqlite_open: Callable[..., SqliteLedgerStore], tmp_path: Path
) -> None:
    first = sqlite_open()

    def fill(tx: Any) -> None:
        tx.append(new_event(intent_hash="1" * 64, expires_at_ms=START_MS + 100))
        tx.append(new_event(intent_hash="2" * 64, expires_at_ms=START_MS + 200))
        tx.append(new_event(intent_hash="3" * 64, expires_at_ms=START_MS + 201))

    first.transact(fill)
    first.close()
    sqlite_open(clock=ManualClock(START_MS + 200))
    assert raw_query(tmp_path / "ledger.db", "SELECT intent_hash FROM events ORDER BY seq") == [
        ("2" * 64,),
        ("3" * 64,),
    ]


def test_a_fully_pruned_intent_can_claim_occurrence_0_again(
    sqlite_open: Callable[..., SqliteLedgerStore],
) -> None:
    sqlite_open().transact(lambda tx: tx.append(new_event(action_id="ao_old")))
    later = sqlite_open(clock=ManualClock(START_MS + EXPIRY_MS + 1))

    def claim(tx: Any) -> Any:
        assert tx.latest("a" * 64) is None
        return tx.append(new_event(action_id="ao_new", at_ms=START_MS + EXPIRY_MS + 1))

    claimed = later.transact(claim)
    assert (claimed.action_id, claimed.occurrence) == ("ao_new", 0)


def test_refuses_a_newer_schema_version_without_modifying_the_file(
    sqlite_open: Callable[..., SqliteLedgerStore], tmp_path: Path
) -> None:
    path = tmp_path / "ledger.db"
    sqlite_open().close()
    raw_exec(path, "UPDATE meta SET value = '7' WHERE key = 'schema_version'")
    before = path.read_bytes()
    with pytest.raises(LedgerSchemaTooNewError) as caught:
        sqlite_open(clock=ManualClock(START_MS + EXPIRY_MS * 3))
    assert isinstance(caught.value, LedgerUnavailableError)
    assert caught.value.found == 7
    assert "schema_version 7" in str(caught.value)
    assert path.read_bytes() == before


@pytest.mark.parametrize(
    "sql",
    [
        "DELETE FROM meta WHERE key = 'schema_version'",
        "UPDATE meta SET value = '1.5' WHERE key = 'schema_version'",
        "UPDATE meta SET value = '' WHERE key = 'schema_version'",
        "UPDATE meta SET value = '0' WHERE key = 'schema_version'",
    ],
    ids=["missing", "non-integer", "empty", "zero"],
)
def test_a_bad_schema_version_fails_closed_and_is_not_a_newer_schema(
    sqlite_open: Callable[..., SqliteLedgerStore], tmp_path: Path, sql: str
) -> None:
    sqlite_open().close()
    raw_exec(tmp_path / "ledger.db", sql)
    with pytest.raises(LedgerUnavailableError) as caught:
        sqlite_open()
    assert not isinstance(caught.value, LedgerSchemaTooNewError)
    assert "agent-once ledger unavailable" in str(caught.value)


def test_a_database_with_other_tables_but_no_meta_is_unavailable(
    sqlite_open: Callable[..., SqliteLedgerStore], tmp_path: Path
) -> None:
    path = tmp_path / "other.db"
    raw_exec(path, "CREATE TABLE unrelated (id INTEGER)")
    with pytest.raises(LedgerUnavailableError):
        sqlite_open(path)
    assert raw_query(path, "SELECT name FROM sqlite_master WHERE type = 'table'") == [
        ("unrelated",)
    ]


def test_two_store_handles_on_one_file(
    sqlite_open: Callable[..., SqliteLedgerStore], tmp_path: Path
) -> None:
    first = sqlite_open()
    second = sqlite_open()
    first.transact(lambda tx: tx.append(new_event(action_id="ao_first")))
    seen = second.transact(lambda tx: tx.latest("a" * 64))
    assert seen is not None and (seen.action_id, seen.state) == ("ao_first", "intended")
    with pytest.raises(LedgerConflictError):
        second.transact(lambda tx: tx.append(new_event(action_id="ao_second", at_ms=START_MS + 1)))
    assert raw_query(tmp_path / "ledger.db", "SELECT action_id FROM events") == [("ao_first",)]


def test_transact_holds_the_write_lock_from_its_first_statement(
    sqlite_open: Callable[..., SqliteLedgerStore], tmp_path: Path
) -> None:
    store = sqlite_open()
    competitor = sqlite3.connect(str(tmp_path / "ledger.db"), isolation_level=None, timeout=0)
    try:

        def body(_tx: Any) -> None:
            with pytest.raises(sqlite3.OperationalError, match="locked|busy"):
                competitor.execute("BEGIN IMMEDIATE")

        store.transact(body)
        competitor.execute("BEGIN IMMEDIATE")
        competitor.execute("ROLLBACK")
    finally:
        competitor.close()


class WriteLock:
    def __init__(self, path: Path) -> None:
        self._connection = sqlite3.connect(str(path), isolation_level=None)
        self._connection.execute("BEGIN IMMEDIATE")

    def release(self) -> None:
        self._connection.execute("ROLLBACK")
        self._connection.close()


def test_busy_timeout_defaults_to_5000_and_accepts_an_override(
    sqlite_open: Callable[..., SqliteLedgerStore],
) -> None:
    assert sqlite_open().settings().busy_timeout_ms == 5000
    assert sqlite_open(busy_timeout_ms=0).settings().busy_timeout_ms == 0
    for bad in (-1, 1.5, True):
        with pytest.raises(ValueError):
            sqlite_open(busy_timeout_ms=bad)


def test_a_write_lock_past_the_busy_timeout_makes_transact_unavailable(
    sqlite_open: Callable[..., SqliteLedgerStore], tmp_path: Path
) -> None:
    store = sqlite_open(busy_timeout_ms=0)
    lock = WriteLock(tmp_path / "ledger.db")
    try:
        with pytest.raises(LedgerUnavailableError, match="locked|busy"):
            store.transact(lambda tx: tx.append(new_event()))
    finally:
        lock.release()
    assert store.transact(lambda tx: tx.append(new_event())).state == "intended"


def test_a_write_lock_past_the_busy_timeout_makes_open_unavailable(
    sqlite_open: Callable[..., SqliteLedgerStore], tmp_path: Path
) -> None:
    sqlite_open().close()
    lock = WriteLock(tmp_path / "ledger.db")
    try:
        with pytest.raises(
            LedgerUnavailableError, match=r"^agent-once ledger unavailable: .*(locked|busy)"
        ):
            sqlite_open(busy_timeout_ms=0)
    finally:
        lock.release()


class FaultyConnection(sqlite3.Connection):
    fail_insert = False
    fail_rollback = False

    def execute(self, sql: str, parameters: Any = (), /) -> sqlite3.Cursor:
        if FaultyConnection.fail_insert and sql.lstrip().startswith("INSERT INTO events"):
            FaultyConnection.fail_insert = False
            super().execute("ROLLBACK")
            raise sqlite3.OperationalError("disk I/O error")
        if FaultyConnection.fail_rollback and sql == "ROLLBACK":
            raise sqlite3.OperationalError("rollback failed")
        return super().execute(sql, parameters)


@pytest.fixture
def faulty_connections(monkeypatch: pytest.MonkeyPatch) -> Iterator[type[FaultyConnection]]:
    original = sqlite3.connect

    def connect(*args: Any, **kwargs: Any) -> sqlite3.Connection:
        return original(*args, factory=FaultyConnection, **kwargs)

    monkeypatch.setattr(sqlite_module.sqlite3, "connect", connect)
    yield FaultyConnection
    FaultyConnection.fail_insert = False
    FaultyConnection.fail_rollback = False


def test_a_storage_error_that_ends_the_transaction_poisons_the_rest_of_it(
    sqlite_open: Callable[..., SqliteLedgerStore],
    tmp_path: Path,
    faulty_connections: type[FaultyConnection],
) -> None:
    store = sqlite_open()
    faulty_connections.fail_insert = True
    failures: list[BaseException] = []

    def body(tx: Any) -> str:
        steps: list[Callable[[], object]] = [
            lambda: tx.append(new_event()),
            lambda: tx.latest("a" * 64),
            lambda: tx.append(new_event(intent_hash="b" * 64)),
        ]
        for step in steps:
            try:
                step()
            except Exception as error:
                failures.append(error)
        return "swallowed"

    with pytest.raises(LedgerUnavailableError):
        store.transact(body)
    assert len(failures) == 3
    assert all(isinstance(failure, LedgerUnavailableError) for failure in failures)
    assert "transaction was aborted" in str(failures[1])
    assert raw_query(tmp_path / "ledger.db", "SELECT COUNT(*) FROM events") == [(0,)]
    assert store.transact(lambda tx: tx.append(new_event())).state == "intended"


def test_a_failing_rollback_does_not_hide_the_original_error(
    sqlite_open: Callable[..., SqliteLedgerStore],
    tmp_path: Path,
    faulty_connections: type[FaultyConnection],
) -> None:
    store = sqlite_open()
    faulty_connections.fail_rollback = True

    def body(tx: Any) -> None:
        tx.append(new_event())
        raise RuntimeError("the original failure")

    with pytest.raises(RuntimeError, match="the original failure"):
        store.transact(body)
    faulty_connections.fail_rollback = False
    with pytest.raises(LedgerUnavailableError):
        store.transact(lambda tx: tx.latest("a" * 64))
    assert raw_query(tmp_path / "ledger.db", "SELECT COUNT(*) FROM events") == [(0,)]


@pytest.mark.skipif(
    hasattr(os, "getuid") and os.getuid() == 0, reason="root ignores directory permissions"
)
def test_an_unwritable_directory_is_unavailable(
    sqlite_open: Callable[..., SqliteLedgerStore], tmp_path: Path
) -> None:
    locked = tmp_path / "locked"
    locked.mkdir()
    locked.chmod(0o500)
    try:
        with pytest.raises(LedgerUnavailableError):
            sqlite_open(locked / "ledger.db")
        with pytest.raises(LedgerUnavailableError):
            sqlite_open(locked / "missing" / "ledger.db")
    finally:
        locked.chmod(0o700)


def test_a_corrupt_file_is_unavailable(
    sqlite_open: Callable[..., SqliteLedgerStore], tmp_path: Path
) -> None:
    path = tmp_path / "ledger.db"
    path.write_bytes(b"not a sqlite ledger " * 410)
    with pytest.raises(LedgerUnavailableError, match=r"^agent-once ledger unavailable: ") as caught:
        sqlite_open(path)
    assert caught.value.__cause__ is not None


def test_round_trips_detail_and_args_json_byte_for_byte(
    sqlite_open: Callable[..., SqliteLedgerStore], tmp_path: Path
) -> None:
    args_json = '{ "note": "café \U0001f600  ",\n  "amount": 12.50, "big": 9007199254740993 }'
    detail = {
        "result": {"text": "café \U0001f600", "n": 1e21, "nested": [None, True, -0.5]},
        "result_truncated": False,
        "delivery": "delivered",
    }
    sqlite_open().transact(
        lambda tx: tx.append(new_event(state="confirmed", args_json=args_json, detail=detail))
    )
    assert raw_query(tmp_path / "ledger.db", "SELECT args_json, detail_json FROM events") == [
        (args_json, canonicalize(detail))
    ]
    reread = sqlite_open().find_action("ao_000000000000000000000001")
    assert reread is not None
    assert reread.args_json == args_json
    assert reread.detail == detail


def test_a_detail_that_cannot_be_canonicalized_is_rejected_before_writing(
    sqlite_open: Callable[..., SqliteLedgerStore], tmp_path: Path
) -> None:
    store = sqlite_open()
    with pytest.raises(Exception, match="non-finite"):
        store.transact(lambda tx: tx.append(new_event(detail={"result": float("nan")})))
    assert raw_query(tmp_path / "ledger.db", "SELECT COUNT(*) FROM events") == [(0,)]


def test_default_ledger_path_honours_agent_once_home() -> None:
    assert default_ledger_path({"AGENT_ONCE_HOME": "/srv/once"}, "/home/ada") == os.path.join(
        "/srv/once", "ledger.db"
    )
    assert default_ledger_path({}, "/home/ada") == os.path.join(
        "/home/ada", ".agent-once", "ledger.db"
    )
    assert default_ledger_path({"AGENT_ONCE_HOME": ""}, "/home/ada") == os.path.join(
        "/home/ada", ".agent-once", "ledger.db"
    )
