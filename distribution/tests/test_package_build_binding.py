"""Pure typed binding fixtures, no build or execution-attestation claims."""
import copy
import hashlib
import importlib
import json
import unittest

from 工具.lib.package_inventory import (InventoryError, SOURCE_LIMITATIONS, CLIENT_LIMITATIONS, content_digest)
from 工具.lib.package_build_receipt import LIMITATIONS


def row(path, body=b'fixture', mode=0o644):
    return dict(path=path,type='file',mode=mode,bytes=len(body),sha256='sha256:'+hashlib.sha256(body).hexdigest())


class BuildBindingTests(unittest.TestCase):
    def setUp(self):
        self.api=importlib.import_module('工具.lib.package_build_binding')
        self.source_rows=[['package.json','file',hashlib.sha256(b'fixture').hexdigest()]]
        source=dict(valid=True,validationScope='FIXED_DECLARED_SOURCE',releaseApproved=False,baseline='1'*40,
                    overlayManifestSha256='sha256:'+'2'*64,inventoryProfile='kvvi-declared-source/v1',
                    inventoryDigest='sha256:'+hashlib.sha256(json.dumps(self.source_rows,separators=(',',':')).encode()).hexdigest(),
                    sourceEntryCount=1,excludedUnqualified=['.dsh-build','apps/web/dist','packages/g/p/lib','tsconfig.host.tsbuildinfo'],limitations=list(SOURCE_LIMITATIONS))
        self.outputs=sorted([row('.dsh-build/client-build-environment.json'),row('apps/web/dist/index.html'),
                             row('packages/g/p/lib/host.js'),row('packages/g/p/lib/types/index.js'),
                             row('packages/g/p/lib/types/index.d.ts'),row('packages/g/p/lib/types/index.js.map'),
                             row('tsconfig.host.tsbuildinfo')],key=lambda r:r['path'])
        client_rows=[self.outputs[1]]
        client=dict(valid=True,validationScope='FIXED_SOURCE_CLIENT_RECEIPT',releaseApproved=False,sourceQualification=source,
                    receipt=self.outputs[0],environment={'DSH_CLIENT_COMMIT_HASH':'1111111','DSH_CLIENT_VERSION':'1.0.0'},
                    artifactCount=1,artifactDigest='sha256:'+'3'*64,clientInventoryDigest=content_digest(client_rows),limitations=list(CLIENT_LIMITATIONS))
        self.proof=dict(valid=True,validationScope='PINNED_LOCAL_BUILD_RECEIPT',releaseApproved=False,sourceQualification=source,
                        buildReceipt=row('metadata/build-receipt.json'),buildAnchorSha256='sha256:'+'4'*64,
                        inputMaterialCount=1,inputMaterialDigest='sha256:'+'5'*64,outputCount=len(self.outputs),outputDigest=content_digest(self.outputs),
                        clientQualification=client,nodeHost={'version':'v24.20.0','platform':'darwin','arch':'arm64'},
                        tools={name:{'path':'/owned/tools/'+name,'row':row(name,mode=0o755 if name=='node' else 0o644)} for name in ('node','pnpm')},limitations=list(LIMITATIONS))
        self.candidate=sorted([row('README.md'),row('vendor/dsh/package.json')]+[
            dict(r,path='vendor/dsh/'+r['path']) for r in self.outputs if self.api.runtime_file_included(r['path'])],key=lambda r:r['path'])

    def bind(self):
        return self.api.bind_build_rows(self.candidate,self.outputs,self.proof,self.source_rows,{'package.json'})

    def rejected(self):
        with self.assertRaises(InventoryError):self.bind()

    def test_full_table_binds_only_policy_projection(self):
        self.bind()
        paths={r['path'] for r in self.candidate}
        self.assertIn('vendor/dsh/packages/g/p/lib/types/index.js',paths)
        self.assertNotIn('vendor/dsh/packages/g/p/lib/types/index.d.ts',paths)
        self.assertNotIn('vendor/dsh/tsconfig.host.tsbuildinfo',paths)
        self.assertEqual(self.api.project_output_rows(self.outputs,self.proof),[r for r in self.outputs if self.api.runtime_file_included(r['path'])])

    def test_missing_included_host_or_native_or_receipt_is_rejected(self):
        saved=copy.deepcopy(self.candidate)
        for path in ('packages/g/p/lib/host.js','.dsh-build/client-build-environment.json'):
            self.candidate=[r for r in saved if r['path']!='vendor/dsh/'+path];self.rejected()
        native=row('native/system/packages/darwin-arm64/bin/system.node',mode=0o755)
        self.outputs.append(native);self.outputs.sort(key=lambda r:r['path']);self.proof['outputCount']=len(self.outputs);self.proof['outputDigest']=content_digest(self.outputs)
        self.candidate=saved;self.rejected()

    def test_output_body_mode_and_type_substitution_is_rejected(self):
        saved=copy.deepcopy(self.candidate)
        for kind in ('body','mode','type'):
            self.candidate=copy.deepcopy(saved);target=next(r for r in self.candidate if r['path'].endswith('/host.js'))
            if kind=='body':target['sha256']='sha256:'+'0'*64
            elif kind=='mode':target['mode']=0o755
            else:target.clear();target.update(path='vendor/dsh/packages/g/p/lib/host.js',type='symlink',mode=0o777,target='../../../package.json')
            self.rejected()

    def test_unknown_output_under_declared_boundary_is_rejected(self):
        self.candidate.append(row('vendor/dsh/packages/g/p/lib/new.js'));self.candidate.sort(key=lambda r:r['path']);self.rejected()

    def test_excluded_but_verified_output_cannot_be_injected(self):
        self.candidate.append(row('vendor/dsh/packages/g/p/lib/types/index.d.ts'));self.candidate.sort(key=lambda r:r['path']);self.rejected()

    def test_full_private_table_missing_duplicate_changed_or_boolean_count_is_rejected(self):
        saved=copy.deepcopy(self.outputs)
        for kind in ('missing','duplicate','hash','bool'):
            self.outputs=copy.deepcopy(saved)
            if kind=='missing':self.outputs.pop()
            elif kind=='duplicate':self.outputs.append(self.outputs[-1])
            elif kind=='hash':self.outputs[-1]['sha256']='sha256:'+'0'*64
            else:self.proof['outputCount']=True
            self.rejected()

    def test_skipped_rows_are_verified_before_projection(self):
        next(r for r in self.outputs if r['path'].endswith('.d.ts'))['sha256']='sha256:'+'0'*64
        self.rejected()

    def test_source_and_output_paths_cannot_overlap(self):
        self.outputs.append(row('package.json'));self.outputs.sort(key=lambda r:r['path'])
        self.proof['outputCount']=len(self.outputs);self.proof['outputDigest']=content_digest(self.outputs);self.rejected()

    def test_source_body_or_included_set_cannot_be_forged(self):
        next(r for r in self.candidate if r['path']=='vendor/dsh/package.json')['sha256']='sha256:'+'0'*64;self.rejected()
        with self.assertRaises(InventoryError):self.api.bind_build_rows(self.candidate,self.outputs,self.proof,self.source_rows,{'missing'})

    def test_caller_cannot_shrink_policy_source_set_to_hide_omission(self):
        self.candidate=[r for r in self.candidate if r['path']!='vendor/dsh/package.json']
        with self.assertRaises(InventoryError):self.api.bind_build_rows(self.candidate,self.outputs,self.proof,self.source_rows,set())

    def test_policy_cannot_drop_a_receipt_covered_client_log(self):
        self.outputs.append(row('apps/web/dist/covered.log'));self.outputs.sort(key=lambda r:r['path'])
        self.proof['outputCount']=len(self.outputs);self.proof['outputDigest']=content_digest(self.outputs)
        client=self.proof['clientQualification'];client['artifactCount']=2
        client['clientInventoryDigest']=content_digest([r for r in self.outputs if r['path'].startswith('apps/web/dist/')])
        self.rejected()

    def test_source_link_policy_uses_archive_path_not_filesystem_target_kind(self):
        self.source_rows.insert(0,['copy.log','symlink',hashlib.sha256(b'package.json').hexdigest()])
        source=self.proof['sourceQualification'];source['sourceEntryCount']=2
        source['inventoryDigest']='sha256:'+hashlib.sha256(json.dumps(self.source_rows,separators=(',',':')).encode()).hexdigest()
        self.proof['inputMaterialCount']=2;self.bind()
        self.candidate.append(dict(path='vendor/dsh/copy.log',type='symlink',mode=0o777,target='package.json'))
        self.candidate.sort(key=lambda r:r['path']);self.rejected()

    def test_build_shape_unknown_fields_bool_counts_and_client_source_mismatch_reject(self):
        saved=copy.deepcopy(self.proof)
        for kind in ('extra','bool','source','limit','host'):
            self.proof=copy.deepcopy(saved)
            if kind=='extra':self.proof['untrustedExtra']=True
            elif kind=='bool':self.proof['inputMaterialCount']=True
            elif kind=='source':self.proof['clientQualification']['sourceQualification']=dict(self.proof['sourceQualification'],baseline='f'*40)
            elif kind=='limit':self.proof['limitations']=[]
            else:self.proof['nodeHost']['version']='not-a-version'
            self.rejected()

    def test_policy_uses_directory_ancestors_and_preserves_portable_dependency_policy(self):
        for path in ('node_modules/dep/index.js','.git/config','.cache/x.js','.dsh-build/private/extra.json','packages/g/p/lib/types/index.js.map','a/__pycache__/x.py','a.log'):
            self.assertFalse(self.api.runtime_file_included(path),path)
        for path in ('packages/g/p/lib/types/index.js','apps/cli/lib/bin.js','.dsh-build/client-build-environment.json'):
            self.assertTrue(self.api.runtime_file_included(path),path)
        policy=importlib.import_module('工具.lib.package_policy')
        self.assertFalse(policy.should_skip('services/platform','node_modules/pg/index.js'))
        self.assertTrue(policy.should_skip('vendor/dsh','node_modules/pg/index.js'))


if __name__=='__main__':unittest.main()
