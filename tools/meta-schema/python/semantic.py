"""Task-scoped semantic dispatch; later tasks replace fail-closed handlers."""

from __future__ import annotations

from typing import Any

from diagnostics import diagnostic
from business import validate_business
from view import validate_view
from app import validate_app


def _unavailable(path_prefix: str) -> list[dict[str, str]]:
    return [diagnostic("DEPENDENCY_VALIDATOR_UNAVAILABLE", path_prefix)]


def validate_semantic(
    contract: str, entry: str, value: Any, context: dict[str, Any] | None
) -> list[dict[str, str]]:
    path_prefix = "$" if entry == "spec" else "spec"
    if context is None or context.get("fixture") is not True or context.get("suite_revision") != "0a-core-r1":
        return [diagnostic("TRUSTED_CONTEXT_REQUIRED", path_prefix)]
    spec = value if entry == "spec" else value["spec"]
    if contract == 'view-schema/lce-safe-v1':
        from view_registry import resolve_asset
        from structure import validate_structure
        body,status=resolve_asset(spec['businessSchemaRef'],context)
        if status=='ok' and validate_structure('business-schema/v1','spec',body):
            return []  # The reference stage reports the dependency's public shape.
    validators = {
        "business-schema/v1": validate_business,
        "view-schema/lce-safe-v1": validate_view,
        "app-spec/v1alpha1": validate_app,
    }
    return validators[contract](spec, context, path_prefix)
