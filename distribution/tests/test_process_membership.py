"""Stale ps rows are candidates only; fixtures own all real processes."""
import os
import subprocess
import sys
import unittest
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
        snapshot = subprocess.CompletedProcess([], 0, f'{other.pid} {root.pid}\n', '')
        with patch.object(identity.subprocess, 'run', return_value=snapshot):
            members = identity.group_members(root.pid)
        self.assertNotIn(other.pid, members)
        self.assertIsNone(other.poll())

    def test_stale_parent_row_cannot_claim_an_unrelated_live_process(self):
        root, other = self.sleeper(), self.sleeper()
        snapshot = subprocess.CompletedProcess([], 0, f'{other.pid} {root.pid}\n', '')
        with patch.object(identity.subprocess, 'run', return_value=snapshot):
            children = identity.descendants(root.pid)
        self.assertNotIn(other.pid, children)
        self.assertIsNone(other.poll())

    def fake(self, pid, parent, start='original'):
        return dict(pid=pid, ppid=parent, uid=os.getuid(), pgid=pid,
                    startIdentity=f'{pid}:{start}')

    def test_parent_reuse_during_child_acquisition_is_rejected(self):
        root, child = self.fake(20001, 20000), self.fake(20002, 20001)
        reads = iter([root, root, child, dict(root, startIdentity='reused')])
        snapshot = subprocess.CompletedProcess([], 0, '20002 20001\n', '')
        with patch.object(identity, '_observe_with_parent', side_effect=lambda _: next(reads)), \
             patch.object(identity.subprocess, 'run', return_value=snapshot):
            with self.assertRaisesRegex(ValueError, 'KVVI_PROCESS_IDENTITY_CHANGED'):
                identity.descendants(root['pid'])

    def test_root_reuse_after_discovery_is_rejected(self):
        root = self.fake(20001, 20000)
        with patch.object(identity, '_observe_with_parent', side_effect=[root, dict(root, startIdentity='reused')]), \
             patch.object(identity.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, '', '')):
            with self.assertRaisesRegex(ValueError, 'KVVI_PROCESS_IDENTITY_CHANGED'):
                identity.descendants(root['pid'])

    def test_kernel_parent_mismatch_never_expands_stale_grandchild_edge(self):
        root, child, grandchild = (self.fake(20001, 20000), self.fake(20002, 29999),
                                   self.fake(20003, 20002))
        values = {row['pid']: row for row in (root, child, grandchild)}
        snapshot = subprocess.CompletedProcess([], 0, '20002 20001\n20003 20002\n', '')
        with patch.object(identity, '_observe_with_parent', side_effect=values.get) as observer, \
             patch.object(identity.subprocess, 'run', return_value=snapshot):
            self.assertEqual(identity.descendants(root['pid']), {})
        self.assertNotIn(unittest.mock.call(grandchild['pid']), observer.call_args_list)

    def test_public_identity_does_not_persist_mutable_parent_pid(self):
        row = self.fake(20001, 20000)
        with patch.object(identity, '_observe_with_parent', return_value=row):
            self.assertEqual(set(identity.observe(row['pid'])), {'pid', 'uid', 'pgid', 'startIdentity'})


if __name__ == '__main__':
    unittest.main()
