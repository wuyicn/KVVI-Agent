#!/usr/bin/env python3
"""Materialize FIX2 authored witnesses; never run validators or derive outcomes."""
import hashlib
import json
from pathlib import Path
from external_review_fix2_fixtures import cases

DEST = Path(__file__).with_name('0a-core-r1')
OWNER = Path(__file__).name


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode()


def main():
    table = json.loads((DEST / 'cases.json').read_text())
    original = [case for case in table['cases'] if case.get('generated_by') != OWNER]
    # Explicit M-1 normative correction, not outcomes learned from either engine.
    for case in original:
        if case['id'] in ('T5-record-number-label-0', 'T5-record-number-label-81'):
            case['expected'].update(exit_code=0, valid=True, errors=[])
            case['expected_stage'] = 'structure'
    additions = []
    for source in cases():
        name = 'FX2-' + source['name']
        input_path = 'inputs/' + name + '.json'
        (DEST / input_path).write_bytes(encoded(source['value']))
        context_raw = encoded(source['context'])
        context_path = 'contexts/fix2-' + hashlib.sha256(context_raw).hexdigest()[:16] + '.json'
        (DEST / context_path).write_bytes(context_raw)
        errors = [dict(code=code, severity='ERROR', path=path) for code, path in source['expected']]
        additions.append(dict(id=name, generated_by=OWNER, groups=source['groups'] + ['ExternalReviewFix2'],
            input=input_path, context=context_path, contract=source['contract'], entry=source['entry'],
            checks=source['checks'], expected_stage=source['stage'],
            expected=dict(suite_revision='0a-core-r1', entry=source['entry'], checks=source['checks'],
                          exit_code=2 if errors else 0, valid=not errors, errors=errors)))
    table['cases'] = original + additions
    assert len({case['id'] for case in table['cases']}) == len(table['cases'])
    (DEST / 'cases.json').write_bytes(encoded(table))
    print(json.dumps(dict(preserved_inputs=len(original), explicit_oracle_corrections=2,
                          added=len(additions), total=len(table['cases']))))


if __name__ == '__main__':
    main()
