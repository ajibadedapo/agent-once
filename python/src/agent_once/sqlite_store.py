from __future__ import annotations

import json
import os
import re
import sqlite3
import threading
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any, TypeVar

from .canonical import canonicalize
from .clock import Clock
from .ledger import (
    LEDGER_SCHEMA_VERSION,
    NESTED_TRANSACT,
    LedgerConflictError,
    LedgerEvent,
    LedgerSchemaTooNewError,
    LedgerTx,
    LedgerUnavailableError,
    LedgerUsageError,
    NewLedgerEvent,
    is_unresolved_event,
    reject_awaitable,
    stored_event,
)
from .private_files import ensure_private_directory, ensure_private_file

LEDGER_V1_SQL = """CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  action_id TEXT NOT NULL,
  intent_hash TEXT NOT NULL,
  occurrence INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('intended','sent','confirmed','failed','reconciled')),
  at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  session_key TEXT NOT NULL,
  session_explicit INTEGER NOT NULL,
  intent_key_explicit INTEGER NOT NULL,
  run_instance TEXT NOT NULL,
  tool TEXT NOT NULL,
  tool_class TEXT NOT NULL CHECK (tool_class IN ('money','irreversible','standard')),
  policy TEXT NOT NULL CHECK (policy IN ('guard','block-on-doubt')),
  args_json TEXT,
  detail_json TEXT NOT NULL
);
CREATE UNIQUE INDEX events_one_intended ON events(intent_hash, occurrence) WHERE state = 'intended';
CREATE INDEX events_by_intent ON events(intent_hash, occurrence, seq);
CREATE INDEX events_by_action ON events(action_id, seq);
CREATE INDEX events_by_expiry ON events(expires_at_ms);
INSERT INTO meta (key, value) VALUES ('schema_version', '1');
"""

DEFAULT_BUSY_TIMEOUT_MS = 5000
POSITIVE_INTEGER = re.compile(r"[1-9][0-9]*")
LEDGER_FILE = "ledger.db"
DEFAULT_HOME_DIR = ".agent-once"
LATEST_SQL = "SELECT * FROM events WHERE intent_hash = ? ORDER BY occurrence DESC, seq DESC LIMIT 1"
FIND_ACTION_SQL = "SELECT * FROM events WHERE action_id = ? ORDER BY seq DESC LIMIT 1"
IN_DOUBT_SQL = """SELECT * FROM events AS e
WHERE e.state IN ('intended', 'sent', 'failed') AND e.expires_at_ms > ?
  AND NOT EXISTS (
    SELECT 1 FROM events AS later
    WHERE later.intent_hash = e.intent_hash
      AND (later.occurrence > e.occurrence
        OR (later.occurrence = e.occurrence AND later.seq > e.seq))
  )
ORDER BY e.seq"""
APPEND_SQL = """INSERT INTO events (action_id, intent_hash, occurrence, state, at_ms, expires_at_ms,
  session_key, session_explicit, intent_key_explicit, run_instance, tool, tool_class, policy,
  args_json, detail_json)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"""

T = TypeVar("T")


@dataclass(frozen=True)
class SqliteLedgerSettings:
    journal_mode: str
    synchronous: int
    busy_timeout_ms: int


def default_ledger_path(env: Mapping[str, str], homedir: str) -> str:
    home = env.get("AGENT_ONCE_HOME")
    return os.path.join(home if home else os.path.join(homedir, DEFAULT_HOME_DIR), LEDGER_FILE)


def _unavailable(error: BaseException, context: str) -> LedgerUnavailableError:
    return LedgerUnavailableError(f"{context}: {error}")


def _is_unique_violation(error: sqlite3.Error) -> bool:
    return isinstance(error, sqlite3.IntegrityError) and str(error).startswith(
        "UNIQUE constraint failed"
    )


def _to_event(row: sqlite3.Row) -> LedgerEvent:
    return LedgerEvent(
        seq=row["seq"],
        action_id=row["action_id"],
        intent_hash=row["intent_hash"],
        occurrence=row["occurrence"],
        state=row["state"],
        at_ms=row["at_ms"],
        expires_at_ms=row["expires_at_ms"],
        session_key=row["session_key"],
        session_explicit=row["session_explicit"] == 1,
        intent_key_explicit=row["intent_key_explicit"] == 1,
        run_instance=row["run_instance"],
        tool=row["tool"],
        tool_class=row["tool_class"],
        policy=row["policy"],
        args_json=row["args_json"],
        detail=json.loads(row["detail_json"]),
    )


def _pragma(connection: sqlite3.Connection, name: str) -> Any:
    row = connection.execute(f"PRAGMA {name}").fetchone()
    return None if row is None else row[0]


def _rollback_if_open(connection: sqlite3.Connection) -> None:
    if connection.in_transaction:
        connection.execute("ROLLBACK")


def _check_schema_version(connection: sqlite3.Connection) -> None:
    row = connection.execute("SELECT value FROM meta WHERE key = 'schema_version'").fetchone()
    if row is None:
        raise LedgerUnavailableError("the meta table has no schema_version")
    value = row[0]
    if not isinstance(value, str) or not POSITIVE_INTEGER.fullmatch(value):
        raise LedgerUnavailableError(
            f"schema_version {json.dumps(value)} is not a positive integer"
        )
    found = int(value)
    if found > LEDGER_SCHEMA_VERSION:
        raise LedgerSchemaTooNewError(found, LEDGER_SCHEMA_VERSION)


def _schema_statements() -> list[str]:
    return [statement.strip() for statement in LEDGER_V1_SQL.split(";\n") if statement.strip()]


def _initialize_schema(connection: sqlite3.Connection) -> None:
    connection.execute("BEGIN IMMEDIATE")
    try:
        has_meta = connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'"
        ).fetchone()
        if has_meta is not None:
            _check_schema_version(connection)
        else:
            existing = connection.execute("SELECT COUNT(*) FROM sqlite_master").fetchone()
            if existing is None or existing[0] != 0:
                raise LedgerUnavailableError(
                    "the file is a SQLite database but not an agent-once ledger"
                )
            for statement in _schema_statements():
                connection.execute(statement)
        connection.execute("COMMIT")
    except BaseException:
        _rollback_if_open(connection)
        raise


def _configure_journal(connection: sqlite3.Connection) -> None:
    if _pragma(connection, "journal_mode = WAL") != "wal":
        raise LedgerUnavailableError("cannot enable the WAL journal")
    connection.execute("PRAGMA synchronous = NORMAL")


def _validate_busy_timeout(busy_timeout_ms: object) -> int:
    if (
        isinstance(busy_timeout_ms, bool)
        or not isinstance(busy_timeout_ms, int)
        or busy_timeout_ms < 0
    ):
        raise ValueError(f"busy_timeout_ms must be a non-negative integer, got {busy_timeout_ms!r}")
    return busy_timeout_ms


class _Transaction:
    def __init__(self) -> None:
        self.poisoned = False


def _aborted_transaction() -> LedgerUnavailableError:
    return LedgerUnavailableError(
        "the transaction was aborted by a storage error; "
        "no further reads or writes are possible in it"
    )


class _SqliteTx:
    def __init__(self, store: SqliteLedgerStore) -> None:
        self._store = store

    def latest(self, intent_hash: str) -> LedgerEvent | None:
        return self._store._latest(intent_hash)

    def append(self, event: NewLedgerEvent) -> LedgerEvent:
        return self._store._append(event)


class SqliteLedgerStore:
    def __init__(self, connection: sqlite3.Connection) -> None:
        self._connection: sqlite3.Connection | None = connection
        self._active: _Transaction | None = None
        self._lock = threading.RLock()

    @classmethod
    def open(
        cls, path: str, clock: Clock, *, busy_timeout_ms: int = DEFAULT_BUSY_TIMEOUT_MS
    ) -> SqliteLedgerStore:
        timeout_ms = _validate_busy_timeout(busy_timeout_ms)
        connection: sqlite3.Connection | None = None
        try:
            ensure_private_directory(os.path.dirname(path))
            ensure_private_file(path)
            connection = sqlite3.connect(
                path, timeout=timeout_ms / 1000, isolation_level=None, check_same_thread=False
            )
            connection.row_factory = sqlite3.Row
            connection.execute(f"PRAGMA busy_timeout = {timeout_ms}")
            _initialize_schema(connection)
            _configure_journal(connection)
            connection.execute("DELETE FROM events WHERE expires_at_ms < ?", (clock.now_ms(),))
            return cls(connection)
        except LedgerUnavailableError:
            if connection is not None:
                connection.close()
            raise
        except Exception as error:
            if connection is not None:
                connection.close()
            raise _unavailable(error, f"cannot open {path}") from error

    def transact(self, fn: Callable[[LedgerTx], T]) -> T:
        with self._lock:
            return self._transact_locked(fn)

    def _transact_locked(self, fn: Callable[[LedgerTx], T]) -> T:
        connection = self._connection_or_raise()
        if self._active is not None:
            raise LedgerUsageError(NESTED_TRANSACT)
        try:
            connection.execute("BEGIN IMMEDIATE")
        except sqlite3.Error as error:
            raise _unavailable(error, "cannot begin a transaction") from error
        state = _Transaction()
        self._active = state
        try:
            result = fn(_SqliteTx(self))
            reject_awaitable(result)
            if state.poisoned:
                raise _aborted_transaction()
            try:
                connection.execute("COMMIT")
            except sqlite3.Error as error:
                raise _unavailable(error, "cannot commit") from error
            return result
        except BaseException:
            self._abort(connection)
            raise
        finally:
            self._active = None

    def find_action(self, action_id: str) -> LedgerEvent | None:
        with self._lock:
            return self._find_action_locked(action_id)

    def _find_action_locked(self, action_id: str) -> LedgerEvent | None:
        connection = self._connection_or_raise()
        try:
            row = connection.execute(FIND_ACTION_SQL, (action_id,)).fetchone()
        except sqlite3.Error as error:
            raise _unavailable(error, "cannot read the ledger") from error
        return None if row is None else _to_event(row)

    def list_in_doubt(self, now_ms: int) -> list[LedgerEvent]:
        with self._lock:
            return self._list_in_doubt_locked(now_ms)

    def _list_in_doubt_locked(self, now_ms: int) -> list[LedgerEvent]:
        connection = self._connection_or_raise()
        try:
            rows = connection.execute(IN_DOUBT_SQL, (now_ms,)).fetchall()
        except sqlite3.Error as error:
            raise _unavailable(error, "cannot read the ledger") from error
        events = [_to_event(row) for row in rows]
        return [event for event in events if is_unresolved_event(event, now_ms)]

    def settings(self) -> SqliteLedgerSettings:
        with self._lock:
            return self._settings_locked()

    def _settings_locked(self) -> SqliteLedgerSettings:
        connection = self._connection_or_raise()
        return SqliteLedgerSettings(
            journal_mode=str(_pragma(connection, "journal_mode")),
            synchronous=int(_pragma(connection, "synchronous")),
            busy_timeout_ms=int(_pragma(connection, "busy_timeout")),
        )

    def close(self) -> None:
        with self._lock:
            self._close_locked()

    def _close_locked(self) -> None:
        connection, self._connection = self._connection, None
        if connection is not None:
            connection.close()

    def _connection_or_raise(self) -> sqlite3.Connection:
        if self._connection is None:
            raise LedgerUnavailableError("the ledger is closed")
        return self._connection

    def _abort(self, connection: sqlite3.Connection) -> None:
        try:
            _rollback_if_open(connection)
        except sqlite3.Error:
            self.close()

    def _active_connection(self) -> sqlite3.Connection:
        connection = self._connection_or_raise()
        if self._active is not None and self._active.poisoned:
            raise _aborted_transaction()
        return connection

    def _storage_failure(
        self, connection: sqlite3.Connection, error: sqlite3.Error, context: str
    ) -> LedgerUnavailableError:
        if self._active is not None and not connection.in_transaction:
            self._active.poisoned = True
        return _unavailable(error, context)

    def _latest(self, intent_hash: str) -> LedgerEvent | None:
        connection = self._active_connection()
        try:
            row = connection.execute(LATEST_SQL, (intent_hash,)).fetchone()
        except sqlite3.Error as error:
            raise self._storage_failure(connection, error, "cannot read the ledger") from error
        return None if row is None else _to_event(row)

    def _append(self, event: NewLedgerEvent) -> LedgerEvent:
        connection = self._active_connection()
        detail_json = canonicalize(event.detail)
        try:
            cursor = connection.execute(
                APPEND_SQL,
                (
                    event.action_id,
                    event.intent_hash,
                    event.occurrence,
                    event.state,
                    event.at_ms,
                    event.expires_at_ms,
                    event.session_key,
                    event.session_explicit,
                    event.intent_key_explicit,
                    event.run_instance,
                    event.tool,
                    event.tool_class,
                    event.policy,
                    event.args_json,
                    detail_json,
                ),
            )
        except sqlite3.Error as error:
            if _is_unique_violation(error):
                raise LedgerConflictError(event.intent_hash, event.occurrence) from error
            raise self._storage_failure(connection, error, "cannot append to the ledger") from error
        seq = cursor.lastrowid
        if seq is None:
            raise self._storage_failure(
                connection, sqlite3.Error("no row id"), "cannot append to the ledger"
            )
        return stored_event(event, seq, json.loads(detail_json))
