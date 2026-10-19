"""Read-only declared-source inventory. Dependencies and outputs remain unqualified."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import re
import stat
import subprocess


def _safe(path):
    return (isinstance(path, str) and path not in ('', '.') and '\\' not in path
            and '\x00' not in path and not path.startswith('/')
            and all(p not in ('', '.', '..') for p in path.split('/')))


def _git(objects, *args, input_bytes=None):
    env = {**os.environ, 'GIT_NO_REPLACE_OBJECTS': '1'}
    return subprocess.run(['git', '--no-replace-objects', '-C', str(objects), *args], env=env,
                          check=True, input=input_bytes, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120).stdout


def _jsonc(raw):
    text = raw.decode('utf-8')
    tokens = re.compile(r'"(?:[^"\\]|\\.)*"|//[^\r\n]*|/\*.*?\*/', re.S)
    text = tokens.sub(lambda m: m[0] if m[0].startswith('"') else ' ', text)
    text = re.sub(r'"(?:[^"\\]|\\.)*"|,(?=\s*[}\]])',
                  lambda m: m[0] if m[0].startswith('"') else '', text, flags=re.S)
    return json.loads(text)


def _regular(root, rel):
    path = root
    for part in PurePosixPath(rel).parts[:-1]:
        path /= part
        if path.is_symlink():
            raise ValueError('SOURCE_PARENT_LINK')
        if not path.is_dir():
            raise ValueError('SOURCE_ENTRY_MISSING')
    path = root / rel
    if not stat.S_ISREG(path.lstat().st_mode):
        raise ValueError('SOURCE_ENTRY_TYPE_INVALID')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as handle:
        before = os.fstat(handle.fileno())
        body = handle.read()
        after = os.fstat(handle.fileno())
    fields = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
    if fields(before) != fields(after) or len(body) != before.st_size:
        raise ValueError('SOURCE_CHANGED_DURING_READ')
    return body


def qualify_source(source, objects, manifest):
    """Selected roots are administrator controlled; this is not an atomic tree snapshot.

    Git blob hashing uses original bytes. Public contract c14n is not used for
    private index/source-inventory bookkeeping. No executable bit qualification.
    """
    errors, excluded, inventory = [], [], []

    def error(code, path='$'):
        errors.append({'code': code, 'path': path})

    def report(expected=None):
        rows = sorted(inventory, key=lambda x: x[0].encode('utf-8'))
        digest = hashlib.sha256(json.dumps(rows, ensure_ascii=False, separators=(',', ':')).encode('utf-8')).hexdigest()
        return {'valid': not errors, 'validationScope': 'DECLARED_SOURCE_INVENTORY', 'releaseApproved': False,
                'sourceEntryCount': len(expected or {}), 'matchedEntryCount': len(rows),
                'inventoryProfile': 'kvvi-declared-source/v1', 'inventoryDigest': 'sha256:' + digest,
                'errors': sorted(errors, key=lambda x: (x['path'], x['code'])),
                'excludedUnqualified': sorted(excluded)}

    try:
        source = Path(source)
        if source.is_symlink() or not source.is_dir():
            raise ValueError('SOURCE_ROOT_INVALID')
        source = source.resolve()
        base = manifest['upstream_merge_base']; changes = manifest['files']
        if not re.fullmatch('[0-9a-f]{40}', base) or not isinstance(changes, dict) or type(manifest['count']) is not int or manifest['count'] != len(changes):
            raise ValueError('SOURCE_MANIFEST_INVALID')
        for path, item in changes.items():
            if (not _safe(path) or not isinstance(item, dict) or item.get('status') not in ('A', 'M', 'D')
                    or (item['status'] != 'D' and not re.fullmatch('[0-9a-f]{64}', item.get('sha256', '')))):
                raise ValueError('SOURCE_MANIFEST_INVALID')
    except (ValueError, TypeError, KeyError, OSError) as exc:
        error(str(exc) if isinstance(exc, ValueError) else 'SOURCE_MANIFEST_INVALID')
        return report()
    try:
        tree = _git(objects, 'ls-tree', '-rz', '--full-tree', base)
        expected = {}
        for record in tree.split(b'\0'):
            if not record:
                continue
            metadata, path = record.split(b'\t', 1)
            mode, kind, blob = metadata.decode('ascii').split(' ')
            path = path.decode('utf-8')
            if not _safe(path) or kind != 'blob' or mode not in ('100644', '100755', '120000'):
                raise ValueError('BASELINE_LAYOUT_UNSUPPORTED')
            expected[path] = {'mode': mode, 'blob': blob}
    except (subprocess.SubprocessError, OSError):
        error('BASELINE_OBJECT_UNAVAILABLE'); return report()
    except (ValueError, UnicodeError):
        error('BASELINE_LAYOUT_UNSUPPORTED'); return report()
    deleted = set()
    for path, item in changes.items():
        exists = path in expected
        if (item['status'] == 'A' and exists) or (item['status'] in ('M', 'D') and not exists):
            error('SOURCE_MANIFEST_INVALID', path); continue
        if item['status'] == 'D':
            expected.pop(path); deleted.add(path)
        else:
            expected[path] = {'mode': '100644', 'sha256': item['sha256']}
    if errors:
        return report(expected)
    for path in deleted:
        if os.path.lexists(source / path):
            error('DELETED_SOURCE_PRESENT', path)
    configs = {}
    for path, item in sorted(expected.items()):
        try:
            if item['mode'] == '120000':
                # Parents must be actual directories; the final link is the one
                # explicitly declared by the fixed Git blob.
                parent = source
                for part in PurePosixPath(path).parts[:-1]:
                    parent /= part
                    if parent.is_symlink():
                        raise ValueError('SOURCE_PARENT_LINK')
                    if not parent.is_dir():
                        raise ValueError('SOURCE_ENTRY_MISSING')
                body = os.fsencode(os.readlink(source / path))
                target = _git(objects, 'cat-file', 'blob', item['blob'])
                if body != target:
                    raise ValueError('SOURCE_LINK_MISMATCH')
                try:
                    target_path = (source / path).resolve(strict=True)
                except RuntimeError:
                    raise ValueError('SOURCE_LINK_UNAVAILABLE') from None
                if not target_path.is_relative_to(source) or os.path.isabs(os.fsdecode(body)):
                    raise ValueError('SOURCE_LINK_OUTSIDE_ROOT')
                # Every file or target directory must also belong to the fixed
                # source list; a link cannot authorize an output/dependency.
                target_rel = target_path.relative_to(source).as_posix()
                if target_rel not in expected and not any(p.startswith(target_rel + '/') for p in expected):
                    raise ValueError('SOURCE_LINK_TARGET_UNREGISTERED')
            else:
                body = _regular(source, path)
                got = hashlib.sha256(body).hexdigest()
                if 'sha256' in item:
                    matches = got == item['sha256']
                else:
                    matches = hashlib.sha1(b'blob ' + str(len(body)).encode('ascii') + b'\0' + body).hexdigest() == item['blob']
                if not matches:
                    raise ValueError('SOURCE_DIGEST_MISMATCH')
                name = PurePosixPath(path).name
                if name in ('package.json', 'prebuilds.json') or (name.startswith('tsconfig') and name.endswith('.json')):
                    configs[path] = body
            inventory.append([path, 'symlink' if item['mode'] == '120000' else 'file', hashlib.sha256(body).hexdigest()])
        except ValueError as exc:
            error(str(exc), path)
        except FileNotFoundError:
            error('SOURCE_ENTRY_MISSING', path)
        except (OSError, subprocess.SubprocessError):
            error('SOURCE_ENTRY_UNAVAILABLE', path)
    if errors:
        return report(expected)
    roots = {'.git'}
    files = {'.dsh-build/client-build-environment.json', 'tsconfig.host.tsbuildinfo', 'tsconfig.client.tsbuildinfo'}
    try:
        for path, raw in configs.items():
            parent, name = posixpath.dirname(path), posixpath.basename(path)
            data = _jsonc(raw)
            if not isinstance(data, dict):
                raise ValueError()
            if name == 'package.json':
                roots.add(posixpath.join(parent, 'node_modules'))
            elif name.startswith('tsconfig'):
                options = data.get('compilerOptions', {})
                if not isinstance(options, dict):
                    raise ValueError()
                output = options.get('outDir')
                if output is None:
                    continue
                output = posixpath.normpath(posixpath.join(parent, output))
                if not _safe(output):
                    raise ValueError()
                if posixpath.basename(output) == 'types':
                    output = posixpath.dirname(output)
                elif output != 'native/system/packages/entry/lib':
                    raise ValueError()
                if not _safe(output):
                    raise ValueError()
                roots.add(output)
            elif name == 'prebuilds.json':
                for binary in data['binaries']:
                    rel = binary['path']
                    if not _safe(rel):
                        raise ValueError()
                    files.add(posixpath.join(parent, rel))
        if 'apps/web/vite.config.ts' in expected:
            roots.add('apps/web/dist')
    except (ValueError, TypeError, KeyError, UnicodeError):
        error('SOURCE_BUILD_LAYOUT_UNSUPPORTED'); return report(expected)
    parents = set()
    for path in set(expected) | roots | files:
        parents.update(str(p) for p in PurePosixPath(path).parents if str(p) != '.')

    def visit(directory, prefix=''):
        for entry in sorted(os.scandir(directory), key=lambda x: os.fsencode(x.name)):
            path = posixpath.join(prefix, entry.name)
            if path in expected:
                continue
            if path in roots or path in files:
                if entry.is_symlink():
                    error('EXCLUDED_ROOT_LINK', path)
                elif path == '.git' and not (entry.is_dir(follow_symlinks=False) or entry.is_file(follow_symlinks=False)):
                    error('EXCLUDED_ROOT_TYPE_INVALID', path)
                elif path in roots and not entry.is_dir(follow_symlinks=False) and path != '.git':
                    error('EXCLUDED_ROOT_TYPE_INVALID', path)
                elif path in files and not entry.is_file(follow_symlinks=False):
                    error('EXCLUDED_ROOT_TYPE_INVALID', path)
                else:
                    excluded.append(path)
                continue
            if entry.is_dir(follow_symlinks=False) and path in parents:
                visit(entry.path, path)
            else:
                error('UNEXPECTED_SOURCE_PATH', path)
    try:
        visit(source)
    except OSError:
        error('SOURCE_ENTRY_UNAVAILABLE')
    return report(expected)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True, type=Path)
    parser.add_argument('--git-objects', required=True, type=Path)
    parser.add_argument('--manifest', type=Path, default=Path(__file__).resolve().parents[2] / 'forks/dsh/改造点指纹.json')
    args = parser.parse_args()
    try:
        result = qualify_source(args.source, args.git_objects, json.loads(args.manifest.read_text(encoding='utf-8')))
    except (OSError, ValueError):
        result = {'valid': False, 'errors': [{'code': 'SOURCE_MANIFEST_INVALID', 'path': '$'}], 'releaseApproved': False}
    print(json.dumps(result, ensure_ascii=True, indent=2))
    return 0 if result['valid'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
