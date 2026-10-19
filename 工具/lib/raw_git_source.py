"""Export fixed Git blob bytes into a new or empty administrator-selected root."""
import hashlib
import os
from pathlib import Path
import re
import subprocess
import tempfile

from .runtime_source import _git, _safe


def _target(path):
    if path.is_symlink():
        raise ValueError('RAW_SOURCE_TARGET_INVALID')
    if path.exists() and (not path.is_dir() or any(path.iterdir())):
        raise ValueError('RAW_SOURCE_TARGET_NOT_EMPTY')


def export_raw_baseline(objects, base, into):
    """No checkout/archive transforms, filters, hooks, builds or source execution.

    A failed export leaves the selected empty target unchanged. This is not an
    atomic snapshot against a concurrent administrator changing its parents.
    """
    try:
        return _export_raw_baseline(objects, base, into)
    except (OSError, RuntimeError, subprocess.SubprocessError):
        raise ValueError('RAW_SOURCE_EXPORT_FAILED') from None


def _export_raw_baseline(objects, base, into):
    into = Path(into).absolute()
    _target(into)
    try:
        if not isinstance(base, str) or not re.fullmatch('[0-9a-f]{40}', base):
            raise ValueError()
        raw = _git(objects, 'ls-tree', '-rz', '--full-tree', base)
        entries = []
        for record in raw.split(b'\0'):
            if not record:
                continue
            header, path = record.split(b'\t', 1)
            mode, kind, blob = header.decode('ascii').split(' ')
            path = path.decode('utf-8')
            if not _safe(path) or kind != 'blob' or mode not in ('100644', '100755', '120000') or not re.fullmatch('[0-9a-f]{40}', blob):
                raise ValueError()
            entries.append((mode, blob, path))
        if not entries:
            raise ValueError()
    except (ValueError, OSError, subprocess.SubprocessError):
        raise ValueError('RAW_SOURCE_BASELINE_UNAVAILABLE') from None
    paths = {path for _, _, path in entries}
    if len(paths) != len(entries) or any(str(parent) in paths for path in paths for parent in Path(path).parents if str(parent) != '.'):
        raise ValueError('RAW_SOURCE_BASELINE_UNAVAILABLE')
    into.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='kvvi-source-stage-', dir=into.parent) as temporary:
        stage = Path(temporary).resolve()
        links = []
        try:
            for start in range(0, len(entries), 128):
                chunk = entries[start:start + 128]
                raw = _git(objects, 'cat-file', '--batch', input_bytes=('\n'.join(item[1] for item in chunk) + '\n').encode('ascii'))
                at = 0
                for mode, blob, rel in chunk:
                    end = raw.index(b'\n', at)
                    actual, kind, length = raw[at:end].split(b' ')
                    length = int(length)
                    if length < 0 or actual.decode('ascii') != blob or kind != b'blob':
                        raise ValueError()
                    body = raw[end + 1:end + 1 + length]
                    at = end + length + 2
                    if len(body) != length or raw[at - 1:at] != b'\n' or hashlib.sha1(b'blob ' + str(length).encode('ascii') + b'\0' + body).hexdigest() != blob:
                        raise ValueError()
                    path = stage / rel
                    path.parent.mkdir(parents=True, exist_ok=True)
                    if mode == '120000':
                        links.append((path, body))
                    else:
                        # O_EXCL rejects file aliases on case-insensitive or
                        # Unicode-normalizing filesystems instead of overwriting.
                        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                        with os.fdopen(fd, 'wb') as handle:
                            handle.write(body)
                        path.chmod(0o755 if mode == '100755' else 0o644)
                if at != len(raw):
                    raise ValueError()
        except (ValueError, OSError, subprocess.SubprocessError):
            raise ValueError('RAW_SOURCE_EXPORT_FAILED') from None
        try:
            for path, target in links:
                if os.path.isabs(target) or b'\0' in target:
                    raise ValueError()
                path.symlink_to(os.fsdecode(target))
            for path, _ in links:
                if not path.resolve(strict=True).is_relative_to(stage):
                    raise ValueError()
        except (ValueError, RuntimeError, OSError):
            raise ValueError('RAW_SOURCE_LINK_INVALID') from None
        # Directory aliases can merge without a file collision (Src/one and
        # src/two). Require the actual spelling/set of every directory and entry.
        wanted = paths | {str(parent) for path in paths for parent in Path(path).parents if str(parent) != '.'}
        actual = set()
        for directory, dirs, names in os.walk(stage, followlinks=False):
            prefix = Path(directory).relative_to(stage)
            actual.update((prefix / name).as_posix() for name in dirs + names)
        if actual != wanted:
            raise ValueError('RAW_SOURCE_EXPORT_FAILED')
        # Never replace a populated target after waiting on Git or I/O.
        _target(into)
        os.replace(stage, into)
