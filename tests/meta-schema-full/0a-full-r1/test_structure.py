"""Acceptance for the 13 public machine contracts, not runtime acceptance."""
import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[3]
BUNDLE = ROOT / 'contracts/meta-schemas/0a-full-r1'
NAMES = ['business-schema.v1', 'view-schema.lce-safe-v1', 'app-spec.v1alpha1',
         'permission-spec.v1alpha1', 'workflow-spec.v1alpha1', 'app-model-command.v1alpha1',
         'tool-spec.v1alpha1', 'migration-plan.v1alpha1', 'migration-run-event.v1alpha1',
         'artifact-manifest.v1alpha1', 'approval-attestation.v1alpha1',
         'promotion-record.v1alpha1', 'evidence-bundle.v1alpha1']


class FullStructureAcceptance(unittest.TestCase):
    def test_exact_public_protocol_inventory(self):
        self.assertEqual(set(p.name for p in BUNDLE.glob('*.schema.json')),
                         {n + '.schema.json' for n in NAMES} | {'common.schema.json'})

    def test_existing_three_and_common_keep_their_constraints(self):
        for name in ['common'] + NAMES[:3]:
            path = name + '.schema.json'
            self.assertTrue((BUNDLE / path).is_file(), path)
            old = json.loads((ROOT / 'contracts/meta-schemas/0a-core-r1' / path).read_text())
            new = json.loads((BUNDLE / path).read_text().replace('0a-full-r1', '0a-core-r1'))
            self.assertEqual(old, new, path)

    def test_independent_engines_match_fixed_positive_and_negative_cases(self):
        tool = ROOT / 'tools/meta-schema-full/0a-full-r1/verify.py'
        self.assertTrue(tool.is_file(), 'full verifier has not been delivered')
        spec = importlib.util.spec_from_file_location('full_verify', tool)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        report = module.verify()
        self.assertTrue(report['valid'], report)
        self.assertEqual(report['protocols'], 13)
        self.assertEqual(report['python_mismatches'], [])
        self.assertEqual(report['node_mismatches'], [])
        self.assertFalse(report['release_approved'])
        self.assertFalse(report['semantic_validation_complete'])


class FullVerifierBoundaryRegression(unittest.TestCase):
    """Fault injection at the bundle and CI boundaries, using synthetic values only."""

    @staticmethod
    def verifier():
        spec = importlib.util.spec_from_file_location(
            'full_verify_boundary', ROOT / 'tools/meta-schema-full/0a-full-r1/verify.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_required_source_bindings_cannot_be_omitted_or_substituted(self):
        import copy
        import shutil
        import tempfile

        module = self.verifier()
        with tempfile.TemporaryDirectory() as directory:
            bundle = Path(directory) / 'bundle'
            shutil.copytree(BUNDLE, bundle)
            path = bundle / 'manifest.json'
            manifest = json.loads(path.read_text(encoding='utf-8'))
            module.load_bundle(bundle)  # The exact source inventory must also accept.
            sources = manifest['sources']
            mutations = {
                'empty': [],
                'missing': sources[:-1],
                'duplicate': sources[:-1] + [sources[0]],
                'extra': sources + [sources[0]],
                'unknown_key': [dict(item, unexpected=True) for item in sources],
                'wrong_digest': [dict(item, sha256='0' * 64) for item in sources],
                'substituted_path': [dict(item, path='README.md') for item in sources],
            }
            for label, value in mutations.items():
                with self.subTest(case=label):
                    candidate = copy.deepcopy(manifest)
                    candidate['sources'] = value
                    path.write_text(json.dumps(candidate), encoding='utf-8')
                    with self.assertRaisesRegex(ValueError, 'source'):
                        module.load_bundle(bundle)

    def test_full_uuid_override_does_not_mutate_core_formats(self):
        module = self.verifier()
        self.assertIsNot(module.FORMAT_CHECKER, module.CORE_FORMAT_CHECKER)
        self.assertIsNot(module.FORMAT_CHECKER.checkers, module.CORE_FORMAT_CHECKER.checkers)
        self.assertNotEqual(module.FORMAT_CHECKER.checkers['uuid'], module.CORE_FORMAT_CHECKER.checkers['uuid'])
        for name, checker in module.CORE_FORMAT_CHECKER.checkers.items():
            if name != 'uuid':
                self.assertEqual(module.FORMAT_CHECKER.checkers[name], checker)

    def test_schema_failures_are_redacted_at_ci_and_cli_boundaries(self):
        import contextlib
        import io
        from unittest.mock import patch

        module = self.verifier()
        marker = 'SYNTHETIC_PRIVATE_SCHEMA_VALUE_FOR_REDACTION_TEST'

        def bad_schema():
            module.Draft202012Validator.check_schema({'type': marker})

        with patch.object(module, '_verify', side_effect=bad_schema):
            # Exercise unittest's real traceback renderer, as used by this CI file.
            output = io.StringIO()
            suite = unittest.TestSuite([unittest.FunctionTestCase(module.verify)])
            result = unittest.TextTestRunner(stream=output).run(suite)
            self.assertEqual(len(result.errors), 1)
            self.assertIn('Structural verification failed (SchemaError)', output.getvalue())
            self.assertNotIn(marker, output.getvalue())
            cli = io.StringIO()
            with patch('sys.argv', ['verify.py']), contextlib.redirect_stdout(cli):
                code = module.main()
            self.assertEqual(code, 1)
            report = json.loads(cli.getvalue())
            self.assertTrue(report['execution_failed'])
            self.assertFalse(report['release_approved'])
            self.assertNotIn(marker, cli.getvalue())


if __name__ == '__main__':
    unittest.main(verbosity=2)
