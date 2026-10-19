import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import unittest
from unittest.mock import patch

from distribution.tests import test_release_package as preservation


class RuntimeSelectionTests(unittest.TestCase):
    setUp = preservation.ReleasePackageTests.setUp
    call = preservation.ReleasePackageTests.call
    pair = preservation.ReleasePackageTests.pair

    def select_another(self):
        selected = self.root / 'explicit runtime source'
        shutil.copytree(self.root / 'vendor/dsh', selected)
        (selected / 'apps/cli/lib/bin.js').write_bytes(b'explicit new runtime\n')
        self.module.RUNTIME_SOURCE = str(selected)
        preservation.register_runtime_source(self.module,self.root)
        return selected

    def test_every_runtime_archive_entry_comes_from_selected_root(self):
        selected = self.select_another()
        self.assertEqual(self.call(self.module.build), 0)
        with tarfile.open(self.module.ARCHIVE) as archive:
            with archive.extractfile(self.module.TOP + '/vendor/dsh/apps/cli/lib/bin.js') as handle:
                self.assertEqual(handle.read(), (selected / 'apps/cli/lib/bin.js').read_bytes())
        self.assertEqual(self.call(self.module.check), 0)
        (self.root / 'vendor/dsh/apps/cli/lib/bin.js').write_bytes(b'ignored old root\n')
        self.assertEqual(self.call(self.module.check), 0)
        (selected / 'apps/cli/lib/bin.js').write_bytes(b'modified selected root\n')
        self.assertNotEqual(self.call(self.module.check), 0)

    def test_missing_or_invalid_selection_never_falls_back_or_changes_pair(self):
        missing = self.root / 'missing'
        linked = self.root / 'linked'; linked.symlink_to(self.root / 'vendor/dsh', target_is_directory=True)
        for source in (None, '', 'vendor/dsh', str(missing), str(linked), str(linked) + '/', os.fsencode(str(self.root / 'vendor/dsh'))):
            with self.subTest(source=source):
                self.module.RUNTIME_SOURCE = source
                self.assertNotEqual(self.call(self.module.build), 0)
                self.assertNotEqual(self.call(self.module.check), 0)
                self.assertEqual(self.pair(), self.old)
                with self.assertRaises(self.module.InventoryError): self.module.source_runtime_js_count()

    def test_declared_main_must_be_in_the_selected_packaged_inventory(self):
        selected = self.select_another(); package = selected / 'packages/new/selected/package.json'
        package.parent.mkdir(parents=True)
        outside = self.root / 'outside.js'; outside.write_bytes(b'not in selected runtime')
        for main in (str(outside), 'node_modules/hidden.js'):
            with self.subTest(main=main):
                package.write_text(json.dumps({'name':'invalid-entrypoint', 'main':main}))
                hidden = package.parent / 'node_modules/hidden.js'; hidden.parent.mkdir(exist_ok=True); hidden.write_bytes(b'excluded')
                self.assertTrue((package.parent / main).is_file())
                preservation.register_runtime_source(self.module,self.root)
                self.assertNotEqual(self.call(self.module.build), 0)
                self.assertEqual(self.pair(), self.old)

    def test_malformed_workspace_manifest_preserves_pair_instead_of_escaping(self):
        selected = self.select_another(); package = selected / 'packages/new/selected/package.json'
        package.parent.mkdir(parents=True)
        for body in ('[]', '[' * 10000 + '0' + ']' * 10000, '{invalid'):
            package.write_text(body)
            self.assertNotEqual(self.call(self.module.build), 0); self.assertEqual(self.pair(), self.old)

    def test_workspace_metadata_must_be_a_collected_regular_file(self):
        selected = self.select_another(); package = selected / 'packages/new/selected/package.json'
        package.parent.mkdir(parents=True)
        external = self.root / 'external-package.json'; external.write_text('{}')
        package.symlink_to(external)
        with self.assertRaises(self.module.InventoryError): self.module.packages_missing_main()
        package.unlink(); package.parent.rmdir()
        external_dir = self.root / 'external-package'; external_dir.mkdir(); (external_dir / 'package.json').write_text('{}')
        package.parent.symlink_to(external_dir, target_is_directory=True)
        with self.assertRaises(self.module.InventoryError): self.module.packages_missing_main()

    def test_node_modules_text_in_selected_root_name_cannot_bypass_main_checks(self):
        selected = self.select_another(); renamed = self.root / 'node_modules-named-runtime'; selected.rename(renamed)
        self.module.RUNTIME_SOURCE = str(renamed)
        package = renamed / 'packages/new/selected/package.json'; package.parent.mkdir(parents=True)
        package.write_text(json.dumps({'name':'broken', 'main':'lib/missing.js'}))
        preservation.register_runtime_source(self.module,self.root)
        self.assertNotEqual(self.call(self.module.build), 0); self.assertEqual(self.pair(), self.old)

    def test_absolute_main_and_unpacked_dependency_alias_cannot_claim_an_entrypoint(self):
        selected = self.select_another(); package = selected / 'packages/new/selected/package.json'
        package.parent.mkdir(parents=True); real = package.parent / 'lib/index.js'; real.parent.mkdir(); real.write_bytes(b'present')
        excluded = package.parent / 'node_modules/hidden.js'; excluded.parent.mkdir(); excluded.symlink_to('../lib/index.js')
        for main in (str(real), 'node_modules/hidden.js'):
            with self.subTest(main=main):
                package.write_text(json.dumps({'name':'not-portable', 'main':main}))
                preservation.register_runtime_source(self.module,self.root)
                self.assertNotEqual(self.call(self.module.build), 0); self.assertEqual(self.pair(), self.old)

    def test_all_declared_workspace_main_suffixes_must_be_present(self):
        selected = self.select_another()
        for relative in ('vendor/schemastery','packages/new/cjs-package','benchmarks'):
            package = selected / relative / 'package.json'; package.parent.mkdir(parents=True, exist_ok=True)
            for suffix in ('.cjs','.mjs',''):
                with self.subTest(relative=relative,suffix=suffix):
                    package.write_text(json.dumps({'name':'missing-entrypoint', 'main':'lib/missing' + suffix}))
                    preservation.register_runtime_source(self.module,self.root)
                    self.assertNotEqual(self.call(self.module.build), 0); self.assertEqual(self.pair(), self.old)
            package.unlink()

    def test_source_manifest_uses_node_nested_dependency_semantics_but_rejects_duplicate_main(self):
        selected = self.select_another(); package = selected / 'packages/new/selected/package.json'; package.parent.mkdir(parents=True)
        entry = package.parent / 'index.cjs'; entry.write_bytes(b'module.exports={fixture:true}\n')
        package.write_text('{"name":"present","main":"index.cjs","dependencies":{"same":"workspace:*","same":"workspace:*"}}')
        preservation.register_runtime_source(self.module,self.root)
        self.assertEqual(self.call(self.module.build), 0); self.assertEqual(self.call(self.module.check), 0)
        previous = self.pair()
        package.write_text('{"main":"index.cjs","main":"missing.cjs"}')
        preservation.register_runtime_source(self.module,self.root)
        self.assertNotEqual(self.call(self.module.build), 0); self.assertEqual(self.pair(), previous)

    def test_unsupported_workspace_selection_metadata_fails_closed(self):
        selected = self.select_another(); yaml = selected / 'pnpm-workspace.yaml'
        for body in ('packages: [vendor/*]\n', 'packages:\n  - !vendor/*\n', 'packages:\n  - vendor/*\npackages:\n  - apps/*\n', "'packages':\n  - vendor/*\n", 'packages:\n  - extras#hidden\n'):
            with self.subTest(body=body):
                yaml.write_text(body)
                preservation.register_runtime_source(self.module,self.root)
                self.assertNotEqual(self.call(self.module.build), 0); self.assertEqual(self.pair(), self.old)

    def test_portable_commonjs_workspace_main_loads_after_unpack(self):
        selected = self.select_another(); package = selected / 'vendor/portable/package.json'; package.parent.mkdir(parents=True)
        package.write_text(json.dumps({'name':'portable-fixture','main':'./index.cjs'}))
        (package.parent / 'index.cjs').write_bytes(b'module.exports={fixture:true}\n')
        preservation.register_runtime_source(self.module,self.root)
        self.assertEqual(self.call(self.module.build), 0); self.assertEqual(self.call(self.module.check), 0)
        destination = self.root / 'unpacked'; destination.mkdir()
        extract = subprocess.run(['/usr/bin/tar','-xzf',self.module.ARCHIVE,'-C',str(destination)], capture_output=True, timeout=15)
        self.assertEqual(extract.returncode, 0)
        node = shutil.which('node')
        if node is None: self.skipTest('Node unavailable for owned CommonJS loading probe')
        result = subprocess.run([node,'--eval','if(require(process.argv[1]).fixture!==true)process.exit(1)',str(destination / self.module.TOP / 'vendor/dsh/vendor/portable')], capture_output=True, timeout=15)
        self.assertEqual(result.returncode, 0)

    def test_glob_metacharacters_in_selected_root_cannot_bypass_main_checks(self):
        selected = self.select_another(); renamed = self.root / 'runtime[abc]'; selected.rename(renamed)
        self.module.RUNTIME_SOURCE = str(renamed)
        package = renamed / 'packages/new/selected/package.json'; package.parent.mkdir(parents=True)
        package.write_text(json.dumps({'name':'broken', 'main':'lib/missing.js'}))
        preservation.register_runtime_source(self.module,self.root)
        self.assertNotEqual(self.call(self.module.build), 0); self.assertEqual(self.pair(), self.old)

    def test_counts_and_missing_main_use_only_the_selected_root(self):
        selected = self.select_another()
        (selected / 'packages/new/selected/lib/types').mkdir(parents=True)
        (selected / 'packages/new/selected/lib/types/extra.js').write_bytes(b'additional runtime')
        self.assertEqual(self.module.source_runtime_js_count(), 3)
        package = selected / 'packages/new/selected/package.json'
        package.write_text(json.dumps({'name':'selected-new-package', 'main':'lib/index.js'}))
        broken = self.module.packages_missing_main()
        self.assertEqual(len(broken), 1); self.assertIn('selected-new-package', broken[0])
        (package.parent / 'lib/index.js').write_bytes(b'entrypoint')
        self.assertEqual(self.module.packages_missing_main(), [])

    def copy_owned_cli(self):
        directory = self.root / '工具'; (directory / 'lib').mkdir(parents=True)
        shutil.copy2(preservation.SCRIPT, directory / '发行包.py')
        for name in ('package_outputs.py','package_inventory.py','package_provenance.py','runtime_source.py'):
            shutil.copy2(preservation.SCRIPT.parent / 'lib' / name, directory / 'lib' / name)
        return directory / '发行包.py'

    def test_cli_requires_explicit_source_and_rejects_conflicting_actions(self):
        script = self.copy_owned_cli()
        archive = self.root / '交付/发行/kvvi-macos-pilot.tar.gz'
        for arguments in (['--build'], ['--check'], ['--build','--check','--runtime-source',str(self.root / 'vendor/dsh')], ['--build','--runtime-source',str(self.root / 'vendor/dsh')]):
            with self.subTest(arguments=arguments):
                result = subprocess.run([sys.executable,str(script),*arguments], capture_output=True, timeout=15)
                self.assertNotEqual(result.returncode, 0); self.assertFalse(archive.exists())

    def test_cli_build_and_check_take_the_explicit_tree_including_space_paths(self):
        selected = self.select_another(); script = self.copy_owned_cli()
        for action in ('--build','--check'):
            result = subprocess.run([sys.executable,str(script),action,'--runtime-source',str(selected),'--git-objects',self.module.GIT_OBJECTS], capture_output=True, timeout=15)
            self.assertEqual(result.returncode, 0, result.stdout.decode(errors='replace'))
        with tarfile.open(self.root / '交付/发行/kvvi-macos-pilot.tar.gz') as archive:
            with archive.extractfile(self.module.TOP + '/vendor/dsh/apps/cli/lib/bin.js') as handle:
                self.assertEqual(handle.read(), b'explicit new runtime\n')

    def test_self_test_is_independent_of_caller_selection_and_both_existing_trees(self):
        self.module.RUNTIME_SOURCE = str(self.root / 'absent caller runtime')
        before = self.pair()
        self.assertEqual(self.call(self.module.self_test), 0); self.assertEqual(self.pair(), before)

    def test_g9_passes_the_same_explicit_source_to_both_package_actions(self):
        script = preservation.SCRIPT.parent / 'check_stage11.py'
        spec = importlib.util.spec_from_file_location('owned_g9',script); g9 = importlib.util.module_from_spec(spec); spec.loader.exec_module(g9)
        g9.ROOT = self.root; g9.ARCHIVE = self.root / 'nonexistent package'
        selected = self.select_another(); calls = []
        def execute(command, **kwargs):
            calls.append(command)
            return subprocess.CompletedProcess(command,0,stdout='',stderr='')
        with patch.object(g9,'run',side_effect=execute), contextlib.redirect_stdout(io.StringIO()):
            g9.ensure_archive(str(selected),self.module.GIT_OBJECTS)
        self.assertEqual(len(calls),2)
        for command in calls:
            self.assertEqual(command[-4:], ['--runtime-source',str(selected),'--git-objects',self.module.GIT_OBJECTS])

    def test_evidence_collection_and_stage11_dispatch_forward_explicit_source(self):
        script = preservation.SCRIPT.parent / '验收证据包.py'
        spec = importlib.util.spec_from_file_location('owned_evidence',script); evidence = importlib.util.module_from_spec(spec); spec.loader.exec_module(evidence)
        selected = str(self.select_another())
        for flag, method in ((None,'collect'),('--append-stage11','append_stage11'),('--refresh-stage11','refresh_stage11')):
            arguments = ['owned-evidence'] + ([flag] if flag else []) + ['--runtime-source',selected,'--git-objects',self.module.GIT_OBJECTS]
            with self.subTest(method=method), patch.object(evidence,method,return_value=0) as called, patch.object(sys,'argv',arguments):
                self.assertEqual(evidence.main(), 0); called.assert_called_once_with(selected,self.module.GIT_OBJECTS)
        for method in (evidence.append_stage11, evidence.refresh_stage11):
            with patch.object(evidence,'_write_stage',return_value=0) as write:
                self.assertEqual(method(selected,self.module.GIT_OBJECTS), 0)
                command = write.call_args.args[2][0][1]
                self.assertEqual(command[-4:], ['--runtime-source',selected,'--git-objects',self.module.GIT_OBJECTS])


if __name__ == '__main__':
    unittest.main()
