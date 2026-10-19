import hashlib
import json
from pathlib import Path
import unittest

from distribution.tests import test_runtime_source as source_fixtures


class PackageProvenanceTests(unittest.TestCase):
    setUp = source_fixtures.SourceInventoryTests.setUp
    git = source_fixtures.SourceInventoryTests.git

    def qualify(self):
        from 工具.lib.package_provenance import qualify_runtime_source
        return qualify_runtime_source(self.source, self.objects, self.manifest_path)

    def prepare(self):
        self.manifest_path = Path(self.temp.name) / 'trusted-manifest.json'
        self.manifest_path.write_text(json.dumps(self.manifest))

    def test_success_binds_exact_manifest_and_full_source_without_qualifying_builds(self):
        self.prepare(); result = self.qualify()
        self.assertTrue(result['valid']); self.assertFalse(result['releaseApproved'])
        self.assertEqual(result['validationScope'], 'FIXED_DECLARED_SOURCE')
        self.assertEqual(result['baseline'], self.base)
        self.assertEqual(result['overlayManifestSha256'], 'sha256:' + hashlib.sha256(self.manifest_path.read_bytes()).hexdigest())
        expected = source_fixtures.runtime_source.qualify_source(self.source,self.objects,self.manifest)
        self.assertEqual(result['inventoryDigest'], expected['inventoryDigest']); self.assertEqual(result['sourceEntryCount'], 7)
        self.assertEqual(result['limitations'], ['source-executable-bits','dependencies','build-outputs','client-receipt','catalog-consumption','release-acceptance'])

    def test_source_failure_never_exposes_partial_qualification(self):
        self.prepare(); (self.source / 'src/base.js').write_bytes(b'tampered upstream')
        result = self.qualify(); self.assertFalse(result['valid'])
        self.assertNotIn('inventoryDigest',result); self.assertNotIn('sourceEntryCount',result)
        self.assertFalse(result['releaseApproved']); self.assertEqual(result['code'],'FIXED_SOURCE_REJECTED')

    def test_opt_in_source_rows_are_complete_digest_bound_and_absent_on_failure(self):
        from 工具.lib.package_provenance import qualify_runtime_source
        self.prepare()
        result = qualify_runtime_source(self.source,self.objects,self.manifest_path,include_source_rows=True)
        rows = result['sourceRows']; self.assertEqual(len(rows),result['sourceEntryCount'])
        digest = hashlib.sha256(json.dumps(rows,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()
        self.assertEqual('sha256:' + digest,result['inventoryDigest'])
        (self.source / 'src/base.js').write_bytes(b'changed')
        failed = qualify_runtime_source(self.source,self.objects,self.manifest_path,include_source_rows=True)
        self.assertFalse(failed['valid']); self.assertNotIn('sourceRows',failed); self.assertNotIn('inventoryDigest',failed)

    def test_build_outputs_are_listed_as_unqualified_and_not_hashed_as_source(self):
        self.prepare(); output = self.source / 'lib/generated.js'; output.parent.mkdir(); output.write_bytes(b'unqualified build')
        first = self.qualify(); self.assertTrue(first['valid']); self.assertIn('lib',first['excludedUnqualified'])
        output.write_bytes(b'another unqualified build')
        second = self.qualify(); self.assertEqual(first,second)

    def test_missing_ambiguous_or_linked_manifest_and_missing_objects_fail_closed(self):
        self.prepare(); original = self.manifest_path.read_bytes()
        for body in (b'[]', b'{"count":0,"count":1}', b'[' * 10000 + b'0' + b']' * 10000):
            with self.subTest(bodySize=len(body)):
                self.manifest_path.write_bytes(body)
                result = self.qualify(); self.assertFalse(result['valid']); self.assertNotIn('inventoryDigest',result)
        self.manifest_path.write_bytes(original)
        real = self.manifest_path.with_name('real-manifest'); self.manifest_path.rename(real); self.manifest_path.symlink_to(real)
        self.assertFalse(self.qualify()['valid'])
        self.manifest_path.unlink(); self.manifest_path.write_bytes(original)
        self.objects = Path(self.temp.name) / 'absent-objects'
        self.assertFalse(self.qualify()['valid'])

    def test_explicit_roots_are_required_even_when_a_relative_directory_exists(self):
        self.prepare(); self.source = Path('vendor/dsh')
        self.assertFalse(self.qualify()['valid'])

    def test_manifest_change_during_source_validation_does_not_publish_a_proof(self):
        from unittest.mock import patch
        from 工具.lib import package_provenance
        self.prepare(); original = package_provenance.qualify_source
        def modify(*args):
            result = original(*args); self.manifest_path.write_bytes(self.manifest_path.read_bytes() + b'\n'); return result
        with patch.object(package_provenance,'qualify_source',side_effect=modify):
            result = self.qualify()
        self.assertFalse(result['valid']); self.assertEqual(result['code'],'FIXED_SOURCE_INPUT_CHANGED')
        self.assertNotIn('inventoryDigest',result)

    def test_oversized_manifest_is_never_read_without_a_bound(self):
        import builtins
        import contextlib
        import os
        from unittest.mock import patch
        from 工具.lib.package_inventory import MAX_MANIFEST_BYTES
        from 工具.lib import package_provenance
        original = builtins.open; case = self
        class Reader:
            def __init__(self, handle): self.handle = handle
            def __enter__(self): self.handle.__enter__(); return self
            def __exit__(self,*args): return self.handle.__exit__(*args)
            def fileno(self): return self.handle.fileno()
            def read(self, size=-1):
                case.assertGreaterEqual(size,0,'manifest must not allocate its unbounded file size')
                case.assertLessEqual(size,MAX_MANIFEST_BYTES + 1)
                return self.handle.read(size)
        def guarded(path,*args,**kwargs):
            handle = original(path,*args,**kwargs)
            return Reader(handle) if Path(path) == self.manifest_path else handle
        original_qualify = package_provenance.qualify_source
        def grow(*args):
            result = original_qualify(*args); os.truncate(self.manifest_path,MAX_MANIFEST_BYTES * 8); return result
        for phase in ('first','second'):
            with self.subTest(phase=phase):
                self.prepare()
                if phase == 'first': os.truncate(self.manifest_path,MAX_MANIFEST_BYTES * 8)
                context = patch.object(package_provenance,'qualify_source',side_effect=grow) if phase == 'second' else contextlib.nullcontext()
                with context, patch('builtins.open',side_effect=guarded): result = self.qualify()
                self.assertFalse(result['valid']); self.assertNotIn('inventoryDigest',result)


if __name__ == '__main__':
    unittest.main()
