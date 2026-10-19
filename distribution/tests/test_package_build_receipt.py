"""Pinned receipt qualification from owned synthetic builds, no real assets."""
import hashlib
import importlib
import json
from pathlib import Path
import unittest
from unittest.mock import patch

from distribution.tests import test_package_clean_build as build_fixture
from 工具.lib.package_inventory import snapshot


def write_json(path,value):
    path.write_text(json.dumps(value,sort_keys=True,ensure_ascii=True,separators=(',',':'))+'\n')


class BuildReceiptTests(unittest.TestCase):
    def setUp(self):
        build_fixture.CleanBuildTests.setUp(self)
        built=self.api.run_clean_build(self.source,self.objects,self.manifest,self.workspace,self.node,self.pnpm,self.store)
        self.assertTrue(built['valid'],built)
        self.built_source=self.workspace/'source';self.receipt=self.workspace/'metadata/build-receipt.json'
        self.record=json.loads(self.receipt.read_text());self.anchor=self.root/'trusted-build-anchor.json'
        self.pin()
        self.receipt_api=importlib.import_module('工具.lib.package_build_receipt')

    def pin(self):
        r=self.record;q=r['outputQualification'];data=self.receipt.read_bytes()
        anchor={'formatVersion':'kvvi-local-build-anchor/v1','validationScope':'OBSERVED_LOCAL_BUILD','releaseApproved':False,'runnerCommit':'1'*40,
                'workspace':str(self.workspace),'runtimeSource':r['runtimeSource'],'receiptPath':str(self.receipt),
                'receiptSha256':'sha256:'+hashlib.sha256(data).hexdigest(),'receiptBytes':len(data),
                'sourceEntryCount':r['inputMaterialCount'],'sourceInventoryDigest':r['inputQualification']['inventoryDigest'],
                'overlayManifestSha256':r['inputQualification']['overlayManifestSha256'],'inputMaterialDigest':r['inputMaterialDigest'],
                'outputCount':q['outputCount'],'outputDigest':q['outputDigest'],'outputBoundaryCount':len(q['outputBoundaries']),
                'clientCount':q['clientQualification']['artifactCount'],'clientDigest':q['clientQualification']['artifactDigest'],
                'clientEnvironment':q['clientQualification']['environment'],'nodeHost':r['nodeHost'],'tools':r['tools'],'nativeOutput':None,
                'commands':[{'name':c['name'],'exitCode':c['result']['exitCode'],'cleanupConfirmed':c['result']['cleanupConfirmed'],'log':c['log']} for c in r['commands']],
                'readOnlyReverificationSha256':'sha256:'+'2'*64,
                'limitations':r['limitations']+['signed-attestation','unobserved-daemon-escape','packager-consumption']}
        write_json(self.anchor,anchor)

    def rewrite_receipt(self):
        write_json(self.receipt,self.record);self.pin()

    def update_command(self,index):
        command=self.record['commands'][index];path=self.workspace/'metadata'/(command['name']+'.json')
        write_json(path,command)
        self.record['commandRecordFiles'][index]=snapshot(path,'metadata/'+path.name)[0]
        self.rewrite_receipt()

    def qualify(self,**options):
        return self.receipt_api.qualify_build_receipt(self.built_source,self.objects,self.manifest,self.receipt,self.anchor,**options)

    def rejected(self):
        result=self.qualify(include_output_rows=True)
        self.assertFalse(result['valid']);self.assertFalse(result['releaseApproved'])
        for name in ('outputRows','outputDigest','sourceQualification','buildReceipt','buildAnchorSha256'):self.assertNotIn(name,result)
        return result

    def test_pinned_current_complete_build_and_private_output_rows(self):
        result=self.qualify();self.assertTrue(result['valid'],result);self.assertFalse(result['releaseApproved'])
        self.assertEqual(result['validationScope'],'PINNED_LOCAL_BUILD_RECEIPT')
        self.assertEqual(result['outputCount'],4);self.assertEqual(result['inputMaterialCount'],4)
        self.assertNotIn('outputRows',result)
        self.assertEqual(len(self.qualify(include_output_rows=True)['outputRows']),4)
        self.assertIn('signed-attestation',result['limitations'])

    def test_selected_original_source_is_not_replaced_by_anchor_source(self):
        self.built_source=self.source;self.rejected()

    def test_receipt_raw_hash_mismatch_rejects_before_source_qualification(self):
        with self.receipt.open('ab') as handle:handle.write(b' ')
        with patch.object(self.receipt_api,'qualify_runtime_source',side_effect=AssertionError('must reject first')):self.rejected()

    def test_changed_declared_source_rejects(self):
        (self.built_source/'package.json').write_text('{}');self.rejected()

    def test_changed_host_output_rejects(self):
        (self.built_source/'packages/g/p/lib/host.js').write_text('changed host');self.rejected()

    def test_resigned_empty_input_table_still_fails_material_binding(self):
        path=self.workspace/'metadata/source-material.json';write_json(path,[])
        self.record['inputMaterialFile']=snapshot(path,'metadata/source-material.json')[0]
        self.rewrite_receipt();self.rejected()

    def test_resigned_missing_output_row_still_fails_complete_output_binding(self):
        path=self.workspace/'metadata/output-rows.json';rows=json.loads(path.read_text());write_json(path,rows[:-1])
        self.record['outputRowsFile']=snapshot(path,'metadata/output-rows.json')[0]
        self.rewrite_receipt();self.rejected()

    def test_bool_zero_cannot_equal_integer_output_category(self):
        self.record['outputQualification']['categoryCounts']['native-declared-binary']=False
        self.rewrite_receipt();self.rejected()

    def test_bool_exit_code_cannot_equal_real_zero(self):
        self.record['commands'][3]['result']['exitCode']=False
        self.update_command(3);self.rejected()

    def test_exact_offline_install_argv_is_required(self):
        self.record['commands'][2]['argv'].remove('--offline');self.update_command(2);self.rejected()

    def test_changed_log_and_tool_are_rejected(self):
        log=self.workspace/'logs/install.log';saved=log.read_bytes();log.write_bytes(b'changed log');self.rejected();log.write_bytes(saved)
        self.node.write_text(self.node.read_text()+'\n# changed tool\n');self.rejected()

    def test_metadata_directory_link_is_not_followed(self):
        directory=self.workspace/'metadata';moved=self.root/'external-metadata';directory.rename(moved);directory.symlink_to(moved,target_is_directory=True)
        self.rejected()

    def test_copied_receipt_outside_recorded_workspace_is_rejected(self):
        copy=self.root/'copied-receipt.json';copy.write_bytes(self.receipt.read_bytes());self.receipt=copy;self.rejected()

    def test_oversized_receipt_never_uses_unbounded_snapshot(self):
        with self.receipt.open('r+b') as handle:handle.truncate(32*1024*1024)
        original=self.receipt_api.snapshot
        def bounded(path,label,max_bytes=None):
            if Path(path)==self.receipt:self.assertIsNotNone(max_bytes)
            return original(path,label,max_bytes=max_bytes)
        with patch.object(self.receipt_api,'snapshot',side_effect=bounded):self.rejected()

    def assert_large_tool_rejected_with_bounded_read(self, late=False):
        expected=self.record['tools']['node']['row']['bytes'];seen=[]
        original_snapshot=snapshot;original_output=self.receipt_api.qualify_output_inventory
        def enlarge():
            with self.node.open('r+b') as handle:handle.truncate(128*1024*1024)
        def bounded(path,label,max_bytes=None):
            if Path(path)==self.node:
                seen.append(max_bytes);self.assertEqual(max_bytes,expected)
            return original_snapshot(path,label,max_bytes=max_bytes)
        def output(*args,**kwargs):
            result=original_output(*args,**kwargs)
            if late:enlarge()
            return result
        if not late:enlarge()
        with patch.object(self.api,'snapshot',side_effect=bounded), patch.object(self.receipt_api,'snapshot',side_effect=bounded), patch.object(self.receipt_api,'qualify_output_inventory',side_effect=output):
            self.rejected()
        self.assertEqual(len(seen),2 if late else 1)

    def test_oversized_tool_is_rejected_before_unbounded_read(self):
        self.assert_large_tool_rejected_with_bounded_read()

    def test_late_oversized_tool_is_rejected_before_unbounded_read(self):
        self.assert_large_tool_rejected_with_bounded_read(late=True)

    def test_unrepresentable_pinned_tool_size_is_fixed_rejection(self):
        self.record['tools']['node']['row']['bytes']=2**100
        self.rewrite_receipt();self.rejected()

    def test_output_change_after_first_full_qualification_rejects(self):
        original=self.receipt_api.qualify_output_inventory;seen=[]
        def changed(root,*args,**kwargs):
            result=original(root,*args,**kwargs)
            if result.get('valid') and not seen:
                seen.append(True);(Path(root)/'packages/g/p/lib/host.js').write_text('late host')
            return result
        with patch.object(self.receipt_api,'qualify_output_inventory',side_effect=changed):self.rejected()
        self.assertTrue(seen)

    def test_trusted_anchor_change_during_final_scan_rejects(self):
        original=self.receipt_api.qualify_output_inventory;seen=[]
        def changed(*args,**kwargs):
            result=original(*args,**kwargs)
            if not seen:seen.append(True);self.anchor.write_bytes(self.anchor.read_bytes()+b' ')
            return result
        with patch.object(self.receipt_api,'qualify_output_inventory',side_effect=changed):self.rejected()
        self.assertTrue(seen)


if __name__=='__main__':unittest.main()
