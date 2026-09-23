"""Business static semantics. Caller must first run the real structure engine."""

import re
from diagnostics import diagnostic, sorted_unique
from values import compare_decimal, valid_date, valid_typed_value
from safe_pattern import parse_safe_pattern
from expressions import validate_expressions
from business_history import validate_history
from secret_safety import validate_secrets

PLATFORM = {
    "id",
    "tenant_id",
    "form_code",
    "schema_version",
    "status",
    "owner_id",
    "created_by",
    "updated_by",
    "created_at",
    "updated_at",
}
RESERVED = PLATFORM | {"data", "record_no"}


def validate_business(spec, context, prefix):
    errors = validate_secrets(spec, prefix)

    def path(p):
        return (prefix + "." if prefix and prefix != "$" else "") + p

    def add(p, code="CONSTRAINT_INCOMPATIBLE"):
        errors.append(diagnostic(code, path(p)))

    def text_check(text, p):
        if re.search(r"</?[A-Za-z][A-Za-z0-9:-]*(?:[ \t\r\n/>])|<![A-Za-z-]", text):
            add(p, "ARBITRARY_EXPRESSION_FORBIDDEN")

    if "description" in spec:
        text_check(spec["description"], "description")
    config = context.get("business")
    if config is None:
        return [diagnostic("DEPENDENCY_VALIDATOR_UNAVAILABLE", prefix)]
    fields = {}
    numbering = spec.get("record_number", {}).get("field_code")
    if (
        numbering in PLATFORM
        or numbering == "data"
        or (numbering and numbering.startswith("_platform_"))
    ):
        add("record_number.field_code", "FIELD_CODE_INVALID")
    for i, f in enumerate(spec["fields"]):
        p = f"fields[{i}]"
        code = f["field_code"]
        kind = f["type"]
        cfg = f.get("type_config", {})
        limits = f.get("constraints", {})
        if "description" in f:
            text_check(f["description"], p + ".description")
        if code in RESERVED or code.startswith("_platform_") or code == numbering:
            add(p + ".field_code", "FIELD_CODE_INVALID")
        if code in fields:
            add(p + ".field_code", "FIELD_CODE_DUPLICATE")
        fields[code] = f
        if kind not in config.get("enabled_types", []):
            add(p + ".type", "FIELD_TYPE_UNREGISTERED")
        if f["required"] and f["nullable"]:
            add(p + ".nullable")
        if f["write_policy"] == "SYSTEM" and not any(
            g.get("schema_code") == spec["schema_code"]
            and g.get("field_code") == code
            and g.get("type") == kind
            for g in config.get("generators", [])
        ):
            add(p + ".write_policy")
        if f["query"]["searchable"] and kind not in (
            "short_text",
            "long_text",
            "single_select",
            "multi_select",
        ):
            add(p + ".query.searchable")
        if f["query"]["sortable"] and kind in ("long_text", "multi_select"):
            add(p + ".query.sortable")
        valid_limits = True
        if kind == "short_text":
            if limits.get("min_length", 0) > limits.get("max_length", 255):
                add(p + ".constraints")
                valid_limits = False
            if "pattern" in limits and not parse_safe_pattern(limits["pattern"]).valid:
                add(p + ".constraints.pattern")
                valid_limits = False
        if kind == "decimal" and cfg.get("scale", 2) > cfg.get("precision", 18):
            add(p + ".type_config")
            valid_limits = False
        if kind == "money" and not config.get("money_rules", {}).get(cfg["currency"]):
            add(p + ".type_config", "DEPENDENCY_VALIDATOR_UNAVAILABLE")
            valid_limits = False
        if kind in ("single_select", "multi_select"):
            seen = set()
            for j, o in enumerate(cfg["options"]):
                if o["code"] in seen:
                    add(p + f".type_config.options[{j}].code")
                seen.add(o["code"])
        if kind == "date":
            for key in ("minimum", "maximum"):
                if key in limits and not valid_date(limits[key]):
                    add(p + ".constraints." + key)
                    valid_limits = False
        if valid_limits and "minimum" in limits and "maximum" in limits:
            reverse = (
                compare_decimal(limits["minimum"], limits["maximum"]) > 0
                if kind in ("decimal", "money")
                else limits["minimum"] > limits["maximum"]
            )
            if reverse:
                add(p + ".constraints")
                valid_limits = False
        if (
            valid_limits
            and "default" in f
            and not valid_typed_value(f, f["default"], context)
        ):
            add(p + ".default")
    index_codes = set()
    for i, index in enumerate(spec.get("indexes", [])):
        p = f"indexes[{i}]"
        if index["index_code"] in index_codes:
            add(p + ".index_code")
        index_codes.add(index["index_code"])
        seen = set()
        for j, code in enumerate(index["fields"]):
            f = fields.get(code)
            if (
                code in seen
                or (f is None and code != numbering)
                or (f and (f["type"] == "long_text" and index["kind"] == "UNIQUE"))
            ):
                add(p + f".fields[{j}]")
            if f:
                capabilities = config.get("index_capabilities", {}).get(f["type"])
                if capabilities is None:
                    add(p + f".fields[{j}]", "DEPENDENCY_VALIDATOR_UNAVAILABLE")
                elif index["kind"] not in capabilities:
                    add(p + f".fields[{j}]")
            seen.add(code)
    used = set()
    sections = set()
    for i, s in enumerate(spec.get("layout", {}).get("sections", [])):
        p = f"layout.sections[{i}]"
        text_check(s["title"], p + ".title")
        if "description" in s:
            text_check(s["description"], p + ".description")
        if s["section_code"] in sections:
            add(p + ".section_code")
        sections.add(s["section_code"])
        for j, item in enumerate(s["items"]):
            if item["kind"] != "field":
                text_check(item["text"], p + f".items[{j}].text")
                continue
            ip = p + f".items[{j}]"
            code = item["field_code"]
            if code not in fields and code not in PLATFORM and code != numbering:
                add(ip + ".field_code")
            if code in fields and code in used:
                add(ip + ".field_code")
            if item["col_span"] > s["columns"]:
                add(ip + ".col_span")
            used.add(code)
    rules = set()
    for i, r in enumerate(spec.get("record_rules", [])):
        p = f"record_rules[{i}]"
        if r["rule_code"] in rules:
            add(p + ".rule_code")
        rules.add(r["rule_code"])
        roots = [(r[k], path(p + "." + k)) for k in ("when", "assert") if k in r]
        errors.extend(validate_expressions(roots, fields, context, path(p)))
    errors.extend(validate_history(spec, context, prefix))
    return sorted_unique(errors)
