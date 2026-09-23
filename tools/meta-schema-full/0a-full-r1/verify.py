#!/usr/bin/env python3
"""Offline, dual-engine structural acceptance; never a complete/runtime validator."""
import argparse
import hashlib
import importlib.util
import json
import re
from pathlib import Path
import subprocess
import sys
from datetime import datetime, timezone

from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

ROOT = Path(__file__).resolve().parents[3]
BUNDLE = ROOT / 'contracts/meta-schemas/0a-full-r1'
CASES = ROOT / 'tests/meta-schema-full/0a-full-r1'
PREFIX = 'urn:kvvi:meta-schema:0a-full-r1:'
NAMES = ['business-schema.v1', 'view-schema.lce-safe-v1', 'app-spec.v1alpha1',
         'permission-spec.v1alpha1', 'workflow-spec.v1alpha1', 'app-model-command.v1alpha1',
         'tool-spec.v1alpha1', 'migration-plan.v1alpha1', 'migration-run-event.v1alpha1',
         'artifact-manifest.v1alpha1', 'approval-attestation.v1alpha1',
         'promotion-record.v1alpha1', 'evidence-bundle.v1alpha1']
ENTRY = {'spec': 'Spec', 'compiled-draft': 'CompiledDraft', 'registered': 'RegisteredContract'}
BASELINE = 'docs/PRD-AI无代码平台设计-v1.11.md'
REQUIRED_SOURCES = {
    'docs/superpowers/specs/' + name for name in [
        '2026-09-11-0a-5-meta-schemas-design.md',
        '2026-09-11-0a-5-shared-dictionary.md',
        '2026-09-11-0a-5-permission-workflow-dictionary.md',
        '2026-09-11-0a-5-command-tool-dictionary.md',
        '2026-09-11-0a-5-migration-dictionary.md',
        '2026-09-11-0a-5-release-dictionary.md',
        '2026-09-15-0a-5-machine-delivery-scope.md',
        '2026-09-15-0a-5-uuid-profile-r1.md']}
BASELINE_SHA = 'd517617a0c500713897e7d6c88b5894d4c802e6362ecf68631ba88776750993b'

# Reuse the already locked format profile and schema-keyword policy, not validation results.
sys.path.insert(0, str(ROOT / 'tools/meta-schema/python'))
from structure import FORMAT_CHECKER as CORE_FORMAT_CHECKER
from expressions import business_budget_errors
from view_safety import view_preflight, walk, is_i18n_path
policy_spec = importlib.util.spec_from_file_location('core_schema_policy', ROOT / 'tools/meta-schema/verify_bundle.py')
policy = importlib.util.module_from_spec(policy_spec)
policy_spec.loader.exec_module(policy)


# Suite-local profile: preserve all core formats without mutating the core checker.
FORMAT_CHECKER = FormatChecker()
FORMAT_CHECKER.checkers = CORE_FORMAT_CHECKER.checkers.copy()
UUID_PATTERN = re.compile(r"[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}")
FORMAT_CHECKER.checks("uuid")(lambda value: not isinstance(value, str) or UUID_PATTERN.fullmatch(value) is not None)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def pairs(items):
    result = {}
    for key, value in items:
        if key in result:
            raise ValueError('duplicate JSON key')
        result[key] = value
    return result


def read(path):
    if path.is_symlink():
        raise ValueError('symlink not accepted')
    return json.loads(path.read_text(encoding='utf-8'), object_pairs_hook=pairs,
                      parse_constant=lambda value: (_ for _ in ()).throw(ValueError('non-JSON constant')))


def load_bundle(bundle=BUNDLE):
    manifest = read(bundle / 'manifest.json')
    expected = {'common.schema.json'} | {n + '.schema.json' for n in NAMES}
    if set(manifest) != {'suite_revision', 'validation_scope', 'baseline', 'sources', 'resources'}:
        raise ValueError('invalid manifest keys')
    if manifest['suite_revision'] != '0a-full-r1' or manifest['validation_scope'] != 'structure':
        raise ValueError('invalid suite or validation scope')
    if set(manifest['resources']) != expected or {p.name for p in bundle.glob('*.schema.json')} != expected:
        raise ValueError('expected 13 protocols and one common resource')
    if manifest['baseline'] != {'path': BASELINE, 'sha256': BASELINE_SHA} or sha(ROOT / BASELINE) != BASELINE_SHA:
        raise ValueError('frozen baseline mismatch')
    sources = manifest['sources']
    if (not isinstance(sources, list) or any(not isinstance(s, dict) or set(s) != {'path', 'sha256'} for s in sources)
            or len(sources) != len(REQUIRED_SOURCES) or {s['path'] for s in sources} != REQUIRED_SOURCES):
        raise ValueError('required design source inventory mismatch')
    for source in sources:
        path = ROOT / source['path']
        if not path.resolve().is_relative_to(ROOT) or path.is_symlink() or sha(path) != source['sha256']:
            raise ValueError('design source mismatch')
    schemas = {}
    for name, meta in manifest['resources'].items():
        if set(meta) != {'id', 'sha256'} or sha(bundle / name) != meta['sha256']:
            raise ValueError('schema byte digest mismatch: ' + name)
        schema = read(bundle / name)
        wanted = PREFIX + name.removesuffix('.schema.json').replace('.', '-')
        if schema.get('$id') != wanted or meta['id'] != wanted or schema.get('$schema') != policy.DIALECT:
            raise ValueError('schema identity mismatch: ' + name)
        Draft202012Validator.check_schema(schema)
        policy.walk_schema(schema, name)
        schemas[name] = schema
    by_id = {s['$id']: s for s in schemas.values()}
    if len(by_id) != 14:
        raise ValueError('duplicate schema identifier')
    for name, schema in schemas.items():
        policy.walk_refs(schema, schema['$id'], by_id, name)
        if name != 'common.schema.json' and schema.get('$defs', {}).get('AssetRef') != {'$ref': PREFIX + 'common#/$defs/AssetRef'}:
            raise ValueError('shared AssetRef alias missing or forked: ' + name)
    registry = Registry().with_resources((key, Resource.from_contents(value)) for key, value in by_id.items())
    return manifest, schemas, registry


def _verify():
    manifest, schemas, registry = load_bundle()
    cases = []
    fixture_files = sorted(CASES.glob('*-cases.json'))
    for path in fixture_files:
        cases.extend(read(path))
    inventory = read(CASES / 'expected-inventory.json')
    if set(inventory) != {'files', 'cases'} or inventory['files'] != {p.name: sha(p) for p in fixture_files}:
        raise ValueError('fixed fixture inventory mismatch')
    if len({case['id'] for case in cases}) != len(cases) or sorted(c['id'] for c in cases) != inventory['cases']:
        raise ValueError('case identity inventory mismatch')
    names = set()
    positive = set()
    negative = set()
    python_results = []
    before = json.dumps(cases, ensure_ascii=False, sort_keys=True)
    for case in cases:
        if set(case) != {'id', 'schema', 'entry', 'valid', 'value', 'reason'} or type(case['valid']) is not bool:
            raise ValueError('invalid case definition')
        name = case['schema']
        if name not in schemas or name == 'common.schema.json':
            raise ValueError('unknown protocol in case')
        entry = case['entry']
        if entry not in {*ENTRY, 'record', 'command'}:
            raise ValueError('unknown entry in case')
        reference = schemas[name]['$id']
        if entry in ENTRY:
            reference += '#/$defs/' + ENTRY[entry]
        value = case['value']
        spec = value if entry == 'spec' else value.get('spec') if isinstance(value, dict) else None
        prefix = '' if entry == 'spec' else 'spec'
        # Preserve core's published structural pipeline, not merely its raw Schema.
        # These existing iterative checks precede recursive validators; exceptions
        # remain execution faults and are never converted into expected rejection.
        preflight = []
        if name == 'business-schema.v1.schema.json':
            preflight = business_budget_errors(spec, prefix)
        elif name == 'view-schema.lce-safe-v1.schema.json':
            preflight = view_preflight(spec, prefix)
        validator = Draft202012Validator({'$ref': reference}, registry=registry, format_checker=FORMAT_CHECKER)
        valid = not preflight and validator.is_valid(value)
        if valid and name == 'view-schema.lce-safe-v1.schema.json':
            # Core's dynamic property slots require the same typed-node second pass.
            # Resolve definitions from this verified full bundle, never the old
            # bundle's validator or stored expected results.
            kinds = {'FieldRef', 'I18nRef', 'SafeExpression', 'ActionRef', 'DataQueryRef', 'DataBindingRef'}
            for item, path in walk(value):
                if isinstance(item, dict) and not is_i18n_path(path) and item.get('type') in kinds:
                    local_ref = schemas[name]['$id'] + '#/$defs/' + item['type']
                    local = Draft202012Validator({'$ref': local_ref}, registry=registry, format_checker=FORMAT_CHECKER)
                    if not local.is_valid(item):
                        valid = False
                        break
        python_results.append({'id': case['id'], 'valid': valid})
        names.add(name)
        (positive if case['valid'] else negative).add(name)
    expected_names = {n + '.schema.json' for n in NAMES}
    if names != expected_names or positive != expected_names or negative != expected_names:
        raise ValueError('each of 13 protocols needs positive and negative cases')
    if before != json.dumps(cases, ensure_ascii=False, sort_keys=True):
        raise ValueError('Python validation modified test inputs')
    run = subprocess.run(['node', str(ROOT / 'tools/meta-schema-full/0a-full-r1/verify-node.mjs')],
                         input=json.dumps({'schemas': schemas, 'cases': cases}, ensure_ascii=False).encode(),
                         capture_output=True, timeout=90, cwd=ROOT)
    if run.returncode:
        raise RuntimeError('Node structural execution failed')
    node_results = json.loads(run.stdout)
    if len(node_results) != len(cases) or any(set(r) != {'id', 'valid'} or type(r['valid']) is not bool for r in node_results):
        raise ValueError('invalid Node result inventory')
    if [r['id'] for r in node_results] != [c['id'] for c in cases]:
        raise ValueError('Node case order/identity mismatch')
    py_bad = [c['id'] for c, r in zip(cases, python_results) if c['valid'] != r['valid']]
    js_bad = [c['id'] for c, r in zip(cases, node_results) if c['valid'] != r['valid']]
    files = list(BUNDLE.glob('*.json')) + fixture_files + [CASES / 'expected-inventory.json']
    files += list((ROOT / 'tools/meta-schema-full/0a-full-r1').glob('*.*')) + [Path(__file__), CASES / 'test_structure.py']
    files += [ROOT / 'tools/meta-schema/node/package-lock.json', ROOT / 'tools/meta-schema/python/requirements.lock',
              ROOT / 'tools/meta-schema/python/values.py', ROOT / 'tools/meta-schema/node/values.mjs',
              ROOT / 'tools/meta-schema/python/structure.py', ROOT / 'tools/meta-schema/verify_bundle.py',
              ROOT / '.github/workflows/meta-schema-files.yml']
    files += [ROOT / ('tools/meta-schema/python/' + n + '.py') for n in ['expressions', 'view_safety', 'diagnostics', 'safe_pattern']]
    files += [ROOT / ('tools/meta-schema/node/' + n + '.mjs') for n in ['expressions', 'view_safety', 'diagnostics', 'safe_pattern']]
    files += [ROOT / s['path'] for s in manifest['sources']]
    git = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    dirty = bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT, text=True).strip())
    return {'suite_revision': '0a-full-r1', 'validated_at': datetime.now(timezone.utc).isoformat(),
            'source_commit': git, 'worktree_dirty': dirty, 'validation_scope': 'structure',
            'protocols': 13, 'schema_resources': 14, 'cases': len(cases),
            'positive_cases': sum(c['valid'] for c in cases), 'negative_cases': sum(not c['valid'] for c in cases),
            'python_mismatches': py_bad, 'node_mismatches': js_bad, 'valid': not (py_bad or js_bad),
            'python_results': python_results, 'node_results': node_results,
            'semantic_validation_complete': False, 'runtime_verified': False, 'release_approved': False,
            'files': {str(p.relative_to(ROOT)): sha(p) for p in sorted(set(files)) if p.is_file()},
            'baseline': manifest['baseline'], 'known_limits': ['M-4 remains OPEN', 'Core UUID divergence remains OPEN: issue #8', 'No complete validator for ten new protocols']}


def verify():
    try:
        return _verify()
    except Exception as exc:
        raise RuntimeError("Structural verification failed (" + type(exc).__name__ + ")") from None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    try:
        report = verify()
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            with args.output.open('x', encoding='utf-8') as stream:
                json.dump(report, stream, ensure_ascii=False, indent=2)
                stream.write('\n')
        print(json.dumps({k: v for k, v in report.items() if k not in {'files', 'python_results', 'node_results'}}, ensure_ascii=False))
        return 0 if report['valid'] else 2
    except Exception as exc:
        print(json.dumps({'valid': False, 'execution_failed': True, 'error_type': type(exc).__name__,
                          'message': 'Validation execution failed; inspect inputs locally without publishing their contents', 'release_approved': False}, ensure_ascii=False))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
