"""Closed private Fake context, independently parsed before any trust is used."""
from copy import deepcopy
import json
import importlib.util
from pathlib import Path
from jsonschema import Draft202012Validator
from structure import load_bundle, FORMAT_CHECKER, BundleLoadError, validate_structure
from view_registry import _c14n, resolve_asset

SCHEMA = Path(__file__).resolve().parents[1] / 'context.schema.json'
IDENTITY = ('scope_type','scope_id','app_id','module_id','asset_type','asset_id')
# FIX2 private Registry profile, independent of installed optional format extras.
REGISTRY_FORMATS = frozenset({'date', 'date-time', 'uuid'})


class ContextInvalid(ValueError):
    pass


class RegistryConfigurationInvalid(ValueError):
    pass


def validate_registry_schemas(context, schemas, registry):
    module_spec=importlib.util.spec_from_file_location('context_schema_policy',SCHEMA.parent/'verify_bundle.py')
    policy=importlib.util.module_from_spec(module_spec);module_spec.loader.exec_module(policy)
    def nodes(schema):
        yield schema
        if not isinstance(schema,dict): return
        for key in policy.SCHEMA_MAP_KEYS:
            for nested in schema.get(key,{}).values():yield from nodes(nested)
        for key in policy.SCHEMA_SINGLE_KEYS:
            if isinstance(schema.get(key),(dict,bool)):yield from nodes(schema[key])
        for key in policy.SCHEMA_LIST_KEYS:
            for nested in schema.get(key,[]):yield from nodes(nested)
    try:
        for asset in context['fake_assets']:
            content=asset['content']
            if not isinstance(content,dict):continue
            definitions=[]
            if asset['ref']['asset_type']=='COMPONENT_REGISTRY':
                definitions=[c['propsSchema'] for c in content.get('components',[]) if isinstance(c,dict) and 'propsSchema' in c]
            if asset['ref']['asset_type']=='CAPABILITY':
                definitions=[content[k] for k in ('inputSchema','outputSchema','errorSchema') if k in content]
            for schema in definitions:
                Draft202012Validator.check_schema(schema)
                for node in nodes(schema):
                    if isinstance(node,dict):
                        if set(node)-policy.KNOWN_KEYWORDS:raise RegistryConfigurationInvalid()
                        if 'format' in node and node['format'] not in REGISTRY_FORMATS:raise RegistryConfigurationInvalid()
                local_id=schema.get('$id','urn:kvvi:tool-private:registered-schema') if isinstance(schema,dict) else 'urn:kvvi:tool-private:registered-schema'
                policy.walk_refs(schema,local_id,{**{s['$id']:s for s in schemas.values()},local_id:schema},'$')
                # Actual engine construction, no custom interpretation of schema values.
                Draft202012Validator(schema,registry=registry,format_checker=FORMAT_CHECKER)
    except Exception as exc:
        raise RegistryConfigurationInvalid() from exc


def identity(ref):
    return tuple(ref.get(k) if k != 'asset_id' else ref.get('asset_id', ref.get('capability_code')) for k in IDENTITY)


def exact_key(ref):
    return identity(ref) + (ref['version'],)


def parse_context(raw):
    try:
        result = _c14n.canonicalize_json(raw.decode('utf-8'))
        context = json.loads(result['canonical'])
        schemas, registry = load_bundle()
        schema = json.loads(SCHEMA.read_text())
        validator = Draft202012Validator(schema, registry=registry, format_checker=FORMAT_CHECKER)
        if not validator.is_valid(context): raise ContextInvalid()
        for name, key in [('fake_assets', exact_key), ('snapshots', exact_key)]:
            keys = [key(item['ref']) for item in context[name]]
            if len(keys) != len(set(keys)): raise ContextInvalid()
        history_keys = [identity(h['target']) for h in context['histories']]
        if len(history_keys) != len(set(history_keys)): raise ContextInvalid()
        for rules in context['business']['money_rules'].values():
            if rules['scale'] > rules['precision']: raise ContextInvalid()
        validate_registry_schemas(context,schemas,registry)
        return context
    except (ContextInvalid, BundleLoadError, RegistryConfigurationInvalid):
        raise
    except Exception as exc:
        raise ContextInvalid() from exc


def bound_context(context, target=None, historical=False):
    """Never let one asset's draft history leak into a pinned dependency."""
    result = dict(context)
    result['business'] = dict(context['business'], history=None)
    # Unknown/not applicable is distinct from an explicitly bound empty history.
    # Existing View CompiledDrafts must pass the exact active-history reference gate.
    if 'view' in context: result['view'] = dict(context['view'], deleted_node_ids=None)
    if not historical:
        key = identity(target or context['current'])
        histories = [h for h in context['histories'] if identity(h['target']) == key]
        if histories:
            history=histories[0]
            prior=history['previous_ref']
            body=history['business_history']
            bound=prior is None and body is None and context['current']['active_version']==0
            if prior is not None:
                content,status=resolve_asset(prior,context)
                bound=(identity(prior)==key and prior['version']==context['current']['active_version'] and status=='ok'
                       and (body is None or content==body['previous_spec']))
                if bound and body is not None:
                    from business import validate_business
                    bound=(not validate_structure('business-schema/v1','spec',content)
                           and not validate_business(content,result,''))
            if bound:
                result['business']['history'] = body
                if 'view' in result: result['view']['deleted_node_ids'] = history['deleted_node_ids']
    return result
