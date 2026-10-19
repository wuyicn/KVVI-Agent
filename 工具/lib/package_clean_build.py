"""Run fixed offline install/full build only in a newly owned source workspace.

Records observed causality, not tool/dependency authenticity, a network sandbox,
or expected-output completeness. Original built trees are never cleaned.
"""
import argparse
import json
import math
import os
from pathlib import Path
import platform
import re
import shlex
import stat
import sys

from .owned_build_command import run_owned_command
from .package_build_source import stage_declared_source, material_rows, target_path, inside_protected_root
from .package_build_inventory import qualify_output_inventory
from .package_provenance import qualify_runtime_source
from .package_inventory import InventoryError, snapshot, load_json, MAX_MANIFEST_BYTES

LIMITATIONS = ('tool-origin-authentication', 'toolchain-transitive-dependencies',
               'dependency-content-authentication', 'raw-filesystem-permissions',
               'source-executable-policy', 'network-sandbox', 'expected-output-completeness',
               'catalog-consumption', 'release-acceptance')


def _failure(workspace=None, phase='INPUT'):
    result = dict(valid=False, validationScope='OWNED_OFFLINE_BUILD', releaseApproved=False,
                  code='CLEAN_BUILD_REJECTED', phase=phase)
    if workspace is not None:
        result['workspace'] = str(workspace)
    return result


def _write(path, value):
    # All metadata is outside source, exclusively created in our new workspace.
    with path.open('x', encoding='utf-8') as handle:
        json.dump(value, handle, sort_keys=True, ensure_ascii=True, separators=(',', ':'))
        handle.write('\n')


def _checked_json(path, label, value):
    row, body = _row(path, label, MAX_MANIFEST_BYTES)
    expected = (json.dumps(value, sort_keys=True, ensure_ascii=True, separators=(',', ':')) + '\n').encode('utf-8')
    if body != expected:
        raise InventoryError('BUILD_METADATA_CHANGED')
    return row


def _row(path, label, max_bytes=None):
    row, body = snapshot(path, label, max_bytes=max_bytes)
    if row['type'] != 'file':
        raise InventoryError('BUILD_REGULAR_FILE_REQUIRED')
    return row, body


def _tools(node, pnpm):
    rows = {}
    for name, value in (('node', node), ('pnpm', pnpm)):
        path = target_path(value)
        if path.is_symlink() or not path.is_file():
            raise InventoryError('BUILD_TOOL_INVALID')
        row, _ = _row(path, name)
        if name == 'node' and not path.stat().st_mode & stat.S_IXUSR:
            raise InventoryError('BUILD_TOOL_NOT_EXECUTABLE')
        rows[name] = dict(path=str(path), row=row)
    return rows


def _source_core(proof):
    return {key: value for key, value in proof.items() if key != 'excludedUnqualified'}


def _environment(workspace, node, store, commit):
    return dict(HOME=str(workspace / 'home'), TMPDIR=str(workspace / 'tmp'),
                TMP=str(workspace / 'tmp'), TEMP=str(workspace / 'tmp'),
                XDG_CONFIG_HOME=str(workspace / 'home/config'),
                XDG_CACHE_HOME=str(workspace / 'home/cache'),
                XDG_DATA_HOME=str(workspace / 'home/data'),
                PATH=os.pathsep.join([str(workspace / 'bin'), str(node.parent), '/usr/bin', '/bin', '/usr/sbin', '/sbin']),
                CI='true', LANG='C', LC_ALL='C',
                GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_SYSTEM=os.devnull, GIT_CONFIG_NOSYSTEM='1',
                GIT_CEILING_DIRECTORIES=str(workspace),
                npm_config_userconfig=os.devnull, npm_config_globalconfig=os.devnull,
                npm_config_store_dir=str(store), PNPM_HOME=str(workspace / 'bin'),
                DSH_CLIENT_COMMIT_HASH=commit)


def run_clean_build(source, objects, trusted_manifest, workspace, node, pnpm, store, *,
                    install_timeout=600, build_timeout=1800):
    owned = None
    phase = 'INPUT'
    commands = []
    metadata_records = {}
    try:
        for seconds in (install_timeout, build_timeout):
            if type(seconds) not in (int, float) or not math.isfinite(seconds) or seconds <= 0:
                return _failure()
        workspace = target_path(workspace)
        if workspace.exists() or workspace.is_symlink():
            return _failure()
        # The fixed tsx CLI creates TMPDIR/tsx-UID/PID.pipe. Reject a path
        # that cannot fit the platform sockaddr_un before costly installation.
        socket_path = workspace / 'tmp' / ('tsx-' + str(os.getuid())) / '2147483647.pipe'
        limit = {'darwin':104, 'linux':108}.get(sys.platform)
        if limit is None or len(os.fsencode(socket_path)) >= limit:
            return _failure(phase='SOCKET_PATH_LENGTH')
        store = target_path(store)
        if store.is_symlink() or not store.is_dir():
            return _failure()
        canonical = workspace.parent.resolve(strict=True) / workspace.name
        if any(inside_protected_root(canonical, root) for root in (source, objects, store)):
            return _failure()
        tools = _tools(node, pnpm)
        node, pnpm = Path(tools['node']['path']), Path(tools['pnpm']['path'])
        workspace.mkdir(mode=0o700)  # Existing even-empty workspaces are never reused.
        owned = workspace
        for directory in ('metadata', 'logs', 'home', 'home/config', 'home/cache', 'home/data', 'tmp', 'bin'):
            (workspace / directory).mkdir(mode=0o700)
        root = workspace / 'source'
        phase = 'SOURCE_STAGE'
        staged = stage_declared_source(source, objects, trusted_manifest, root, include_material_rows=True)
        if staged.get('valid') is not True:
            raise InventoryError('BUILD_SOURCE_REJECTED')
        initial_rows = staged.pop('materialRows')
        initial_proof = staged['sourceQualification']
        proof = qualify_runtime_source(root, objects, trusted_manifest, include_source_rows=True)
        if proof.get('valid') is not True:
            raise InventoryError('BUILD_SOURCE_REJECTED')
        source_rows = proof.pop('sourceRows')
        if proof != initial_proof or material_rows(root, source_rows) != initial_rows:
            raise InventoryError('BUILD_SOURCE_REJECTED')
        manifest_row, manifest_body = _row(trusted_manifest, 'overlay-manifest', MAX_MANIFEST_BYTES)
        if manifest_row['sha256'] != proof['overlayManifestSha256']:
            raise InventoryError('BUILD_MANIFEST_CHANGED')
        commit = load_json(manifest_body)['fork_head']
        if not isinstance(commit, str) or not re.fullmatch('[0-9a-f]{40}', commit):
            raise InventoryError('BUILD_COMMIT_INVALID')
        package_row, package_body = _row(root / 'package.json', 'package.json', MAX_MANIFEST_BYTES)
        if package_row != next(row for row in initial_rows if row['path'] == 'package.json'):
            raise InventoryError('BUILD_POLICY_CHANGED')
        package = load_json(package_body)
        if (not isinstance(package, dict) or package.get('packageManager') != 'pnpm@11.7.0'
                or not isinstance(package.get('engines'), dict)
                or package['engines'].get('node') != '^22.19.0 || >=24.0.0'):
            raise InventoryError('BUILD_POLICY_UNSUPPORTED')
        environment = _environment(workspace, node, store, commit)
        shim = workspace / 'bin/pnpm'
        with shim.open('x') as handle:
            handle.write('#!/bin/sh\nexec ' + shlex.quote(str(node)) + ' ' + shlex.quote(str(pnpm)) + ' "$@"\n')
        shim.chmod(0o755)
        shim_row = _row(shim, 'bin/pnpm', MAX_MANIFEST_BYTES)[0]

        def record_json(name, value):
            path = workspace / 'metadata' / name
            _write(path, value)
            row = _checked_json(path, 'metadata/' + name, value)
            metadata_records[name] = row
            return row

        record_json('source-material.json', initial_rows)
        record_json('build-input.json', dict(tools=tools, environment=environment,
                    inputQualification=initial_proof, inputMaterialCount=staged['materialCount'],
                    inputMaterialDigest=staged['materialDigest'], pnpmStore=str(store), nestedPnpmShim=shim_row))

        def execute(name, argv, seconds):
            log = workspace / 'logs' / (name + '.log')
            outcome = run_owned_command(argv, root, environment, log, seconds)
            command = dict(name=name, argv=argv, result=outcome)
            body = None
            if log.exists():
                command['log'], body = _row(log, 'logs/' + log.name, MAX_MANIFEST_BYTES)
            commands.append(command)
            record_json(name + '.json', command)
            if (outcome.get('valid') is not True or outcome.get('cleanupConfirmed') is not True
                    or outcome.get('exitCode') != 0 or outcome.get('timedOut') is not False):
                raise InventoryError('BUILD_COMMAND_REJECTED')
            if body is None:
                raise InventoryError('BUILD_LOG_MISSING')
            return body

        def check_input():
            current = qualify_runtime_source(root, objects, trusted_manifest)
            if (current.get('valid') is not True or _source_core(current) != _source_core(initial_proof)
                    or material_rows(root, source_rows) != initial_rows or _tools(node, pnpm) != tools
                    or _row(shim, 'bin/pnpm', MAX_MANIFEST_BYTES)[0] != shim_row):
                raise InventoryError('BUILD_INPUT_CHANGED')

        def check_records():
            for name, row in metadata_records.items():
                if _row(workspace / 'metadata' / name, row['path'], MAX_MANIFEST_BYTES)[0] != row:
                    raise InventoryError('BUILD_METADATA_CHANGED')
            for command in commands:
                row = command['log']
                if _row(workspace / row['path'], row['path'], MAX_MANIFEST_BYTES)[0] != row:
                    raise InventoryError('BUILD_LOG_CHANGED')

        phase = 'NODE_PROBE'
        node_info = load_json(execute('node-version', [str(node), '-p',
                    'JSON.stringify({version:process.version,platform:process.platform,arch:process.arch})'], 30))
        if not isinstance(node_info, dict) or set(node_info) != {'version', 'platform', 'arch'}:
            raise InventoryError('BUILD_NODE_PROBE_INVALID')
        version = re.fullmatch(r'v([0-9]+)\.([0-9]+)\.([0-9]+)', node_info.get('version', ''))
        if not version or not (int(version[1]) >= 24 or int(version[1]) == 22 and int(version[2]) >= 19):
            raise InventoryError('BUILD_NODE_UNSUPPORTED')
        machine = platform.machine().lower()
        arch = {'arm64':'arm64', 'aarch64':'arm64', 'x86_64':'x64', 'amd64':'x64'}.get(machine)
        if sys.platform not in ('darwin', 'linux') or arch is None or node_info['platform'] != sys.platform or node_info['arch'] != arch:
            raise InventoryError('BUILD_HOST_MISMATCH')
        phase = 'PNPM_PROBE'
        if execute('pnpm-version', [str(node), str(pnpm), '--version'], 30).strip() != b'11.7.0':
            raise InventoryError('BUILD_PNPM_UNSUPPORTED')
        check_input()
        phase = 'INSTALL'
        execute('install', [str(node), str(pnpm), 'install', '--frozen-lockfile', '--offline', '--store-dir', str(store)], install_timeout)
        phase = 'INSTALL_POSTCHECK'
        check_input()
        phase = 'BUILD'
        execute('build', [str(node), str(pnpm), 'run', 'build'], build_timeout)
        phase = 'BUILD_POSTCHECK'
        check_input()
        phase = 'OUTPUT_QUALIFICATION'
        output = qualify_output_inventory(root, objects, trusted_manifest, include_output_rows=True)
        if output.get('valid') is not True:
            raise InventoryError('BUILD_OUTPUT_REJECTED')
        output_rows = output.pop('outputRows')
        if _source_core(output['sourceQualification']) != _source_core(initial_proof):
            raise InventoryError('BUILD_SOURCE_CHANGED')
        check_input()
        record_json('output-rows.json', output_rows)
        receipt = dict(formatVersion='kvvi-owned-build/v1', valid=True, validationScope='OWNED_OFFLINE_BUILD',
                releaseApproved=False, runtimeSource=str(root), inputQualification=initial_proof,
                inputMaterialCount=staged['materialCount'], inputMaterialDigest=staged['materialDigest'],
                inputMaterialFile=metadata_records['source-material.json'],
                buildInputFile=metadata_records['build-input.json'],
                tools=tools, nodeHost=node_info, host=dict(system=sys.platform, machine=machine, release=platform.release()),
                environment=environment, pnpmStore=str(store), commands=commands,
                outputQualification=output,
                outputRowsFile=metadata_records['output-rows.json'],
                commandRecordFiles=[metadata_records[command['name'] + '.json'] for command in commands],
                nestedPnpmShim=shim_row,
                limitations=list(LIMITATIONS))
        phase = 'RECEIPT_PREPARATION'
        pending = workspace / 'metadata/build-receipt.candidate.json'
        published = workspace / 'metadata/build-receipt.json'
        _write(pending, receipt)
        receipt_row = _checked_json(pending, 'metadata/build-receipt.json', receipt)
        success = dict(valid=True, validationScope='OWNED_OFFLINE_BUILD', releaseApproved=False,
                    workspace=str(workspace), runtimeSource=str(root), receipt=receipt_row, limitations=list(LIMITATIONS))
        phase = 'FINAL_BINDING'
        check_input()
        fresh = qualify_output_inventory(root, objects, trusted_manifest, include_output_rows=True)
        if fresh.get('valid') is not True or fresh.pop('outputRows') != output_rows or fresh != output:
            raise InventoryError('BUILD_OUTPUT_CHANGED')
        check_records()
        if _checked_json(pending, 'metadata/build-receipt.json', receipt) != receipt_row:
            raise InventoryError('BUILD_RECEIPT_CHANGED')
    except (InventoryError, OSError, ValueError, TypeError, KeyError, RecursionError, UnicodeError, RuntimeError):
        result = _failure(owned, phase)
        if owned is not None:
            try:
                _write(owned / 'metadata/failure.json', result)
            except (OSError, ValueError):
                pass
        return result
    except BaseException:
        if owned is not None:
            try:
                _write(owned / 'metadata/interrupted.json', _failure(owned, phase))
            except (OSError, ValueError):
                pass
        raise

    # Commit point: an exclusive atomic link of the verified regular candidate.
    # Preparation failures/interruption leave only an unpublished candidate.
    # There is no fallible validation/cleanup after publication, and a signal
    # after this syscall is a post-commit interruption, not a failed preparation.
    try:
        os.link(pending, published, follow_symlinks=False)
    except OSError:
        return _failure(owned, 'RECEIPT_PUBLICATION')
    return success


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('runtime-source', 'git-objects', 'workspace', 'node', 'pnpm', 'store'):
        parser.add_argument('--' + name, required=True, type=Path)
    parser.add_argument('--install-timeout', type=float, default=600)
    parser.add_argument('--build-timeout', type=float, default=1800)
    args = parser.parse_args()
    manifest = Path(__file__).resolve().parents[2] / 'forks/dsh/改造点指纹.json'
    result = run_clean_build(args.runtime_source, args.git_objects, manifest, args.workspace,
                             args.node, args.pnpm, args.store,
                             install_timeout=args.install_timeout, build_timeout=args.build_timeout)
    print(json.dumps(result, ensure_ascii=True, indent=2))
    return 0 if result['valid'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
