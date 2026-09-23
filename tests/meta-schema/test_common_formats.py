"""D01/D03 real-engine and raw CLI regressions; expectations are literals."""
import copy
import json
import subprocess
import sys
import unittest
from test_bundle import ROOT, python_definition, node_definition, VALID_ASSET_REF, entry_errors
from test_integration import run
from integration_fixtures import composition

SOURCE = ROOT / 'tests/meta-schema/0a-core-r1/inputs/app-registered-published-valid.json'


class CommonFormats(unittest.TestCase):
    def test_app_machine_codes_have_identical_absolute_end_boundaries(self):
        for slot,path,code in [('app_code','spec.app_code','CONTRACT_SHAPE_INVALID'),
                               ('route_code','spec.navigation[0].route_code','APPSPEC_INVALID')]:
            for text,valid in [('abc',True),('a'+'b'*63,True),('ab',False),('a'+'b'*64,False),
                               ('abc\n',False),('abc\r\n',False),('abc\u2028',False)]:
                value,ctx=composition()
                target=value['spec'] if slot=='app_code' else value['spec']['navigation'][0]
                target[slot]=text
                expected=[] if valid else [(code,path)]
                for language in ['python','node']:
                    with self.subTest(slot=slot,text=text,engine=language):
                        errors=entry_errors(language,'app-spec/v1alpha1','compiled-draft',value)
                        self.assertEqual([(e['code'],e['path']) for e in errors],expected)
                for exit_code,payload in run(value,ctx):
                    with self.subTest(slot=slot,text=text,cli=True):
                        self.assertEqual(exit_code,0 if valid else 2,payload)
                        self.assertEqual([(e['code'],e['path']) for e in payload['validation']['errors']],expected)
                        self.assertEqual(payload['stage'],'complete' if valid else 'structure')

    def test_digest_requires_absolute_end_in_real_definitions(self):
        for value in ['sha256:' + 'a' * 64 + '\n', 'sha256:' + '１' * 64]:
            ref = dict(VALID_ASSET_REF, digest=value)
            for runner in [python_definition, node_definition]:
                with self.subTest(runner=runner.__name__, value=value):
                    self.assertEqual([(e['code'], e['path']) for e in runner('AssetRef', ref)],
                                     [('REFERENCE_INVALID', 'digest')])
            value_object=json.loads(SOURCE.read_text());value_object['checksum']=value
            for command in [[sys.executable,str(ROOT/'tools/meta-schema/python/cli.py')],['node',str(ROOT/'tools/meta-schema/node/cli.mjs')]]:
                proc=subprocess.run(command+['--contract','app-spec/v1alpha1','--entry','registered','--checks','structure'],input=json.dumps(value_object).encode(),capture_output=True,timeout=15)
                self.assertEqual(proc.returncode,2,proc.stdout)
                self.assertEqual([(e['code'],e['path']) for e in json.loads(proc.stdout)['validation']['errors']],[('CONTRACT_SHAPE_INVALID','checksum')])

    def test_all_audit_timestamp_slots_in_real_engines_and_raw_cli(self):
        original = json.loads(SOURCE.read_text())
        probes = [
            ('2026-02-30T12:00:00Z', False), ('2025-02-29T12:00:00Z', False),
            ('2024-02-29T23:59:59.123456789Z', True), ('2000-02-29T00:00:00Z', True),
            ('1900-02-29T00:00:00Z', False), ('2026-01-01T24:00:00Z', False),
            ('2026-01-01T23:59:60Z', False), ('2026-01-01T00:00:00+00:00', False),
            ('2026-01-01T00:00:00Z\n', False), ('２０２６-01-01T00:00:00Z', False),
            ('2026-01-01T00:00:00.Z', False), ('0000-01-01T00:00:00Z', False),
        ]
        for slot in ['created_at', 'approved_at', 'published_at']:
            for timestamp, valid in probes:
                value = copy.deepcopy(original)
                value['audit'][slot] = timestamp
                base = {k: v for k, v in value.items() if k not in ['app_id', 'contract_version', 'spec']}
                for runner in [python_definition, node_definition]:
                    with self.subTest(slot=slot, timestamp=timestamp, runner=runner.__name__):
                        self.assertEqual(not runner('RegisteredBase', base), valid)
                for command in [[sys.executable, str(ROOT / 'tools/meta-schema/python/cli.py')],
                                ['node', str(ROOT / 'tools/meta-schema/node/cli.mjs')]]:
                    with self.subTest(slot=slot, timestamp=timestamp, cli=command[0]):
                        run = subprocess.run(command + ['--contract', 'app-spec/v1alpha1', '--entry', 'registered', '--checks', 'structure'],
                                             input=json.dumps(value).encode(), capture_output=True, timeout=15)
                        self.assertEqual(run.stderr, b'')
                        self.assertEqual(run.returncode, 0 if valid else 2, run.stdout)
                        self.assertEqual(json.loads(run.stdout)['validation']['valid'], valid)


if __name__ == '__main__':
    unittest.main()
