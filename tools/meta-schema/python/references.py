"""Exact fixed references, recursive dependency validation and trusted history."""
from diagnostics import diagnostic, sorted_unique
from context import identity, exact_key, bound_context
from structure import validate_structure, validate_definition
from view_registry import resolve_asset, resolve_capability, content_digest
from view_reference_declarations import declared_parameter_refs
from business import validate_business
from view import validate_view
from app import validate_app
from view_safety import walk

CONTRACTS = {'BUSINESS_SCHEMA':'business-schema/v1', 'VIEW_SCHEMA':'view-schema/lce-safe-v1', 'APP_SPEC':'app-spec/v1alpha1'}
IDS = {'BUSINESS_SCHEMA':'schema_id', 'VIEW_SCHEMA':'view_id', 'APP_SPEC':'app_id'}
CODES = {'BUSINESS_SCHEMA':'schema_code', 'VIEW_SCHEMA':'view_code', 'APP_SPEC':'app_code'}
PLATFORM_TYPES = {'FIELD_TYPE_REGISTRY','COMPONENT_REGISTRY','CAPABILITY_REGISTRY','CAPABILITY','SEQUENCE_POLICY'}


def child(prefix, key):
    return str(key) if prefix in ('', '$') else prefix + '.' + str(key)


def refs_in(spec, kind, prefix, context):
    if kind == 'BUSINESS_SCHEMA':
        yield spec['field_type_registry_ref'], child(prefix,'field_type_registry_ref')
        if 'record_number' in spec:
            yield spec['record_number']['sequence_policy_ref'], child(prefix,'record_number.sequence_policy_ref')
    elif kind == 'APP_SPEC':
        for slot in ('businessSchemaRefs','viewRefs','workflowRefs','permissionRefs'):
            for i, ref in enumerate(spec[slot]): yield ref, child(prefix,f'{slot}[{i}]')
    elif kind == 'VIEW_SCHEMA':
        for slot in ('businessSchemaRef','componentRegistryRef'):
            yield spec[slot],child(prefix,slot)
        # Only schema-declared reference slots; message keys are inert data.
        for value,path in walk({k:v for k,v in spec.items() if k!='i18n'},prefix):
            if isinstance(value,dict):
                slot='actionRef' if value.get('type')=='ActionRef' else 'queryRef' if value.get('type')=='DataQueryRef' else None
                if slot is not None:
                    yield value[slot],child(path,slot)
                    parameter_slot='input' if slot=='actionRef' else 'params'
                    capability,status=resolve_capability(value[slot],context)
                    if status=='ok':
                        yield from declared_parameter_refs(capability['inputSchema'],value.get(parameter_slot,{}),child(path,parameter_slot))


def allowed(ref, source, context, template_source=False):
    if ref['scope_type'] == 'PLATFORM_CONTROL':
        return ref['asset_type'] in PLATFORM_TYPES and ref['app_id'] is None and ref['module_id'] is None
    if ref['scope_type'] == 'TEMPLATE' and template_source:
        return ref['asset_type'] == 'BUSINESS_SCHEMA'
    if ref['scope_type'] != source['scope_type'] or ref['scope_id'] != source['scope_id']: return False
    if ref['app_id'] == source['app_id']: return True
    purpose = context['current']['purpose']
    if not purpose: return False
    sides = {g['side'] for g in context['grants'] if g['source_app_id'] == source['app_id'] and g['purpose'] == purpose and g['target'] == ref}
    return sides == {'source','target'}


def prefixed(errors, prefix):
    return [dict(e, path=prefix if e['path']=='$' else child(prefix,e['path'])) for e in errors]


def validate_references(contract, entry, value, context):
    kind = next(k for k,v in CONTRACTS.items() if v == contract)
    prefix = '$' if entry == 'spec' else 'spec'
    spec = value if entry == 'spec' else value['spec']
    current = context['current']
    errors, visiting, validated = [], set(), set()
    def add(code,path): errors.append(diagnostic(code,path))
    def snapshot_for(ref):
        return next((s['registered'] for s in context['snapshots'] if exact_key(s['ref']) == exact_key(ref) and s['ref']['digest'] == ref['digest']),None)

    def metadata(ref, content, path, published=True):
        snap = snapshot_for(ref)
        if snap is None:
            add('REFERENCE_NOT_FOUND',path); return None
        dep_kind=ref['asset_type']
        expected={'contract_version':CONTRACTS[dep_kind], 'scope_type':ref['scope_type'], 'scope_id':ref['scope_id'],
                  'version':ref['version'], 'checksum':ref['digest']}
        if any(snap.get(k)!=v for k,v in expected.items()) or snap.get('spec') != content:
            add('REFERENCE_INVALID',path); return None
        shape=validate_structure(CONTRACTS[dep_kind], 'registered', snap)
        if shape:
            errors.extend(prefixed(shape,path)); return None
        if published and snap['lifecycle'] not in ('PUBLISHED','SUPERSEDED'):
            add('REFERENCE_INVALID',path); return None
        for other in context['snapshots']:
            if identity(other['ref']) == identity(ref):
                if other['registered'].get(IDS[dep_kind]) != snap[IDS[dep_kind]] or other['registered'].get('spec',{}).get(CODES[dep_kind]) != content.get(CODES[dep_kind]):
                    add('REFERENCE_INVALID',path); return None
            elif identity(other['ref'])[:5] == identity(ref)[:5] and (
                other['registered'].get(IDS[dep_kind]) == snap[IDS[dep_kind]]
                or other['registered'].get('spec',{}).get(CODES[dep_kind]) == content.get(CODES[dep_kind])):
                add('REFERENCE_INVALID',path); return None
        return snap

    def resolve(ref,path,source,template_source=False):
        shape=validate_definition('CapabilityRef' if 'capability_code' in ref else 'AssetRef',ref)
        if shape: errors.extend(prefixed(shape,path)); return None
        if not allowed(ref,source,context,template_source): add('REFERENCE_OUT_OF_SCOPE',path); return None
        dep_kind=ref['asset_type']
        if dep_kind in ('WORKFLOW','PERMISSION'):
            add('DEPENDENCY_VALIDATOR_UNAVAILABLE',path); return None
        content,status=resolve_asset(ref,context)
        if status != 'ok':
            code=('VIEW_CAPABILITY_DIGEST_MISMATCH' if dep_kind=='CAPABILITY' else 'REFERENCE_DIGEST_MISMATCH') if status=='digest' else 'REFERENCE_NOT_FOUND'
            add(code,path); return None
        key=exact_key(ref)
        if key in visiting: add('REFERENCE_INVALID',path); return None
        if key in validated: return content
        if dep_kind in CONTRACTS:
            shape=validate_structure(CONTRACTS[dep_kind],'spec',content)
            if shape: errors.extend(prefixed(shape,child(path,'spec'))); return None
            snap=metadata(ref,content,path)
            if snap is None: return None
            visiting.add(key)
            before=len(errors)
            check_spec(dep_kind,content,ref,child(path,'spec'))
            if snap.get('source_ref') is not None: resolve(snap['source_ref'],child(path,'source_ref'),ref,True)
            visiting.remove(key)
            if len(errors)==before: validated.add(key)
        elif dep_kind in PLATFORM_TYPES:
            if not isinstance(content,dict) or content.get('fixture') is not True:
                add('REFERENCE_INVALID',path); return None
            if 'state' in content and content['state'] != 'PUBLISHED': add('REFERENCE_INVALID',path); return None
            if 'version' in content and content['version'] != ref['version']: add('REFERENCE_INVALID',path); return None
            if dep_kind=='FIELD_TYPE_REGISTRY':
                config=context['business']
                if (content.get('types') != config['enabled_types'] or content.get('index_capabilities') != config['index_capabilities']
                    or content.get('generators') != config['generators'] or content.get('money_rules') != config['money_rules']):
                    add('REFERENCE_INVALID',path); return None
            validated.add(key)
        else:
            add('DEPENDENCY_VALIDATOR_UNAVAILABLE',path); return None
        return content

    def check_spec(asset_kind,body,source,path):
        before=len(errors)
        resolved={}
        for ref,ref_path in refs_in(body,asset_kind,path,context):
            content=resolve(ref,ref_path,source)
            if content is not None: resolved[exact_key(ref)]=content
        if asset_kind=='VIEW_SCHEMA' and 'view' in context:
            registry=context['view']['capability_registry_ref']
            if registry is None:add('DEPENDENCY_VALIDATOR_UNAVAILABLE',child(path,'componentRegistryRef'))
            else:resolve(registry,child(path,'componentRegistryRef'),source)
        if len(errors)!=before: return
        if asset_kind=='APP_SPEC':
            for i,ref in enumerate(body['viewRefs']):
                view_body=resolved.get(exact_key(ref))
                if view_body is not None and view_body['businessSchemaRef'] not in body['businessSchemaRefs']:
                    add('APPSPEC_INVALID',child(path,f'viewRefs[{i}]'))
        validators={'BUSINESS_SCHEMA':validate_business,'VIEW_SCHEMA':validate_view,'APP_SPEC':validate_app}
        errors.extend(validators[asset_kind](body,bound_context(context,source,True),path))

    if current['asset_type'] != kind:
        return [diagnostic('REFERENCE_INVALID',prefix)]
    for item in context['snapshots']:
        r,s=item['ref'],item['registered']
        if r['asset_type'] != kind or identity(r)[:5] != identity(current)[:5]: continue
        same=identity(r)==identity(current)
        if same and s.get(IDS[kind]) != current['stable_id']: add('REFERENCE_INVALID',IDS[kind])
        if (same and s.get('spec',{}).get(CODES[kind]) != spec[CODES[kind]]) or (not same and s.get('spec',{}).get(CODES[kind]) == spec[CODES[kind]]):
            add('SCHEMA_CODE_INVALID' if kind=='BUSINESS_SCHEMA' else 'APPSPEC_INVALID' if kind=='APP_SPEC' else 'VIEW_REFERENCE_VERSION_CONFLICT',child(prefix,CODES[kind]))
    if entry=='compiled-draft' and value['base_version'] != current['active_version']:
        add('BASE_VERSION_CONFLICT','base_version')
    if entry!='registered':
        for history in context['histories']:
            if identity(history['target']) != identity(current): continue
            prior=history['previous_ref']
            body=history['business_history']
            if prior is not None:
                content,status=resolve_asset(prior,context)
                if (identity(prior)!=identity(current) or prior['version']!=current['active_version'] or status!='ok'
                    or (body is not None and content!=body['previous_spec'])):
                    add('REFERENCE_INVALID',child(prefix,CODES[kind]))
                else:
                    resolve(prior,'base_version' if entry=='compiled-draft' else child(prefix,CODES[kind]),current)
            elif current['active_version']!=0 or body is not None:
                add('REFERENCE_INVALID',child(prefix,CODES[kind]))
    if entry=='registered':
        if content_digest(spec) != value['checksum']: add('CONTRACT_CHECKSUM_MISMATCH','checksum')
        else:
            candidates=[s for s in context['snapshots'] if identity(s['ref'])==identity(current)]
            exact=next((s for s in candidates if s['ref']['version']==value['version']),None)
            if exact is None: add('REFERENCE_INVALID','version')
            else:
                trusted=exact['registered']
                for key in ('contract_version',IDS[kind],'scope_type','scope_id','version','base_version','lifecycle','canonicalization_profile','audit'):
                    if value.get(key)!=trusted.get(key): add('REFERENCE_INVALID',key)
                if kind=='BUSINESS_SCHEMA' and value['source_ref']!=trusted.get('source_ref'): add('REFERENCE_INVALID','source_ref')
                if value['spec']!=trusted.get('spec') or value['checksum']!=exact['ref']['digest']: add('CONTRACT_CHECKSUM_MISMATCH','checksum')
                if not errors: metadata(exact['ref'],spec,'$',published=False)
    if errors: return sorted_unique(errors)
    if entry=='compiled-draft' and current['active_version']>0:
        active=next((s for s in context['snapshots'] if identity(s['ref'])==identity(current) and s['ref']['version']==current['active_version']),None)
        if active is None: return [diagnostic('REFERENCE_NOT_FOUND','base_version')]
        resolve(active['ref'],'base_version',current)
        if errors: return sorted_unique(errors)
        if kind in ('BUSINESS_SCHEMA', 'VIEW_SCHEMA'):
            history=next((h for h in context['histories'] if identity(h['target'])==identity(current)),None)
            if history is None or history['previous_ref']!=active['ref'] or (kind=='BUSINESS_SCHEMA' and history['business_history'] is None):
                return [diagnostic('REFERENCE_INVALID','base_version')]
    check_spec(kind,spec,current,prefix)
    if entry=='registered' and value.get('source_ref') is not None: resolve(value['source_ref'],'source_ref',current,True)
    return sorted_unique(errors)
