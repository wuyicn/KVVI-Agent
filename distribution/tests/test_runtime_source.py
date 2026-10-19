import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

MODULE = Path(__file__).resolve().parents[2] / '工具/lib/runtime_source.py'
spec = importlib.util.spec_from_file_location('runtime_source', MODULE)
runtime_source = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime_source)


class SourceInventoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='kvvi-source-test-')
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.objects = root / 'objects'; self.objects.mkdir()
        self.source = root / 'source'
        for name, text in {
            'package.json': '{"name":"test-source"}',
            'tsconfig.json': '{// project comment\n"compilerOptions":{"outDir":"lib/types",},}',
            'src/base.js': 'upstream\n', 'src/changed.js': 'before\n',
            'src/deleted.js': 'removed\n', 'docs/readme.md': 'documentation\n',
        }.items():
            p = self.objects / name; p.parent.mkdir(parents=True, exist_ok=True); p.write_text(text)
        (self.objects / 'readme-link').symlink_to('docs/readme.md')
        self.git('init', '--quiet'); self.git('add', '.')
        self.git('-c', 'user.name=Source Test', '-c', 'user.email=source-test@example.invalid',
                 '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'baseline')
        self.base = self.git('rev-parse', 'HEAD').strip()
        shutil.copytree(self.objects, self.source, symlinks=True, ignore=shutil.ignore_patterns('.git'))
        (self.source / 'src/changed.js').write_text('overlay\n')
        (self.source / 'src/new.js').write_text('new source\n')
        (self.source / 'src/deleted.js').unlink()
        digest = lambda name: hashlib.sha256((self.source / name).read_bytes()).hexdigest()
        self.manifest = {'upstream_merge_base': self.base, 'count': 3, 'files': {
            'src/changed.js': {'status': 'M', 'sha256': digest('src/changed.js')},
            'src/new.js': {'status': 'A', 'sha256': digest('src/new.js')},
            'src/deleted.js': {'status': 'D', 'sha256': ''},
        }}

    def git(self, *args):
        env = {**os.environ, 'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_CONFIG_SYSTEM': os.devnull}
        return subprocess.run(['git', '-C', str(self.objects), *args], env=env, check=True,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True).stdout

    def check(self):
        return runtime_source.qualify_source(self.source, self.objects, self.manifest)

    def reject(self, code):
        result = self.check(); self.assertFalse(result['valid']); self.assertIn(code, {e['code'] for e in result['errors']})

    def test_all_declared_sources_and_only_config_derived_outputs(self):
        for name in ['lib/types/base.js', 'lib/client.js', 'node_modules/anything/ignored.bin',
                     '.dsh-build/client-build-environment.json', 'tsconfig.host.tsbuildinfo']:
            p = self.source / name; p.parent.mkdir(parents=True, exist_ok=True); p.write_text('unqualified output')
        report = self.check()
        self.assertTrue(report['valid'], report)
        self.assertEqual(report['sourceEntryCount'], 7)
        self.assertEqual(report['validationScope'], 'DECLARED_SOURCE_INVENTORY')
        self.assertFalse(report['releaseApproved'])
        self.assertIn('lib', report['excludedUnqualified'])
        self.assertIn('node_modules', report['excludedUnqualified'])
        (self.source / 'other/lib').mkdir(parents=True)
        (self.source / 'other/lib/injected.js').write_text('unregistered source')
        self.reject('UNEXPECTED_SOURCE_PATH')

    def test_unchanged_upstream_and_overlay_both_require_original_bytes(self):
        for name in ['src/base.js', 'src/changed.js', 'src/new.js']:
            p = self.source / name; old = p.read_bytes(); p.write_bytes(old + b'x')
            self.reject('SOURCE_DIGEST_MISMATCH'); p.write_bytes(old)
        self.assertTrue(self.check()['valid'])

    def test_regular_file_and_parent_directory_cannot_be_replaced_with_links(self):
        outside = Path(self.temp.name) / 'outside'; shutil.copytree(self.source / 'src', outside)
        p = self.source / 'src/base.js'; p.unlink(); p.symlink_to(outside / 'base.js')
        self.reject('SOURCE_ENTRY_TYPE_INVALID')
        p.unlink(); p.write_text('upstream\n')
        shutil.rmtree(self.source / 'src'); (self.source / 'src').symlink_to(outside, target_is_directory=True)
        self.reject('SOURCE_PARENT_LINK')

    def test_exact_link_text_and_deleted_broken_links_are_checked(self):
        p = self.source / 'readme-link'; p.unlink(); p.symlink_to('./docs/readme.md')
        self.reject('SOURCE_LINK_MISMATCH')
        p.unlink(); p.symlink_to('docs/readme.md')
        (self.source / 'src/deleted.js').symlink_to('not-present')
        self.reject('DELETED_SOURCE_PRESENT')

    def test_unknown_links_and_output_root_links_stay_closed(self):
        (self.source / 'unknown').symlink_to('docs/readme.md')
        self.reject('UNEXPECTED_SOURCE_PATH'); (self.source / 'unknown').unlink()
        (self.source / 'node_modules').symlink_to(self.objects, target_is_directory=True)
        self.reject('EXCLUDED_ROOT_LINK')

    def test_missing_baseline_and_unsafe_manifest_paths_do_not_fall_back(self):
        old = self.manifest['upstream_merge_base']; self.manifest['upstream_merge_base'] = '0' * 40
        self.reject('BASELINE_OBJECT_UNAVAILABLE'); self.manifest['upstream_merge_base'] = old
        self.manifest['files']['../outside'] = {'status': 'A', 'sha256': '0' * 64}; self.manifest['count'] += 1
        self.reject('SOURCE_MANIFEST_INVALID')

    def test_git_replace_objects_cannot_change_the_fixed_baseline(self):
        (self.objects / 'src/base.js').write_text('replacement tree\n')
        self.git('add', '.'); self.git('-c', 'user.name=Source Test', '-c', 'user.email=source-test@example.invalid',
            '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'replacement')
        replacement = self.git('rev-parse', 'HEAD').strip()
        self.git('replace', self.base, replacement)
        self.assertTrue(self.check()['valid'])
        (self.source / 'src/base.js').write_text('replacement tree\n')
        self.reject('SOURCE_DIGEST_MISMATCH')

    def test_link_target_cycles_return_closed_reports(self):
        shutil.rmtree(self.source / 'docs')
        (self.source / 'docs').symlink_to('docs', target_is_directory=True)
        self.reject('SOURCE_LINK_UNAVAILABLE')

    def test_special_git_metadata_is_not_an_accepted_exclusion(self):
        os.mkfifo(self.source / '.git')
        self.reject('EXCLUDED_ROOT_TYPE_INVALID')

    def test_registered_invalid_config_shapes_fail_as_layout_errors(self):
        path = 'tsconfig.json'
        self.manifest['count'] += 1
        for value in [[], None, {'compilerOptions': None}, {'compilerOptions': []}]:
            raw = json.dumps(value).encode()
            (self.source / path).write_bytes(raw)
            self.manifest['files'][path] = {'status': 'M', 'sha256': hashlib.sha256(raw).hexdigest()}
            self.reject('SOURCE_BUILD_LAYOUT_UNSUPPORTED')

    def test_declared_native_temporary_container_is_allowed_only_when_empty(self):
        rel = 'native/system/scripts/build.ts'
        script = b"mkdirSync(join(root, '.release'), { recursive: true })\n"
        p = self.objects / rel; p.parent.mkdir(parents=True); p.write_bytes(script)
        self.git('add', '.'); self.git('-c', 'user.name=Source Test', '-c', 'user.email=source-test@example.invalid',
            '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'native build declaration')
        self.manifest['upstream_merge_base'] = self.git('rev-parse', 'HEAD').strip()
        p = self.source / rel; p.parent.mkdir(parents=True); p.write_bytes(script)
        temporary = self.source / 'native/system/.release'; temporary.mkdir()
        report = self.check(); self.assertTrue(report['valid'], report)
        self.assertIn('native/system/.release', report['excludedUnqualified'])
        (temporary / 'interrupted-build.bin').write_bytes(b'partial')
        self.reject('UNEXPECTED_SOURCE_PATH')


if __name__ == '__main__':
    unittest.main()
