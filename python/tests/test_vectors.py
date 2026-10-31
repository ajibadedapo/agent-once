from __future__ import annotations

import datetime
import json
import math
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import pytest

from agent_once import (
    BROWSER_VOLATILE_KEYS,
    DEFAULT_VOLATILE_KEYS,
    CanonicalizationError,
    DecisionCall,
    LedgerEvent,
    action_id,
    canonicalize,
    decide,
    intent_hash,
    project_args,
)

VECTORS = Path(__file__).resolve().parents[2] / "spec" / "vectors"
NON_FINITE = {"NaN": math.nan, "Infinity": math.inf, "-Infinity": -math.inf}
DEFAULT_PORTS = {"http": 80, "https": 443}


def load(name: str) -> list[dict[str, Any]]:
    loaded: list[dict[str, Any]] = json.loads((VECTORS / name).read_text(encoding="utf-8"))
    return loaded


def substitute_non_finite(value: Any) -> Any:
    if isinstance(value, list):
        return [substitute_non_finite(item) for item in value]
    if isinstance(value, dict):
        if list(value) == ["$number"] and value["$number"] in NON_FINITE:
            return NON_FINITE[value["$number"]]
        return {key: substitute_non_finite(inner) for key, inner in value.items()}
    return value


def thrown_by(value: Any) -> CanonicalizationError:
    with pytest.raises(CanonicalizationError) as caught:
        canonicalize(value)
    return caught.value


CANONICAL = load("canonical.json")
IDENTITY = load("identity.json")
DECISIONS = load("decisions.json")


def test_vector_files_are_not_empty() -> None:
    assert len(CANONICAL) > 40
    assert any("browser" in vector for vector in IDENTITY)
    assert any("identity_rule" in vector for vector in IDENTITY)
    assert any("intent_key" in vector for vector in IDENTITY)
    assert sorted({vector["expect"]["kind"] for vector in DECISIONS}) == [
        "execute",
        "in_doubt",
        "replay",
    ]


@pytest.mark.parametrize("vector", CANONICAL, ids=[vector["name"] for vector in CANONICAL])
def test_canonical_vectors(vector: dict[str, Any]) -> None:
    if "canonical" in vector:
        assert canonicalize(vector["input"]) == vector["canonical"]
    else:
        with pytest.raises(CanonicalizationError):
            canonicalize(substitute_non_finite(vector["input"]))


def page_identity_url(raw: str) -> str:
    parts = urlsplit(raw)
    scheme = parts.scheme.lower()
    origin = f"{scheme}://{(parts.hostname or '').lower()}"
    if parts.port is not None and parts.port != DEFAULT_PORTS.get(scheme):
        origin = f"{origin}:{parts.port}"
    return origin + (parts.path or "/")


@pytest.mark.parametrize("vector", IDENTITY, ids=[vector["name"] for vector in IDENTITY])
def test_identity_vectors(vector: dict[str, Any]) -> None:
    browser = vector.get("browser")
    if browser is None:
        projected = project_args(vector["args"], vector.get("identity_rule"), DEFAULT_VOLATILE_KEYS)
    else:
        projected = project_args(
            vector["args"],
            vector.get("identity_rule"),
            BROWSER_VOLATILE_KEYS,
            {"page_url": page_identity_url(browser["page_url"]), "label": browser["label"]},
        )
    assert projected == vector["projected"]
    hashed = intent_hash(vector["session_key"], vector["tool"], projected, vector.get("intent_key"))
    assert hashed == vector["intent_hash"]
    assert action_id(hashed, vector["occurrence"], vector["intended_at_ms"]) == vector["action_id"]


def decision_event(vector: dict[str, Any]) -> LedgerEvent | None:
    latest = vector["latest"]
    if latest is None:
        return None
    return LedgerEvent(
        seq=7,
        action_id="ao_000000000000000000000007",
        intent_hash="b" * 64,
        occurrence=latest["occurrence"],
        state=latest["state"],
        at_ms=latest["at_ms"],
        expires_at_ms=latest["expires_at_ms"],
        session_key="client:/work",
        session_explicit=vector["call"]["session_explicit"],
        intent_key_explicit=vector["call"]["intent_key_explicit"],
        run_instance=latest["run_instance"],
        tool="place_order",
        tool_class="money",
        policy=vector["call"]["policy"],
        args_json=None,
        detail=latest["detail"],
    )


@pytest.mark.parametrize("vector", DECISIONS, ids=[vector["name"] for vector in DECISIONS])
def test_decision_vectors(vector: dict[str, Any]) -> None:
    latest = decision_event(vector)
    call = vector["call"]
    decision = decide(
        latest,
        vector["now_ms"],
        vector["retry_window_ms"],
        DecisionCall(
            run_instance=call["run_instance"],
            session_explicit=call["session_explicit"],
            intent_key_explicit=call["intent_key_explicit"],
            policy=call["policy"],
        ),
    )
    assert decision.kind == vector["expect"]["kind"]
    assert decision.reason == vector["expect"]["reason"]
    assert decision.occurrence == vector["expect"]["occurrence"]
    if decision.kind != "execute":
        assert decision.event is latest


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (1e21, "1e+21"),
        (1e-7, "1e-7"),
        (5e-324, "5e-324"),
        (123456789012345680000.0, "123456789012345680000"),
        (int(123456789012345680000.0), "123456789012345680000"),
        (1e20, "100000000000000000000"),
        (1e-6, "0.000001"),
        (1.5e-7, "1.5e-7"),
        (-1.25e22, "-1.25e+22"),
        (0.1 + 0.2, "0.30000000000000004"),
        (-0.0, "0"),
        (2.0, "2"),
        (9007199254740992, "9007199254740992"),
        (-(2**60), "-1152921504606847000"),
        (1.7976931348623157e308, "1.7976931348623157e+308"),
    ],
)
def test_float_formatting_matches_ecmascript(value: float, expected: str) -> None:
    assert canonicalize(value) == expected


def test_booleans_are_not_numbers() -> None:
    assert canonicalize([True, False, 1, 0]) == "[true,false,1,0]"
    assert canonicalize({"a": True}) == '{"a":true}'


def test_non_finite_numbers_name_the_path() -> None:
    assert thrown_by({"price": math.nan}).path == "$.price"
    error = thrown_by({"items": [1, [{"qty": math.inf}]]})
    assert error.path == "$.items[1][0].qty"
    assert str(error) == "cannot canonicalize the non-finite number Infinity at $.items[1][0].qty"
    assert thrown_by(-math.inf).path == "$"
    assert thrown_by({"a b": math.nan}).path == '$["a b"]'


@pytest.mark.parametrize(
    ("value", "path"),
    [
        ({"when": datetime.datetime(2026, 10, 31, tzinfo=datetime.timezone.utc)}, "$.when"),
        ({"tags": {1, 2}}, "$.tags"),
        ({"raw": b"bytes"}, "$.raw"),
        ([object()], "$[0]"),
        ({"run": len}, "$.run"),
        ({1: "non-str key"}, "$"),
        ({"text": "a\ud800"}, "$.text"),
        ({"outer": {"\udc00": 1}}, '$.outer["\\udc00"]'),
        ({"huge": 10**400}, "$.huge"),
        ({"id": 1234567890123456789}, "$.id"),
        ({"id": 2**53 + 1}, "$.id"),
    ],
)
def test_canonical_rejects_values_json_cannot_represent(value: Any, path: str) -> None:
    assert thrown_by(value).path == path


def test_canonical_rejects_a_cycle() -> None:
    looped: dict[str, Any] = {}
    looped["self"] = looped
    assert thrown_by(looped).path == "$.self"


def test_canonical_accepts_tuples_as_arrays_and_repeated_objects() -> None:
    shared = {"k": 1}
    assert canonicalize((1, "a", None)) == '[1,"a",null]'
    assert canonicalize([shared, shared]) == '[{"k":1},{"k":1}]'


def test_project_args_removes_volatile_keys_at_any_depth() -> None:
    args = {
        "ts": 1,
        "order": {
            "nonce": "n",
            "lines": [[{"sku": "A", "requestId": "r"}], {"_meta": {}, "qty": 2}],
        },
    }
    assert project_args(args, None, DEFAULT_VOLATILE_KEYS) == {
        "order": {"lines": [[{"sku": "A"}], {"qty": 2}]}
    }
    assert args["ts"] == 1


def test_project_args_keeps_non_plain_values_for_canonicalize_to_reject() -> None:
    projected = project_args({"when": {1, 2}, "nonce": "n"}, None, DEFAULT_VOLATILE_KEYS)
    with pytest.raises(CanonicalizationError):
        intent_hash("s", "book", projected)


def test_include_exclude_and_extra_identity() -> None:
    args = {"a": 1, "b": {"a": 2}, "c": 3, "nonce": "x"}
    assert project_args(args, {"include": ["a", "nonce", "missing"]}, DEFAULT_VOLATILE_KEYS) == {
        "a": 1
    }
    assert project_args(args, {"exclude": ["a"]}, DEFAULT_VOLATILE_KEYS) == {"b": {"a": 2}, "c": 3}
    assert project_args(
        {"label": "spoofed", "a": 1}, {"include": ["a"]}, DEFAULT_VOLATILE_KEYS, {"label": "real"}
    ) == {"a": 1, "label": "real"}


def test_browser_keys_extend_the_default_keys() -> None:
    assert set(DEFAULT_VOLATILE_KEYS) < set(BROWSER_VOLATILE_KEYS)
    assert "element" in BROWSER_VOLATILE_KEYS and "element" not in DEFAULT_VOLATILE_KEYS


def test_intent_key_ignores_args_and_action_id_varies() -> None:
    keyed = intent_hash("s", "t", {"qty": 1}, "k")
    assert keyed == intent_hash("s", "t", {"qty": 9}, "k")
    assert keyed != intent_hash("s", "t", {"qty": 1})
    hashed = intent_hash("s", "t", {})
    first = action_id(hashed, 0, START_AT)
    assert first.startswith("ao_") and len(first) == 27
    assert action_id(hashed, 1, START_AT) != first
    assert action_id(hashed, 0, START_AT + 1) != first


START_AT = 1_761_912_345_678


def test_inexact_integers_never_share_an_intent_hash() -> None:
    error = thrown_by({"id": 1234567890123456789})
    assert (
        str(error)
        == "cannot canonicalize an integer that a double cannot represent exactly at $.id"
    )
    with pytest.raises(CanonicalizationError):
        intent_hash("s", "t", {"id": 1234567890123456790})
