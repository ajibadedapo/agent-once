from __future__ import annotations

import dataclasses
import json
from pathlib import Path
from typing import Any

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


def test_idempotency_headers_carry_the_key() -> None:
    assert IDEMPOTENCY_KEY_HEADER == "Idempotency-Key"
    assert idempotency_headers("ao_0123456789abcdef01234567") == {
        "Idempotency-Key": "ao_0123456789abcdef01234567"
    }
