"""Owned source/receipt fixtures; no real build, package, model, or pilot changes."""
import hashlib
import importlib
import json
import os
import subprocess
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from distribution.tests.test_release_package import load_package, register_runtime_source


class PackageClientTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='kvvi-client-record-'); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name); self.source = self.root / 'runtime'; self.source.mkdir()
        (self.source / 'package.json').write_text('{"version":"0.1.6-alpha.2"}')
        (self.source / 'packages/g/p').mkdir(parents=True)
        (self.source / 'packages/AGENTS.md').write_text('source documentation')
        (self.source / 'packages/CLAUDE.md').symlink_to('AGENTS.md')
        (self.source / 'packages/g/p/package.json').write_text('{}')
        (self.source / 'packages/g/p/tsconfig.json').write_text('{"compilerOptions":{"outDir":"lib/types"}}')
        (self.source / 'apps/web').mkdir(parents=True)
        (self.source / 'apps/web/vite.config.ts').write_text('// fixed source')
        module = load_package(); module.RUNTIME_SOURCE = str(self.source)
        register_runtime_source(module,self.root); self.objects = Path(module.GIT_OBJECTS)
        self.manifest = self.root / 'forks/dsh/改造点指纹.json'
        data = json.loads(self.manifest.read_text()); self.commit = data['upstream_merge_base']
        data['fork_head'] = self.commit; self.manifest.write_text(json.dumps(data))
        for path, body in [('apps/web/dist/index.html',b'<html>fixture</html>'),('apps/web/dist/assets/app.js',b'web code'),
                           ('packages/g/p/lib/client.js',b'client code'),('packages/g/p/lib/client.ABC.js.map',b'{}')]:
            item = self.source / path; item.parent.mkdir(parents=True,exist_ok=True); item.write_bytes(body)
        self.record = self.source / '.dsh-build/client-build-environment.json'; self.record.parent.mkdir()
        self.write_record()
        self.api = importlib.import_module('工具.lib.package_client')

    def write_record(self, paths=None):
        # Independent upstream framing; enumerate the four fixture files directly.
        paths = paths or ['apps/web/dist/index.html','apps/web/dist/assets/app.js','packages/g/p/lib/client.js','packages/g/p/lib/client.ABC.js.map']
        digest = hashlib.sha256()
        for path in sorted(paths,key=lambda value:value.encode('utf-16-be')):
            content = (self.source / path).read_bytes(); encoded = path.encode()
            digest.update(str(len(encoded)).encode()+b':'+encoded+str(len(content)).encode()+b':'+content)
        self.payload = {'formatVersion':1,'environment':{'DSH_CLIENT_COMMIT_HASH':self.commit[:7],'DSH_CLIENT_VERSION':'0.1.6-alpha.2'},
                        'artifacts':{'fileCount':len(paths),'sha256':digest.hexdigest()}}
        self.record.write_text(json.dumps(self.payload))

    def qualify(self, **kwargs):
        return self.api.qualify_client_outputs(self.source,self.objects,self.manifest,**kwargs)

    def rejected(self):
        result = self.qualify(include_artifact_rows=True)
        self.assertFalse(result['valid']); self.assertFalse(result['releaseApproved'])
        self.assertNotIn('clientRows',result); self.assertNotIn('artifactDigest',result)
        self.assertNotIn('sourceQualification',result)

    def test_current_complete_receipt_binds_fixed_environment_and_all_four_artifacts(self):
        result = self.qualify(include_artifact_rows=True)
        self.assertTrue(result['valid']); self.assertFalse(result['releaseApproved'])
        self.assertEqual(result['validationScope'],'FIXED_SOURCE_CLIENT_RECEIPT')
        self.assertEqual(result['artifactDigest'],'sha256:'+self.payload['artifacts']['sha256'])
        self.assertEqual(result['artifactCount'],4)
        self.assertEqual(len(result['clientRows']),4)
        self.assertEqual(result['receipt']['path'],'.dsh-build/client-build-environment.json')
        self.assertIn('build-causality',result['limitations'])
        self.assertNotIn('clientRows',self.qualify())


    def test_hidden_paths_are_excluded_by_upstream_glob_semantics(self):
        for path in ('apps/web/dist/.DS_Store','apps/web/dist/.cache/hidden.js',
                     'packages/.hidden/p/lib/client.js','packages/g/.hidden/lib/client.js'):
            target = self.source / path; target.parent.mkdir(parents=True,exist_ok=True); target.write_bytes(b'hidden output')
        # Direct pattern collector comparison is independent of the source gate,
        # which correctly rejects newly invented hidden package source roots.
        rows,digest = self.api.artifact_snapshots(self.source)
        self.assertEqual(len(rows),4); self.assertEqual(digest,self.payload['artifacts']['sha256'])

    def test_glob_corner_cases_and_utf16_sort_match_independent_upstream_framing(self):
        paths = ['apps/web/dist/index.html','apps/web/dist/assets/app.js','packages/g/p/lib/client.js','packages/g/p/lib/client.ABC.js.map']
        for path in ('apps/web/dist/😀.js','apps/web/dist/\ue000.js',
                     'apps/web/dist/node_modules/included.js','packages/g/p/lib/client..js'):
            target = self.source / path; target.parent.mkdir(parents=True,exist_ok=True); target.write_bytes(path.encode())
            paths.append(path)
        self.write_record(paths)
        result = self.qualify(include_artifact_rows=True)
        self.assertTrue(result['valid']); self.assertEqual(result['artifactCount'],8)
        self.assertEqual(result['artifactDigest'],'sha256:'+self.payload['artifacts']['sha256'])

    def test_missing_changed_and_additional_artifacts_reject_stale_receipt(self):
        target = self.source / 'packages/g/p/lib/client.js'; saved = target.read_bytes()
        target.unlink(); self.rejected(); target.write_bytes(saved+b'changed'); self.rejected(); target.write_bytes(saved)
        extra = self.source / 'packages/g/p/lib/client.extra.js'; extra.write_bytes(b'new chunk'); self.rejected()

    def test_unrelated_host_output_is_not_covered_or_approved(self):
        host = self.source / 'packages/g/p/lib/index.js'; host.write_bytes(b'host output')
        result = self.qualify(include_artifact_rows=True)
        self.assertTrue(result['valid']); self.assertEqual(result['artifactCount'],4)
        self.assertIn('host-native-outputs',result['limitations'])
        self.assertNotIn('packages/g/p/lib/index.js',[row['path'] for row in result['clientRows']])

    def test_missing_wrong_commit_version_or_extra_public_value_reject_without_echo(self):
        for name,value in [('DSH_CLIENT_COMMIT_HASH','0'*7),('DSH_CLIENT_VERSION','2.0.0'),('DSH_CLIENT_UNEXPECTED','sensitive-fixture')]:
            with self.subTest(name=name):
                record = json.loads(json.dumps(self.payload)); record['environment'][name]=value
                self.record.write_text(json.dumps(record)); self.rejected()
                self.assertNotIn('sensitive-fixture',json.dumps(self.qualify()))
        record = json.loads(json.dumps(self.payload)); del record['environment']['DSH_CLIENT_COMMIT_HASH']
        self.record.write_text(json.dumps(record)); self.rejected()

    def test_record_shape_duplicate_boolean_count_bad_digest_and_deep_json_reject(self):
        saved = self.record.read_bytes()
        for body in [b'{"formatVersion":1,"formatVersion":1}',b'['*10000+b'0'+b']'*10000,
                     json.dumps(dict(self.payload,formatVersion=True)).encode(),
                     json.dumps(dict(self.payload,artifacts={'fileCount':True,'sha256':'0'*64})).encode(),
                     json.dumps(dict(self.payload,artifacts={'fileCount':4,'sha256':'not-a-digest'})).encode()]:
            with self.subTest(body=body[:60]): self.record.write_bytes(body); self.rejected()
        self.record.write_bytes(saved); self.record.unlink(); self.rejected()

    def test_record_and_artifact_links_are_rejected_without_following(self):
        saved = self.record.read_bytes(); outside = self.root / 'outside-record'; outside.write_bytes(saved)
        self.record.unlink(); self.record.symlink_to(outside); self.rejected(); self.record.unlink(); self.record.write_bytes(saved)
        path = self.source / 'packages/g/p/lib/client.js'; original = path.read_bytes(); path.unlink()
        outside_artifact = self.root / 'outside-client'; outside_artifact.write_bytes(original)
        path.symlink_to(outside_artifact); self.rejected()
        self.assertEqual(outside_artifact.read_bytes(),original)

    def test_output_directory_links_are_rejected_without_scanning_outside(self):
        directory = self.source / 'packages/g/p/lib'; saved = self.root / 'external-lib'; directory.rename(saved)
        directory.symlink_to(saved,target_is_directory=True); self.rejected()
        self.assertTrue((saved / 'client.js').is_file())

    def test_changed_fixed_source_never_yields_partial_client_qualification(self):
        (self.source / 'package.json').write_text('{"version":"2.0.0"}')
        self.rejected()

    def test_record_change_during_artifact_snapshot_rejects(self):
        original = self.api.snapshot; triggered = []
        def change(absolute,relative,*args,**kwargs):
            result = original(absolute,relative,*args,**kwargs)
            if relative == 'packages/g/p/lib/client.js' and not triggered:
                triggered.append(True); self.record.write_bytes(self.record.read_bytes()+b' ')
            return result
        with patch.object(self.api,'snapshot',side_effect=change): self.rejected()
        self.assertTrue(triggered)

    def test_matching_artifact_set_change_during_snapshot_rejects(self):
        original = self.api.snapshot; triggered = []
        def change(absolute,relative,*args,**kwargs):
            result = original(absolute,relative,*args,**kwargs)
            if relative == 'packages/g/p/lib/client.js' and not triggered:
                triggered.append(True); (self.source / 'packages/g/p/lib/client.new.js').write_bytes(b'late chunk')
            return result
        with patch.object(self.api,'snapshot',side_effect=change): self.rejected()
        self.assertTrue(triggered)

    def test_temporary_package_metadata_must_match_the_fixed_source_table(self):
        original = self.api.snapshot; target = self.source / 'package.json'; body = target.read_bytes(); triggered = []
        def change(absolute,relative,*args,**kwargs):
            if Path(absolute) != target: return original(absolute,relative,*args,**kwargs)
            target.write_text('{"version":"9.9.9"}')
            try:
                triggered.append(True); return original(absolute,relative,*args,**kwargs)
            finally: target.write_bytes(body)
        with patch.object(self.api,'snapshot',side_effect=change): self.rejected()
        self.assertTrue(triggered); self.assertEqual(target.read_bytes(),body)

    def test_source_change_after_artifact_scan_rejects(self):
        original = self.api.snapshot; triggered = []
        def change(absolute,relative,*args,**kwargs):
            result = original(absolute,relative,*args,**kwargs)
            if relative == 'packages/g/p/lib/client.js' and not triggered:
                triggered.append(True); (self.source / 'package.json').write_text('{"version":"2.0.0"}')
            return result
        with patch.object(self.api,'snapshot',side_effect=change): self.rejected()
        self.assertTrue(triggered)

    def test_unicode_digits_in_fixed_package_version_are_rejected(self):
        body = json.dumps({'version':'١.٢.٣'}).encode()
        (self.source / 'package.json').write_bytes(body); (self.objects / 'package.json').write_bytes(body)
        env = {**os.environ,'GIT_CONFIG_GLOBAL':os.devnull,'GIT_CONFIG_SYSTEM':os.devnull}
        def git(*args):
            return subprocess.run(['git','-C',str(self.objects),*args],env=env,check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True).stdout.strip()
        git('add','package.json')
        git('-c','user.name=Client Fixture','-c','user.email=client@example.invalid','-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false','commit','--quiet','-m','owned version fixture')
        self.commit = git('rev-parse','HEAD')
        manifest = json.loads(self.manifest.read_text()); manifest['upstream_merge_base']=self.commit; manifest['fork_head']=self.commit
        self.manifest.write_text(json.dumps(manifest)); self.write_record()
        record = json.loads(self.record.read_text()); record['environment']['DSH_CLIENT_VERSION']='١.٢.٣'
        self.record.write_text(json.dumps(record)); self.rejected()

    def test_web_root_and_two_package_directory_links_reject(self):
        for relative in ('apps/web/dist','packages/g/p','packages/g'):
            with self.subTest(relative=relative):
                path = self.source / relative; saved = self.root / 'outside-directory'
                path.rename(saved); path.symlink_to(saved,target_is_directory=True)
                try: self.rejected()
                finally: path.unlink(); saved.rename(path)

    def test_receipt_read_is_bounded_before_allocating_large_body(self):
        with self.record.open('wb') as handle: handle.truncate(128*1024*1024)
        self.rejected()


if __name__ == '__main__': unittest.main()
