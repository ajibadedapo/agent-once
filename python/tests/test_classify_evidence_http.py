from __future__ import annotations

import dataclasses
import json
import os
import stat
import sys
from pathlib import Path
from typing import Any

import pytest
from harness import START_MS

from agent_once import (
    DEFAULT_IRREVERSIBLE_PATTERNS,
    DEFAULT_MONEY_PATTERNS,
    DEFAULT_SIDE_EFFECT_PATTERNS,
    IDEMPOTENCY_KEY_HEADER,
    EvidenceEvent,
    JsonlEvidence,
    classify_tool,
    idempotency_headers,
    matches_any_pattern,
)
from agent_once import evidence as evidence_module
from agent_once import private_files as private_files_module


def test_the_default_pattern_lists_are_the_agreed_words() -> None:
    assert list(DEFAULT_SIDE_EFFECT_PATTERNS) == [
        "pay",
        "buy",
        "checkout",
        "book",
        "confirm",
        "submit",
        "send",
        "delete",
        "publish",
        "order",
        "purchase",
        "place",
        "create",
        "post",
    ]
    assert list(DEFAULT_MONEY_PATTERNS) == [
        "pay",
        "buy",
        "checkout",
        "purchase",
        "charge",
        "order",
        "payment",
        "transfer",
    ]
    assert list(DEFAULT_IRREVERSIBLE_PATTERNS) == ["delete", "publish", "send", "deploy"]


def test_matches_whole_words_in_every_case_style_and_description() -> None:
    assert classify_tool("place_order", "") == "money"
    assert classify_tool("sendEmail", "") == "irreversible"
    assert classify_tool("blog-publish", "") == "irreversible"
    assert classify_tool("run", "Transfer funds between accounts") == "money"
    assert classify_tool("PAY", "") == "money"
    assert classify_tool("HTTPSendRequest", "") == "irreversible"


def test_does_not_match_a_pattern_inside_a_longer_word() -> None:
    assert classify_tool("display_payload", "Shows the payroll summary") == "standard"
    assert classify_tool("get_orders", "Lists the border crossings") == "standard"
    assert classify_tool("resend_preview", "") == "standard"


def test_money_wins_over_irreversible() -> None:
    assert classify_tool("send_payment", "") == "money"
    assert classify_tool("delete_item", "and charge the card") == "money"


def test_multi_word_patterns_match_consecutive_words() -> None:
    assert (
        classify_tool("wire", "Sends a wire transfer", money=["wire transfer"], irreversible=[])
        == "money"
    )
    assert (
        classify_tool("wire", "transfer by wire", money=["wire transfer"], irreversible=[])
        == "standard"
    )


def test_matches_any_pattern_finds_side_effect_tools_by_name_or_description() -> None:
    assert matches_any_pattern("book_table", "", DEFAULT_SIDE_EFFECT_PATTERNS) is True
    assert (
        matches_any_pattern("lookup", "Read the bookings list", DEFAULT_SIDE_EFFECT_PATTERNS)
        is False
    )


def evidence_event(**overrides: Any) -> EvidenceEvent:
    base = EvidenceEvent(
        v=1,
        at_ms=START_MS,
        kind="decision",
        action_id="ao_000000000000000000000001",
        tool="place_order",
        session_key="client:/work",
        detail={"decision": "execute", "reason": "new", "occurrence": 0},
    )
    return dataclasses.replace(base, **overrides)


def test_jsonl_evidence_appends_one_line_per_event_in_the_shared_format(tmp_path: Path) -> None:
    path = tmp_path / "nested" / "events.jsonl"
    sink = JsonlEvidence(str(path))
    sink.emit(evidence_event())
    sink.emit(
        evidence_event(kind="state", action_id=None, detail={"state": "intended", "occurrence": 0})
    )
    lines = path.read_text(encoding="utf-8").split("\n")
    assert len(lines) == 3 and lines[2] == ""
    assert lines[0] == (
        '{"v":1,"atMs":1761912345678,"kind":"decision","actionId":"ao_000000000000000000000001",'
        '"tool":"place_order","sessionKey":"client:/work","detail":{"decision":"execute","reason":"new","occurrence":0}}'
    )
    assert json.loads(lines[1]) == {
        "v": 1,
        "atMs": START_MS,
        "kind": "state",
        "tool": "place_order",
        "sessionKey": "client:/work",
        "detail": {"state": "intended", "occurrence": 0},
    }


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX file modes")
def test_jsonl_evidence_creates_the_directory_0o700_and_the_file_0o600(tmp_path: Path) -> None:
    home = tmp_path / "home"
    path = home / "events.jsonl"
    JsonlEvidence(str(path)).emit(evidence_event())
    assert stat.S_IMODE(home.stat().st_mode) == 0o700
    assert stat.S_IMODE(path.stat().st_mode) == 0o600


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX file modes")
def test_jsonl_evidence_keeps_an_existing_stricter_file_mode(tmp_path: Path) -> None:
    path = tmp_path / "events.jsonl"
    path.write_text("", encoding="utf-8")
    path.chmod(0o200)
    JsonlEvidence(str(path)).emit(evidence_event())
    assert stat.S_IMODE(path.stat().st_mode) == 0o200


def test_jsonl_evidence_writes_lf_line_endings_only(tmp_path: Path) -> None:
    path = tmp_path / "events.jsonl"
    sink = JsonlEvidence(str(path))
    sink.emit(evidence_event())
    sink.emit(evidence_event(kind="state", detail={"state": "sent", "occurrence": 0}))
    written = path.read_bytes()
    assert written.endswith(b"\n")
    assert b"\r" not in written


def test_jsonl_evidence_asks_for_lf_even_where_text_mode_defaults_to_crlf(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    real_fdopen = os.fdopen

    def windows_default_fdopen(fd: int, mode: str, **kwargs: Any) -> Any:
        if kwargs.get("newline") is None:
            kwargs["newline"] = "\r\n"
        return real_fdopen(fd, mode, **kwargs)

    monkeypatch.setattr(evidence_module.os, "fdopen", windows_default_fdopen)
    path = tmp_path / "events.jsonl"
    JsonlEvidence(str(path)).emit(evidence_event())
    assert b"\r" not in path.read_bytes()


def test_private_files_open_in_binary_mode_where_the_platform_has_one(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    binary_flag = 1 << 30
    real_open = os.open
    seen: list[int] = []

    def recording_open(path: str, flags: int, mode: int = 0o777) -> int:
        seen.append(flags)
        return real_open(path, flags & ~binary_flag, mode)

    monkeypatch.setattr(os, "O_BINARY", binary_flag, raising=False)
    monkeypatch.setattr(private_files_module.os, "open", recording_open)
    os.close(private_files_module.open_private_file(str(tmp_path / "events.jsonl")))
    assert seen and all(flags & binary_flag for flags in seen)


def test_idempotency_headers_carry_the_key() -> None:
    assert IDEMPOTENCY_KEY_HEADER == "Idempotency-Key"
    assert idempotency_headers("ao_0123456789abcdef01234567") == {
        "Idempotency-Key": "ao_0123456789abcdef01234567"
    }
