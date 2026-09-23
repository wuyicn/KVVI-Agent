"""Iterative View preflight: budgets and forbidden executable shapes, no evaluation."""
import json
import re

from diagnostics import diagnostic, sorted_unique

RAW_KEYS = {
    "JSExpression", "JSFunction", "script", "html", "css", "style", "styles",
    "methods", "utils", "lifeCycles", "lifecycle", "package", "npm", "exportName",
    "componentsMap", "cdn", "render", "dangerouslySetInnerHTML", "innerHTML",
}
DATA_KEYS = {"url", "uri", "headers", "header", "token", "sql", "graphql", "dataSource", "request", "fetch", "requestFunction"}
DYNAMIC = {"props", "actions", "input", "params", "i18n"}

# view-static-lexical-r1: controller ruling 17, documented in VIEW.md.
# Explicit characters and ASCII folding avoid host Unicode regex acceptance drift.
SCANNER_SPACE = "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
_SPACE = "[" + SCANNER_SPACE + "]"
_ASCII_FOLD = str.maketrans("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz")
_MARKUP = re.compile(r"<" + _SPACE + r"*(?:/?[a-z][^>]*|!|\?)>|javascript" + _SPACE + r"*:|data" + _SPACE + r"*:" + _SPACE + r"*text/html")
_CALL = re.compile(r"function" + _SPACE + r"*(?:[A-Za-z_$][A-Za-z0-9_$]*" + _SPACE + r"*)?\(|(?:eval|Function|import)" + _SPACE + r"*\(")
_DATA = re.compile(r"^" + _SPACE + r"*(?:https?://|(?:select|insert|update|delete)" + _SPACE + r"+|(?:query|mutation)" + _SPACE + r"*[{(])")


def string_safety_code(value, path):
    folded = value.translate(_ASCII_FOLD)
    if _MARKUP.search(folded):
        return "VIEW_RAW_CODE_FORBIDDEN"
    # A dictionary key that spells ".props[" cannot turn its message into code.
    if re.match(r'^(?:spec\.)?i18n\[', path):
        return None
    if not re.search(r"\.(?:props|input|params)\[|\.condition(?:\.|$)", path):
        return None
    if "=>" in value:
        return "VIEW_RAW_CODE_FORBIDDEN"
    for match in _CALL.finditer(value):
        before = value[match.start() - 1] if match.start() else None
        if before is None or before in SCANNER_SPACE or (
            ord(before) < 128 and not (before.isalnum() or before in "_$")
        ):
            return "VIEW_RAW_CODE_FORBIDDEN"
    if ".params[" in path and _DATA.search(folded):
        return "VIEW_DATA_SOURCE_FORBIDDEN"
    return None


def is_i18n_path(path):
    """Only the two dictionary containers, not an illegal object-valued message."""
    return re.fullmatch(r'(?:spec\.)?i18n(?:\["(?:[^"\\]|\\.)*"\])?', path) is not None


def child_path(path, key, dynamic=False):
    base = "" if path == "$" else path
    if isinstance(key, int):
        return base + f"[{key}]"
    if dynamic or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
        return base + "[" + json.dumps(key, ensure_ascii=False) + "]"
    return base + ("." if base else "") + key


def walk(value, prefix=""):
    stack = [(value, prefix, False)]
    while stack:
        current, path, dynamic = stack.pop()
        yield current, path
        if isinstance(current, dict):
            for key, item in reversed(list(current.items())):
                stack.append((
                    item, child_path(path, key, dynamic),
                    key in DYNAMIC or dynamic and (path.endswith(".i18n") or path == "i18n"),
                ))
        elif isinstance(current, list):
            stack.extend((item, child_path(path, i), False) for i, item in reversed(list(enumerate(current))))


def expression_over_budget(root):
    leaves = 0
    stack = [(root, 1)]
    while stack:
        value, depth = stack.pop()
        if depth > 3:
            return True
        if not isinstance(value, dict):
            continue
        if "left" in value:
            leaves += 1
        if leaves > 20:
            return True
        # Every branch is inspected before Schema establishes exclusivity.
        for key in ("all", "any"):
            items = value.get(key)
            if isinstance(items, list):
                if len(items) > 20:
                    return True
                stack.extend((item, depth + 1) for item in items)
        if "not" in value:
            stack.append((value["not"], depth + 1))
    return False


def view_preflight(spec, prefix=""):
    if not isinstance(spec, dict):
        return []
    errors = []
    for value, path in walk(spec, prefix):
        if isinstance(value, dict) and not is_i18n_path(path):
            for key in value:
                code = "VIEW_RAW_CODE_FORBIDDEN" if key in RAW_KEYS else "VIEW_DATA_SOURCE_FORBIDDEN" if key in DATA_KEYS else None
                if code:
                    dynamic = path.endswith((".props", ".actions", ".input", ".params")) or path in DYNAMIC
                    errors.append(diagnostic(code, child_path(path, key, dynamic)))
            if value.get("type") in ("JSExpression", "JSFunction"):
                errors.append(diagnostic("VIEW_RAW_CODE_FORBIDDEN", path))
        elif isinstance(value, str):
            code = string_safety_code(value, path)
            if code:
                errors.append(diagnostic(code, path))
    if errors:
        return sorted_unique(errors)
    # Count tree budget before a recursive schema or serializer sees the tree.
    roots = spec.get("componentsTree")
    stack = [(node, 1) for node in roots] if isinstance(roots, list) else []
    count = 0
    while stack:
        node, depth = stack.pop()
        count += 1
        if count > 500 or depth > 20:
            errors.append(diagnostic("VIEW_LIMIT_EXCEEDED", child_path(prefix, "componentsTree")))
            break
        if isinstance(node, dict) and isinstance(node.get("children"), list):
            stack.extend((child, depth + 1) for child in node["children"])
    expression_paths = []
    for value, path in walk(spec, prefix):
        if any(path.startswith(parent + ".") or path.startswith(parent + "[") for parent in expression_paths):
            continue
        if (
            isinstance(value, dict)
            and not is_i18n_path(path)
            and (value.get("type") == "SafeExpression" or any(key in value for key in ("all", "any", "not", "left")))
            and expression_over_budget(value)
        ):
            errors.append(diagnostic("VIEW_EXPRESSION_UNSAFE", path))
            expression_paths.append(path)
    if errors:
        return sorted_unique(errors)
    # Input has already passed c14n; serialized integer/Unicode domain is identical.
    size = len(json.dumps(spec, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8"))
    if size > 1048576:
        return [diagnostic("VIEW_LIMIT_EXCEEDED", prefix)]
    for locale, messages in spec.get("i18n", {}).items() if isinstance(spec.get("i18n"), dict) else []:
        if isinstance(messages, dict):
            for key in messages:
                path = child_path(child_path(child_path(prefix, "i18n"), locale, True), key, True)
                if len(key) > 128:
                    errors.append(diagnostic("VIEW_LIMIT_EXCEEDED", path))
                elif len(key) == 0:
                    errors.append(diagnostic("VIEW_PROP_INVALID", path))
    return sorted_unique(errors)
