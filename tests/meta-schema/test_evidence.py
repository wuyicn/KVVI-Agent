"""Fault tests for evidence trust: no validator outputs are manufactured as real runs."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import test_conformance as harness
ROOT = Path(__file__).resolve().parents[2]


class EvidenceFaultTests(unittest.TestCase):
    def test_toolchain_collects_all_locked_actual_dependencies(self):
        actual = self.evidence.toolchain()['dependencies']
        self.assertEqual(set(actual), {'attrs', 'jsonschema', 'jsonschema-specifications',
            'referencing', 'rpds-py', 'typing-extensions', 'ajv', 'ajv-formats',
            'fast-deep-equal', 'fast-uri', 'json-schema-traverse', 'require-from-string'})
        self.assertTrue(all(type(v) is str and v.strip() for v in actual.values()))

    def test_toolchain_dependency_shape_and_source_locked_versions_are_strict(self):
        self.assertTrue(hasattr(self.evidence, 'verify_toolchain'), 'dependency verifier is missing')
        chain = self.evidence.toolchain()
        self.evidence.verify_toolchain(ROOT, chain)
        for name in chain['dependencies']:
            changed = dict(chain['dependencies'], **{name: '0.0.0-FIX3-PROBE'})
            with self.subTest(package=name), self.assertRaisesRegex(ValueError, 'dependency version'):
                self.evidence.verify_toolchain(ROOT, dict(chain, dependencies=changed))
        for dependencies in ({}, [], None, dict(chain['dependencies'], extra='1'),
                             {k: v for k, v in chain['dependencies'].items() if k != 'typing-extensions'}):
            with self.subTest(dependencies=dependencies), self.assertRaises(ValueError):
                self.evidence.verify_toolchain(ROOT, dict(chain, dependencies=dependencies))
        for value in ('', ' ', None, 1, True, [], {}):
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.evidence.verify_toolchain(ROOT, dict(chain, dependencies=dict(chain['dependencies'], ajv=value)))

    def test_toolchain_uses_source_lock_versions_not_current_installations(self):
        # Independent miniature source locks: no installation or validator involved.
        with tempfile.TemporaryDirectory(prefix='kvvi-fix3-locks-') as directory:
            root = Path(directory)
            py = root / 'tools/meta-schema/python/requirements.lock'
            node = root / 'tools/meta-schema/node/package-lock.json'
            py.parent.mkdir(parents=True); node.parent.mkdir(parents=True)
            py.write_text('jsonschema==1.2.3\n', encoding='utf-8')
            node.write_text(json.dumps({'packages': {'': {}, 'node_modules/ajv': {'version': '4.5.6'}}}), encoding='utf-8')
            chain = dict(python='historical-python', node='historical-node', npm='historical-npm',
                         pip='historical-pip', platform='historical-platform',
                         dependencies={'jsonschema': '1.2.3', 'ajv': '4.5.6'})
            self.evidence.verify_toolchain(root, chain)
            for name, wrong in (('jsonschema', '1.2.4'), ('ajv', '4.5.7')):
                with self.subTest(package=name), self.assertRaisesRegex(ValueError, 'dependency version'):
                    self.evidence.verify_toolchain(root, dict(chain, dependencies=dict(chain['dependencies'], **{name: wrong})))

    def test_collector_rejects_actual_dependency_version_drift(self):
        # Only the external installed-version lookup is doubled; collection and
        # verification stay real. Do not mutate the user's installed packages.
        import importlib.metadata as metadata
        installed_version = metadata.version
        with patch.object(metadata, 'version', side_effect=lambda name:
                          '0.0.0-FIX3-PROBE' if name == 'jsonschema' else installed_version(name)):
            with self.assertRaisesRegex(ValueError, 'dependency version'):
                self.evidence.toolchain()

    def test_full_report_rejects_version_tampering_even_with_recomputed_checksum(self):
        # Verify a real immutable historical run with the current verifier. Only
        # copies in this test-owned directory are mutated; no evidence is forged.
        name = 'evidence/meta-schema/0a-core-r1/20260910T055717167600Z-6281e5d2afe1'
        original = ROOT / name
        with tempfile.TemporaryDirectory(prefix='kvvi-fix3-report-') as directory:
            root = Path(directory)
            def git(*args):
                return subprocess.run(['git', '-C', str(root), *args], check=True, capture_output=True, timeout=30)
            git('init', '--quiet')
            git('fetch', '--quiet', '--no-tags', str(original / 'source.bundle'), 'HEAD')
            git('checkout', '--quiet', '--detach', 'FETCH_HEAD')
            run = root / name; run.mkdir(parents=True)
            for filename in ('report.json', 'report.sha256', 'source.bundle'):
                shutil.copyfile(original / filename, run / filename)
            self.evidence.verify_report(root, name)
            clean = json.loads((run / 'report.json').read_text())
            for package in ('jsonschema', 'ajv'):
                candidate = copy.deepcopy(clean)
                candidate['toolchain']['dependencies'][package] = '0.0.0-FIX3-PROBE'
                raw = (json.dumps(candidate, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
                (run / 'report.json').write_bytes(raw)
                (run / 'report.sha256').write_text(hashlib.sha256(raw).hexdigest() + '\n', encoding='utf-8')
                with self.subTest(package=package), self.assertRaisesRegex(ValueError, 'dependency version'):
                    self.evidence.verify_report(root, name)

    def setUp(self):
        source = ROOT / 'tools/meta-schema/record_evidence.py'
        self.assertTrue(source.is_file(), 'source-bound evidence verifier is missing')
        spec = importlib.util.spec_from_file_location('task5_evidence', source)
        self.evidence = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.evidence)

    def sample(self):
        case = copy.deepcopy(harness.load_cases()[0])
        # Controlled comparator input, never saved as runtime evidence.
        payload = dict(suite_revision='0a-core-r1', entry='compiled-draft', checks='structure', stage='structure', input_sha256=harness.file_hash(harness.CASE_ROOT / case['input']), validation=dict(valid=True, errors=[]), release_approved=False)
        outcome = dict(exit_code=0, payload=payload, stdout=json.dumps(payload), stderr='', elapsed_seconds=0.1)
        results = [dict(id=case['id'], outcomes={name: copy.deepcopy(outcome) for name in ('python','node')})]
        inventory = {case['id']: self.evidence.case_digest(case)}
        return [case], results, inventory

    def test_case_result_and_language_inventory_faults_fail(self):
        cases, results, inventory = self.sample()
        self.evidence.verify_results(cases, results, inventory)
        for fault in ('wrong-expected','duplicate-case','missing-case','missing-language','exit-one','numeric-valid','numeric-release','wrong-stage','self-passed','duplicate-stdout','missing-both-case-result'):
            c, r = copy.deepcopy(cases), copy.deepcopy(results)
            if fault == 'wrong-expected': c[0]['expected']['valid'] = False
            elif fault == 'duplicate-case': r.append(copy.deepcopy(r[0]))
            elif fault == 'missing-case': r.clear()
            elif fault == 'missing-language': r[0]['outcomes'].pop('node')
            elif fault == 'exit-one': r[0]['outcomes']['python']['exit_code'] = 1
            elif fault == 'numeric-valid':
                for item in r[0]['outcomes'].values(): item['payload']['validation']['valid'] = 1
            elif fault == 'numeric-release': r[0]['outcomes']['python']['payload']['release_approved'] = 0
            elif fault == 'wrong-stage': r[0]['outcomes']['python']['payload']['stage'] = 'complete'
            elif fault == 'self-passed': r[0].update(passed=True, outcomes={})
            elif fault == 'duplicate-stdout': r[0]['outcomes']['python']['stdout'] = '{"validation":{},"validation":{}}'
            elif fault == 'missing-both-case-result': c.clear(); r.clear()
            with self.subTest(fault=fault), self.assertRaises(ValueError):
                self.evidence.verify_results(c, r, inventory)

    def test_bindings_reject_each_changed_class_and_stale_source(self):
        with tempfile.TemporaryDirectory(prefix='kvvi-task5-source-') as directory:
            root = Path(directory)
            paths = ['tools/meta-schema/python/cli.py','tools/meta-schema/python/requirements.lock','contracts/meta-schemas/0a-core-r1/common.schema.json','contracts/meta-schemas/0a-core-r1/manifest.json','tests/meta-schema/0a-core-r1/cases.json','tests/meta-schema/0a-core-r1/inputs/owned.json','tests/meta-schema/0a-core-r1/contexts/owned.json','tests/meta-schema/expected-inventory.json','tests/meta-schema/coverage.json','tests/meta-schema/generate_owned.py','docs/PRD-AI无代码平台设计-v1.11.md','docs/superpowers/specs/2026-09-08-0a-meta-schema-core-design.md','docs/superpowers/specs/2026-09-08-0a-meta-schema-core-traceability.md']
            for name in paths:
                path = root / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_text('{}')
            def git(*args): return subprocess.check_output(['git', '-C', str(root), *args], stderr=subprocess.DEVNULL).decode().strip()
            git('init'); git('config','user.email','fixture@example.invalid'); git('config','user.name','Fixture'); git('add','.'); git('commit','-m','owned test source')
            commit = git('rev-parse','HEAD')
            bindings = self.evidence.source_bindings(root, commit)
            self.evidence.verify_bindings(root, commit, bindings)
            for name in paths:
                path = root / name; path.write_text('{"changed":true}')
                with self.subTest(path=name), self.assertRaises(ValueError): self.evidence.verify_bindings(root, commit, bindings)
                path.write_text('{}')
            with self.assertRaises(ValueError): self.evidence.verify_bindings(root, '0'*40, bindings)
            for name in ('../owned.json', str(root / 'owned.json')):
                with self.subTest(path=name), self.assertRaises(ValueError): self.evidence.verify_bindings(root, commit, {name:'0'*64})
            source = root / paths[0]; source.unlink(); outside = root / 'owned.txt'; outside.write_text('{}'); source.symlink_to(outside)
            with self.assertRaises(ValueError): self.evidence.verify_bindings(root, commit, bindings)

    def test_run_refuses_overwrite_and_escape(self):
        with tempfile.TemporaryDirectory(prefix='kvvi-task5-runs-') as directory:
            root = Path(directory)
            run = self.evidence.create_run(root, 'owned-run')
            marker = run / 'report.json'; marker.write_text('historical bytes')
            for name in ('owned-run','../owned-run','/owned-run'):
                with self.subTest(name=name), self.assertRaises(ValueError): self.evidence.create_run(root, name)
            self.assertEqual(marker.read_text(), 'historical bytes')

    def test_missing_required_group_is_not_pass(self):
        cases, _, _ = self.sample()
        with self.assertRaises(ValueError): self.evidence.verify_coverage(cases, {}, [])

    def test_shared_harness_rejects_removed_case_and_group_oracle(self):
        cases, _, inventory = self.sample()
        original=harness.CASE_ROOT
        with tempfile.TemporaryDirectory(prefix='kvvi-task5-inventory-') as directory:
            root=Path(directory);suite=root/'0a-core-r1';suite.mkdir()
            (root/'expected-inventory.json').write_text(json.dumps({'cases':[{'id':name,'sha256':sha} for name,sha in inventory.items()]}))
            path=suite/'cases.json';path.write_text(json.dumps({'cases':cases}))
            try:
                harness.CASE_ROOT=suite
                self.assertEqual(len(harness.load_cases()),1)
                path.write_text(json.dumps({'cases':[]}))
                with self.assertRaises(ValueError):harness.load_cases()
                cases[0]['groups']=[];path.write_text(json.dumps({'cases':cases}))
                with self.assertRaises(ValueError):harness.load_cases()
            finally:harness.CASE_ROOT=original

    def test_partial_or_tampered_report_is_rejected_before_binding_reads(self):
        with tempfile.TemporaryDirectory(prefix='kvvi-task5-report-') as directory:
            root=Path(directory);name='evidence/meta-schema/0a-core-r1/owned-run';run=root/name;run.mkdir(parents=True)
            (run/'report.json').write_text('{}')
            with self.assertRaises(ValueError):self.evidence.verify_report(root,name)
            (run/'report.sha256').write_text('0'*64)
            (run/'source.bundle').write_bytes(b'owned placeholder')
            with self.assertRaisesRegex(ValueError,'checksum'):self.evidence.verify_report(root,name)
            (run/'report.json').unlink();owned=root/'owned.json';owned.write_text('{}');(run/'report.json').symlink_to(owned)
            with self.assertRaises(ValueError):self.evidence.verify_report(root,name)

    def test_archive_survives_squash_but_rejects_corruption_and_wrong_tip(self):
        self.assertTrue(hasattr(self.evidence,'archive_repo'), 'self-contained source bundle verification is missing')
        with tempfile.TemporaryDirectory(prefix='kvvi-task5-archive-') as directory:
            root=Path(directory)
            def repository(name,message):
                repo=root/name;repo.mkdir();path=repo/'tools/meta-schema/python/cli.py';path.parent.mkdir(parents=True);path.write_text('owned source')
                def git(*args):return subprocess.check_output(['git','-C',str(repo),*args],stderr=subprocess.DEVNULL).decode().strip()
                git('init');git('config','user.email','fixture@example.invalid');git('config','user.name','Fixture');git('add','.');git('commit','-m',message)
                return repo,git('rev-parse','HEAD')
            original,commit=repository('original','source before evidence')
            current,squash=repository('squashed','independent squash checkout')
            self.assertNotEqual(commit,squash)
            self.assertNotEqual(subprocess.run(['git','-C',str(current),'cat-file','-e',commit],capture_output=True).returncode,0)
            archive=root/'source.bundle'
            self.evidence.create_source_archive(original,archive,commit)
            sha=self.evidence.digest(archive.read_bytes())
            bindings=self.evidence.source_bindings(original,commit)
            with self.evidence.archive_repo(archive,sha,commit) as bare:
                self.evidence.verify_bindings(current,commit,bindings,object_root=bare)
                (current/'tools/meta-schema/python/cli.py').write_text('mutated source')
                with self.assertRaises(ValueError):self.evidence.verify_bindings(current,commit,bindings,object_root=bare)
            with self.assertRaises(ValueError):
                with self.evidence.archive_repo(archive,sha,squash):pass
            archive.write_bytes(archive.read_bytes()[:-8])
            with self.assertRaises(ValueError):
                with self.evidence.archive_repo(archive,sha,commit):pass
            with self.assertRaises(ValueError):
                with self.evidence.archive_repo(archive,self.evidence.digest(archive.read_bytes()),commit):pass
            archive.unlink()
            with self.assertRaises(ValueError):
                with self.evidence.archive_repo(archive,sha,commit):pass

    def test_record_inventory_duplicate_id_path_extra_and_wrong_hash_fail(self):
        cases,results,inventory=self.sample()
        rows=[{'id':name,'sha256':sha} for name,sha in inventory.items()]
        with self.assertRaises(ValueError):harness.inventory_map(rows+rows)
        for bad in ([], rows+[{'id':'extra','sha256':'0'*64}], [{'id':rows[0]['id'],'sha256':'0'*64}]):
            with self.assertRaises(ValueError):self.evidence.verify_results(cases,results,harness.inventory_map(bad))
        with tempfile.TemporaryDirectory(prefix='kvvi-task5-duplicate-path-') as directory:
            root=Path(directory);name='evidence/meta-schema/0a-core-r1/owned-run';run=root/name;run.mkdir(parents=True)
            report={'suite_revision':'0a-core-r1','release_approved':False,'source_commit':'0'*40,'source_archive':{'path':'source.bundle','sha256':'0'*64},'bindings':[{'path':'tools/meta-schema/python/cli.py','sha256':'0'*64}]*2}
            raw=json.dumps(report).encode();(run/'report.json').write_bytes(raw);(run/'report.sha256').write_text(self.evidence.digest(raw));(run/'source.bundle').write_bytes(b'owned placeholder')
            with self.assertRaisesRegex(ValueError,'duplicate source binding'):self.evidence.verify_report(root,name)


if __name__ == '__main__': unittest.main()
