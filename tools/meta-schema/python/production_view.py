"""Static validation only; host code supplies a real authorized registry resolver."""
from copy import deepcopy
import json
import re
from jsonschema import Draft202012Validator

from component_catalog import _c14n, resolve_component_catalog
from diagnostics import diagnostic, sorted_unique
from structure import load_bundle, validate_definition, validate_structure
from view_tree import check_view_tree
from view_safety import child_path

IDENTITY_KEYS = ("scope_type", "scope_id", "app_id", "module_id", "asset_type", "asset_id")


def _identity(ref):
    return {key: ref[key] for key in IDENTITY_KEYS}


def _same_namespace(left, right):
    return all(left[key] == right[key] for key in ("scope_type", "scope_id", "app_id", "module_id"))


def _id(value):
    return type(value) is str and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", value) is not None


def _equal(left, right):
    # Python dict equality equates True and 1; the protocol does not.
    try:
        return (_c14n.canonicalize_json(json.dumps(left, ensure_ascii=False))["canonical"]
                == _c14n.canonicalize_json(json.dumps(right, ensure_ascii=False))["canonical"])
    except Exception:
        return False


def _report(errors, dependencies=None):
    return {"valid": not errors, "errors": sorted_unique(errors), "dependencies": dependencies or [],
            "validationScope": "STATIC_VIEW_AND_REFERENCE", "releaseApproved": False}


def _unsupported(spec):
    errors = [diagnostic("VIEW_FEATURE_UNSUPPORTED", key) for key in ("queries", "i18n") if key in spec]
    stack = [(node, f"componentsTree[{index}]") for index, node in enumerate(spec["componentsTree"])]
    while stack:
        node, path = stack.pop()
        errors.extend(diagnostic("VIEW_FEATURE_UNSUPPORTED", child_path(path, key))
                      for key in ("condition", "loop", "loopArgs", "actions") if key in node)
        stack.extend((child, f"{path}.children[{index}]") for index, child in enumerate(node.get("children", [])))
    return errors


class _ProductionViewChecker:
    def __init__(self, resolver):
        self._resolver = resolver

    def check(self, raw_view_bytes, trusted_context):
        try:
            return self._check(raw_view_bytes, trusted_context)
        except Exception:
            return _report([diagnostic("DEPENDENCY_VALIDATOR_UNAVAILABLE", "$")])

    def _check(self, raw_view_bytes, trusted_context):
        try:
            if type(raw_view_bytes) is not bytes:
                return _report([diagnostic("CANON_JSON_INVALID", "$")])
            # Preserve canonical protocol errors rather than catalog ingress mapping.
            if raw_view_bytes.startswith(b"\xef\xbb\xbf"):
                return _report([diagnostic("CANON_JSON_INVALID", "$")])
            try:
                text = raw_view_bytes.decode("utf-8", errors="strict")
            except UnicodeDecodeError:
                return _report([diagnostic("CANON_INVALID_UNICODE", "$")])
            spec = json.loads(_c14n.canonicalize_json(text)["canonical"])
        except Exception as error:
            return _report([diagnostic(getattr(error, "error_code", "CANON_JSON_INVALID"), "$")])
        shape = validate_structure("view-schema/lce-safe-v1", "spec", spec)
        if shape:
            return _report(shape)
        try:
            context = deepcopy(trusted_context)
            source = context.get("sourceIdentity")
            expected = context.get("expectedBusinessRef")
            if (type(source) is not dict or set(source) != set(IDENTITY_KEYS)
                    or validate_definition("AssetRef", {**source, "version": 1, "digest": "sha256:" + "0" * 64})
                    or source["scope_type"] != "TENANT" or source["asset_type"] != "VIEW_SCHEMA"
                    or type(expected) is not dict or validate_definition("AssetRef", expected)
                    or expected["asset_type"] != "BUSINESS_SCHEMA" or not _same_namespace(source, expected)):
                return _report([diagnostic("TRUSTED_CONTEXT_REQUIRED", "$")])
        except Exception:
            return _report([diagnostic("TRUSTED_CONTEXT_REQUIRED", "$")])
        deleted = context.get("deletedNodeIds")
        schemas, _ = load_bundle()
        node_id_schema = schemas["view-schema.lce-safe-v1.schema.json"]["$defs"]["ViewNode"]["properties"]["id"]
        if not Draft202012Validator({"type": "array", "items": node_id_schema}).is_valid(deleted):
            return _report([diagnostic("TRUSTED_HISTORY_REQUIRED", "$")])
        unsupported = _unsupported(spec)
        if unsupported:
            return _report(unsupported)
        try:
            catalog = resolve_component_catalog(spec["componentRegistryRef"])
        except Exception as error:
            code = "VIEW_COMPONENT_UNREGISTERED" if getattr(error, "code", None) == "CATALOG_REFERENCE_MISMATCH" else "DEPENDENCY_VALIDATOR_UNAVAILABLE"
            return _report([diagnostic(code, "componentRegistryRef")])
        dependencies = [deepcopy(spec["componentRegistryRef"])]
        ref = spec["businessSchemaRef"]

        def fail(code):
            return _report([diagnostic(code, "businessSchemaRef")], dependencies)

        if not _same_namespace(source, ref):
            return fail("ASSET_REF_OUT_OF_SCOPE")
        if ref["asset_id"] != expected["asset_id"]:
            return fail("ASSET_NOT_FOUND")
        if ref["version"] != expected["version"]:
            return fail("VIEW_REFERENCE_VERSION_CONFLICT")
        if ref["digest"] != expected["digest"]:
            return fail("ASSET_DIGEST_MISMATCH")
        try:
            snapshot = deepcopy(self._resolver(deepcopy(ref)))
        except Exception:
            return fail("DEPENDENCY_VALIDATOR_UNAVAILABLE")
        if snapshot is None:
            return fail("ASSET_NOT_FOUND")
        if type(snapshot) is not dict or not _equal(snapshot.get("ref"), ref):
            return fail("ASSET_NOT_FOUND")
        registered = snapshot.get("registered")
        if type(registered) is not dict:
            return fail("ASSET_REGISTRATION_UNAVAILABLE")
        if registered.get("lifecycle") not in ("PUBLISHED", "SUPERSEDED"):
            return fail("ASSET_NOT_PUBLISHED")
        if validate_structure("business-schema/v1", "registered", registered):
            return fail("ASSET_REGISTRATION_UNAVAILABLE")
        registration = snapshot.get("registration")
        publication = snapshot.get("publication")
        if (type(registration) is not dict or type(publication) is not dict
                or not _equal(registration.get("identity"), _identity(ref))
                or registration.get("schema_id") != registered["schema_id"]
                or registration.get("schema_code") != registered["spec"]["schema_code"]
                or not _equal(publication.get("reference"), ref)
                or publication.get("schema_id") != registered["schema_id"]
                or publication.get("schema_code") != registered["spec"]["schema_code"]
                or not _id(publication.get("published_record_id")) or not _id(publication.get("approved_record_id"))):
            return fail("ASSET_REGISTRATION_UNAVAILABLE")
        if (registered["scope_type"] != ref["scope_type"] or registered["scope_id"] != ref["scope_id"]
                or registered["version"] != ref["version"]):
            return fail("ASSET_REGISTRATION_UNAVAILABLE")
        try:
            digest = _c14n.canonicalize_json(json.dumps(registered["spec"], ensure_ascii=False))["digest"]
        except Exception:
            return fail("ASSET_DIGEST_MISMATCH")
        if (registered["canonicalization_profile"] != "kvvi-json-c14n/v1"
                or registered["checksum"] != ref["digest"] or digest != ref["digest"]):
            return fail("ASSET_DIGEST_MISMATCH")
        dependencies.append(deepcopy(ref))
        return _report(check_view_tree(spec, components=catalog["components"], model_fields=registered["spec"]["fields"],
                                      deleted_node_ids=deleted, allow_root=lambda definition: "$root" in definition["allowedParents"]), dependencies)


def create_production_view_checker(*, resolve_published_business):
    """Resolver is host code checking real records/access, never an upload flag."""
    if not callable(resolve_published_business):
        raise TypeError("trusted registry resolver required")
    return _ProductionViewChecker(resolve_published_business)
