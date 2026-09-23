"""Non-evaluating typed expression validation, independent of AST key names."""

from diagnostics import diagnostic, sorted_unique
from values import SORTABLE, valid_typed_value


def business_budget_errors(spec, prefix):
    """Preflight only resource budgets, without substituting for JSON Schema."""
    if not isinstance(spec, dict) or not isinstance(spec.get("record_rules"), list):
        return []
    errors = []
    for i, rule in enumerate(spec["record_rules"]):
        if not isinstance(rule, dict):
            continue
        path = (prefix + "." if prefix and prefix != "$" else "") + f"record_rules[{i}]"
        count = 0
        for key in ("when", "assert"):
            if count > 20:
                break
            if key not in rule:
                continue
            stack = [(rule[key], 1)]
            deep = False
            while stack and count <= 20:
                node, depth = stack.pop()
                if depth > 3:
                    deep = True
                    break
                if not isinstance(node, dict):
                    continue
                # Exclusivity is not established until the real Schema runs.
                # Inspect every recursive slot, including hidden mixed branches.
                if "field" in node:
                    count += 1
                for slot in ("all", "any"):
                    children = node.get(slot)
                    if isinstance(children, list):
                        # Each accepted child must eventually contain a leaf.
                        if len(children) > 20:
                            count = 21
                            break
                        stack.extend((child, depth + 1) for child in children)
                if "not" in node:
                    stack.append((node["not"], depth + 1))
            if deep:
                errors.append(diagnostic("CONSTRAINT_INCOMPATIBLE", path + "." + key))
        if count > 20:
            errors.append(diagnostic("CONSTRAINT_INCOMPATIBLE", path))
    return sorted_unique(errors)


def validate_operand(field, operator, value, context, has_value=True):
    if operator in ("is_empty", "not_empty"):
        return not has_value
    if not has_value:
        return False
    if operator in ("gt", "gte", "lt", "lte"):
        return (
            field["type"] in SORTABLE
            and value is not None
            and valid_typed_value(field, value, context, constraints=False)
        )
    if operator in ("eq", "ne"):
        return valid_typed_value(field, value, context, constraints=False)
    if operator in ("in", "not_in"):
        return isinstance(value, list) and all(
            valid_typed_value(field, v, context, constraints=False) for v in value
        )
    return False


def validate_expressions(roots, fields, context, rule_path):
    """roots=[(AST, path)]; Business when + assert share the leaf budget."""
    errors = []
    leaves = 0
    for root, path in roots:
        stack = [(root, path, 1)]
        too_deep = False
        while stack:
            expr, current, depth = stack.pop()
            if depth > 3:
                too_deep = True
                continue
            if "all" in expr or "any" in expr:
                key = "all" if "all" in expr else "any"
                stack.extend(
                    (child, f"{current}.{key}[{i}]", depth + 1)
                    for i, child in enumerate(expr[key])
                )
            elif "not" in expr:
                stack.append((expr["not"], current + ".not", depth + 1))
            else:
                leaves += 1
                field = fields.get(expr["field"])
                if field is None:
                    errors.append(
                        diagnostic("CONSTRAINT_INCOMPATIBLE", current + ".field")
                    )
                elif not validate_operand(
                    field, expr["operator"], expr.get("value"), context, "value" in expr
                ):
                    errors.append(diagnostic("CONSTRAINT_INCOMPATIBLE", current))
        if too_deep:
            errors.append(diagnostic("CONSTRAINT_INCOMPATIBLE", path))
    if leaves > 20:
        errors.append(diagnostic("CONSTRAINT_INCOMPATIBLE", rule_path))
    return sorted_unique(errors)
