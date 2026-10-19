"""Owned argv sessions, with a leader held until cleanup acknowledgment.

The session and observed descendants are covered, not unobserved daemon escape.
No shell, inherited command environment, or existing log overwrite is used.
"""
import json
import math
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from distribution.lib.process_identity import observe, same_process, group_members, descendants

POLL_SECONDS = 0.05
TERM_SECONDS = 1.0
KILL_SECONDS = 1.0
START_SECONDS = 5.0
CANCEL_SECONDS = 45.0
CONTROL_ERRORS = (OSError, ValueError, TypeError, KeyError, RecursionError, subprocess.SubprocessError)


def _write_json(path, value):
    temporary = path.with_suffix('.partial')
    with temporary.open('x', encoding='utf-8') as handle:
        os.chmod(temporary, 0o600)
        json.dump(value, handle)
    os.replace(temporary, path)


def _read_json(path):
    with path.open('rb') as handle:
        body = handle.read(1024 * 1024 + 1)
    if len(body) > 1024 * 1024:
        raise ValueError('BUILD_COMMAND_CONTROL_INVALID')
    return json.loads(body.decode('utf-8'))


def _checked_root(saved):
    current = observe(saved['pid'])
    if not same_process(current, saved) or current['uid'] != os.getuid() or current['pgid'] != saved['pid']:
        raise ValueError('BUILD_COMMAND_IDENTITY_UNAVAILABLE_OR_CHANGED')
    return current


def _collect(saved, known):
    _checked_root(saved)
    members = group_members(saved['pid'])
    values = {**descendants(saved['pid']), **members}
    if any(value['uid'] != os.getuid() for value in values.values()):
        raise ValueError('BUILD_COMMAND_FOREIGN_UID')
    # Bind the whole discovery to our saved leader, before adopting any rows.
    _checked_root(saved)
    known.update(values)
    return members


def _remaining(saved, known):
    members = _collect(saved, known)
    active = {pid: value for pid, value in members.items() if pid != saved['pid']}
    for pid, value in known.items():
        if pid != saved['pid'] and same_process(observe(pid), value):
            active[pid] = value
    return active


def _signal_escaped(saved, known, number):
    for pid, value in known.items():
        _checked_root(saved)
        current = observe(pid)
        if pid != saved['pid'] and same_process(current, value) and current['pgid'] != saved['pid']:
            try:
                os.kill(pid, number)
            except ProcessLookupError:
                pass


def _signal_owned(saved, known, number):
    _collect(saved, known)
    _signal_escaped(saved, known, number)
    _checked_root(saved)
    os.killpg(saved['pid'], number)


def _await_children(saved, known, seconds):
    deadline = time.monotonic() + seconds
    while True:
        if not _remaining(saved, known):
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(POLL_SECONDS)


def _merge_identities(known, rows):
    if not isinstance(rows, list):
        raise ValueError('BUILD_COMMAND_CONTROL_INVALID')
    for value in rows:
        if (not isinstance(value, dict) or set(value) != {'pid', 'uid', 'pgid', 'startIdentity'}
                or type(value['pid']) is not int or value['pid'] <= 1
                or type(value['pgid']) is not int or value['pgid'] <= 1
                or type(value['uid']) is not int or value['uid'] != os.getuid()
                or not isinstance(value['startIdentity'], str) or not value['startIdentity']):
            raise ValueError('BUILD_COMMAND_CONTROL_INVALID')
        if value['pid'] in known and not same_process(value, known[value['pid']]):
            raise ValueError('BUILD_COMMAND_IDENTITY_UNAVAILABLE_OR_CHANGED')
        known[value['pid']] = value


def _worker_own_group(number):
    # Called only inside the live worker. No stored numeric leader is trusted.
    if os.getpgrp() != os.getpid():
        raise ValueError('BUILD_COMMAND_WORKER_SESSION_CHANGED')
    os.killpg(os.getpgrp(), number)


def _worker_stop(control, saved, known, child):
    discovery_ok = True
    try:
        if (control / 'cancel.json').exists():
            _merge_identities(known, _read_json(control / 'cancel.json')['observedIdentities'])
        _collect(saved, known)
    except CONTROL_ERRORS:
        discovery_ok = False
    # Even when discovery is unavailable, the live worker can stop its intrinsic
    # session. Unknown escaped scope remains unconfirmed, never a success.
    _worker_own_group(signal.SIGTERM)
    try:
        _signal_escaped(saved, known, signal.SIGTERM)
    except CONTROL_ERRORS:
        discovery_ok = False
    stopped = False
    deadline = time.monotonic() + TERM_SECONDS
    while True:
        if child is not None:
            child.poll()
        try:
            stopped = not _remaining(saved, known)
        except CONTROL_ERRORS:
            discovery_ok = False
            break
        if stopped or time.monotonic() >= deadline:
            break
        time.sleep(POLL_SECONDS)
    status = dict(cleanupConfirmed=stopped and discovery_ok,
                  discoveryConfirmed=discovery_ok, signalEscalated=not stopped,
                  observedIdentities=list(known.values()))
    if not stopped:
        try:
            _signal_escaped(saved, known, signal.SIGKILL)
        except CONTROL_ERRORS:
            status.update(cleanupConfirmed=False, discoveryConfirmed=False)
        # Publish before killing this session leader; the parent must verify all
        # observed identities and group exit before promoting this to confirmed.
        _write_json(control / 'stopped.json', status)
        _worker_own_group(signal.SIGKILL)
    else:
        if child is not None:
            child.wait(timeout=KILL_SECONDS)
        _write_json(control / 'stopped.json', status)
    return 70


def _worker(control):
    config = _read_json(control / 'input.json')
    # Caught TERM resets on exec, so the actual command gets default semantics.
    signal.signal(signal.SIGTERM, lambda *_: None)
    saved = observe(os.getpid())
    if saved is None or saved['pgid'] != os.getpid() or saved['uid'] != os.getuid():
        return 70
    controller = config['controllerIdentity']
    _merge_identities({}, [controller])
    known = {saved['pid']: saved}
    (control / 'ready').write_text('ready\n')
    deadline = time.monotonic() + START_SECONDS
    while not (control / 'go').exists():
        if (control / 'cancel.json').exists() or not same_process(observe(controller['pid']), controller):
            _write_json(control / 'stopped.json', dict(cleanupConfirmed=True,
                        discoveryConfirmed=True, signalEscalated=False,
                        observedIdentities=list(known.values())))
            return 70
        if time.monotonic() > deadline:
            return 70
        time.sleep(0.01)
    child = None
    try:
        child = subprocess.Popen(config['argv'], cwd=config['cwd'], env=config['env'], stdin=subprocess.DEVNULL)
        reported = False
        while True:
            _collect(saved, known)
            if ((control / 'cancel.json').exists()
                    or not same_process(observe(controller['pid']), controller)):
                return _worker_stop(control, saved, known, child)
            code = child.poll()
            if code is not None and not reported:
                _write_json(control / 'result.json', {'exitCode': code,
                            'observedIdentities': list(known.values())})
                reported = True
            if reported and (control / 'ack').exists():
                if _remaining(saved, known):
                    return _worker_stop(control, saved, known, child)
                return 0
            time.sleep(POLL_SECONDS)
    except CONTROL_ERRORS:
        return _worker_stop(control, saved, known, child)


def _adopt_stopped_status(control, known, result):
    status = _read_json(control / 'stopped.json')
    if (not isinstance(status, dict) or set(status) != {'cleanupConfirmed', 'discoveryConfirmed', 'signalEscalated', 'observedIdentities'}
            or any(type(status[key]) is not bool for key in ('cleanupConfirmed', 'discoveryConfirmed', 'signalEscalated'))):
        raise ValueError('BUILD_COMMAND_CONTROL_INVALID')
    _merge_identities(known, status['observedIdentities'])
    result['signalEscalated'] = result['signalEscalated'] or status['signalEscalated']
    return status


def _cancel_and_confirm(process, control, known, result):
    if process.poll() is None:
        _write_json(control / 'cancel.json', {'observedIdentities': list(known.values())})
        process.wait(timeout=CANCEL_SECONDS)
    status = _adopt_stopped_status(control, known, result)
    if not (control / 'go').exists():
        result['cleanupConfirmed'] = True  # No command was authorized to start.
    else:
        result['cleanupConfirmed'] = (status['discoveryConfirmed'] and not group_members(process.pid)
                and not any(same_process(observe(pid), value) for pid, value in known.items()))


def _stop_known_children(known, root_pid):
    """Saved child starts remain owned after leader death; never signal its group."""
    def active():
        pending = {}
        unknown = False
        for pid, value in known.items():
            if pid == root_pid:
                continue
            try:
                current = observe(pid)
                if same_process(current, value):
                    pending[pid] = value
            except CONTROL_ERRORS:
                unknown = True
        return pending, unknown

    def send(rows, number):
        for pid, value in rows.items():
            try:
                if same_process(observe(pid), value):
                    os.kill(pid, number)
            except CONTROL_ERRORS:
                pass  # Re-query below; unavailable identities are never signalled.

    pending, unknown = active()
    send(pending, signal.SIGTERM)
    deadline = time.monotonic() + TERM_SECONDS
    while pending and time.monotonic() < deadline:
        time.sleep(POLL_SECONDS)
        pending, unknown = active()
    escalated = bool(pending)
    if pending:
        send(pending, signal.SIGKILL)
        deadline = time.monotonic() + KILL_SECONDS
        while pending and time.monotonic() < deadline:
            time.sleep(POLL_SECONDS)
            pending, unknown = active()
    return not pending and not unknown, escalated


def _execute(process, control, known, result, timeout_seconds):
    saved = None
    acknowledged = False
    try:
        deadline = time.monotonic() + START_SECONDS
        while not (control / 'ready').is_file():
            if process.poll() is not None or time.monotonic() > deadline:
                raise ValueError('BUILD_COMMAND_START_FAILED')
            time.sleep(0.01)
        saved = observe(process.pid)
        if saved is None or saved['uid'] != os.getuid() or saved['pgid'] != process.pid:
            raise ValueError('BUILD_COMMAND_IDENTITY_UNAVAILABLE_OR_CHANGED')
        known[process.pid] = saved
        _checked_root(saved)
        (control / 'go').write_text('go\n')
        deadline = time.monotonic() + timeout_seconds
        while not (control / 'result.json').is_file():
            if process.poll() is not None:
                raise ValueError('BUILD_COMMAND_WORKER_FAILED')
            _collect(saved, known)
            if time.monotonic() >= deadline:
                result['timedOut'] = True
                break
            time.sleep(POLL_SECONDS)
        if (control / 'result.json').is_file():
            status = _read_json(control / 'result.json')
            if (not isinstance(status, dict) or set(status) != {'exitCode', 'observedIdentities'}
                    or type(status['exitCode']) is not int):
                raise ValueError('BUILD_COMMAND_RESULT_INVALID')
            _checked_root(saved)
            _merge_identities(known, status['observedIdentities'])
            _checked_root(saved)
            result['exitCode'] = status['exitCode']
        left_children = bool(_remaining(saved, known))
        if result['timedOut'] or left_children:
            _signal_owned(saved, known, signal.SIGTERM)
            if not _await_children(saved, known, TERM_SECONDS):
                result['signalEscalated'] = True
                _signal_owned(saved, known, signal.SIGKILL)
            else:
                (control / 'ack').write_text('ack\n')
                acknowledged = True
        else:
            (control / 'ack').write_text('ack\n')
            acknowledged = True
        process.wait(timeout=KILL_SECONDS + 1)
        discovery_confirmed = True
        if (control / 'stopped.json').is_file():
            discovery_confirmed = _adopt_stopped_status(control, known, result)['discoveryConfirmed']
        # No more parent group signals after releasing the session leader.
        result['cleanupConfirmed'] = (discovery_confirmed and not group_members(saved['pid'])
                and not any(same_process(observe(pid), value) for pid, value in known.items()))
        if not result['cleanupConfirmed']:
            result['code'] = 'BUILD_COMMAND_EXIT_UNCONFIRMED'
        elif result['timedOut']:
            result['code'] = 'BUILD_COMMAND_TIMEOUT'
        elif left_children:
            result['code'] = 'BUILD_COMMAND_LEFT_CHILDREN'
        elif result['exitCode'] != 0:
            result['code'] = 'BUILD_COMMAND_FAILED'
        elif process.returncode != 0 or not acknowledged:
            result['code'] = 'BUILD_COMMAND_WORKER_FAILED'
        else:
            result.update(valid=True, code='BUILD_COMMAND_OK')
    except BaseException as error:
        result.update(valid=False, cleanupConfirmed=False, code='BUILD_COMMAND_CONTROL_OR_IDENTITY_FAILED')
        # Keep control files and the held leader until cooperative stop finishes.
        try:
            _cancel_and_confirm(process, control, known, result)
        except CONTROL_ERRORS:
            result['cleanupConfirmed'] = False
        finally:
            if process.poll() is None:
                try:
                    process.kill()
                    process.wait(timeout=2)
                except CONTROL_ERRORS:
                    pass
                result['cleanupConfirmed'] = False
            # This does not require a still-live root: each saved child was
            # adopted under the checked root, and is rechecked before signalling.
            stopped, escalated = _stop_known_children(known, process.pid)
            result['signalEscalated'] = result['signalEscalated'] or escalated
            if not stopped:
                result['cleanupConfirmed'] = False
        if not isinstance(error, CONTROL_ERRORS):
            raise
    finally:
        if process.poll() is None:
            # Only our direct Popen child, after bounded cooperative cancellation.
            # A failed/unknown stop cannot be upgraded to confirmed by this kill.
            try:
                process.kill()
                process.wait(timeout=2)
            except CONTROL_ERRORS:
                pass
            result.update(valid=False, cleanupConfirmed=False)


def run_owned_command(argv, cwd, env, log_path, timeout_seconds):
    result = dict(valid=False, started=False, exitCode=None, timedOut=False,
                  cleanupConfirmed=True, signalEscalated=False,
                  code='BUILD_COMMAND_INPUT_INVALID', observedIdentities=[])
    known = {}
    try:
        if (not isinstance(argv, list) or not argv
                or any(not isinstance(value, str) or not value or '\x00' in value for value in argv)
                or not os.path.isabs(argv[0]) or not isinstance(env, dict)
                or any(not isinstance(key, str) or not isinstance(value, str) or not key or '=' in key
                       or '\x00' in key + value for key, value in env.items())
                or type(timeout_seconds) not in (int, float) or not math.isfinite(timeout_seconds) or timeout_seconds <= 0):
            return result
        cwd, log_path = Path(cwd), Path(log_path)
        if (not cwd.is_absolute() or cwd.is_symlink() or not cwd.is_dir() or not log_path.is_absolute()
                or log_path.parent.is_symlink() or not log_path.parent.is_dir()):
            return result
        controller = observe(os.getpid())
        if controller is None or controller['uid'] != os.getuid():
            return result
        with log_path.open('xb') as log, tempfile.TemporaryDirectory(prefix='kvvi-build-command-', dir=log_path.parent) as temporary:
            control = Path(temporary)
            _write_json(control / 'input.json', {'argv': argv, 'cwd': str(cwd), 'env': env,
                                               'controllerIdentity': controller})
            process = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), '--worker', str(control)],
                        cwd=cwd, env=dict(env), stdin=subprocess.DEVNULL, stdout=log,
                        stderr=subprocess.STDOUT, start_new_session=True)
            result.update(started=True, cleanupConfirmed=False, code='BUILD_COMMAND_START_FAILED')
            _execute(process, control, known, result, timeout_seconds)
    except CONTROL_ERRORS:
        result.update(valid=False, code='BUILD_COMMAND_CONTROL_OR_IDENTITY_FAILED' if result['started'] else 'BUILD_COMMAND_INPUT_INVALID')
    result['observedIdentities'] = list(known.values())
    return result


if __name__ == '__main__':
    if len(sys.argv) != 3 or sys.argv[1] != '--worker':
        raise SystemExit(2)
    raise SystemExit(_worker(Path(sys.argv[2])))
