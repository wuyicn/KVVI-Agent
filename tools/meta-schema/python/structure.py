"""Offline Draft 2020-12 loading and structural validation."""

from __future__ import annotations

import re
import importlib.util
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

from diagnostics import diagnostic, join_path, sorted_unique
from values import valid_date, valid_datetime

# D03 explicitly selects a bounded date/time profile, through the real engine.
# Do not depend on optional jsonschema format extras silently being installed.
FORMAT_CHECKER = FormatChecker()
FORMAT_CHECKER.checks("date")(lambda value: not isinstance(value, str) or valid_date(value))
FORMAT_CHECKER.checks("date-time")(lambda value: not isinstance(value, str) or valid_datetime(value))


ROOT = Path(__file__).resolve().parents[3]
DEFAULT_BUNDLE = ROOT / "contracts/meta-schemas/0a-core-r1"
CONTRACT_FILES = {
    "business-schema/v1": "business-schema.v1.schema.json",
    "view-schema/lce-safe-v1": "view-schema.lce-safe-v1.schema.json",
    "app-spec/v1alpha1": "app-spec.v1alpha1.schema.json",
}
ENTRY_DEFS = {
    "compiled-draft": "CompiledDraft",
    "spec": "Spec",
    "registered": "RegisteredContract",
}
REGISTERED_BASE_PROPERTIES = {
    "scope_type",
    "scope_id",
    "version",
    "base_version",
    "lifecycle",
    "canonicalization_profile",
    "checksum",
    "audit",
}
REGISTERED_PROPERTIES = {
    "business-schema/v1": REGISTERED_BASE_PROPERTIES
    | {"contract_version", "schema_id", "source_ref", "spec"},
    "view-schema/lce-safe-v1": REGISTERED_BASE_PROPERTIES
    | {"contract_version", "view_id", "spec"},
    "app-spec/v1alpha1": REGISTERED_BASE_PROPERTIES
    | {"contract_version", "app_id", "spec"},
}


class BundleLoadError(RuntimeError):
    pass


_SESSION = ContextVar('kvvi_bundle_session', default=None)


@contextmanager
def bundle_session():
    """Reuse within one synchronous CLI validation, never across invocations."""
    token = _SESSION.set({})
    try:
        yield
    finally:
        _SESSION.reset(token)


def load_bundle(bundle_dir: Path = DEFAULT_BUNDLE) -> tuple[dict[str, Any], Registry]:
    session = _SESSION.get()
    key = str(bundle_dir.resolve())
    if session is not None and key in session:
        return session[key]
    policy_spec = importlib.util.spec_from_file_location('kvvi_bundle_policy', ROOT / 'tools/meta-schema/verify_bundle.py')
    policy = importlib.util.module_from_spec(policy_spec)
    policy_spec.loader.exec_module(policy)
    try:
        schemas = policy.validated_resources(bundle_dir)
    except Exception as exc:
        raise BundleLoadError('bundle validation failed') from exc
    registry = Registry().with_resources(
        [(schema["$id"], Resource.from_contents(schema)) for schema in schemas.values()]
    )
    if session is not None:
        session[key] = (schemas, registry)
    return schemas, registry


def _value_at(instance: Any, path: list[object]) -> Any:
    value = instance
    for part in path:
        value = value[part]
    return value


def _code_for(error, definition: str | None) -> str:
    if error.validator in {"additionalProperties", "unevaluatedProperties"}:
        return "UNKNOWN_PROPERTY"
    if list(error.absolute_path) == ["contract_version"]:
        return "CONTRACT_VERSION_UNSUPPORTED"
    if definition == "AssetRef":
        return "REFERENCE_INVALID"
    if definition == "CapabilityRef":
        return "VIEW_CAPABILITY_REF_INVALID"
    if definition == 'App':
        parts=list(error.absolute_path)
        if 'navigation' in parts and any(p in ('path','route_code') for p in parts):return 'APPSPEC_INVALID'
        if 'viewRef' in parts or any(slot in parts and len(parts)>parts.index(slot)+1 for slot in ('businessSchemaRefs','viewRefs','workflowRefs','permissionRefs')):
            return 'REFERENCE_INVALID'
    if definition == "View":
        parts = list(error.absolute_path)
        if any(p in parts for p in ("actionRef", "queryRef")):
            return "VIEW_CAPABILITY_REF_INVALID"
        if any(p in parts for p in ("businessSchemaRef", "componentRegistryRef")):
            return "REFERENCE_INVALID"
        if "condition" in parts:
            return "VIEW_EXPRESSION_UNSAFE"
        if error.validator in {"maxLength", "maxItems", "maximum", "minimum"}:
            if "i18n" in parts or "queries" in parts or "maxItems" in parts:
                return "VIEW_LIMIT_EXCEEDED"
    if definition == "Business":
        parts = list(error.absolute_path)
        if any(p in parts for p in ("field_type_registry_ref", "sequence_policy_ref")):
            return "REFERENCE_INVALID"
        if error.validator != "required":
            if parts and parts[-1] == "schema_code":
                return "SCHEMA_CODE_INVALID"
            if parts and parts[-1] == "field_code":
                return "FIELD_CODE_INVALID"
            if "fields" in parts and parts[-1:] == ["type"]:
                return "FIELD_TYPE_UNREGISTERED"
            if "fields" in parts and any(p in parts for p in ("constraints", "type_config", "default")):
                return "CONSTRAINT_INCOMPATIBLE"
        if "record_rules" in parts and any(p in parts for p in ("assert", "when")):
            return "ARBITRARY_EXPRESSION_FORBIDDEN"
    return "CONTRACT_SHAPE_INVALID"


def _is_descendant_path(parent: str, child: str) -> bool:
    if parent == "$":
        return child != "$"
    return child.startswith(f"{parent}.") or child.startswith(f"{parent}[")


def _map_errors(
    raw_errors: list[Any],
    instance: Any,
    definition: str | None,
    evaluated_properties: set[str] | None = None,
) -> list[dict[str, str]]:
    mapped: list[tuple[bool, dict[str, str]]] = []
    def path(parts):
        return join_path(parts, view=definition == "View")
    for error in raw_errors:
        if error.validator == "if" and error.context:
            continue
        parts = list(error.absolute_path)
        if error.validator in {"oneOf", "anyOf"}:
            mapped.append((True, diagnostic(_code_for(error, definition), path(parts))))
            continue
        if error.validator == "required":
            current = _value_at(instance, parts)
            missing = sorted(
                set(error.validator_value) - set(current), key=lambda item: item.encode("utf-8")
            )
            for key in missing:
                mapped.append(
                    (False, diagnostic(_code_for(error, definition), path([*parts, key])))
                )
            continue
        if error.validator in {"additionalProperties", "unevaluatedProperties"}:
            current = _value_at(instance, parts)
            if error.validator == "unevaluatedProperties":
                known = evaluated_properties or set(error.schema.get("properties", {}))
            else:
                known = set(error.schema.get("properties", {}))
            extras = sorted(set(current) - known, key=lambda item: item.encode("utf-8"))
            for key in extras:
                mapped.append((False, diagnostic("UNKNOWN_PROPERTY", path([*parts, key]))))
            continue
        if definition == "Business" and "fields" in parts and "default" in parts:
            parts = parts[:parts.index("default") + 1]
        mapped.append((False, diagnostic(_code_for(error, definition), path(parts))))
    without_cascades = [
        item
        for aggregate, item in mapped
        if not aggregate
        or not any(
            (not candidate_aggregate or definition == "View")
            and _is_descendant_path(item["path"], candidate["path"])
            for candidate_aggregate, candidate in mapped
        )
    ]
    normalized = sorted_unique(without_cascades)
    if raw_errors and not normalized:
        fallback = next(
            (error for error in raw_errors if error.validator != "if"), raw_errors[0]
        )
        return [diagnostic(_code_for(fallback, definition), path(list(fallback.absolute_path)))]
    return normalized


def _validate(
    schema_ref: str,
    value: Any,
    bundle_dir: Path,
    definition: str | None,
    evaluated_properties: set[str] | None = None,
) -> list[dict[str, str]]:
    _, registry = load_bundle(bundle_dir)
    wrapper = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$ref": schema_ref,
    }
    validator = Draft202012Validator(wrapper, registry=registry, format_checker=FORMAT_CHECKER)
    return _map_errors(
        list(validator.iter_errors(value)), value, definition, evaluated_properties
    )


def validate_structure(
    contract: str, entry: str, value: Any, bundle_dir: Path = DEFAULT_BUNDLE
) -> list[dict[str, str]]:
    filename = CONTRACT_FILES[contract]
    schemas, _ = load_bundle(bundle_dir)
    if contract == "business-schema/v1":
        from expressions import business_budget_errors
        spec = value if entry == "spec" else value.get("spec") if isinstance(value, dict) else None
        errors = business_budget_errors(spec, "" if entry == "spec" else "spec")
        if errors:
            return errors
    if contract == "view-schema/lce-safe-v1":
        from view_safety import view_preflight
        spec = value if entry == "spec" else value.get("spec") if isinstance(value, dict) else None
        errors = view_preflight(spec, "" if entry == "spec" else "spec")
        if errors:
            return errors
    schema_id = schemas[filename]["$id"]
    evaluated_properties = REGISTERED_PROPERTIES.get(contract) if entry == "registered" else None
    errors = _validate(
        f"{schema_id}#/$defs/{ENTRY_DEFS[entry]}",
        value,
        bundle_dir,
        "Business" if contract == "business-schema/v1" else "View" if contract == "view-schema/lce-safe-v1" else 'App',
        evaluated_properties,
    )
    if contract == 'business-schema/v1':
        prefix = '' if entry == 'spec' else 'spec.'
        forbidden = {prefix + key for key in ('tenant_id', 'role_permissions', 'user_permissions',
                                               'authorization', 'data_scope', 'approvers')}
        errors = [diagnostic('PERMISSION_DECLARATION_FORBIDDEN', error['path'])
                  if error['code'] == 'UNKNOWN_PROPERTY' and error['path'] in forbidden else error
                  for error in errors]
    if contract == "view-schema/lce-safe-v1" and not errors:
        from view_safety import walk, is_i18n_path
        kinds = {"FieldRef", "I18nRef", "SafeExpression", "ActionRef", "DataQueryRef", "DataBindingRef"}
        for item, path in walk(value):
            if isinstance(item, dict) and not is_i18n_path(path) and item.get("type") in kinds:
                local = _validate(f"{schema_id}#/$defs/{item['type']}", item, bundle_dir, "View")
                for error in local:
                    suffix = error["path"]
                    error["path"] = path if suffix == "$" else path + ("" if suffix.startswith("[") else ".") + suffix
                errors.extend(local)
    return sorted_unique(errors)


def validate_definition(
    definition: str, value: Any, bundle_dir: Path = DEFAULT_BUNDLE
) -> list[dict[str, str]]:
    if definition not in {"AssetRef", "CapabilityRef", "RegisteredBase"}:
        raise ValueError("unsupported exported definition")
    return _validate(
        f"urn:kvvi:meta-schema:0a-core-r1:common#/$defs/{definition}",
        value,
        bundle_dir,
        definition,
    )


def validate_registered_schema(schema, value, prefix, code):
    """Apply the actual closed Registry schema with the same offline resources."""
    _, registry = load_bundle(DEFAULT_BUNDLE)
    Draft202012Validator.check_schema(schema)
    validator = Draft202012Validator(schema, registry=registry, format_checker=FORMAT_CHECKER)
    errors = _map_errors(list(validator.iter_errors(value)), value, "View")
    from view_safety import child_path
    output = []
    for error in errors:
        suffix = error["path"]
        if suffix == "$":
            path = prefix
        else:
            # Dynamic dictionaries: the first key is always JSON bracket quoted.
            match = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)(.*)$", suffix, re.S)
            path = child_path(prefix, match[1], True) if match else prefix + suffix
        output.append(diagnostic(code, path))
    return sorted_unique(output)
