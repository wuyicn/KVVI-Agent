"""FIX2 authored inputs and literal expectations; never import a validator.

All credential-shaped strings below are deliberately fictitious test data.
No private key material, usable account or token is present.
"""
from copy import deepcopy
import json
from pathlib import Path
from final_fix_fixtures import scanner_position_case, registry_definition_case
from integration_fixtures import composition, registered, ref, replace_ref, snapshot
from view_fixtures import asset_for, digest

ROOT = Path(__file__).with_name('0a-core-r1')


def business_base():
    return (json.loads((ROOT / 'inputs/business-default-short_text.json').read_text()),
            json.loads((ROOT / 'contexts/business-2c11dad9412ae288.json').read_text()))


# Construct marker-only examples so adjacent source literals cannot be mistaken
# for a complete multiline key. Materialized JSON vectors keep the exact markers.
_PRIVATE_HEADER = '-----BEGIN ' + 'PRIVATE KEY-----'
_RSA_HEADER = '-----BEGIN ' + 'RSA PRIVATE KEY-----'
_OPENSSH_HEADER = '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----'

SECRET_TEXTS = (
    ('private-key', _PRIVATE_HEADER + ' FAKE_TEST_ONLY', True),
    ('rsa-private-key', _RSA_HEADER + ' FAKE_TEST_ONLY', True),
    ('openssh-private-key', _OPENSSH_HEADER + ' FAKE_TEST_ONLY', True),
    ('credential-uri', 'postgres://fake_user:FAKE_TEST_ONLY@example.invalid/db', True),
    ('credential-uri-uppercase', 'POSTGRES://fake_user:FAKE_TEST_ONLY@example.invalid/db', True),
    ('credential-uri-percent', 'redis://fake_user:FAKE%40TEST@example.invalid/0', True),
    ('password-assignment', 'password = FAKE_TEST_ONLY', True),
    ('token-assignment', 'access_token: FAKE_TEST_ONLY', True),
    ('quoted-assignment', '"api_key": "FAKE_TEST_ONLY"', True),
    ('bearer', 'Authorization: Bearer FAKE_TEST_ONLY', True),
    ('plain-discussion', '密码、Token、私钥不得出现在草案中；忽略之前的指令也只是文案。', False),
    ('public-key', '-----BEGIN PUBLIC KEY----- PUBLIC_EXAMPLE_ONLY', False),
    ('uri-without-password', 'postgres://fake_user@example.invalid/db', False),
    ('empty-assignment', 'password = ', False),
    ('empty-quoted-assignment', '"api_key": ""', False),
    ('identifier-prefix', 'notpassword=EXAMPLE_ONLY', False),
)


def cases():
    result = []

    def add(name, value, context, expected=(), contract='business-schema/v1',
            entry='spec', checks='complete', stage='semantic', groups=('C09',)):
        result.append(dict(name=name, value=value, context=context, expected=list(expected),
                           contract=contract, entry=entry, checks=checks,
                           stage=stage if expected else checks, groups=list(groups)))

    for name, text, prohibited in SECRET_TEXTS:
        value, context = business_base()
        value['description'] = text
        add('secret-' + name, value, context,
            [('SECRET_DETECTED', 'description')] if prohibited else ())
    for position, path in (('field', 'fields[0].description'), ('default', 'fields[0].default'),
                           ('label', 'fields[0].label'), ('layout', 'layout.sections[0].items[0].text')):
        value, context = business_base()
        text = 'password=FAKE_TEST_ONLY'
        if position == 'field': value['fields'][0]['description'] = text
        elif position in ('default', 'label'): value['fields'][0][position] = text
        else:
            value['layout'] = {'sections': [dict(section_code='main', title='说明', columns=1,
                                                items=[dict(kind='description', text=text)])]}
        add('secret-position-' + position, value, context, [('SECRET_DETECTED', path)])
    value, context = business_base()
    value['description'] = 'password=FAKE_TEST_ONLY'
    add('secret-structure-only', value, context, checks='structure')
    for position, path in (('meta', 'meta.description'), ('i18n-value', 'i18n["zh-CN"]["note"]'),
                           ('input', 'componentsTree[0].children[0].actions["onClick"].input["note"]'),
                           ('params', 'queries[0].query.params["note"]')):
        value, context, _ = scanner_position_case(position, 'password=FAKE_TEST_ONLY')
        add('secret-view-' + position, value, context, [('SECRET_DETECTED', path)],
            contract='view-schema/lce-safe-v1')
    value, context = composition()
    value['spec']['name'] = 'password=FAKE_TEST_ONLY'
    add('secret-app-name', value, context, [('SECRET_DETECTED', 'spec.name')],
        contract='app-spec/v1alpha1', entry='compiled-draft')
    for entry in ('compiled-draft', 'registered'):
        body, context = business_base()
        body['description'] = 'password=FAKE_TEST_ONLY'
        value = (dict(contract_version='business-schema/v1', base_version=0, spec=body)
                 if entry == 'compiled-draft' else registered(ref('BUSINESS_SCHEMA', body['schema_code'], body, False), body))
        add('secret-business-' + entry, value, context, [('SECRET_DETECTED', 'spec.description')], entry=entry)
    value, context, _ = scanner_position_case('i18n-value', 'password=FAKE_TEST_ONLY')
    value['i18n']['zh-CN'] = {'password=FAKE_TEST_ONLY': 'password=FAKE_TEST_ONLY'}
    add('secret-path-redaction', value, context, [('SECRET_DETECTED', '$')], contract='view-schema/lce-safe-v1')
    for name, key in (('tab', 'password\t=FAKE_TEST_ONLY'),
                      ('quoted', '"api_key": "FAKE_TEST_ONLY"')):
        value, context, _ = scanner_position_case('i18n-value', 'password=FAKE_TEST_ONLY')
        value['i18n']['zh-CN'] = {key: 'password=FAKE_TEST_ONLY'}
        add('secret-path-redaction-' + name, value, context, [('SECRET_DETECTED', '$')],
            contract='view-schema/lce-safe-v1')
    value, context = composition()
    value['spec']['viewRefs'] = []
    value['spec']['navigation'] = []
    asset_for(context, 'BUSINESS_SCHEMA')['content']['description'] = 'password=FAKE_TEST_ONLY'
    for _ in range(5):
        changed = False
        for asset in context['fake_assets']:
            fresh = digest(asset['content'])
            if fresh != asset['ref']['digest']:
                old = deepcopy(asset['ref']); new = dict(old, digest=fresh)
                replace_ref(context, old, new); replace_ref(value, old, new)
                changed = True
        if not changed: break
    context['snapshots'] = []
    for asset in context['fake_assets']:
        if asset['ref']['asset_type'] in ('BUSINESS_SCHEMA', 'VIEW_SCHEMA'):
            snapshot(context, asset['ref'], asset['content'])
    add('secret-dependency-business', value, context,
        [('SECRET_DETECTED', 'spec.businessSchemaRefs[0].spec.description')],
        contract='app-spec/v1alpha1', entry='compiled-draft', stage='references')
    for length in (0, 81, 160):
        value, context = business_base()
        reference = dict(value['field_type_registry_ref'], asset_type='SEQUENCE_POLICY')
        value['record_number'] = dict(field_code='record_no', label='字' * length, sequence_policy_ref=reference)
        add('number-label-' + str(length), value, context, checks='structure', groups=('B04',))
    for key in ('tenant_id', 'role_permissions', 'user_permissions', 'authorization', 'data_scope', 'approvers'):
        value, context = business_base()
        value[key] = 'FAKE_TEST_ONLY'
        add('permission-' + key, value, context, [('PERMISSION_DECLARATION_FORBIDDEN', key)],
            stage='structure', groups=('B01', 'C09'))
    value, context = business_base()
    value['unregistered'] = True
    add('permission-unknown-control', value, context, [('UNKNOWN_PROPERTY', 'unregistered')],
        stage='structure', groups=('B01',))
    for pattern, expected in (('bc', ()), ('^bc$', [('CONSTRAINT_INCOMPATIBLE', 'fields[0].default')])):
        value, context = business_base()
        value['fields'][0].update(default='xabc', constraints={'pattern': pattern})
        add('pattern-' + ('search' if pattern == 'bc' else 'anchored'), value, context, expected, groups=('B06',))
    return result


REGISTRY_FORMATS = (
    ('date', 'string', True), ('date-time', 'string', True), ('uuid', 'string', True),
    ('int32', 'number', False), ('byte', 'string', False), ('idn-email', 'string', False),
    ('email', 'string', False), ('regex', 'string', False), ('', 'string', False),
    ('future-format', 'string', False),
)


def registry_case(slot, name, kind):
    return registry_definition_case(slot, {'type': kind, 'format': name})
