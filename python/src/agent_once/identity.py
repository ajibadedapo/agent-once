from __future__ import annotations

import hashlib
from collections.abc import Iterable, Mapping, Sequence

from .canonical import JsonValue, canonicalize

ARGS_DOMAIN = "agent-once/v1"
INTENT_KEY_DOMAIN = "agent-once/v1/intent"
ACTION_ID_PREFIX = "ao_"
ACTION_ID_HEX_LENGTH = 24

DEFAULT_VOLATILE_KEYS: tuple[str, ...] = (
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
)

BROWSER_VOLATILE_KEYS: tuple[str, ...] = (
    *DEFAULT_VOLATILE_KEYS,
    "element",
    "target",
    "ref",
    "uid",
    "pageId",
    "from_uid",
    "to_uid",
    "slowly",
    "includeSnapshot",
)

IdentityRule = Mapping[str, Sequence[str]]


def _strip_volatile(value: object, volatile: frozenset[str]) -> object:
    if isinstance(value, (list, tuple)):
        return [_strip_volatile(item, volatile) for item in value]
    if isinstance(value, dict):
        return {
            key: _strip_volatile(inner, volatile)
            for key, inner in value.items()
            if not (isinstance(key, str) and key in volatile)
        }
    return value


def _apply_rule(args: dict[object, object], rule: IdentityRule | None) -> dict[object, object]:
    if rule is None:
        return args
    if "include" in rule:
        listed = frozenset(rule["include"])
        return {key: value for key, value in args.items() if key in listed}
    if "exclude" in rule:
        listed = frozenset(rule["exclude"])
        return {key: value for key, value in args.items() if key not in listed}
    raise ValueError("an identity rule needs an include or an exclude list")


def project_args(
    args: Mapping[str, object],
    rule: IdentityRule | None,
    volatile_keys: Iterable[str],
    extra_identity: Mapping[str, JsonValue] | None = None,
) -> dict[object, object]:
    stripped = _strip_volatile(dict(args), frozenset(volatile_keys))
    assert isinstance(stripped, dict)
    projected = dict(_apply_rule(stripped, rule))
    for key, value in (extra_identity or {}).items():
        projected[key] = value
    return projected


def _sha256_hex(value: object) -> str:
    return hashlib.sha256(canonicalize(value).encode("utf-8")).hexdigest()


def intent_hash(
    session_key: str, tool: str, projected_args: object, intent_key: str | None = None
) -> str:
    if intent_key is not None:
        return _sha256_hex([INTENT_KEY_DOMAIN, session_key, tool, intent_key])
    return _sha256_hex([ARGS_DOMAIN, session_key, tool, projected_args])


def action_id(intent_hash: str, occurrence: int, intended_at_ms: int) -> str:
    digest = _sha256_hex([intent_hash, occurrence, intended_at_ms])
    return ACTION_ID_PREFIX + digest[:ACTION_ID_HEX_LENGTH]
