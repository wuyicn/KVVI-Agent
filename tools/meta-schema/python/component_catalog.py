"""Installed static component metadata; no DSH imports or plugin execution."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys

from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[3]
CATALOG_DIR = "contracts/component-catalog/v1"
MAX_BYTES = 2 * 1024 * 1024
_spec = importlib.util.spec_from_file_location(
    "component_catalog_c14n_reference",
    ROOT / "protocol/kvvi-json-c14n/v1/evidence-sets/prd-v1.11/python/kvvi_json_c14n.py",
)
_c14n = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = _c14n
_spec.loader.exec_module(_c14n)


class CatalogError(ValueError):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def _regular_bytes(root, relative, code):
    parts = relative.split("/")
    if any(not part or part in (".", "..") or "\\" in part or "\0" in part for part in parts):
        raise CatalogError(code)
    try:
        path = Path(root).absolute()
        if not stat.S_ISDIR(path.lstat().st_mode):
            raise CatalogError(code)
        for index, part in enumerate(parts):
            path = path / part
            mode = path.lstat().st_mode
            if not (stat.S_ISDIR(mode) if index < len(parts) - 1 else stat.S_ISREG(mode)):
                raise CatalogError(code)
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_BYTES:
                raise CatalogError(code)
            with os.fdopen(fd, "rb", closefd=False) as stream:
                raw = stream.read(MAX_BYTES + 1)
            if len(raw) > MAX_BYTES:
                raise CatalogError(code)
            return raw
        finally:
            os.close(fd)
    except (OSError, ValueError) as error:
        raise CatalogError(code) from error


def _canonical_bytes(raw):
    if type(raw) is not bytes or len(raw) > MAX_BYTES or raw.startswith(b"\xef\xbb\xbf"):
        raise CatalogError("CATALOG_DOCUMENT_INVALID")
    try:
        return _c14n.canonicalize_json(raw.decode("utf-8", errors="strict"))
    except Exception as error:
        raise CatalogError("CATALOG_DOCUMENT_INVALID") from error


def validate_catalog_document(raw):
    """Integrity only. An upload cannot register its own trusted catalog."""
    document = json.loads(_canonical_bytes(raw)["canonical"])
    schema = json.loads(_regular_bytes(ROOT, CATALOG_DIR + "/catalog.schema.json", "CATALOG_UNAVAILABLE"))
    Draft202012Validator.check_schema(schema)
    if not Draft202012Validator(schema).is_valid(document):
        raise CatalogError("CATALOG_DOCUMENT_INVALID")
    digest = _c14n.canonicalize_json(json.dumps(document["content"], ensure_ascii=False))["digest"]
    if digest != document["ref"]["digest"]:
        raise CatalogError("CATALOG_DIGEST_MISMATCH")
    names = [entry["componentName"] for entry in document["content"]["components"]]
    if len(set(names)) != len(names):
        raise CatalogError("CATALOG_DOCUMENT_INVALID")
    for slot in ("sourceFiles", "integrationWitnesses"):
        paths = [entry["path"] for entry in document["content"]["adapter"][slot]]
        if len(set(paths)) != len(paths):
            raise CatalogError("CATALOG_DOCUMENT_INVALID")
    for component in document["content"]["components"]:
        stack = [component["propsSchema"]]
        while stack:
            value = stack.pop()
            if type(value) is dict:
                if "$ref" in value or "$dynamicRef" in value:
                    raise CatalogError("CATALOG_DOCUMENT_INVALID")
                stack.extend(value.values())
            elif type(value) is list:
                stack.extend(value)
        Draft202012Validator.check_schema(component["propsSchema"])
    return document


def read_installed_component_catalog():
    # Fresh detached value each time. A caller mutation cannot poison a cache.
    return validate_catalog_document(_regular_bytes(ROOT, CATALOG_DIR + "/catalog.json", "CATALOG_UNAVAILABLE"))


def resolve_component_catalog(reference):
    catalog = read_installed_component_catalog()
    try:
        matched = type(reference) is dict and _c14n.canonicalize_json(json.dumps(reference, ensure_ascii=False))["canonical"] == _c14n.canonicalize_json(json.dumps(catalog["ref"], ensure_ascii=False))["canonical"]
    except Exception:
        matched = False
    if not matched:
        raise CatalogError("CATALOG_REFERENCE_MISMATCH")
    return catalog["content"]


def qualify_component_adapter(runtime_root):
    """Qualify only declared source inventory, never bundle/transitive closure."""
    catalog = read_installed_component_catalog()
    adapter = catalog["content"]["adapter"]
    entries = adapter["sourceFiles"] + adapter["integrationWitnesses"]
    for entry in entries:
        raw = _regular_bytes(runtime_root, entry["path"], "CATALOG_SOURCE_UNAVAILABLE")
        if hashlib.sha256(raw).hexdigest() != entry["sha256"]:
            raise CatalogError("CATALOG_SOURCE_MISMATCH")
    return {"catalogDigest": catalog["ref"]["digest"], "sourceFiles": len(entries),
            "evidenceBoundary": "explicit-source-inventory-only"}
