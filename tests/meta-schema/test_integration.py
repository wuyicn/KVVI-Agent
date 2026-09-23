"""Black-box Task4 tests: independently authored literal outcomes."""
import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from integration_fixtures import composition, snapshot, registered, current, grant, capability_parameter_case, ordinary_capability_data_case, schema_declared_parameter_case
from view_fixtures import asset_for, ref, digest
from integration_fixtures import nested_parameter_shape_case, app_with_view_dependency

ROOT = Path(__file__).resolve().parents[2]


def run(value, ctx, contract='app-spec/v1alpha1', entry='compiled-draft', checks='complete'):
    outcomes = []
    with tempfile.TemporaryDirectory() as folder:
        path = Path(folder) / 'context.json'
        if ctx is not None: path.write_bytes(ctx if isinstance(ctx, bytes) else json.dumps(ctx).encode())
        for command in [[sys.executable, str(ROOT / 'tools/meta-schema/python/cli.py')],
                        ['node', str(ROOT / 'tools/meta-schema/node/cli.mjs')]]:
            args = ['--contract', contract, '--entry', entry, '--checks', checks]
            if ctx is not None: args += ['--context', str(path)]
            proc = subprocess.run(command + args, input=json.dumps(value).encode(), capture_output=True, timeout=15)
            if proc.stderr: raise AssertionError(proc.stderr)
            outcomes.append((proc.returncode, json.loads(proc.stdout)))
    return outcomes


class Integration(unittest.TestCase):
    def test_unused_registry_definitions_are_checked_at_every_schema_boundary(self):
        from final_fix_fixtures import registry_definition_case
        definitions = [
            ({'type': 'string', 'pattern': '^[a-z]+$'}, True),
            ({'type': 'object', 'allOf': [{'properties': {'name': {'type': 'string'}}}]}, True),
            ({'$ref': 'urn:kvvi:meta-schema:0a-core-r1:common#/$defs/AssetRef'}, True),
            ({'$defs': {'Review/Name~': {'type': 'string'}},
              '$ref': '#/$defs/UnusedFinal/$defs/Review~1Name~0'}, True),
            (False, True),
            ({'type': 'string', 'pattern': '['}, False),
            ({'$ref': 'urn:kvvi:meta-schema:0a-core-r1:common#/$defs/AssetRef#ignored'}, False),
            ({'$defs': {'Nested': {'type': 'string', 'pattern': '['}}}, False),
        ]
        for slot in ('inputSchema', 'outputSchema', 'errorSchema', 'propsSchema'):
            for definition, valid in definitions:
                value, ctx = registry_definition_case(slot, definition)
                self.assertTrue(all(digest(a['content']) == a['ref']['digest'] for a in ctx['fake_assets']))
                for language, (exit_code, payload) in zip(('python', 'node'), run(value, ctx)):
                    with self.subTest(slot=slot, definition=definition, language=language):
                        self.assertEqual(exit_code, 0 if valid else 1, payload)
                        if valid:
                            self.assertIs(payload['validation']['valid'], True)
                            self.assertEqual(payload['stage'], 'complete')
                        else:
                            self.assertEqual(payload['execution']['code'], 'REGISTRY_CONFIGURATION_INVALID')

    def test_existing_view_requires_exact_deleted_id_history(self):
        from final_fix_fixtures import view_history_case
        for mode, expected, stage in (
            ('missing', [('REFERENCE_INVALID', 'base_version')], 'references'),
            ('other-view', [('REFERENCE_INVALID', 'base_version')], 'references'),
            ('wrong-digest', [('REFERENCE_INVALID', 'spec.view_code')], 'references'),
            ('empty', [], 'complete'),
            ('new', [], 'complete'),
            ('deleted', [('VIEW_NODE_ID_DUPLICATE', 'spec.componentsTree[0].children[0].id')], 'semantic'),
        ):
            with self.subTest(mode=mode):
                self.assert_case(*view_history_case(mode), expected, stage, contract='view-schema/lce-safe-v1')
        value, ctx = view_history_case('missing')
        ctx['current']['active_version'] = 2  # Unconsumed active version at Spec entry.
        self.assert_case(value['spec'], ctx, contract='view-schema/lce-safe-v1', entry='spec')
        old = next(s['registered'] for s in ctx['snapshots'] if s['ref']['asset_type'] == 'VIEW_SCHEMA')
        self.assert_case(old, ctx, contract='view-schema/lce-safe-v1', entry='registered')

    def assert_case(self, value, ctx, expected=(), stage='complete', **args):
        for exit_code, payload in run(value, ctx, **args):
            self.assertEqual(exit_code, 2 if expected else 0, payload)
            self.assertEqual([(e['code'], e['path']) for e in payload['validation']['errors']], list(expected))
            self.assertEqual(payload['stage'], stage)
            self.assertFalse(payload['release_approved'])

    def test_complete_real_three_contract_composition(self):
        self.assert_case(*composition())

    def test_missing_validator_fails_complete_but_structure_accepts(self):
        for kind, slot in [('PERMISSION', 'permissionRefs'), ('WORKFLOW', 'workflowRefs')]:
            value, ctx = composition()
            value['spec'][slot] = [ref(kind, 'fake_missing', {}, False)]
            self.assert_case(value, ctx, checks='structure', stage='structure')
            self.assert_case(value, ctx, [('DEPENDENCY_VALIDATOR_UNAVAILABLE', 'spec.' + slot + '[0]')], 'references')

    def test_exact_reference_identity_digest_and_scope(self):
        for key, replacement, code in [('asset_id', 'missing', 'REFERENCE_NOT_FOUND'),
                                      ('module_id', 'other', 'REFERENCE_NOT_FOUND'),
                                      ('version', 99, 'REFERENCE_NOT_FOUND'),
                                      ('digest', 'sha256:' + '0' * 64, 'REFERENCE_DIGEST_MISMATCH'),
                                      ('scope_id', 'another-tenant', 'REFERENCE_OUT_OF_SCOPE'),
                                      ('app_id', 'other-app', 'REFERENCE_OUT_OF_SCOPE')]:
            value, ctx = composition()
            value['spec']['businessSchemaRefs'][0][key] = replacement
            # Avoid a simultaneous App membership failure by omitting Views.
            value['spec']['viewRefs'] = []; value['spec']['navigation'] = []
            with self.subTest(key=key):
                self.assert_case(value, ctx, [(code, 'spec.businessSchemaRefs[0]')], 'references')

    def test_corrupt_context_is_execution_not_protocol_rejection(self):
        value, ctx = composition()
        for raw in [b'{"fixture":true,"fixture":true}', b'{"fixture":NaN}', b'\xff', b'{}',
                    json.dumps(dict(ctx, unknown=True)).encode(),
                    json.dumps(dict(ctx, fake_assets=ctx['fake_assets'] + [ctx['fake_assets'][0]])).encode()]:
            for exit_code, payload in run(value, raw):
                self.assertEqual(exit_code, 1, payload)
                self.assertEqual(payload['execution']['code'], 'CONTEXT_INVALID')

    def test_context_required(self):
        self.assert_case(composition()[0], None, [('TRUSTED_CONTEXT_REQUIRED', 'spec')], 'semantic')

    def test_navigation_and_composition_members_are_exact(self):
        value, ctx = composition()
        value['spec']['navigation'][0]['viewRef']['version'] = 2
        self.assert_case(value, ctx, [('APPSPEC_INVALID', 'spec.navigation[0].viewRef')], 'semantic')
        value, ctx = composition(); value['spec']['businessSchemaRefs'] = []
        self.assert_case(value, ctx, [('APPSPEC_INVALID', 'spec.viewRefs[0]')], 'references')
        value, ctx = composition(); value['spec']['navigation'].append(copy.deepcopy(value['spec']['navigation'][0]))
        self.assert_case(value, ctx, [('APPSPEC_INVALID', 'spec.navigation[1].path'), ('APPSPEC_INVALID', 'spec.navigation[1].route_code')], 'semantic')

    def test_draft_current_base_and_registered_historical_base(self):
        value, ctx = composition(); ctx['current']['active_version'] = 2
        self.assert_case(value, ctx, [('BASE_VERSION_CONFLICT', 'base_version')], 'references')
        ar = ref('APP_SPEC', 'internal_ops', value['spec'], False)
        old = snapshot(ctx, ar, value['spec'], lifecycle='SUPERSEDED')['registered']
        self.assert_case(old, ctx, entry='registered')
        for key, replacement in [('base_version', 1), ('version', 3), ('app_id', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd')]:
            altered = copy.deepcopy(old); altered[key] = replacement
            self.assert_case(altered, ctx, [('REFERENCE_INVALID', key)], 'references', entry='registered')
        altered = copy.deepcopy(old); altered['audit']['trace_id'] = 'forged'
        self.assert_case(altered, ctx, [('REFERENCE_INVALID', 'audit')], 'references', entry='registered')
        altered = copy.deepcopy(old); altered['checksum'] = 'sha256:' + '0' * 64
        self.assert_case(altered, ctx, [('CONTRACT_CHECKSUM_MISMATCH', 'checksum')], 'references', entry='registered')

    def test_hashed_invalid_dependency_is_protocol_rejection(self):
        value, ctx = composition()
        bs = asset_for(ctx, 'BUSINESS_SCHEMA'); bs['content']['fields'][0]['required'] = True
        bs['content']['fields'][0]['nullable'] = True
        bs['ref']['digest'] = digest(bs['content'])
        ctx['snapshots'] = [s for s in ctx['snapshots'] if s['ref']['asset_type'] != 'BUSINESS_SCHEMA']
        snapshot(ctx, bs['ref'], bs['content'])
        value['spec']['businessSchemaRefs'] = [copy.deepcopy(bs['ref'])]
        value['spec']['viewRefs'] = []; value['spec']['navigation'] = []
        self.assert_case(value, ctx, [('CONSTRAINT_INCOMPATIBLE', 'spec.businessSchemaRefs[0].spec.fields[0].nullable')], 'references')

    def test_cross_app_requires_both_exact_grants_and_declared_purpose(self):
        value, ctx = composition()
        bs=asset_for(ctx,'BUSINESS_SCHEMA')
        bs['ref']['app_id']='other-app'
        del bs['content']['record_number'];bs['ref']['digest']=digest(bs['content'])
        ctx['snapshots']=[s for s in ctx['snapshots'] if s['ref']['asset_type']!='BUSINESS_SCHEMA']
        snapshot(ctx,bs['ref'],bs['content'])
        value['spec']['businessSchemaRefs']=[copy.deepcopy(bs['ref'])]
        value['spec']['viewRefs']=[];value['spec']['navigation']=[]
        ctx['grants']=[grant(ctx,bs['ref'],'source'),grant(ctx,bs['ref'],'target')]
        self.assert_case(value,ctx)
        for side in ['source','target']:
            changed=copy.deepcopy(ctx);changed['grants']=[g for g in changed['grants'] if g['side']!=side]
            self.assert_case(value,changed,[('REFERENCE_OUT_OF_SCOPE','spec.businessSchemaRefs[0]')],'references')
        changed=copy.deepcopy(ctx);changed['current']['purpose']=''
        self.assert_case(value,changed,[('REFERENCE_OUT_OF_SCOPE','spec.businessSchemaRefs[0]')],'references')
        changed=copy.deepcopy(ctx);changed['grants'][0]['target']['version']=2
        self.assert_case(value,changed,[('REFERENCE_OUT_OF_SCOPE','spec.businessSchemaRefs[0]')],'references')

    def test_valid_template_source_and_platform_registries(self):
        value,ctx=composition(); bs=asset_for(ctx,'BUSINESS_SCHEMA')
        template=copy.deepcopy(bs);template['ref']['scope_type']='TEMPLATE';template['ref']['scope_id']='template-library'
        template['ref']['app_id']=None;template['ref']['module_id']=None
        del template['content']['record_number'];template['ref']['digest']=digest(template['content'])
        ctx['fake_assets'].append(template)
        snapshot(ctx,template['ref'],template['content'],stable_id='dddddddd-dddd-4ddd-8ddd-dddddddddddd')
        ctx['snapshots'][0]['registered']['source_ref']=copy.deepcopy(template['ref'])
        self.assert_case(value,ctx)

    def test_pinned_older_business_is_valid_after_new_compatible_version(self):
        value,ctx=composition(); bs=asset_for(ctx,'BUSINESS_SCHEMA')
        ctx['snapshots'][0]['registered']['lifecycle']='SUPERSEDED'
        newer=copy.deepcopy(bs);newer['content']['name']='兼容的新名称';newer['ref']['version']=2;newer['ref']['digest']=digest(newer['content'])
        ctx['fake_assets'].append(newer);snapshot(ctx,newer['ref'],newer['content'],base_version=1)
        self.assert_case(value,ctx)

    def test_duplicate_and_multiple_version_app_members_reject(self):
        for change in [False,True]:
            value,ctx=composition();other=copy.deepcopy(value['spec']['businessSchemaRefs'][0])
            if change:other['version']=2
            value['spec']['businessSchemaRefs'].append(other)
            self.assert_case(value,ctx,[('APPSPEC_INVALID','spec.businessSchemaRefs[1]')],'semantic')

    def test_app_reference_slot_shape_uses_d08_reference_code(self):
        value,ctx=composition();value['spec']['businessSchemaRefs'][0]['version']=0
        self.assert_case(value,ctx,[('REFERENCE_INVALID','spec.businessSchemaRefs[0].version')],'structure',checks='structure')

    def test_stable_code_namespace_collisions_and_mapping(self):
        value,ctx=composition();bs=asset_for(ctx,'BUSINESS_SCHEMA')
        body=copy.deepcopy(bs['content']);ctx['current']=current(bs['ref'])
        another=copy.deepcopy(bs);another['ref']['asset_id']='other-stable-id'
        ctx['fake_assets'].append(another)
        snapshot(ctx,another['ref'],another['content'],stable_id='dddddddd-dddd-4ddd-8ddd-dddddddddddd')
        self.assert_case(body,ctx,[('SCHEMA_CODE_INVALID','schema_code')],'references',contract='business-schema/v1',entry='spec')
        # Different module is a distinct namespace, never an identity fallback.
        ctx['snapshots'][-1]['ref']['module_id']='other-module';ctx['fake_assets'][-1]['ref']['module_id']='other-module'
        self.assert_case(body,ctx,contract='business-schema/v1',entry='spec')
        ctx['current']['stable_id']='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
        self.assert_case(body,ctx,[('REFERENCE_INVALID','schema_id')],'references',contract='business-schema/v1',entry='spec')

    def test_history_must_bind_exact_previous_asset_before_static_use(self):
        value,ctx=composition();bs=asset_for(ctx,'BUSINESS_SCHEMA');ctx['current']=current(bs['ref'],1)
        body=copy.deepcopy(bs['content'])
        history=dict(previous_spec=copy.deepcopy(body),used_fields=[],used_options={},deleted_field_codes=[],value_samples={})
        history['previous_spec']['name']='forged previous content'
        ctx['business']['history']=copy.deepcopy(history)
        ctx['histories']=[dict(target={k:ctx['current'][k] for k in ['scope_type','scope_id','app_id','module_id','asset_type','asset_id']},previous_ref=copy.deepcopy(bs['ref']),business_history=history,deleted_node_ids=[])]
        self.assert_case(body,ctx,[('REFERENCE_INVALID','schema_code')],'references',contract='business-schema/v1',entry='spec')

    def test_registry_tables_cannot_override_content(self):
        value,ctx=composition();ctx['business']['money_rules']['CNY']['scale']=3
        self.assert_case(value,ctx,[('REFERENCE_INVALID','spec.businessSchemaRefs[0].spec.field_type_registry_ref'),('REFERENCE_INVALID','spec.viewRefs[0].spec.businessSchemaRef.spec.field_type_registry_ref')],'references')

    def test_complete_500_node_view_and_dependency_shape_rejection(self):
        value,ctx=composition();vr=asset_for(ctx,'VIEW_SCHEMA');body=vr['content']
        body['componentsTree'][0]['children']=[dict(id='node_'+str(i),componentName='Text') for i in range(499)]
        ctx['current']=current(vr['ref']);ctx['snapshots']=[s for s in ctx['snapshots'] if s['ref']['asset_type']!='VIEW_SCHEMA']
        self.assert_case(body,ctx,contract='view-schema/lce-safe-v1',entry='spec')
        bs=asset_for(ctx,'BUSINESS_SCHEMA');del bs['content']['fields'];bs['ref']['digest']=digest(bs['content'])
        body['businessSchemaRef']=copy.deepcopy(bs['ref'])
        self.assert_case(body,ctx,[('CONTRACT_SHAPE_INVALID','businessSchemaRef.spec.fields')],'references',contract='view-schema/lce-safe-v1',entry='spec')

    def test_invalid_registered_json_schema_is_configuration_failure(self):
        for bad in [{'type':'unknown-type'},{'type':'string','format':'unregistered-format'},
                    {'$ref':'https://example.invalid/do-not-fetch'}, {'type':'object','$defs':{'unused':{'format':'unknown'}}}]:
            value,ctx=composition();asset=asset_for(ctx,'COMPONENT_REGISTRY')
            asset['content']['components'][0]['propsSchema']=bad
            for exit_code,payload in run(value,ctx):
                self.assertEqual(exit_code,1,payload)
                self.assertEqual(payload['execution']['code'],'REGISTRY_CONFIGURATION_INVALID')

    def test_invalid_historical_business_body_is_dependency_rejection(self):
        value,ctx=composition();bs=asset_for(ctx,'BUSINESS_SCHEMA')
        candidate=copy.deepcopy(bs['content'])
        del bs['content']['fields'];bs['ref']['digest']=digest(bs['content'])
        ctx['snapshots']=[s for s in ctx['snapshots'] if s['ref']['asset_type']!='BUSINESS_SCHEMA']
        snapshot(ctx,bs['ref'],bs['content'])
        ctx['current']=current(bs['ref'],1)
        history=dict(previous_spec=copy.deepcopy(bs['content']),used_fields=[],used_options={},deleted_field_codes=[],value_samples={})
        ctx['business']['history']=copy.deepcopy(history)
        target={k:ctx['current'][k] for k in ['scope_type','scope_id','app_id','module_id','asset_type','asset_id']}
        ctx['histories']=[dict(target=target,previous_ref=copy.deepcopy(bs['ref']),business_history=history,deleted_node_ids=[])]
        self.assert_case(candidate,ctx,[('CONTRACT_SHAPE_INVALID','schema_code.spec.fields')],'references',contract='business-schema/v1',entry='spec')

    def test_spec_does_not_require_unused_active_snapshot_but_draft_does(self):
        value,ctx=composition();bs=asset_for(ctx,'BUSINESS_SCHEMA')
        ctx['current']=current(bs['ref'],2)
        self.assert_case(bs['content'],ctx,contract='business-schema/v1',entry='spec')
        draft=dict(contract_version='business-schema/v1',base_version=2,spec=copy.deepcopy(bs['content']))
        self.assert_case(draft,ctx,[('REFERENCE_NOT_FOUND','base_version')],'references',contract='business-schema/v1')
        old=copy.deepcopy(ctx['snapshots'][0]['registered'])
        self.assert_case(old,ctx,contract='business-schema/v1',entry='registered')

    def test_existing_business_draft_cannot_omit_required_history(self):
        _,ctx=composition();bs=asset_for(ctx,'BUSINESS_SCHEMA')
        ctx['current']=current(bs['ref'],1)
        draft=dict(contract_version='business-schema/v1',base_version=1,spec=copy.deepcopy(bs['content']))
        field=draft['spec']['fields'][0];field['type']='long_text'
        field.pop('constraints',None);field.pop('type_config',None);field['query']['sortable']=False
        target={k:ctx['current'][k] for k in ['scope_type','scope_id','app_id','module_id','asset_type','asset_id']}
        for histories in [[],[dict(target=target,previous_ref=copy.deepcopy(bs['ref']),business_history=None,deleted_node_ids=[])]]:
            changed=copy.deepcopy(ctx);changed['histories']=histories
            with self.subTest(history=bool(histories)):
                self.assert_case(draft,changed,[('REFERENCE_INVALID','base_version')],'references',contract='business-schema/v1')
        # Missing used_fields remains unknown, not a generated usage assertion.
        history=dict(previous_spec=copy.deepcopy(bs['content']),used_options={},deleted_field_codes=[],value_samples={})
        ctx['histories']=[dict(target=target,previous_ref=copy.deepcopy(bs['ref']),business_history=history,deleted_node_ids=[])]
        self.assert_case(draft,ctx,[('BREAKING_CHANGE_FORBIDDEN','spec.fields[0].type')],'semantic',contract='business-schema/v1')
        draft['spec']=copy.deepcopy(bs['content'])
        self.assert_case(draft,ctx,contract='business-schema/v1')
        draft['spec']['fields']=draft['spec']['fields'][1:];draft['spec']['indexes']=[];draft['spec'].pop('layout',None)
        self.assert_case(draft,ctx,[('MIGRATION_REQUIRED','spec.fields')],'semantic',contract='business-schema/v1')

    def test_registered_shell_is_bound_to_ref_and_current_identity(self):
        value,ctx=composition();ar=ref('APP_SPEC','internal_ops',value['spec'],False)
        baseline=snapshot(ctx,ar,value['spec'])['registered']
        for key,new in [('scope_type','TEMPLATE'),('scope_id','another-tenant')]:
            changed=copy.deepcopy(ctx);changed['snapshots'][-1]['registered'][key]=new
            with self.subTest(shell=key):
                self.assert_case(changed['snapshots'][-1]['registered'],changed,[('REFERENCE_INVALID','$')],'references',entry='registered')
        for key,new,path in [('scope_type','TEMPLATE','version'),('scope_id','another-tenant','version'),
                             ('app_id','other-app','version'),('module_id','other-module','version'),
                             ('asset_id','other-asset','version'),('asset_type','VIEW_SCHEMA','spec'),
                             ('stable_id','dddddddd-dddd-4ddd-8ddd-dddddddddddd','app_id')]:
            changed=copy.deepcopy(ctx);changed['current'][key]=new
            with self.subTest(current=key):
                expected=[('APPSPEC_INVALID','spec.app_code'),('REFERENCE_INVALID','version')] if key=='asset_id' else [('REFERENCE_INVALID',path)]
                self.assert_case(baseline,changed,expected,'references',entry='registered')
        for key,new,path,code in [('version',2,'version','REFERENCE_INVALID'),
                                  ('digest','sha256:'+'0'*64,'checksum','CONTRACT_CHECKSUM_MISMATCH')]:
            changed=copy.deepcopy(ctx);changed['snapshots'][-1]['ref'][key]=new
            with self.subTest(ref=key):
                self.assert_case(baseline,changed,[(code,path)],'references',entry='registered')
        # Root snapshot readability is not the published-only dependency policy.
        changed=copy.deepcopy(ctx);changed['snapshots'][-1]['registered']['lifecycle']='DRAFT'
        for key in ['approved_by','approved_at','published_by','published_at']:
            changed['snapshots'][-1]['registered']['audit'][key]=None
        self.assert_case(changed['snapshots'][-1]['registered'],changed,entry='registered')

    def test_recursive_code_maps_to_one_stable_asset_per_namespace(self):
        for kind,slot in [('BUSINESS_SCHEMA','businessSchemaRefs'),('VIEW_SCHEMA','viewRefs')]:
            value,ctx=composition();first=asset_for(ctx,kind)
            if kind=='BUSINESS_SCHEMA':value['spec']['viewRefs']=[];value['spec']['navigation']=[]
            other=copy.deepcopy(first);other['ref']['asset_id']='another_asset'
            ctx['fake_assets'].append(other)
            snapshot(ctx,other['ref'],other['content'],stable_id='dddddddd-dddd-4ddd-8ddd-dddddddddddd')
            value['spec'][slot].append(copy.deepcopy(other['ref']))
            with self.subTest(kind=kind,namespace='same'):
                self.assert_case(value,ctx,[('REFERENCE_INVALID','spec.'+slot+'[0]'),('REFERENCE_INVALID','spec.'+slot+'[1]')],'references')
            other['ref']['module_id']='other-module';ctx['snapshots'][-1]['ref']['module_id']='other-module'
            value['spec'][slot][-1]['module_id']='other-module'
            with self.subTest(kind=kind,namespace='different'):
                self.assert_case(value,ctx)

    def test_i18n_reference_named_messages_stay_inert_at_every_entry(self):
        for key in ['asset_id','capability_code']:
            value,ctx=composition();vr=asset_for(ctx,'VIEW_SCHEMA')
            vr['content']['i18n']={'zh-CN':{'asset_type':'BUSINESS_SCHEMA',key:'display'}}
            vr['ref']['digest']=digest(vr['content'])
            ctx['snapshots']=[s for s in ctx['snapshots'] if s['ref']['asset_type']!='VIEW_SCHEMA']
            saved=snapshot(ctx,vr['ref'],vr['content'])['registered']
            view_ctx=copy.deepcopy(ctx);view_ctx['current']=current(vr['ref'])
            for entry,candidate in [('spec',vr['content']),('compiled-draft',dict(contract_version='view-schema/lce-safe-v1',base_version=0,spec=vr['content'])),('registered',saved)]:
                with self.subTest(key=key,entry=entry):
                    self.assert_case(candidate,view_ctx,contract='view-schema/lce-safe-v1',entry=entry)
            value['spec']['viewRefs']=[copy.deepcopy(vr['ref'])]
            value['spec']['navigation'][0]['viewRef']=copy.deepcopy(vr['ref'])
            with self.subTest(key=key,entry='recursive'):
                self.assert_case(value,ctx)

    def test_declared_capability_parameter_refs_receive_full_reference_validation(self):
        for is_action in [False,True]:
            base='componentsTree[0].children[0].actions["onClick"].input["businessSchemaRef"]' if is_action else 'queries[0].query.params["businessSchemaRef"]'
            for mode,code,suffix in [('valid',None,''),('pinned-old',None,''),
                                     ('scope','REFERENCE_OUT_OF_SCOPE',''),('missing','REFERENCE_NOT_FOUND',''),
                                     ('digest','REFERENCE_DIGEST_MISMATCH',''),('shape','REFERENCE_INVALID','.version'),
                                     ('invalid-body','CONTRACT_SHAPE_INVALID','.spec.fields')]:
                value,ctx=capability_parameter_case(mode,is_action)
                with self.subTest(mode=mode,action=is_action):
                    self.assert_case(value,ctx,[] if code is None else [(code,base+suffix)],
                                     'complete' if code is None else 'references',contract='view-schema/lce-safe-v1',entry='spec')
        value,ctx=capability_parameter_case('scope',nested=True)
        self.assert_case(value,ctx,[('REFERENCE_OUT_OF_SCOPE','queries[0].query.params["targets"][0].schema')],
                         'references',contract='view-schema/lce-safe-v1',entry='spec')

    def test_ordinary_registered_data_is_not_a_reference_declaration(self):
        for kind,key in [('品类','asset_id'),('BUSINESS_SCHEMA','asset_id'),('CAPABILITY','capability_code')]:
            with self.subTest(kind=kind,key=key):
                self.assert_case(*ordinary_capability_data_case(kind,key),contract='view-schema/lce-safe-v1',entry='spec')

    def test_nested_const_parameter_mismatch_is_protocol_rejection_at_both_entries(self):
        for is_action in [False,True]:
            path='componentsTree[0].children[0].actions["onClick"].input["targets"]' if is_action else 'queries[0].query.params["targets"]'
            code='VIEW_ACTION_FORBIDDEN' if is_action else 'VIEW_DATA_SOURCE_FORBIDDEN'
            for mode in ['missing-member','empty-array','short-array','wrong-array-shape',
                         'wrong-member-shape','wrong-reference-shape','valid','valid-two']:
                body,ctx=nested_parameter_shape_case(mode,is_action)
                valid=mode in ('valid','valid-two')
                with self.subTest(action=is_action,mode=mode,entry='direct'):
                    self.assert_case(body,ctx,[] if valid else [(code,path)],'complete' if valid else 'semantic',
                                     contract='view-schema/lce-safe-v1',entry='spec')
                with self.subTest(action=is_action,mode=mode,entry='recursive'):
                    self.assert_case(*app_with_view_dependency(body,ctx),
                                     [] if valid else [(code,'spec.viewRefs[0].spec.'+path)],
                                     'complete' if valid else 'references')

    def test_matching_nested_const_keeps_independent_reference_rejection(self):
        for is_action in [False,True]:
            path='componentsTree[0].children[0].actions["onClick"].input["targets"][0].schema' if is_action else 'queries[0].query.params["targets"][0].schema'
            for mode,code,suffix in [('scope','REFERENCE_OUT_OF_SCOPE',''),
                                     ('digest','REFERENCE_DIGEST_MISMATCH',''),
                                     ('shape','REFERENCE_INVALID','.version')]:
                body,ctx=capability_parameter_case(mode,is_action,nested=True)
                with self.subTest(action=is_action,mode=mode,entry='direct'):
                    self.assert_case(body,ctx,[(code,path+suffix)],'references',contract='view-schema/lce-safe-v1',entry='spec')
                with self.subTest(action=is_action,mode=mode,entry='recursive'):
                    self.assert_case(*app_with_view_dependency(body,ctx),[(code,'spec.viewRefs[0].spec.'+path+suffix)],'references')

    def test_projection_does_not_relax_registered_root_configuration(self):
        for bad in [{'unknownDeclaration':True},{'type':'unknown-type'},
                    {'type':'string','format':'unregistered-format'},
                    {'$ref':'https://example.invalid/do-not-fetch'}]:
            value,ctx=ordinary_capability_data_case()
            asset_for(ctx,'CAPABILITY','form.submit')['content']['inputSchema']['$defs']={'unused':bad}
            for exit_code,payload in run(value,ctx,contract='view-schema/lce-safe-v1',entry='spec'):
                self.assertEqual(exit_code,1,payload)
                self.assertEqual(payload['execution']['code'],'REGISTRY_CONFIGURATION_INVALID')

    def test_schema_reference_declarations_keep_alias_branch_and_array_semantics(self):
        for declaration in ['direct','alias','allOf','branch-data','items','unevaluated-data','unevaluated-scope']:
            path={'items':'queries[0].query.params["targets"][0].schema',
                  'unevaluated-scope':'queries[0].query.params["payload"].dependency'}.get(declaration,'queries[0].query.params["businessSchemaRef"]')
            expected=[] if declaration in ('branch-data','unevaluated-data') else [('REFERENCE_OUT_OF_SCOPE',path)]
            with self.subTest(declaration=declaration):
                self.assert_case(*schema_declared_parameter_case(declaration),expected,
                                 'complete' if not expected else 'references',contract='view-schema/lce-safe-v1',entry='spec')


if __name__ == '__main__': unittest.main()
