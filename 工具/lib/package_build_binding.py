"""Bind a verified complete output table to the exact runtime package projection.

This integrity contract consumes trusted qualifier results, not arbitrary business
JSON. It does not authenticate the pinned observation or approve a release.
"""
import re

from .package_inventory import (InventoryError, validate_rows, content_digest,
                                validate_source_qualification, validate_client_qualification,
                                fixed_source_index, bind_fixed_source_rows)
from .package_client import bind_client_rows, matches_client_path
from .package_build_receipt import LIMITATIONS, MAX_TOOL_BYTES, _same, _digest, _positive, _absolute
from .package_policy import runtime_file_included

FIELDS = set('''valid validationScope releaseApproved sourceQualification buildReceipt buildAnchorSha256
inputMaterialCount inputMaterialDigest outputCount outputDigest clientQualification nodeHost tools limitations'''.split())


def require(value):
    if not value:
        raise InventoryError('PACKAGE_BUILD_BINDING_INVALID')


def validate_build_qualification(proof):
    require(isinstance(proof, dict) and set(proof) == FIELDS)
    require(proof['valid'] is True and proof['releaseApproved'] is False
            and proof['validationScope'] == 'PINNED_LOCAL_BUILD_RECEIPT')
    validate_source_qualification(proof['sourceQualification'])
    validate_client_qualification(proof['clientQualification'])
    require(_same(proof['sourceQualification'], proof['clientQualification']['sourceQualification']))
    require(_same(proof['limitations'], list(LIMITATIONS)))
    for field in ('inputMaterialCount', 'outputCount'):
        require(_positive(proof[field]))
    require(proof['inputMaterialCount'] == proof['sourceQualification']['sourceEntryCount'])
    for field in ('buildAnchorSha256', 'inputMaterialDigest', 'outputDigest'):
        require(_digest(proof[field]))
    receipt = proof['buildReceipt']; validate_rows([receipt])
    require(receipt['type'] == 'file' and receipt['path'] == 'metadata/build-receipt.json')
    host = proof['nodeHost']
    require(isinstance(host, dict) and set(host) == {'version', 'platform', 'arch'})
    require(isinstance(host['version'], str) and host['platform'] in ('darwin', 'linux') and host['arch'] in ('arm64', 'x64'))
    version = re.fullmatch(r'v([0-9]+)\.([0-9]+)\.([0-9]+)', host['version'])
    require(version is not None and (int(version[1]) >= 24 or int(version[1]) == 22 and int(version[2]) >= 19))
    tools = proof['tools']; require(isinstance(tools, dict) and set(tools) == {'node', 'pnpm'})
    for name, value in tools.items():
        require(isinstance(value, dict) and set(value) == {'path', 'row'})
        _absolute(value['path']); row = value['row']; validate_rows([row])
        require(row['type'] == 'file' and row['path'] == name and row['bytes'] <= MAX_TOOL_BYTES)


def project_output_rows(output_rows, proof):
    validate_build_qualification(proof); validate_rows(output_rows)
    require(all(row['type'] == 'file' for row in output_rows))
    require(len(output_rows) == proof['outputCount'] and content_digest(output_rows) == proof['outputDigest'])
    client_rows = [row for row in output_rows if matches_client_path(row['path'])]
    client = proof['clientQualification']
    require(len(client_rows) == client['artifactCount'] and content_digest(client_rows) == client['clientInventoryDigest'])
    bind_client_rows([dict(row, path='vendor/dsh/' + row['path']) for row in output_rows], client_rows, client)
    # A source-generated client receipt cannot be retained while silently
    # discarding one of its covered files through the package skip policy.
    require(all(runtime_file_included(row['path']) for row in client_rows))
    return [row for row in output_rows if runtime_file_included(row['path'])]


def bind_build_rows(candidate_rows, output_rows, proof, source_rows, included_source_paths):
    projected = project_output_rows(output_rows, proof)
    source = fixed_source_index(source_rows, proof['sourceQualification'])
    require(not source.keys() & {row['path'] for row in output_rows})
    # Links are individual archive entries: policy uses their recorded path,
    # never an is_dir() observation through the current filesystem. The caller
    # cannot redefine completeness by omitting a policy-included source path.
    require(isinstance(included_source_paths, set)
            and included_source_paths == {path for path in source if runtime_file_included(path)})
    validate_rows(candidate_rows)
    bind_fixed_source_rows(candidate_rows, source_rows, proof['sourceQualification'], included_source_paths)
    actual = {row['path'][len('vendor/dsh/'):]: row for row in candidate_rows if row['path'].startswith('vendor/dsh/')}
    expected_outputs = {row['path']: dict(row, path='vendor/dsh/' + row['path']) for row in projected}
    require(actual.keys() == included_source_paths | expected_outputs.keys())
    require(all(_same(actual[path], row) for path, row in expected_outputs.items()))
