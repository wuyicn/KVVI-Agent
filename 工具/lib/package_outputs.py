"""Serialized two-file publication with process-interruption rollback.

This does not make independent files atomic to external readers or claim tested
power-loss durability. Only administrator-controlled output roots are supported.
"""
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import tempfile
import time
import unicodedata


class PublicationError(Exception):
    pass


def _fail(code='PACKAGE_PUBLICATION_RECOVERY_REQUIRED'):
    raise PublicationError(code)


def _paths(archive, manifest):
    pair = [Path(archive).absolute(), Path(manifest).absolute()]
    if pair[0].parent != pair[1].parent or pair[0].name == pair[1].name or any(unicodedata.normalize('NFC', p.name).casefold().startswith(('.kvvi-', 'kvvi-package-')) for p in pair):
        _fail('PACKAGE_OUTPUT_INVALID')
    root = pair[0].parent
    if root.is_symlink():
        _fail('PACKAGE_OUTPUT_INVALID')
    if all(os.path.lexists(p) for p in pair) and os.path.samefile(*pair):
        _fail('PACKAGE_OUTPUT_INVALID')
    return root, pair


def _distinct_names(root, pair):
    """Use the destination filesystem's rules, including case/Unicode aliases."""
    with tempfile.TemporaryDirectory(prefix='kvvi-package-name-probe-', dir=root) as probe:
        for path in pair:
            try:
                fd = os.open(Path(probe) / path.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            except FileExistsError:
                _fail('PACKAGE_OUTPUT_INVALID')
            os.close(fd)


def _digest(path):
    if not os.path.lexists(path):
        return None
    if not stat.S_ISREG(path.lstat().st_mode):
        _fail('PACKAGE_OUTPUT_INVALID')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as handle:
        before = os.fstat(handle.fileno())
        if not stat.S_ISREG(before.st_mode):
            _fail('PACKAGE_OUTPUT_INVALID')
        digest = hashlib.sha256()
        for chunk in iter(lambda: handle.read(1 << 20), b''):
            digest.update(chunk)
        after = os.fstat(handle.fileno())
    identity = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
    if identity(before) != identity(after):
        _fail('PACKAGE_OUTPUT_CHANGED')
    return digest.hexdigest()


def _copy(source, target):
    shutil.copy2(source, target)
    with open(target, 'ab') as handle:
        handle.flush(); os.fsync(handle.fileno())


def _directory(root, name, prefix):
    if not isinstance(name, str) or not re.fullmatch(re.escape(prefix) + r'[A-Za-z0-9_-]+', name):
        _fail()
    path = root / name
    if path.is_symlink() or not path.is_dir():
        _fail()
    return path


def _journal(root):
    return root / '.kvvi-package-publication.json'


def _pairs(values):
    result = {}
    for key, value in values:
        if key in result:
            _fail()
        result[key] = value
    return result


def recover_pair(archive, manifest):
    """Caller holds output_guard. Validate every recovery input before changing any file."""
    root, pair = _paths(archive, manifest)
    journal = _journal(root)
    if not os.path.lexists(journal):
        return
    try:
        if not stat.S_ISREG(journal.lstat().st_mode):
            _fail()
        fd = os.open(journal, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, 'rb') as handle:
            if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
                _fail()
            raw = handle.read(65537)
        if len(raw) > 65536:
            _fail()
        state = json.loads(raw, object_pairs_hook=_pairs)
        if not isinstance(state, dict) or set(state) != {'version', 'backup', 'candidate', 'files'} or type(state['version']) is not int or state['version'] != 1:
            _fail()
        backup = _directory(root, state['backup'], 'kvvi-package-backup-')
        candidate = root / state['candidate'] if isinstance(state['candidate'], str) else root
        if not re.fullmatch(r'kvvi-package-candidate-[A-Za-z0-9_-]+', state['candidate']) or candidate.is_symlink() or (os.path.lexists(candidate) and not candidate.is_dir()):
            _fail()
        rows = state['files']
        if not isinstance(rows, list) or len(rows) != 2:
            _fail()
        actions = []
        for i, (path, row) in enumerate(zip(pair, rows)):
            if not isinstance(row, dict) or set(row) != {'name', 'existed', 'oldSha', 'newSha', 'backup'} or row['name'] != path.name or type(row['existed']) is not bool or row['backup'] != str(i):
                _fail()
            if not isinstance(row['newSha'], str) or not re.fullmatch('[0-9a-f]{64}', row['newSha']):
                _fail()
            if row['existed']:
                if not isinstance(row['oldSha'], str) or not re.fullmatch('[0-9a-f]{64}', row['oldSha']) or _digest(backup / str(i)) != row['oldSha']:
                    _fail()
            elif row['oldSha'] is not None:
                _fail()
            current = _digest(path)
            if current not in (row['oldSha'], row['newSha'], None):
                _fail()  # external edits must not be overwritten by automatic recovery
            actions.append((path, row, current))
        for path, row, current in actions:
            if current == row['oldSha']:
                continue
            if row['existed']:
                fd, pending = tempfile.mkstemp(prefix='.kvvi-restore-', dir=root); os.close(fd)
                try:
                    _copy(backup / row['backup'], pending)
                    os.replace(pending, path)
                finally:
                    if os.path.lexists(pending):
                        os.unlink(pending)
            elif current is not None:
                path.unlink()
        journal.unlink()
        shutil.rmtree(backup)
        if candidate.exists():
            shutil.rmtree(candidate)
    except PublicationError:
        raise
    except (OSError, ValueError, TypeError, KeyError, RecursionError):
        _fail()


@contextmanager
def output_guard(archive, manifest):
    root, pair = _paths(archive, manifest)
    root.mkdir(parents=True, exist_ok=True)
    fd = None; locked = False
    try:
        _distinct_names(root, pair)
        fd = os.open(root / '.kvvi-package.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            _fail('PACKAGE_OUTPUT_INVALID')
        deadline = time.monotonic() + 5
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB); locked = True; break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    _fail('PACKAGE_OUTPUT_LOCKED')
                time.sleep(0.02)
        recover_pair(*pair)
        for path in pair:
            _digest(path)
        yield
    except OSError:
        _fail('PACKAGE_OUTPUT_UNAVAILABLE')
    finally:
        if fd is not None:
            try:
                if locked:
                    fcntl.flock(fd, fcntl.LOCK_UN)
            finally:
                os.close(fd)


def publish_pair(archive_candidate, manifest_candidate, archive, manifest):
    """Caller holds output_guard; pending journal/backup remain if rollback fails."""
    root, pair = _paths(archive, manifest)
    candidates = [Path(archive_candidate), Path(manifest_candidate)]
    directory = candidates[0].parent
    if directory.parent != root or directory != candidates[1].parent:
        _fail('PACKAGE_CANDIDATE_INVALID')
    _directory(root, directory.name, 'kvvi-package-candidate-')
    backup = Path(tempfile.mkdtemp(prefix='kvvi-package-backup-', dir=root))
    journal = _journal(root)
    pending = None
    try:
        rows = []
        for i, (path, candidate) in enumerate(zip(pair, candidates)):
            old = _digest(path); new = _digest(candidate)
            if new is None:
                _fail('PACKAGE_CANDIDATE_INVALID')
            if old is not None:
                _copy(path, backup / str(i))
                if _digest(backup / str(i)) != old or _digest(path) != old:
                    _fail('PACKAGE_OUTPUT_CHANGED')
            rows.append({'name': path.name, 'existed': old is not None, 'oldSha': old, 'newSha': new, 'backup': str(i)})
        state = {'version': 1, 'backup': backup.name, 'candidate': directory.name, 'files': rows}
        fd, pending = tempfile.mkstemp(prefix='.kvvi-publication-', dir=root)
        with os.fdopen(fd, 'w', encoding='utf-8') as handle:
            json.dump(state, handle, ensure_ascii=True); handle.flush(); os.fsync(handle.fileno())
        os.replace(pending, journal); pending = None
        for candidate, path in zip(candidates, pair):
            os.replace(candidate, path)
        journal.unlink()
        shutil.rmtree(backup, ignore_errors=True)  # publication is committed; cleanup cannot turn it into failure
    except BaseException:
        if os.path.lexists(journal):
            try:
                recover_pair(*pair)
            except Exception:
                _fail()
        else:
            shutil.rmtree(backup, ignore_errors=True)
        raise PublicationError('PACKAGE_PUBLICATION_FAILED') from None
    finally:
        if pending is not None and os.path.lexists(pending):
            os.unlink(pending)
