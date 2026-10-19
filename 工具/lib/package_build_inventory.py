"""Complete current files under fixed-source-declared output boundaries.

This is an integrity inventory, not historical build causality or expected
output completeness. Dependency trees and source executable bits are excluded.
Modes use package normalization (0644/0755), not raw filesystem permissions.
Administrator-controlled roots are required; no atomic-tree claim is made.
"""
import argparse
import json
import os
from pathlib import Path
import stat
import unicodedata

from .package_client import (qualify_client_outputs, client_row_index, bind_client_rows,
                             matches_client_path, RECEIPT, _directory)
from .package_inventory import (InventoryError, snapshot, validate_rows, content_digest,
                                validate_source_qualification)

LIMITATIONS = ('source-executable-bits','raw-filesystem-permissions','dependencies','build-causality',
               'expected-output-completeness','catalog-consumption','release-acceptance')


def reject():
    return {'valid':False,'validationScope':'DECLARED_OUTPUT_INVENTORY',
            'releaseApproved':False,'code':'OUTPUT_INVENTORY_REJECTED'}


def reserved_namespace(path):
    return any(unicodedata.normalize('NFC',part).casefold() in ('.git','node_modules') for part in path.split('/'))


def output_boundaries(source_qualification):
    validate_source_qualification(source_qualification)
    return [path for path in source_qualification['excludedUnqualified']
            if not reserved_namespace(path) and path != 'native/system/.release']


def output_snapshots(root,boundaries):
    rows=[]; single_files=set()
    def visit(relative):
        if reserved_namespace(relative):
            raise InventoryError('OUTPUT_NESTED_DEPENDENCY_OR_GIT_NAMESPACE')
        path=root/relative
        parent=Path(relative).parent.as_posix()
        if parent != '.' and not _directory(root,parent): raise InventoryError('OUTPUT_PARENT_UNAVAILABLE')
        mode=path.lstat().st_mode
        if stat.S_ISDIR(mode):
            with os.scandir(path) as entries: children=sorted(entry.name for entry in entries)
            for name in children: visit(relative+'/'+name)
        elif stat.S_ISREG(mode):
            row,_=snapshot(path,relative)
            if row['type'] != 'file': raise InventoryError('OUTPUT_TYPE_CHANGED')
            rows.append(row)
        else: raise InventoryError('OUTPUT_TYPE_INVALID')
    for boundary in boundaries:
        if (root/boundary).is_file() and not (root/boundary).is_symlink(): single_files.add(boundary)
        visit(boundary)
    rows.sort(key=lambda row:row['path']);validate_rows(rows)
    return rows,single_files


def category_counts(rows,single_files):
    counts={'client-receipt-patterns':0,'native-declared-binary':0,'build-metadata':0,'other-declared-output':0}
    for row in rows:
        path=row['path']
        if matches_client_path(path): category='client-receipt-patterns'
        elif path == RECEIPT or path.endswith('.tsbuildinfo'): category='build-metadata'
        elif path.startswith('native/') and path in single_files: category='native-declared-binary'
        else: category='other-declared-output'
        counts[category]+=1
    return counts


def qualify_output_inventory(source,objects,trusted_manifest,*,include_output_rows=False):
    try:
        client=qualify_client_outputs(source,objects,trusted_manifest,include_artifact_rows=True)
        if client.get('valid') is not True: return reject()
        client_rows=client.pop('clientRows');client_row_index(client_rows,client)
        proof=client['sourceQualification'];boundaries=output_boundaries(proof)
        if not boundaries: return reject()
        root=Path(source);rows,single_files=output_snapshots(root,boundaries)
        bind_client_rows([dict(row,path='vendor/dsh/'+row['path']) for row in rows],client_rows,client)
        after_rows,after_files=output_snapshots(root,boundaries)
        if after_rows != rows or after_files != single_files: return reject()
        after=qualify_client_outputs(source,objects,trusted_manifest)
        if after != client: return reject()
        result={'valid':True,'validationScope':'DECLARED_OUTPUT_INVENTORY','releaseApproved':False,
                'sourceQualification':proof,'clientQualification':client,'outputBoundaries':boundaries,
                'outputCount':len(rows),'outputDigest':content_digest(rows),
                'categoryCounts':category_counts(rows,single_files),'limitations':list(LIMITATIONS)}
        if include_output_rows is True: result['outputRows']=rows
        return result
    except (InventoryError,OSError,ValueError,TypeError,KeyError,RecursionError,UnicodeError):
        return reject()


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime-source',required=True,type=Path)
    parser.add_argument('--git-objects',required=True,type=Path)
    args=parser.parse_args()
    manifest=Path(__file__).resolve().parents[2]/'forks/dsh/改造点指纹.json'
    result=qualify_output_inventory(args.runtime_source,args.git_objects,manifest)
    print(json.dumps(result,ensure_ascii=True,indent=2))
    return 0 if result['valid'] else 1


if __name__=='__main__':raise SystemExit(main())
