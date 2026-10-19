"""Read-only integrity of the fixed source's complete upstream client receipt.

This is neither a build execution record nor a release approval. Roots are
administrator controlled; repeated observations do not make an atomic tree.
"""
import argparse
import fnmatch
import hashlib
import json
import os
from pathlib import Path
import re
import stat

from .package_inventory import (InventoryError, MAX_MANIFEST_BYTES, fixed_source_index,
                                load_json, snapshot, validate_rows)
from .package_provenance import qualify_runtime_source

RECEIPT = '.dsh-build/client-build-environment.json'
LIMITATIONS = ('source-executable-bits','dependencies','build-causality',
               'host-native-outputs','catalog-consumption','release-acceptance')


def reject():
    # Never echo environment values or partial source/artifact qualification.
    return {'valid':False,'validationScope':'FIXED_SOURCE_CLIENT_RECEIPT',
            'releaseApproved':False,'code':'CLIENT_RECEIPT_REJECTED'}


def _directory(root, relative):
    current = root
    for component in relative.split('/'):
        current /= component
        try: mode = current.lstat().st_mode
        except FileNotFoundError: return False
        if not stat.S_ISDIR(mode): raise InventoryError('CLIENT_OUTPUT_DIRECTORY_INVALID')
    return True


def artifact_snapshots(root):
    """Exactly the five upstream patterns, without following output links."""
    paths = []
    def visit(relative):
        with os.scandir(root / relative) as entries:
            for entry in entries:
                if entry.name.startswith('.'): continue  # Node glob defaults to dot:false.
                path = relative + '/' + entry.name
                if entry.is_symlink(): raise InventoryError('CLIENT_OUTPUT_LINK')
                if entry.is_dir(follow_symlinks=False): visit(path)
                elif entry.is_file(follow_symlinks=False): paths.append(path)
                else: raise InventoryError('CLIENT_OUTPUT_TYPE_INVALID')
    if _directory(root,'apps/web/dist'): visit('apps/web/dist')
    if _directory(root,'packages'):
        with os.scandir(root / 'packages') as entries: groups = list(entries)
        for group in groups:
            if group.name.startswith('.'): continue
            if group.is_symlink():
                if group.is_dir(): raise InventoryError('CLIENT_OUTPUT_LINK')
                continue  # e.g. fixed packages/CLAUDE.md is not a directory pattern.
            if not group.is_dir(follow_symlinks=False): continue
            with os.scandir(group.path) as entries: packages = list(entries)
            for package in packages:
                if package.name.startswith('.'): continue
                if package.is_symlink():
                    if package.is_dir(): raise InventoryError('CLIENT_OUTPUT_LINK')
                    continue
                if not package.is_dir(follow_symlinks=False): continue
                relative = f'packages/{group.name}/{package.name}/lib'
                if not _directory(root,relative): continue
                with os.scandir(root / relative) as entries:
                    for entry in entries:
                        if any(fnmatch.fnmatchcase(entry.name,pattern) for pattern in ('client.js','client.js.map','client.*.js','client.*.js.map')):
                            if not entry.is_file(follow_symlinks=False): raise InventoryError('CLIENT_OUTPUT_TYPE_INVALID')
                            paths.append(relative + '/' + entry.name)
    if not paths or len(paths) != len(set(paths)): raise InventoryError('CLIENT_OUTPUT_SET_INVALID')
    digest = hashlib.sha256(); rows = []
    # JavaScript Array.sort compares UTF16 code units, not Unicode code points.
    for relative in sorted(paths,key=lambda value:value.encode('utf-16-be')):
        if not _directory(root,str(Path(relative).parent).replace(os.sep,'/')):
            raise InventoryError('CLIENT_OUTPUT_PARENT_MISSING')
        row, body = snapshot(root / relative,relative)
        if row['type'] != 'file': raise InventoryError('CLIENT_OUTPUT_TYPE_INVALID')
        encoded = relative.encode('utf-8')
        digest.update(str(len(encoded)).encode('ascii') + b':' + encoded)
        digest.update(str(len(body)).encode('ascii') + b':' + body)
        rows.append(row)
    rows.sort(key=lambda row:row['path']); validate_rows(rows)
    return rows, digest.hexdigest()


def _record(root):
    if not _directory(root,'.dsh-build'): raise InventoryError('CLIENT_RECEIPT_MISSING')
    row, body = snapshot(root / RECEIPT,RECEIPT,max_bytes=MAX_MANIFEST_BYTES)
    if row['type'] != 'file': raise InventoryError('CLIENT_RECEIPT_TYPE_INVALID')
    record = load_json(body)
    if not isinstance(record,dict) or set(record) != {'formatVersion','environment','artifacts'}:
        raise InventoryError('CLIENT_RECEIPT_SHAPE_INVALID')
    if type(record['formatVersion']) is not int or record['formatVersion'] != 1:
        raise InventoryError('CLIENT_RECEIPT_VERSION_INVALID')
    artifacts = record['artifacts']
    if (not isinstance(artifacts,dict) or set(artifacts) != {'fileCount','sha256'}
            or type(artifacts['fileCount']) is not int or artifacts['fileCount'] < 1
            or artifacts['fileCount'] > 2**53 - 1 or not isinstance(artifacts['sha256'],str)
            or not re.fullmatch('[0-9a-f]{64}',artifacts['sha256'])):
        raise InventoryError('CLIENT_RECEIPT_ARTIFACTS_INVALID')
    return row,body,record


def qualify_client_outputs(source,objects,trusted_manifest,*,include_artifact_rows=False):
    try:
        proof = qualify_runtime_source(source,objects,trusted_manifest,include_source_rows=True)
        if proof.get('valid') is not True: return reject()
        source_rows = proof.pop('sourceRows'); fixed = fixed_source_index(source_rows,proof)
        root = Path(source)
        manifest_row, manifest_body = snapshot(trusted_manifest,'trusted-overlay-manifest.json',max_bytes=MAX_MANIFEST_BYTES)
        if manifest_row['type'] != 'file' or manifest_row['sha256'] != proof['overlayManifestSha256']: return reject()
        manifest = load_json(manifest_body); commit = manifest['fork_head']
        if not isinstance(commit,str) or not re.fullmatch('[0-9a-f]{40}',commit): return reject()
        package_row, package_body = snapshot(root / 'package.json','package.json',max_bytes=MAX_MANIFEST_BYTES)
        if package_row['type'] != 'file' or fixed.get('package.json') != ('file',package_row['sha256'][7:]): return reject()
        version = load_json(package_body)['version']
        if not isinstance(version,str) or not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?',version): return reject()
        expected = {'DSH_CLIENT_COMMIT_HASH':commit[:7],'DSH_CLIENT_VERSION':version}
        receipt_row, receipt_body, record = _record(root)
        if record['environment'] != expected: return reject()
        rows,digest = artifact_snapshots(root)
        if len(rows) != record['artifacts']['fileCount'] or digest != record['artifacts']['sha256']: return reject()
        if _record(root) != (receipt_row,receipt_body,record): return reject()
        after = qualify_runtime_source(source,objects,trusted_manifest)
        if after != proof: return reject()
        after_rows,after_digest = artifact_snapshots(root)
        if after_rows != rows or after_digest != digest or _record(root) != (receipt_row,receipt_body,record): return reject()
        result = {'valid':True,'validationScope':'FIXED_SOURCE_CLIENT_RECEIPT','releaseApproved':False,
                  'sourceQualification':proof,'receipt':receipt_row,'environment':expected,
                  'artifactCount':len(rows),'artifactDigest':'sha256:'+digest,'limitations':list(LIMITATIONS)}
        if include_artifact_rows is True: result['clientRows'] = rows
        return result
    except (InventoryError,OSError,ValueError,TypeError,KeyError,RecursionError,UnicodeError):
        return reject()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime-source',required=True,type=Path)
    parser.add_argument('--git-objects',required=True,type=Path)
    args = parser.parse_args()
    manifest = Path(__file__).resolve().parents[2] / 'forks/dsh/改造点指纹.json'
    result = qualify_client_outputs(args.runtime_source,args.git_objects,manifest)
    print(json.dumps(result,ensure_ascii=True,indent=2))
    return 0 if result['valid'] else 1


if __name__ == '__main__': raise SystemExit(main())
