"""Static safe references: resolve fixed behavior, never invoke capabilities."""
from diagnostics import diagnostic, sorted_unique
from expressions import validate_operand
from structure import validate_registered_schema
from view_registry import resolve_capability
from view_safety import child_path, walk, is_i18n_path


def check_capability(value, context, path):
    action = value["type"] == "ActionRef"
    key = "actionRef" if action else "queryRef"
    content, status = resolve_capability(value[key], context)
    if status != "ok":
        return None, [diagnostic("VIEW_CAPABILITY_DIGEST_MISMATCH" if status == "digest" else "VIEW_CAPABILITY_REF_INVALID", child_path(path, key))]
    code = "VIEW_ACTION_FORBIDDEN" if action else "VIEW_DATA_SOURCE_FORBIDDEN"
    if content["category"] != ("ACTION" if action else "QUERY"):
        return None, [diagnostic(code, child_path(path, key))]
    slot = "input" if action else "params"
    errors = validate_registered_schema(content["inputSchema"], value.get(slot, {}), child_path(path, slot), code)
    # Check all schemas are truly loadable by the same engine, not presence stubs.
    for schema_key in ("outputSchema", "errorSchema"):
        validate_registered_schema(content[schema_key], {}, "", code)
    return content, errors


def expression_errors(expr, fields, context, path):
    errors = []
    stack = [(expr, path)]
    while stack:
        node, current = stack.pop()
        if "all" in node or "any" in node:
            key = "all" if "all" in node else "any"
            stack.extend((child, f"{current}.{key}[{i}]") for i, child in enumerate(node[key]))
        elif "not" in node:
            stack.append((node["not"], child_path(current, "not")))
        else:
            field = fields.get(node["left"]["fieldRef"])
            if field is not None and not validate_operand(field, node["operator"], node.get("right"), context, "right" in node):
                errors.append(diagnostic("VIEW_EXPRESSION_UNSAFE", current))
    return errors


def field_reference_errors(spec, fields, prefix):
    """Field existence only; no capabilities or resolver calls."""
    return [diagnostic("VIEW_FIELD_REF_INVALID", child_path(path, "fieldRef"))
            for value, path in walk(spec, prefix)
            if isinstance(value, dict) and not is_i18n_path(path)
            and value.get("type") == "FieldRef" and value["fieldRef"] not in fields]


def validate_bindings(spec, context, prefix, fields):
    errors = field_reference_errors(spec, fields, prefix)
    queries = {}
    for index, entry in enumerate(spec.get("queries", [])):
        path = child_path(child_path(prefix, "queries"), index)
        if entry["query_code"] in queries:
            errors.append(diagnostic("VIEW_DATA_SOURCE_FORBIDDEN", child_path(path, "query_code")))
        else:
            content, _ = check_capability(entry["query"], context, child_path(path, "query"))
            queries[entry["query_code"]] = content
    i18n = spec.get("i18n", {})
    for value, path in walk(spec, prefix):
        if not isinstance(value, dict) or is_i18n_path(path):
            continue
        kind = value.get("type")
        if kind == "I18nRef":
            if not any(value["key"] in messages for messages in i18n.values()):
                errors.append(diagnostic("VIEW_PROP_INVALID", child_path(path, "key")))
        elif kind == "SafeExpression":
            errors.extend(expression_errors(value, fields, context, path))
        elif kind in ("ActionRef", "DataQueryRef"):
            _, found = check_capability(value, context, path)
            errors.extend(found)
        elif kind == "DataBindingRef":
            if value["queryCode"] not in queries:
                errors.append(diagnostic("VIEW_DATA_SOURCE_FORBIDDEN", child_path(path, "queryCode")))
            else:
                query = queries[value["queryCode"]]
                if query is not None and value["itemKey"] not in query["itemKeys"]:
                    errors.append(diagnostic("VIEW_DATA_SOURCE_FORBIDDEN", child_path(path, "itemKey")))
    return sorted_unique(errors)
