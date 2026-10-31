from __future__ import annotations

import os
from collections.abc import Iterator
from pathlib import Path

import pytest

from .chaos_client import ChaosServer, ChaosTargets, resolve_cli
from .clock import ManualClock
from .evidence import EvidenceEvent
from .guard import Guard
from .sqlite_store import SqliteLedgerStore

ONCE_START_MS = 1_761_912_345_678


class _NoEvidence:
    def emit(self, event: EvidenceEvent) -> None:
        return None


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line(
        "markers", "chaos: the test drives the agent-once chaos targets (needs Node.js)"
    )


@pytest.fixture
def once_clock() -> ManualClock:
    return ManualClock(ONCE_START_MS)


@pytest.fixture
def once_guard(tmp_path: Path, once_clock: ManualClock) -> Iterator[Guard]:
    store = SqliteLedgerStore.open(str(tmp_path / "agent-once" / "ledger.db"), once_clock)
    try:
        yield Guard(store, once_clock, "pytest", _NoEvidence())
    finally:
        store.close()


@pytest.fixture(scope="session")
def agent_once_chaos_server() -> Iterator[ChaosServer]:
    server = ChaosServer(resolve_cli(os.environ))
    try:
        yield server
    finally:
        server.stop()


@pytest.fixture
def agent_once_chaos_targets(agent_once_chaos_server: ChaosServer) -> ChaosTargets:
    targets = ChaosTargets(agent_once_chaos_server.url, agent_once_chaos_server.admin_token)
    targets.reset()
    return targets
