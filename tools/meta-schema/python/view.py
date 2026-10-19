"""View static validation against exact, content-bound Fake assets."""
from diagnostics import diagnostic, sorted_unique
from structure import validate_structure
from view_bindings import validate_bindings
from view_registry import resolve_asset
from view_safety import child_path
from view_tree import check_view_tree


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
    errors = check_view_tree(spec, components=registry["components"], model_fields=business["fields"],
                             deleted_node_ids=context.get("view", {}).get("deleted_node_ids") or [], prefix=prefix)
    # Do not descend malformed dynamic props; their registered Schema error wins.
    if not any(e["code"] == "VIEW_PROP_INVALID" for e in errors):
        errors.extend(validate_bindings(spec, context, prefix, fields))
    return sorted_unique(errors)
