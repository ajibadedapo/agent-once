from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

VECTORS_PATH = (
    Path(__file__).resolve().parent.parent / "spec" / "vectors" / "identity.json"
)

DEFAULT_VOLATILE_KEYS = frozenset(
    {
        "timestamp",
        "ts",
        "nonce",
        "request_id",
        "requestId",
        "idempotency_key",
        "idempotencyKey",
        "trace_id",
        "traceId",
        "_meta",
    }
)

BROWSER_VOLATILE_KEYS = frozenset(
    {
        "target",
        "ref",
        "uid",
        "pageId",
        "from_uid",
        "to_uid",
        "slowly",
        "includeSnapshot",
    }
)

DEFAULT_PORTS = {"http": 80, "https": 443}

SIMPLE_HOST = re.compile(r"([a-z0-9]+(-[a-z0-9]+)*\.)*[a-z][a-z0-9]*(-[a-z0-9]+)*")
SIMPLE_PATH = re.compile(r"(/[A-Za-z0-9_~-]+(\.[A-Za-z0-9]+)?)*/?")

SESSION = "claude-code:/work/shop"

CASES: list[dict[str, Any]] = [
    {
        "name": "plain_args_occurrence_0",
        "session_key": SESSION,
        "tool": "place_order",
        "args": {"sku": "A-100", "qty": 2, "gift": False, "note": None},
        "occurrence": 0,
    },
    {
        "name": "key_order_and_top_level_volatile_keys_do_not_change_intent_occurrence_3",
        "session_key": SESSION,
        "tool": "place_order",
        "args": {
            "timestamp": 1761912345678,
            "qty": 2,
            "note": None,
            "sku": "A-100",
            "gift": False,
            "request_id": "req-7",
        },
        "occurrence": 3,
    },
    {
        "name": "volatile_keys_removed_at_any_depth",
        "session_key": SESSION,
        "tool": "create_invoice",
        "args": {
            "customer": {
                "id": "c-9",
                "trace_id": "abc",
                "address": {"city": "Leeds", "ts": 5},
            },
            "lines": [
                {"sku": "A", "qty": 1, "nonce": "n-1"},
                {"sku": "B", "qty": 2, "meta": {"traceId": "t-2", "keep": True}},
            ],
            "_meta": {"progressToken": 4},
            "idempotencyKey": "k-1",
            "idempotency_key": "k-2",
            "requestId": "r-3",
        },
        "occurrence": 0,
    },
    {
        "name": "volatile_key_match_is_case_sensitive",
        "session_key": SESSION,
        "tool": "send_email",
        "args": {"Timestamp": "kept", "TS": 1, "to": "a@example.com", "ts": 2},
        "occurrence": 0,
    },
    {
        "name": "include_rule_keeps_only_listed_top_level_keys",
        "session_key": SESSION,
        "tool": "book_slot",
        "args": {
            "slot": "2026-11-02T10:00",
            "venue": "court-3",
            "comment": "see you there",
            "client_ref": 991,
            "nonce": "x",
        },
        "identity_rule": {"include": ["slot", "venue", "missing_key"]},
        "occurrence": 0,
    },
    {
        "name": "exclude_rule_drops_listed_top_level_keys_only",
        "session_key": SESSION,
        "tool": "send_email",
        "args": {
            "to": "a@example.com",
            "subject": "Receipt",
            "body": "Thanks",
            "draft_id": "d-1",
            "headers": {"draft_id": "nested stays"},
        },
        "identity_rule": {"exclude": ["draft_id", "body"]},
        "occurrence": 0,
    },
    {
        "name": "explicit_intent_key_ignores_args",
        "session_key": SESSION,
        "tool": "place_order",
        "args": {"sku": "A-100", "qty": 5},
        "intent_key": "cart-42-checkout",
        "occurrence": 0,
    },
    {
        "name": "explicit_intent_key_same_key_different_args_occurrence_3",
        "session_key": SESSION,
        "tool": "place_order",
        "args": {"sku": "B-200", "qty": 1},
        "intent_key": "cart-42-checkout",
        "occurrence": 3,
    },
    {
        "name": "browser_page_url_drops_query_and_fragment_and_element_refs",
        "session_key": "playwright:/work/shop",
        "tool": "browser_click",
        "args": {"element": "Place order button", "ref": "e123", "target": "e123"},
        "browser": {
            "page_url": "https://shop.example.com/checkout/review?step=2&session=abc#summary",
            "label": "Place order",
        },
        "occurrence": 0,
    },
    {
        "name": "browser_uid_args_with_explicit_port_and_default_port_removed",
        "session_key": "chrome-devtools:/work/shop",
        "tool": "click",
        "args": {"uid": "1_42", "includeSnapshot": True, "dblClick": False},
        "browser": {
            "page_url": "https://pay.example.com:443/confirm?token=t-1",
            "label": "Pay now",
        },
        "occurrence": 1,
    },
    {
        "name": "browser_non_default_port_kept_and_page_args_overridden",
        "session_key": "chrome-devtools:/work/shop",
        "tool": "type_text",
        "args": {
            "text": "4 Main Street",
            "submitKey": "Enter",
            "uid": "3_7",
            "page_url": "spoofed",
            "label": "spoofed",
        },
        "browser": {
            "page_url": "http://localhost:8080/orders/new?x=1",
            "label": "Delivery address",
        },
        "occurrence": 0,
    },
    {
        "name": "empty_args",
        "session_key": "env:nightly-run",
        "tool": "publish_post",
        "args": {},
        "occurrence": 0,
    },
    {
        "name": "non_ascii_string_values",
        "session_key": SESSION,
        "tool": "send_message",
        "args": {"text": "café ☕ üß", "channel": "general"},
        "occurrence": 2,
    },
]


def canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def drop_keys(value: Any, keys: frozenset[str]) -> Any:
    if isinstance(value, dict):
        return {k: drop_keys(v, keys) for k, v in value.items() if k not in keys}
    if isinstance(value, list):
        return [drop_keys(item, keys) for item in value]
    return value


def page_identity_url(raw: str) -> str:
    parts = urlsplit(raw)
    scheme = parts.scheme.lower()
    host = (parts.hostname or "").lower()
    if (
        scheme not in DEFAULT_PORTS
        or parts.username is not None
        or not SIMPLE_HOST.fullmatch(host)
        or not SIMPLE_PATH.fullmatch(parts.path)
    ):
        raise ValueError(
            f"page_url needs full WHATWG URL parsing, keep vectors simple: {raw}"
        )
    port = parts.port
    origin = f"{scheme}://{host}"
    if port is not None and port != DEFAULT_PORTS.get(scheme):
        origin = f"{origin}:{port}"
    return origin + (parts.path or "/")


def project(case: dict[str, Any]) -> dict[str, Any]:
    browser = case.get("browser")
    volatile = (
        DEFAULT_VOLATILE_KEYS | BROWSER_VOLATILE_KEYS
        if browser
        else DEFAULT_VOLATILE_KEYS
    )
    projected: dict[str, Any] = drop_keys(case["args"], volatile)
    rule = case.get("identity_rule")
    if rule is not None and "include" in rule:
        projected = {k: v for k, v in projected.items() if k in rule["include"]}
    elif rule is not None and "exclude" in rule:
        projected = {k: v for k, v in projected.items() if k not in rule["exclude"]}
    if browser:
        projected = {
            **projected,
            "page_url": page_identity_url(browser["page_url"]),
            "label": browser["label"],
        }
    return projected


def build_vector(case: dict[str, Any]) -> dict[str, Any]:
    projected = project(case)
    intent_key = case.get("intent_key")
    if intent_key is None:
        preimage = ["agent-once/v1", case["session_key"], case["tool"], projected]
    else:
        preimage = [
            "agent-once/v1/intent",
            case["session_key"],
            case["tool"],
            intent_key,
        ]
    intent_hash = sha256_hex(canonical(preimage))
    action_id = "ao_" + sha256_hex(canonical([intent_hash, case["occurrence"]]))[:24]
    vector: dict[str, Any] = {
        "name": case["name"],
        "session_key": case["session_key"],
        "tool": case["tool"],
        "args": case["args"],
    }
    for optional in ("identity_rule", "browser", "intent_key"):
        if optional in case:
            vector[optional] = case[optional]
    vector["projected"] = projected
    vector["intent_hash"] = intent_hash
    vector["occurrence"] = case["occurrence"]
    vector["action_id"] = action_id
    return vector


def render() -> str:
    return (
        json.dumps([build_vector(case) for case in CASES], indent=2, ensure_ascii=True)
        + "\n"
    )


def main(argv: list[str]) -> int:
    text = render()
    if argv[1:] == ["--check"]:
        if VECTORS_PATH.read_text(encoding="utf-8") != text:
            print(f"{VECTORS_PATH} is out of date; run scripts/gen_identity_vectors.py")
            return 1
        return 0
    VECTORS_PATH.write_text(text, encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
