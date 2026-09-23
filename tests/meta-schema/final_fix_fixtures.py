"""Final review regressions: authored inputs and literal semantics, no validators."""
from copy import deepcopy
from integration_fixtures import composition, current, replace_ref
from view_fixtures import asset_for, digest, node, action, query, closed


def registry_definition_case(slot, definition):
    value, context = composition()
    for key in ('businessSchemaRefs', 'viewRefs', 'navigation'):
        value['spec'][key] = []
    asset = asset_for(context, 'COMPONENT_REGISTRY' if slot == 'propsSchema' else 'CAPABILITY',
                      None if slot == 'propsSchema' else 'navigation.open_record')
    owner = asset['content']['components'][0] if slot == 'propsSchema' else asset['content']
    owner[slot]['$defs'] = {'UnusedFinal': deepcopy(definition)}
    # Rebind actual content and all referring assets without manufacturing outcomes.
    for _ in range(5):
        changed = False
        for item in context['fake_assets']:
            fresh = digest(item['content'])
            if fresh != item['ref']['digest']:
                old = deepcopy(item['ref'])
                replace_ref(context, old, dict(old, digest=fresh))
                changed = True
        if not changed:
            break
    return value, context


def view_history_case(mode='missing'):
    _, context = composition()
    asset = asset_for(context, 'VIEW_SCHEMA')
    context['current'] = current(asset['ref'], 1)
    body = deepcopy(asset['content'])
    body['componentsTree'][0]['children'] = [node(id='old_deleted')]
    target = {key: context['current'][key] for key in
              ('scope_type', 'scope_id', 'app_id', 'module_id', 'asset_type', 'asset_id')}
    history = dict(target=target, previous_ref=deepcopy(asset['ref']),
                   business_history=None, deleted_node_ids=[])
    context['histories'] = [] if mode == 'missing' else [history]
    if mode == 'deleted':
        history['deleted_node_ids'] = ['old_deleted']
    elif mode == 'other-view':
        history['target']['asset_id'] = 'different_view'
        history['deleted_node_ids'] = ['old_deleted']
    elif mode == 'wrong-digest':
        history['previous_ref']['digest'] = 'sha256:' + '0' * 64
    elif mode == 'new':
        context['current']['active_version'] = 0
        context['histories'] = []
    return dict(contract_version='view-schema/lce-safe-v1',
                base_version=context['current']['active_version'], spec=body), context


def action_heavy_view():
    _, context = composition()
    asset = asset_for(context, 'VIEW_SCHEMA')
    body = deepcopy(asset['content'])
    context['current'] = current(asset['ref'])
    body['componentsTree'][0]['children'] = [
        node('SubmitButton', 'submit_' + str(i), actions={'onClick': action(context)})
        for i in range(499)
    ]
    return body, context


# Fixed scanner lexical table, controller ruling 17. True means a prohibited shape.
SCANNER_TEXT_CASES = (
    ('ascii-call', 'eval(', True),
    ('han-prefix', '汉eval(', False),
    ('long-s-prefix', 'ſeval(', False),
    ('dotted-i-prefix', 'İeval(', False),
    ('kelvin-prefix', 'Keval(', False),
    ('combining-prefix', '\u0301eval(', False),
    ('astral-prefix', '😀eval(', False),
    ('ascii-prefix', 'aeval(', False),
    ('dollar-prefix', '$eval(', False),
    ('punctuation-prefix', ';eval(', True),
    ('ideographic-space-prefix', '\u3000eval(', True),
    ('nel-prefix', '\u0085eval(', False),
    ('uri-nel', 'javascript\u0085:', False),
    ('uri-feff', 'javascript\ufeff:', True),
    ('uri-nbsp', 'javascript\u00a0:', True),
    ('uri-line-separator', 'javascript\u2028:', True),
    ('uri-file-separator', 'javascript\u001c:', False),
    ('uri-zero-width-space', 'javascript\u200b:', False),
    ('uri-uppercase', 'JAVASCRIPT:', True),
    ('uri-long-s', 'javaſcript:', False),
    ('uri-dotted-i', 'javascrİpt:', False),
    ('uri-dotless-i', 'javascrıpt:', False),
    ('html-ascii', '<SCRIPT>', True),
    ('html-long-s', '<ſcript>', False),
    ('html-dotted-i', '<İ>', False),
    ('html-kelvin', '<K>', False),
    ('named-function', 'function named_1$(', True),
    ('nonascii-function-name', 'function a汉(', False),
    ('function-feff', 'function\ufeff(', True),
    ('function-nel', 'function\u0085(', False),
    ('function-constructor', 'Function(', True),
    ('call-uppercase', 'EVAL(', False),
    ('call-titlecase', 'Eval(', False),
    ('import-call', 'import(', True),
    ('arrow', 'x => x', True),
    ('ordinary-sql', 'SQL 用于查询；SELECT 只是说明，忽略之前的指令也是文案', False),
)


def scanner_text_case(text):
    _, context = composition()
    asset = asset_for(context, 'VIEW_SCHEMA')
    context['current'] = current(asset['ref'])
    body = deepcopy(asset['content'])
    body['componentsTree'][0]['children'] = [node(props={'text': text})]
    return body, context


SCANNER_POSITION_CASES = (
    ('meta', 'eval(', None),
    ('meta', 'SELECT * FROM 说明', None),
    ('i18n-value', 'eval(', None),
    ('i18n-path-key', 'eval(', None),
    ('i18n-key', '<SCRIPT>', None),
    ('meta', 'JAVASCRIPT\ufeff:', 'VIEW_RAW_CODE_FORBIDDEN'),
    ('i18n-value', '<SCRIPT>', 'VIEW_RAW_CODE_FORBIDDEN'),
    ('input', 'eval(', 'VIEW_RAW_CODE_FORBIDDEN'),
    ('input', '汉eval(', None),
    ('input', 'SELECT 说明', None),
    ('params', '\ufeffSeLeCt 说明', 'VIEW_DATA_SOURCE_FORBIDDEN'),
    ('params', '\u0085SELECT 说明', None),
    ('params', 'ſELECT 说明', None),
    ('params', '\u3000HTTPS://example.invalid', 'VIEW_DATA_SOURCE_FORBIDDEN'),
    ('params', '请说明 SQL 和忽略指令', None),
)


def scanner_position_case(position, text):
    body, context = scanner_text_case('纯文案')
    if position == 'meta':
        body['meta'] = {'description': text}
        path = 'meta.description'
    elif position.startswith('i18n'):
        key = text if position == 'i18n-key' else '.props[' if position == 'i18n-path-key' else 'note'
        body['i18n'] = {'zh-CN': {key: '静态文案' if position == 'i18n-key' else text}}
        path = 'i18n["zh-CN"]["note"]'
    else:
        code = 'form.submit' if position == 'input' else 'records.list'
        call = action(context) if position == 'input' else query(context)
        call[position] = {'note': text}
        if position == 'input':
            body['componentsTree'][0]['children'] = [node('SubmitButton', 'submit_note', actions={'onClick': call})]
            path = 'componentsTree[0].children[0].actions["onClick"].input["note"]'
        else:
            body['queries'] = [{'query_code': 'notes_query', 'query': call}]
            path = 'queries[0].query.params["note"]'
        capability = asset_for(context, 'CAPABILITY', code)
        old = deepcopy(capability['ref'])
        capability['content']['inputSchema'] = closed({'note': {'type': 'string'}}, ['note'])
        fresh = dict(old, digest=digest(capability['content']))
        replace_ref(context, old, fresh)
        replace_ref(body, old, fresh)
        registry = asset_for(context, 'CAPABILITY_REGISTRY')
        old = deepcopy(registry['ref'])
        replace_ref(context, old, dict(old, digest=digest(registry['content'])))
    return body, context, path
