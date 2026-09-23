#!/usr/bin/env python3
"""Python black-box entry for the 0A core Meta-Schema suite."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

from diagnostics import diagnostic
from references import validate_references
from semantic import validate_semantic
from structure import BundleLoadError, validate_structure, bundle_session
from context import parse_context, ContextInvalid, RegistryConfigurationInvalid, bound_context


ROOT = Path(__file__).resolve().parents[3]
C14N = ROOT / "protocol/kvvi-json-c14n/v1/evidence-sets/prd-v1.11/python/kvvi_json_c14n.py"
SUITE_REVISION = "0a-core-r1"


def emit(raw: bytes, entry: str, checks: str, errors: list[dict[str, str]], stage: str) -> int:
    payload = {
        "suite_revision": SUITE_REVISION,
        "entry": entry,
        "checks": checks,
        "stage": stage,
        "input_sha256": hashlib.sha256(raw).hexdigest(),
        "validation": {"valid": not errors, "errors": errors},
        "release_approved": False,
    }
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
    return 0 if not errors else 2


def emit_execution_failure(
    code: str,
    raw: bytes | None = None,
    entry: str | None = None,
    checks: str | None = None,
) -> int:
    payload: dict[str, object] = {
        "suite_revision": SUITE_REVISION,
        "execution": {"status": "failed", "code": code},
        "release_approved": False,
    }
    if raw is not None:
        payload["input_sha256"] = hashlib.sha256(raw).hexdigest()
    if entry is not None:
        payload["entry"] = entry
    if checks is not None:
        payload["checks"] = checks
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
    return 1


def parse_arguments(argv: list[str]) -> dict[str, str]:
    known = {"contract", "entry", "checks", "context"}
    if len(argv) % 2:
        raise ValueError("invalid arguments")
    result: dict[str, str] = {}
    for index in range(0, len(argv), 2):
        token = argv[index]
        if not token.startswith("--"):
            raise ValueError("invalid arguments")
        key = token[2:]
        if key not in known or key in result:
            raise ValueError("invalid arguments")
        result[key] = argv[index + 1]
    if result.get("contract") not in {"business-schema/v1", "view-schema/lce-safe-v1", "app-spec/v1alpha1"}:
        raise ValueError("invalid arguments")
    if result.get("entry") not in {"compiled-draft", "spec", "registered"}:
        raise ValueError("invalid arguments")
    if result.get("checks") not in {"structure", "complete"}:
        raise ValueError("invalid arguments")
    return result


def process_timeout_seconds() -> float:
    value = os.environ.get("KVVI_META_INTERNAL_TIMEOUT_MS", "10000")
    try:
        return max(0.001, int(value) / 1000)
    except ValueError:
        return 10.0


def main() -> int:
    try:
        arguments = parse_arguments(sys.argv[1:])
    except ValueError:
        return emit_execution_failure("CLI_ARGUMENT_INVALID")
    raw = sys.stdin.buffer.read()
    try:
        canonical = subprocess.run(
            [sys.executable, str(C14N), "--profile", "kvvi-json-c14n/v1"],
            input=raw,
            capture_output=True,
            check=False,
            timeout=process_timeout_seconds(),
        )
        if canonical.returncode == 2:
            code = json.loads(canonical.stdout)["error_code"]
            return emit(raw, arguments["entry"], arguments["checks"], [diagnostic(code, "$")], 'canonicalization')
        if canonical.returncode != 0 or canonical.stderr:
            return emit_execution_failure("CANONICALIZER_EXECUTION_FAILED", raw, arguments["entry"], arguments["checks"])
        value = json.loads(json.loads(canonical.stdout)["canonical"])
        errors = validate_structure(arguments["contract"], arguments["entry"], value)
        if errors:
            return emit(raw, arguments["entry"], arguments["checks"], errors, 'structure')
        if arguments["checks"] == "complete":
            context = None
            if arguments.get("context"):
                context = parse_context(Path(arguments["context"]).read_bytes())
            errors = validate_semantic(arguments["contract"], arguments["entry"], value, None if context is None else bound_context(context, historical=arguments['entry']=='registered'))
            if errors: return emit(raw, arguments['entry'], arguments['checks'], errors, 'semantic')
            if not errors:
                errors = validate_references(arguments["contract"], arguments["entry"], value, context)
            return emit(raw, arguments['entry'], arguments['checks'], errors, 'references' if errors else 'complete')
        return emit(raw, arguments["entry"], arguments["checks"], errors, 'structure')
    except ContextInvalid:
        return emit_execution_failure('CONTEXT_INVALID', raw, arguments['entry'], arguments['checks'])
    except RegistryConfigurationInvalid:
        return emit_execution_failure('REGISTRY_CONFIGURATION_INVALID', raw, arguments['entry'], arguments['checks'])
    except subprocess.TimeoutExpired:
        return emit_execution_failure("EXECUTION_TIMEOUT", raw, arguments["entry"], arguments["checks"])
    except (BundleLoadError, OSError, UnicodeDecodeError, json.JSONDecodeError, KeyError, TypeError):
        return emit_execution_failure("EXECUTION_FAILED", raw, arguments["entry"], arguments["checks"])


if __name__ == "__main__":
    with bundle_session():
        raise SystemExit(main())
