"""Kernel start identities for owned processes. No signal is used for discovery."""
import ctypes
import errno
import json
import os
import subprocess
import sys
from pathlib import Path


def parse_pid(value):
    text = str(value).strip()
    if not text.isascii() or not text.isdecimal() or int(text) <= 1:
        raise ValueError('KVVI_PROCESS_PID_INVALID')
    return int(text)


def _observe_with_parent(pid):
    """One kernel observation, including the current parent for edge checks."""
    pid = parse_pid(pid)
    if sys.platform == 'darwin':
        # Layout from the platform SDK's sys/proc_info.h (PROC_PIDTBSDINFO=3).
        class BsdInfo(ctypes.Structure):
            _fields_ = [(name, ctypes.c_uint32) for name in (
                'flags', 'status', 'xstatus', 'pid', 'ppid', 'uid', 'gid', 'ruid',
                'rgid', 'svuid', 'svgid', 'reserved')] + [
                ('comm', ctypes.c_char * 16), ('name', ctypes.c_char * 32)] + [
                (name, ctypes.c_uint32) for name in ('nfiles', 'pgid', 'pjobc', 'tdev', 'tpgid')
            ] + [('nice', ctypes.c_int32), ('start_sec', ctypes.c_uint64),
                 ('start_usec', ctypes.c_uint64)]
        info = BsdInfo()
        lib = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
        lib.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64,
                                    ctypes.c_void_p, ctypes.c_int]
        ctypes.set_errno(0)
        size = lib.proc_pidinfo(pid, 3, 0, ctypes.byref(info), ctypes.sizeof(info))
        if size != ctypes.sizeof(info):
            if ctypes.get_errno() == errno.ESRCH:
                return None
            raise ValueError('KVVI_PROCESS_IDENTITY_UNAVAILABLE')
        if info.status == 5:
            return None
        return dict(pid=pid, ppid=info.ppid, uid=info.uid, pgid=info.pgid,
                    startIdentity=f'darwin:{info.start_sec}:{info.start_usec}')
    if sys.platform == 'linux':
        try:
            raw = Path(f'/proc/{pid}/stat').read_text()
            fields = raw[raw.rfind(')') + 2:].split()
            if fields[0] == 'Z':
                return None
            boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
            return dict(pid=pid, ppid=int(fields[1]), uid=Path(f'/proc/{pid}').stat().st_uid,
                        pgid=int(fields[2]), startIdentity=f'linux:{boot}:{fields[19]}')
        except FileNotFoundError as error:
            if error.filename and (error.filename == f'/proc/{pid}' or error.filename.startswith(f'/proc/{pid}/')):
                return None
            raise ValueError('KVVI_PROCESS_IDENTITY_UNAVAILABLE') from None
        except (OSError, ValueError, IndexError):
            raise ValueError('KVVI_PROCESS_IDENTITY_UNAVAILABLE') from None
    raise ValueError('KVVI_PROCESS_IDENTITY_UNSUPPORTED')


def _public_identity(value):
    # PPID is mutable on reparenting and must not become a saved start identity.
    return {key: value[key] for key in ('pid', 'uid', 'pgid', 'startIdentity')}


def observe(pid):
    """Return immutable start identity plus UID/PGID, or None for exited/zombie."""
    value = _observe_with_parent(pid)
    return None if value is None else _public_identity(value)


def _darwin_pid_candidates(function, pid):
    """libproc wrappers return a PID count (not bytes); never truncate a list."""
    lib = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
    query = getattr(lib, function)
    query.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_int]
    query.restype = ctypes.c_int
    capacity = 64
    while capacity <= 1024 * 1024:
        buffer = (ctypes.c_int * capacity)()
        ctypes.set_errno(0)
        count = query(pid, buffer, ctypes.sizeof(buffer))
        if ctypes.get_errno() or count < 0 or count > capacity:
            raise ValueError('KVVI_PROCESS_MEMBERSHIP_UNAVAILABLE')
        if count < capacity:
            return [value for value in buffer[:count] if value > 1]
        capacity *= 2
    raise ValueError('KVVI_PROCESS_MEMBERSHIP_UNAVAILABLE')


def _candidate_group_pids(pgid):
    if sys.platform == 'darwin':
        return _darwin_pid_candidates('proc_listpgrppids', pgid)
    result = subprocess.run(['ps', '-axo', 'pid=,pgid='], capture_output=True,
                            text=True, timeout=10, check=True)
    return [int(parts[0]) for line in result.stdout.splitlines()
            if len(parts := line.split()) == 2 and int(parts[1]) == pgid and int(parts[0]) > 1]


def _candidate_child_pids(pid):
    if sys.platform == 'darwin':
        return _darwin_pid_candidates('proc_listchildpids', pid)
    result = subprocess.run(['ps', '-axo', 'pid=,ppid='], capture_output=True,
                            text=True, timeout=10, check=True)
    return [int(parts[0]) for line in result.stdout.splitlines()
            if len(parts := line.split()) == 2 and int(parts[1]) == pid and int(parts[0]) > 1]


def group_members(pgid):
    """Only live members; a query failure is unknown, never an empty success."""
    members = {}
    for pid in _candidate_group_pids(pgid):
        identity = observe(pid)
        if identity is not None and identity['pgid'] == pgid:
            members[identity['pid']] = identity
    return members


def descendants(pid):
    pid = parse_pid(pid)
    root = observe(pid)
    if root is None:
        raise ValueError('KVVI_PROCESS_IDENTITY_UNAVAILABLE')
    owned = {pid: root}
    pending = [pid]
    while pending:
        parent = pending.pop()
        if parent != pid:
            before = observe(parent)
            if before is None:
                continue
            if not same_process(before, owned[parent]):
                raise ValueError('KVVI_PROCESS_IDENTITY_CHANGED')
        try:
            candidates = _candidate_child_pids(parent)
        except (OSError, ValueError, subprocess.SubprocessError):
            # If a candidate query fails after an intermediate exits,
            # Only a confirmed absent intermediate permits skipping that edge;
            # root disappearance, permission/unknown, or reuse still fails.
            if parent != pid and observe(parent) is None:
                continue
            raise
        for child in candidates:
            if child <= 1 or child in owned:
                continue
            # Enumeration is only a hint. Bind each edge to kernel PPID,
            # bracketed by the already-owned parent's immutable start identity.
            current_parent = observe(parent)
            if not same_process(current_parent, owned[parent]):
                if parent != pid and current_parent is None:
                    break  # A confirmed exited intermediate cannot own new rows.
                raise ValueError('KVVI_PROCESS_IDENTITY_CHANGED')
            value = _observe_with_parent(child)
            current_parent = observe(parent)
            if not same_process(current_parent, owned[parent]):
                if parent != pid and current_parent is None:
                    break
                raise ValueError('KVVI_PROCESS_IDENTITY_CHANGED')
            if value is not None and value['ppid'] == parent:
                owned[child] = _public_identity(value)
                pending.append(child)
    if not same_process(observe(pid), root):
        raise ValueError('KVVI_PROCESS_IDENTITY_CHANGED')
    del owned[pid]
    return owned


def identity_path(pid_file):
    return Path(pid_file).with_suffix('.identity.json')


def same_process(current, saved):
    return current is not None and all(current.get(key) == saved.get(key)
                                       for key in ('pid', 'uid', 'startIdentity'))


def store_identity(pid_file, home, release_root, program, pid):
    identity = observe(pid)
    if identity is None or identity['uid'] != os.getuid() or identity['pgid'] != pid:
        raise ValueError('KVVI_PROCESS_IDENTITY_UNAVAILABLE')
    identity.update(home=str(Path(home).resolve()), releaseRoot=str(Path(release_root).resolve()),
                    program=program)
    target = identity_path(pid_file)
    temporary = target.with_suffix('.partial')
    with open(temporary, 'w') as handle:
        os.chmod(temporary, 0o600)
        json.dump(identity, handle)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, target)
    Path(pid_file).write_text(str(pid) + '\n')
    return identity


def checked_identity(pid_file, home, release_root, program):
    pid = parse_pid(Path(pid_file).read_text())
    current = observe(pid)
    try:
        saved = json.loads(identity_path(pid_file).read_text())
    except (OSError, ValueError):
        raise ValueError('KVVI_PROCESS_IDENTITY_MISSING')
    expected = dict(pid=pid, home=str(Path(home).resolve()),
                    releaseRoot=str(Path(release_root).resolve()), program=program,
                    uid=os.getuid(), pgid=pid)
    if any(saved.get(key) != value for key, value in expected.items()):
        raise ValueError('KVVI_PROCESS_IDENTITY_MISMATCH')
    if current is not None and any(saved.get(key) != value for key, value in current.items()):
        raise ValueError('KVVI_PROCESS_IDENTITY_MISMATCH')
    if current is None:
        # A dead root cannot prove the exit of descendants that changed session.
        raise ValueError('KVVI_PROCESS_EXIT_UNCONFIRMED')
    return pid, current
