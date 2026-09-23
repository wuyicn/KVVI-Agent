"""Review regressions prove direct APIs and raw CLI process boundaries."""

import json
from pathlib import Path
import subprocess
import sys
import unittest

from business_cases import cases

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools/meta-schema/python"))
from structure import validate_structure


class BusinessReviewTests(unittest.TestCase):
    def test_mixed_expression_budget_direct_apis(self):
        corpus = [c for c in cases() if c["id"].startswith("review-")]
        source = """
          import {readFileSync} from 'node:fs';
          import {validateStructure} from './tools/meta-schema/node/structure.mjs';
          process.stdout.write(JSON.stringify(JSON.parse(readFileSync(0,'utf8')).map(c=>validateStructure('business-schema/v1','spec',c.spec))));
        """
        run = subprocess.run(
            ["node", "--input-type=module", "-e", source],
            input=json.dumps(corpus),
            text=True,
            capture_output=True,
            cwd=ROOT,
            timeout=15,
        )
        self.assertEqual(run.returncode, 0, "Node direct API must not throw")
        node_results = json.loads(run.stdout)
        self.assertEqual(len(node_results), len(corpus))
        for case, node in zip(corpus, node_results):
            with self.subTest(case=case["id"]):
                try:
                    python = validate_structure(
                        "business-schema/v1", "spec", case["spec"]
                    )
                except RecursionError:
                    self.fail("budget bypass reached Python's recursive schema engine")
                want = [tuple(pair) for pair in case["expected"]]
                self.assertEqual([(e["code"], e["path"]) for e in python], want)
                self.assertEqual([(e["code"], e["path"]) for e in node], want)

    def test_mixed_expression_budget_raw_cli_is_json_protocol_rejection(self):
        corpus = [c for c in cases() if c["id"].startswith("review-")]
        commands = [
            [sys.executable, str(ROOT / "tools/meta-schema/python/cli.py")],
            ["node", str(ROOT / "tools/meta-schema/node/cli.mjs")],
        ]
        for case in corpus:
            for command in commands:
                with self.subTest(case=case["id"], language=command[0]):
                    run = subprocess.run(
                        [
                            *command,
                            "--contract",
                            "business-schema/v1",
                            "--entry",
                            "spec",
                            "--checks",
                            "structure",
                        ],
                        input=json.dumps(case["spec"]).encode(),
                        capture_output=True,
                        cwd=ROOT,
                        timeout=15,
                    )
                    self.assertEqual(
                        run.returncode,
                        2,
                        "raw input must be a JSON protocol rejection, not an execution failure",
                    )
                    self.assertEqual(
                        run.stderr, b"", "no input or exception stack in stderr"
                    )
                    result = json.loads(run.stdout)
                    self.assertFalse(result["release_approved"])
                    self.assertEqual(
                        [
                            (e["code"], e["path"])
                            for e in result["validation"]["errors"]
                        ],
                        [tuple(pair) for pair in case["expected"]],
                    )


if __name__ == "__main__":
    unittest.main()
