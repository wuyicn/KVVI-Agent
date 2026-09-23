#!/usr/bin/env python3
"""Materialize independently authored inputs/expectations; never runs validators.

Only derived fixture files are written. The source example is a separately
reviewed literal transcription of frozen PRD 7.14, not generated from runtime
validation results. c14n is used solely to bind Fake asset content digests.
"""
import copy
import hashlib
import json
from pathlib import Path
import subprocess
import sys

from business_cases import CONTEXT, TYPES, cases
from integration_fixtures import close_context

ROOT = Path(__file__).resolve().parents[2]
DEST = Path(__file__).with_name("0a-core-r1")


def dump(value):
    return json.dumps(value, ensure_ascii=False, indent=2) + "\n"


def write(path, value):
    (DEST / path).write_text(dump(value), encoding="utf-8")


def digest(content):
    canonical = subprocess.run(
        [
            sys.executable,
            str(
                ROOT
                / "protocol/kvvi-json-c14n/v1/evidence-sets/prd-v1.11/python/kvvi_json_c14n.py"
            ),
            "--profile",
            "kvvi-json-c14n/v1",
        ],
        input=json.dumps(content).encode(),
        capture_output=True,
        check=True,
    )
    return (
        "sha256:"
        + hashlib.sha256(json.loads(canonical.stdout)["canonical"].encode()).hexdigest()
    )


def main():
    table = json.loads((DEST / "cases.json").read_text())
    table["cases"] = [
        c
        for c in table["cases"]
        if not c.get("generated_by") == "generate_business_fixtures.py"
    ]

    def register(identifier, spec, expected, stage, context, group, entry="spec"):
        if stage != 'structure': spec,context=close_context(spec,context,'BUSINESS_SCHEMA',entry)
        input_path = "inputs/business-" + identifier + ".json"
        context_path = (
            "contexts/business-"
            + hashlib.sha256(dump(context).encode()).hexdigest()[:16]
            + ".json"
        )
        checks = "structure" if stage == "structure" else "complete"
        errors = [
            {"code": code, "severity": "ERROR", "path": path} for code, path in expected
        ]
        pending = stage != "structure" and not errors
        write(input_path, spec)
        item = dict(
            id="B-" + identifier,
            groups=[group, "Business"],
            input=input_path,
            contract="business-schema/v1",
            entry=entry,
            checks=checks,
            generated_by="generate_business_fixtures.py",
            expected_stage=(
                "complete"
                if pending
                else (
                    "structure"
                    if stage == "structure"
                    or identifier in {"reserved-id", "rule-21", "rule-depth-4"}
                    else "semantic"
                )
            ),
            expected=dict(
                suite_revision="0a-core-r1",
                entry=entry,
                checks=checks,
                exit_code=2 if errors else 0,
                valid=not errors,
                errors=errors,
            ),
        )
        # Type defaults exercise the specific B06-B13 contracts as well as B05.
        typed_groups = {
            "short_text": "B06",
            "long_text": "B07",
            "boolean": "B08",
            "integer": "B08",
            "decimal": "B09",
            "money": "B10",
            "date": "B11",
            "datetime": "B11",
            "single_select": "B12",
            "multi_select": "B13",
        }
        for kind, clause in typed_groups.items():
            if identifier in {
                "type-" + kind,
                "default-" + kind,
                "wrong-default-" + kind,
                "null-" + kind,
                "null-forbidden-" + kind,
            }:
                item["groups"] = sorted(set(item["groups"] + [clause]))
        if checks == "complete":
            write(context_path, context)
            item["context"] = context_path
        if pending: item['coverage_status']='complete-fixed-fake'
        table["cases"].append(item)

    corpus = cases()
    for c in corpus:
        register(
            c["id"], c["spec"], c["expected"], c["stage"], c["context"], c["group"]
        )
    original = json.loads((DEST / "inputs/business-prd-7-14-original.json").read_text())
    register(
        "prd-7-14-structure",
        original,
        [],
        "structure",
        CONTEXT,
        "B23",
        "compiled-draft",
    )
    rebound = copy.deepcopy(original)
    ctx = copy.deepcopy(CONTEXT)
    assets = []
    slots = [
        (
            rebound["spec"]["field_type_registry_ref"],
            {
                "fixture": True,
                "types": list(TYPES),
                "index_capabilities": copy.deepcopy(
                    CONTEXT["business"]["index_capabilities"]
                ),
            },
        ),
        (
            rebound["spec"]["record_number"]["sequence_policy_ref"],
            {"fixture": True, "policy": "fake-only-no-generation"},
        ),
    ]
    for ref, content in slots:
        ref["digest"] = digest(content)
        assets.append({"ref": copy.deepcopy(ref), "content": content})
    ctx["fake_assets"] = assets
    rebound,ctx=close_context(rebound,ctx,'BUSINESS_SCHEMA','compiled-draft')
    write("inputs/business-prd-7-14-fake.json", rebound)
    write("contexts/business-prd-7-14-fake.json", ctx)
    register(
        "prd-7-14-fake-complete",
        rebound,
        [],
        "semantic",
        ctx,
        "B23",
        "compiled-draft",
    )
    write("cases.json", table)
    print(
        json.dumps(
            {
                "business_static_cases": len(corpus),
                "shared_cli_cases": len(table["cases"]),
                "business_source_examples": 2,
            }
        )
    )


if __name__ == "__main__":
    main()
