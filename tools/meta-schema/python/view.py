"""View static validation against exact, content-bound Fake assets."""
from diagnostics import diagnostic, sorted_unique
from structure import validate_structure, validate_registered_schema
from view_bindings import validate_bindings
from view_locale import valid_locale
from view_registry import resolve_asset
from view_safety import child_path
from secret_safety import validate_secrets


def validate_view(spec, context, prefix):
    # Public module is safe for direct callers too, not only CLI dispatch.
    structure_errors = validate_structure("view-schema/lce-safe-v1", "spec", spec)
    if structure_errors:
        base = "" if prefix in ("", "$") else prefix
        for error in structure_errors:
            suffix = "" if error["path"] == "$" else error["path"]
            separator = "." if base and suffix and not suffix.startswith("[") else ""
            error["path"] = base + separator + suffix or "$"
        return structure_errors
    registry, status = resolve_asset(spec["componentRegistryRef"], context)
    if (
        status != "ok"
        or registry.get("fixture") is not True
        or registry.get("state") != "PUBLISHED"
        or registry.get("version") != spec["componentRegistryRef"]["version"]
    ):
        return [diagnostic("VIEW_COMPONENT_UNREGISTERED", child_path(prefix, "componentRegistryRef"))]
    business, status = resolve_asset(spec["businessSchemaRef"], context)
    if status != "ok":
        return [diagnostic("VIEW_REFERENCE_VERSION_CONFLICT", child_path(prefix, "businessSchemaRef"))]
    fields = {field["field_code"]: field for field in business["fields"]}
    components = {item["componentName"]: item for item in registry["components"]}
    errors = validate_secrets(spec, prefix)
    seen = set(context.get("view", {}).get("deleted_node_ids") or [])
    stack = [(n, child_path(child_path(prefix, "componentsTree"), i), None) for i, n in enumerate(spec["componentsTree"])]
    while stack:
        node, path, parent = stack.pop()
        if node["id"] in seen:
            errors.append(diagnostic("VIEW_NODE_ID_DUPLICATE", child_path(path, "id")))
        seen.add(node["id"])
        definition = components.get(node["componentName"])
        if (
            definition is None
            or definition.get("state") != "PUBLISHED"
            or type(definition.get("version")) is not int
            or not 1 <= definition["version"] <= 9007199254740991
            or spec["view_type"] not in definition.get("viewTypes", [])
        ):
            errors.append(diagnostic("VIEW_COMPONENT_UNREGISTERED", child_path(path, "componentName")))
            continue
        if parent is None and definition["allowedParents"] or parent is not None and parent not in definition["allowedParents"]:
            errors.append(diagnostic("VIEW_CHILD_NOT_ALLOWED", path))
        props = node.get("props", {})
        errors.extend(validate_registered_schema(definition["propsSchema"], props, child_path(path, "props"), "VIEW_PROP_INVALID"))
        for prop, value in props.items():
            if isinstance(value, dict) and "type" in value and value["type"] not in definition["bindingPositions"].get(prop, []):
                errors.append(diagnostic("VIEW_PROP_INVALID", child_path(child_path(path, "props"), prop, True)))
        binding = props.get("fieldBinding")
        if isinstance(binding, dict) and binding.get("type") == "FieldRef":
            field = fields.get(binding["fieldRef"])
            if field and field["type"] not in definition["fieldTypes"]:
                errors.append(diagnostic("VIEW_FIELD_REF_INVALID", child_path(child_path(path, "props"), "fieldBinding", True)))
        if "loopArgs" in node and "loop" not in node:
            errors.append(diagnostic("VIEW_PROP_INVALID", child_path(path, "loopArgs")))
        if "loop" in node and not definition["loopSupported"]:
            errors.append(diagnostic("VIEW_PROP_INVALID", child_path(path, "loop")))
        for event, action in node.get("actions", {}).items():
            event_path = child_path(child_path(path, "actions"), event, True)
            if event not in definition["events"]:
                errors.append(diagnostic("VIEW_ACTION_FORBIDDEN", event_path))
            elif action["actionRef"]["capability_code"] not in definition["events"][event]:
                errors.append(diagnostic("VIEW_ACTION_FORBIDDEN", child_path(event_path, "actionRef")))
        children = node.get("children", [])
        if len(children) > definition["maxChildren"] or any(
            child["componentName"] in components
            and child["componentName"] not in definition["allowedChildren"]
            for child in children
        ):
            errors.append(diagnostic("VIEW_CHILD_NOT_ALLOWED", child_path(path, "children")))
        else:
            stack.extend(
                (child, child_path(child_path(path, "children"), i), node["componentName"])
                for i, child in reversed(list(enumerate(children)))
            )
    for locale in spec.get("i18n", {}):
        if not valid_locale(locale):
            errors.append(diagnostic("VIEW_PROP_INVALID", child_path(child_path(prefix, "i18n"), locale, True)))
    # Do not descend malformed dynamic props; their registered Schema error wins.
    if not any(e["code"] == "VIEW_PROP_INVALID" for e in errors):
        errors.extend(validate_bindings(spec, context, prefix, fields))
    return sorted_unique(errors)
