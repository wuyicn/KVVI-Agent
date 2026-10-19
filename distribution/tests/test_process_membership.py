"""Stale ps rows are candidates only; fixtures own all real processes."""
import os
import ctypes
import errno
import subprocess
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from distribution.lib import process_identity as identity


class ProcessMembershipTests(unittest.TestCase):
    def sleeper(self):
        process = subprocess.Popen([sys.executable, '-c', 'import time;time.sleep(60)'],
                                   start_new_session=True)
        def cleanup():
            if process.poll() is None:
                process.kill()
            process.wait(timeout=5)
        self.addCleanup(cleanup)
        return process

    def test_stale_group_row_cannot_claim_an_unrelated_live_process(self):
        root, other = self.sleeper(), self.sleeper()
        with patch.object(identity, '_candidate_group_pids', return_value=[other.pid]):
            members = identity.group_members(root.pid)
        self.assertNotIn(other.pid, members)
        self.assertIsNone(other.poll())

    def test_stale_parent_row_cannot_claim_an_unrelated_live_process(self):
        root, other = self.sleeper(), self.sleeper()
        with patch.object(identity, '_candidate_child_pids', return_value=[other.pid]):
            children = identity.descendants(root.pid)
        self.assertNotIn(other.pid, children)
        self.assertIsNone(other.poll())

    def fake(self, pid, parent, start='original'):
        return dict(pid=pid, ppid=parent, uid=os.getuid(), pgid=pid,
                    startIdentity=f'{pid}:{start}')

    def test_parent_reuse_during_child_acquisition_is_rejected(self):
        root, child = self.fake(20001, 20000), self.fake(20002, 20001)
        reads = iter([root, root, child, dict(root, startIdentity='reused')])
        with patch.object(identity, '_observe_with_parent', side_effect=lambda _: next(reads)), \
             patch.object(identity, '_candidate_child_pids', return_value=[child['pid']]):
            with self.assertRaisesRegex(ValueError, 'KVVI_PROCESS_IDENTITY_CHANGED'):
                identity.descendants(root['pid'])

    def test_root_reuse_after_discovery_is_rejected(self):
        root = self.fake(20001, 20000)
        with patch.object(identity, '_observe_with_parent', side_effect=[root, dict(root, startIdentity='reused')]), \
             patch.object(identity, '_candidate_child_pids', return_value=[]):
            with self.assertRaisesRegex(ValueError, 'KVVI_PROCESS_IDENTITY_CHANGED'):
                identity.descendants(root['pid'])

    def test_kernel_parent_mismatch_never_expands_stale_grandchild_edge(self):
        root, child, grandchild = (self.fake(20001, 20000), self.fake(20002, 29999),
                                   self.fake(20003, 20002))
        values = {row['pid']: row for row in (root, child, grandchild)}
        with patch.object(identity, '_observe_with_parent', side_effect=values.get) as observer, \
             patch.object(identity, '_candidate_child_pids', side_effect=lambda pid: {20001:[20002],20002:[20003]}.get(pid,[])):
            self.assertEqual(identity.descendants(root['pid']), {})
        self.assertNotIn(unittest.mock.call(grandchild['pid']), observer.call_args_list)

    def test_public_identity_does_not_persist_mutable_parent_pid(self):
        row = self.fake(20001, 20000)
        with patch.object(identity, '_observe_with_parent', return_value=row):
            self.assertEqual(set(identity.observe(row['pid'])), {'pid', 'uid', 'pgid', 'startIdentity'})

    @unittest.skipUnless(sys.platform == 'darwin', 'Darwin libproc enumeration')
    def test_native_enumeration_spawns_no_setuid_ps_child(self):
        root = self.sleeper()
        with patch.object(identity.subprocess, 'run', side_effect=AssertionError('must not spawn ps')):
            self.assertIn(root.pid, identity.group_members(root.pid))
            self.assertEqual(identity.descendants(root.pid), {})

    def test_native_capacity_full_is_retried_not_returned_as_complete(self):
        sizes = []
        def query(pid, buffer, size):
            sizes.append(size)
            capacity = size // ctypes.sizeof(ctypes.c_int)
            if capacity == 64:
                return capacity
            buffer[0] = 20003
            return 1
        with patch.object(identity.ctypes, 'CDLL', return_value=SimpleNamespace(proc_listchildpids=query)):
            self.assertEqual(identity._darwin_pid_candidates('proc_listchildpids', 20001), [20003])
        self.assertEqual(sizes, [256, 512])

    def test_native_zero_with_errno_is_unknown_not_empty(self):
        def query(*args):
            ctypes.set_errno(errno.EPERM)
            return 0
        with patch.object(identity.ctypes, 'CDLL', return_value=SimpleNamespace(proc_listchildpids=query)):
            with self.assertRaisesRegex(ValueError, 'KVVI_PROCESS_MEMBERSHIP_UNAVAILABLE'):
                identity._darwin_pid_candidates('proc_listchildpids', 20001)

    def test_native_invalid_count_and_capacity_exhaustion_are_unknown(self):
        for count in (-1, 65, 'full'):
            with self.subTest(count=count):
                def query(pid, buffer, size):
                    return size // ctypes.sizeof(ctypes.c_int) if count == 'full' else count
                with patch.object(identity.ctypes, 'CDLL', return_value=SimpleNamespace(proc_listchildpids=query)):
                    with self.assertRaisesRegex(ValueError, 'KVVI_PROCESS_MEMBERSHIP_UNAVAILABLE'):
                        identity._darwin_pid_candidates('proc_listchildpids', 20001)

    def test_intermediate_confirmed_exit_does_not_adopt_stale_grandchild(self):
        root, child = self.fake(20001, 20000), self.fake(20002, 20001)
        reads = {20001:root, 20002:child}
        def candidates(pid):
            if pid == 20001:return [20002]
            reads[20002] = None
            return [20003]
        with patch.object(identity, '_observe_with_parent', side_effect=reads.get), \
             patch.object(identity, '_candidate_child_pids', side_effect=candidates):
            self.assertEqual(set(identity.descendants(20001)), {20002})


if __name__ == '__main__':
    unittest.main()
