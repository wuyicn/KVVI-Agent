#!/usr/bin/env python3
"""Shared black-box suite for the two independent Meta-Schema CLIs."""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import unittest
import time
import math


ROOT = Path(__file__).resolve().parents[2]
CASE_ROOT = Path(__file__).with_name("0a-core-r1")
DEFAULT_RUNNERS = {
    "python": [sys.executable, str(ROOT / "tools/meta-schema/python/cli.py")],
    "node": ["node", str(ROOT / "tools/meta-schema/node/cli.mjs")],
}
REQUIRED_LANGUAGES = ("python", "node")
SELECTED_CASES: list[dict[str, object]] | None = None


class RunnerFailure(RuntimeError):
    pass


def strict_json(raw):
    def pairs(items):
        value = {}
        for key, datum in items:
            if key in value:
                raise ValueError('duplicate JSON key')
            value[key] = datum
        return value
    def number(token):
        value=float(token)
        if not math.isfinite(value): raise ValueError('nonfinite JSON number')
        return value
    return json.loads(raw, object_pairs_hook=pairs, parse_float=number,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError('nonfinite JSON')))


def file_hash(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def fixture_path(name):
    if type(name) is not str or name.startswith('/') or '..' in Path(name).parts or not name.startswith(('inputs/', 'contexts/')):
        raise RunnerFailure('unsafe fixture path')
    path = CASE_ROOT / name
    current=path
    while current != CASE_ROOT:
        if current.is_symlink(): raise RunnerFailure('unsafe fixture path')
        current=current.parent
    if not path.resolve().is_relative_to(CASE_ROOT.resolve()):
        raise RunnerFailure('unsafe fixture path')
    return path


def load_cases() -> list[dict[str, object]]:
    cases = strict_json((CASE_ROOT / 'cases.json').read_bytes())['cases']
    inventory = inventory_map(strict_json((CASE_ROOT.parent / 'expected-inventory.json').read_bytes())['cases'])
    actual = {case['id']:hashlib.sha256(json.dumps(case,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest() for case in cases}
    if len(actual) != len(cases) or actual != inventory:
        raise ValueError('independent case inventory or oracle mismatch')
    return cases


def inventory_map(records):
    if type(records) is not list or any(type(row) is not dict or set(row) != {'id','sha256'} or type(row['id']) is not str or type(row['sha256']) is not str for row in records):
        raise ValueError('invalid independent inventory records')
    result={row['id']:row['sha256'] for row in records}
    if len(result) != len(records): raise ValueError('duplicate independent inventory ID')
    return result


def validate_case_inventory(cases: list[dict[str, object]], languages: tuple[str, ...]) -> None:
    identifiers = [str(case["id"]) for case in cases]
    if len(identifiers) != len(set(identifiers)):
        raise ValueError("duplicate case id")
    if set(languages) != set(REQUIRED_LANGUAGES):
        raise ValueError("required languages are python and node")


def select_cases(
    cases: list[dict[str, object]], case_id: str | None = None, group: str | None = None
) -> list[dict[str, object]]:
    selected = [
        case
        for case in cases
        if (case_id is None or case["id"] == case_id)
        and (group is None or group in case["groups"])
    ]
    if not selected:
        raise ValueError("no cases selected")
    return selected


def diagnostic_signatures(payload: dict[str, object]) -> list[dict[str, str]]:
    validation = payload["validation"]
    assert isinstance(validation, dict)
    errors = validation["errors"]
    assert isinstance(errors, list)
    return [
        {"code": item["code"], "severity": item["severity"], "path": item["path"]}
        for item in errors
    ]


def run_case(
    case: dict[str, object],
    runners: dict[str, list[str]] | None = None,
    timeout_seconds: float = 15.0,
) -> dict[str, dict[str, object]]:
    selected = DEFAULT_RUNNERS if runners is None else runners
    validate_case_inventory([case], tuple(selected))
    raw_path = fixture_path(case["input"])
    before = raw_path.read_bytes()
    context_path = fixture_path(case['context']) if case.get('context') else None
    context_before = context_path.read_bytes() if context_path else None
    arguments = [
        "--contract", str(case["contract"]),
        "--entry", str(case["entry"]),
        "--checks", str(case["checks"]),
    ]
    if case.get("context"):
        arguments.extend(["--context", str(context_path)])
    def invoke(language: str, command: list[str]) -> tuple[str, dict[str, object]]:
        started = time.monotonic()
        try:
            completed = subprocess.run(
                [*command, *arguments],
                cwd=ROOT,
                input=before,
                check=False,
                capture_output=True,
                timeout=timeout_seconds,
            )
        except subprocess.TimeoutExpired as exc:
            raise RunnerFailure(f"{language} runner timed out") from exc
        except OSError as exc:
            raise RunnerFailure(f"{language} runner failed to execute") from exc
        if completed.returncode not in (0, 2):
            raise RunnerFailure(f"{language} runner execution failure")
        if completed.stderr:
            raise RunnerFailure(f"{language} runner wrote stderr")
        try:
            payload = strict_json(completed.stdout)
        except (UnicodeDecodeError, ValueError) as exc:
            raise RunnerFailure(f"{language} runner emitted invalid JSON") from exc
        return language, {"exit_code": completed.returncode, "payload": payload,
                          "stdout": completed.stdout.decode('utf-8'), "stderr": '',
                          "elapsed_seconds": round(time.monotonic() - started, 6),
                          "input_before_sha256": hashlib.sha256(before).hexdigest(),
                          "input_after_sha256": file_hash(raw_path),
                          "context_before_sha256": hashlib.sha256(context_before).hexdigest() if context_before is not None else None,
                          "context_after_sha256": file_hash(context_path) if context_path else None}

    outcomes: dict[str, dict[str, object]] = {}
    with ThreadPoolExecutor(max_workers=len(selected)) as executor:
        futures = [executor.submit(invoke, language, command) for language, command in selected.items()]
        for future in futures:
            language, outcome = future.result()
            outcomes[language] = outcome
    if raw_path.read_bytes() != before:
        raise RunnerFailure("validator modified the input fixture")
    if context_path and context_path.read_bytes() != context_before:
        raise RunnerFailure('validator modified the context fixture')
    return outcomes


def case_matches_expected(
    case: dict[str, object], outcomes: dict[str, dict[str, object]]
) -> bool:
    expected = case["expected"]
    assert isinstance(expected, dict)
    if type(expected.get('valid')) is not bool or type(expected.get('exit_code')) is not int:
        return False
    if set(outcomes) != set(REQUIRED_LANGUAGES):
        return False
    expected_projection = {
        "suite_revision": expected["suite_revision"],
        "entry": expected["entry"],
        "checks": expected["checks"],
        "exit_code": expected["exit_code"],
        "valid": expected["valid"],
        "errors": expected["errors"],
        "stage": case['expected_stage'],
    }
    projections = []
    raw_sha = file_hash(fixture_path(case['input']))
    for outcome in outcomes.values():
        payload = outcome["payload"]
        if not isinstance(payload, dict) or type(outcome['exit_code']) is not int or outcome['exit_code'] not in (0, 2):
            return False
        if not isinstance(payload.get('validation'), dict) or type(payload['validation'].get('valid')) is not bool:
            return False
        if set(payload) != {'suite_revision','entry','checks','stage','input_sha256','validation','release_approved'} or set(payload['validation']) != {'valid','errors'}:
            return False
        errors = payload['validation']['errors']
        if type(errors) is not list or any(type(error) is not dict or set(error) != {'code','severity','path','message','suggested_fix'} or any(type(value) is not str for value in error.values()) for error in errors):
            return False
        if any(type(payload.get(field)) is not str for field in ('suite_revision','entry','checks','stage','input_sha256')):
            return False
        projections.append(
            {
                "suite_revision": payload.get("suite_revision"),
                "entry": payload.get("entry"),
                "checks": payload.get("checks"),
                "exit_code": outcome["exit_code"],
                "valid": payload["validation"]["valid"],
                "errors": diagnostic_signatures(payload),
                "stage": payload.get('stage'),
            }
        )
        if payload.get("input_sha256") != raw_sha or payload.get("release_approved") is not False:
            return False
    return all(projection == expected_projection for projection in projections) and len(
        {json.dumps(item, sort_keys=True) for item in projections}
    ) == 1


class SharedConformanceTests(unittest.TestCase):
    def test_all_registered_cases_match_literal_expectations_in_both_languages(self):
        cases = SELECTED_CASES or load_cases()
        validate_case_inventory(cases, REQUIRED_LANGUAGES)
        for case in cases:
            with self.subTest(case=case["id"]):
                outcomes = run_case(case)
                self.assertTrue(case_matches_expected(case, outcomes), outcomes)


def main() -> int:
    global SELECTED_CASES
    parser = argparse.ArgumentParser()
    parser.add_argument("--suite", default="0a-core-r1")
    parser.add_argument("--case-id")
    parser.add_argument("--group")
    arguments, unittest_args = parser.parse_known_args()
    if arguments.suite != "0a-core-r1":
        parser.error("unsupported suite")
    try:
        SELECTED_CASES = select_cases(load_cases(), arguments.case_id, arguments.group)
    except ValueError as exc:
        parser.error(str(exc))
    program = unittest.main(argv=[sys.argv[0], *unittest_args], exit=False, verbosity=2)
    return 0 if program.result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
