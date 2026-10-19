"""Publication binding and submission regressions against real contract trees."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


CLI_PATH = Path(__file__).with_name('发布脚手架.py')
SPEC = importlib.util.spec_from_file_location('publish_scaffold', CLI_PATH)
CLI = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CLI)


class PublishContractsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='kvvi-publish-cli-')
        self.root = Path(self.temp.name)
        self.addCleanup(self.temp.cleanup)

    def write(self, path, value):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(value), encoding='utf-8')
        return path

    def complete(self):
        for kind in CLI.CONTRACT_TYPES:
            hint = self.hint(kind)
            self.write('%s.json' % hint, {'kind': kind})

    @staticmethod
    def hint(kind):
        return {'app-model-command': '搭建命令', 'tool-spec': '工具'}.get(kind, kind)

    def duplicate(self, kind):
        hint = self.hint(kind)
        files = ['01-%s.json' % hint, 'nested/02-%s.json' % hint]
        for path in files:
            self.write(path, {'name': path})
        return files

    def test_multiple_non_tool_contracts_name_type_and_all_files(self):
        for kind in CLI.CONTRACT_TYPES:
            if kind == 'tool-spec':
                continue
            with self.subTest(kind=kind):
                files = self.duplicate(kind)
                expected = 'KVVI_CONTRACT_MULTIPLE_UNSUPPORTED: %s：%s' % (kind, '、'.join(files))
                try:
                    with self.assertRaises(CLI.CliError) as raised:
                        CLI.read_contracts(str(self.root))
                    self.assertEqual(str(raised.exception), expected)
                finally:
                    for path in files:
                        (self.root / path).unlink()

    def test_multiple_tools_are_all_carried(self):
        self.complete()
        (self.root / '工具.json').unlink()
        tools = [{'tool_code': 'a'}, {'tool_code': 'b'}, {'tool_code': 'c'}]
        for index, tool in enumerate(tools):
            self.write('06-工具/%s.json' % index, tool)
        contracts, notes = CLI.read_contracts(str(self.root))
        self.assertEqual(set(contracts), set(CLI.CONTRACT_TYPES))
        self.assertEqual(contracts['tool-spec'], {'tools': tools})
        self.assertTrue(any('tool-spec' in note for note in notes))

    def test_single_contracts_preserve_contents(self):
        self.complete()
        contracts, _notes = CLI.read_contracts(str(self.root))
        self.assertEqual(contracts, {kind: {'kind': kind} for kind in CLI.CONTRACT_TYPES})

    def test_symlink_contract_is_rejected_before_reading(self):
        with tempfile.TemporaryDirectory() as external:
            outside = Path(external) / 'view-schema.json'
            outside.write_text('{"secret":"do-not-read"}')
            (self.root / 'view-schema.json').symlink_to(outside)
            with self.assertRaisesRegex(CLI.CliError, 'KVVI_CONTRACT_SYMLINK_UNSUPPORTED'):
                CLI.read_contracts(str(self.root))

    def test_missing_contracts_remain_named_in_notes(self):
        self.write('business-schema.json', {'kind': 'business-schema'})
        contracts, notes = CLI.read_contracts(str(self.root))
        self.assertEqual(contracts, {'business-schema': {'kind': 'business-schema'}})
        self.assertEqual(len([note for note in notes if note.startswith('✗')]), 5)
        contracts, notes = CLI.read_contracts(str(self.root / 'absent'))
        self.assertEqual(contracts, {})
        self.assertEqual(len(notes), 6)

    def test_symlink_in_excluded_subtree_is_rejected(self):
        nested = self.root / '_校验/nested'
        nested.mkdir(parents=True)
        (nested / 'loop').symlink_to(self.root, target_is_directory=True)
        with self.assertRaisesRegex(CLI.CliError, 'KVVI_CONTRACT_SYMLINK_UNSUPPORTED'):
            CLI.read_contracts(str(self.root))

    def test_symlink_root_with_trailing_separator_is_rejected(self):
        actual = self.root / 'actual'
        actual.mkdir()
        (actual / 'view-schema.json').write_text('{}')
        link = self.root / 'link'
        link.symlink_to(actual, target_is_directory=True)
        with self.assertRaisesRegex(CLI.CliError, 'KVVI_CONTRACT_SYMLINK_UNSUPPORTED'):
            CLI.read_contracts(str(link) + '/')

    def test_excluded_trees_do_not_create_duplicate_contracts(self):
        self.complete()
        for directory in ['_校验', '_校验环境', 'fixture', '.hidden', '06-工具/schemas']:
            self.write(directory + '/view-schema.json', {})
        contracts, notes = CLI.read_contracts(str(self.root))
        self.assertEqual(set(contracts), set(CLI.CONTRACT_TYPES))
        self.assertEqual(len([note for note in notes if '整目录跳过' in note]), 5)

    def test_submission_refuses_duplicates_before_any_http(self):
        self.complete()
        self.write('extra-view-schema.json', {})
        argv = [str(CLI_PATH), '--workspace', str(self.root), '--apply']
        with patch.object(sys, 'argv', argv), patch.object(CLI, 'Session') as session, \
                patch.object(CLI, 'pilot_password', return_value='test-only'), \
                contextlib.redirect_stdout(io.StringIO()):
            session.return_value.sign_in.return_value.call.return_value = (200, {'items': []})
            with self.assertRaisesRegex(CLI.CliError, 'KVVI_CONTRACT_MULTIPLE_UNSUPPORTED: view-schema'):
                CLI.main()
            session.assert_not_called()

    def test_missing_submission_remains_blocked_before_any_http(self):
        self.write('business-schema.json', {})
        argv = [str(CLI_PATH), '--workspace', str(self.root), '--apply']
        with patch.object(sys, 'argv', argv), patch.object(CLI, 'Session') as session, \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(CLI.main(), 2)
            session.assert_not_called()

    def test_cli_process_reports_stable_error_and_nonzero_exit(self):
        files = self.duplicate('view-schema')
        result = subprocess.run([sys.executable, str(CLI_PATH), '--workspace', str(self.root), '--apply'],
                                capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 1)
        self.assertIn('KVVI_CONTRACT_MULTIPLE_UNSUPPORTED: view-schema', result.stderr)
        for path in files:
            self.assertIn(path, result.stderr)
        self.assertNotIn('Traceback', result.stderr)

    @unittest.skipUnless(os.environ.get('KVVI_PUBLISH_TEST_RUNTIME'), 'requires independent DSH source runtime')
    def test_agent_and_cli_match_binding_vectors(self):
        runtime = Path(os.environ['KVVI_PUBLISH_TEST_RUNTIME'])
        source = (runtime / 'packages/tool/kvvi-publish/src/index.ts').as_uri()
        script = (
            'import {readContracts} from %s;'
            'try { console.log(JSON.stringify(readContracts(process.argv[1]).contracts)); }'
            'catch(error) { console.log(JSON.stringify({error:error.message})); }'
        ) % json.dumps(source)
        self.complete()
        self.write('06-工具/extra.json', {'tool_code': 'extra'})
        self.write('06-工具/\ue000.json', {'tool_code': 'bmp'})
        self.write('06-工具/😀.json', {'tool_code': 'nonbmp'})
        for kind in [None] + [kind for kind in CLI.CONTRACT_TYPES if kind != 'tool-spec']:
            with self.subTest(kind=kind):
                if kind:
                    self.write('extra-%s.json' % self.hint(kind), {})
                try:
                    expected = CLI.read_contracts(str(self.root))[0]
                except CLI.CliError as error:
                    expected = {'error': str(error)}
                result = subprocess.run(['node', '--import', 'tsx/esm', '--input-type=module',
                                         '-e', script, str(self.root)], cwd=runtime,
                                        capture_output=True, text=True, check=True)
                try:
                    self.assertEqual(json.loads(result.stdout), expected)
                finally:
                    if kind:
                        (self.root / ('extra-%s.json' % self.hint(kind))).unlink()


if __name__ == '__main__':
    unittest.main()
