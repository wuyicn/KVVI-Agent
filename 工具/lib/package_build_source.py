"""Stage only fixed declared source into a new or empty owned build input.

No dependency install or build runs here. Modes use package normalization;
expected source executable policy and raw permissions remain unqualified.
Administrator-controlled roots are required, without an atomic-tree claim.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import tempfile

from .package_client import _directory
from .package_inventory import InventoryError, snapshot, validate_rows, fixed_source_index, content_digest
from .package_provenance import qualify_runtime_source

LIMITATIONS=('source-executable-policy','raw-filesystem-permissions','dependencies',
             'build-execution','catalog-consumption','release-acceptance')


def reject():
    return {'valid':False,'validationScope':'DECLARED_SOURCE_STAGE','releaseApproved':False,'code':'BUILD_SOURCE_STAGE_REJECTED'}


def target_state(target):
    if target.is_symlink(): raise InventoryError('BUILD_SOURCE_TARGET_INVALID')
    if not target.exists(): return None
    info=target.lstat()
    if not stat.S_ISDIR(info.st_mode) or any(target.iterdir()): raise InventoryError('BUILD_SOURCE_TARGET_NOT_EMPTY')
    return info.st_dev,info.st_ino,info.st_mode,info.st_mtime_ns,info.st_ctime_ns


def target_path(value):
    value=os.fspath(value)
    if not isinstance(value,str) or not os.path.isabs(value) or '..' in value.split(os.sep):
        raise InventoryError('BUILD_SOURCE_TARGET_INVALID')
    target=Path(os.path.normpath(value))
    if target.parent.is_symlink() or not target.parent.is_dir(): raise InventoryError('BUILD_SOURCE_PARENT_INVALID')
    return target


def inside_protected_root(target,protected):
    protected=Path(protected).resolve(strict=True)
    if target.is_relative_to(protected):return True
    # APFS can resolve case aliases to the same directories without changing
    # their spelling in pathlib. Identity of any existing ancestor is decisive.
    identity=protected.stat();wanted=(identity.st_dev,identity.st_ino)
    for ancestor in (target,*target.parents):
        try:info=ancestor.stat()
        except FileNotFoundError:continue
        if (info.st_dev,info.st_ino)==wanted:return True
    return False


def source_snapshot(root,path,kind,digest):
    parent=Path(path).parent.as_posix()
    if parent != '.' and not _directory(root,parent): raise InventoryError('BUILD_SOURCE_PARENT_INVALID')
    row,body=snapshot(root/path,path)
    actual=row['sha256'][7:] if row['type']=='file' else hashlib.sha256(row['target'].encode('utf-8')).hexdigest()
    if row['type'] != kind or actual != digest: raise InventoryError('BUILD_SOURCE_MATERIAL_MISMATCH')
    return row,body


def material_rows(root,source_rows):
    rows=[source_snapshot(root,*entry)[0] for entry in source_rows]
    rows.sort(key=lambda row:row['path']);validate_rows(rows)
    return rows


def verify_stage_paths(stage,source_rows):
    # Full source qualification intentionally allows declared output/dependency
    # roots. A clean build input additionally has no entries beyond fixed source.
    wanted={row[0] for row in source_rows}
    wanted |= {parent.as_posix() for path in tuple(wanted) for parent in Path(path).parents if parent.as_posix()!='.'}
    actual=set()
    def walk_error(error):raise error
    for directory,dirs,files in os.walk(stage,followlinks=False,onerror=walk_error):
        prefix=Path(directory).relative_to(stage)
        actual.update((prefix/name).as_posix() for name in dirs+files)
    if actual != wanted:raise InventoryError('BUILD_SOURCE_STAGE_EXTRA_OR_MISSING_PATH')


def stage_declared_source(source,objects,trusted_manifest,into,*,include_material_rows=False):
    try:
        target=target_path(into);initial_target=target_state(target)
        proof=qualify_runtime_source(source,objects,trusted_manifest,include_source_rows=True)
        if proof.get('valid') is not True: return reject()
        source_rows=proof.pop('sourceRows');fixed_source_index(source_rows,proof)
        root=Path(source)
        canonical_target=target.parent.resolve(strict=True)/target.name
        if any(inside_protected_root(canonical_target,protected) for protected in (source,objects)):
            return reject()
        with tempfile.TemporaryDirectory(prefix='kvvi-build-source-stage-',dir=target.parent) as temporary:
            stage=Path(temporary).resolve();rows=[];links=[]
            for path,kind,digest in source_rows:
                row,body=source_snapshot(root,path,kind,digest);rows.append(row)
                output=stage/path;output.parent.mkdir(parents=True,exist_ok=True)
                if kind=='file':
                    fd=os.open(output,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
                    with os.fdopen(fd,'wb') as handle:
                        handle.write(body);os.fchmod(handle.fileno(),row['mode'])
                else:links.append((output,row['target']))
            rows.sort(key=lambda row:row['path']);validate_rows(rows)
            for path,text in links:path.symlink_to(text)
            for path,_ in links:
                if not path.resolve(strict=True).is_relative_to(stage): raise InventoryError('BUILD_SOURCE_LINK_INVALID')
            if material_rows(root,source_rows) != rows: return reject()
            if qualify_runtime_source(source,objects,trusted_manifest) != proof: return reject()
            if material_rows(stage,source_rows) != rows: return reject()
            staged=qualify_runtime_source(stage,objects,trusted_manifest)
            if staged.get('valid') is not True: return reject()
            if {k:v for k,v in staged.items() if k!='excludedUnqualified'} != {k:v for k,v in proof.items() if k!='excludedUnqualified'}:
                return reject()
            if material_rows(stage,source_rows) != rows: return reject()
            verify_stage_paths(stage,source_rows)
            material_digest=content_digest(rows)
            if target_state(target) != initial_target: return reject()
            os.replace(stage,target)
        result={'valid':True,'validationScope':'DECLARED_SOURCE_STAGE','releaseApproved':False,
                'sourceQualification':staged,'materialCount':len(rows),'materialDigest':material_digest,
                'limitations':list(LIMITATIONS)}
        if include_material_rows is True: result['materialRows']=rows
        return result
    except (InventoryError,OSError,ValueError,TypeError,KeyError,RecursionError,UnicodeError,RuntimeError):
        return reject()


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime-source',required=True,type=Path)
    parser.add_argument('--git-objects',required=True,type=Path)
    parser.add_argument('--into',required=True,type=Path)
    args=parser.parse_args()
    manifest=Path(__file__).resolve().parents[2]/'forks/dsh/改造点指纹.json'
    result=stage_declared_source(args.runtime_source,args.git_objects,manifest,args.into)
    print(json.dumps(result,ensure_ascii=True,indent=2))
    return 0 if result['valid'] else 1


if __name__=='__main__':raise SystemExit(main())
