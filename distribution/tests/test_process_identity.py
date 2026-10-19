"""All processes here are disposable children; no existing instance is touched."""
import json
import errno
import ctypes
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from distribution.lib.supervisor import start_plan, stop_plan, status_report


class IdentityBoundaryTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name) / 'instance'
        self.release = Path(self.tmp.name) / 'release'
        (self.home / 'run').mkdir(parents=True)
        (self.home / 'log').mkdir()
        self.pid_file = self.home / 'run' / 'platform.pid'

    def child(self):
        child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)'],
                                 start_new_session=True)
        def cleanup():
            if child.poll() is None:
                child.kill()
            child.wait(timeout=5)
        self.addCleanup(cleanup)
        return child

    def test_invalid_and_legacy_pid_files_never_send_signals(self):
        unrelated = self.child()
        for value in ('', '0', '-1', '1', 'not-a-pid', str(unrelated.pid)):
            with self.subTest(value=value):
                self.pid_file.write_text(value)
                with patch('distribution.lib.supervisor.os.kill') as signal, \
                     patch('distribution.lib.supervisor.os.killpg') as group_signal:
                    result = stop_plan(self.home, self.release).apply()
                self.assertFalse(result['ok'])
                signal.assert_not_called()
                group_signal.assert_not_called()
                self.assertTrue(self.pid_file.exists())
        self.assertIsNone(unrelated.poll())

    def spawn_owned(self, body='import time; time.sleep(120)'):
        plan = start_plan(self.home, self.release)
        pid = plan._spawn({'program': 'platform', 'argv': [sys.executable, '-c', body]}, self.home / 'log')
        self.assertIsNotNone(pid)
        def cleanup():
            try:
                os.kill(pid, 9)
            except ProcessLookupError:
                pass
            try:
                os.waitpid(pid, 0)
            except ChildProcessError:
                pass
        self.addCleanup(cleanup)
        return pid

    def test_start_identity_mismatch_does_not_kill_a_live_process(self):
        pid = self.spawn_owned()
        identity_path = self.pid_file.with_suffix('.identity.json')
        identity = json.loads(identity_path.read_text())
        identity['startIdentity'] = 'reused-pid'
        identity_path.write_text(json.dumps(identity))
        result = stop_plan(self.home, self.release).apply()
        self.assertFalse(result['ok'])
        os.kill(pid, 0)  # Our child is still alive.
        report = status_report(self.home, self.release)['processes']['platform']
        self.assertFalse(report['running'])
        self.assertEqual(report['identityError'], 'KVVI_PROCESS_IDENTITY_MISMATCH')

    def test_owned_spawn_can_be_stopped_and_identity_is_removed(self):
        self.spawn_owned()
        result = stop_plan(self.home, self.release).apply()
        self.assertTrue(result['ok'], result)
        self.assertFalse(self.pid_file.exists())
        self.assertFalse(self.pid_file.with_suffix('.identity.json').exists())

    def test_second_spawn_does_not_overwrite_a_live_instance_record(self):
        first = self.spawn_owned()
        plan = start_plan(self.home, self.release)
        # A second child would be ours too, but must never be launched here.
        with patch('distribution.lib.supervisor.subprocess.Popen') as spawn:
            second = plan._spawn({'program': 'platform', 'argv': [sys.executable, '-c', 'pass']},
                                 self.home / 'log')
        self.assertIsNone(second)
        self.assertEqual(spawn.call_count, 0)
        self.assertEqual(int(self.pid_file.read_text()), first)

    @unittest.skipUnless(sys.platform == 'darwin', 'Darwin kernel error boundary')
    def test_kernel_permission_error_is_unknown_and_preserves_record(self):
        pid = self.spawn_owned()
        def unavailable(*args):
            ctypes.set_errno(errno.EACCES)
            return 0
        with patch('distribution.lib.process_identity.ctypes.CDLL') as lib:
            lib.return_value.proc_pidinfo.side_effect = unavailable
            result = stop_plan(self.home, self.release).apply()
        self.assertFalse(result['ok'])
        self.assertTrue(self.pid_file.exists())
        os.kill(pid, 0)

    def test_exited_root_is_not_proof_that_all_descendants_exited(self):
        pid = self.spawn_owned()
        os.kill(pid, 9)
        os.waitpid(pid, 0)
        result = stop_plan(self.home, self.release).apply()
        self.assertFalse(result['ok'])
        self.assertTrue(self.pid_file.exists())

    def test_stop_also_ends_a_child_that_created_its_own_session(self):
        from distribution.lib.process_identity import observe
        self.spawn_owned('import subprocess,sys,time\n'
                         'p=subprocess.Popen([sys.executable,"-c","import time; time.sleep(120)"],'
                         ' start_new_session=True)\nprint(p.pid,flush=True)\ntime.sleep(120)\n')
        log = self.home / 'log' / 'platform.log'
        deadline = time.monotonic() + 5
        while not log.read_text().strip() and time.monotonic() < deadline:
            time.sleep(0.01)
        child_pid = int(log.read_text().strip())
        def cleanup():
            try:
                os.kill(child_pid, 9)
            except ProcessLookupError:
                pass
        self.addCleanup(cleanup)
        result = stop_plan(self.home, self.release).apply()
        self.assertTrue(result['ok'], result)
        self.assertIsNone(observe(child_pid), 'descendant survived stop in a separate session')

    def test_child_cannot_escape_by_changing_session_in_sigterm_handler(self):
        from distribution.lib.process_identity import observe
        child_code = ('import os,signal,time\n'
                      'signal.signal(signal.SIGTERM,lambda *_: os.setsid())\n'
                      'print("ready",flush=True)\ntime.sleep(120)\n')
        self.spawn_owned('import subprocess,sys,time\n'
                         f'p=subprocess.Popen([sys.executable,"-u","-c",{child_code!r}],'
                         ' stdout=subprocess.PIPE,text=True)\n'
                         'p.stdout.readline()\nprint(p.pid,flush=True)\ntime.sleep(120)\n')
        log = self.home / 'log' / 'platform.log'
        deadline = time.monotonic() + 5
        while not log.read_text().strip() and time.monotonic() < deadline:
            time.sleep(0.01)
        child_pid = int(log.read_text().strip())
        def cleanup():
            try:
                os.kill(child_pid, 9)
            except ProcessLookupError:
                pass
        self.addCleanup(cleanup)
        with patch('distribution.lib.supervisor.STOP_WAIT_SECONDS', 0.1):
            result = stop_plan(self.home, self.release).apply()
        self.assertTrue(result['ok'], result)
        self.assertIsNone(observe(child_pid))
