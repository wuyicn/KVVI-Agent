#!/usr/bin/env python3
"""Source-bound, append-only evidence for the fixed 0A suite; never release approval."""
from __future__ import annotations
import argparse
from collections import Counter
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import sys
import time
import tempfile

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tests/meta-schema'))
import test_conformance as harness

SUITE = '0a-core-r1'
EVIDENCE = 'evidence/meta-schema/0a-core-r1'
INVENTORY = 'tests/meta-schema/expected-inventory.json'
COVERAGE = 'tests/meta-schema/coverage.json'
FIXED = {
    'AGENTS.md', 'docs/PRD-AI无代码平台设计-v1.11.md',
    'docs/superpowers/specs/2026-09-08-0a-meta-schema-core-design.md',
    'docs/superpowers/specs/2026-09-08-0a-meta-schema-core-traceability.md',
    'docs/baselines/prd-v1.11-go0.sha256', '.github/workflows/meta-schema-checks.yml', '.github/workflows/repository-checks.yml',
}
REQUIRED = {f'{prefix}{i:02}' for prefix, count in [('C',10),('B',23),('V',16),('A',8),('E',4)] for i in range(1,count+1)} - {'B16','V15','A08','E04'}


def digest(raw): return hashlib.sha256(raw).hexdigest()
def case_digest(case): return digest(json.dumps(case, ensure_ascii=False, sort_keys=True, separators=(',',':')).encode())
def require(condition, message):
    if not condition: raise ValueError(message)


def safe_path(root, name):
    require(type(name) is str and name and not Path(name).is_absolute() and '..' not in Path(name).parts and '\\' not in name, 'unsafe evidence path')
    path = root / name
    require(path.resolve().is_relative_to(root.resolve()), 'evidence path escapes root')
    current = path
    while current != root:
        require(not current.is_symlink(), 'symlink evidence path')
        current = current.parent
    return path


def source_path(name):
    if name in FIXED: return True
    parts = Path(name).parts
    if any(p in ('node_modules','__pycache__','.venv') for p in parts): return False
    return ((name.startswith('tools/meta-schema/') or name.startswith('tests/meta-schema/')) and Path(name).suffix in {'.py','.mjs','.json','.lock','.in','.raw'}
            or name.startswith('contracts/meta-schemas/0a-core-r1/') and Path(name).suffix == '.json'
            or name in {'contracts/meta-schemas/0a-core-r1/CONTEXT.md', 'contracts/meta-schemas/0a-core-r1/VIEW.md',
                        'contracts/meta-schemas/0a-core-r1/EXTERNAL-REVIEW-FIX2.md'}
            or name.startswith('protocol/kvvi-json-c14n/v1/evidence-sets/prd-v1.11/')
            or name.startswith('评审/') and Path(name).suffix in {'.md','.json'})


def git(root, *args):
    try: return subprocess.check_output(['git','-C',str(root),*args], stderr=subprocess.DEVNULL, timeout=30)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc: raise ValueError('source commit unavailable') from exc


def source_tree(root, commit):
    require(type(commit) is str and re.fullmatch('[0-9a-f]{40}', commit), 'invalid source commit')
    require(git(root,'rev-parse',commit+'^{commit}').decode().strip() == commit, 'invalid source identity')
    entries = {}
    for item in git(root,'ls-tree','-r','-z',commit).split(b'\0'):
        if not item: continue
        metadata, raw_name = item.split(b'\t',1)
        mode, kind, blob = metadata.decode().split()
        name = raw_name.decode()
        if source_path(name):
            require(mode == '100644' or mode == '100755', 'source is not a regular file')
            entries[name] = blob
    return entries


def current_source_files(root):
    names = set()
    for prefix in ('tools/meta-schema','tests/meta-schema','contracts/meta-schemas/0a-core-r1','protocol/kvvi-json-c14n/v1/evidence-sets/prd-v1.11','评审'):
        start = root / prefix
        if not start.exists(): continue
        for directory, folders, files in os.walk(start, followlinks=False):
            folders[:] = [f for f in folders if f not in {'node_modules','__pycache__','.venv'}]
            for folder in folders: require(not (Path(directory)/folder).is_symlink(), 'symlink source directory')
            for file in files:
                name = (Path(directory)/file).relative_to(root).as_posix()
                if source_path(name): names.add(name)
    names.update(name for name in FIXED if (root/name).exists())
    return names


def source_bindings(root, commit, object_root=None):
    tree = source_tree(object_root or root, commit)
    require(set(tree) == current_source_files(root), 'incomplete or uncommitted source inventory')
    bindings = {}
    for name, blob in tree.items():
        raw = safe_path(root,name).read_bytes()
        require(hashlib.sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).hexdigest() == blob, 'stale source bytes: '+name)
        bindings[name] = digest(raw)
    return bindings


def verify_bindings(root, commit, bindings, object_root=None):
    require(type(bindings) is dict, 'invalid source bindings')
    for name in bindings:
        require(source_path(name), 'unexpected source category')
        safe_path(root,name)
    require(bindings == source_bindings(root,commit,object_root=object_root), 'source binding mismatch')


def create_source_archive(root, path, commit):
    require(git(root,'rev-parse','HEAD').decode().strip() == commit, 'source HEAD changed before archival')
    require(not path.exists(), 'source archive already exists')
    git(root,'bundle','create',str(path),'HEAD')


@contextmanager
def archive_repo(path, sha256, commit):
    require(path.is_file() and not path.is_symlink(), 'source archive missing or linked')
    require(digest(path.read_bytes()) == sha256, 'source archive checksum mismatch')
    with tempfile.TemporaryDirectory(prefix='kvvi-evidence-source-') as directory:
        bare=Path(directory)
        git(bare,'init','--bare')
        heads=git(bare,'bundle','list-heads',str(path)).decode().splitlines()
        require(heads == [commit+' HEAD'], 'source archive tip mismatch')
        git(bare,'bundle','verify',str(path))
        git(bare,'fetch','--no-tags',str(path),'HEAD:refs/heads/source')
        git(bare,'symbolic-ref','HEAD','refs/heads/source')
        git(bare,'fsck','--full','--strict')
        require(git(bare,'rev-parse','HEAD').decode().strip() == commit, 'source archive identity mismatch')
        yield bare


def verify_results(cases, results, inventory):
    require(type(inventory) is dict and type(results) is list, 'invalid case inventory')
    ids = [case['id'] for case in cases]
    require(len(ids) == len(set(ids)) and {c['id']:case_digest(c) for c in cases} == inventory, 'case inventory or independent oracle changed')
    require(len(results) == len(ids) and {r['id'] for r in results} == set(ids), 'missing, extra or duplicate result')
    by_id = {r['id']:r for r in results}
    for case in cases:
        outcomes = by_id[case['id']]['outcomes']
        require(set(outcomes) == {'python','node'}, 'missing language')
        for outcome in outcomes.values():
            require(type(outcome.get('exit_code')) is int and outcome['exit_code'] in (0,2), 'execution failure is not a rejection')
            require(outcome.get('stderr') == '' and type(outcome.get('stdout')) is str, 'invalid runner streams')
            parsed = harness.strict_json(outcome['stdout'])
            require(json.dumps(parsed,sort_keys=True) == json.dumps(outcome['payload'],sort_keys=True), 'stdout differs from stored payload')
        require(harness.case_matches_expected(case,outcomes), 'result differs from independent expected: '+case['id'])


def verify_coverage(cases, coverage, unit_ids):
    require(type(coverage) is dict and set(coverage) == REQUIRED, 'required S/L group missing')
    by_id = {c['id']:c for c in cases}
    for group, row in coverage.items():
        require(type(row) is dict and type(row.get('scope')) is str and row['scope'], 'missing coverage scope')
        for branch in ('positive','negative'):
            refs = row.get(branch, [])
            reason = row.get(branch+'_not_applicable')
            require(refs or type(reason) is str and len(reason) >= 12, 'coverage branch missing: '+group)
            for ref in refs:
                if ref.startswith('unit:'):
                    require(ref[5:] in unit_ids, 'unit evidence missing: '+ref)
                else:
                    require(ref in by_id, 'coverage case missing: '+ref)
                    require(by_id[ref]['expected']['valid'] is (branch == 'positive'), 'coverage polarity mismatch: '+ref)
        if group in {'C03','C07','C08','C09','B22','A07'}:
            require(type(row.get('runtime_boundary')) is str and len(row['runtime_boundary']) > 15, 'mixed R boundary missing')


def create_run(parent, name):
    require(type(name) is str and re.fullmatch('[A-Za-z0-9][A-Za-z0-9_-]{0,95}',name), 'invalid run ID')
    path = safe_path(parent,name)
    try: path.mkdir(parents=True, exist_ok=False)
    except FileExistsError as exc: raise ValueError('historical run already exists') from exc
    return path


def load(root,name): return harness.strict_json(safe_path(root,name).read_bytes())
def write(path,value): path.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')


def verify_report(root, run_name):
    require(type(run_name) is str and run_name.startswith(EVIDENCE+'/') and len(Path(run_name).parts) == 4, 'unexpected run path')
    run = safe_path(root,run_name)
    require({p.name for p in run.iterdir()} == {'report.json','report.sha256','source.bundle'}, 'partial or extra evidence files')
    raw = safe_path(run,'report.json').read_bytes()
    require(safe_path(run,'report.sha256').read_text().strip() == digest(raw), 'report checksum mismatch')
    report = harness.strict_json(raw)
    require(report['suite_revision'] == SUITE and report['release_approved'] is False, 'invalid suite or release claim')
    archive=report['source_archive']
    require(set(archive)=={'path','sha256'} and archive['path']=='source.bundle', 'invalid archive path')
    records=report['bindings']
    require(type(records) is list and all(type(row) is dict and set(row)=={'path','sha256'} and type(row['path']) is str and type(row['sha256']) is str for row in records),'invalid binding records')
    bindings={row['path']:row['sha256'] for row in records}
    require(len(bindings)==len(records),'duplicate source binding')
    with archive_repo(safe_path(run,'source.bundle'),archive['sha256'],report['source_commit']) as bare:
        verify_bindings(root,report['source_commit'],bindings,object_root=bare)
    cases = load(root,'tests/meta-schema/0a-core-r1/cases.json')['cases']
    inventory = load(root,INVENTORY)
    verify_results(cases,report['results'],harness.inventory_map(inventory['cases']))
    units = report['unit_checks']
    require(type(units['exit_code']) is int and units['exit_code'] == 0 and units['failures'] == [] and units['errors'] == [] and units['skipped'] == [], 'unit execution failed')
    require(len(units['methods']) == len(set(units['methods'])) and set(units['methods']) == set(inventory['unit_methods']), 'unit inventory mismatch')
    require(type(units['tests_run']) is int and units['tests_run'] == len(units['methods']), 'unit count mismatch')
    verify_coverage(cases,load(root,COVERAGE),units['methods'])
    for case, result in zip(cases, report['results']):
        require(case['id'] == result['id'], 'case order mismatch')
        for outcome in result['outcomes'].values():
            input_sha = digest(safe_path(root,'tests/meta-schema/0a-core-r1/'+case['input']).read_bytes())
            context_sha = digest(safe_path(root,'tests/meta-schema/0a-core-r1/'+case['context']).read_bytes()) if case.get('context') else None
            require(outcome['input_before_sha256'] == outcome['input_after_sha256'] == input_sha and outcome['context_before_sha256'] == outcome['context_after_sha256'] == context_sha, 'fixture mutation')
            require(type(outcome['elapsed_seconds']) in (float,int) and 0 <= outcome['elapsed_seconds'] < 15.5, 'runner duration invalid')
    require(report['counts'] == counts(cases), 'summary count mismatch')
    require(report['coverage_groups'] == sorted(REQUIRED), 'coverage summary mismatch')
    verify_toolchain(root, report['toolchain'])
    return report


def counts(cases):
    return {'cases':len(cases),'language_executions':len(cases)*2,
            'checks_and_validity':dict(Counter(c['checks']+(' positive' if c['expected']['valid'] else ' negative') for c in cases)),
            'stages':dict(Counter(c['expected_stage'] for c in cases))}


def locked_dependencies(root):
    """The source-bound locks define inventory, not the verifier's installations."""
    raw = safe_path(root, 'tools/meta-schema/python/requirements.lock').read_text()
    python = {}
    for line in raw.splitlines():
        if not line or line[0].isspace() or line.startswith('#'):
            continue
        match = re.fullmatch(r'([A-Za-z0-9][A-Za-z0-9_.-]*)==([^\s;]+)(?:\s+\\)?', line)
        require(match is not None, 'unsupported Python lock entry')
        name = re.sub(r'[-_.]+', '-', match[1]).lower()
        require(name not in python, 'duplicate Python lock dependency')
        python[name] = match[2]
    packages = load(root, 'tools/meta-schema/node/package-lock.json')['packages']
    require(type(packages) is dict and '' in packages, 'invalid Node lock packages')
    node = {}
    for path, package in packages.items():
        if path == '':
            continue
        require(type(path) is str and path.startswith('node_modules/'), 'invalid Node dependency path')
        safe_path(root, 'tools/meta-schema/node/' + path)
        name = path[len('node_modules/'):]
        require(name not in node and name not in python and '/node_modules/' not in name, 'ambiguous dependency identity')
        require(type(package) is dict and type(package.get('version')) is str and package['version'].strip(), 'invalid Node lock version')
        node[name] = path
    require(python and node, 'empty dependency lock inventory')
    return python, node


def verify_toolchain(root, chain):
    require(type(chain) is dict and set(chain) == {'python','node','npm','pip','platform','dependencies'}, 'toolchain missing')
    require(all(type(chain[key]) is str and chain[key].strip() for key in ('python','node','npm','pip','platform')), 'invalid toolchain types')
    python, node = locked_dependencies(root)
    dependencies = chain['dependencies']
    require(type(dependencies) is dict and set(dependencies) == set(python) | set(node), 'incomplete dependency inventory')
    require(all(type(version) is str and version.strip() for version in dependencies.values()), 'invalid dependency versions')
    packages = load(root, 'tools/meta-schema/node/package-lock.json')['packages']
    expected = dict(python)
    expected.update((name, packages[path]['version']) for name, path in node.items())
    require(dependencies == expected, 'dependency version differs from source lock')


def toolchain(root=ROOT):
    def version(command): return subprocess.check_output(command,stderr=subprocess.STDOUT,timeout=15).decode().strip()
    import importlib.metadata as metadata
    python, node = locked_dependencies(root)
    dependencies={name:metadata.version(name) for name in python}
    for name, path in node.items():
        dependencies[name]=version(['node','-p','require('+json.dumps(str(root/'tools/meta-schema/node'/path/'package.json'))+').version'])
    result = {'python':platform.python_version(),'node':version(['node','--version']),'npm':version(['npm','--version']),
            'pip':version([sys.executable,'-m','pip','--version']),'platform':platform.platform(),
            'dependencies':dependencies}
    verify_toolchain(root, result)
    return result


def record(root, run_id=None):
    commit = git(root,'rev-parse','HEAD').decode().strip()
    bindings = source_bindings(root,commit)  # Fail before creating a directory if source is uncommitted.
    cases = load(root,'tests/meta-schema/0a-core-r1/cases.json')['cases']
    inventory = load(root,INVENTORY)
    require({c['id']:case_digest(c) for c in cases} == harness.inventory_map(inventory['cases']), 'independent inventory mismatch')
    run = create_run(safe_path(root,EVIDENCE),run_id or datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')+'-'+commit[:12])
    create_source_archive(root,run/'source.bundle',commit)
    started = time.monotonic()
    unit_run = subprocess.run([sys.executable,str(root/'tests/meta-schema/run_unit_checks.py')],cwd=root,capture_output=True,timeout=2400)
    require(unit_run.returncode == 0 and not unit_run.stderr, 'unit checks failed')
    units = harness.strict_json(unit_run.stdout)
    units['exit_code'] = unit_run.returncode
    verify_coverage(cases,load(root,COVERAGE),units['methods'])
    results = []
    for index, case in enumerate(cases):
        outcomes = harness.run_case(case)
        require(harness.case_matches_expected(case,outcomes), 'case failed: '+case['id'])
        results.append({'id':case['id'],'outcomes':outcomes})
        if (index+1) % 100 == 0: print(f'Collected {index+1}/{len(cases)} shared cases',file=sys.stderr,flush=True)
    verify_results(cases,results,harness.inventory_map(inventory['cases']))
    verify_bindings(root,commit,bindings)
    report = dict(suite_revision=SUITE,source_commit=commit,source_archive={'path':'source.bundle','sha256':digest((run/'source.bundle').read_bytes())},created_at=datetime.now(timezone.utc).isoformat(),
                  bindings=[{'path':name,'sha256':sha} for name,sha in bindings.items()],toolchain=toolchain(root),unit_checks=units,results=results,counts=counts(cases),
                  coverage_groups=sorted(REQUIRED),elapsed_seconds=round(time.monotonic()-started,3),release_approved=False,
                  scope='Reference Meta-Schema/Linter and fixed Fake contexts only; no runtime, deployment, production, permission or release acceptance.')
    write(run/'report.json',report)
    (run/'report.sha256').write_text(digest((run/'report.json').read_bytes())+'\n')
    verify_report(root,run.relative_to(root).as_posix())
    return run


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--suite',default=SUITE)
    mode=parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--new-run',action='store_true');mode.add_argument('--verify');mode.add_argument('--verify-current',action='store_true')
    parser.add_argument('--run-id')
    args=parser.parse_args()
    try:
        require(args.suite == SUITE, 'unsupported suite')
        if args.new_run: output={'run':record(ROOT,args.run_id).relative_to(ROOT).as_posix()}
        else:
            name = load(ROOT,EVIDENCE+'/current.json')['run'] if args.verify_current else args.verify
            report=verify_report(ROOT,name); output={'verified':name,'source_commit':report['source_commit'],'counts':report['counts']}
        print(json.dumps(output,ensure_ascii=False));return 0
    except Exception as exc:
        print(json.dumps({'execution':'failed','error_type':type(exc).__name__,'release_approved':False}));return 1


if __name__ == '__main__': raise SystemExit(main())
