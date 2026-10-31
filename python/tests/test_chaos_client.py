from __future__ import annotations

import os
import sys
import threading
from pathlib import Path

import pytest

from agent_once import chaos_client
from agent_once.chaos_client import ChaosServer, ChaosTargetsError, resolve_cli

posix_only = pytest.mark.skipif(os.name != "posix", reason="process groups are POSIX")

GRANDCHILD = """
import fcntl, sys, threading
handle = open(sys.argv[1], "w")
fcntl.flock(handle, fcntl.LOCK_EX)
print("locked", flush=True)
threading.Event().wait()
"""

SERVER_WITH_GRANDCHILD = """
import subprocess, sys, threading
child = subprocess.Popen(
    [sys.executable, "-c", sys.argv[1], sys.argv[2]], stdout=subprocess.PIPE, text=True
)
child.stdout.readline()
print("agent-once chaos targets listening on http://127.0.0.1:9", flush=True)
threading.Event().wait()
"""

SERVER_THAT_FAILS = """
import sys
sys.stderr.write("listen EADDRINUSE")
sys.exit(1)
"""


def lock_acquired_within(path: Path, timeout_s: float) -> bool:
    import fcntl

    acquired = threading.Event()

    def take() -> None:
        with open(path, "w") as handle:
            fcntl.flock(handle, fcntl.LOCK_EX)
            acquired.set()

    threading.Thread(target=take, daemon=True).start()
    return acquired.wait(timeout_s)


def lock_is_free(path: Path) -> bool:
    import fcntl

    with open(path, "w") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return False
        return True


@posix_only
def test_stop_terminates_the_whole_process_group(tmp_path: Path) -> None:
    script = tmp_path / "server.py"
    script.write_text(SERVER_WITH_GRANDCHILD)
    lock = tmp_path / "grandchild.lock"
    server = ChaosServer([sys.executable, str(script), GRANDCHILD, str(lock)])
    try:
        assert server.url == "http://127.0.0.1:9"
        assert not lock_is_free(lock)
    finally:
        server.stop()
    assert lock_acquired_within(lock, 10.0)


def test_a_server_that_exits_before_listening_reports_its_stderr(tmp_path: Path) -> None:
    script = tmp_path / "server.py"
    script.write_text(SERVER_THAT_FAILS)
    with pytest.raises(ChaosTargetsError, match="did not report a URL.*EADDRINUSE"):
        ChaosServer([sys.executable, str(script)])


def test_resolve_cli_prefers_the_environment_variable() -> None:
    assert resolve_cli({"AGENT_ONCE_CLI": "node '/opt/agent once/main.js'"}) == [
        "node",
        "/opt/agent once/main.js",
    ]


def test_resolve_cli_uses_the_repository_build_inside_the_repository(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    built = tmp_path / "main.js"
    monkeypatch.setattr(chaos_client, "repo_cli", lambda: built)
    monkeypatch.setattr("agent_once.chaos_client.shutil.which", lambda name: f"/usr/bin/{name}")
    assert resolve_cli({}) == ["/usr/bin/node", str(built)]


def test_resolve_cli_falls_back_to_npx_outside_the_repository(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(chaos_client, "repo_cli", lambda: None)
    monkeypatch.setattr("agent_once.chaos_client.shutil.which", lambda name: f"/usr/bin/{name}")
    assert resolve_cli({"AGENT_ONCE_CLI": " "}) == ["/usr/bin/npx", "--yes", "agent-once"]


def test_repo_cli_finds_the_built_cli_in_this_checkout() -> None:
    found = chaos_client.repo_cli()
    assert found is not None
    assert found.parts[-4:] == ("agent-once", "dist", "cli", "main.js")
