"""Read-only binding of a repository-pinned local build observation to current files.

The anchor is supplied by repository tooling, never a business payload. A pinned
observation is not a signed execution attestation or tool/dependency authenticity.
Administrator-controlled roots are required; no atomic filesystem-tree claim.
"""
import argparse
import json
import os
from pathlib import Path
import re
import shlex
import stat

from .package_inventory import (InventoryError, snapshot, load_json, validate_rows,
                                validate_source_qualification, content_digest, MAX_MANIFEST_BYTES)
from .package_provenance import _root, qualify_runtime_source
from .package_build_source import material_rows, target_path
from .package_build_inventory import qualify_output_inventory
from .package_client import _directory
from .package_clean_build import _environment, _source_core, LIMITATIONS as BUILD_LIMITATIONS

LIMITATIONS = tuple(BUILD_LIMITATIONS) + ('signed-attestation', 'unobserved-daemon-escape', 'packager-consumption')
ANCHOR_FIELDS = set('''formatVersion validationScope releaseApproved runnerCommit workspace runtimeSource receiptPath
receiptSha256 receiptBytes sourceEntryCount sourceInventoryDigest overlayManifestSha256 inputMaterialDigest outputCount
outputDigest outputBoundaryCount clientCount clientDigest clientEnvironment nodeHost tools nativeOutput commands
readOnlyReverificationSha256 limitations'''.split())
RECEIPT_FIELDS = set('''buildInputFile commandRecordFiles commands environment formatVersion host inputMaterialCount
inputMaterialDigest inputMaterialFile inputQualification limitations nestedPnpmShim nodeHost outputQualification outputRowsFile
pnpmStore releaseApproved runtimeSource tools valid validationScope'''.split())
RESULT_FIELDS = set('''cleanupConfirmed cleanupFailureCode code exitCode failureCode failurePhase observedIdentities
signalEscalated started timedOut valid workerFailureCode'''.split())
NODE_EXPRESSION = 'JSON.stringify({version:process.version,platform:process.platform,arch:process.arch})'
MAX_TOOL_BYTES = 512 * 1024 * 1024


def _reject():
    return dict(valid=False, validationScope='PINNED_LOCAL_BUILD_RECEIPT', releaseApproved=False,
                code='BUILD_RECEIPT_REJECTED')


def _require(condition):
    if not condition:
        raise InventoryError('BUILD_RECEIPT_REJECTED')


def _same(left, right):
    # Typed JSON equality: False/0 and 1.0/1 cannot substitute for each other.
    return json.dumps(left, sort_keys=True, ensure_ascii=True, separators=(',', ':')) == json.dumps(right, sort_keys=True, ensure_ascii=True, separators=(',', ':'))


def _absolute(value):
    text = os.fspath(value)
    _require(isinstance(text, str) and os.path.isabs(text) and '..' not in text.split(os.sep))
    return Path(text)


def _read(path, label):
    row, body = snapshot(path, label, max_bytes=MAX_MANIFEST_BYTES)
    _require(row['type'] == 'file')
    return row, body


def _digest(value):
    return isinstance(value, str) and re.fullmatch('sha256:[0-9a-f]{64}', value) is not None


def _positive(value):
    return type(value) is int and 1 <= value <= 2**53 - 1


def _anchor_shape(anchor):
    _require(isinstance(anchor, dict) and set(anchor) == ANCHOR_FIELDS)
    _require(anchor['formatVersion'] == 'kvvi-local-build-anchor/v1'
             and anchor['validationScope'] == 'OBSERVED_LOCAL_BUILD' and anchor['releaseApproved'] is False)
    _require(isinstance(anchor['runnerCommit'], str) and re.fullmatch('[0-9a-f]{40}', anchor['runnerCommit']) is not None)
    for name in ('receiptSha256', 'sourceInventoryDigest', 'overlayManifestSha256', 'inputMaterialDigest',
                 'outputDigest', 'clientDigest', 'readOnlyReverificationSha256'):
        _require(_digest(anchor[name]))
    for name in ('receiptBytes', 'sourceEntryCount', 'outputCount', 'outputBoundaryCount', 'clientCount'):
        _require(_positive(anchor[name]))
    _require(_same(anchor['limitations'], list(LIMITATIONS)))


def _metadata(workspace, row, expected_path):
    validate_rows([row])
    _require(row['type'] == 'file' and row['path'] == expected_path)
    parent = Path(expected_path).parent.as_posix()
    _require(_directory(workspace, parent))
    observed, body = _read(workspace / expected_path, expected_path)
    _require(_same(observed, row))
    return body


def _identity_rows(rows, system):
    _require(isinstance(rows, list) and 1 <= len(rows) <= 65536)
    seen = set()
    for value in rows:
        _require(isinstance(value, dict) and set(value) == {'pid', 'uid', 'pgid', 'startIdentity'})
        _require(type(value['pid']) is int and value['pid'] > 1 and value['pid'] not in seen)
        _require(type(value['pgid']) is int and value['pgid'] > 1 and type(value['uid']) is int and 0 <= value['uid'] < 2**32)
        start = value['startIdentity']
        pattern = r'darwin:[0-9]+:[0-9]+' if system == 'darwin' else r'linux:[0-9a-f-]{36}:[0-9]+'
        _require(isinstance(start, str) and re.fullmatch(pattern, start) is not None)
        seen.add(value['pid'])


def _check_tools(tools):
    for name in ('node', 'pnpm'):
        value = tools[name]
        _require(isinstance(value, dict) and set(value) == {'path', 'row'})
        path = _absolute(value['path'])
        _require(target_path(path) == path)
        row = value['row']; validate_rows([row])
        _require(row['type'] == 'file' and row['path'] == name and row['bytes'] <= MAX_TOOL_BYTES)
        # The trusted anchor has already fixed this row. Reject growth before
        # allocation, including during the final recipe revalidation. Node is
        # larger than metadata, so the limit is its own pinned size.
        observed, _ = snapshot(path, name, max_bytes=row['bytes'])
        _require(_same(observed, row))
        if name == 'node':
            _require(path.stat().st_mode & stat.S_IXUSR)


def _recipe(workspace, record, anchor, manifest):
    _require(isinstance(record, dict) and set(record) == RECEIPT_FIELDS)
    _require(record['formatVersion'] == 'kvvi-owned-build/v1' and record['valid'] is True
             and record['releaseApproved'] is False and record['validationScope'] == 'OWNED_OFFLINE_BUILD')
    _require(_same(record['limitations'], list(BUILD_LIMITATIONS)))
    validate_source_qualification(record['inputQualification'])
    _require(_positive(record['inputMaterialCount']) and _digest(record['inputMaterialDigest']))
    node_host = record['nodeHost']
    _require(isinstance(node_host, dict) and set(node_host) == {'version', 'platform', 'arch'})
    _require(node_host['platform'] in ('darwin', 'linux') and node_host['arch'] in ('arm64', 'x64'))
    version = re.fullmatch(r'v([0-9]+)\.([0-9]+)\.([0-9]+)', node_host['version'])
    _require(version is not None and (int(version[1]) >= 24 or int(version[1]) == 22 and int(version[2]) >= 19))
    _require(_same(node_host, anchor['nodeHost']))
    host = record['host']
    _require(isinstance(host, dict) and set(host) == {'system', 'machine', 'release'})
    _require(all(isinstance(value, str) and value for value in host.values()) and host['system'] == node_host['platform'])
    _require({'arm64':'arm64', 'aarch64':'arm64', 'x86_64':'x64', 'amd64':'x64'}.get(host['machine']) == node_host['arch'])
    tools = record['tools']
    _require(isinstance(tools, dict) and set(tools) == {'node', 'pnpm'})
    _require(_same(tools, anchor['tools']))
    node = _absolute(tools['node']['path']); pnpm = _absolute(tools['pnpm']['path'])
    _check_tools(tools)
    store = _absolute(record['pnpmStore'])
    commit = manifest['fork_head']
    _require(isinstance(commit, str) and re.fullmatch('[0-9a-f]{40}', commit) is not None)
    _require(_same(record['environment'], _environment(workspace, node, store, commit)))
    expected = [('node-version', [str(node), '-p', NODE_EXPRESSION]),
                ('pnpm-version', [str(node), str(pnpm), '--version']),
                ('install', [str(node), str(pnpm), 'install', '--frozen-lockfile', '--offline', '--store-dir', str(store)]),
                ('build', [str(node), str(pnpm), 'run', 'build'])]
    commands = record['commands']; summaries = anchor['commands']; files = record['commandRecordFiles']
    _require(isinstance(commands, list) and len(commands) == 4 and isinstance(summaries, list) and len(summaries) == 4
             and isinstance(files, list) and len(files) == 4)
    for index, (name, argv) in enumerate(expected):
        command = commands[index]
        _require(isinstance(command, dict) and set(command) == {'name', 'argv', 'log', 'result'}
                 and command['name'] == name and _same(command['argv'], argv))
        result = command['result']
        _require(isinstance(result, dict) and set(result) == RESULT_FIELDS)
        _require(all(result[key] is True for key in ('valid', 'started', 'cleanupConfirmed'))
                 and all(result[key] is False for key in ('timedOut', 'signalEscalated'))
                 and type(result['exitCode']) is int and result['exitCode'] == 0 and result['code'] == 'BUILD_COMMAND_OK'
                 and all(result[key] is None for key in ('failureCode', 'failurePhase', 'cleanupFailureCode', 'workerFailureCode')))
        _identity_rows(result['observedIdentities'], node_host['platform'])
        _require(_same(summaries[index], dict(name=name, exitCode=0, cleanupConfirmed=True, log=command['log'])))
        saved = load_json(_metadata(workspace, files[index], 'metadata/' + name + '.json'))
        _require(_same(saved, command))
        log = _metadata(workspace, command['log'], 'logs/' + name + '.log')
        if name == 'node-version':
            _require(_same(load_json(log), node_host))
        elif name == 'pnpm-version':
            _require(log.strip() == b'11.7.0')
    shim = _metadata(workspace, record['nestedPnpmShim'], 'bin/pnpm')
    _require(shim == ('#!/bin/sh\nexec ' + shlex.quote(str(node)) + ' ' + shlex.quote(str(pnpm)) + ' "$@"\n').encode('utf-8'))


def qualify_build_receipt(source, objects, trusted_manifest, receipt, trusted_anchor, *, include_output_rows=False):
    try:
        source = _root(source); workspace = _root(source.parent)
        receipt = _absolute(receipt); trusted_anchor = _absolute(trusted_anchor)
        _require(source.name == 'source' and receipt == workspace / 'metadata/build-receipt.json')
        _require(_directory(workspace, 'metadata'))
        anchor_row, anchor_body = _read(trusted_anchor, 'trusted-build-anchor.json')
        anchor = load_json(anchor_body); _anchor_shape(anchor)
        _require(_absolute(anchor['workspace']) == workspace and _absolute(anchor['runtimeSource']) == source
                 and _absolute(anchor['receiptPath']) == receipt)
        receipt_row, receipt_body = _read(receipt, 'metadata/build-receipt.json')
        _require(receipt_row['sha256'] == anchor['receiptSha256'] and receipt_row['bytes'] == anchor['receiptBytes'])
        record = load_json(receipt_body)
        _require(isinstance(record, dict) and record.get('runtimeSource') == str(source))
        manifest_row, manifest_body = _read(trusted_manifest, 'trusted-overlay-manifest.json')
        _require(manifest_row['sha256'] == anchor['overlayManifestSha256'])
        manifest = load_json(manifest_body)
        _recipe(workspace, record, anchor, manifest)
        proof = qualify_runtime_source(source, objects, trusted_manifest, include_source_rows=True)
        _require(proof.get('valid') is True)
        source_rows = proof.pop('sourceRows')
        _require(_same(_source_core(proof), _source_core(record['inputQualification'])))
        _require(proof['inventoryDigest'] == anchor['sourceInventoryDigest']
                 and proof['sourceEntryCount'] == anchor['sourceEntryCount'])
        materials = material_rows(source, source_rows)
        _require(_same(materials, load_json(_metadata(workspace, record['inputMaterialFile'], 'metadata/source-material.json'))))
        _require(len(materials) == record['inputMaterialCount'] == anchor['sourceEntryCount']
                 and content_digest(materials) == record['inputMaterialDigest'] == anchor['inputMaterialDigest'])
        package_row, package_body = _read(source / 'package.json', 'package.json')
        _require(any(_same(package_row, row) for row in materials))
        package = load_json(package_body)
        _require(isinstance(package, dict) and package.get('packageManager') == 'pnpm@11.7.0'
                 and isinstance(package.get('engines'), dict) and package['engines'].get('node') == '^22.19.0 || >=24.0.0')
        initial = load_json(_metadata(workspace, record['buildInputFile'], 'metadata/build-input.json'))
        _require(_same(initial, dict(tools=record['tools'], environment=record['environment'],
                    inputQualification=record['inputQualification'], inputMaterialCount=record['inputMaterialCount'],
                    inputMaterialDigest=record['inputMaterialDigest'], pnpmStore=record['pnpmStore'], nestedPnpmShim=record['nestedPnpmShim'])))
        output = qualify_output_inventory(source, objects, trusted_manifest, include_output_rows=True)
        _require(output.get('valid') is True)
        output_rows = output.pop('outputRows')
        _require(_same(output, record['outputQualification']) and _same(output['sourceQualification'], proof))
        _require(_same(output_rows, load_json(_metadata(workspace, record['outputRowsFile'], 'metadata/output-rows.json'))))
        _require(output['outputCount'] == anchor['outputCount'] and output['outputDigest'] == anchor['outputDigest']
                 and len(output['outputBoundaries']) == anchor['outputBoundaryCount'])
        client = output['clientQualification']
        _require(client['artifactCount'] == anchor['clientCount'] and client['artifactDigest'] == anchor['clientDigest']
                 and _same(client['environment'], anchor['clientEnvironment']))
        native_count = output['categoryCounts']['native-declared-binary']
        if native_count == 0:
            _require(anchor['nativeOutput'] is None)
        else:
            _require(native_count == 1)
            native = anchor['nativeOutput']; validate_rows([native])
            expected_native = 'native/system/packages/' + record['nodeHost']['platform'] + '-' + record['nodeHost']['arch'] + '/bin/system.node'
            _require(native['path'] == expected_native and any(_same(native, row) for row in output_rows))
        # Re-read the complete output after checking all external evidence.
        after = qualify_output_inventory(source, objects, trusted_manifest, include_output_rows=True)
        _require(after.get('valid') is True and _same(after.pop('outputRows'), output_rows) and _same(after, output))
        _require(_same(material_rows(source, source_rows), materials))
        _recipe(workspace, record, anchor, manifest)
        for field, name in (('inputMaterialFile','source-material.json'), ('buildInputFile','build-input.json'), ('outputRowsFile','output-rows.json')):
            _metadata(workspace, record[field], 'metadata/' + name)
        # These rows came from our snapshots, with strict native scalar types;
        # compare their raw bytes directly rather than serializing bytes as JSON.
        _require(_read(trusted_anchor, 'trusted-build-anchor.json') == (anchor_row, anchor_body))
        _require(_read(receipt, 'metadata/build-receipt.json') == (receipt_row, receipt_body))
        _require(_read(trusted_manifest, 'trusted-overlay-manifest.json') == (manifest_row, manifest_body))
        result = dict(valid=True, validationScope='PINNED_LOCAL_BUILD_RECEIPT', releaseApproved=False,
                      sourceQualification=proof, buildReceipt=receipt_row, buildAnchorSha256=anchor_row['sha256'],
                      inputMaterialCount=len(materials), inputMaterialDigest=record['inputMaterialDigest'],
                      outputCount=output['outputCount'], outputDigest=output['outputDigest'],
                      clientQualification=client, nodeHost=record['nodeHost'], tools=record['tools'], limitations=list(LIMITATIONS))
        if include_output_rows is True:
            result['outputRows'] = output_rows
        return result
    except (InventoryError, OSError, ValueError, TypeError, KeyError, RecursionError, UnicodeError, RuntimeError, OverflowError):
        return _reject()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('runtime-source', 'git-objects', 'build-receipt'):
        parser.add_argument('--' + name, required=True, type=Path)
    args = parser.parse_args()
    repository = Path(__file__).resolve().parents[2]
    result = qualify_build_receipt(args.runtime_source, args.git_objects, repository / 'forks/dsh/改造点指纹.json',
                                  args.build_receipt, repository / 'docs/handoff/2026-10-19/local-build-anchor.json')
    print(json.dumps(result, ensure_ascii=True, indent=2))
    return 0 if result['valid'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
