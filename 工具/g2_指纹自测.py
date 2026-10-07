#!/usr/bin/env python3
"""隔离的指纹反例；不改真实 vendor/dsh、登记或 Git 状态。"""
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location('g2_checker', Path(__file__).with_name('g2_改造点.py'))
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


class FingerprintTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name) / 'fork'
        self.repo.mkdir()
        self.git('init', '-q')
        self.git('config', 'user.name', 'Fingerprint Test')
        self.git('config', 'user.email', 'test@example.invalid')
        self.git('config', 'core.hooksPath', '/dev/null')
        (self.repo / 'live.txt').write_text('kept\n')
        (self.repo / 'deleted.txt').write_text('removed\n')
        self.git('add', '.')
        self.git('commit', '-qm', 'baseline')
        (self.repo / 'deleted.txt').unlink()
        self.git('add', '-u')
        self.git('commit', '-qm', 'delete obsolete file')
        self.manifest = Path(self.temp.name) / 'fingerprint.json'
        self.manifest.write_text(json.dumps({
            'fork_head': self.git('rev-parse', 'HEAD').strip(),
            'files': {
                'live.txt': {'status': 'M', 'sha256': hashlib.sha256(b'kept\n').hexdigest()},
                'deleted.txt': {'status': 'D', 'sha256': ''},
            },
        }))
        for name, value in [('DSH', str(self.repo)), ('FINGERPRINT', str(self.manifest))]:
            override = patch.object(checker, name, value)
            override.start()
            self.addCleanup(override.stop)

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.repo), *args], text=True)

    def verify(self):
        with contextlib.redirect_stdout(io.StringIO()):
            return checker.verify_fingerprint()

    def test_registered_deletion_is_valid_when_absent(self):
        self.assertEqual(self.verify(), 0)

    def test_restored_deleted_file_is_rejected(self):
        (self.repo / 'deleted.txt').write_text('removed\n')
        self.assertEqual(self.verify(), 1)

    def test_deleted_path_as_dangling_link_is_rejected(self):
        (self.repo / 'deleted.txt').symlink_to('missing-target')
        self.assertEqual(self.verify(), 1)

    def test_deleted_path_as_directory_is_rejected(self):
        (self.repo / 'deleted.txt').mkdir()
        self.assertEqual(self.verify(), 1)

    def test_missing_live_file_is_rejected(self):
        (self.repo / 'live.txt').unlink()
        self.assertEqual(self.verify(), 1)

    def test_tampered_live_file_is_rejected(self):
        (self.repo / 'live.txt').write_text('tampered\n')
        self.assertEqual(self.verify(), 1)

    def test_changed_head_is_rejected(self):
        self.git('commit', '--allow-empty', '-qm', 'different head')
        self.assertEqual(self.verify(), 1)


if __name__ == '__main__':
    unittest.main()
