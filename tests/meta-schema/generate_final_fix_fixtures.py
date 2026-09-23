#!/usr/bin/env python3
"""Final review literal witnesses. Seed 0; no runner or validator imports."""
import hashlib
import json
from pathlib import Path
from final_fix_fixtures import (
    SCANNER_TEXT_CASES, SCANNER_POSITION_CASES, scanner_text_case,
    scanner_position_case, view_history_case, action_heavy_view,
)

DEST = Path(__file__).with_name('0a-core-r1')
OWNER = Path(__file__).name


def main():
    table = json.loads((DEST / 'cases.json').read_text())
    original = [case for case in table['cases'] if case.get('generated_by') != OWNER]
    additions = []

    def add(name, body, context, groups, code=None, path=None, entry='spec', stage='structure'):
        name = 'FR-' + name
        raw = (json.dumps(body, ensure_ascii=False, indent=2) + '\n').encode()
        input_path = 'inputs/' + name + '.json'
        (DEST / input_path).write_bytes(raw)
        context_raw = (json.dumps(context, ensure_ascii=False, indent=2) + '\n').encode()
        context_path = 'contexts/final-fix-' + hashlib.sha256(context_raw).hexdigest()[:16] + '.json'
        (DEST / context_path).write_bytes(context_raw)
        additions.append(dict(
            id=name, groups=groups + ['FinalReview'], generated_by=OWNER,
            input=input_path, context=context_path, contract='view-schema/lce-safe-v1',
            entry=entry, checks='complete', expected_stage=stage if code else 'complete',
            expected=dict(suite_revision='0a-core-r1', entry=entry, checks='complete',
                          exit_code=2 if code else 0, valid=code is None,
                          errors=[dict(code=code, severity='ERROR', path=path)] if code else []),
        ))

    add('I3-500-actions', *action_heavy_view(), ['V02', 'V08', 'C05'])
    for mode, code, path, stage in (
        ('missing', 'REFERENCE_INVALID', 'base_version', 'references'),
        ('other-view', 'REFERENCE_INVALID', 'base_version', 'references'),
        ('wrong-digest', 'REFERENCE_INVALID', 'spec.view_code', 'references'),
        ('empty', None, None, 'complete'),
        ('new', None, None, 'complete'),
        ('deleted', 'VIEW_NODE_ID_DUPLICATE', 'spec.componentsTree[0].children[0].id', 'semantic'),
    ):
        add('I2-' + mode, *view_history_case(mode), ['V03', 'C07'], code, path,
            entry='compiled-draft', stage=stage)
    draft, context = view_history_case('missing')
    context['current']['active_version'] = 2
    add('I2-spec-unused-active', draft['spec'], context, ['C07', 'V03'])
    old = next(s['registered'] for s in context['snapshots'] if s['ref']['asset_type'] == 'VIEW_SCHEMA')
    add('I2-registered-historical', old, context, ['C03', 'C07'], entry='registered')
    for name, text, prohibited in SCANNER_TEXT_CASES:
        add('I4-text-' + name, *scanner_text_case(text), ['V13', 'C09'],
            'VIEW_RAW_CODE_FORBIDDEN' if prohibited else None,
            'componentsTree[0].children[0].props["text"]')
    for index, (position, text, code) in enumerate(SCANNER_POSITION_CASES):
        body, context, path = scanner_position_case(position, text)
        add('I4-position-' + str(index) + '-' + position, body, context, ['V13', 'V06' if position.startswith('i18n') else 'C09'], code, path)
    ids = [case['id'] for case in original + additions]
    assert len(ids) == len(set(ids))
    table['cases'] = original + additions
    (DEST / 'cases.json').write_text(json.dumps(table, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'shared_cases': len(ids), 'preserved': len(original), 'added': len(additions)}))


if __name__ == '__main__':
    main()
