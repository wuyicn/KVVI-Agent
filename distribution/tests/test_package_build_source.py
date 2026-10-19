"""Owned clean-source staging; no dependency install, build, or real pilot."""
import importlib
from pathlib import Path
import os
import shutil
import unittest
from unittest.mock import patch

from distribution.tests import test_package_client as client_fixture


class BuildSourceTests(unittest.TestCase):
    write_record = client_fixture.PackageClientTests.write_record

    def setUp(self):
        client_fixture.PackageClientTests.setUp(self)
        self.stage_api=importlib.import_module('工具.lib.package_build_source')
        self.target=self.root/'clean-source'

    def stage(self,**kwargs):
        return self.stage_api.stage_declared_source(self.source,self.objects,self.manifest,self.target,**kwargs)

    def rejected(self):
        result=self.stage(include_material_rows=True)
        self.assertFalse(result['valid']);self.assertFalse(result['releaseApproved'])
        for key in ('materialRows','materialDigest','sourceQualification'):self.assertNotIn(key,result)

    def test_fixed_source_only_excludes_all_current_outputs_dependencies_and_receipt(self):
        dependency=self.source/'node_modules/example/index.js';dependency.parent.mkdir(parents=True);dependency.write_bytes(b'dependency')
        before={path.relative_to(self.source).as_posix():(path.lstat().st_mtime_ns,path.read_bytes()) for path in self.source.rglob('*') if path.is_file() and not path.is_symlink()}
        result=self.stage(include_material_rows=True)
        self.assertTrue(result['valid']);self.assertFalse(result['releaseApproved'])
        self.assertEqual(result['validationScope'],'DECLARED_SOURCE_STAGE')
        self.assertEqual(result['materialCount'],6);self.assertEqual(len(result['materialRows']),6)
        for excluded in ('node_modules','.dsh-build','apps/web/dist','packages/g/p/lib'):
            self.assertFalse((self.target/excluded).exists())
        self.assertEqual((self.target/'package.json').read_bytes(),(self.source/'package.json').read_bytes())
        self.assertTrue((self.target/'packages/CLAUDE.md').is_symlink())
        self.assertEqual(os.readlink(self.target/'packages/CLAUDE.md'),'AGENTS.md')
        self.assertIn('build-execution',result['limitations'])
        after={path.relative_to(self.source).as_posix():(path.lstat().st_mtime_ns,path.read_bytes()) for path in self.source.rglob('*') if path.is_file() and not path.is_symlink()}
        self.assertEqual(before,after)

    def test_nonempty_file_symlink_relative_and_protected_targets_are_preserved(self):
        populated=self.root/'populated';populated.mkdir();(populated/'keep').write_bytes(b'old')
        plain=self.root/'plain-file';plain.write_bytes(b'plain')
        linked=self.root/'linked';linked.symlink_to(populated,target_is_directory=True)
        for target in (populated,plain,linked,Path('relative-target'),self.source/'new-child',self.objects/'new-child'):
            with self.subTest(target=target):
                self.target=target;self.rejected()
        self.assertEqual((populated/'keep').read_bytes(),b'old');self.assertEqual(plain.read_bytes(),b'plain');self.assertTrue(linked.is_symlink())
        self.assertFalse((self.source/'new-child').exists());self.assertFalse((self.objects/'new-child').exists())

    def test_case_alias_of_protected_roots_never_creates_a_stage(self):
        tested=0
        for protected in (self.source,self.objects):
            alias=protected.with_name(protected.name.upper())
            if not alias.is_dir() or not os.path.samefile(alias,protected):continue
            tested+=1;self.target=alias/'new-child'
            with patch.object(self.stage_api.tempfile,'TemporaryDirectory',side_effect=AssertionError('must reject before writing protected root')):
                self.rejected()
        if not tested:self.skipTest('requires actual case-insensitive filesystem alias')

    def test_existing_empty_target_is_published_only_after_success(self):
        self.target.mkdir();result=self.stage();self.assertTrue(result['valid']);self.assertTrue((self.target/'package.json').is_file())
        self.assertNotIn('materialRows',result)

    def test_wrong_fixed_source_rejects_without_publishing(self):
        (self.source/'package.json').write_bytes(b'wrong fixed source');self.target.mkdir();self.rejected()
        self.assertEqual(list(self.target.iterdir()),[])

    def test_temporary_source_body_cannot_be_copied_then_restored(self):
        target=self.source/'package.json';saved=target.read_bytes();original=self.stage_api.snapshot;seen=[]
        def temporary(absolute,relative,*args,**kwargs):
            if Path(absolute)!=target:return original(absolute,relative,*args,**kwargs)
            target.write_bytes(b'temporary wrong body')
            try:seen.append(True);return original(absolute,relative,*args,**kwargs)
            finally:target.write_bytes(saved)
        self.target.mkdir()
        with patch.object(self.stage_api,'snapshot',side_effect=temporary):self.rejected()
        self.assertTrue(seen);self.assertEqual(target.read_bytes(),saved);self.assertEqual(list(self.target.iterdir()),[])

    def test_write_failure_preserves_target_and_cleans_only_own_stage(self):
        self.target.mkdir();unrelated=self.root/'kvvi-build-source-stage-unrelated';unrelated.mkdir();(unrelated/'keep').write_bytes(b'keep')
        original=os.open;seen=[]
        def failure(path,flags,*args,**kwargs):
            if flags & os.O_CREAT and Path(path).name=='package.json':seen.append(True);raise OSError('owned create failure')
            return original(path,flags,*args,**kwargs)
        with patch.object(os,'open',side_effect=failure):self.rejected()
        self.assertTrue(seen);self.assertEqual(list(self.target.iterdir()),[])
        self.assertEqual((unrelated/'keep').read_bytes(),b'keep')
        self.assertEqual([path.name for path in self.root.glob('kvvi-build-source-stage-*')],[unrelated.name])

    def test_source_change_after_staging_prevents_publication(self):
        original=self.stage_api.qualify_runtime_source;calls=[]
        def change(source,*args,**kwargs):
            if Path(source)==self.source:
                calls.append(True)
                if len(calls)==2:(self.source/'package.json').write_bytes(b'late source change')
            return original(source,*args,**kwargs)
        self.target.mkdir()
        with patch.object(self.stage_api,'qualify_runtime_source',side_effect=change):self.rejected()
        self.assertEqual(len(calls),2);self.assertEqual(list(self.target.iterdir()),[])

    def test_late_stage_extra_files_and_declared_old_outputs_never_publish(self):
        original=self.stage_api.material_rows
        for extra in ('unregistered-extra.txt','node_modules/old.js','packages/g/p/lib/stale.js','apps/web/dist/stale.js','.dsh-build/client-build-environment.json','node_modules/empty-directory'):
            with self.subTest(extra=extra):
                seen=[]
                def add(root,*args,**kwargs):
                    result=original(root,*args,**kwargs)
                    if Path(root)!=self.source and not seen:
                        seen.append(True);path=Path(root)/extra;path.parent.mkdir(parents=True,exist_ok=True)
                        if extra.endswith('empty-directory'):path.mkdir()
                        else:path.write_bytes(b'should not be copied')
                    return result
                try:
                    with patch.object(self.stage_api,'material_rows',side_effect=add):self.rejected()
                finally:
                    if self.target.exists():shutil.rmtree(self.target)  # owned fixture only; keep each RED subcase independent
                self.assertTrue(seen);self.assertFalse(self.target.exists())

    def test_last_original_material_read_cannot_hide_a_new_source_file(self):
        original=self.stage_api.material_rows;seen=[]
        def add(root,*args,**kwargs):
            result=original(root,*args,**kwargs)
            if Path(root)==self.source and not seen:
                seen.append(True);(self.source/'late-extra.txt').write_bytes(b'late new source')
            return result
        self.target.mkdir()
        with patch.object(self.stage_api,'material_rows',side_effect=add):self.rejected()
        self.assertTrue(seen);self.assertEqual(list(self.target.iterdir()),[])

    def test_ignored_output_added_after_stage_qualification_is_still_rejected(self):
        original=self.stage_api.qualify_runtime_source;seen=[]
        def add(root,*args,**kwargs):
            result=original(root,*args,**kwargs)
            if Path(root)!=self.source and not seen:
                seen.append(True);path=Path(root)/'node_modules/old.js';path.parent.mkdir();path.write_bytes(b'old dependency')
            return result
        with patch.object(self.stage_api,'qualify_runtime_source',side_effect=add):self.rejected()
        self.assertTrue(seen);self.assertFalse(self.target.exists())

    def test_stage_mutation_after_full_qualification_cannot_disagree_with_material_rows(self):
        original=self.stage_api.qualify_runtime_source
        for kind in ('mode','body'):
            with self.subTest(kind=kind):
                seen=[]
                def change(root,*args,**kwargs):
                    result=original(root,*args,**kwargs)
                    if Path(root)!=self.source and not seen:
                        seen.append(True);path=Path(root)/'package.json'
                        if kind=='mode':path.chmod(0o755)
                        else:path.write_bytes(b'wrong published source body')
                    return result
                try:
                    with patch.object(self.stage_api,'qualify_runtime_source',side_effect=change):self.rejected()
                finally:
                    if self.target.exists():shutil.rmtree(self.target)
                self.assertTrue(seen)

    def test_observed_executable_bit_is_copied_and_bound_without_policy_approval(self):
        (self.source/'packages/AGENTS.md').chmod(0o755)
        result=self.stage(include_material_rows=True)
        self.assertTrue(result['valid']);self.assertEqual((self.target/'packages/AGENTS.md').stat().st_mode & 0o777,0o755)
        row=next(row for row in result['materialRows'] if row['path']=='packages/AGENTS.md')
        self.assertEqual(row['mode'],0o755);self.assertIn('source-executable-policy',result['limitations'])


if __name__=='__main__':unittest.main()
