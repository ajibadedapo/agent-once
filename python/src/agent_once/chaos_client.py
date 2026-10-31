from __future__ import annotations

import json
import os
import queue
import shlex
import shutil
import signal
import subprocess
import tempfile
import threading
import urllib.error
import urllib.request
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import IO, Any

from . import __version__

LISTENING_PREFIX = "agent-once chaos targets listening on "
ADMIN_TOKEN_PREFIX = "agent-once chaos targets admin token "
ADMIN_TOKEN_HEADER = "x-agent-once-admin-token"
CLI_ENV = "AGENT_ONCE_CLI"
DEFAULT_STARTUP_TIMEOUT_S = 120.0
DEFAULT_STOP_TIMEOUT_S = 10.0
REQUEST_TIMEOUT_S = 30.0
STDERR_TAIL_CHARS = 2_000

Effect = dict[str, Any]
FaultPlan = Sequence[Mapping[str, Any]]


class ChaosTargetsError(RuntimeError):
    pass


def _fields_key(effect: Effect) -> str:
    return json.dumps(effect.get("fields", {}), sort_keys=True, separators=(",", ":"))


def _ids(effects: Sequence[Effect]) -> str:
    return ", ".join(str(effect.get("id")) for effect in effects)


def duplicate_problems(truth: Mapping[str, Sequence[Effect]]) -> list[str]:
    problems: list[str] = []
    for target, effects in truth.items():
        groups: dict[str, list[Effect]] = {}
        for effect in effects:
            groups.setdefault(_fields_key(effect), []).append(effect)
        for fields, grouped in groups.items():
            if len(grouped) > 1:
                problems.append(
                    f"{target} has {len(grouped)} effects with the same fields {fields}: "
                    f"{_ids(grouped)}"
                )
    return problems


class ChaosTargets:
    def __init__(self, url: str, admin_token: str) -> None:
        self.url = url.rstrip("/")
        self._admin_token = admin_token

    def _request(self, method: str, path: str, body: object | None = None) -> Any:
        data = None if body is None else json.dumps(body).encode("utf-8")
        request = urllib.request.Request(
            self.url + path,
            data=data,
            method=method,
            headers={
                "content-type": "application/json",
                "connection": "close",
                ADMIN_TOKEN_HEADER: self._admin_token,
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_S) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            payload = error.read().decode("utf-8", "replace")
            error.close()
            if error.code == 400:
                raise ValueError(json.loads(payload).get("error", payload)) from None
            raise ChaosTargetsError(f"{method} {path} answered {error.code}: {payload}") from None

    def set_faults(self, plan: FaultPlan) -> None:
        self._request("POST", "/__faults", [dict(fault) for fault in plan])

    def reset(self) -> None:
        self._request("POST", "/__reset", {})

    def truth(self) -> dict[str, list[Effect]]:
        result: dict[str, list[Effect]] = self._request("GET", "/__truth")
        return result

    def assert_no_duplicates(self) -> None:
        __tracebackhide__ = True
        problems = duplicate_problems(self.truth())
        if problems:
            raise AssertionError("\n".join(problems))

    def assert_exactly_one(self, target: str) -> None:
        __tracebackhide__ = True
        truth = self.truth()
        if target not in truth:
            raise ValueError(f"unknown target {target}; expected one of {', '.join(truth)}")
        effects = truth[target]
        if len(effects) != 1:
            found = f"{len(effects)}" + (f": {_ids(effects)}" if effects else "")
            raise AssertionError(f"expected exactly one {target} effect, found {found}")


def repo_cli() -> Path | None:
    candidate = Path(__file__).resolve().parents[3] / "packages" / "agent-once" / "dist" / "cli"
    main = candidate / "main.js"
    return main if main.is_file() else None


def resolve_cli(env: Mapping[str, str]) -> list[str]:
    configured = env.get(CLI_ENV, "").strip()
    if configured:
        return shlex.split(configured)
    local = repo_cli()
    node = shutil.which("node")
    if local is not None and node is not None:
        return [node, str(local)]
    npx = shutil.which("npx")
    if npx is None:
        raise ChaosTargetsError(f"npx is not on PATH; install Node.js 22.13+ or set {CLI_ENV}")
    return [npx, "--yes", f"agent-once@{__version__}"]


def _read_lines(stream: IO[str], lines: queue.Queue[str]) -> None:
    for line in stream:
        lines.put(line)
    lines.put("")


class ChaosServer:
    def __init__(
        self,
        cli: Sequence[str],
        *,
        startup_timeout_s: float = DEFAULT_STARTUP_TIMEOUT_S,
        stop_timeout_s: float = DEFAULT_STOP_TIMEOUT_S,
    ) -> None:
        self._stop_timeout_s = stop_timeout_s
        self._stderr = tempfile.TemporaryFile(mode="w+", encoding="utf-8")
        self._process = subprocess.Popen(
            [*cli, "chaos", "serve", "--port", "0"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=self._stderr,
            text=True,
            encoding="utf-8",
            start_new_session=os.name == "posix",
            creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
        )
        assert self._process.stdout is not None
        self._lines: queue.Queue[str] = queue.Queue()
        self._reader = threading.Thread(
            target=_read_lines, args=(self._process.stdout, self._lines), daemon=True
        )
        self._reader.start()
        self._group_gone = False
        try:
            self.url = self._await_url(startup_timeout_s)
            self.admin_token = self._await_admin_token(startup_timeout_s)
        except BaseException:
            self.stop()
            raise

    def _await_url(self, timeout_s: float) -> str:
        try:
            line = self._lines.get(timeout=timeout_s)
        except queue.Empty:
            raise ChaosTargetsError(
                f"agent-once chaos serve printed nothing within {timeout_s:g} s"
                + self._stderr_tail()
            ) from None
        if line.startswith(LISTENING_PREFIX):
            return line[len(LISTENING_PREFIX) :].strip()
        if line == "":
            try:
                self._process.wait(timeout=self._stop_timeout_s)
            except subprocess.TimeoutExpired:
                pass
        raise ChaosTargetsError(
            f"agent-once chaos serve did not report a URL (first line {line.strip()!r})"
            + self._stderr_tail()
        )

    def _await_admin_token(self, timeout_s: float) -> str:
        try:
            line = self._lines.get(timeout=timeout_s)
        except queue.Empty:
            line = ""
        if line.startswith(ADMIN_TOKEN_PREFIX):
            return line[len(ADMIN_TOKEN_PREFIX) :].strip()
        if line == "":
            try:
                self._process.wait(timeout=self._stop_timeout_s)
            except subprocess.TimeoutExpired:
                pass
        raise ChaosTargetsError(
            f"agent-once chaos serve did not report an admin token (second line {line.strip()!r})"
            + self._stderr_tail()
        )

    def _stderr_tail(self) -> str:
        self._stderr.seek(0)
        detail = self._stderr.read().strip()[-STDERR_TAIL_CHARS:]
        return f": {detail}" if detail else ""

    def _signal_group(self, sig: signal.Signals) -> None:
        if self._group_gone:
            return
        try:
            os.killpg(self._process.pid, sig)
        except ProcessLookupError:
            self._group_gone = True

    def _terminate(self) -> None:
        if os.name == "posix":
            self._signal_group(signal.SIGTERM)
        else:
            self._process.terminate()

    def _kill(self) -> None:
        if os.name == "posix":
            self._signal_group(signal.SIGKILL)
        else:
            self._process.kill()

    def stop(self) -> None:
        try:
            if self._process.poll() is None:
                self._terminate()
                try:
                    self._process.wait(timeout=self._stop_timeout_s)
                except subprocess.TimeoutExpired:
                    self._kill()
                    self._process.wait()
            self._kill()
            self._reader.join(timeout=self._stop_timeout_s)
        finally:
            if not self._reader.is_alive() and self._process.stdout is not None:
                self._process.stdout.close()
            self._stderr.close()
