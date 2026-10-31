from __future__ import annotations

IDEMPOTENCY_KEY_HEADER = "Idempotency-Key"


def idempotency_headers(key: str) -> dict[str, str]:
    return {IDEMPOTENCY_KEY_HEADER: key}
