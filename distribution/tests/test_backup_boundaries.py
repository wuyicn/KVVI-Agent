import io
import json
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from distribution.lib.backup import backup_plan, restore_plan, safe_extract, sha256_bytes, sha256_file


class ArchiveBoundaryTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.home = self.root / 'source'
        self.home.mkdir()

    def backup(self, out):
        plan = backup_plan(self.home, 1, out, 'test', 'test-only', databases=())
        result = plan.apply(Path('/unused'))
        self.assertTrue(result['ok'])
        with tarfile.open(plan.archive, 'r:gz') as outer:
            with tarfile.open(fileobj=outer.extractfile('home.tar')) as inner:
                return inner.getnames()

    def test_credentials_are_excluded_at_every_depth(self):
        for name in ('kvvi.env', 'nested/.credentials.yaml', 'nested/secrets/signing.key',
                     'nested/.env.local', 'nested/pgdata/base/1', '.kvvi-recovery/receipt.json'):
            p = self.home / name
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text('private-sentinel')
        (self.home / 'business-notes.txt').write_text('retain')
        names = self.backup(self.root / 'out')
        self.assertIn('business-notes.txt', names)
        self.assertFalse(any(n.endswith(('kvvi.env', '.credentials.yaml', '.key', '.env.local',
                                         'base/1', 'receipt.json')) for n in names), names)

    def test_custom_nested_output_and_prior_backups_are_excluded(self):
        out = self.home / 'custom' / 'exports'
        out.mkdir(parents=True)
        (out / 'prior.bin').write_bytes(b'old backup')
        (self.home / 'backups').mkdir()
        (self.home / 'backups' / 'prior.bin').write_bytes(b'old backup')
        (self.home / 'custom' / 'keep.txt').write_text('retain')
        names = self.backup(out)
        self.assertIn('custom/keep.txt', names)
        self.assertFalse(any('exports' in n or 'backups' in n for n in names), names)

    def test_output_ancestor_does_not_exclude_the_entire_home(self):
        (self.home / 'notes.txt').write_text('retain')
        self.assertIn('notes.txt', self.backup(self.root))

    def archive(self, entries):
        inner_bytes = io.BytesIO()
        with tarfile.open(fileobj=inner_bytes, mode='w') as tar:
            for name, body in entries:
                info = tarfile.TarInfo(name)
                info.size = len(body)
                tar.addfile(info, io.BytesIO(body))
        body = inner_bytes.getvalue()
        manifest = {'databases': [], 'files': {'home.tar': {'sha256': sha256_bytes(body)}}}
        archive = self.root / 'legacy.tar.gz'
        with tarfile.open(archive, 'w:gz') as tar:
            for name, content in (('home.tar', body), ('backup-manifest.json', json.dumps(manifest).encode())):
                info = tarfile.TarInfo(name)
                info.size = len(content)
                tar.addfile(info, io.BytesIO(content))
        archive.with_suffix(archive.suffix + '.sha256').write_text(sha256_file(archive))
        return archive

    def test_legacy_backup_cannot_overwrite_target_credentials(self):
        target = self.root / 'target'
        target.mkdir()
        (target / 'kvvi.env').write_text('target-secret')
        plan = restore_plan(self.archive([('kvvi.env', b'source-secret'),
                                          ('notes.txt', b'restore-me')]), target, 1, 'test', 'test-only')
        result = plan.apply(Path('/unused'), stop_services=lambda: {'ok': True})
        self.assertTrue(result['ok'], result)
        self.assertEqual((target / 'kvvi.env').read_text(), 'target-secret')
        self.assertEqual((target / 'notes.txt').read_text(), 'restore-me')

    def test_unsafe_nested_archive_is_rejected_before_stopping(self):
        archive = self.archive([('../escape.txt', b'bad')])
        stop = unittest.mock.Mock(return_value={'ok': True})
        plan = restore_plan(archive, self.root / 'target', 1, 'test', 'test-only')
        result = plan.apply(Path('/unused'), stop_services=stop)
        self.assertFalse(result['ok'])
        stop.assert_not_called()

    def test_special_files_are_rejected(self):
        raw = io.BytesIO()
        with tarfile.open(fileobj=raw, mode='w') as tar:
            info = tarfile.TarInfo('pipe')
            info.type = tarfile.FIFOTYPE
            tar.addfile(info)
        raw.seek(0)
        with tarfile.open(fileobj=raw) as tar:
            with self.assertRaises(ValueError):
                safe_extract(tar, self.root / 'target')

    def test_restore_uses_the_verified_bytes_when_original_path_is_replaced(self):
        archive = self.archive([('notes.txt', b'verified-A')])
        original = archive.read_bytes()
        original_sha = sha256_file(archive)
        self.archive([('notes.txt', b'unverified-B')])
        replacement = archive.read_bytes()
        archive.write_bytes(original)
        archive.with_suffix(archive.suffix + '.sha256').write_text(original_sha)
        def stop():
            archive.write_bytes(replacement)
            archive.with_suffix(archive.suffix + '.sha256').write_text(sha256_file(archive))
            return {'ok': True}
        target = self.root / 'target'
        result = restore_plan(archive, target, 1, 'test', 'test-only').apply(Path('/unused'), stop)
        self.assertTrue(result['ok'], result)
        self.assertEqual((target / 'notes.txt').read_bytes(), b'verified-A')
        self.assertEqual(json.loads(Path(result['journalPath']).read_text())['archiveSha256'], original_sha)

    def test_conflicting_parent_file_is_rejected_before_stopping(self):
        archive = self.archive([('a', b'file'), ('a/b', b'impossible')])
        stop = unittest.mock.Mock(return_value={'ok': True})
        result = restore_plan(archive, self.root / 'target', 1, 'test', 'test-only').apply(Path('/unused'), stop)
        self.assertFalse(result['ok'])
        stop.assert_not_called()
