from __future__ import annotations

from .canonical import CanonicalizationError, JsonValue, canonicalize

DEFAULT_MAX_RESULT_BYTES = 262_144


def stored_result_detail(result: JsonValue, max_bytes: int) -> dict[str, JsonValue]:
    try:
        size = len(canonicalize(result).encode("utf-8"))
    except CanonicalizationError as error:
        return {"result": None, "result_truncated": False, "result_error": str(error)}
    if size > max_bytes:
        return {"result": None, "result_truncated": True}
    return {"result": result, "result_truncated": False}
