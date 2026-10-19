import json
from pathlib import Path
import tarfile
import unittest
from unittest.mock import patch

from distribution.tests import test_release_package as fixture


class FixedPackageSourceGateTests(unittest.TestCase):
    setUp = fixture.ReleasePackageTests.setUp
    call = fixture.ReleasePackageTests.call
    pair = fixture.ReleasePackageTests.pair

    def test_source_qualification_is_bound_in_both_manifests(self):
        from 工具.lib.package_provenance import qualify_runtime_source
        expected = qualify_runtime_source(Path(self.module.RUNTIME_SOURCE),Path(self.module.GIT_OBJECTS),self.root / 'forks/dsh/改造点指纹.json')
        external = json.loads(Path(self.module.MANIFEST).read_text())
        self.assertEqual(external['bundleVersion'],'kvvi-macos-pilot/v5')
        self.assertEqual(external['sourceQualification'],expected)
        with tarfile.open(self.module.ARCHIVE) as archive:
            with archive.extractfile(self.module.TOP + '/发行包清单.json') as handle: internal = json.load(handle)
        self.assertEqual(internal['sourceQualification'],expected); self.assertFalse(expected['releaseApproved'])
        self.assertEqual(self.call(self.module.check),0)

    def test_changed_or_extra_fixed_source_cannot_build_or_validate_an_old_package(self):
        selected = Path(self.module.RUNTIME_SOURCE); tracked = selected / 'apps/cli/lib/bin.js'
        original = tracked.read_bytes()
        for extra in (False,True):
            with self.subTest(extra=extra):
                tracked.write_bytes(original)
                if extra:
                    path = selected / 'unregistered-source.js'; path.write_bytes(b'extra')
                else: tracked.write_bytes(original + b'changed')
                self.assertNotEqual(self.call(self.module.build),0); self.assertEqual(self.pair(),self.old)
                self.assertNotEqual(self.call(self.module.check),0); self.assertEqual(self.pair(),self.old)

    def test_missing_git_objects_never_degrades_to_current_source_integrity_only(self):
        for objects in (None,str(self.root / 'missing-objects')):
            self.module.GIT_OBJECTS = objects
            self.assertNotEqual(self.call(self.module.build),0); self.assertEqual(self.pair(),self.old)
            self.assertNotEqual(self.call(self.module.check),0); self.assertEqual(self.pair(),self.old)

    def test_source_change_after_candidate_write_preserves_old_pair(self):
        original = self.module.tarfile.TarFile.addfile; triggered = []
        def change(tar,member,*args,**kwargs):
            result = original(tar,member,*args,**kwargs)
            if member.name == self.module.TOP + '/发行包清单.json' and not triggered:
                triggered.append(True)
                (Path(self.module.RUNTIME_SOURCE) / 'apps/cli/lib/bin.js').write_bytes(b'changed after snapshot')
            return result
        with patch.object(self.module.tarfile.TarFile,'addfile',new=change):
            self.assertNotEqual(self.call(self.module.build),0)
        self.assertTrue(triggered); self.assertEqual(self.pair(),self.old)

    def test_forged_source_binding_and_old_v2_records_fail_closed(self):
        original = json.loads(Path(self.module.MANIFEST).read_text())
        for legacy in (False,True):
            manifest = dict(original)
            if legacy:
                manifest['bundleVersion']='kvvi-macos-pilot/v2'; manifest.pop('sourceQualification',None)
            else:
                manifest['sourceQualification']=dict(manifest['sourceQualification'],baseline='f' * 40)
            Path(self.module.MANIFEST).write_text(json.dumps(manifest))
            self.assertNotEqual(self.call(self.module.check),0)
            self.assertEqual(Path(self.module.ARCHIVE).read_bytes(),self.old[0])

    def test_manifest_bytes_change_after_candidate_write_preserves_old_pair(self):
        original = self.module.tarfile.TarFile.addfile; triggered = []
        def change(tar,member,*args,**kwargs):
            result = original(tar,member,*args,**kwargs)
            if member.name == self.module.TOP + '/发行包清单.json' and not triggered:
                triggered.append(True); path = self.root / 'forks/dsh/改造点指纹.json'
                path.write_bytes(path.read_bytes() + b'\n')
            return result
        with patch.object(self.module.tarfile.TarFile,'addfile',new=change):
            self.assertNotEqual(self.call(self.module.build),0)
        self.assertTrue(triggered); self.assertEqual(self.pair(),self.old)

    def test_source_change_after_current_rows_are_checked_never_returns_success(self):
        original = self.module.packages_missing_main
        def change(*args,**kwargs):
            result = original(*args,**kwargs); (Path(self.module.RUNTIME_SOURCE) / 'apps/cli/lib/bin.js').write_bytes(b'changed at end of check'); return result
        with patch.object(self.module,'packages_missing_main',side_effect=change):
            self.assertNotEqual(self.call(self.module.check),0)
        self.assertEqual(self.pair(),self.old)

    def test_candidate_source_bytes_must_match_fixed_source_even_if_file_is_restored(self):
        original = self.module.snapshot; selected = Path(self.module.RUNTIME_SOURCE) / 'apps/cli/lib/bin.js'
        before = selected.read_bytes(); triggered = []
        def temporary(absolute,relative,*args,**kwargs):
            if Path(absolute) != selected: return original(absolute,relative,*args,**kwargs)
            selected.write_bytes(b'temporary bytes outside the fixed source')
            try:
                triggered.append(True); return original(absolute,relative,*args,**kwargs)
            finally: selected.write_bytes(before)
        with patch.object(self.module,'snapshot',side_effect=temporary):
            self.assertNotEqual(self.call(self.module.build),0)
        self.assertTrue(triggered); self.assertEqual(self.pair(),self.old); self.assertEqual(selected.read_bytes(),before)

    def test_transient_unregistered_source_path_is_not_a_qualified_output(self):
        original_collect = self.module.collect; original_snapshot = self.module.snapshot; calls = []
        extra = Path(self.module.RUNTIME_SOURCE) / 'z-unregistered.js'
        def collect():
            entries = original_collect(); calls.append(True)
            if len(calls) == 2:
                extra.write_bytes(b'transient unregistered source')
                entries.append((str(extra),'vendor/dsh/z-unregistered.js')); entries.sort(key=lambda row:row[1])
            return entries
        def snapshot(absolute,relative,*args,**kwargs):
            result = original_snapshot(absolute,relative,*args,**kwargs)
            if Path(absolute) == extra: extra.unlink()
            return result
        with patch.object(self.module,'collect',side_effect=collect), patch.object(self.module,'snapshot',side_effect=snapshot):
            self.assertNotEqual(self.call(self.module.build),0)
        self.assertFalse(extra.exists()); self.assertEqual(self.pair(),self.old)

    def test_transient_omission_of_a_registered_source_file_preserves_old_pair(self):
        original = self.module.collect; calls = []
        path = Path(self.module.RUNTIME_SOURCE) / 'packages/fixture/build/lib/types/probe.js'
        hidden = self.root / 'temporarily-omitted-source'
        def collect():
            calls.append(True)
            if len(calls) != 2: return original()
            path.rename(hidden)
            try: return original()
            finally: hidden.rename(path)
        with patch.object(self.module,'collect',side_effect=collect):
            self.assertNotEqual(self.call(self.module.build),0)
        self.assertTrue(path.is_file()); self.assertEqual(self.pair(),self.old)

    def test_entrypoint_metadata_reads_match_the_same_fixed_source_inventory(self):
        package = Path(self.module.RUNTIME_SOURCE) / 'packages/new/metadata/package.json'; package.parent.mkdir(parents=True)
        body = b'{"name":"metadata-fixture","main":"lib/missing.js"}'; package.write_bytes(body)
        fixture.register_runtime_source(self.module,self.root)
        original = self.module.snapshot; triggered = []
        def temporary(absolute,relative,*args,**kwargs):
            if Path(absolute) != package or kwargs.get('max_bytes') is None: return original(absolute,relative,*args,**kwargs)
            package.write_bytes(b'{"name":"metadata-fixture"}')
            try:
                triggered.append(True); return original(absolute,relative,*args,**kwargs)
            finally: package.write_bytes(body)
        with patch.object(self.module,'snapshot',side_effect=temporary):
            self.assertNotEqual(self.call(self.module.build),0)
        self.assertTrue(triggered); self.assertEqual(self.pair(),self.old); self.assertEqual(package.read_bytes(),body)

    def test_malformed_or_unbound_private_source_table_never_reaches_publication(self):
        original = self.module.qualify_runtime_source
        for kind in ('missing','digest','duplicate'):
            with self.subTest(kind=kind):
                def corrupt(*args,**kwargs):
                    result = original(*args,**kwargs)
                    if kind == 'missing': result['sourceRows'] = None
                    elif kind == 'digest': result['sourceRows'][0][2] = '0' * 64
                    else: result['sourceRows'].append(result['sourceRows'][0])
                    return result
                with patch.object(self.module,'qualify_runtime_source',side_effect=corrupt):
                    self.assertNotEqual(self.call(self.module.build),0)
                self.assertEqual(self.pair(),self.old)

    def test_workspace_enumeration_uses_the_fixed_table_even_if_glob_misses_a_package(self):
        import glob
        package = Path(self.module.RUNTIME_SOURCE) / 'packages/new/hidden/package.json'; package.parent.mkdir(parents=True)
        package.write_text('{"name":"hidden-main","main":"lib/missing.js"}')
        fixture.register_runtime_source(self.module,self.root)
        original = glob.glob; hidden = self.root / 'temporarily-hidden-workspace'
        def enumerate(pattern,*args,**kwargs):
            if 'packages/' not in pattern: return original(pattern,*args,**kwargs)
            package.parent.rename(hidden)
            try: return original(pattern,*args,**kwargs)
            finally: hidden.rename(package.parent)
        with patch.object(glob,'glob',side_effect=enumerate):
            self.assertNotEqual(self.call(self.module.build),0)
        self.assertTrue(package.is_file()); self.assertEqual(self.pair(),self.old)

    def test_declared_main_in_unqualified_output_must_exist_in_final_candidate(self):
        package = Path(self.module.RUNTIME_SOURCE) / 'packages/new/generated/package.json'; package.parent.mkdir(parents=True)
        package.write_text('{"name":"generated-main","main":"lib/index.js"}')
        (package.parent / 'tsconfig.json').write_text('{"compilerOptions":{"outDir":"lib/types"}}')
        fixture.register_runtime_source(self.module,self.root)
        main = package.parent / 'lib/index.js'; main.parent.mkdir(); main.write_bytes(b'module.exports=true')
        hidden = self.root / 'temporarily-hidden-output'; original = self.module.collect; calls = []
        def collect():
            calls.append(True)
            if len(calls) != 2: return original()
            main.rename(hidden)
            try: return original()
            finally: hidden.rename(main)
        with patch.object(self.module,'collect',side_effect=collect):
            self.assertNotEqual(self.call(self.module.build),0)
        self.assertTrue(main.is_file()); self.assertEqual(self.pair(),self.old)

    def test_candidate_main_link_must_resolve_to_a_file_in_the_candidate(self):
        import os
        package = Path(self.module.RUNTIME_SOURCE) / 'packages/new/link-main/package.json'; package.parent.mkdir(parents=True)
        package.write_text('{"name":"link-main","main":"lib/index.js"}')
        (package.parent / 'tsconfig.json').write_text('{"compilerOptions":{"outDir":"lib/types"}}')
        fixture.register_runtime_source(self.module,self.root)
        target = package.parent / 'lib/target'; target.mkdir(parents=True); (target / 'marker').write_bytes(b'directory marker')
        main = package.parent / 'lib/index.js'; main.symlink_to('target',target_is_directory=True)
        original = os.path.isfile
        with patch.object(os.path,'isfile',side_effect=lambda path: True if Path(path) == main else original(path)):
            self.assertNotEqual(self.call(self.module.build),0)
        self.assertEqual(self.pair(),self.old)

    def test_generated_output_link_is_rejected_by_complete_build_gate(self):
        package = Path(self.module.RUNTIME_SOURCE) / 'packages/new/file-main/package.json'; package.parent.mkdir(parents=True)
        package.write_text('{"name":"file-main","main":"lib/index.js"}')
        (package.parent / 'tsconfig.json').write_text('{"compilerOptions":{"outDir":"lib/types"}}')
        fixture.register_runtime_source(self.module,self.root)
        output = package.parent / 'lib'; output.mkdir(); (output / 'actual.cjs').write_bytes(b'module.exports=true')
        (output / 'index.js').symlink_to('actual.cjs')
        self.assertNotEqual(self.call(self.module.build),0); self.assertEqual(self.pair(),self.old)


if __name__ == '__main__':
    unittest.main()
