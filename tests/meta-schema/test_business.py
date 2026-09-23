"""Business contract assertions, two independent implementations and no mutation."""

import copy
import json
from pathlib import Path
import subprocess
import sys
import unittest

from business_cases import cases, business, rule, leaf

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools/meta-schema/python"))
from semantic import validate_business
from structure import validate_structure


class BusinessTests(unittest.TestCase):
    def test_prd_source_and_rebound_examples_have_structure_and_static_semantics(self):
        folder = ROOT / "tests/meta-schema/0a-core-r1"
        context = json.loads(
            (folder / "contexts/business-prd-7-14-fake.json").read_text()
        )
        for name in ("business-prd-7-14-original.json", "business-prd-7-14-fake.json"):
            draft = json.loads((folder / "inputs" / name).read_text())
            self.assertEqual(
                validate_structure("business-schema/v1", "compiled-draft", draft), []
            )
            self.assertEqual(validate_business(draft["spec"], context, "spec"), [])

    def test_expression_budget_rejects_before_recursive_schema_descent(self):
        expr = leaf()
        for _ in range(40):
            expr = {"not": expr}
        value = business(record_rules=[rule(expr)])
        errors = validate_structure("business-schema/v1", "spec", value)
        self.assertEqual(
            [(e["code"], e["path"]) for e in errors],
            [("CONSTRAINT_INCOMPATIBLE", "record_rules[0].assert")],
        )
        source = """
          import {readFileSync} from 'node:fs';
          import {validateStructure} from './tools/meta-schema/node/structure.mjs';
          process.stdout.write(JSON.stringify(validateStructure('business-schema/v1','spec',JSON.parse(readFileSync(0,'utf8')))));
        """
        run = subprocess.run(
            ["node", "--input-type=module", "-e", source],
            input=json.dumps(value),
            text=True,
            capture_output=True,
            cwd=ROOT,
            timeout=5,
        )
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(
            [(e["code"], e["path"]) for e in json.loads(run.stdout)],
            [("CONSTRAINT_INCOMPATIBLE", "record_rules[0].assert")],
        )

    def test_linear_pattern_matcher_does_not_expand_or_backtrack(self):
        from safe_pattern import parse_safe_pattern, match_safe_pattern

        samples = [
            ("^" + "a*" * 60 + "b$", "a" * 20000, False),
            ("^a{9999999999999999999999999999999999999999999999999}$", "a", False),
            ("^[😀-🙏]{2}$", "😀🙏", True),
            ("^a?$", "", True),
            ("a$", "a\n", False),
        ]
        for pattern, text, want in samples:
            self.assertEqual(
                match_safe_pattern(parse_safe_pattern(pattern), text), want
            )
        source = """
          import {readFileSync} from 'node:fs';
          import {parseSafePattern,matchSafePattern} from './tools/meta-schema/node/safe_pattern.mjs';
          process.stdout.write(JSON.stringify(JSON.parse(readFileSync(0,'utf8')).map(([p,t])=>matchSafePattern(parseSafePattern(p),t))));
        """
        run = subprocess.run(
            ["node", "--input-type=module", "-e", source],
            input=json.dumps(samples),
            text=True,
            capture_output=True,
            cwd=ROOT,
            timeout=5,
        )
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(json.loads(run.stdout), [False, False, True, True, False])

    def test_frozen_business_expectations_and_in_memory_immutability(self):
        corpus = cases()
        source = """
          import {readFileSync} from 'node:fs';
          import {validateBusiness} from './tools/meta-schema/node/semantic.mjs';
          import {validateStructure} from './tools/meta-schema/node/structure.mjs';
          const cases=JSON.parse(readFileSync(0,'utf8'));
          const out=cases.map(c=>{const before=JSON.stringify([c.spec,c.context]);
            const errors=c.stage==='structure'?validateStructure('business-schema/v1','spec',c.spec):validateBusiness(c.spec,c.context,'');
            return {errors,unchanged:before===JSON.stringify([c.spec,c.context])};});
          process.stdout.write(JSON.stringify(out));"""
        run = subprocess.run(
            ["node", "--input-type=module", "-e", source],
            input=json.dumps(corpus),
            text=True,
            capture_output=True,
            cwd=ROOT,
            timeout=120,
        )
        self.assertEqual(run.returncode, 0, run.stderr)
        outputs = json.loads(run.stdout)
        self.assertEqual(len(outputs), len(corpus))
        for case, node in zip(corpus, outputs):
            with self.subTest(case=case["id"]):
                before = copy.deepcopy([case["spec"], case["context"]])
                errors = (
                    validate_structure("business-schema/v1", "spec", case["spec"])
                    if case["stage"] == "structure"
                    else validate_business(case["spec"], case["context"], "")
                )
                want = [tuple(x) for x in case["expected"]]
                self.assertEqual(
                    [(e["code"], e["path"]) for e in errors], want, "python"
                )
                self.assertEqual(
                    [(e["code"], e["path"]) for e in node["errors"]], want, "node"
                )
                self.assertEqual([case["spec"], case["context"]], before)
                self.assertTrue(node["unchanged"])


if __name__ == "__main__":
    unittest.main()
