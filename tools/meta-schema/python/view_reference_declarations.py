"""Project trusted Schema reference declarations; engines decide applicability."""
from jsonschema import Draft202012Validator
from jsonschema._utils import find_evaluated_property_keys_by_schema
from referencing.jsonschema import DRAFT202012

from structure import load_bundle, FORMAT_CHECKER
from view_safety import child_path, DYNAMIC

BASE_KEYS = {'scope_type','scope_id','app_id','module_id','asset_type','version','digest'}
REF_LAYOUTS = (BASE_KEYS | {'asset_id'}, BASE_KEYS | {'capability_code'})


def declared_parameter_refs(root, value, prefix):
    schemas, registry = load_bundle()
    common = schemas['common.schema.json']
    terminals = {id(common['$defs'][name]) for name in ('AssetRef','CapabilityRef')}
    root_id = root.get('$id','urn:kvvi:tool-private:parameter-input')
    registry = registry.with_resource(root_id,DRAFT202012.create_resource(root))
    visited = set()

    def engine(schema, resolver):
        return Draft202012Validator(schema,registry=registry,format_checker=FORMAT_CHECKER,_resolver=resolver)

    def constant(declaration, instance, path, dynamic):
        if isinstance(declaration,dict):
            if any(set(declaration)==layout for layout in REF_LAYOUTS):
                yield instance,path
                return
            for key, nested in declaration.items():
                yield from constant(nested,instance[key],child_path(path,key,dynamic),key in DYNAMIC)
        elif isinstance(declaration,list):
            for index,nested in enumerate(declaration):
                yield from constant(nested,instance[index],child_path(path,index),False)

    def project(schema, instance, path, resolver, dynamic=False, entered=False):
        key=(id(schema),path)
        if key in visited or isinstance(schema,bool):return
        visited.add(key)
        if id(schema) in terminals:
            yield instance,path
            return
        if not entered:
            resolver=resolver.in_subresource(DRAFT202012.create_resource(schema))
        validator=engine(schema,resolver)
        if '$ref' in schema:
            resolved=resolver.lookup(schema['$ref'])
            yield from project(resolved.contents,instance,path,resolved.resolver,dynamic,True)
        # Recursive dependencies reach projection before their parameter check.
        # Only a matching const can supply instance locations; validate_view
        # still reports mismatches through the registered inputSchema.
        if 'const' in schema and validator.evolve(schema={'const':schema['const']}).is_valid(instance):
            yield from constant(schema['const'],instance,path,dynamic)
        for keyword in ('allOf','anyOf','oneOf'):
            for branch in schema.get(keyword,[]):
                # Applicability is determined by the registered real engine.
                if keyword=='allOf' or validator.evolve(schema=branch).is_valid(instance):
                    yield from project(branch,instance,path,resolver,dynamic)
        if 'if' in schema:
            matched=validator.evolve(schema=schema['if']).is_valid(instance)
            if matched:yield from project(schema['if'],instance,path,resolver,dynamic)
            branch='then' if matched else 'else'
            if branch in schema:yield from project(schema[branch],instance,path,resolver,dynamic)
        if isinstance(instance,dict):
            properties=schema.get('properties',{})
            for prop,subschema in properties.items():
                if prop in instance:
                    yield from project(subschema,instance[prop],child_path(path,prop,dynamic),resolver,prop in DYNAMIC)
            matched=set(properties)
            for pattern,subschema in schema.get('patternProperties',{}).items():
                for prop,item in instance.items():
                    if engine({'pattern':pattern},resolver).is_valid(prop):
                        matched.add(prop)
                        yield from project(subschema,item,child_path(path,prop,dynamic),resolver,prop in DYNAMIC)
            if 'additionalProperties' in schema:
                for prop in instance.keys()-matched:
                    yield from project(schema['additionalProperties'],instance[prop],child_path(path,prop,dynamic),resolver,prop in DYNAMIC)
            for prop,subschema in schema.get('dependentSchemas',{}).items():
                if prop in instance:yield from project(subschema,instance,path,resolver,dynamic)
            if 'unevaluatedProperties' in schema:
                # Exclude this keyword's own annotation; otherwise every key is evaluated.
                without={k:v for k,v in schema.items() if k!='unevaluatedProperties'}
                evaluated=set(find_evaluated_property_keys_by_schema(validator.evolve(schema=without),instance,without))
                for prop in instance.keys()-evaluated:
                    yield from project(schema['unevaluatedProperties'],instance[prop],child_path(path,prop,dynamic),resolver,prop in DYNAMIC)
        elif isinstance(instance,list):
            heads=schema.get('prefixItems',[])
            for index,subschema in enumerate(heads[:len(instance)]):
                yield from project(subschema,instance[index],child_path(path,index),resolver)
            if 'items' in schema:
                for index in range(len(heads),len(instance)):
                    yield from project(schema['items'],instance[index],child_path(path,index),resolver)
            if 'contains' in schema:
                for index,item in enumerate(instance):
                    if validator.evolve(schema=schema['contains']).is_valid(item):
                        yield from project(schema['contains'],item,child_path(path,index),resolver)

    yield from project(root,value,prefix,registry.resolver(root_id),True,True)
