#!/usr/bin/env python3
"""Materialize D01/D05/D06 integration fixtures from literal oracles, never outputs."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
from integration_fixtures import composition, snapshot, current, grant, capability_parameter_case, ordinary_capability_data_case, schema_declared_parameter_case
from view_fixtures import asset_for, ref, digest
from integration_fixtures import nested_parameter_shape_case, app_with_view_dependency
DEST=Path(__file__).with_name('0a-core-r1')
def dump(v):return json.dumps(v,ensure_ascii=False,indent=2)+'\n'
def write(path,v):(DEST/path).write_text(dump(v),encoding='utf-8')


def main():
    table=json.loads((DEST/'cases.json').read_text())
    table['cases']=[c for c in table['cases'] if c.get('generated_by')!='generate_integration_fixtures.py' and c['id']!='E01-app-complete-unavailable']
    for c in table['cases']:
        if 'expected_stage' not in c:
            c['expected_stage']='canonicalization' if any(e['code'].startswith('CANON_') for e in c['expected']['errors']) else 'structure'
    def add(name,value,context,errors=(),stage='complete',groups=('A07',),entry='compiled-draft',contract='app-spec/v1alpha1',checks=None):
        checks=checks or ('structure' if stage=='structure' else 'complete')
        input_path='inputs/integration-'+name+'.json';write(input_path,value)
        context_path='contexts/integration-'+hashlib.sha256(dump(context).encode()).hexdigest()[:16]+'.json'
        write(context_path,context)
        table['cases'].append(dict(id='I-'+name,groups=['Integration',*groups],input=input_path,context=context_path,
          generated_by='generate_integration_fixtures.py',contract=contract,entry=entry,checks=checks,expected_stage=stage,
          expected=dict(suite_revision='0a-core-r1',entry=entry,checks=checks,exit_code=2 if errors else 0,valid=not errors,
                        errors=[dict(code=code,path=path,severity='ERROR') for code,path in errors])))
    value,ctx=composition();add('three-contract-closed',value,ctx,groups=('C06','A02','A04','A06','A07'))
    empty=deepcopy(value)
    for slot in ['businessSchemaRefs','viewRefs','navigation']:empty['spec'][slot]=[]
    add('empty-closed',empty,ctx,groups=('A01','A03'))
    for slot in ['app_code','name','businessSchemaRefs','viewRefs','navigation','workflowRefs','permissionRefs','automationRefs','integrationRefs']:
        changed=deepcopy(empty);del changed['spec'][slot]
        add('missing-'+slot,changed,ctx,[('CONTRACT_SHAPE_INVALID','spec.'+slot)],'structure',('A01',))
    for slot in ['automationRefs','integrationRefs']:
        changed=deepcopy(empty);changed['spec'][slot]=[{}]
        add('reserved-'+slot,changed,ctx,[('CONTRACT_SHAPE_INVALID','spec.'+slot)],'structure',('A03',))
    for kind,slot in [('WORKFLOW','workflowRefs'),('PERMISSION','permissionRefs')]:
        changed=deepcopy(empty);changed['spec'][slot]=[ref(kind,'fixed_missing',{},False)]
        add('structure-'+kind,changed,ctx,stage='structure',groups=('A02','A04'))
        add('unavailable-'+kind,changed,ctx,[('DEPENDENCY_VALIDATOR_UNAVAILABLE','spec.'+slot+'[0]')],'references',('A04',))
    for i,path in enumerate(['/','/general-items/new','https://example.invalid','//x','/x/','/x//y','/x/..','/x\\y','/%2e','/x?y','/x#y','/x\n']):
        changed=deepcopy(value);changed['spec']['navigation'][0]['path']=path
        add('route-'+str(i),changed,ctx,[] if i<2 else [('APPSPEC_INVALID','spec.navigation[0].path')], 'complete' if i<2 else 'structure',('A05',))
    for key,new,code in [('module_id','missing-module','REFERENCE_NOT_FOUND'),('asset_id','missing-id','REFERENCE_NOT_FOUND'),('version',9,'REFERENCE_NOT_FOUND'),('scope_id','other-tenant','REFERENCE_OUT_OF_SCOPE'),('app_id','other-app','REFERENCE_OUT_OF_SCOPE'),('digest','sha256:'+'0'*64,'REFERENCE_DIGEST_MISMATCH')]:
        changed=deepcopy(empty);changed['spec']['businessSchemaRefs']=[deepcopy(value['spec']['businessSchemaRefs'][0])];changed['spec']['businessSchemaRefs'][0][key]=new
        add('identity-'+key,changed,ctx,[(code,'spec.businessSchemaRefs[0]')],'references',('C06','A07'))
    for version in [1,2]:
        changed=deepcopy(value);other=deepcopy(changed['spec']['businessSchemaRefs'][0]);other['version']=version;changed['spec']['businessSchemaRefs'].append(other)
        add('duplicate-version-'+str(version),changed,ctx,[('APPSPEC_INVALID','spec.businessSchemaRefs[1]')],'semantic',('A02',))
    changed=deepcopy(value);changed['spec']['navigation'][0]['viewRef']['version']=2
    add('navigation-member',changed,ctx,[('APPSPEC_INVALID','spec.navigation[0].viewRef')],'semantic',('A06',))
    changed=deepcopy(value);changed['spec']['businessSchemaRefs']=[]
    add('view-business-member',changed,ctx,[('APPSPEC_INVALID','spec.viewRefs[0]')],'references',('A06',))
    changed=deepcopy(value);changed['base_version']=1
    add('base-conflict',changed,ctx,[('BASE_VERSION_CONFLICT','base_version')],'references',('C07',))
    older=deepcopy(ctx);ar=ref('APP_SPEC','internal_ops',value['spec'],False)
    registered=snapshot(older,ar,value['spec'],lifecycle='SUPERSEDED')['registered']
    older['current']['active_version']=2
    add('registered-superseded',registered,older,groups=('C07',),entry='registered')
    for key,new in [('base_version',1),('version',3),('app_id','dddddddd-dddd-4ddd-8ddd-dddddddddddd')]:
        changed=deepcopy(registered);changed[key]=new
        add('registered-'+key,changed,older,[('REFERENCE_INVALID',key)],'references',('C07',),entry='registered')
    changed=deepcopy(registered);changed['checksum']='sha256:'+'0'*64
    add('registered-checksum',changed,older,[('CONTRACT_CHECKSUM_MISMATCH','checksum')],'references',('C07',),entry='registered')
    changed=deepcopy(registered);changed['audit']['trace_id']='fake-tamper'
    add('registered-audit',changed,older,[('REFERENCE_INVALID','audit')],'references',('C07',),entry='registered')

    # Review round 1: independent literal outcomes, not validator projections.
    _,history_ctx=composition();bs=asset_for(history_ctx,'BUSINESS_SCHEMA')
    history_ctx['current']=current(bs['ref'],1)
    draft=dict(contract_version='business-schema/v1',base_version=1,spec=deepcopy(bs['content']))
    field=draft['spec']['fields'][0];field['type']='long_text'
    field.pop('constraints',None);field.pop('type_config',None);field['query']['sortable']=False
    add('r1-history-missing',draft,history_ctx,[('REFERENCE_INVALID','base_version')],'references',('Task4Fix1','C07'),contract='business-schema/v1')
    target={k:history_ctx['current'][k] for k in ['scope_type','scope_id','app_id','module_id','asset_type','asset_id']}
    binding=dict(target=target,previous_ref=deepcopy(bs['ref']),business_history=None,deleted_node_ids=[])
    history_ctx['histories']=[binding]
    add('r1-history-null',draft,history_ctx,[('REFERENCE_INVALID','base_version')],'references',('Task4Fix1','C07'),contract='business-schema/v1')
    binding['business_history']=dict(previous_spec=deepcopy(bs['content']),used_options={},deleted_field_codes=[],value_samples={})
    add('r1-history-type-change',draft,history_ctx,[('BREAKING_CHANGE_FORBIDDEN','spec.fields[0].type')],'semantic',('Task4Fix1','C07'),contract='business-schema/v1')
    draft['spec']=deepcopy(bs['content'])
    add('r1-history-bound-valid',draft,history_ctx,groups=('Task4Fix1','C07'),contract='business-schema/v1')
    draft['spec']['fields']=draft['spec']['fields'][1:];draft['spec']['indexes']=[];draft['spec'].pop('layout',None)
    add('r1-history-usage-unknown',draft,history_ctx,[('MIGRATION_REQUIRED','spec.fields')],'semantic',('Task4Fix1','C07'),contract='business-schema/v1')

    value,ctx=composition();ar=ref('APP_SPEC','internal_ops',value['spec'],False)
    saved=snapshot(ctx,ar,value['spec'])['registered']
    changed=deepcopy(ctx);changed['snapshots'][-1]['registered']['scope_id']='another-tenant'
    add('r1-shell-scope',changed['snapshots'][-1]['registered'],changed,[('REFERENCE_INVALID','$')],'references',('Task4Fix1','C07'),entry='registered')
    changed=deepcopy(ctx);changed['current']['module_id']='another-module'
    add('r1-current-module',saved,changed,[('REFERENCE_INVALID','version')],'references',('Task4Fix1','C07'),entry='registered')

    for kind,slot in [('BUSINESS_SCHEMA','businessSchemaRefs'),('VIEW_SCHEMA','viewRefs')]:
        value,ctx=composition();first=asset_for(ctx,kind)
        if kind=='BUSINESS_SCHEMA':value['spec']['viewRefs']=[];value['spec']['navigation']=[]
        other=deepcopy(first);other['ref']['asset_id']='another_asset'
        ctx['fake_assets'].append(other);snapshot(ctx,other['ref'],other['content'],stable_id='dddddddd-dddd-4ddd-8ddd-dddddddddddd')
        value['spec'][slot].append(deepcopy(other['ref']))
        add('r1-duplicate-code-'+kind,value,ctx,[('REFERENCE_INVALID','spec.'+slot+'[0]'),('REFERENCE_INVALID','spec.'+slot+'[1]')],'references',('Task4Fix1','C06','A07'))
        other['ref']['module_id']='other-module';ctx['snapshots'][-1]['ref']['module_id']='other-module';value['spec'][slot][-1]['module_id']='other-module'
        add('r1-other-module-'+kind,value,ctx,groups=('Task4Fix1','C06','A07'))

    value,ctx=composition();vr=asset_for(ctx,'VIEW_SCHEMA')
    vr['content']['i18n']={'zh-CN':{'asset_type':'BUSINESS_SCHEMA','asset_id':'display'}}
    vr['ref']['digest']=digest(vr['content'])
    ctx['snapshots']=[s for s in ctx['snapshots'] if s['ref']['asset_type']!='VIEW_SCHEMA'];snapshot(ctx,vr['ref'],vr['content'])
    view_ctx=deepcopy(ctx);view_ctx['current']=current(vr['ref'])
    add('r1-i18n-spec',vr['content'],view_ctx,groups=('Task4Fix1','A07'),entry='spec',contract='view-schema/lce-safe-v1')
    value['spec']['viewRefs']=[deepcopy(vr['ref'])];value['spec']['navigation'][0]['viewRef']=deepcopy(vr['ref'])
    add('r1-i18n-recursive',value,ctx,groups=('Task4Fix1','A07'))
    for slot,path,code in [('app_code','spec.app_code','CONTRACT_SHAPE_INVALID'),('route_code','spec.navigation[0].route_code','APPSPEC_INVALID')]:
        value,ctx=composition();target=value['spec'] if slot=='app_code' else value['spec']['navigation'][0];target[slot]='abc\n'
        add('r1-lf-'+slot,value,ctx,[(code,path)],'structure',('Task4Fix1','A05'),checks='complete')

    for is_action in [False,True]:
        base='componentsTree[0].children[0].actions["onClick"].input["businessSchemaRef"]' if is_action else 'queries[0].query.params["businessSchemaRef"]'
        for mode,code,suffix in [('valid',None,''),('pinned-old',None,''),
                                 ('scope','REFERENCE_OUT_OF_SCOPE',''),('missing','REFERENCE_NOT_FOUND',''),
                                 ('digest','REFERENCE_DIGEST_MISMATCH',''),('shape','REFERENCE_INVALID','.version'),
                                 ('invalid-body','CONTRACT_SHAPE_INVALID','.spec.fields')]:
            value,ctx=capability_parameter_case(mode,is_action)
            add('r2-'+('action-' if is_action else 'query-')+mode,value,ctx,
                [] if code is None else [(code,base+suffix)],'complete' if code is None else 'references',
                ('Task4Fix2','C06','A07'),entry='spec',contract='view-schema/lce-safe-v1')
    value,ctx=capability_parameter_case('scope',nested=True)
    add('r2-nested-query-scope',value,ctx,[('REFERENCE_OUT_OF_SCOPE','queries[0].query.params["targets"][0].schema')],
        'references',('Task4Fix2','C06','A07'),entry='spec',contract='view-schema/lce-safe-v1')
    for name,kind,key in [('ordinary','品类','asset_id'),('asset-word','BUSINESS_SCHEMA','asset_id'),('capability-word','CAPABILITY','capability_code')]:
        value,ctx=ordinary_capability_data_case(kind,key)
        add('r3-data-'+name,value,ctx,groups=('Task4Fix3','C06','A07'),entry='spec',contract='view-schema/lce-safe-v1')
    for declaration in ['direct','alias','allOf','branch-data','items','unevaluated-data','unevaluated-scope']:
        value,ctx=schema_declared_parameter_case(declaration)
        path='queries[0].query.params["businessSchemaRef"]'
        if declaration=='items':path='queries[0].query.params["targets"][0].schema'
        if declaration=='unevaluated-scope':path='queries[0].query.params["payload"].dependency'
        errors=[] if declaration in ['branch-data','unevaluated-data'] else [('REFERENCE_OUT_OF_SCOPE',path)]
        add('r3-declared-'+declaration,value,ctx,errors,'references' if errors else 'complete',
            ('Task4Fix3','C06','A07'),entry='spec',contract='view-schema/lce-safe-v1')
    for is_action in [False,True]:
        kind='action' if is_action else 'query'
        path='componentsTree[0].children[0].actions["onClick"].input["targets"]' if is_action else 'queries[0].query.params["targets"]'
        parameter_code='VIEW_ACTION_FORBIDDEN' if is_action else 'VIEW_DATA_SOURCE_FORBIDDEN'
        for mode in ['missing-member','empty-array','short-array','wrong-array-shape',
                     'wrong-member-shape','wrong-reference-shape','valid','valid-two']:
            value,ctx=nested_parameter_shape_case(mode,is_action)
            valid=mode in ('valid','valid-two')
            add('r4-'+kind+'-'+mode+'-direct',value,ctx,[] if valid else [(parameter_code,path)],
                'complete' if valid else 'semantic',('Task4Fix4','V08','V09','A07'),
                entry='spec',contract='view-schema/lce-safe-v1')
            app,app_ctx=app_with_view_dependency(value,ctx)
            add('r4-'+kind+'-'+mode+'-recursive',app,app_ctx,
                [] if valid else [(parameter_code,'spec.viewRefs[0].spec.'+path)],
                'complete' if valid else 'references',('Task4Fix4','V08','V09','A07'))
        for mode,code,suffix in [('scope','REFERENCE_OUT_OF_SCOPE',''),
                                 ('digest','REFERENCE_DIGEST_MISMATCH',''),
                                 ('shape','REFERENCE_INVALID','.version')]:
            value,ctx=capability_parameter_case(mode,is_action,nested=True)
            ref_path=path+'[0].schema'+suffix
            add('r4-'+kind+'-matched-'+mode+'-direct',value,ctx,[(code,ref_path)],'references',
                ('Task4Fix4','C06','A07'),entry='spec',contract='view-schema/lce-safe-v1')
            app,app_ctx=app_with_view_dependency(value,ctx)
            add('r4-'+kind+'-matched-'+mode+'-recursive',app,app_ctx,[(code,'spec.viewRefs[0].spec.'+ref_path)],
                'references',('Task4Fix4','C06','A07'))
    write('cases.json',table)
    print(json.dumps(dict(integration_cases=sum('Integration' in c['groups'] for c in table['cases']),shared_cli_cases=len(table['cases']))))

if __name__=='__main__':main()
