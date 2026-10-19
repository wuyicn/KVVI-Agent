import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[2] / '工具/发行包.py'


def load_package():
    spec = importlib.util.spec_from_file_location('owned_release_package', SCRIPT)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


class ReleasePackageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='kvvi-package-test-'); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name); self.module = load_package()
        self.module.ROOT = str(self.root); self.module.OUT_DIR = str(self.root / 'out')
        self.module.ARCHIVE = str(self.root / 'out/pilot.tar.gz'); self.module.MANIFEST = str(self.root / 'out/manifest.json')
        for source, _ in self.module.CONTENTS:
            (self.root / source).mkdir(parents=True, exist_ok=True)
        for rel in self.module.REQUIRED + self.module.EXTRA_FILES + ['vendor/dsh/packages/fixture/build/lib/types/probe.js']:
            path = self.root / rel; path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('{}\n' if path.suffix == '.json' else 'fixture source\n')
        self.assertEqual(self.call(self.module.build), 0)
        self.old = self.pair()

    def call(self, function):
        with contextlib.redirect_stdout(io.StringIO()):
            return function()

    def pair(self):
        return tuple(Path(p).read_bytes() for p in [self.module.ARCHIVE, self.module.MANIFEST])

    def changed(self):
        (self.root / 'README.md').write_text('new candidate\n')

    def test_forbidden_candidate_preserves_both_old_outputs(self):
        (self.root / 'distribution/rejected.txt').write_bytes(b'-----BEGIN ' + b'PRIVATE KEY-----')
        self.assertNotEqual(self.call(self.module.build), 0)
        self.assertEqual(self.pair(), self.old)

    def test_tar_failure_preserves_both_old_outputs(self):
        self.changed()
        with patch.object(self.module.tarfile.TarFile, 'addfile', side_effect=OSError('owned tar fault')):
            self.assertNotEqual(self.call(self.module.build), 0)
        self.assertEqual(self.pair(), self.old)

    def test_manifest_failure_preserves_both_old_outputs(self):
        self.changed()
        with patch.object(self.module.json, 'dump', side_effect=OSError('owned JSON fault')):
            self.assertNotEqual(self.call(self.module.build), 0)
        self.assertEqual(self.pair(), self.old)

    def test_second_publish_rename_rolls_back_the_old_pair(self):
        self.changed(); original = os.replace; triggered = []
        def fail_once(source, target):
            if Path(target) == Path(self.module.MANIFEST) and not triggered:
                triggered.append(True); raise OSError('owned second rename fault')
            return original(source, target)
        with patch.object(os, 'replace', side_effect=fail_once):
            self.assertNotEqual(self.call(self.module.build), 0)
        self.assertEqual(triggered, [True]); self.assertEqual(self.pair(), self.old)

    def test_output_symlink_is_preserved_instead_of_followed(self):
        archive = Path(self.module.ARCHIVE); saved = self.root / 'saved-archive'
        archive.rename(saved); archive.symlink_to(saved); self.changed()
        self.assertNotEqual(self.call(self.module.build), 0)
        self.assertTrue(archive.is_symlink()); self.assertEqual(saved.read_bytes(), self.old[0])
        self.assertEqual(Path(self.module.MANIFEST).read_bytes(), self.old[1])

    def test_process_exit_after_first_publish_recovers_the_old_pair_before_check(self):
        self.changed()
        code = '''
import importlib.util,os,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('interrupted_package',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
m.ROOT=sys.argv[2];m.OUT_DIR=str(Path(sys.argv[3]).parent);m.ARCHIVE=sys.argv[3];m.MANIFEST=sys.argv[4]
original=os.replace
def interrupt(source,target):
 result=original(source,target)
 if Path(target)==Path(m.ARCHIVE):os._exit(73)
 return result
os.replace=interrupt
raise SystemExit(m.build())
'''
        child = subprocess.run([sys.executable, '-c', code, str(SCRIPT), str(self.root), self.module.ARCHIVE, self.module.MANIFEST],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20)
        self.assertEqual(child.returncode, 73)
        self.assertNotEqual(self.call(self.module.check), 0)  # old source digest differs from the newly changed README
        self.assertEqual(self.pair(), self.old)
        self.assertFalse((Path(self.module.OUT_DIR) / '.kvvi-package-publication.json').exists())
        self.assertEqual(list(Path(self.module.OUT_DIR).glob('kvvi-package-backup-*')), [])
        self.assertEqual(list(Path(self.module.OUT_DIR).glob('kvvi-package-candidate-*')), [])

    def test_self_test_never_changes_real_outputs_or_server_metadata(self):
        paths = [Path(self.module.ARCHIVE), Path(self.module.MANIFEST), self.root / 'services/platform/src/server.mjs']
        before = [(path.read_bytes(), path.stat().st_mtime_ns) for path in paths]
        self.assertEqual(self.call(self.module.self_test), 0)
        self.assertEqual([(path.read_bytes(), path.stat().st_mtime_ns) for path in paths], before)

    def test_self_test_needs_no_existing_real_package(self):
        self.module.ARCHIVE = str(self.root / 'absent/archive.tar.gz'); self.module.MANIFEST = str(self.root / 'absent/manifest.json')
        self.assertEqual(self.call(self.module.self_test), 0)
        self.assertFalse(Path(self.module.ARCHIVE).exists()); self.assertFalse(Path(self.module.MANIFEST).exists())

    def test_scan_and_tar_use_the_same_single_read_snapshot(self):
        import builtins
        original = builtins.open; reads = []
        safe = b'scanned snapshot\n'
        (self.root / 'README.md').write_bytes(safe)
        def snapshot(path, mode='r', *args, **kwargs):
            if Path(path) == self.root / 'README.md' and mode == 'rb':
                reads.append(True)
                if len(reads) > 1: return io.BytesIO(b'-----BEGIN ' + b'PRIVATE KEY-----')
            return original(path, mode, *args, **kwargs)
        with patch('builtins.open', side_effect=snapshot):
            self.assertEqual(self.call(self.module.build), 0)
        self.assertEqual(reads, [True])
        with self.module.tarfile.open(self.module.ARCHIVE) as tar:
            self.assertEqual(tar.extractfile(self.module.TOP + '/README.md').read(), safe)

    def test_lost_confirmation_after_second_rename_still_restores_old_pair(self):
        self.changed(); original = os.replace; triggered = []
        def fail_after(source, target):
            result = original(source, target)
            if Path(target) == Path(self.module.MANIFEST) and not triggered:
                triggered.append(True); raise OSError('owned lost rename confirmation')
            return result
        with patch.object(os, 'replace', side_effect=fail_after):
            self.assertNotEqual(self.call(self.module.build), 0)
        self.assertEqual(self.pair(), self.old)

    def test_failed_rollback_retains_verified_old_backups_and_later_recovers(self):
        self.changed(); original = os.replace
        def stop_publish_and_restore(source, target):
            if Path(target) == Path(self.module.MANIFEST) or str(Path(source).name).startswith('.kvvi-restore-'):
                raise OSError('owned rollback fault')
            return original(source, target)
        with patch.object(os, 'replace', side_effect=stop_publish_and_restore):
            self.assertNotEqual(self.call(self.module.build), 0)
        journal = Path(self.module.OUT_DIR) / '.kvvi-package-publication.json'
        self.assertTrue(journal.exists())
        state = json.loads(journal.read_text()); backup = Path(self.module.OUT_DIR) / state['backup']
        self.assertEqual((backup / '0').read_bytes(), self.old[0]); self.assertEqual((backup / '1').read_bytes(), self.old[1])
        (backup / '1').write_bytes(b'tampered recovery input')
        interrupted = self.pair()
        self.assertNotEqual(self.call(self.module.check), 0)
        self.assertEqual(self.pair(), interrupted, 'all recovery inputs must validate before either destination changes')
        (backup / '1').write_bytes(self.old[1])
        candidate = Path(self.module.OUT_DIR) / state['candidate']
        candidate.write_bytes(b'not a candidate directory')
        self.assertNotEqual(self.call(self.module.check), 0)
        self.assertEqual(self.pair(), interrupted, 'candidate type must validate before recovery mutates outputs')
        self.assertTrue(journal.is_file()); self.assertTrue(backup.is_dir())
        self.assertEqual(candidate.read_bytes(), b'not a candidate directory')
        candidate.unlink()
        self.assertNotEqual(self.call(self.module.check), 0)  # source README changed, but output pair is restored
        self.assertEqual(self.pair(), self.old); self.assertFalse(journal.exists())

    def test_a_live_output_lock_blocks_another_build_without_changing_the_pair(self):
        ready = self.root / 'lock-ready'
        code = '''
import sys
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from 工具.lib.package_outputs import output_guard
with output_guard(sys.argv[2],sys.argv[3]):
 Path(sys.argv[4]).write_text('ready')
 sys.stdin.readline()
'''
        child = subprocess.Popen([sys.executable, '-c', code, str(SCRIPT.parent.parent), self.module.ARCHIVE, self.module.MANIFEST, str(ready)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            deadline = time.monotonic() + 3
            while not ready.exists() and time.monotonic() < deadline and child.poll() is None:
                time.sleep(0.01)
            self.assertTrue(ready.exists())
            self.changed(); self.assertNotEqual(self.call(self.module.build), 0); self.assertEqual(self.pair(), self.old)
        finally:
            child.communicate('release\n', timeout=5)
            self.assertEqual(child.returncode, 0)

    def test_nested_malformed_journal_returns_fixed_error_and_preserves_pair(self):
        journal = Path(self.module.OUT_DIR) / '.kvvi-package-publication.json'
        journal.write_text('[' * 10000 + '0' + ']' * 10000)
        self.assertNotEqual(self.call(self.module.check), 0)
        self.assertEqual(self.pair(), self.old); self.assertTrue(journal.exists())

    def test_fifo_lock_is_rejected_without_unlocking_or_leaking_its_descriptor(self):
        from 工具.lib import package_outputs
        lock = Path(self.module.OUT_DIR) / '.kvvi-package.lock'; lock.unlink(); os.mkfifo(lock)
        original = os.open; descriptors = []
        def capture(path, *args, **kwargs):
            fd = original(path, *args, **kwargs)
            if Path(path) == lock: descriptors.append(fd)
            return fd
        with patch.object(package_outputs.fcntl, 'flock', wraps=package_outputs.fcntl.flock) as flock, patch.object(os, 'open', side_effect=capture):
            self.assertNotEqual(self.call(self.module.build), 0)
        self.assertEqual(flock.call_count, 0); self.assertEqual(len(descriptors), 1)
        with self.assertRaises(OSError): os.fstat(descriptors[0])
        self.assertEqual(self.pair(), self.old)

    def test_filesystem_output_aliases_are_rejected_existing_and_first_publication(self):
        aliases = [('archive.tar.gz', 'ARCHIVE.TAR.GZ'), ('caf\u00e9.tar.gz', 'cafe\u0301.tar.gz')]
        exercised = 0
        for index, (first, second) in enumerate(aliases):
            probe = self.root / ('alias-probe-' + str(index)); probe.mkdir()
            (probe / first).write_bytes(b'probe')
            if not (probe / second).exists():
                continue
            exercised += 1
            for existing in (False, True):
                out = self.root / ('alias-out-' + str(index) + str(existing)); out.mkdir()
                self.module.OUT_DIR = str(out); self.module.ARCHIVE = str(out / first); self.module.MANIFEST = str(out / second)
                if existing: (out / first).write_bytes(b'keep existing aliased output')
                self.assertNotEqual(self.call(self.module.build), 0)
                self.assertEqual(list(out.glob('*.gz')), [out / first] if existing else [])
                if existing: self.assertEqual((out / first).read_bytes(), b'keep existing aliased output')
        if not exercised: self.skipTest('filesystem has no tested filename aliases')

    def test_output_names_cannot_alias_internal_control_namespaces(self):
        for index, name in enumerate(('.KVVI-PACKAGE-PUBLICATION.JSON', '.KVVI-PACKAGE.LOCK', 'KVVI-PACKAGE-CANDIDATE-XYZ')):
            out = self.root / ('control-alias-' + str(index))
            self.module.OUT_DIR = str(out); self.module.ARCHIVE = str(out / 'archive.tar.gz'); self.module.MANIFEST = str(out / name)
            self.assertNotEqual(self.call(self.module.build), 0)
            self.assertFalse(Path(self.module.ARCHIVE).exists()); self.assertFalse(Path(self.module.MANIFEST).exists())


if __name__ == '__main__':
    unittest.main()
