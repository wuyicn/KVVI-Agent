import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from 工具.lib.raw_git_source import export_raw_baseline


class RawGitSourceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='kvvi-raw-source-test-'); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name); self.objects = self.root / 'objects'; self.objects.mkdir()
        (self.objects / '.gitattributes').write_text('*.cmd text eol=crlf\n')
        (self.objects / 'start.cmd').write_bytes(b'@echo off\necho fixed\n')
        (self.objects / 'tool.sh').write_bytes(b'#!/bin/sh\nexit 0\n'); (self.objects / 'tool.sh').chmod(0o755)
        (self.objects / 'linked.cmd').symlink_to('start.cmd')
        self.git('init', '--quiet'); self.git('add', '.')
        self.commit('base'); self.base = self.git('rev-parse', 'HEAD').decode().strip()

    def git(self, *args, input_bytes=None):
        return subprocess.run(['git', '-C', str(self.objects), *args], check=True, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, input=input_bytes, env={**os.environ, 'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_CONFIG_SYSTEM': os.devnull}).stdout

    def commit(self, message):
        self.git('-c', 'user.name=Source Test', '-c', 'user.email=source-test@example.invalid',
            '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', message)

    def test_export_is_exact_blob_bytes_despite_crlf_attributes_and_preserves_links_and_modes(self):
        into = self.root / 'exported'
        export_raw_baseline(self.objects, self.base, into)
        self.assertEqual((into / 'start.cmd').read_bytes(), self.git('show', self.base + ':start.cmd'))
        self.assertNotIn(b'\r\n', (into / 'start.cmd').read_bytes())
        self.assertEqual(os.readlink(into / 'linked.cmd'), 'start.cmd')
        self.assertEqual(stat.S_IMODE((into / 'tool.sh').stat().st_mode), 0o755)

    def test_nonempty_or_linked_targets_are_preserved(self):
        into = self.root / 'existing'; into.mkdir(); (into / 'keep').write_text('preserve')
        with self.assertRaisesRegex(ValueError, 'RAW_SOURCE_TARGET_NOT_EMPTY'):
            export_raw_baseline(self.objects, self.base, into)
        self.assertEqual((into / 'keep').read_text(), 'preserve')
        link = self.root / 'link'; link.symlink_to(into, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'RAW_SOURCE_TARGET_INVALID'):
            export_raw_baseline(self.objects, self.base, link)
        self.assertTrue(link.is_symlink())

    def test_missing_base_or_unsafe_link_does_not_publish_a_partial_target(self):
        into = self.root / 'exported'; into.mkdir()
        with self.assertRaisesRegex(ValueError, 'RAW_SOURCE_BASELINE_UNAVAILABLE'):
            export_raw_baseline(self.objects, '0' * 40, into)
        self.assertEqual(list(into.iterdir()), [])
        (self.objects / 'outside').symlink_to('../outside-private')
        self.git('add', '.'); self.commit('unsafe link')
        with self.assertRaisesRegex(ValueError, 'RAW_SOURCE_LINK_INVALID'):
            export_raw_baseline(self.objects, self.git('rev-parse', 'HEAD').decode().strip(), into)
        self.assertEqual(list(into.iterdir()), [])

    def test_replace_ref_is_ignored_and_fork_pristine_uses_the_same_exact_export(self):
        (self.objects / 'start.cmd').write_bytes(b'changed\n'); self.git('add', '.'); self.commit('replacement')
        replacement = self.git('rev-parse', 'HEAD').decode().strip(); self.git('replace', self.base, replacement)
        export_raw_baseline(self.objects, self.base, self.root / 'direct')
        self.assertEqual((self.root / 'direct/start.cmd').read_bytes(), b'@echo off\necho fixed\n')
        path = Path(__file__).resolve().parents[2] / '工具/fork.py'
        spec = importlib.util.spec_from_file_location('fork_source_fixture', path)
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        module.DSH = str(self.objects)
        manifest = self.root / 'manifest.json'; manifest.write_text(json.dumps({'upstream_merge_base': self.base}))
        module.MANIFEST = str(manifest)
        self.assertTrue(module.pristine('local', str(self.root / 'pristine')))
        self.assertEqual((self.root / 'pristine/start.cmd').read_bytes(), b'@echo off\necho fixed\n')

    def test_clone_source_uses_fixed_objects_without_checkout_transform(self):
        self.git('branch', 'vendor-dsh', self.base)
        path = Path(__file__).resolve().parents[2] / '工具/fork.py'
        spec = importlib.util.spec_from_file_location('fork_clone_fixture', path)
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        manifest = self.root / 'manifest.json'; manifest.write_text(json.dumps({'upstream_merge_base': self.base}))
        module.MANIFEST = str(manifest)
        original_run = subprocess.run
        seen = []
        def local_clone(args, **kwargs):
            if args[:2] == ['git', 'clone']:
                self.assertIn('--no-checkout', args); seen.append(True)
                args = [str(self.objects) if arg == 'https://github.com/wuyicn/KVVI-Agent.git' else arg for arg in args]
            return original_run(args, **kwargs)
        with patch.object(module.subprocess, 'run', side_effect=local_clone):
            self.assertTrue(module.pristine('git', str(self.root / 'cloned')))
        self.assertEqual(seen, [True])
        self.assertEqual((self.root / 'cloned/start.cmd').read_bytes(), b'@echo off\necho fixed\n')
        self.assertFalse((self.root / 'cloned/.git').exists())

    def test_publish_io_failure_keeps_the_empty_target_and_removes_staging(self):
        into = self.root / 'exported'; into.mkdir()
        with patch('工具.lib.raw_git_source.os.replace', side_effect=PermissionError('owned failure')):
            with self.assertRaisesRegex(ValueError, 'RAW_SOURCE_EXPORT_FAILED'):
                export_raw_baseline(self.objects, self.base, into)
        self.assertEqual(list(into.iterdir()), [])
        self.assertEqual(list(self.root.glob('kvvi-source-stage-*')), [])

    def test_filesystem_aliases_cannot_silently_merge_distinct_git_paths(self):
        blobs = [self.git('hash-object', '-w', '--stdin', input_bytes=body).decode().strip() for body in [b'first', b'second']]
        for index, (first, second, directories) in enumerate([('A.txt', 'a.txt', False), ('Src', 'src', True), ('é', 'e\u0301', True)]):
            probe = self.root / ('probe-' + str(index)); probe.mkdir(); (probe / first).mkdir()
            aliases = (probe / second).exists()
            entries = []
            for i, name in enumerate([first, second]):
                if directories:
                    tree = self.git('mktree', input_bytes=('100644 blob ' + blobs[i] + '\t' + str(i) + '.txt\n').encode()).decode().strip()
                    entries.append('040000 tree ' + tree + '\t' + name)
                else:
                    entries.append('100644 blob ' + blobs[i] + '\t' + name)
            tree = self.git('mktree', input_bytes=('\n'.join(entries) + '\n').encode()).decode().strip()
            commit = self.git('-c', 'user.name=Source Test', '-c', 'user.email=source-test@example.invalid',
                'commit-tree', tree, '-m', 'alias fixture').decode().strip()
            into = self.root / ('aliases-' + str(index))
            if aliases:
                with self.assertRaisesRegex(ValueError, 'RAW_SOURCE_EXPORT_FAILED'):
                    export_raw_baseline(self.objects, commit, into)
                self.assertFalse(into.exists())
            else:
                export_raw_baseline(self.objects, commit, into)
                self.assertEqual(sorted(p.name for p in into.iterdir()), sorted([first, second]))

    def test_clone_timeout_returns_false_and_cleans_temporary_objects(self):
        path = Path(__file__).resolve().parents[2] / '工具/fork.py'
        spec = importlib.util.spec_from_file_location('fork_timeout_fixture', path)
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        manifest = self.root / 'manifest.json'; manifest.write_text(json.dumps({'upstream_merge_base': self.base}))
        module.MANIFEST = str(manifest)
        roots = []
        def timeout(args, **kwargs):
            roots.append(Path(args[-1]).parent)
            raise subprocess.TimeoutExpired(args, 3600)
        with patch.object(module.subprocess, 'run', side_effect=timeout):
            self.assertFalse(module.pristine('git', str(self.root / 'timed-out')))
        self.assertTrue(roots); self.assertTrue(all(not p.exists() for p in roots))


if __name__ == '__main__':
    unittest.main()
