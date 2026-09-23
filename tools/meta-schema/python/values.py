"""Exact Business values. Decimal comparisons never use host floating point."""

import re
from datetime import date
from safe_pattern import SPACES, parse_safe_pattern, match_safe_pattern

DECIMAL = re.compile(r"-?(0|[1-9][0-9]*)(\.[0-9]+)?\Z")
DATE = re.compile(r"([0-9]{4})-([0-9]{2})-([0-9]{2})\Z")
DATETIME = re.compile(
    r"([0-9]{4}-[0-9]{2}-[0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]+))?(Z|[+-][0-9]{2}:[0-9]{2})\Z"
)
SORTABLE = {
    "boolean",
    "short_text",
    "integer",
    "decimal",
    "money",
    "date",
    "datetime",
    "single_select",
}


def decimal_parts(value):
    if not isinstance(value, str) or not DECIMAL.fullmatch(value):
        return None
    negative = value.startswith("-")
    body = value[1:] if negative else value
    whole, _, fraction = body.partition(".")
    return negative, whole, fraction


def compare_decimal(left, right):
    a = decimal_parts(left)
    b = decimal_parts(right)
    if a is None or b is None:
        raise ValueError("invalid decimal")
    an, aw, af = a
    bn, bw, bf = b
    an = an and any(c != "0" for c in aw + af)
    bn = bn and any(c != "0" for c in bw + bf)
    if an != bn:
        return -1 if an else 1
    width = max(len(af), len(bf))
    av = (len(aw), aw, af.ljust(width, "0"))
    bv = (len(bw), bw, bf.ljust(width, "0"))
    result = (av > bv) - (av < bv)
    return -result if an else result


def fits_decimal(value, precision, scale):
    parts = decimal_parts(value)
    if parts is None:
        return False
    _, whole, fraction = parts
    return len(fraction) <= scale and len(whole.lstrip("0")) <= precision - scale


def valid_date(value):
    if not isinstance(value, str):
        return False
    m = DATE.fullmatch(value)
    if not m:
        return False
    try:
        date(*map(int, m.groups()))
        return True
    except ValueError:
        return False


def valid_datetime(value):
    if not isinstance(value, str):
        return False
    m = DATETIME.fullmatch(value)
    if not m or not valid_date(m[1]):
        return False
    if int(m[2]) > 23 or int(m[3]) > 59 or int(m[4]) > 59:
        return False
    zone = m[6]
    return zone == "Z" or (int(zone[1:3]) <= 23 and int(zone[4:6]) <= 59)


def valid_typed_value(field, value, context, *, constraints=True):
    """Pure typed operand API; constraints=False checks type/config, not bounds.

    Task3 can pass the resolved Business field and right operand independently
    of the View AST's left/operator/right key spelling.
    """
    if value is None:
        return field["nullable"]
    kind = field["type"]
    cfg = field.get("type_config", {})
    limits = field.get("constraints", {}) if constraints else {}
    if kind in ("short_text", "long_text"):
        if not isinstance(value, str):
            return False
        text = value.strip(SPACES) if limits.get("trim") else value
        if (
            len(text) > limits.get("max_length", 255 if kind == "short_text" else 5000)
            and constraints
        ):
            return False
        if len(text) < limits.get("min_length", 0):
            return False
        if "pattern" in limits and not match_safe_pattern(
            parse_safe_pattern(limits["pattern"]), text
        ):
            return False
    elif kind == "boolean":
        return type(value) is bool
    elif kind == "integer":
        if type(value) is not int or not -9007199254740991 <= value <= 9007199254740991:
            return False
    elif kind == "decimal":
        if not fits_decimal(value, cfg.get("precision", 18), cfg.get("scale", 2)):
            return False
    elif kind == "money":
        rule = (
            context.get("business", {}).get("money_rules", {}).get(cfg.get("currency"))
        )
        if (
            not rule
            or not isinstance(value, dict)
            or set(value) != {"amount", "currency"}
            or value["currency"] != cfg["currency"]
        ):
            return False
        if not fits_decimal(value["amount"], rule["precision"], rule["scale"]):
            return False
        value = value["amount"]
    elif kind == "date":
        if not valid_date(value):
            return False
    elif kind == "datetime":
        return valid_datetime(value)
    elif kind in ("single_select", "multi_select"):
        enabled = {o["code"] for o in cfg["options"] if o["enabled"] or not constraints}
        if kind == "single_select":
            return isinstance(value, str) and value in enabled
        return (
            isinstance(value, list)
            and all(isinstance(v, str) and v in enabled for v in value)
            and len(set(value)) == len(value)
            and (not constraints or len(value) <= limits.get("max_items", 20))
        )
    else:
        return False
    for key, direction in [("minimum", -1), ("maximum", 1)]:
        if key not in limits:
            continue
        cmp = (
            compare_decimal(value, limits[key])
            if kind in ("decimal", "money")
            else (value > limits[key]) - (value < limits[key])
        )
        if cmp == direction:
            return False
    return True
