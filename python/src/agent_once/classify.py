from __future__ import annotations

import re
from collections.abc import Sequence

from .ledger import ToolClass

DEFAULT_SIDE_EFFECT_PATTERNS: tuple[str, ...] = (
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
)

DEFAULT_MONEY_PATTERNS: tuple[str, ...] = (
    "pay",
    "buy",
    "checkout",
    "purchase",
    "charge",
    "order",
    "payment",
    "transfer",
)

DEFAULT_IRREVERSIBLE_PATTERNS: tuple[str, ...] = ("delete", "publish", "send", "deploy")

LOWER_THEN_UPPER = re.compile(r"([a-z0-9])([A-Z])")
ACRONYM_THEN_WORD = re.compile(r"([A-Z]+)([A-Z][a-z])")
SEPARATORS = re.compile(r"[\W_]+")


def _words(text: str) -> list[str]:
    split = ACRONYM_THEN_WORD.sub(r"\1 \2", LOWER_THEN_UPPER.sub(r"\1 \2", text))
    return [word for word in SEPARATORS.split(split.lower()) if word]


def _as_phrase(text: str) -> str:
    return f" {' '.join(_words(text))} "


def _contains_pattern(phrase: str, patterns: Sequence[str]) -> bool:
    for pattern in patterns:
        wanted = _words(pattern)
        if wanted and f" {' '.join(wanted)} " in phrase:
            return True
    return False


def matches_any_pattern(name: str, text: str, patterns: Sequence[str]) -> bool:
    return _contains_pattern(_as_phrase(name), patterns) or _contains_pattern(
        _as_phrase(text), patterns
    )


def classify_tool(
    name: str,
    text: str,
    money: Sequence[str] = DEFAULT_MONEY_PATTERNS,
    irreversible: Sequence[str] = DEFAULT_IRREVERSIBLE_PATTERNS,
) -> ToolClass:
    if matches_any_pattern(name, text, money):
        return "money"
    if matches_any_pattern(name, text, irreversible):
        return "irreversible"
    return "standard"
