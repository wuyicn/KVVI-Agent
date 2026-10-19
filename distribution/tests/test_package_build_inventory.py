"""Complete current declared outputs; fixtures never run a build or a pilot."""
import importlib
import json
import os
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

from distribution.tests import test_package_client as client_fixture


class BuildInventoryTests(unittest.TestCase):
    write_record = client_fixture.PackageClientTests.write_record

    def setUp(self):
        client_fixture.PackageClientTests.setUp(self)
        self.build_api = importlib.import_module('工具.lib.package_build_inventory')
        for relative,body in [('packages/g/p/lib/index.js',b'host code'),('packages/g/p/lib/types/index.d.ts',b'types'),
                              ('packages/g/p/lib/types/index.js.map',b'{}'),('tsconfig.host.tsbuildinfo',b'incremental')]:
            path=self.source/relative;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(body)

    def qualify(self,**kwargs):
        return self.build_api.qualify_output_inventory(self.source,self.objects,self.manifest,**kwargs)

    def rejected(self):
        result=self.qualify(include_output_rows=True)
        self.assertFalse(result['valid']);self.assertFalse(result['releaseApproved'])
        self.assertNotIn('outputRows',result);self.assertNotIn('outputDigest',result)
        self.assertNotIn('sourceQualification',result);self.assertNotIn('clientQualification',result)

    def test_all_declared_outputs_include_types_maps_metadata_and_client_receipt(self):
        result=self.qualify(include_output_rows=True)
        self.assertTrue(result['valid']);self.assertFalse(result['releaseApproved'])
        self.assertEqual(result['outputCount'],9)
        self.assertEqual(result['categoryCounts'],{'client-receipt-patterns':4,'native-declared-binary':0,'build-metadata':2,'other-declared-output':3})
        paths={row['path'] for row in result['outputRows']}
        self.assertIn('packages/g/p/lib/types/index.d.ts',paths)
        self.assertIn('packages/g/p/lib/types/index.js.map',paths)
        self.assertIn('.dsh-build/client-build-environment.json',paths)
        self.assertNotIn('outputRows',self.qualify());self.assertIn('build-causality',result['limitations'])

    def test_dependency_contents_never_enter_output_inventory(self):
        before=self.qualify()
        path=self.source/'node_modules/dependency/lib/index.js';path.parent.mkdir(parents=True);path.write_bytes(b'dependency')
        after=self.qualify(include_output_rows=True)
        self.assertTrue(after['valid']);self.assertEqual(after['outputDigest'],before['outputDigest'])
        self.assertFalse(any('node_modules' in row['path'].split('/') for row in after['outputRows']))

    def test_output_mode_changes_change_inventory_without_claiming_build_history(self):
        before=self.qualify();(self.source/'packages/g/p/lib/index.js').chmod(0o755)
        after=self.qualify();self.assertTrue(after['valid']);self.assertNotEqual(after['outputDigest'],before['outputDigest'])
        self.assertFalse(after['releaseApproved'])

    def test_internal_host_link_and_special_file_are_rejected(self):
        outside=self.root/'outside-host';outside.write_bytes(b'outside')
        path=self.source/'packages/g/p/lib/types/link.js';path.symlink_to(outside);self.rejected();path.unlink()
        if hasattr(os,'mkfifo'):
            os.mkfifo(path)
            try:self.rejected()
            finally:path.unlink()
        self.assertEqual(outside.read_bytes(),b'outside')

    def test_unreadable_output_directory_fails_instead_of_silently_omitting_it(self):
        if os.geteuid()==0:self.skipTest('requires non-root permission enforcement')
        path=self.source/'packages/g/p/lib/unreadable';path.mkdir();(path/'hidden.js').write_bytes(b'host')
        path.chmod(0)
        try:self.rejected()
        finally:path.chmod(0o755)

    def test_host_output_change_addition_or_deletion_during_scan_rejects(self):
        original=self.build_api.snapshot;target=self.source/'packages/g/p/lib/index.js';saved=target.read_bytes()
        for kind in ('body','add','delete'):
            with self.subTest(kind=kind):
                target.write_bytes(saved);extra=target.parent/'new.js';extra.unlink(missing_ok=True);triggered=[]
                def change(absolute,relative,*args,**kwargs):
                    result=original(absolute,relative,*args,**kwargs)
                    if relative=='packages/g/p/lib/index.js' and not triggered:
                        triggered.append(True)
                        if kind=='body':target.write_bytes(b'changed host')
                        elif kind=='add':extra.write_bytes(b'late host')
                        else:target.unlink()
                    return result
                with patch.object(self.build_api,'snapshot',side_effect=change):self.rejected()
                self.assertTrue(triggered)

    def test_source_or_client_receipt_mismatch_yields_no_output_qualification(self):
        path=self.source/'package.json';saved=path.read_bytes();path.write_bytes(b'{}');self.rejected();path.write_bytes(saved)
        (self.source/'apps/web/dist/index.html').write_bytes(b'stale client');self.rejected()

    def test_nested_dependency_or_git_namespace_inside_output_is_rejected(self):
        for relative in ('packages/g/p/lib/node_modules/dependency/index.js','packages/g/p/lib/.git/config',
                         'apps/web/dist/node_modules/included.js'):
            with self.subTest(relative=relative):
                path=self.source/relative;path.parent.mkdir(parents=True);path.write_bytes(b'unsupported nested namespace')
                if relative.startswith('apps/web/dist/'):
                    # A matching upstream receipt is insufficient to qualify
                    # dependency-named output namespaces in this stricter scope.
                    paths=['apps/web/dist/index.html','apps/web/dist/assets/app.js','packages/g/p/lib/client.js','packages/g/p/lib/client.ABC.js.map',relative]
                    self.write_record(paths)
                try:self.rejected()
                finally:
                    path.unlink()
                    parent=path.parent
                    while parent not in (self.source/'packages/g/p/lib',self.source/'apps/web/dist'):
                        parent.rmdir();parent=parent.parent
                    self.write_record()

    def test_source_or_new_boundary_change_during_second_scan_is_rejected(self):
        original=self.build_api.snapshot;package=self.source/'package.json';saved=package.read_bytes()
        for kind in ('source','new-boundary'):
            with self.subTest(kind=kind):
                calls=[]
                def change(absolute,relative,*args,**kwargs):
                    result=original(absolute,relative,*args,**kwargs)
                    if relative=='packages/g/p/lib/index.js':
                        calls.append(True)
                        if len(calls)==2:
                            if kind=='source':package.write_bytes(b'{"version":"9.9.9"}')
                            else:(self.source/'tsconfig.client.tsbuildinfo').write_bytes(b'new output boundary')
                    return result
                try:
                    with patch.object(self.build_api,'snapshot',side_effect=change):self.rejected()
                    self.assertEqual(len(calls),2)
                finally:
                    package.write_bytes(saved);(self.source/'tsconfig.client.tsbuildinfo').unlink(missing_ok=True)

    def test_reserved_namespace_case_aliases_are_rejected(self):
        for name in ('Node_Modules','.GIT'):
            with self.subTest(name=name):
                path=self.source/'packages/g/p/lib'/name;path.mkdir();(path/'probe.js').write_bytes(b'namespace alias')
                canonical=path.with_name(name.lower())
                if canonical.is_dir():self.assertEqual(canonical.stat().st_ino,path.stat().st_ino)
                try:self.rejected()
                finally:(path/'probe.js').unlink();path.rmdir()

    def test_native_output_is_covered_only_when_declared_by_fixed_source(self):
        relative='native/system/packages/darwin-arm64/prebuilds.json'
        body=json.dumps({'binaries':[{'path':'bin/system.node'}]}).encode()
        for root in (self.source,self.objects):
            path=root/relative;path.parent.mkdir(parents=True);path.write_bytes(body)
        environment={**os.environ,'GIT_CONFIG_GLOBAL':os.devnull,'GIT_CONFIG_SYSTEM':os.devnull}
        def git(*args):
            return subprocess.run(['git','-C',str(self.objects),*args],env=environment,check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True).stdout.strip()
        git('add',relative);git('-c','user.name=Output Fixture','-c','user.email=output@example.invalid','-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false','commit','--quiet','-m','owned native declaration')
        self.commit=git('rev-parse','HEAD');manifest=json.loads(self.manifest.read_text());manifest['upstream_merge_base']=self.commit;manifest['fork_head']=self.commit
        self.manifest.write_text(json.dumps(manifest));self.write_record()
        binary=self.source/'native/system/packages/darwin-arm64/bin/system.node';binary.parent.mkdir();binary.write_bytes(b'owned native fixture')
        result=self.qualify(include_output_rows=True)
        self.assertTrue(result['valid']);self.assertEqual(result['categoryCounts']['native-declared-binary'],1)
        self.assertIn(binary.relative_to(self.source).as_posix(),[row['path'] for row in result['outputRows']])


if __name__=='__main__':unittest.main()
