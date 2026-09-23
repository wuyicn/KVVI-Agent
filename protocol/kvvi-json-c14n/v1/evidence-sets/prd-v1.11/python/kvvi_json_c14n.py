#!/usr/bin/env python3
"""Independent Python reference implementation of kvvi-json-c14n/v1."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import hashlib
import json
import re
import sys
from typing import Any


PROFILE = "kvvi-json-c14n/v1"
SAFE_INTEGER_LIMIT = 9_007_199_254_740_991
NUMBER_TOKEN = re.compile(
    r"^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?)(\d+))?$"
)


class CanonicalizationError(Exception):
    def __init__(self, error_code: str) -> None:
        super().__init__(error_code)
        self.error_code = error_code


@dataclass(frozen=True)
class JsonNumber:
    token: str


def _reject_constant(_: str) -> JsonNumber:
    raise CanonicalizationError("CANON_JSON_INVALID")


def _validate_unicode_scalar_string(value: str) -> None:
    if any(0xD800 <= ord(character) <= 0xDFFF for character in value):
        raise CanonicalizationError("CANON_INVALID_UNICODE")


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        _validate_unicode_scalar_string(key)
        if key in result:
            raise CanonicalizationError("CANON_DUPLICATE_KEY")
        result[key] = value
    return result


def _parse_bounded_nonnegative_decimal(text: str, cap: int) -> int | None:
    """Parse a decimal exponent only when it is no greater than cap."""
    normalized = text.lstrip("0") or "0"
    cap_text = str(cap)
    if len(normalized) > len(cap_text):
        return None
    if len(normalized) == len(cap_text) and normalized > cap_text:
        return None
    return int(normalized)


def _parse_json_number(number: JsonNumber) -> int:
    match = NUMBER_TOKEN.fullmatch(number.token)
    if match is None:
        raise CanonicalizationError("CANON_NUMBER_UNSUPPORTED")

    negative = match.group(1) == "-"
    fraction = match.group(3) or ""
    exponent_sign = match.group(4) or "+"
    exponent_digits = match.group(5) or "0"
    digits = f"{match.group(2)}{fraction}".lstrip("0")

    if not digits:
        return 0

    fraction_length = len(fraction)
    if exponent_sign == "-":
        remaining_integer_digits = len(digits) - fraction_length
        if remaining_integer_digits <= 0:
            raise CanonicalizationError("CANON_NUMBER_UNSUPPORTED")
        exponent = _parse_bounded_nonnegative_decimal(
            exponent_digits,
            remaining_integer_digits - 1,
        )
        if exponent is None:
            raise CanonicalizationError("CANON_NUMBER_UNSUPPORTED")
        scale = fraction_length + exponent
    else:
        exponent = _parse_bounded_nonnegative_decimal(
            exponent_digits,
            fraction_length + 16,
        )
        if exponent is None:
            raise CanonicalizationError("CANON_NUMBER_OUT_OF_RANGE")
        scale = fraction_length - exponent

    if scale > 0:
        if scale >= len(digits) or not digits.endswith("0" * scale):
            raise CanonicalizationError("CANON_NUMBER_UNSUPPORTED")
        digits = digits[:-scale]
    elif scale < 0:
        zero_count = -scale
        if len(digits) + zero_count > 16:
            raise CanonicalizationError("CANON_NUMBER_OUT_OF_RANGE")
        digits += "0" * zero_count

    if len(digits) > 16:
        raise CanonicalizationError("CANON_NUMBER_OUT_OF_RANGE")
    if len(digits) == 16 and digits > str(SAFE_INTEGER_LIMIT):
        raise CanonicalizationError("CANON_NUMBER_OUT_OF_RANGE")

    magnitude = int(digits)
    return -magnitude if negative else magnitude


def _parse_json_text(raw_text: str) -> Any:
    try:
        return json.loads(
            raw_text,
            object_pairs_hook=_unique_object,
            parse_int=JsonNumber,
            parse_float=JsonNumber,
            parse_constant=_reject_constant,
        )
    except CanonicalizationError:
        raise
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise CanonicalizationError("CANON_JSON_INVALID") from exc


def _escape_string(value: str) -> str:
    _validate_unicode_scalar_string(value)
    escaped: list[str] = ['"']
    short_escapes = {
        '"': '\\"',
        "\\": "\\\\",
        "\b": "\\b",
        "\t": "\\t",
        "\n": "\\n",
        "\f": "\\f",
        "\r": "\\r",
    }
    for character in value:
        if character in short_escapes:
            escaped.append(short_escapes[character])
        elif ord(character) <= 0x1F:
            escaped.append(f"\\u{ord(character):04x}")
        else:
            escaped.append(character)
    escaped.append('"')
    return "".join(escaped)


def _canonicalize(value: Any) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, JsonNumber):
        return str(_parse_json_number(value))
    if isinstance(value, str):
        return _escape_string(value)
    if isinstance(value, list):
        return "[" + ",".join(_canonicalize(item) for item in value) + "]"
    if isinstance(value, dict):
        ordered_keys = sorted(value, key=lambda key: key.encode("utf-8"))
        members = (
            f"{_escape_string(key)}:{_canonicalize(value[key])}"
            for key in ordered_keys
        )
        return "{" + ",".join(members) + "}"
    raise CanonicalizationError("CANON_JSON_INVALID")


def canonicalize_json(raw_text: str, profile: str = PROFILE) -> dict[str, str]:
    if profile != PROFILE:
        raise CanonicalizationError("CANON_PROFILE_UNSUPPORTED")
    parsed = _parse_json_text(raw_text)
    canonical = _canonicalize(parsed)
    canonical_bytes = canonical.encode("utf-8")
    return {
        "status": "ok",
        "profile": PROFILE,
        "canonical": canonical,
        "canonical_utf8_hex": canonical_bytes.hex(),
        "digest": f"sha256:{hashlib.sha256(canonical_bytes).hexdigest()}",
    }


def _emit(payload: dict[str, str]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    sys.stdout.write("\n")


def main() -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--profile", required=True)
    arguments = parser.parse_args()

    try:
        raw_text = sys.stdin.buffer.read().decode("utf-8")
        result = canonicalize_json(raw_text, arguments.profile)
    except UnicodeDecodeError:
        _emit({"status": "error", "error_code": "CANON_INVALID_UNICODE"})
        return 2
    except CanonicalizationError as exc:
        _emit({"status": "error", "error_code": exc.error_code})
        return 2

    _emit(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
