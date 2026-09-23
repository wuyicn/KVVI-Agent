"""Regression witnesses for source-named external review FIX2, real dual CLIs."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import unittest
from test_integration import run
from external_review_fix2_fixtures import cases, registry_case, REGISTRY_FORMATS, business_base


class ExternalReviewFix2(unittest.TestCase):
    def test_secret_scan_incomplete_assignment_does_not_exhaust_cli_budget(self):
        value, context = business_base()
        value['fields'][0].update(type='long_text', default='password' + ' ' * 19990,
                                  constraints={'max_length': 20000})
        value['fields'] = [dict(value['fields'][0], field_code='note_' + str(index)) for index in range(20)]
        try:
            outcomes = run(value, context, contract='business-schema/v1', entry='spec')
        except subprocess.TimeoutExpired:
            self.fail('incomplete secret assignment exhausted the existing 15 second CLI budget')
        for status, result in outcomes:
            self.assertEqual(status, 0, result)
            self.assertEqual(result['stage'], 'complete')

    def test_fix2_rule_record_is_covered_by_source_evidence_binding(self):
        root = Path(__file__).resolve().parents[2]
        module = importlib.util.spec_from_file_location('fix2_evidence', root / 'tools/meta-schema/record_evidence.py')
        evidence = importlib.util.module_from_spec(module)
        module.loader.exec_module(evidence)
        self.assertTrue(evidence.source_path('contracts/meta-schemas/0a-core-r1/EXTERNAL-REVIEW-FIX2.md'))

    def check_cases(self, prefix):
        for case in cases():
            if not case['name'].startswith(prefix): continue
            before = copy.deepcopy((case['value'], case['context']))
            for language, (status, result) in zip(('python', 'node'), run(
                    case['value'], case['context'], contract=case['contract'],
                    entry=case['entry'], checks=case['checks'])):
                with self.subTest(case=case['name'], language=language):
                    self.assertEqual(status, 2 if case['expected'] else 0, result)
                    self.assertEqual(result['stage'], case['stage'])
                    self.assertEqual([(e['code'], e['path']) for e in result['validation']['errors']], case['expected'])
                    self.assertIs(result['release_approved'], False)
                    self.assertNotIn('FAKE_TEST_ONLY', json.dumps(result))
            self.assertEqual((case['value'], case['context']), before)

    def test_secret_values_are_rejected_without_echo_and_prose_stays_inert(self):
        self.check_cases('secret-')

    def test_record_number_label_does_not_inherit_field_label_limits(self):
        self.check_cases('number-label-')

    def test_permission_injections_have_specific_diagnostics_without_widening_shape(self):
        self.check_cases('permission-')

    def test_pattern_search_and_explicit_anchors_are_distinct(self):
        self.check_cases('pattern-')

    def test_registry_format_profile_is_fixed_at_all_four_schema_slots(self):
        for slot in ('inputSchema', 'outputSchema', 'errorSchema', 'propsSchema'):
            for name, kind, valid in REGISTRY_FORMATS:
                value, context = registry_case(slot, name, kind)
                before = copy.deepcopy((value, context))
                for language, (status, result) in zip(('python', 'node'), run(value, context)):
                    with self.subTest(slot=slot, format=name, language=language):
                        self.assertEqual(status, 0 if valid else 1, result)
                        if valid:
                            self.assertIs(result['validation']['valid'], True)
                            self.assertEqual(result['stage'], 'complete')
                        else:
                            self.assertEqual(result['execution'], {'status': 'failed', 'code': 'REGISTRY_CONFIGURATION_INVALID'})
                            self.assertNotIn('validation', result)
                        self.assertIs(result['release_approved'], False)
                self.assertEqual((value, context), before)


if __name__ == '__main__':
    unittest.main()
