import hashlib
import importlib.util
import json
from pathlib import Path
import shlex
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class EvidenceCommandTests(unittest.TestCase):
    def test_quoted_writer_commands_are_accepted_and_argv_substitutions_are_rejected(self):
        with tempfile.TemporaryDirectory(prefix='kvvi-evidence-command-') as temporary:
            owned = Path(temporary); source = owned / 'explicit source'; source.mkdir()
            for number, stage in ((8,'阶段八'),(9,'阶段九'),(10,'阶段十'),(11,'阶段十一')):
                with self.subTest(stage=stage):
                    path = ROOT / '工具' / ('check_stage' + str(number) + '.py')
                    spec = importlib.util.spec_from_file_location('owned_reader_' + str(number),path)
                    reader = importlib.util.module_from_spec(spec); spec.loader.exec_module(reader)
                    reader.ROOT = owned; reader.MANIFEST = owned / 'manifest.json'; reader.EVIDENCE = reader.MANIFEST
                    if number == 8: classes = ['role_policy','login_api','runtime_preset','topology']
                    elif number == 9: classes = list(reader.CHECKS)
                    elif number == 10: classes = list(set(reader.CHECKS) | set(reader.CLIENT_CHECKS) | set(reader.TOOL_CHECKS) | {'signed_context','worker_composition'})
                    else: classes = []
                    body = 'owned fixture only\n'; (owned / 'evidence.txt').write_text('$ fixture\n\n' + body)
                    arguments = ['python3','工具/check_stage' + str(number) + '.py','--run-only']
                    if number == 11: arguments += ['--runtime-source',str(source)]
                    entry = {'stage':stage,'ok':True,'exitCode':0,'command':shlex.join(arguments),'evidence':'evidence.txt',
                        'digest':'sha256:' + hashlib.sha256(body.encode()).hexdigest(),'evidenceClasses':classes,'acceptanceHost':'clean-dir'}
                    def save(): reader.MANIFEST.write_text(json.dumps({'entries':[entry]}))
                    save(); function = getattr(reader,'require_stage' + str(number) + '_evidence')
                    function()
                    if number < 11:
                        entry['command'] = ' '.join(arguments); save(); function()
                    for command in ('echo ' + shlex.join(arguments), shlex.join(arguments + ['--extra']), "python3 'unterminated", None):
                        entry['command'] = command; save()
                        with self.assertRaisesRegex(RuntimeError,'EVIDENCE_COMMAND_INVALID'): function()


if __name__ == '__main__':
    unittest.main()
