from __future__ import annotations

import json
import math
import re
from typing import TypeAlias

JsonValue: TypeAlias = None | bool | int | float | str | list["JsonValue"] | dict[str, "JsonValue"]

IDENTIFIER = re.compile(r"[A-Za-z_$][A-Za-z0-9_$]*")
SURROGATE = re.compile("[\ud800-\udfff]")
NON_FINITE_NAMES = {math.inf: "Infinity", -math.inf: "-Infinity"}


class CanonicalizationError(ValueError):
    def __init__(self, path: str, problem: str) -> None:
        super().__init__(f"cannot canonicalize {problem} at {path}")
        self.path = path


def _quote(text: str) -> str:
    return json.dumps(text, ensure_ascii=False)


def _member_path(parent: str, key: str) -> str:
    if IDENTIFIER.fullmatch(key):
        return f"{parent}.{key}"
    return (
        parent
        + "["
        + SURROGATE.sub(lambda match: f"\\u{ord(match.group()):04x}", _quote(key))
        + "]"
    )


def _string(value: str, path: str) -> str:
    if SURROGATE.search(value):
        raise CanonicalizationError(path, "a string with a lone surrogate")
    return _quote(value)


def _digits_and_point(value: float) -> tuple[str, int]:
    mantissa, _, exponent = repr(value).partition("e")
    whole, _, fraction = mantissa.partition(".")
    digits = whole + fraction
    point = len(whole) + (int(exponent) if exponent else 0)
    stripped = digits.lstrip("0")
    point -= len(digits) - len(stripped)
    return stripped.rstrip("0"), point


def format_number(value: float) -> str:
    if value == 0:
        return "0"
    sign = "-" if value < 0 else ""
    digits, point = _digits_and_point(abs(value))
    count = len(digits)
    if count <= point <= 21:
        return sign + digits + "0" * (point - count)
    if 0 < point <= 21:
        return sign + digits[:point] + "." + digits[point:]
    if -6 < point <= 0:
        return sign + "0." + "0" * -point + digits
    exponent = point - 1
    exponent_text = ("+" if exponent >= 0 else "-") + str(abs(exponent))
    if count == 1:
        return f"{sign}{digits}e{exponent_text}"
    return f"{sign}{digits[0]}.{digits[1:]}e{exponent_text}"


def _number(value: float, path: str) -> str:
    if math.isnan(value):
        raise CanonicalizationError(path, "the non-finite number NaN")
    if math.isinf(value):
        raise CanonicalizationError(path, f"the non-finite number {NON_FINITE_NAMES[value]}")
    return format_number(value)


def _integer(value: int, path: str) -> str:
    try:
        return format_number(float(value))
    except OverflowError:
        raise CanonicalizationError(path, "an integer too large for a double") from None


def _serialize(value: object, path: str, ancestors: set[int]) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int):
        return _integer(value, path)
    if isinstance(value, float):
        return _number(value, path)
    if isinstance(value, str):
        return _string(value, path)
    if isinstance(value, (list, tuple, dict)):
        if id(value) in ancestors:
            raise CanonicalizationError(path, "a cyclic reference")
        ancestors.add(id(value))
        try:
            if isinstance(value, dict):
                return _object(value, path, ancestors)
            items = (
                _serialize(item, f"{path}[{index}]", ancestors) for index, item in enumerate(value)
            )
            return "[" + ",".join(items) + "]"
        finally:
            ancestors.discard(id(value))
    raise CanonicalizationError(path, f"a value of type {type(value).__name__}")


def _utf16_key(key: str) -> bytes:
    return key.encode("utf-16-be", "surrogatepass")


def _object(value: dict[object, object], path: str, ancestors: set[int]) -> str:
    if not all(isinstance(key, str) for key in value):
        raise CanonicalizationError(path, "an object with a key that is not a string")
    members: list[str] = []
    for key in sorted((str(key) for key in value), key=_utf16_key):
        key_path = _member_path(path, key)
        members.append(_string(key, key_path) + ":" + _serialize(value[key], key_path, ancestors))
    return "{" + ",".join(members) + "}"


def canonicalize(value: object) -> str:
    return _serialize(value, "$", set())
