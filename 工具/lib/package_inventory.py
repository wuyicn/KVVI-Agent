"""Strict v2 package inventory, computed from source snapshots and actual tar bytes.

An untrusted manifest is an integrity record, not an authenticity signature.
Qualification additionally compares every row with the selected current source.
"""
import hashlib
from collections import deque
import json
import os
from pathlib import PurePosixPath
import stat
import unicodedata

VERSION = 'kvvi-macos-pilot/v2'
INTERNAL = '发行包清单.json'
MAX_MANIFEST_BYTES = 16 * 1024 * 1024


class InventoryError(Exception):
    pass


def fail():
    raise InventoryError('PACKAGE_INVENTORY_INVALID')


def _pairs(items):
    result = {}
    for key, value in items:
        if key in result: fail()
        result[key] = value
    return result


def load_json(body):
    try:
        if not isinstance(body, bytes) or len(body) > MAX_MANIFEST_BYTES: fail()
        return json.loads(body.decode('utf-8'), object_pairs_hook=_pairs, parse_constant=lambda _: fail())
    except (ValueError, TypeError, RecursionError, UnicodeError):
        fail()


def _path(value):
    if not isinstance(value, str) or not value or '\\' in value or any(ord(c) < 32 or ord(c) == 127 for c in value): fail()
    if value.startswith('/') or any(p in ('', '.', '..') for p in value.split('/')): fail()
    try: value.encode('utf-8')
    except UnicodeError: fail()
    return value


def _target(path, target):
    if not isinstance(target, str) or not target or target.startswith('/') or '\\' in target or any(ord(c) < 32 or ord(c) == 127 for c in target): fail()
    try: target.encode('utf-8')
    except UnicodeError: fail()
    return target


def validate_rows(rows):
    if not isinstance(rows, list): fail()
    names = {}; spellings = {}
    for row in rows:
        if not isinstance(row, dict): fail()
        path = _path(row.get('path'))
        if path == INTERNAL or path in names: fail()
        names[path] = row
        parts = path.split('/')
        for i in range(1, len(parts) + 1):
            spelling = '/'.join(parts[:i]); key = unicodedata.normalize('NFC', spelling).casefold()
            if key in spellings and spellings[key] != spelling: fail()
            spellings[key] = spelling
        if type(row.get('mode')) is not int: fail()
        if row.get('type') == 'file':
            if set(row) != {'path','type','mode','bytes','sha256'} or row['mode'] not in (0o644,0o755) or type(row['bytes']) is not int or row['bytes'] < 0: fail()
            digest = row['sha256']
            if not isinstance(digest, str) or len(digest) != 71 or not digest.startswith('sha256:') or any(c not in '0123456789abcdef' for c in digest[7:]): fail()
        elif row.get('type') == 'symlink':
            if set(row) != {'path','type','mode','target'} or row['mode'] != 0o777: fail()
            _target(path, row['target'])
        else: fail()
    if [row['path'] for row in rows] != sorted(names): fail()
    directories = {str(parent) for name in names for parent in PurePosixPath(name).parents if str(parent) != '.'}
    if directories & names.keys(): fail()  # no file or link may also be an ancestor
    for path, row in names.items():
        if row['type'] != 'symlink': continue
        stack = path.split('/')[:-1]; pending = deque(_target(path, row['target']).split('/')); expansions = 0
        while pending:
            component = pending.popleft()
            if component in ('', '.'): continue
            if component == '..':
                if not stack: fail()
                stack.pop(); continue
            stack.append(component); prefix = '/'.join(stack); entry = names.get(prefix)
            if entry and entry['type'] == 'symlink':
                expansions += 1
                if expansions > 64: fail()
                stack.pop(); pending.extendleft(reversed(_target(prefix, entry['target']).split('/')))
            elif entry:
                if pending: fail()  # regular file is not traversable, even before /..
            elif prefix not in directories: fail()
    return rows


def content_digest(rows):
    validate_rows(rows)
    return 'sha256:' + hashlib.sha256(json.dumps(rows, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')).hexdigest()


def _identity(s):
    return s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns, s.st_mode


def snapshot(absolute, relative, max_bytes=None):
    _path(relative)
    if max_bytes is not None and (type(max_bytes) is not int or max_bytes < 0): fail()
    before = os.lstat(absolute)
    if stat.S_ISLNK(before.st_mode):
        target = os.readlink(absolute); _target(relative, target)
        if _identity(before) != _identity(os.lstat(absolute)): fail()
        return {'path':relative, 'type':'symlink', 'mode':0o777, 'target':target}, None
    if not stat.S_ISREG(before.st_mode): fail()
    with open(absolute, 'rb', opener=lambda path, flags: os.open(path, flags | os.O_NOFOLLOW | os.O_NONBLOCK)) as handle:
        if _identity(before) != _identity(os.fstat(handle.fileno())): fail()
        if max_bytes is not None and before.st_size > max_bytes: fail()
        body = handle.read() if max_bytes is None else handle.read(max_bytes + 1)
        if max_bytes is not None and len(body) > max_bytes: fail()
        if _identity(before) != _identity(os.fstat(handle.fileno())) or _identity(before) != _identity(os.lstat(absolute)): fail()
    mode = 0o755 if before.st_mode & 0o111 or relative.endswith('kvvi-admin') else 0o644
    return {'path':relative, 'type':'file', 'mode':mode, 'bytes':len(body), 'sha256':'sha256:' + hashlib.sha256(body).hexdigest()}, body


def internal_manifest(rows):
    return {'bundleVersion':VERSION, 'fileCount':len(rows), 'contentDigest':content_digest(rows), 'entries':rows}


def verify_archive(tar, top, rows, internal):
    expected = {top + '/' + row['path']:row for row in validate_rows(rows)}
    seen = set(); actual = []; inner = None
    for member in tar:
        name = _path(member.name)
        if name in seen: fail()
        seen.add(name)
        if set(member.pax_headers) - {'path','linkpath'} or any(member.pax_headers[key] != value for key, value in (('path',member.name),('linkpath',member.linkname)) if key in member.pax_headers): fail()
        if member.uid != 0 or member.gid != 0 or member.uname != 'root' or member.gname != 'root' or member.mtime != 0 or member.devmajor != 0 or member.devminor != 0: fail()
        if name == top + '/' + INTERNAL:
            if member.type != b'0' or member.mode != 0o644 or member.size > MAX_MANIFEST_BYTES: fail()
            with tar.extractfile(member) as handle: inner = load_json(handle.read())
            continue
        row = expected.get(name)
        if row is None or member.mode != row['mode']: fail()
        if row['type'] == 'file':
            if member.type != b'0' or member.size != row['bytes'] or member.linkname: fail()
            digest = hashlib.sha256()
            with tar.extractfile(member) as handle:
                for chunk in iter(lambda:handle.read(1 << 20), b''): digest.update(chunk)
            actual.append(dict(row, sha256='sha256:' + digest.hexdigest()))
        else:
            if not member.issym() or member.size != 0: fail()
            actual.append(dict(row, target=member.linkname))
    actual.sort(key=lambda row:row['path'])
    if seen != set(expected) | {top + '/' + INTERNAL} or actual != rows or inner != internal: fail()
    # Equality alone is permissive for JSON bool/int. Independently validate the embedded shape.
    if not isinstance(inner, dict) or set(inner) != {'bundleVersion','fileCount','contentDigest','entries'} or type(inner['fileCount']) is not int: fail()
    if content_digest(inner['entries']) != inner['contentDigest']: fail()
    if tar.pax_headers: fail()
    # Consume the gzip stream through its CRC/footer, and reject a second tar or
    # payload hidden behind the first zero header. Our writer uses 10 KiB records.
    padding = 1024 + (-(tar.offset + 1024) % 10240)
    tar.fileobj.seek(tar.offset)
    tail = tar.fileobj.read(padding + 1)
    if len(tail) != padding or any(tail): fail()
