"""View real-engine tests: independently fixed results, no mutation, two languages."""
import copy
import json
from pathlib import Path
import subprocess
import sys
import unittest

from view_cases import cases
from view_cases_extended import cases as extended_cases

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools/meta-schema/python"))
from semantic import validate_view
from structure import validate_structure


class ViewTests(unittest.TestCase):
    def test_scanner_position_policy_preserves_inert_text_and_dictionary_keys(self):
        from final_fix_fixtures import SCANNER_POSITION_CASES, scanner_position_case
        from test_integration import run
        for position, text, code in SCANNER_POSITION_CASES:
            body, context, path = scanner_position_case(position, text)
            for language, (exit_code, payload) in zip(('python', 'node'), run(body, context, contract='view-schema/lce-safe-v1', entry='spec')):
                with self.subTest(position=position, text=text, language=language):
                    self.assertEqual(exit_code, 2 if code else 0, payload)
                    self.assertEqual(payload['stage'], 'structure' if code else 'complete')
                    self.assertEqual([(e['code'], e['path']) for e in payload['validation']['errors']], [(code, path)] if code else [])

    def test_explicit_scanner_lexical_table_at_real_text_position(self):
        from final_fix_fixtures import SCANNER_TEXT_CASES, scanner_text_case
        from test_integration import run
        for name, text, prohibited in SCANNER_TEXT_CASES:
            for language, (exit_code, payload) in zip(('python', 'node'), run(
                *scanner_text_case(text), contract='view-schema/lce-safe-v1', entry='spec'
            )):
                with self.subTest(name=name, language=language):
                    self.assertEqual(exit_code, 2 if prohibited else 0, payload)
                    self.assertEqual(payload['stage'], 'structure' if prohibited else 'complete')
                    self.assertEqual([(e['code'], e['path']) for e in payload['validation']['errors']],
                                     [('VIEW_RAW_CODE_FORBIDDEN', 'componentsTree[0].children[0].props["text"]')] if prohibited else [])

    def test_prd_original_and_rebound_are_distinct_evidence(self):
        folder=ROOT/"tests/meta-schema/0a-core-r1"
        original=json.loads((folder/"inputs/view-prd-7-25-original.json").read_text())
        rebound=json.loads((folder/"inputs/view-prd-7-25-fake.json").read_text())
        context=json.loads((folder/"contexts/view-prd-7-25-fake.json").read_text())
        self.assertEqual(validate_structure("view-schema/lce-safe-v1","compiled-draft",original),[])
        self.assertEqual(validate_structure("view-schema/lce-safe-v1","compiled-draft",rebound),[])
        self.assertEqual(validate_view(rebound["spec"],context,"spec"),[])
        self.assertEqual([(e["code"],e["path"]) for e in validate_view(original["spec"],context,"spec")],[("VIEW_COMPONENT_UNREGISTERED","spec.componentRegistryRef")])

    def test_frozen_view_expectations_and_in_memory_immutability(self):
        corpus = cases() + extended_cases()
        source = """
          import {readFileSync} from 'node:fs';
          import {validateView} from './tools/meta-schema/node/semantic.mjs';
          import {validateStructure} from './tools/meta-schema/node/structure.mjs';
          const cases=JSON.parse(readFileSync(0,'utf8'));
          const out=cases.map(c=>{
            const before=JSON.stringify([c.spec,c.context]);
            const errors=c.stage==='structure'?validateStructure('view-schema/lce-safe-v1','spec',c.spec):validateView(c.spec,c.context,'');
            return {errors,unchanged:before===JSON.stringify([c.spec,c.context])};
          });
          process.stdout.write(JSON.stringify(out));
        """
        run = subprocess.run(["node", "--input-type=module", "-e", source], input=json.dumps(corpus),
                             text=True, capture_output=True, cwd=ROOT, timeout=120)
        self.assertEqual(run.returncode, 0, run.stderr)
        outputs = json.loads(run.stdout)
        self.assertEqual(len(outputs), len(corpus))
        for case, node in zip(corpus, outputs):
            with self.subTest(case=case["id"]):
                before = copy.deepcopy([case["spec"], case["context"]])
                errors = validate_structure("view-schema/lce-safe-v1", "spec", case["spec"]) if case["stage"] == "structure" else validate_view(case["spec"], case["context"], "")
                want = [tuple(x) for x in case["expected"]]
                self.assertEqual([(e["code"],e["path"]) for e in errors], want, "python")
                self.assertEqual([(e["code"],e["path"]) for e in node["errors"]], want, "node")
                self.assertEqual([case["spec"],case["context"]], before)
                self.assertTrue(node["unchanged"])


if __name__ == "__main__":
    unittest.main()
