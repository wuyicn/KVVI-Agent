"""Owned synthetic tool executables; no actual dependency install or pilot."""
import importlib
import json
import os
from pathlib import Path
import platform
import sys
import tempfile
import unittest
from unittest.mock import patch

from distribution.tests.test_release_package import load_package, register_runtime_source


class CleanBuildTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='kbuild-',dir='/private/tmp' if sys.platform=='darwin' else '/tmp');self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.source=self.root/'input';self.source.mkdir()
        files={'package.json':json.dumps({'version':'0.1.6-alpha.2','packageManager':'pnpm@11.7.0','engines':{'node':'^22.19.0 || >=24.0.0'}}),
               'packages/g/p/package.json':'{}','packages/g/p/tsconfig.json':'{"compilerOptions":{"outDir":"lib/types"}}',
               'apps/web/vite.config.ts':'// owned source'}
        for path,body in files.items():
            target=self.source/path;target.parent.mkdir(parents=True,exist_ok=True);target.write_text(body)
        module=load_package();module.RUNTIME_SOURCE=str(self.source);register_runtime_source(module,self.root,with_client_receipt=False)
        self.objects=Path(module.GIT_OBJECTS);self.manifest=self.root/'forks/dsh/改造点指纹.json'
        self.workspace=self.root/'new-workspace';self.store=self.root/'store';self.store.mkdir()
        self.tools=self.root/'tools with spaces';self.tools.mkdir();self.node=self.tools/'node';self.pnpm=self.tools/'pnpm.cjs'
        self.pnpm.write_text('// synthetic entrypoint')
        self.mode=self.tools/'fixture-mode.json';self.mode.write_text('{}')
        body='''import os,sys,json,hashlib,platform,signal,time
from pathlib import Path
mode=json.loads((Path(__file__).parent/'fixture-mode.json').read_text())
if sys.argv[1]=='-p':
 print(json.dumps({'version':mode.get('nodeVersion','v24.20.0'),'platform':sys.platform,'arch':'arm64' if platform.machine() in ('arm64','aarch64') else 'x64'}));raise SystemExit(0)
args=sys.argv[2:]
if args==['--version']:print(mode.get('pnpmVersion','11.7.0'));raise SystemExit(0)
root=Path.cwd()
print(json.dumps({'argv':args,'env':dict(os.environ)}),flush=True)
if args[0]=='install':
 if (root/'apps/web/dist').exists() or (root/'node_modules').exists():raise SystemExit(81)
 if mode.get('installTimeout'):
  signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(60)
 if mode.get('installFail'):raise SystemExit(17)
 (root/'node_modules').mkdir();(root/'node_modules/owned.txt').write_text('fixture dependency')
 if mode.get('changeSource'):(root/'package.json').write_text('{}')
 if mode.get('changeShim'):
  shim=Path(os.environ['PATH'].split(os.pathsep)[0])/'pnpm';shim.write_text(shim.read_text()+'\\n# changed shim\\n')
else:
 if mode.get('buildFail'):raise SystemExit(19)
 files={'apps/web/dist/index.html':b'<html>new build</html>','packages/g/p/lib/client.js':b'client','packages/g/p/lib/host.js':b'host'}
 for name,body in files.items():
  target=root/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(body)
 paths=['apps/web/dist/index.html','packages/g/p/lib/client.js'];digest=hashlib.sha256()
 for path in sorted(paths,key=lambda p:p.encode('utf-16-be')):
  encoded=path.encode();body=(root/path).read_bytes();digest.update(str(len(encoded)).encode()+b':'+encoded+str(len(body)).encode()+b':'+body)
 receipt=root/'.dsh-build/client-build-environment.json';receipt.parent.mkdir()
 receipt.write_text(json.dumps({'formatVersion':1,'environment':{'DSH_CLIENT_COMMIT_HASH':os.environ['DSH_CLIENT_COMMIT_HASH'][:7],'DSH_CLIENT_VERSION':'0.1.6-alpha.2'},'artifacts':{'fileCount':2,'sha256':digest.hexdigest()}}))
 if mode.get('staleReceipt'):(root/'packages/g/p/lib/client.js').write_bytes(b'changed after receipt')
 if mode.get('changeTool'):Path(__file__).write_text(Path(__file__).read_text()+'\\n# changed tool\\n')
'''
        self.node.write_text('#!'+sys.executable+'\n'+body);self.node.chmod(0o755)
        self.api=importlib.import_module('工具.lib.package_clean_build')

    def run_build(self,**options):
        return self.api.run_clean_build(self.source,self.objects,self.manifest,self.workspace,
                    self.node,self.pnpm,self.store,**options)

    def set_mode(self,**mode):self.mode.write_text(json.dumps(mode))

    def rejected(self,**options):
        result=self.run_build(**options)
        self.assertFalse(result['valid']);self.assertFalse(result['releaseApproved'])
        self.assertNotIn('outputQualification',result)
        self.assertFalse((self.workspace/'metadata/build-receipt.json').exists())
        return result

    def test_success_binds_fresh_source_tools_commands_logs_and_complete_outputs(self):
        for name in ('node_modules/old.js','apps/web/dist/old.js'):
            path=self.source/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_text('old preserved')
        result=self.run_build();self.assertTrue(result['valid'],result);self.assertFalse(result['releaseApproved'])
        receipt=json.loads((self.workspace/'metadata/build-receipt.json').read_text())
        self.assertEqual(receipt['formatVersion'],'kvvi-owned-build/v1')
        self.assertEqual(receipt['inputMaterialCount'],4);self.assertEqual(receipt['outputQualification']['outputCount'],4)
        self.assertEqual(receipt['commands'][-2]['argv'],[str(self.node),str(self.pnpm),'install','--frozen-lockfile','--offline','--store-dir',str(self.store)])
        self.assertEqual(receipt['commands'][-1]['argv'],[str(self.node),str(self.pnpm),'run','build'])
        self.assertTrue(all(row['result']['valid'] and row['result']['cleanupConfirmed'] for row in receipt['commands']))
        self.assertEqual(len(json.loads((self.workspace/'metadata/output-rows.json').read_text())),4)
        self.assertEqual((self.source/'apps/web/dist/old.js').read_text(),'old preserved')
        self.assertNotIn('build-causality',receipt['limitations']);self.assertIn('toolchain-transitive-dependencies',receipt['limitations'])

    def test_environment_is_explicit_and_nested_pnpm_shim_uses_selected_absolute_tools(self):
        with patch.dict(os.environ,{'DO_NOT_INHERIT':'private-fixture','DSH_CLIENT_VERSION':'wrong','NODE_ENV':'wrong'}):
            result=self.run_build()
        self.assertTrue(result['valid'],result)
        record=json.loads((self.workspace/'logs/install.log').read_text())
        self.assertNotIn('DO_NOT_INHERIT',record['env']);self.assertNotIn('NODE_ENV',record['env'])
        self.assertEqual(record['env']['HOME'],str(self.workspace/'home'))
        self.assertEqual(record['env']['GIT_CEILING_DIRECTORIES'],str(self.workspace))
        self.assertEqual(record['env']['npm_config_userconfig'],os.devnull)
        shim=(self.workspace/'bin/pnpm').read_text();self.assertIn('exec ',shim);self.assertIn('"$@"',shim)
        self.assertNotIn('private-fixture',''.join(p.read_text() for p in (self.workspace/'logs').iterdir()))

    def test_existing_workspace_and_protected_target_are_not_mutated(self):
        self.workspace.mkdir();(self.workspace/'keep').write_text('keep');self.rejected()
        self.assertEqual((self.workspace/'keep').read_text(),'keep')
        for protected in (self.source,self.objects,self.store):
            self.workspace=protected/'forbidden';self.rejected();self.assertFalse(self.workspace.exists())

    def test_wrong_original_source_fails_without_running_tools(self):
        (self.source/'package.json').write_text('{}');self.rejected()
        self.assertFalse((self.workspace/'logs/node-version.log').exists())

    def test_install_failure_retains_logs_and_never_runs_build(self):
        self.set_mode(installFail=True);self.rejected()
        self.assertTrue((self.workspace/'logs/install.log').exists());self.assertFalse((self.workspace/'logs/build.log').exists())

    def test_failed_install_preserves_initial_tool_and_environment_observations(self):
        self.set_mode(installFail=True);self.rejected()
        record=json.loads((self.workspace/'metadata/build-input.json').read_text())
        self.assertEqual(record['tools']['node']['path'],str(self.node))
        self.assertEqual(record['environment']['HOME'],str(self.workspace/'home'))
        self.assertEqual(record['inputMaterialCount'],4)

    def test_build_failure_has_no_qualified_receipt(self):
        self.set_mode(buildFail=True);self.rejected();self.assertTrue((self.workspace/'logs/build.log').exists())

    def test_source_changed_during_install_prevents_build(self):
        self.set_mode(changeSource=True);self.rejected();self.assertFalse((self.workspace/'logs/build.log').exists())

    def test_stale_client_receipt_rejects_complete_output_qualification(self):
        self.set_mode(staleReceipt=True);self.rejected()

    def test_wrong_tool_versions_prevent_install(self):
        for mode in ({'nodeVersion':'v22.18.0'},{'pnpmVersion':'11.25.0'}):
            with self.subTest(mode=mode):
                self.workspace=self.root/('bad-version-'+str(len(list(self.root.iterdir()))));self.set_mode(**mode)
                self.rejected();self.assertFalse((self.workspace/'logs/install.log').exists())

    def test_tool_changed_during_build_cannot_receive_receipt(self):
        self.set_mode(changeTool=True);self.rejected()

    def test_symlink_tool_is_rejected_before_workspace_creation(self):
        linked=self.tools/'node-link';linked.symlink_to(self.node);self.node=linked
        self.rejected();self.assertFalse(self.workspace.exists())

    def test_timed_out_install_is_failed_with_preserved_log_and_no_build(self):
        self.set_mode(installTimeout=True);self.rejected(install_timeout=0.3)
        self.assertTrue((self.workspace/'logs/install.log').exists());self.assertFalse((self.workspace/'logs/build.log').exists())

    def test_command_success_without_confirmed_cleanup_is_rejected(self):
        with patch.object(self.api,'run_owned_command',return_value={'valid':True,'cleanupConfirmed':False,'exitCode':0}):
            self.rejected()
        self.assertFalse((self.workspace/'metadata/output-rows.json').exists())

    def test_output_change_after_first_qualification_prevents_receipt(self):
        original=self.api.qualify_output_inventory;seen=[]
        def changed(root,*args,**kwargs):
            result=original(root,*args,**kwargs)
            if result.get('valid') and not seen:
                seen.append(True);(Path(root)/'packages/g/p/lib/host.js').write_text('late changed output')
            return result
        with patch.object(self.api,'qualify_output_inventory',side_effect=changed):self.rejected()
        self.assertTrue(seen)

    def test_external_material_table_mutation_is_not_bound_as_if_correct(self):
        original=self.api._write
        def changed(path,value):
            original(path,value)
            if path.name=='source-material.json':path.write_text('[]')
        with patch.object(self.api,'_write',side_effect=changed):self.rejected()

    def test_completed_install_log_change_cannot_receive_receipt(self):
        original=self.api.qualify_output_inventory
        def changed(root,*args,**kwargs):
            result=original(root,*args,**kwargs)
            (self.workspace/'logs/install.log').write_text('changed completed log')
            return result
        with patch.object(self.api,'qualify_output_inventory',side_effect=changed):self.rejected()

    def test_failed_receipt_write_never_leaves_published_success_file(self):
        original=self.api._write
        def failed(path,value):
            if path.name in ('build-receipt.json','build-receipt.candidate.json'):
                path.write_text('{"valid":true,');raise OSError('owned partial write')
            return original(path,value)
        with patch.object(self.api,'_write',side_effect=failed):self.rejected()

    def test_modified_nested_pnpm_shim_prevents_build(self):
        self.set_mode(changeShim=True);self.rejected();self.assertFalse((self.workspace/'logs/build.log').exists())

    def test_receipt_snapshot_failure_never_leaves_published_success_file(self):
        original=self.api._row
        def failed(path,label,*args,**kwargs):
            if label=='metadata/build-receipt.json':raise OSError('owned receipt snapshot failed')
            return original(path,label,*args,**kwargs)
        with patch.object(self.api,'_row',side_effect=failed):self.rejected()

    def test_interrupt_after_receipt_write_leaves_only_unpublished_candidate(self):
        original=self.api._write
        def interrupted(path,value):
            original(path,value)
            if path.name in ('build-receipt.json','build-receipt.candidate.json'):raise KeyboardInterrupt()
        with patch.object(self.api,'_write',side_effect=interrupted):
            with self.assertRaises(KeyboardInterrupt):self.run_build()
        self.assertFalse((self.workspace/'metadata/build-receipt.json').exists())

    def test_temporary_policy_read_cannot_override_fixed_package_manager(self):
        package=self.source/'package.json';data=json.loads(package.read_text());data['packageManager']='pnpm@11.25.0';package.write_text(json.dumps(data))
        module=load_package();module.RUNTIME_SOURCE=str(self.source);register_runtime_source(module,self.root,with_client_receipt=False)
        saved=package.read_bytes();original=self.api._row;seen=[]
        def replaced(path,label,*args,**kwargs):
            if Path(path)==self.workspace/'source/package.json' and label=='package.json':
                seen.append(True);staged=Path(path);body=staged.read_bytes();temporary=json.loads(body);temporary['packageManager']='pnpm@11.7.0'
                staged.write_text(json.dumps(temporary))
                try:return original(path,label,*args,**kwargs)
                finally:staged.write_bytes(body)
            return original(path,label,*args,**kwargs)
        with patch.object(self.api,'_row',side_effect=replaced):self.rejected()
        self.assertTrue(seen);self.assertEqual(package.read_bytes(),saved)

    def test_non_mapping_engine_policy_is_fixed_failure(self):
        package=self.source/'package.json';data=json.loads(package.read_text());data['engines']=[];package.write_text(json.dumps(data))
        module=load_package();module.RUNTIME_SOURCE=str(self.source);register_runtime_source(module,self.root,with_client_receipt=False)
        self.rejected();self.assertFalse((self.workspace/'metadata/interrupted.json').exists())

    def test_large_probe_log_is_bounded_before_any_snapshot_allocation(self):
        seen=[];original=self.api.snapshot
        def command(argv,cwd,env,log,timeout):
            with Path(log).open('wb') as handle:handle.truncate(32*1024*1024)
            return {'valid':True,'cleanupConfirmed':True,'exitCode':0,'timedOut':False}
        def bounded(path,label,max_bytes=None):
            if label.startswith('logs/'):
                seen.append(max_bytes);self.assertIsNotNone(max_bytes,'unbounded allocation before log limit')
            return original(path,label,max_bytes=max_bytes)
        with patch.object(self.api,'run_owned_command',side_effect=command),patch.object(self.api,'snapshot',side_effect=bounded):self.rejected()
        self.assertTrue(seen)

    def test_long_temporary_socket_path_is_rejected_before_workspace_creation(self):
        self.workspace=self.root/('long-workspace-'+'x'*100)
        result=self.rejected();self.assertEqual(result['phase'],'SOCKET_PATH_LENGTH')
        self.assertFalse(self.workspace.exists())


if __name__=='__main__':unittest.main()
