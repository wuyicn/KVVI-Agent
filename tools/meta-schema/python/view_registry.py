"""Exact private Fake lookup; Task 4 additionally checks authorization/history."""
from functools import lru_cache
import importlib.util
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[3]
_spec = importlib.util.spec_from_file_location(
    "view_c14n_reference",
    ROOT / "protocol/kvvi-json-c14n/v1/evidence-sets/prd-v1.11/python/kvvi_json_c14n.py",
)
_c14n = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = _c14n
_spec.loader.exec_module(_c14n)


@lru_cache(maxsize=256)
def _digest_text(raw):
    return _c14n.canonicalize_json(raw)["digest"]


def content_digest(content):
    return _digest_text(json.dumps(content, ensure_ascii=False, separators=(",", ":")))


def resolve_asset(reference, context):
    """Return (content, status). No name-only, latest, alias, or tenant guessing."""
    if not isinstance(reference, dict):
        return None, "missing"
    identity = {key: value for key, value in reference.items() if key != "digest"}
    found = [a for a in context.get("fake_assets", []) if isinstance(a, dict) and
             {k: v for k, v in a.get("ref", {}).items() if k != "digest"} == identity]
    if len(found) != 1:
        return None, "missing"
    record = found[0]
    if reference.get("digest") != record["ref"].get("digest") or content_digest(record["content"]) != reference.get("digest"):
        return None, "digest"
    return record["content"], "ok"


def resolve_capability(reference, context):
    content, status = resolve_asset(reference, context)
    if status != "ok":
        return None, status
    registry_ref = context.get("view", {}).get("capability_registry_ref")
    if not isinstance(registry_ref, dict) or registry_ref.get("asset_type") != "CAPABILITY_REGISTRY":
        return None, "missing"
    registry, registry_status = resolve_asset(registry_ref, context)
    if (
        registry_status != "ok"
        or registry.get("fixture") is not True
        or registry.get("version") != registry_ref["version"]
        or registry.get("state") != "PUBLISHED"
    ):
        return None, "missing"
    identity = {key: value for key, value in reference.items() if key != "digest"}
    members = [member for member in registry.get("members", []) if
               {key: value for key, value in member.items() if key != "digest"} == identity]
    if len(members) != 1:
        return None, "missing"
    if members[0].get("digest") != reference["digest"]:
        return None, "digest"
    required = {
        "fixture", "capability_code", "version", "state", "category",
        "inputSchema", "outputSchema", "errorSchema", "authorization", "scope",
        "sideEffects", "idempotency", "retry", "runtimeDigest", "timeoutMs",
        "rateLimit", "maxResults", "itemKeys", "recovery", "auditEvents",
    }
    if (
        not required <= set(content)
        or content["fixture"] is not True
        or content["state"] != "PUBLISHED"
        or content["capability_code"] != reference["capability_code"]
        or content["version"] != reference["version"]
    ):
        return None, "missing"
    from jsonschema import Draft202012Validator
    for key in ("inputSchema", "outputSchema", "errorSchema"):
        schema = content[key]
        if not isinstance(schema, dict) or schema.get("type") != "object" or schema.get("additionalProperties") is not False:
            return None, "missing"
        Draft202012Validator.check_schema(schema)
    return content, "ok"
