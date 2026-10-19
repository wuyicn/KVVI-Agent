"""Bind a complete declared-source check to the exact trusted overlay manifest.

The manifest path is supplied by repository tooling, never by a business payload.
This proves neither executable bits nor any excluded dependencies/build output.
Only administrator-controlled roots are supported, without an atomic tree claim.
"""
import argparse
import json
import os
from pathlib import Path
import re

from .package_inventory import MAX_MANIFEST_BYTES, SOURCE_LIMITATIONS, InventoryError, load_json, snapshot
from .runtime_source import qualify_source



def _reject(code):
    # In particular, do not expose runtime_source's digest of a matched subset.
    return {'valid':False, 'validationScope':'FIXED_DECLARED_SOURCE', 'releaseApproved':False, 'code':code}


def _root(value):
    value = os.fspath(value)
    if not isinstance(value, str) or not os.path.isabs(value) or '..' in value.split(os.sep): raise ValueError()
    path = Path(value)
    if path.is_symlink() or not path.is_dir(): raise ValueError()
    return path


def qualify_runtime_source(source, objects, trusted_manifest, *, include_source_rows=False):
    """Only a successful complete inventory yields a source binding record."""
    try:
        source = _root(source); objects = _root(objects)
        manifest_path = Path(trusted_manifest)
        if not manifest_path.is_absolute(): raise ValueError()
        manifest_row, body = snapshot(manifest_path, 'trusted-overlay-manifest.json', max_bytes=MAX_MANIFEST_BYTES)
        if manifest_row['type'] != 'file': raise ValueError()
        manifest = load_json(body)
        result = qualify_source(source, objects, manifest, include_inventory=True) if include_source_rows is True else qualify_source(source, objects, manifest)
        after_row, after_body = snapshot(manifest_path, 'trusted-overlay-manifest.json', max_bytes=MAX_MANIFEST_BYTES)
        if after_row != manifest_row or after_body != body: return _reject('FIXED_SOURCE_INPUT_CHANGED')
        if not result['valid']: return _reject('FIXED_SOURCE_REJECTED')
        count = result['sourceEntryCount']
        if (type(count) is not int or count < 1 or count != result['matchedEntryCount']
                or result['inventoryProfile'] != 'kvvi-declared-source/v1'
                or not re.fullmatch(r'sha256:[0-9a-f]{64}', result['inventoryDigest'])):
            return _reject('FIXED_SOURCE_REPORT_INVALID')
        binding = {'valid':True, 'validationScope':'FIXED_DECLARED_SOURCE', 'releaseApproved':False,
                'baseline':manifest['upstream_merge_base'], 'overlayManifestSha256':manifest_row['sha256'],
                'inventoryProfile':result['inventoryProfile'], 'inventoryDigest':result['inventoryDigest'],
                'sourceEntryCount':count, 'excludedUnqualified':result['excludedUnqualified'],
                'limitations':list(SOURCE_LIMITATIONS)}
        if include_source_rows is True:
            binding['sourceRows'] = result['sourceInventory']
        return binding
    except (OSError, ValueError, TypeError, KeyError, RecursionError, InventoryError):
        return _reject('FIXED_SOURCE_INPUT_INVALID')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime-source', required=True, type=Path)
    parser.add_argument('--git-objects', required=True, type=Path)
    args = parser.parse_args()
    manifest = Path(__file__).resolve().parents[2] / 'forks/dsh/改造点指纹.json'
    result = qualify_runtime_source(args.runtime_source, args.git_objects, manifest)
    print(json.dumps(result, ensure_ascii=True, indent=2))
    return 0 if result['valid'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
