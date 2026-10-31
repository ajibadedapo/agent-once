from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Literal, Protocol

from .canonical import JsonValue

EvidenceKind = Literal["decision", "state", "resolve", "reconcile"]


@dataclass(frozen=True)
class EvidenceEvent:
    v: int
    at_ms: int
    kind: EvidenceKind
    tool: str
    session_key: str
    detail: dict[str, JsonValue]
    action_id: str | None = None

    def to_json(self) -> dict[str, JsonValue]:
        encoded: dict[str, JsonValue] = {"v": self.v, "atMs": self.at_ms, "kind": self.kind}
        if self.action_id is not None:
            encoded["actionId"] = self.action_id
        encoded.update({"tool": self.tool, "sessionKey": self.session_key, "detail": self.detail})
        return encoded


class EvidenceSink(Protocol):
    def emit(self, event: EvidenceEvent) -> None: ...


class JsonlEvidence:
    def __init__(self, path: str) -> None:
        self._path = path
        self._directory_ready = False

    def emit(self, event: EvidenceEvent) -> None:
        if not self._directory_ready:
            os.makedirs(os.path.dirname(self._path) or ".", exist_ok=True)
            self._directory_ready = True
        line = json.dumps(
            event.to_json(), ensure_ascii=False, separators=(",", ":"), allow_nan=False
        )
        with open(self._path, "a", encoding="utf-8") as handle:
            handle.write(line + "\n")
