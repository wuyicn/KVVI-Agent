"""Independent Fake composition and trusted snapshot inputs (no validator imports)."""
from copy import deepcopy
from view_fixtures import fixture_context, asset_for, view, ref, digest, query, action, node, closed

IDS = {'BUSINESS_SCHEMA': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
       'VIEW_SCHEMA': 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
       'APP_SPEC': '22222222-2222-4222-8222-222222222222'}
CONTRACTS = {'BUSINESS_SCHEMA': 'business-schema/v1', 'VIEW_SCHEMA': 'view-schema/lce-safe-v1', 'APP_SPEC': 'app-spec/v1alpha1'}
ID_KEYS = {'BUSINESS_SCHEMA': 'schema_id', 'VIEW_SCHEMA': 'view_id', 'APP_SPEC': 'app_id'}
CODE_KEYS = {'BUSINESS_SCHEMA': 'schema_code', 'VIEW_SCHEMA': 'view_code', 'APP_SPEC': 'app_code'}


def registered(reference, content, stable_id=None, lifecycle='PUBLISHED', base_version=0):
    who = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    value = dict(contract_version=CONTRACTS[reference['asset_type']],
                 scope_type=reference['scope_type'], scope_id=reference['scope_id'],
                 version=reference['version'], base_version=base_version, lifecycle=lifecycle,
                 canonicalization_profile='kvvi-json-c14n/v1', checksum=digest(content),
                 audit=dict(created_by=who, created_at='2026-09-08T00:00:00Z',
                            approved_by=who, approved_at='2026-09-08T00:00:01Z',
                            published_by=who, published_at='2026-09-08T00:00:02Z', trace_id='fake-trace'),
                 spec=deepcopy(content))
    value[ID_KEYS[reference['asset_type']]] = stable_id or IDS[reference['asset_type']]
    if reference['asset_type'] == 'BUSINESS_SCHEMA': value['source_ref'] = None
    return value


def snapshot(context, reference, content, **kwargs):
    item = dict(ref=deepcopy(reference), registered=registered(reference, content, **kwargs))
    context.setdefault('snapshots', []).append(item)
    return item


def current(reference, active_version=0):
    return dict(**{k: reference[k] for k in ['scope_type', 'scope_id', 'app_id', 'module_id', 'asset_type', 'asset_id']},
                stable_id=IDS[reference['asset_type']], active_version=active_version, purpose='compose')


def composition():
    ctx = fixture_context(False)
    enrich_registries(ctx)
    vs = view(ctx)
    vr = ref('VIEW_SCHEMA', vs['view_code'], vs, False)
    ctx['fake_assets'].append(dict(ref=vr, content=vs))
    bs = asset_for(ctx, 'BUSINESS_SCHEMA')
    app = dict(app_code='internal_ops', name='内部经营系统', businessSchemaRefs=[deepcopy(bs['ref'])],
               viewRefs=[deepcopy(vr)], navigation=[dict(route_code='general_items_new', path='/general-items/new', viewRef=deepcopy(vr))],
               workflowRefs=[], permissionRefs=[], automationRefs=[], integrationRefs=[])
    ar = ref('APP_SPEC', 'internal_ops', app, False)
    ctx.update(current=current(ar), snapshots=[], histories=[], grants=[])
    snapshot(ctx, bs['ref'], bs['content'])
    snapshot(ctx, vr, vs)
    return dict(contract_version='app-spec/v1alpha1', base_version=0, spec=app), ctx


def capability_parameter_case(mode='valid', is_action=False, nested=False):
    """Registered Fake input permits a fixed ref; its protocol outcome is separate."""
    _,ctx=composition();vr=asset_for(ctx,'VIEW_SCHEMA');body=deepcopy(vr['content'])
    bs=asset_for(ctx,'BUSINESS_SCHEMA');parameter=deepcopy(bs['ref'])
    if mode=='scope':parameter['scope_id']='other-tenant'
    elif mode=='missing':parameter['asset_id']='missing_business'
    elif mode=='digest':parameter['digest']='sha256:'+'0'*64
    elif mode=='shape':parameter['version']=0
    elif mode=='invalid-body':
        invalid=deepcopy(bs);invalid['ref']['module_id']='query-module';del invalid['content']['fields']
        invalid['ref']['digest']=digest(invalid['content']);ctx['fake_assets'].append(invalid)
        snapshot(ctx,invalid['ref'],invalid['content']);parameter=deepcopy(invalid['ref'])
    elif mode=='pinned-old':
        newer=deepcopy(bs);newer['content']['name']='兼容的新名称';newer['ref']['version']=2;newer['ref']['digest']=digest(newer['content'])
        ctx['fake_assets'].append(newer);snapshot(ctx,newer['ref'],newer['content'],base_version=1)
        body['businessSchemaRef']=deepcopy(newer['ref'])
    params={'targets':[{'schema':parameter}]} if nested else {'businessSchemaRef':parameter}
    if not is_action and not nested:params['pageSize']=20
    code='form.submit' if is_action else 'records.list'
    if is_action:
        call=action(ctx,code);call['input']=params
        body['componentsTree'][0]['children']=[node('SubmitButton','submit_button',actions={'onClick':call})]
    else:
        call=query(ctx,code);call['params']=params
        body['queries']=[dict(query_code='items_query',query=call)]
    capability=asset_for(ctx,'CAPABILITY',code);old=deepcopy(capability['ref'])
    if nested:
        capability['content']['inputSchema']=closed({'targets':{'const':params['targets']}},['targets'])
    else:
        capability['content']['inputSchema']['properties']['businessSchemaRef']={'const':parameter}
        capability['content']['inputSchema']['required']=['businessSchemaRef']
    fresh=dict(old,digest=digest(capability['content']));replace_ref(ctx,old,fresh);replace_ref(body,old,fresh)
    registry=asset_for(ctx,'CAPABILITY_REGISTRY');old_registry=deepcopy(registry['ref'])
    replace_ref(ctx,old_registry,dict(old_registry,digest=digest(registry['content'])))
    ctx['current']=current(vr['ref'])
    return body,ctx


def ordinary_capability_data_case(asset_type='品类', identity_key='asset_id'):
    """Trusted ordinary string properties are not declarations of dependencies."""
    _,ctx=composition();vr=asset_for(ctx,'VIEW_SCHEMA');body=deepcopy(vr['content'])
    call=action(ctx,'form.submit');call['input']={'note':{'asset_type':asset_type,identity_key:'货号'}}
    body['componentsTree'][0]['children']=[node('SubmitButton','submit_button',actions={'onClick':call})]
    capability=asset_for(ctx,'CAPABILITY','form.submit');old=deepcopy(capability['ref'])
    note=closed({'asset_type':{'type':'string'},identity_key:{'type':'string'}},['asset_type',identity_key])
    capability['content']['inputSchema']=closed({'note':note},['note'])
    fresh=dict(old,digest=digest(capability['content']));replace_ref(ctx,old,fresh);replace_ref(body,old,fresh)
    registry=asset_for(ctx,'CAPABILITY_REGISTRY');old_registry=deepcopy(registry['ref'])
    replace_ref(ctx,old_registry,dict(old_registry,digest=digest(registry['content'])))
    ctx['current']=current(vr['ref'])
    return body,ctx


def nested_parameter_shape_case(mode='valid', is_action=False):
    """Keep a trusted const fixed while authored public parameters violate it."""
    body,ctx=capability_parameter_case('valid',is_action,nested=True)
    call=body['componentsTree'][0]['children'][0]['actions']['onClick'] if is_action else body['queries'][0]['query']
    params=call['input' if is_action else 'params']
    if mode in ('short-array','valid-two'):
        capability=asset_for(ctx,'CAPABILITY','form.submit' if is_action else 'records.list')
        old=deepcopy(capability['ref'])
        target_schema=capability['content']['inputSchema']['properties']['targets']
        declared=deepcopy(target_schema['const']);target_schema['const']=declared
        declared.append(deepcopy(declared[0]))
        fresh=dict(old,digest=digest(capability['content']))
        replace_ref(ctx,old,fresh);replace_ref(body,old,fresh)
        registry=asset_for(ctx,'CAPABILITY_REGISTRY');old_registry=deepcopy(registry['ref'])
        replace_ref(ctx,old_registry,dict(old_registry,digest=digest(registry['content'])))
        if mode=='valid-two':params['targets'].append(deepcopy(params['targets'][0]))
    elif mode=='missing-member':params['targets']=[{}]
    elif mode=='empty-array':params['targets']=[]
    elif mode=='wrong-array-shape':params['targets']={}
    elif mode=='wrong-member-shape':params['targets']=[None]
    elif mode=='wrong-reference-shape':params['targets']=[{'schema':None}]
    return body,ctx


def app_with_view_dependency(body, context):
    """Hash-close the supplied public View as a dependency of a valid App."""
    app,_=composition();ctx=deepcopy(context);vr=asset_for(ctx,'VIEW_SCHEMA')
    vr['content']=deepcopy(body);vr['ref']['digest']=digest(body)
    ctx['snapshots']=[s for s in ctx['snapshots'] if s['ref']['asset_type']!='VIEW_SCHEMA']
    snapshot(ctx,vr['ref'],vr['content'])
    app['spec']['businessSchemaRefs']=[deepcopy(body['businessSchemaRef'])]
    app['spec']['viewRefs']=[deepcopy(vr['ref'])]
    app['spec']['navigation'][0]['viewRef']=deepcopy(vr['ref'])
    ctx['current']=current(ref('APP_SPEC','internal_ops',app['spec'],False))
    return app,ctx


def schema_declared_parameter_case(declaration='direct'):
    """Use standard Schema declarations, including an ordinary-data branch."""
    body,ctx=capability_parameter_case('scope',nested=declaration=='items')
    call=body['queries'][0]['query'];capability=asset_for(ctx,'CAPABILITY','records.list');old=deepcopy(capability['ref'])
    reference={'$ref':'urn:kvvi:meta-schema:0a-core-r1:common#/$defs/AssetRef'}
    schema=closed({'businessSchemaRef':reference,'pageSize':{'type':'integer'}},['businessSchemaRef'])
    if declaration=='alias':
        schema['$id']='urn:kvvi:fake:query-input'
        schema['$defs']={'a/b~c':reference};schema['properties']['businessSchemaRef']={'$ref':'#/$defs/a~1b~0c'}
    elif declaration=='allOf':schema['properties']['businessSchemaRef']={'allOf':[reference]}
    elif declaration=='branch-data':
        ordinary=closed({'asset_type':{'type':'string'},'asset_id':{'type':'string'}},['asset_type','asset_id'])
        schema['properties']['businessSchemaRef']={'anyOf':[reference,ordinary]}
        call['params']['businessSchemaRef']={'asset_type':'BUSINESS_SCHEMA','asset_id':'货号'}
    elif declaration=='items':
        schema=closed({'targets':{'type':'array','items':closed({'schema':reference},['schema'])}},['targets'])
    elif declaration in ('unevaluated-data','unevaluated-scope'):
        ordinary=closed({'asset_type':{'type':'string'},'asset_id':{'type':'string'}},['asset_type','asset_id'])
        payload={'note':{'asset_type':'BUSINESS_SCHEMA','asset_id':'货号'}}
        if declaration=='unevaluated-scope':payload['dependency']=deepcopy(call['params']['businessSchemaRef'])
        call['params']={'payload':payload}
        schema=closed({'payload':{'type':'object','allOf':[{'properties':{'note':ordinary}}],
                                 'unevaluatedProperties':reference}},['payload'])
    capability['content']['inputSchema']=schema
    fresh=dict(old,digest=digest(capability['content']))
    replace_ref(ctx,old,fresh);replace_ref(body,old,fresh)
    registry=asset_for(ctx,'CAPABILITY_REGISTRY');old_registry=deepcopy(registry['ref'])
    replace_ref(ctx,old_registry,dict(old_registry,digest=digest(registry['content'])))
    return body,ctx


def grant(ctx, target, side):
    return dict(side=side, source_app_id=ctx['current']['app_id'], target=deepcopy(target), purpose='compose')


def replace_ref(value, old, new):
    if isinstance(value,dict):
        if value == old:
            value.clear();value.update(deepcopy(new));return
        for nested in value.values(): replace_ref(nested,old,new)
    elif isinstance(value,list):
        for nested in value:replace_ref(nested,old,new)


def enrich_registries(ctx, instance=None):
    """Bind all private static tables to fixed FieldTypeRegistry content."""
    ctx['business'].setdefault('index_capabilities',{})
    prior={id(asset):digest(asset['content']) for asset in ctx.get('fake_assets',[])}
    for asset in ctx.get('fake_assets',[]):
        if asset['ref']['asset_type']=='FIELD_TYPE_REGISTRY':
            asset['content'].update(generators=deepcopy(ctx['business']['generators']),money_rules=deepcopy(ctx['business']['money_rules']))
    # Contract and capability contents can themselves contain rebound refs.
    # Repeat until the DAG of fixed dependency digests is closed.
    for _ in range(5):
        changed=False
        for asset in ctx.get('fake_assets',[]):
            fresh=digest(asset['content'])
            before=prior[id(asset)]
            prior[id(asset)]=fresh
            if before != fresh and asset['ref']['digest'] == before:
                old=deepcopy(asset['ref']);new=dict(old,digest=fresh)
                replace_ref(ctx,old,new)
                if instance is not None:replace_ref(instance,old,new)
                changed=True
        if not changed:break


def close_context(value, ctx, kind, entry='spec'):
    """Promote static fixtures to an explicit independent Fake identity/history.

    This only rebinds authored assets, never runs validators or derives expected.
    Existing digest tamper probes remain tampered.
    """
    value,ctx=deepcopy(value),deepcopy(ctx)
    body=value if entry=='spec' else value['spec']
    ctx.setdefault('fake_assets',[])
    ctx['business'].setdefault('index_capabilities',{})
    if 'view' in ctx:ctx['view'].setdefault('capability_registry_ref',None)
    if kind=='BUSINESS_SCHEMA' and not any(a['ref']['asset_type']=='FIELD_TYPE_REGISTRY' for a in ctx['fake_assets']):
        old=deepcopy(body['field_type_registry_ref'])
        content=dict(fixture=True,types=deepcopy(ctx['business']['enabled_types']),index_capabilities=deepcopy(ctx['business']['index_capabilities']))
        fixed=dict(old,digest=digest(content))
        ctx['fake_assets'].append(dict(ref=fixed,content=content))
        replace_ref(value,old,fixed);replace_ref(ctx['business'],old,fixed)
    enrich_registries(ctx,value)
    history=ctx['business']['history']
    code=body[CODE_KEYS[kind]]
    if kind=='BUSINESS_SCHEMA' and history:code=history['previous_spec']['schema_code']
    target=ref(kind,code,body,False)
    ctx.update(current=current(target,1 if history else 0),snapshots=[],histories=[],grants=[])
    for asset in ctx['fake_assets']:
        if asset['ref']['asset_type'] in CONTRACTS:snapshot(ctx,asset['ref'],asset['content'])
    previous=None
    if history:
        previous=ref(kind,code,history['previous_spec'],False)
        ctx['fake_assets'].append(dict(ref=deepcopy(previous),content=deepcopy(history['previous_spec'])))
        snapshot(ctx,previous,history['previous_spec'])
    deleted=ctx.get('view',{}).get('deleted_node_ids',[])
    ctx['histories']=[dict(target={k:target[k] for k in ['scope_type','scope_id','app_id','module_id','asset_type','asset_id']},previous_ref=previous,business_history=history,deleted_node_ids=deepcopy(deleted))]
    return value,ctx
