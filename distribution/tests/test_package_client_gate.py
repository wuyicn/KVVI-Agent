"""Client receipt/candidate binding, only owned synthetic repositories and archives."""
import json
from pathlib import Path
import tarfile
import unittest
from unittest.mock import patch

from distribution.tests import test_release_package as fixture


class PackageClientGateTests(unittest.TestCase):
    setUp = fixture.ReleasePackageTests.setUp
    call = fixture.ReleasePackageTests.call
    pair = fixture.ReleasePackageTests.pair

    def test_v4_manifest_and_archive_bind_the_verified_client_receipt(self):
        manifest = json.loads(Path(self.module.MANIFEST).read_text())
        self.assertEqual(manifest['bundleVersion'],'kvvi-macos-pilot/v4')
        proof = manifest['clientQualification']
        self.assertTrue(proof['valid']); self.assertFalse(proof['releaseApproved'])
        self.assertEqual(proof['sourceQualification'],manifest['sourceQualification'])
        self.assertEqual(proof['artifactCount'],1); self.assertNotIn('clientRows',proof)
        self.assertIn('clientInventoryDigest',proof)
        with tarfile.open(self.module.ARCHIVE) as tar:
            receipt = tar.extractfile(self.module.TOP+'/vendor/dsh/.dsh-build/client-build-environment.json').read()
        self.assertEqual(receipt,(Path(self.module.RUNTIME_SOURCE)/'.dsh-build/client-build-environment.json').read_bytes())
        self.assertEqual(self.call(self.module.check),0)

    def test_missing_or_stale_receipt_rejects_build_and_preserves_pair(self):
        root = Path(self.module.RUNTIME_SOURCE); record = root / '.dsh-build/client-build-environment.json'; saved = record.read_bytes()
        record.unlink(); self.assertNotEqual(self.call(self.module.build),0); self.assertEqual(self.pair(),self.old)
        record.write_bytes(saved); (root/'apps/web/dist/index.html').write_bytes(b'changed client')
        self.assertNotEqual(self.call(self.module.build),0); self.assertEqual(self.pair(),self.old)

    def test_temporary_client_bytes_restored_before_final_qualification_reject(self):
        target = Path(self.module.RUNTIME_SOURCE)/'apps/web/dist/index.html'; saved = target.read_bytes(); original = self.module.snapshot; seen=[]
        def temporary(absolute,relative,*args,**kwargs):
            if relative != 'vendor/dsh/apps/web/dist/index.html': return original(absolute,relative,*args,**kwargs)
            target.write_bytes(b'wrong candidate client')
            try: seen.append(True); return original(absolute,relative,*args,**kwargs)
            finally: target.write_bytes(saved)
        with patch.object(self.module,'snapshot',side_effect=temporary): self.assertNotEqual(self.call(self.module.build),0)
        self.assertTrue(seen); self.assertEqual(self.pair(),self.old); self.assertEqual(target.read_bytes(),saved)

    def test_final_candidate_cannot_omit_a_client_file_or_receipt(self):
        original=self.module.collect
        for missing in ('vendor/dsh/apps/web/dist/index.html','vendor/dsh/.dsh-build/client-build-environment.json'):
            with self.subTest(missing=missing):
                with patch.object(self.module,'collect',side_effect=lambda:[entry for entry in original() if entry[1]!=missing]):
                    self.assertNotEqual(self.call(self.module.build),0)
                self.assertEqual(self.pair(),self.old)

    def test_extra_matching_candidate_chunk_is_rejected(self):
        original=self.module.collect
        def collect():
            return sorted(original()+[(str(self.root/'README.md'),'vendor/dsh/apps/web/dist/injected.js')],key=lambda entry:entry[1])
        with patch.object(self.module,'collect',side_effect=collect): self.assertNotEqual(self.call(self.module.build),0)
        self.assertEqual(self.pair(),self.old)

    def test_temporary_receipt_bytes_cannot_escape_its_verified_snapshot(self):
        target=Path(self.module.RUNTIME_SOURCE)/'.dsh-build/client-build-environment.json'; saved=target.read_bytes(); original=self.module.snapshot; seen=[]
        def temporary(absolute,relative,*args,**kwargs):
            if relative!='vendor/dsh/.dsh-build/client-build-environment.json': return original(absolute,relative,*args,**kwargs)
            target.write_bytes(saved+b' ')
            try: seen.append(True); return original(absolute,relative,*args,**kwargs)
            finally: target.write_bytes(saved)
        with patch.object(self.module,'snapshot',side_effect=temporary): self.assertNotEqual(self.call(self.module.build),0)
        self.assertTrue(seen); self.assertEqual(self.pair(),self.old)

    def test_private_client_rows_must_match_qualified_count_and_inventory_digest(self):
        original=self.module.qualify_client_outputs
        for corruption in ('missing','hash','duplicate'):
            with self.subTest(corruption=corruption):
                def corrupt(*args,**kwargs):
                    result=original(*args,**kwargs)
                    if corruption=='missing':result['clientRows']=None
                    elif corruption=='hash':result['clientRows'][0]['sha256']='sha256:'+'0'*64
                    else:result['clientRows'].append(result['clientRows'][0])
                    return result
                with patch.object(self.module,'qualify_client_outputs',side_effect=corrupt): self.assertNotEqual(self.call(self.module.build),0)
                self.assertEqual(self.pair(),self.old)

    def rewrite_current_receipt(self):
        from 工具.lib.package_client import artifact_snapshots
        record = Path(self.module.RUNTIME_SOURCE)/'.dsh-build/client-build-environment.json'
        value = json.loads(record.read_text()); rows,digest = artifact_snapshots(Path(self.module.RUNTIME_SOURCE))
        value['artifacts']={'fileCount':len(rows),'sha256':digest}; record.write_text(json.dumps(value))

    def test_valid_but_different_client_receipt_after_candidate_write_preserves_old_pair(self):
        original=self.module.tarfile.TarFile.addfile; seen=[]
        def change(tar,member,*args,**kwargs):
            result=original(tar,member,*args,**kwargs)
            if member.name==self.module.TOP+'/发行包清单.json' and not seen:
                seen.append(True); (Path(self.module.RUNTIME_SOURCE)/'apps/web/dist/index.html').write_bytes(b'later valid build')
                self.rewrite_current_receipt()
            return result
        with patch.object(self.module.tarfile.TarFile,'addfile',new=change): self.assertNotEqual(self.call(self.module.build),0)
        self.assertTrue(seen); self.assertEqual(self.pair(),self.old)

    def test_client_change_after_check_rows_never_returns_success(self):
        original=self.module.qualify_runtime_source; calls=[]
        def change(*args,**kwargs):
            calls.append(True)
            if len(calls)==2:
                (Path(self.module.RUNTIME_SOURCE)/'apps/web/dist/index.html').write_bytes(b'later client')
                self.rewrite_current_receipt()
            return original(*args,**kwargs)
        with patch.object(self.module,'qualify_runtime_source',side_effect=change): self.assertNotEqual(self.call(self.module.check),0)
        self.assertEqual(len(calls),2); self.assertEqual(self.pair(),self.old)

    def test_old_v3_and_forged_client_binding_are_rejected(self):
        original=json.loads(Path(self.module.MANIFEST).read_text())
        for kind in ('v3','client-digest'):
            value=json.loads(json.dumps(original))
            if kind=='v3': value['bundleVersion']='kvvi-macos-pilot/v3'; value.pop('clientQualification')
            else: value['clientQualification']['artifactDigest']='sha256:'+'0'*64
            Path(self.module.MANIFEST).write_text(json.dumps(value)); self.assertNotEqual(self.call(self.module.check),0)
        self.assertEqual(Path(self.module.ARCHIVE).read_bytes(),self.old[0])

    def test_candidate_directory_link_cannot_create_unlisted_client_aliases(self):
        source=Path(self.module.RUNTIME_SOURCE)
        package=source/'packages/g/p/package.json'; package.parent.mkdir(parents=True)
        package.write_text('{"name":"alias-probe"}')
        (package.parent/'tsconfig.json').write_text('{"compilerOptions":{"outDir":"lib/types"}}')
        (source/'apps/web/dist/client.js').write_bytes(b'web client also matches aliased lib glob')
        fixture.register_runtime_source(self.module,self.root)
        (package.parent/'lib').mkdir()
        alias=self.root/'candidate-directory-alias';alias.symlink_to('../../../apps/web/dist',target_is_directory=True)
        original=self.module.collect
        def collect():
            return sorted(original()+[(str(alias),'vendor/dsh/packages/g/p/lib')],key=lambda entry:entry[1])
        with patch.object(self.module,'collect',side_effect=collect): self.assertNotEqual(self.call(self.module.build),0)
        self.assertEqual(self.pair(),self.old)

    def test_other_dsh_build_metadata_is_never_collected(self):
        path=Path(self.module.RUNTIME_SOURCE)/'.dsh-build/private-extra.json';path.write_text('private fixture')
        self.assertNotIn(str(path),[absolute for absolute,_ in self.module.collect()])
        self.assertIn('vendor/dsh/.dsh-build/client-build-environment.json',[relative for _,relative in self.module.collect()])


if __name__=='__main__':unittest.main()
