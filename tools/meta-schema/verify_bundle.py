#!/usr/bin/env python3
"""Verify manifest binding, local references, keywords and both engine loaders."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import math
from pathlib import Path
import subprocess
import sys
from typing import Any
from urllib.parse import urldefrag

from jsonschema import Draft202012Validator


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_BUNDLE = ROOT / "contracts/meta-schemas/0a-core-r1"
DIALECT = "https://json-schema.org/draft/2020-12/schema"
KNOWN_FORMATS = {"date-time", "uuid"}
RESOURCE_IDS = {
    'common.schema.json': 'common',
    'business-schema.v1.schema.json': 'business-schema-v1',
    'view-schema.lce-safe-v1.schema.json': 'view-schema-lce-safe-v1',
    'app-spec.v1alpha1.schema.json': 'app-spec-v1alpha1',
}
SOURCE_BINDINGS = {
    'baseline': ('docs/PRD-AI无代码平台设计-v1.11.md', 'd517617a0c500713897e7d6c88b5894d4c802e6362ecf68631ba88776750993b'),
    'design': ('docs/superpowers/specs/2026-09-08-0a-meta-schema-core-design.md', '6b3f0eea5a0cd8874c2d509bf446edb0402513efb6c3c6b00c26674fdecbe4c0'),
}
KNOWN_KEYWORDS = {
    "$schema", "$id", "$ref", "$defs", "$comment", "title", "description", "default", "examples",
    "type", "enum", "const", "multipleOf", "maximum", "exclusiveMaximum", "minimum", "exclusiveMinimum",
    "maxLength", "minLength", "pattern", "format", "maxItems", "minItems", "uniqueItems", "maxContains",
    "minContains", "maxProperties", "minProperties", "required", "dependentRequired", "properties",
    "patternProperties", "additionalProperties", "unevaluatedProperties", "propertyNames", "items", "prefixItems",
    "contains", "dependentSchemas", "allOf", "anyOf", "oneOf", "not", "if", "then", "else",
    "readOnly", "writeOnly", "deprecated", "contentEncoding", "contentMediaType", "contentSchema",
}
SCHEMA_MAP_KEYS = {"$defs", "properties", "patternProperties", "dependentSchemas"}
SCHEMA_SINGLE_KEYS = {"additionalProperties", "unevaluatedProperties", "propertyNames", "items", "contains", "not", "if", "then", "else", "contentSchema"}
SCHEMA_LIST_KEYS = {"prefixItems", "allOf", "anyOf", "oneOf"}


class VerificationError(RuntimeError):
    def __init__(self, code: str, path: str) -> None:
        super().__init__(code)
        self.code = code
        self.path = path


def strict_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise VerificationError("BUNDLE_DUPLICATE_KEY", key)
        result[key] = value
    return result


def load_json(path: Path) -> dict[str, Any]:
    def number(token):
        value=float(token)
        if not math.isfinite(value): raise ValueError()
        return value
    try:
        value = json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=strict_object,
                           parse_constant=lambda _: (_ for _ in ()).throw(ValueError()), parse_float=number)
    except VerificationError:
        raise
    except (OSError, UnicodeDecodeError, ValueError) as exc:
        raise VerificationError("BUNDLE_JSON_INVALID", path.name) from exc
    if not isinstance(value, dict):
        raise VerificationError("BUNDLE_JSON_INVALID", path.name)
    return value


def walk_schema(schema: bool | dict[str, Any], path: str) -> None:
    if isinstance(schema, bool):
        return
    if not isinstance(schema, dict):
        raise VerificationError("BUNDLE_SCHEMA_INVALID", path)
    for key in schema:
        if key not in KNOWN_KEYWORDS:
            raise VerificationError("BUNDLE_UNKNOWN_KEYWORD", f"{path}.{key}")
    if "format" in schema and schema["format"] not in KNOWN_FORMATS:
        raise VerificationError("BUNDLE_UNKNOWN_FORMAT", f"{path}.format")
    for key in SCHEMA_MAP_KEYS:
        if key in schema:
            for name, child in schema[key].items():
                walk_schema(child, f"{path}.{key}.{name}")
    for key in SCHEMA_SINGLE_KEYS:
        if key in schema and isinstance(schema[key], (dict, bool)):
            walk_schema(schema[key], f"{path}.{key}")
    for key in SCHEMA_LIST_KEYS:
        if key in schema:
            for index, child in enumerate(schema[key]):
                walk_schema(child, f"{path}.{key}[{index}]")


def resolve_pointer(document: Any, fragment: str, path: str) -> None:
    if fragment == "":
        return
    if not fragment.startswith("/"):
        raise VerificationError("BUNDLE_UNKNOWN_REF", path)
    value = document
    for raw_part in fragment[1:].split("/"):
        part = raw_part.replace("~1", "/").replace("~0", "~")
        if not isinstance(value, dict) or part not in value:
            raise VerificationError("BUNDLE_UNKNOWN_REF", path)
        value = value[part]
    if not isinstance(value, (dict, bool)):
        raise VerificationError('BUNDLE_UNKNOWN_REF', path)


def walk_refs(schema: bool | dict[str, Any], current_id: str, by_id: dict[str, dict[str, Any]], path: str) -> None:
    if isinstance(schema, bool):
        return
    reference = schema.get("$ref")
    if reference is not None:
        resource_id, fragment = urldefrag(reference)
        target_id = resource_id or current_id
        if target_id not in by_id:
            raise VerificationError("BUNDLE_UNKNOWN_REF", f"{path}.$ref")
        resolve_pointer(by_id[target_id], fragment, f"{path}.$ref")
    for key in SCHEMA_MAP_KEYS:
        for name, child in schema.get(key, {}).items():
            walk_refs(child, current_id, by_id, f"{path}.{key}.{name}")
    for key in SCHEMA_SINGLE_KEYS:
        child = schema.get(key)
        if isinstance(child, (dict, bool)):
            walk_refs(child, current_id, by_id, f"{path}.{key}")
    for key in SCHEMA_LIST_KEYS:
        for index, child in enumerate(schema.get(key, [])):
            walk_refs(child, current_id, by_id, f"{path}.{key}[{index}]")


def safe_file(root: Path, name: str) -> Path:
    path = root / name
    if path.is_symlink() or not path.resolve().is_relative_to(root.resolve()):
        raise VerificationError('BUNDLE_PATH_INVALID', name)
    return path


def validated_resources(bundle: Path) -> dict[str, dict[str, Any]]:
    safe_file(bundle, 'manifest.json')
    manifest = load_json(bundle / "manifest.json")
    if set(manifest) != {'suite_revision', 'schema_dialect', 'baseline', 'design', 'resources'} or manifest.get("suite_revision") != "0a-core-r1" or manifest.get("schema_dialect") != DIALECT:
        raise VerificationError("BUNDLE_MANIFEST_INVALID", "manifest")
    resources = manifest.get("resources")
    if not isinstance(resources, dict) or set(resources) != set(RESOURCE_IDS):
        raise VerificationError("BUNDLE_MANIFEST_INVALID", "manifest.resources")
    by_id: dict[str, dict[str, Any]] = {}
    by_file: dict[str, dict[str, Any]] = {}
    for filename, record in resources.items():
        if not isinstance(record, dict):
            raise VerificationError("BUNDLE_MANIFEST_INVALID", filename)
        expected_keys = {'id', 'sha256', 'dependencies'} | ({'contract_version'} if filename != 'common.schema.json' else set())
        if set(record) != expected_keys or not isinstance(record.get('sha256'), str) or not re.fullmatch('[0-9a-f]{64}', record['sha256']):
            raise VerificationError('BUNDLE_MANIFEST_INVALID', filename)
        path = safe_file(bundle, filename)
        try:
            raw = path.read_bytes()
        except OSError as exc:
            raise VerificationError("BUNDLE_RESOURCE_MISSING", filename) from exc
        if hashlib.sha256(raw).hexdigest() != record.get("sha256"):
            raise VerificationError("BUNDLE_DIGEST_MISMATCH", filename)
        schema = load_json(path)
        schema_id = schema.get("$id")
        if not isinstance(schema_id, str):
            raise VerificationError("BUNDLE_SCHEMA_ID_MISMATCH", filename)
        if schema_id in by_id:
            raise VerificationError("BUNDLE_DUPLICATE_ID", filename)
        by_id[schema_id] = schema
        by_file[filename] = schema
    for filename, record in resources.items():
        schema = by_file[filename]
        if schema.get("$schema") != DIALECT or schema.get("$id") != record.get("id") or record['id'] != 'urn:kvvi:meta-schema:0a-core-r1:' + RESOURCE_IDS[filename]:
            raise VerificationError("BUNDLE_SCHEMA_ID_MISMATCH", filename)
        if filename != 'common.schema.json' and record.get('contract_version') != {'business-schema.v1.schema.json':'business-schema/v1','view-schema.lce-safe-v1.schema.json':'view-schema/lce-safe-v1','app-spec.v1alpha1.schema.json':'app-spec/v1alpha1'}[filename]:
            raise VerificationError('BUNDLE_MANIFEST_INVALID', filename)
    for filename, record in resources.items():
        expected_dependencies = [] if filename == 'common.schema.json' else ['urn:kvvi:meta-schema:0a-core-r1:common']
        if record.get('dependencies') != expected_dependencies:
            raise VerificationError('BUNDLE_UNKNOWN_DEPENDENCY', filename)
        for dependency in record.get("dependencies", []):
            if dependency not in by_id:
                raise VerificationError("BUNDLE_UNKNOWN_DEPENDENCY", filename)
    for filename, schema in by_file.items():
        try:
            walk_schema(schema, filename)
            Draft202012Validator.check_schema(schema)
        except VerificationError:
            raise
        except Exception as exc:
            raise VerificationError("BUNDLE_SCHEMA_INVALID", filename) from exc
        walk_refs(schema, schema["$id"], by_id, filename)
    for source_key in ("baseline", "design"):
        record = manifest.get(source_key)
        if not isinstance(record, dict) or set(record) != {'path', 'sha256'}:
            raise VerificationError("BUNDLE_MANIFEST_INVALID", source_key)
        expected_path, expected_sha = SOURCE_BINDINGS[source_key]
        if record != {'path': expected_path, 'sha256': expected_sha}:
            raise VerificationError('BUNDLE_SOURCE_MISMATCH', source_key)
        source = safe_file(ROOT, expected_path)
        if not source.is_file() or hashlib.sha256(source.read_bytes()).hexdigest() != record.get("sha256"):
            raise VerificationError("BUNDLE_SOURCE_MISMATCH", source_key)
    return by_file


def verify(bundle: Path) -> None:
    validated_resources(bundle)
    node_module = (ROOT / "tools/meta-schema/node/structure.mjs").as_uri()
    source = f'import {{loadBundle}} from {json.dumps(node_module)}; loadBundle(process.argv[1]);'
    timeout_ms = os.environ.get("KVVI_META_INTERNAL_TIMEOUT_MS", "10000")
    try:
        timeout_seconds = max(0.001, int(timeout_ms) / 1000)
    except ValueError:
        timeout_seconds = 10.0
    try:
        completed = subprocess.run(
            ["node", "--input-type=module", "-e", source, str(bundle)],
            cwd=ROOT,
            check=False,
            capture_output=True,
            timeout=timeout_seconds,
        )
    except subprocess.TimeoutExpired as exc:
        raise VerificationError("BUNDLE_NODE_TIMEOUT", "bundle") from exc
    if completed.returncode != 0:
        raise VerificationError("BUNDLE_NODE_LOAD_FAILED", "bundle")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--suite", default="0a-core-r1")
    parser.add_argument("--bundle", type=Path)
    arguments = parser.parse_args()
    if arguments.suite != "0a-core-r1":
        parser.error("unsupported suite")
    try:
        verify(arguments.bundle or DEFAULT_BUNDLE)
    except VerificationError as exc:
        payload = {"suite_revision": "0a-core-r1", "valid": False, "errors": [{"code": exc.code, "path": exc.path}]}
        sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
        return 1
    sys.stdout.write('{"suite_revision":"0a-core-r1","valid":true,"errors":[]}\n')
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
