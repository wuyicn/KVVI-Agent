#!/usr/bin/env python3
"""Task5 supplemental literal oracles. Seed 0; no validator/output imports."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
from business_cases import business, field, section, rule, option, CONTEXT, leaf
from view_fixtures import fixture_context, view, node, asset_for, expression, field_ref
from integration_fixtures import close_context

DEST = Path(__file__).with_name('0a-core-r1')


def main():
    table = json.loads((DEST/'cases.json').read_text())
    table['cases'] = [c for c in table['cases'] if c.get('generated_by') != Path(__file__).name]
    def add(name, value, contract='business-schema/v1', entry='spec', group='B05', code=None, path=None, stage='structure', context=None, raw=None):
        name='T5-'+name
        input_name='inputs/'+name+'.json'
        (DEST/input_name).write_bytes(raw if raw is not None else (json.dumps(value,ensure_ascii=False,indent=2)+'\n').encode())
        checks='structure' if stage in ('structure','canonicalization') else 'complete'
        errors=[] if code is None else [dict(code=code,severity='ERROR',path=path)]
        case=dict(id=name,groups=[group,'T5'],input=input_name,contract=contract,entry=entry,checks=checks,
                  generated_by=Path(__file__).name,expected_stage=stage,
                  expected=dict(suite_revision='0a-core-r1',entry=entry,checks=checks,exit_code=2 if errors else 0,valid=not errors,errors=errors))
        if context is not None:
            raw_context=(json.dumps(context,ensure_ascii=False,indent=2)+'\n').encode()
            context_name='contexts/task5-'+hashlib.sha256(raw_context).hexdigest()[:16]+'.json'
            (DEST/context_name).write_bytes(raw_context);case['context']=context_name
        table['cases'].append(case)
    # Previously unit-only reachable raw errors now have fixed shared input bytes.
    for name, raw, code in [('out-of-range',b'{"base_version":9007199254740992}','CANON_NUMBER_OUT_OF_RANGE'),('invalid-unicode',b'{"description":"\\ud800"}','CANON_INVALID_UNICODE'),('invalid-utf8',b'{"description":"\xff"}','CANON_INVALID_UNICODE'),('bom',b'\xef\xbb\xbf{}','CANON_JSON_INVALID')]:
        add('raw-'+name,None,'app-spec/v1alpha1','compiled-draft','C01',code,'$','canonicalization',raw=raw)
    app=json.loads((DEST/'inputs/app-compiled-empty.json').read_text())
    add('missing-context',app,'app-spec/v1alpha1','compiled-draft','E01','TRUSTED_CONTEXT_REQUIRED','spec','semantic')
    ctx=fixture_context(); vs=view(ctx)
    vs['componentsTree'][0]['children']=[node(id='text_'+str(i)) for i in range(499)]
    vs,ctx=close_context(vs,ctx,'VIEW_SCHEMA','spec')
    add('complete-500-nodes',vs,'view-schema/lce-safe-v1','spec','V02',stage='complete',context=ctx)
    # Distinct count/length boundaries missing explicit directed cases in the old inventory.
    for count in (0,1,80,81):
        value=deepcopy(app);value['spec']['name']='a'*count
        add('app-name-'+str(count),value,'app-spec/v1alpha1','compiled-draft','A01',None if count in (1,80) else 'CONTRACT_SHAPE_INVALID','spec.name')
    for name, value in [('app-root', app), ('business-draft',dict(contract_version='business-schema/v1',base_version=0,spec=business())), ('view-draft',dict(contract_version='view-schema/lce-safe-v1',base_version=0,spec=view(fixture_context())))]:
        candidate=deepcopy(value);candidate['unexpected']=True
        add('closed-'+name,candidate,value['contract_version'],'compiled-draft','C02','UNKNOWN_PROPERTY','unexpected')
    for where in ('spec','route'):
        value=deepcopy(app)
        if where=='spec':value['spec']['unexpected']=True;path='spec.unexpected'
        else:
            value['spec']['navigation']=[dict(route_code='home',path='/',viewRef=asset_for(fixture_context(),'BUSINESS_SCHEMA')['ref'])]
            value['spec']['navigation'][0]['viewRef']['asset_type']='VIEW_SCHEMA'
            value['spec']['navigation'][0]['unexpected']=True;path='spec.navigation[0].unexpected'
        add('closed-app-'+where,value,'app-spec/v1alpha1','compiled-draft','A01','UNKNOWN_PROPERTY',path)
    for kind in ('short_text','long_text'):
        if kind=='short_text':
            for n in (-1,0,255,256):
                value=business([field(kind,constraints=dict(min_length=n,max_length=255))])
                add('short-min-length-'+str(n),value,group='B06',code=None if n in (0,255) else 'CONSTRAINT_INCOMPATIBLE',path='fields[0].constraints.min_length')
    for key, values in [('precision',(0,1,38,39)),('scale',(-1,0,12,13))]:
        for n in values:
            cfg={'precision':38,'scale':0};cfg[key]=n
            value=business([field('decimal',type_config=cfg)])
            add('decimal-'+key+'-'+str(n),value,group='B09',code=None if n in values[1:3] else 'CONSTRAINT_INCOMPATIBLE',path='fields[0].type_config.'+key)
    for n in (0,1,200,201):
        value=business([field('multi_select',type_config={'options':[option(str(i)) for i in range(n)]})])
        add('multi-options-'+str(n),value,group='B13',code=None if n in (1,200) else 'CONSTRAINT_INCOMPATIBLE',path='fields[0].type_config.options')
    for n in (0,1,4,5):
        s=section();s['columns']=4;s['items'][0]['col_span']=n
        add('col-span-'+str(n),business(layout={'sections':[s]}),group='B15',code=None if n in (1,4) else 'CONTRACT_SHAPE_INVALID',path='layout.sections[0].items[0].col_span')
    # Both layout item branches close unknown properties.
    s=section();s['items']=[{'kind':'description','text':'静态说明','unregistered':True}]
    add('closed-description-layout-item',business(layout={'sections':[s]}),group='B15',code='UNKNOWN_PROPERTY',path='layout.sections[0].items[0].unregistered')
    for n in (0,1,80,81):
        value=business();reference=deepcopy(value['field_type_registry_ref']);reference['asset_type']='SEQUENCE_POLICY'
        value['record_number']=dict(field_code='record_no',label='a'*n,sequence_policy_ref=reference)
        # FIX2 M-1: record_number.label has no inherited fields[].label bound.
        add('record-number-label-'+str(n),value,group='B04')
    # Shared reference definition scalar limits through real App compiled entry.
    for n in (0,1,9007199254740991):
        value=deepcopy(app);ref=asset_for(fixture_context(),'BUSINESS_SCHEMA')['ref'];ref['version']=n
        value['spec']['businessSchemaRefs']=[ref]
        add('ref-version-'+str(n),value,'app-spec/v1alpha1','compiled-draft','C04',None if n else 'REFERENCE_INVALID','spec.businessSchemaRefs[0].version')
    for length in (70,71,72):
        value=deepcopy(app);ref=asset_for(fixture_context(),'BUSINESS_SCHEMA')['ref'];ref['digest']='sha256:'+'a'*(length-7)
        value['spec']['businessSchemaRefs']=[ref]
        add('ref-digest-length-'+str(length),value,'app-spec/v1alpha1','compiled-draft','C04',None if length==71 else 'REFERENCE_INVALID','spec.businessSchemaRefs[0].digest')
    for n in (-1,0,9007199254740991):
        value=deepcopy(app);value['base_version']=n
        add('base-version-'+str(n),value,'app-spec/v1alpha1','compiled-draft','C02',None if n>=0 else 'CONTRACT_SHAPE_INVALID','base_version')
    for n in (-9007199254740991,9007199254740991):
        add('safe-integer-'+str(n),business([field('integer',default=n)]),group='B08')
    for length in (0,1):
        value=deepcopy(app);ref=asset_for(fixture_context(),'BUSINESS_SCHEMA')['ref'];ref['asset_id']='a'*length
        value['spec']['businessSchemaRefs']=[ref]
        add('stable-id-length-'+str(length),value,'app-spec/v1alpha1','compiled-draft','C04',None if length else 'REFERENCE_INVALID','spec.businessSchemaRefs[0].asset_id')
        value=json.loads((DEST/'inputs/app-registered-draft.json').read_text());value['audit']['trace_id']='a'*length
        add('trace-length-'+str(length),value,'app-spec/v1alpha1','registered','C03',None if length else 'CONTRACT_SHAPE_INVALID','audit.trace_id')
        add('business-name-length-'+str(length),business(name='a'*length),group='B01',code=None if length else 'CONTRACT_SHAPE_INVALID',path='name')
    for length in (200,201):
        value,ctx=close_context(business([field(constraints={'pattern':'a'*length})]),deepcopy(CONTEXT),'BUSINESS_SCHEMA','spec')
        add('pattern-length-'+str(length),value,group='B06',code=None if length==200 else 'CONSTRAINT_INCOMPATIBLE',path='fields[0].constraints.pattern',stage='complete' if length==200 else 'semantic',context=ctx)
    for index,expr in enumerate((leaf(),leaf(operator='eq',value='x'),{'all':[leaf()]},{'any':[leaf()]},{'not':leaf()})):
        add('expr-branch-'+str(index)+'-positive',business(record_rules=[rule(expr)]),group='B18')
        bad=deepcopy(expr);bad['unregistered']=True
        add('expr-branch-'+str(index)+'-unknown',business(record_rules=[rule(bad)]),group='B18',code='ARBITRARY_EXPRESSION_FORBIDDEN',path='record_rules[0].assert')
    add('expr-any-empty',business(record_rules=[rule({'any':[]})]),group='B18',code='ARBITRARY_EXPRESSION_FORBIDDEN',path='record_rules[0].assert')
    for length in (0,1,128,129):
        vs=view(fixture_context());vs['componentsTree'][0]['props']={'title':{'type':'I18nRef','key':'a'*length}}
        add('i18n-ref-key-'+str(length),vs,'view-schema/lce-safe-v1','spec','V06',None if length in (1,128) else 'CONTRACT_SHAPE_INVALID','componentsTree[0].props["title"].key')
    for length in (0,1):
        vs=view(fixture_context());vs['componentsTree'][0]['children']=[node('ShortTextField',props={'fieldBinding':{'type':'FieldRef','fieldRef':'a'*length}})]
        add('fieldref-length-'+str(length),vs,'view-schema/lce-safe-v1','spec','V05',None if length else 'CONTRACT_SHAPE_INVALID','componentsTree[0].children[0].props["fieldBinding"].fieldRef')
        vs=json.loads((DEST/'inputs/view-loop-max-1.json').read_text());vs['componentsTree'][0]['children'][0]['loop']['itemKey']='a'*length
        add('binding-itemkey-length-'+str(length),vs,'view-schema/lce-safe-v1','spec','V11',None if length else 'CONTRACT_SHAPE_INVALID','componentsTree[0].children[0].loop.itemKey')
    for key in ('all','any'):
        for count in (0,1):
            expr=expression();expr.pop('type')
            vs=view(fixture_context());vs['componentsTree'][0]['condition']={'type':'SafeExpression',key:[expr]*count}
            add('view-expr-'+key+'-'+str(count),vs,'view-schema/lce-safe-v1','spec','V07',None if count else 'VIEW_EXPRESSION_UNSAFE','componentsTree[0].condition.'+key)
    for contract,stable_key,body in [('business-schema/v1','schema_id',business()),('view-schema/lce-safe-v1','view_id',view(fixture_context()))]:
        value=json.loads((DEST/'inputs/app-registered-draft.json').read_text())
        value['contract_version']=contract;value[stable_key]=value.pop('app_id');value['spec']=body
        if stable_key=='schema_id':value['source_ref']=None
        add('registered-'+stable_key+'-positive',value,contract,'registered','C03')
        value['unexpected']=True
        add('registered-'+stable_key+'-unknown',value,contract,'registered','C03','UNKNOWN_PROPERTY','unexpected')
    for n in (1,80):add('field-label-boundary-'+str(n),business([field(label='a'*n)]),group='B05')
    for n in (3,64):add('field-code-boundary-'+str(n),business([field(field_code='a'*n)]),group='B04')
    add('columns-zero',business(layout={'sections':[section(columns=0)]}),group='B15',code='CONTRACT_SHAPE_INVALID',path='layout.sections[0].columns')
    add('index-one-field',business(indexes=[{'index_code':'idx_one','kind':'NORMAL','fields':['title']}]),group='B21')
    add('multi-max-zero',business([field('multi_select',constraints={'max_items':0})]),group='B13',code='CONSTRAINT_INCOMPATIBLE',path='fields[0].constraints.max_items')
    for n in (2,3,64,65):
        for slot in ('app_code','route_code'):
            value=deepcopy(app)
            if slot=='app_code':value['spec'][slot]='a'*n;path='spec.app_code'
            else:
                ref=asset_for(fixture_context(),'BUSINESS_SCHEMA')['ref'];ref['asset_type']='VIEW_SCHEMA'
                value['spec']['navigation']=[dict(route_code='a'*n,path='/',viewRef=ref)];path='spec.navigation[0].route_code'
            add('app-'+slot+'-length-'+str(n),value,'app-spec/v1alpha1','compiled-draft','A05',None if n in (3,64) else 'APPSPEC_INVALID' if slot=='route_code' else 'CONTRACT_SHAPE_INVALID',path)
        for slot in ('view_code','query_code'):
            vs=json.loads((DEST/'inputs/view-loop-max-1.json').read_text())
            if slot=='view_code':vs[slot]='a'*n;path=slot
            else:vs['queries'][0][slot]='a'*n;path='queries[0].query_code'
            add('view-'+slot+'-length-'+str(n),vs,'view-schema/lce-safe-v1','spec','V01' if slot=='view_code' else 'V10',None if n in (3,64) else 'CONTRACT_SHAPE_INVALID',path)
    (DEST/'cases.json').write_text(json.dumps(table,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'shared_cases':len(table['cases']),'added':sum(c.get('generated_by')==Path(__file__).name for c in table['cases'])}))


if __name__=='__main__':main()
