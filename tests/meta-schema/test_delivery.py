"""Task 5: real loader and evidence boundary faults, only in owned temp files."""
import copy
import json
from pathlib import Path
import subprocess
import sys
import unittest

import test_bundle as bundle_tests
from test_bundle import refresh_manifest_digest, entry_errors, SUITE, ROOT
import test_conformance as harness

REVIEW_INVALID_DEFINITIONS = (
    {'type': 'string', 'pattern': '['},
    {'$ref': 'urn:kvvi:meta-schema:0a-core-r1:common#/$defs/AssetRef#ignored'},
    {'type': 'object', '$defs': {'Hidden': {'type': 'string', 'pattern': '['}}},
)


class ActualLoaderFaultTests(unittest.TestCase):
    mutate_bundle = bundle_tests.BundleIntegrityTests.mutate_bundle

    def test_trusted_registry_actual_parsers_reject_unused_invalid_definitions(self):
        from final_fix_fixtures import registry_definition_case
        sys.path.insert(0, str(ROOT / 'tools/meta-schema/python'))
        from context import parse_context, RegistryConfigurationInvalid
        contexts = []
        for slot in ('inputSchema', 'outputSchema', 'errorSchema', 'propsSchema'):
            for definition, valid in (({'type': 'string', 'pattern': '^[a-z]+$'}, True),
                                      ({'type': 'string', 'pattern': '['}, False),
                                      ({'$ref': 'urn:kvvi:meta-schema:0a-core-r1:common#/$defs/AssetRef#ignored'}, False)):
                _, context = registry_definition_case(slot, definition)
                raw = json.dumps(context).encode()
                with self.subTest(slot=slot, valid=valid, language='python'):
                    if valid:
                        self.assertEqual(parse_context(raw), context)
                    else:
                        with self.assertRaises(RegistryConfigurationInvalid):
                            parse_context(raw)
                contexts.append({'context': context, 'valid': valid})
        source = """
          import {readFileSync} from 'node:fs';
          import {parseContext,RegistryConfigurationInvalid} from './tools/meta-schema/node/context.mjs';
          import {bundleSession} from './tools/meta-schema/node/structure.mjs';
          const cases=JSON.parse(readFileSync(0,'utf8'));
          const outcomes=cases.map(({context})=>bundleSession(()=>{
            try {parseContext(Buffer.from(JSON.stringify(context)));return true;}
            catch(e){if(e instanceof RegistryConfigurationInvalid)return false;throw e;}
          }));
          process.stdout.write(JSON.stringify(outcomes));
        """
        result = subprocess.run(['node', '--input-type=module', '-e', source], cwd=ROOT,
                                input=json.dumps(contexts), text=True, capture_output=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), [c['valid'] for c in contexts])

    def test_real_clis_fail_execution_for_rebound_invalid_unused_bundle(self):
        import tempfile
        import shutil
        with tempfile.TemporaryDirectory(prefix='kvvi-task5-cli-') as directory:
            root=Path(directory)
            shutil.copytree(ROOT/'tools/meta-schema',root/'tools/meta-schema',ignore=shutil.ignore_patterns('node_modules','__pycache__'))
            (root/'tools/meta-schema/node/node_modules').symlink_to(ROOT/'tools/meta-schema/node/node_modules',target_is_directory=True)
            shutil.copytree(SUITE,root/'contracts/meta-schemas/0a-core-r1')
            shutil.copytree(ROOT/'protocol/kvvi-json-c14n/v1/evidence-sets/prd-v1.11',root/'protocol/kvvi-json-c14n/v1/evidence-sets/prd-v1.11')
            for name in ('docs/PRD-AI无代码平台设计-v1.11.md','docs/superpowers/specs/2026-09-08-0a-meta-schema-core-design.md'):
                destination=root/name;destination.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(ROOT/name,destination)
            bundle=root/'contracts/meta-schemas/0a-core-r1'
            path=bundle/'app-spec.v1alpha1.schema.json';schema=json.loads(path.read_text())
            raw=(ROOT/'tests/meta-schema/0a-core-r1/inputs/app-compiled-empty.json').read_bytes()
            for mutation in ({'kvviMagic':True}, *REVIEW_INVALID_DEFINITIONS):
                schema['$defs']['UnusedInvalid']=mutation
                path.write_text(json.dumps(schema));refresh_manifest_digest(bundle,path.name)
                for command in ([sys.executable,str(root/'tools/meta-schema/python/cli.py')],['node',str(root/'tools/meta-schema/node/cli.mjs')]):
                    with self.subTest(mutation=mutation,language=command[0]):
                        result=subprocess.run([*command,'--contract','app-spec/v1alpha1','--entry','compiled-draft','--checks','structure'],input=raw,capture_output=True,timeout=15)
                        self.assertEqual(result.returncode,1,result.stdout)
                        self.assertEqual(json.loads(result.stdout)['execution']['code'],'EXECUTION_FAILED')
                        self.assertEqual(result.stderr,b'')
    def test_actual_loaders_reject_hash_rebound_unused_invalid_definitions(self):
        for mutation in ({'kvviMagic': True}, {'type': 'string', 'format': 'kvvi-unknown'}, {'$ref': 'urn:kvvi:missing'}, *REVIEW_INVALID_DEFINITIONS):
            def edit(bundle):
                path = bundle / 'app-spec.v1alpha1.schema.json'
                schema = json.loads(path.read_text())
                schema['$defs']['UnusedInvalid'] = mutation
                path.write_text(json.dumps(schema))
                refresh_manifest_digest(bundle, path.name)
            bundle = self.mutate_bundle(edit)
            value = json.loads((ROOT / 'tests/meta-schema/0a-core-r1/inputs/app-compiled-empty.json').read_text())
            for language in ('python', 'node'):
                with self.subTest(mutation=mutation, language=language):
                    with self.assertRaises(Exception):
                        entry_errors(language, 'app-spec/v1alpha1', 'compiled-draft', value, bundle)
            with self.subTest(mutation=mutation,language='preflight'):
                result=subprocess.run([sys.executable,str(bundle_tests.VERIFY),'--bundle',str(bundle)],capture_output=True,timeout=15)
                self.assertEqual(result.returncode,1,result.stdout)
                self.assertIs(json.loads(result.stdout)['valid'],False)
                self.assertEqual(result.stderr,b'')

    def test_unused_legal_definitions_and_full_pointer_controls_still_load(self):
        def edit(bundle):
            path=bundle/'app-spec.v1alpha1.schema.json';schema=json.loads(path.read_text())
            schema['$defs'].update({
                'UnusedLegal': {'type':'object','allOf':[{'properties':{'name':{'type':'string','pattern':'^[a-z]+$'}}}], '$defs':{'Nested':{'type':'string','pattern':'^[a-z]+$'}}},
                'UnusedFalse': False,
                'Review/Name~': {'type':'string'},
                'UnusedPointer': {'$ref':'#/$defs/Review~1Name~0'},
                'UnusedExternal': {'$ref':'urn:kvvi:meta-schema:0a-core-r1:common#/$defs/AssetRef'},
            })
            path.write_text(json.dumps(schema));refresh_manifest_digest(bundle,path.name)
        bundle=self.mutate_bundle(edit)
        value=json.loads((ROOT/'tests/meta-schema/0a-core-r1/inputs/app-compiled-empty.json').read_text())
        for language in ('python','node'):
            with self.subTest(language=language):self.assertEqual(entry_errors(language,'app-spec/v1alpha1','compiled-draft',value,bundle),[])
        result=subprocess.run([sys.executable,str(bundle_tests.VERIFY),'--bundle',str(bundle)],capture_output=True,timeout=15)
        self.assertEqual(result.returncode,0,result.stdout)
        self.assertIs(json.loads(result.stdout)['valid'],True)
        self.assertEqual(result.stderr,b'')

    def test_actual_loaders_reject_manifest_source_dialect_json_and_path_faults(self):
        def mutations(bundle, fault):
            path = bundle / 'manifest.json'
            manifest = json.loads(path.read_text())
            if fault == 'dialect': manifest['schema_dialect'] = 'urn:wrong'
            elif fault == 'source': manifest['baseline']['sha256'] = '0' * 64
            elif fault == 'source-path': manifest['baseline']['path'] = '../owned-source'
            elif fault == 'resources-list': manifest['resources'] = []
            elif fault == 'path': manifest['resources']['../owned.json'] = manifest['resources'].pop('common.schema.json')
            elif fault == 'symlink':
                resource = bundle / 'common.schema.json'
                owned = bundle.parent / 'owned.json'
                resource.rename(owned)
                resource.symlink_to(owned)
            path.write_text(json.dumps(manifest))
            if fault == 'duplicate': path.write_text(path.read_text().replace('"suite_revision":', '"suite_revision":"ignored","suite_revision":', 1))
            if fault == 'nonfinite': path.write_text(path.read_text().replace('"suite_revision":', '"nonfinite":NaN,"suite_revision":', 1))
        for fault in ('dialect', 'source', 'source-path', 'resources-list', 'path', 'symlink', 'duplicate', 'nonfinite'):
            bundle = self.mutate_bundle(lambda b: mutations(b, fault))
            value = json.loads((ROOT / 'tests/meta-schema/0a-core-r1/inputs/app-compiled-empty.json').read_text())
            for language in ('python', 'node'):
                with self.subTest(fault=fault, language=language):
                    with self.assertRaises(Exception):
                        entry_errors(language, 'app-spec/v1alpha1', 'compiled-draft', value, bundle)


class TypedHarnessTests(unittest.TestCase):
    def test_numeric_boolean_cannot_satisfy_literal_oracle(self):
        case = harness.load_cases()[0]
        outcomes = harness.run_case(case)
        self.assertTrue(harness.case_matches_expected(case, outcomes))
        for language in ('python', 'node'):
            tampered = copy.deepcopy(outcomes)
            tampered[language]['payload']['validation']['valid'] = int(case['expected']['valid'])
            self.assertFalse(harness.case_matches_expected(case, tampered))
        tampered = copy.deepcopy(outcomes)
        for outcome in tampered.values(): outcome['payload']['validation']['valid'] = 1
        self.assertFalse(harness.case_matches_expected(case, tampered))

    def test_duplicate_or_nonfinite_stdout_is_runner_failure(self):
        case = harness.load_cases()[0]
        for output in ('{"validation":{},"validation":{}}', '{"value":NaN}', '{"value":1e999}', '{} garbage'):
            command = [sys.executable, '-c', 'print(' + repr(output) + ')']
            with self.subTest(output=output):
                with self.assertRaises(harness.RunnerFailure):
                    harness.run_case(case, {'python': command, 'node': command})

    def test_mutated_context_file_is_runner_failure(self):
        import tempfile
        original=harness.CASE_ROOT
        with tempfile.TemporaryDirectory(prefix='kvvi-task5-harness-') as directory:
            root=Path(directory);(root/'inputs').mkdir();(root/'contexts').mkdir()
            (root/'inputs/owned.json').write_text('{}');context=root/'contexts/owned.json';context.write_text('{}')
            case=dict(id='owned',input='inputs/owned.json',context='contexts/owned.json',contract='app-spec/v1alpha1',entry='spec',checks='complete')
            command=[sys.executable,'-c','from pathlib import Path;Path('+repr(str(context))+').write_text("changed");print("{}")']
            try:
                harness.CASE_ROOT=root
                with self.assertRaisesRegex(harness.RunnerFailure,'context fixture'):
                    harness.run_case(case,{'python':command,'node':command})
            finally:harness.CASE_ROOT=original


class InvocationResourceTests(unittest.TestCase):
    def test_reused_annotation_probe_recomputes_each_instances_evaluated_keys(self):
        from integration_fixtures import composition
        from view_fixtures import asset_for
        _, context = composition()
        reference = asset_for(context, 'BUSINESS_SCHEMA')['ref']
        source = """
          import {readFileSync} from 'node:fs';
          import {bundleSession} from './tools/meta-schema/node/structure.mjs';
          import {declaredParameterRefs} from './tools/meta-schema/node/view_reference_declarations.mjs';
          const ref=JSON.parse(readFileSync(0,'utf8'));
          const target={$ref:'urn:kvvi:meta-schema:0a-core-r1:common#/$defs/AssetRef'};
          const root={type:'object',properties:{switch:{type:'boolean'}},
            if:{properties:{switch:{const:true}},required:['switch']},
            then:{properties:{note:{type:'string'}}},
            else:{properties:{label:{type:'string'}}},unevaluatedProperties:target};
          const values=[{switch:true,note:'ordinary',first:ref},
            {switch:false,label:'ordinary',second:ref},{switch:true,note:'ordinary',third:ref}];
          const result=bundleSession(()=>values.map(value=>[...declaredParameterRefs(root,value,'input')].map(([,path])=>path)));
          process.stdout.write(JSON.stringify(result));
        """
        result = subprocess.run(['node', '--input-type=module', '-e', source], cwd=ROOT,
                                input=json.dumps(reference), text=True, capture_output=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), [['input["first"]'], ['input["second"]'], ['input["third"]']])

    def test_projection_reuse_is_exact_schema_scoped_and_expires_with_invocation(self):
        from integration_fixtures import composition
        from view_fixtures import asset_for
        _, context = composition()
        reference = asset_for(context, 'BUSINESS_SCHEMA')['ref']
        source = """
          import {readFileSync} from 'node:fs';
          import {bundleSession} from './tools/meta-schema/node/structure.mjs';
          import {declaredParameterRefs} from './tools/meta-schema/node/view_reference_declarations.mjs';
          const ref=JSON.parse(readFileSync(0,'utf8'));
          const target={$ref:'urn:kvvi:meta-schema:0a-core-r1:common#/$defs/AssetRef'};
          const a={$id:'urn:fixture:same-name',type:'object',properties:{first:target}};
          const b={$id:'urn:fixture:same-name',type:'object',properties:{second:target}};
          const project=(schema,value)=>[...declaredParameterRefs(schema,value,'input')].map(([,p])=>p);
          const out=bundleSession(()=>[project(a,{first:ref}),project(b,{second:ref}),project(a,{first:ref})]);
          a.properties.first={type:'object'};
          out.push(bundleSession(()=>project(a,{first:ref})));
          a.properties.first={type:'object',properties:{bad:{type:'wrong-type'}}};
          try{bundleSession(()=>project(a,{first:ref}));out.push('accepted');}catch{out.push('rejected');}
          process.stdout.write(JSON.stringify(out));
        """
        result = subprocess.run(['node', '--input-type=module', '-e', source], cwd=ROOT,
                                input=json.dumps(reference), text=True, capture_output=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), [['input["first"]'], ['input["second"]'], ['input["first"]'], [], 'rejected'])

    def test_complete_500_action_nodes_within_existing_cli_timeout(self):
        from final_fix_fixtures import action_heavy_view
        from test_integration import run
        value, context = action_heavy_view()
        try:
            outcomes = run(value, context, contract='view-schema/lce-safe-v1', entry='spec')
        except subprocess.TimeoutExpired:
            self.fail('legal 500 action-node View exceeded the unchanged 15 second CLI budget')
        for exit_code, payload in outcomes:
            self.assertEqual(exit_code, 0, payload)
            self.assertEqual(payload['stage'], 'complete')

    def test_later_invocation_rechecks_changed_bundle_in_same_process(self):
        import tempfile
        import shutil
        sys.path.insert(0, str(ROOT / 'tools/meta-schema/python'))
        import structure
        with tempfile.TemporaryDirectory(prefix='kvvi-task5-fresh-') as directory:
            bundle = Path(directory) / 'bundle'
            shutil.copytree(SUITE, bundle)
            structure.load_bundle(bundle)
            with (bundle / 'common.schema.json').open('a') as stream: stream.write(' ')
            with self.assertRaises(structure.BundleLoadError): structure.load_bundle(bundle)
            shutil.copyfile(SUITE / 'common.schema.json', bundle / 'common.schema.json')
            module = (ROOT / 'tools/meta-schema/node/structure.mjs').as_uri()
            source = 'import {loadBundle,bundleSession} from ' + json.dumps(module) + ';import {appendFileSync} from "node:fs";bundleSession(()=>loadBundle(process.argv[1]));appendFileSync(process.argv[1]+"/common.schema.json"," ");try{bundleSession(()=>loadBundle(process.argv[1]));process.exitCode=9;}catch{process.stdout.write("rejected");}'
            result = subprocess.run(['node', '--input-type=module', '-e', source, str(bundle)], capture_output=True, timeout=15)
            self.assertEqual((result.returncode, result.stdout), (0, b'rejected'))

    def test_complete_500_nodes_within_existing_cli_timeout(self):
        import tempfile
        from view_fixtures import fixture_context, view, node
        from integration_fixtures import close_context
        context = fixture_context()
        spec = view(context)
        spec['componentsTree'][0]['children'] = [node(id='text_' + str(i)) for i in range(499)]
        spec, context = close_context(spec, context, 'VIEW_SCHEMA', 'spec')
        with tempfile.TemporaryDirectory(prefix='kvvi-task5-500-') as directory:
            path = Path(directory) / 'context.json'
            path.write_text(json.dumps(context))
            for language, command in harness.DEFAULT_RUNNERS.items():
                with self.subTest(language=language):
                    result = subprocess.run([*command, '--contract', 'view-schema/lce-safe-v1', '--entry', 'spec', '--checks', 'complete', '--context', str(path)], input=json.dumps(spec).encode(), capture_output=True, timeout=15)
                    self.assertEqual(result.returncode, 0, result.stdout)
                    self.assertEqual(json.loads(result.stdout)['stage'], 'complete')


if __name__ == '__main__':
    unittest.main()
