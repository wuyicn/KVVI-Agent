"""End-to-end synthetic owned builds, real qualification, no pilot/real assets."""
import copy
import importlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from distribution.tests import test_release_package as package_fixture


class BuildGateTests(unittest.TestCase):
    call=package_fixture.ReleasePackageTests.call
    pair=package_fixture.ReleasePackageTests.pair

    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='kp space-',dir='/private/tmp' if sys.platform=='darwin' else '/tmp');self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.module=package_fixture.load_package()
        self.module.ROOT=str(self.root);self.module.OUT_DIR=str(self.root/'out')
        self.module.ARCHIVE=str(self.root/'out/pilot.tar.gz');self.module.MANIFEST=str(self.root/'out/manifest.json')
        helper=importlib.import_module('工具.lib.package_fixture')
        helper.create_fixture_sources(self.root,self.module)
        helper.build_owned_fixture(self.root,self.module)
        self.assertEqual(self.call(self.module.build),0)
        self.old=self.pair()

    def test_v5_build_and_check_bind_real_owned_receipt_and_private_full_table(self):
        manifest=json.loads(Path(self.module.MANIFEST).read_text())
        self.assertEqual(manifest['bundleVersion'],'kvvi-macos-pilot/v5')
        proof=manifest['buildQualification'];self.assertTrue(proof['valid']);self.assertFalse(proof['releaseApproved'])
        self.assertNotIn('outputRows',proof);self.assertEqual(proof['sourceQualification'],manifest['sourceQualification'])
        self.assertEqual(proof['clientQualification'],manifest['clientQualification'])
        self.assertEqual(self.call(self.module.check),0)

    def test_missing_or_modified_pinned_receipt_preserves_old_outputs(self):
        receipt=Path(self.module.RUNTIME_SOURCE).parent/'metadata/build-receipt.json';saved=receipt.read_bytes()
        for kind in ('missing','modified'):
            if kind=='missing':receipt.unlink()
            else:receipt.write_bytes(saved+b' ')
            self.assertNotEqual(self.call(self.module.build),0);self.assertEqual(self.pair(),self.old)
            self.assertNotEqual(self.call(self.module.check),0)

    def test_transient_extra_host_bytes_restored_before_final_qualification_reject(self):
        target=Path(self.module.RUNTIME_SOURCE)/'packages/fixture/host/lib/extra.js';saved=target.read_bytes();original=self.module.snapshot;seen=[]
        def temporary(path,relative,*args,**kwargs):
            if Path(path)!=target:return original(path,relative,*args,**kwargs)
            target.write_bytes(b'wrong candidate host')
            try:seen.append(True);return original(path,relative,*args,**kwargs)
            finally:target.write_bytes(saved)
        with patch.object(self.module,'snapshot',side_effect=temporary):self.assertNotEqual(self.call(self.module.build),0)
        self.assertTrue(seen);self.assertEqual(self.pair(),self.old)

    def test_non_main_host_omission_preserves_old_outputs(self):
        original=self.module.collect;missing='vendor/dsh/packages/fixture/host/lib/extra.js'
        with patch.object(self.module,'collect',side_effect=lambda:[pair for pair in original() if pair[1]!=missing]):
            self.assertNotEqual(self.call(self.module.build),0)
        self.assertEqual(self.pair(),self.old)

    def test_output_change_after_candidate_write_preserves_old_outputs(self):
        original=self.module.tarfile.TarFile.addfile;seen=[]
        def changed(tar,member,*args,**kwargs):
            result=original(tar,member,*args,**kwargs)
            if member.name==self.module.TOP+'/发行包清单.json' and not seen:
                seen.append(True);(Path(self.module.RUNTIME_SOURCE)/'packages/fixture/host/lib/extra.js').write_bytes(b'late host')
            return result
        with patch.object(self.module.tarfile.TarFile,'addfile',new=changed):self.assertNotEqual(self.call(self.module.build),0)
        self.assertTrue(seen);self.assertEqual(self.pair(),self.old)

    def test_legacy_v4_and_forged_build_digest_are_rejected(self):
        original=json.loads(Path(self.module.MANIFEST).read_text())
        for kind in ('v4','digest'):
            value=copy.deepcopy(original)
            if kind=='v4':value['bundleVersion']='kvvi-macos-pilot/v4';value.pop('buildQualification',None)
            else:value['buildQualification']['outputDigest']='sha256:'+'0'*64
            Path(self.module.MANIFEST).write_text(json.dumps(value));self.assertNotEqual(self.call(self.module.check),0)

    def test_generated_output_link_and_unpinned_tool_changes_reject(self):
        root=Path(self.module.RUNTIME_SOURCE);target=root/'packages/fixture/host/lib/extra.js';saved=target.read_bytes()
        target.unlink();target.symlink_to('index.js');self.assertNotEqual(self.call(self.module.build),0);self.assertEqual(self.pair(),self.old)
        target.unlink();target.write_bytes(saved)
        tool=self.root/'synthetic tools/node';tool.write_bytes(tool.read_bytes()+b'\n# changed tool\n')
        self.assertNotEqual(self.call(self.module.check),0)

    def test_private_full_output_table_cannot_be_omitted_or_modified(self):
        original=self.module.qualify_build_receipt
        for kind in ('missing','hash'):
            def corrupt(*args,**kwargs):
                result=original(*args,**kwargs)
                if kind=='missing':result.pop('outputRows',None)
                else:result['outputRows'][-1]['sha256']='sha256:'+'0'*64
                return result
            with patch.object(self.module,'qualify_build_receipt',side_effect=corrupt):self.assertNotEqual(self.call(self.module.build),0)
            self.assertEqual(self.pair(),self.old)

    def test_build_receipt_change_at_end_of_check_is_rejected(self):
        original=self.module.packages_missing_main;seen=[]
        def change(*args,**kwargs):
            result=original(*args,**kwargs)
            if kwargs.get('candidate_rows') is not None:
                seen.append(True);receipt=Path(self.module.RUNTIME_SOURCE).parent/'metadata/build-receipt.json';receipt.write_bytes(receipt.read_bytes()+b' ')
            return result
        with patch.object(self.module,'packages_missing_main',side_effect=change):self.assertNotEqual(self.call(self.module.check),0)
        self.assertTrue(seen);self.assertEqual(self.pair(),self.old)

    def test_build_receipt_change_during_final_main_check_never_publishes(self):
        (self.root/'README.md').write_text('new candidate')
        original=self.module.packages_missing_main;seen=[]
        def change(*args,**kwargs):
            result=original(*args,**kwargs)
            if kwargs.get('candidate_rows') is not None:
                seen.append(True);receipt=Path(self.module.RUNTIME_SOURCE).parent/'metadata/build-receipt.json';receipt.write_bytes(receipt.read_bytes()+b' ')
            return result
        with patch.object(self.module,'packages_missing_main',side_effect=change):self.assertNotEqual(self.call(self.module.build),0)
        self.assertTrue(seen);self.assertEqual(self.pair(),self.old)

    @staticmethod
    def flip_gzip_mtime(path):
        with Path(path).open('r+b') as handle:
            handle.seek(4);value=handle.read(1);handle.seek(4);handle.write(bytes([value[0]^1]))

    def test_check_rejects_late_archive_header_or_outer_manifest_change(self):
        original=self.module.packages_missing_main
        for kind in ('archive','manifest'):
            Path(self.module.ARCHIVE).write_bytes(self.old[0]);Path(self.module.MANIFEST).write_bytes(self.old[1]);seen=[]
            def change(*args,**kwargs):
                result=original(*args,**kwargs)
                if kwargs.get('candidate_rows') is not None and not seen:
                    seen.append(True)
                    if kind=='archive':self.flip_gzip_mtime(self.module.ARCHIVE)
                    else:Path(self.module.MANIFEST).write_bytes(Path(self.module.MANIFEST).read_bytes()+b' ')
                return result
            with patch.object(self.module,'packages_missing_main',side_effect=change):self.assertNotEqual(self.call(self.module.check),0)
            self.assertTrue(seen)

    def test_build_rejects_candidate_pair_change_after_last_build_qualification(self):
        original=self.module.selected_build_qualification
        for kind in ('archive','manifest'):
            calls=[]
            def change(*args,**kwargs):
                result=original(*args,**kwargs);calls.append(True)
                if len(calls)==2:
                    directory=next((self.root/'out').glob('kvvi-package-candidate-*'))
                    if kind=='archive':self.flip_gzip_mtime(directory/'candidate.tar.gz')
                    else:
                        path=directory/'candidate-manifest.json';path.write_bytes(path.read_bytes()+b' ')
                return result
            with patch.object(self.module,'selected_build_qualification',side_effect=change):self.assertNotEqual(self.call(self.module.build),0)
            self.assertEqual(self.pair(),self.old)

    def test_first_candidate_manifest_snapshot_must_match_internal_semantics(self):
        original=self.module.snapshot
        for kind in ('count','archive','build','empty','array'):
            with self.subTest(kind=kind):
                seen=[]
                def corrupt(path,label,*args,**kwargs):
                    if Path(path).name=='candidate-manifest.json' and not seen:
                        seen.append(True);target=Path(path);value=json.loads(target.read_text())
                        if kind=='count':value['fileCount']+=1
                        elif kind=='archive':value['archive']='wrong.tar.gz'
                        elif kind=='build':value['buildQualification']['outputCount']+=1
                        elif kind=='empty':value={}
                        else:value=[]
                        target.write_text(json.dumps(value))
                    return original(path,label,*args,**kwargs)
                with patch.object(self.module,'snapshot',side_effect=corrupt):self.assertNotEqual(self.call(self.module.build),0)
                self.assertTrue(seen);self.assertEqual(self.pair(),self.old)


if __name__=='__main__':unittest.main()
