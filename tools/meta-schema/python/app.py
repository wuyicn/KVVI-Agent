"""D06 local App composition rules. Reference content checks follow separately."""
from diagnostics import diagnostic, sorted_unique
from secret_safety import validate_secrets


def validate_app(spec, context, prefix):
    errors = validate_secrets(spec, prefix)
    def add(path):
        errors.append(diagnostic('APPSPEC_INVALID', (prefix + '.' if prefix not in ('', '$') else '') + path))
    for slot in ('businessSchemaRefs', 'viewRefs', 'workflowRefs', 'permissionRefs'):
        seen = set()
        for i, ref in enumerate(spec[slot]):
            identity = tuple(ref[k] for k in ('scope_type', 'scope_id', 'app_id', 'module_id', 'asset_type', 'asset_id'))
            if identity in seen: add(f'{slot}[{i}]')
            seen.add(identity)
    codes, paths = set(), set()
    for i, route in enumerate(spec['navigation']):
        if route['route_code'] in codes: add(f'navigation[{i}].route_code')
        if route['path'] in paths: add(f'navigation[{i}].path')
        codes.add(route['route_code']); paths.add(route['path'])
        if route['viewRef'] not in spec['viewRefs']: add(f'navigation[{i}].viewRef')
    return sorted_unique(errors)
