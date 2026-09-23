#!/usr/bin/env python3
"""Behavior tests for the 0A core schema bundle and harness."""

from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import os
import unittest


ROOT = Path(__file__).resolve().parents[2]
SUITE = ROOT / "contracts/meta-schemas/0a-core-r1"
PYTHON_TOOLS = ROOT / "tools/meta-schema/python"
NODE_STRUCTURE = ROOT / "tools/meta-schema/node/structure.mjs"
VERIFY = ROOT / "tools/meta-schema/verify_bundle.py"
CONFORMANCE = Path(__file__).with_name("test_conformance.py")

VALID_ASSET_REF = {
    "scope_type": "TENANT",
    "scope_id": "tenant-fixture",
    "app_id": None,
    "module_id": None,
    "asset_type": "BUSINESS_SCHEMA",
    "asset_id": "general_item",
    "version": 1,
    "digest": "sha256:" + "a" * 64,
}
VALID_CAPABILITY_REF = {
    "scope_type": "PLATFORM_CONTROL",
    "scope_id": "kvvi-platform",
    "app_id": None,
    "module_id": None,
    "asset_type": "CAPABILITY",
    "capability_code": "form.submit",
    "version": 1,
    "digest": "sha256:" + "b" * 64,
}


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def python_definition(name: str, value: object) -> list[dict[str, str]]:
    sys.path.insert(0, str(PYTHON_TOOLS))
    try:
        structure = load_module("kvvi_meta_structure", PYTHON_TOOLS / "structure.py")
        return structure.validate_definition(name, value, SUITE)
    finally:
        sys.path.pop(0)


def node_definition(name: str, value: object) -> list[dict[str, str]]:
    source = (
        "import { validateDefinition } from "
        + json.dumps(NODE_STRUCTURE.as_uri())
        + ";"
        + "const errors=validateDefinition(process.argv[1],JSON.parse(process.argv[2]),"
        + json.dumps(str(SUITE))
        + ");process.stdout.write(JSON.stringify(errors));"
    )
    completed = subprocess.run(
        ["node", "--input-type=module", "-e", source, name, json.dumps(value)],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
    )
    self_message = completed.stderr or completed.stdout
    if completed.returncode != 0:
        raise AssertionError(self_message)
    return json.loads(completed.stdout)


def entry_errors(
    language: str,
    contract: str,
    entry: str,
    value: object,
    bundle: Path = SUITE,
) -> list[dict[str, str]]:
    if language == "python":
        sys.path.insert(0, str(PYTHON_TOOLS))
        try:
            structure = load_module("kvvi_meta_structure_entry", PYTHON_TOOLS / "structure.py")
            return structure.validate_structure(contract, entry, value, bundle)
        finally:
            sys.path.pop(0)
    source = (
        "import { validateStructure } from "
        + json.dumps(NODE_STRUCTURE.as_uri())
        + ";const errors=validateStructure(process.argv[1],process.argv[2],JSON.parse(process.argv[3]),"
        + json.dumps(str(bundle))
        + ");process.stdout.write(JSON.stringify(errors));"
    )
    completed = subprocess.run(
        ["node", "--input-type=module", "-e", source, contract, entry, json.dumps(value)],
        cwd=ROOT, check=False, capture_output=True, text=True
    )
    if completed.returncode != 0:
        raise AssertionError(completed.stderr)
    return json.loads(completed.stdout)


def signatures(errors: list[dict[str, str]]) -> list[tuple[str, str, str]]:
    return [(item["code"], item["severity"], item["path"]) for item in errors]


def refresh_manifest_digest(bundle: Path, filename: str) -> None:
    manifest_path = bundle / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["resources"][filename]["sha256"] = hashlib.sha256(
        (bundle / filename).read_bytes()
    ).hexdigest()
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


class SharedDefinitionTests(unittest.TestCase):
    """Each test names a mutation of the public reference contract."""

    def assert_both(self, definition: str, value: object, expected: list[tuple[str, str, str]]):
        python_errors = python_definition(definition, value)
        node_errors = node_definition(definition, value)
        self.assertEqual(signatures(python_errors), expected)
        self.assertEqual(signatures(node_errors), expected)

    def test_asset_ref_accepts_exact_eight_keys_with_explicit_nulls(self):
        self.assert_both("AssetRef", VALID_ASSET_REF, [])

    def test_asset_ref_rejects_each_missing_key_at_the_property_path(self):
        for key in VALID_ASSET_REF:
            with self.subTest(key=key):
                value = {item: datum for item, datum in VALID_ASSET_REF.items() if item != key}
                self.assert_both(
                    "AssetRef", value, [("REFERENCE_INVALID", "ERROR", key)]
                )

    def test_asset_ref_rejects_unknown_key_before_generic_shape_errors(self):
        value = {**VALID_ASSET_REF, "latest": True}
        self.assert_both("AssetRef", value, [("UNKNOWN_PROPERTY", "ERROR", "latest")])

    def test_dynamic_property_path_uses_json_bracket_escaping(self):
        value = {**VALID_ASSET_REF, 'evil-"key': True}
        self.assert_both(
            "AssetRef", value, [("UNKNOWN_PROPERTY", "ERROR", '["evil-\\"key"]')]
        )

    def test_asset_ref_rejects_zero_latest_and_uppercase_digest(self):
        mutations = [
            ("version", 0, "version"),
            ("version", "latest", "version"),
            ("digest", "sha256:" + "A" * 64, "digest"),
        ]
        for key, value, path in mutations:
            with self.subTest(key=key, value=value):
                candidate = {**VALID_ASSET_REF, key: value}
                self.assert_both(
                    "AssetRef", candidate, [("REFERENCE_INVALID", "ERROR", path)]
                )

    def test_capability_ref_replaces_asset_id_without_widening_shape(self):
        self.assert_both("CapabilityRef", VALID_CAPABILITY_REF, [])
        for mutation, path, code in [
            ({"asset_id": "form.submit"}, "asset_id", "UNKNOWN_PROPERTY"),
            ({"asset_type": "BUSINESS_SCHEMA"}, "asset_type", "VIEW_CAPABILITY_REF_INVALID"),
        ]:
            with self.subTest(mutation=mutation):
                self.assert_both(
                    "CapabilityRef",
                    {**VALID_CAPABILITY_REF, **mutation},
                    [(code, "ERROR", path)],
                )

    def test_capability_ref_rejects_each_missing_key_at_the_property_path(self):
        for key in VALID_CAPABILITY_REF:
            with self.subTest(key=key):
                value = {item: datum for item, datum in VALID_CAPABILITY_REF.items() if item != key}
                self.assert_both(
                    "CapabilityRef",
                    value,
                    [("VIEW_CAPABILITY_REF_INVALID", "ERROR", key)],
                )


class BundleIntegrityTests(unittest.TestCase):
    def run_verify(self, bundle: Path) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(VERIFY), "--bundle", str(bundle)],
            cwd=ROOT,
            check=False,
            capture_output=True,
            text=True,
        )

    def mutate_bundle(self, edit) -> Path:
        temp = Path(tempfile.mkdtemp(prefix="kvvi-meta-bundle-")) / "bundle"
        shutil.copytree(SUITE, temp)
        self.addCleanup(shutil.rmtree, temp.parent)
        edit(temp)
        return temp

    def test_manifest_bound_bundle_self_checks_offline(self):
        completed = self.run_verify(SUITE)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        payload = json.loads(completed.stdout)
        self.assertEqual(payload, {"suite_revision": "0a-core-r1", "valid": True, "errors": []})

    def test_tampered_schema_fails_before_loading(self):
        def edit(bundle: Path) -> None:
            path = bundle / "common.schema.json"
            path.write_text(path.read_text(encoding="utf-8") + " ", encoding="utf-8")

        completed = self.run_verify(self.mutate_bundle(edit))
        self.assertEqual(completed.returncode, 1)
        self.assertEqual(json.loads(completed.stdout)["errors"][0]["code"], "BUNDLE_DIGEST_MISMATCH")

    def test_unknown_schema_reference_fails_loading(self):
        def edit(bundle: Path) -> None:
            path = bundle / "app-spec.v1alpha1.schema.json"
            schema = json.loads(path.read_text(encoding="utf-8"))
            schema["$defs"]["Spec"] = {"$ref": "urn:kvvi:unknown#/$defs/Spec"}
            path.write_text(json.dumps(schema, indent=2) + "\n", encoding="utf-8")
            refresh_manifest_digest(bundle, path.name)

        completed = self.run_verify(self.mutate_bundle(edit))
        self.assertEqual(completed.returncode, 1)
        self.assertEqual(json.loads(completed.stdout)["errors"][0]["code"], "BUNDLE_UNKNOWN_REF")

    def test_duplicate_schema_id_fails_loading(self):
        def edit(bundle: Path) -> None:
            path = bundle / "app-spec.v1alpha1.schema.json"
            schema = json.loads(path.read_text(encoding="utf-8"))
            schema["$id"] = "urn:kvvi:meta-schema:0a-core-r1:common"
            path.write_text(json.dumps(schema, indent=2) + "\n", encoding="utf-8")
            refresh_manifest_digest(bundle, path.name)

        completed = self.run_verify(self.mutate_bundle(edit))
        self.assertEqual(completed.returncode, 1)
        self.assertEqual(json.loads(completed.stdout)["errors"][0]["code"], "BUNDLE_DUPLICATE_ID")

    def test_unknown_keyword_and_format_fail_loading(self):
        for mutation, expected in [
            ({"kvviMagic": True}, "BUNDLE_UNKNOWN_KEYWORD"),
            ({"format": "kvvi-mystery"}, "BUNDLE_UNKNOWN_FORMAT"),
        ]:
            with self.subTest(expected=expected):
                def edit(bundle: Path, mutation=mutation) -> None:
                    path = bundle / "app-spec.v1alpha1.schema.json"
                    schema = json.loads(path.read_text(encoding="utf-8"))
                    schema["$defs"]["Spec"].update(mutation)
                    path.write_text(json.dumps(schema, indent=2) + "\n", encoding="utf-8")
                    refresh_manifest_digest(bundle, path.name)

                completed = self.run_verify(self.mutate_bundle(edit))
                self.assertEqual(completed.returncode, 1)
                self.assertEqual(json.loads(completed.stdout)["errors"][0]["code"], expected)

    def test_node_loader_timeout_is_json_execution_failure(self):
        environment = {**os.environ, "KVVI_META_INTERNAL_TIMEOUT_MS": "1"}
        completed = subprocess.run(
            [sys.executable, str(VERIFY), "--bundle", str(SUITE)],
            cwd=ROOT, check=False, capture_output=True, text=True, env=environment
        )
        self.assertEqual(completed.returncode, 1)
        self.assertEqual(json.loads(completed.stdout)["errors"][0]["code"], "BUNDLE_NODE_TIMEOUT")


class EnvelopeShapeTests(unittest.TestCase):
    def test_registered_base_is_shared_and_unclosed_until_final_entry(self):
        value = json.loads(
            (ROOT / "tests/meta-schema/0a-core-r1/inputs/app-registered-draft.json").read_text(encoding="utf-8")
        )
        for language in ("python", "node"):
            if language == "python":
                errors = python_definition("RegisteredBase", value)
            else:
                errors = node_definition("RegisteredBase", value)
            self.assertEqual(errors, [])
            self.assertEqual(
                signatures(entry_errors(language, "app-spec/v1alpha1", "registered", {**value, "forged": True})),
                [("UNKNOWN_PROPERTY", "ERROR", "forged")],
            )

    def test_business_registered_shell_requires_identity_source_and_required_spec_keys(self):
        value = {"contract_version": "business-schema/v1", "spec": {}}
        expected = [
            ("CONTRACT_SHAPE_INVALID", "ERROR", "audit"),
            ("CONTRACT_SHAPE_INVALID", "ERROR", "base_version"),
            ("CONTRACT_SHAPE_INVALID", "ERROR", "canonicalization_profile"),
            ("CONTRACT_SHAPE_INVALID", "ERROR", "checksum"),
            ("CONTRACT_SHAPE_INVALID", "ERROR", "lifecycle"),
            ("CONTRACT_SHAPE_INVALID", "ERROR", "schema_id"),
            ("CONTRACT_SHAPE_INVALID", "ERROR", "scope_id"),
            ("CONTRACT_SHAPE_INVALID", "ERROR", "scope_type"),
            ("CONTRACT_SHAPE_INVALID", "ERROR", "source_ref"),
            ("CONTRACT_SHAPE_INVALID", "ERROR", "spec.field_type_registry_ref"),
            ("CONTRACT_SHAPE_INVALID", "ERROR", "spec.fields"),
            ("CONTRACT_SHAPE_INVALID", "ERROR", "spec.name"),
            ("CONTRACT_SHAPE_INVALID", "ERROR", "spec.schema_code"),
            ("CONTRACT_SHAPE_INVALID", "ERROR", "version"),
        ]
        for language in ("python", "node"):
            self.assertEqual(signatures(entry_errors(language, "business-schema/v1", "registered", value)), expected)

    def test_view_registered_shell_requires_view_identity_and_six_spec_fields(self):
        value = {"contract_version": "view-schema/lce-safe-v1", "spec": {}}
        expected_paths = ["audit", "base_version", "canonicalization_profile", "checksum", "lifecycle", "scope_id", "scope_type", "spec.businessSchemaRef", "spec.componentRegistryRef", "spec.componentsTree", "spec.name", "spec.view_code", "spec.view_type", "version", "view_id"]
        expected = [("CONTRACT_SHAPE_INVALID", "ERROR", path) for path in expected_paths]
        for language in ("python", "node"):
            self.assertEqual(signatures(entry_errors(language, "view-schema/lce-safe-v1", "registered", value)), expected)

    def test_registered_audit_nullable_unions_reject_invalid_identity_and_time(self):
        draft = json.loads(
            (ROOT / "tests/meta-schema/0a-core-r1/inputs/app-registered-draft.json").read_text(encoding="utf-8")
        )
        published = json.loads(
            (ROOT / "tests/meta-schema/0a-core-r1/inputs/app-registered-published-valid.json").read_text(encoding="utf-8")
        )
        mutations = [
            ("approved_by", "not-a-uuid"),
            ("approved_at", "2026-09-08T08:01:00+08:00"),
            ("published_by", "not-a-uuid"),
            ("published_at", "2026-09-08T08:02:00+08:00"),
        ]
        for language in ("python", "node"):
            with self.subTest(language=language, state="draft-null-pairs"):
                self.assertEqual(entry_errors(language, "app-spec/v1alpha1", "registered", draft), [])
            with self.subTest(language=language, state="published-non-null-pairs"):
                self.assertEqual(entry_errors(language, "app-spec/v1alpha1", "registered", published), [])
            for field, invalid in mutations:
                with self.subTest(language=language, field=field):
                    value = copy.deepcopy(published)
                    value["audit"][field] = invalid
                    self.assertEqual(
                        signatures(entry_errors(language, "app-spec/v1alpha1", "registered", value)),
                        [("CONTRACT_SHAPE_INVALID", "ERROR", f"audit.{field}")],
                    )

    def test_business_source_ref_nullable_union_cannot_hide_its_only_error(self):
        temp = Path(tempfile.mkdtemp(prefix="kvvi-meta-source-ref-")) / "bundle"
        shutil.copytree(SUITE, temp)
        self.addCleanup(shutil.rmtree, temp.parent)
        schema_path = temp / "business-schema.v1.schema.json"
        schema = json.loads(schema_path.read_text(encoding="utf-8"))
        schema["$defs"]["Spec"] = {
            "type": "object",
            "properties": {},
            "additionalProperties": False,
        }
        schema_path.write_text(json.dumps(schema, indent=2) + "\n", encoding="utf-8")
        refresh_manifest_digest(temp, schema_path.name)

        value = json.loads(
            (ROOT / "tests/meta-schema/0a-core-r1/inputs/app-registered-published-valid.json").read_text(encoding="utf-8")
        )
        value["contract_version"] = "business-schema/v1"
        value["schema_id"] = value.pop("app_id")
        value["source_ref"] = copy.deepcopy(VALID_ASSET_REF)
        value["spec"] = {}
        for language in ("python", "node"):
            with self.subTest(language=language):
                self.assertEqual(
                    signatures(entry_errors(language, "business-schema/v1", "registered", value, temp)),
                    [("CONTRACT_SHAPE_INVALID", "ERROR", "source_ref")],
                )


class HarnessIntegrityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.harness = load_module("kvvi_meta_conformance", CONFORMANCE)

    def test_duplicate_case_ids_are_configuration_failure(self):
        case = {"id": "same"}
        with self.assertRaisesRegex(ValueError, "duplicate case id"):
            self.harness.validate_case_inventory([case, copy.deepcopy(case)], ("python", "node"))

    def test_missing_language_is_configuration_failure(self):
        with self.assertRaisesRegex(ValueError, "required languages"):
            self.harness.validate_case_inventory([{"id": "one"}], ("python",))

    def test_actual_runner_map_must_contain_both_languages(self):
        case = copy.deepcopy(self.harness.load_cases()[0])
        for runners in ({}, {"python": self.harness.DEFAULT_RUNNERS["python"]}):
            with self.subTest(runners=tuple(runners)):
                with self.assertRaisesRegex(ValueError, "required languages"):
                    self.harness.run_case(case, runners=runners)

    def test_wrong_literal_expectation_is_not_cross_language_success(self):
        case = copy.deepcopy(self.harness.load_cases()[0])
        case["expected"]["exit_code"] = 9
        outcomes = self.harness.run_case(case)
        self.assertFalse(self.harness.case_matches_expected(case, outcomes))

    def test_single_language_outcome_cannot_match_expected(self):
        case = copy.deepcopy(self.harness.load_cases()[0])
        outcomes = self.harness.run_case(case)
        outcomes.pop("node")
        self.assertFalse(self.harness.case_matches_expected(case, outcomes))

    def test_fixed_result_identity_fields_are_compared(self):
        case = copy.deepcopy(self.harness.load_cases()[0])
        for field, wrong in [
            ("suite_revision", "wrong-suite"),
            ("entry", "spec"),
            ("checks", "complete"),
            ('stage', 'invented-stage'),
        ]:
            with self.subTest(field=field):
                outcomes = self.harness.run_case(case)
                outcomes["node"]["payload"][field] = wrong
                self.assertFalse(self.harness.case_matches_expected(case, outcomes))

    def test_runner_execution_failure_is_not_protocol_rejection(self):
        case = copy.deepcopy(self.harness.load_cases()[0])
        with self.assertRaises(self.harness.RunnerFailure):
            self.harness.run_case(case, runners={"python": ["/missing/kvvi-python"], "node": ["node"]})

    def test_runner_timeout_is_not_protocol_rejection(self):
        case = copy.deepcopy(self.harness.load_cases()[0])
        sleeper = [sys.executable, "-c", "import time; time.sleep(1)"]
        with self.assertRaisesRegex(self.harness.RunnerFailure, "timed out"):
            self.harness.run_case(
                case,
                runners={"python": sleeper, "node": sleeper},
                timeout_seconds=0.01,
            )

    def test_focused_selection_preserves_default_full_inventory(self):
        cases = self.harness.load_cases()
        self.assertEqual(self.harness.select_cases(cases), cases)
        selected = self.harness.select_cases(cases, case_id="C02-app-compiled-empty-valid")
        self.assertEqual([case["id"] for case in selected], ["C02-app-compiled-empty-valid"])
        grouped = self.harness.select_cases(cases, group="C01")
        self.assertTrue(grouped)
        self.assertTrue(all("C01" in case["groups"] for case in grouped))

    def test_empty_focused_selection_is_configuration_failure(self):
        with self.assertRaisesRegex(ValueError, "no cases selected"):
            self.harness.select_cases(self.harness.load_cases(), case_id="missing")


class RawInputTests(unittest.TestCase):
    def assert_raw_rejection(self, raw: bytes, code: str) -> None:
        commands = [
            [sys.executable, str(ROOT / "tools/meta-schema/python/cli.py")],
            ["node", str(ROOT / "tools/meta-schema/node/cli.mjs")],
        ]
        arguments = [
            "--contract", "app-spec/v1alpha1",
            "--entry", "compiled-draft",
            "--checks", "structure",
        ]
        for command in commands:
            with self.subTest(command=command[0]):
                completed = subprocess.run(
                    [*command, *arguments], cwd=ROOT, input=raw, capture_output=True, check=False
                )
                self.assertEqual(completed.returncode, 2, completed.stderr)
                payload = json.loads(completed.stdout)
                self.assertEqual(signatures(payload["validation"]["errors"]), [(code, "ERROR", "$")])

    def test_bom_is_rejected_before_json_parsing(self):
        self.assert_raw_rejection(b"\xef\xbb\xbf{}", "CANON_JSON_INVALID")

    def test_invalid_utf8_is_rejected_without_replacement(self):
        self.assert_raw_rejection(b'{"x":"\x80"}', "CANON_INVALID_UNICODE")

    def test_canonicalizer_buffer_covers_approved_one_mib_spec_plus_wrappers(self):
        raw = json.dumps(
            {
                "contract_version": "view-schema/lce-safe-v1",
                "base_version": 0,
                "spec": {"payload": "x" * 1_100_000},
            },
            separators=(",", ":"),
        ).encode("utf-8")
        arguments = [
            "--contract", "view-schema/lce-safe-v1",
            "--entry", "compiled-draft",
            "--checks", "structure",
        ]
        for command in [
            [sys.executable, str(ROOT / "tools/meta-schema/python/cli.py")],
            ["node", str(ROOT / "tools/meta-schema/node/cli.mjs")],
        ]:
            with self.subTest(command=command[0]):
                completed = subprocess.run(
                    [*command, *arguments], cwd=ROOT, input=raw, capture_output=True, check=False
                )
                self.assertEqual(completed.returncode, 2)
                payload = json.loads(completed.stdout)
                self.assertEqual(
                    signatures(payload["validation"]["errors"]),
                    [("VIEW_LIMIT_EXCEEDED", "ERROR", "spec")],
                )

    def test_cli_canonicalizer_timeout_is_json_execution_failure(self):
        environment = {**os.environ, "KVVI_META_INTERNAL_TIMEOUT_MS": "1"}
        raw = (ROOT / "tests/meta-schema/0a-core-r1/inputs/app-compiled-empty.json").read_bytes()
        arguments = [
            "--contract", "app-spec/v1alpha1",
            "--entry", "compiled-draft",
            "--checks", "structure",
        ]
        for command in [
            [sys.executable, str(ROOT / "tools/meta-schema/python/cli.py")],
            ["node", str(ROOT / "tools/meta-schema/node/cli.mjs")],
        ]:
            with self.subTest(command=command[0]):
                completed = subprocess.run(
                    [*command, *arguments], cwd=ROOT, input=raw, capture_output=True, check=False, env=environment
                )
                self.assertEqual(completed.returncode, 1)
                self.assertEqual(json.loads(completed.stdout)["execution"]["code"], "EXECUTION_TIMEOUT")


class CliArgumentTests(unittest.TestCase):
    def assert_argument_failure(self, extra_arguments: list[str]) -> None:
        raw = b"{}"
        base = [
            "--contract", "app-spec/v1alpha1",
            "--entry", "compiled-draft",
            "--checks", "structure",
        ]
        outputs = []
        for command in [
            [sys.executable, str(ROOT / "tools/meta-schema/python/cli.py")],
            ["node", str(ROOT / "tools/meta-schema/node/cli.mjs")],
        ]:
            completed = subprocess.run(
                [*command, *base, *extra_arguments], cwd=ROOT, input=raw, capture_output=True, check=False
            )
            self.assertEqual(completed.returncode, 1)
            self.assertEqual(completed.stderr, b"")
            outputs.append(json.loads(completed.stdout))
        self.assertEqual(outputs[0], outputs[1])
        self.assertEqual(outputs[0]["execution"]["code"], "CLI_ARGUMENT_INVALID")

    def test_unknown_argument_is_rejected_identically(self):
        self.assert_argument_failure(["--unknown", "value"])

    def test_duplicate_argument_is_rejected_identically(self):
        self.assert_argument_failure(["--checks", "complete"])


class StageInterfaceTests(unittest.TestCase):
    def test_reference_stage_closes_real_fake_composition(self):
        from integration_fixtures import composition
        value,context=composition()
        sys.path.insert(0, str(PYTHON_TOOLS))
        try:
            references = load_module("kvvi_meta_references", PYTHON_TOOLS / "references.py")
            errors = references.validate_references(
                "app-spec/v1alpha1", "compiled-draft", value, context
            )
        finally:
            sys.path.pop(0)
        self.assertEqual(signatures(errors), [])

    def test_missing_complete_context_is_protocol_rejection(self):
        raw = (CASE_ROOT := ROOT / "tests/meta-schema/0a-core-r1/inputs/app-compiled-empty.json").read_bytes()
        for command in [
            [sys.executable, str(ROOT / "tools/meta-schema/python/cli.py")],
            ["node", str(ROOT / "tools/meta-schema/node/cli.mjs")],
        ]:
            completed = subprocess.run(
                [*command, "--contract", "app-spec/v1alpha1", "--entry", "compiled-draft", "--checks", "complete"],
                cwd=ROOT, input=raw, capture_output=True, check=False
            )
            self.assertEqual(completed.returncode, 2)
            payload = json.loads(completed.stdout)
            self.assertEqual(signatures(payload["validation"]["errors"]), [("TRUSTED_CONTEXT_REQUIRED", "ERROR", "spec")])

    def test_corrupt_context_is_execution_failure(self):
        raw = (ROOT / "tests/meta-schema/0a-core-r1/inputs/app-compiled-empty.json").read_bytes()
        with tempfile.TemporaryDirectory(prefix="kvvi-meta-context-") as directory:
            context = Path(directory) / "context.json"
            context.write_text("{", encoding="utf-8")
            for command in [
                [sys.executable, str(ROOT / "tools/meta-schema/python/cli.py")],
                ["node", str(ROOT / "tools/meta-schema/node/cli.mjs")],
            ]:
                completed = subprocess.run(
                    [*command, "--contract", "app-spec/v1alpha1", "--entry", "compiled-draft", "--checks", "complete", "--context", str(context)],
                    cwd=ROOT, input=raw, capture_output=True, check=False
                )
                self.assertEqual(completed.returncode, 1)


if __name__ == "__main__":
    unittest.main()
