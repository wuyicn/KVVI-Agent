"""Exercise fingerprint verification against a real temporary Git checkout."""
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest


SPEC = importlib.util.spec_from_file_location('g2_fingerprint', Path(__file__).with_name('g2_改造点.py'))
G2 = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(G2)


class FingerprintDeletionTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='kvvi-g2-fingerprint-')
        self.root = Path(self.temp.name)
        self.previous = G2.DSH, G2.FINGERPRINT
        G2.DSH = str(self.root)
        G2.FINGERPRINT = str(self.root / 'manifest.json')
        subprocess.run(['git', 'init', '--quiet', str(self.root)], check=True)
        (self.root / 'kept.txt').write_text('registered content\n')
        subprocess.run(['git', '-C', str(self.root), 'add', 'kept.txt'], check=True)
        subprocess.run(['git', '-C', str(self.root), '-c', 'user.name=G2 test',
                        '-c', 'user.email=g2-test@example.invalid', 'commit', '--quiet', '-m', 'fixture'], check=True)
        head = subprocess.check_output(['git', '-C', str(self.root), 'rev-parse', 'HEAD'], text=True).strip()
        manifest = {'fork_head': head, 'files': {
            'kept.txt': {'status': 'M', 'sha256': hashlib.sha256((self.root / 'kept.txt').read_bytes()).hexdigest()},
            'deleted.txt': {'status': 'D', 'sha256': ''},
        }}
        Path(G2.FINGERPRINT).write_text(json.dumps(manifest))

    def tearDown(self):
        G2.DSH, G2.FINGERPRINT = self.previous
        self.temp.cleanup()

    def verify(self):
        with contextlib.redirect_stdout(io.StringIO()):
            return G2.verify_fingerprint()

    def test_registered_deletion_accepts_an_absent_path(self):
        self.assertEqual(self.verify(), 0)

    def test_restored_deleted_file_is_rejected(self):
        (self.root / 'deleted.txt').write_text('restored\n')
        self.assertEqual(self.verify(), 1)

    def test_restored_deleted_directory_is_rejected(self):
        (self.root / 'deleted.txt').mkdir()
        self.assertEqual(self.verify(), 1)

    def test_changed_retained_file_is_rejected(self):
        (self.root / 'kept.txt').write_text('modified\n')
        self.assertEqual(self.verify(), 1)


if __name__ == '__main__':
    unittest.main()
