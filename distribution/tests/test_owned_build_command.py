"""Actual owned processes only; no pilot PID/port/process environment scans."""
import importlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from distribution.lib.process_identity import observe,same_process


class OwnedBuildCommandTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='kvvi-owned-build-command-');self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.api=importlib.import_module('工具.lib.owned_build_command')
        self.log=self.root/'command.log';self.environment={'PATH':'/usr/bin:/bin','ONLY_BUILD_VALUE':'public-fixture'}
        self.addCleanup(self.cleanup_owned)
        self.owned=[]

    def cleanup_owned(self):
        for identity in self.owned:
            current=observe(identity['pid'])
            if same_process(current,identity):
                os.kill(identity['pid'],signal.SIGKILL)

    def run_command(self,body,timeout=3):
        result=self.api.run_owned_command([sys.executable,'-u','-c',body],self.root,self.environment,self.log,timeout)
        self.owned.extend(result['observedIdentities'])
        return result

    def running_fixture_ids(self):
        if not self.log.exists():return []
        try:pids=json.loads(self.log.read_text().strip())
        except (ValueError,OSError):return []
        for pid in pids:
            value=observe(pid)
            if value is not None and value not in self.owned:self.owned.append(value)
        return pids

    def detached_body(self):
        return '''import os,subprocess,sys,time,json
p=subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)'],start_new_session=True)
print(json.dumps([os.getpid(),p.pid]),flush=True)
time.sleep(60)
'''

    def assert_fixture_stopped(self):
        pids=self.running_fixture_ids()
        self.assertEqual(len(pids),2,self.log.read_text())
        for pid in pids:self.assertIsNone(observe(pid),f'owned fixture {pid} survived exception cleanup')

    def test_persistent_group_query_failure_after_go_stops_group_and_detached_child(self):
        original=self.api.group_members
        def broken(pgid):
            if self.running_fixture_ids():raise ValueError('fixture query failure')
            return original(pgid)
        with patch.object(self.api,'group_members',side_effect=broken):
            result=self.run_command(self.detached_body())
        self.assertFalse(result['valid'])
        self.assert_fixture_stopped()

    def test_unknown_root_after_go_uses_cooperative_stop_without_parent_group_signal(self):
        original=self.api.observe
        def broken(pid):
            if self.running_fixture_ids():raise ValueError('fixture kernel failure')
            return original(pid)
        with patch.object(self.api,'observe',side_effect=broken),patch.object(self.api.os,'killpg') as group_signal:
            result=self.run_command(self.detached_body())
            group_signal.assert_not_called()
        self.assertFalse(result['valid']);self.assertFalse(result['cleanupConfirmed'])
        self.assert_fixture_stopped()

    def test_keyboard_interrupt_cancels_children_before_reraising(self):
        original=self.api._collect
        def interrupted(saved,known):
            if self.running_fixture_ids():raise KeyboardInterrupt()
            return original(saved,known)
        with patch.object(self.api,'_collect',side_effect=interrupted):
            with self.assertRaises(KeyboardInterrupt):self.run_command(self.detached_body())
        self.assert_fixture_stopped()

    def test_worker_crash_still_cleans_previously_observed_children_without_group_signal(self):
        original=self.api._collect
        def crashed(saved,known):
            value=original(saved,known)
            pids=self.running_fixture_ids()
            if pids and all(pid in known for pid in pids):
                self.assertTrue(same_process(observe(saved['pid']),saved))
                os.kill(saved['pid'],signal.SIGKILL)
                raise ValueError('owned worker crashed')
            return value
        with patch.object(self.api,'_collect',side_effect=crashed),patch.object(self.api.os,'killpg') as group_signal:
            result=self.run_command(self.detached_body())
            group_signal.assert_not_called()
        self.assertFalse(result['valid']);self.assertFalse(result['cleanupConfirmed'])
        self.assert_fixture_stopped()

    def test_controller_death_worker_stops_own_group_and_observed_detached_child(self):
        code=("import sys;sys.path.insert(0,"+repr(str(self.api.ROOT))+");"
              "from 工具.lib.owned_build_command import run_owned_command;"
              "run_owned_command("+repr([sys.executable,'-u','-c',self.detached_body()])+","+
              repr(str(self.root))+","+repr(self.environment)+","+repr(str(self.log))+",60)")
        controller=subprocess.Popen([sys.executable,'-c',code],start_new_session=True)
        def cleanup():
            if controller.poll() is None:controller.kill()
            controller.wait(timeout=5)
        self.addCleanup(cleanup)
        deadline=time.monotonic()+5
        while not self.running_fixture_ids() and controller.poll() is None and time.monotonic()<deadline:
            time.sleep(0.02)
        pids=self.running_fixture_ids();self.assertEqual(len(pids),2)
        worker=observe(observe(pids[0])['pgid']);self.owned.append(worker)
        controller.kill();controller.wait(timeout=5)
        deadline=time.monotonic()+5
        while any(same_process(observe(value['pid']),value) for value in self.owned) and time.monotonic()<deadline:
            time.sleep(0.02)
        self.assert_fixture_stopped()
        self.assertIsNone(observe(worker['pid']))

    def short_detached_body(self):
        return self.detached_body().rsplit('time.sleep(60)',1)[0]+'time.sleep(0.6)\n'

    def test_worker_observations_are_adopted_when_parent_misses_detached_child(self):
        with patch.object(self.api,'descendants',return_value={}):
            result=self.run_command(self.short_detached_body())
        self.assertFalse(result['valid']);self.assertEqual(result['exitCode'],0)
        self.assertTrue(result['cleanupConfirmed'])
        self.assert_fixture_stopped()
        self.assertTrue(set(self.running_fixture_ids()) <= {row['pid'] for row in result['observedIdentities']})

    def test_worker_rechecks_its_own_children_before_accepting_parent_ack(self):
        with patch.object(self.api,'_remaining',return_value={}):
            result=self.run_command(self.short_detached_body())
        self.assertFalse(result['valid']);self.assertTrue(result['cleanupConfirmed'])
        self.assert_fixture_stopped()

    def test_structured_command_exit_zero_and_exact_environment_log(self):
        with patch.dict(os.environ,{'DO_NOT_INHERIT':'private-fixture'}):
            result=self.run_command("import os,json;print(json.dumps({'value':os.environ.get('ONLY_BUILD_VALUE'),'unexpected':'DO_NOT_INHERIT' in os.environ}))")
        self.assertTrue(result['valid']);self.assertEqual(result['exitCode'],0);self.assertTrue(result['cleanupConfirmed'])
        self.assertEqual(json.loads(self.log.read_text()),{'value':'public-fixture','unexpected':False})
        self.assertNotIn('private-fixture',self.log.read_text())

    def test_nonzero_exit_stays_failed_and_preserves_output(self):
        result=self.run_command("print('owned failure');raise SystemExit(17)")
        self.assertFalse(result['valid']);self.assertEqual(result['exitCode'],17);self.assertTrue(result['cleanupConfirmed'])
        self.assertIn('owned failure',self.log.read_text())

    def test_existing_log_and_invalid_timeout_do_not_execute_or_overwrite(self):
        self.log.write_bytes(b'old log')
        result=self.run_command("raise SystemExit(0)")
        self.assertFalse(result['valid']);self.assertFalse(result['started']);self.assertEqual(self.log.read_bytes(),b'old log')
        self.log.unlink()
        for timeout in (0,-1,True,float('inf')):
            result=self.run_command("raise SystemExit(0)",timeout)
            self.assertFalse(result['valid']);self.assertFalse(result['started'])
        self.assertFalse(self.log.exists())

    def test_timeout_ends_own_group_and_does_not_signal_an_unrelated_process(self):
        unrelated=subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)'],start_new_session=True)
        self.addCleanup(lambda:unrelated.wait(timeout=5))
        self.addCleanup(unrelated.kill)
        result=self.run_command("import os,time;print(os.getpid(),flush=True);time.sleep(60)",0.3)
        pid=int(self.log.read_text().strip());self.assertIsNone(observe(pid));self.assertIsNone(unrelated.poll())
        self.assertFalse(result['valid']);self.assertTrue(result['timedOut']);self.assertTrue(result['cleanupConfirmed'])

    def test_ignored_term_escalates_only_with_own_worker_identity(self):
        result=self.run_command("import os,signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);print(os.getpid(),flush=True);time.sleep(60)",0.3)
        pid=int(self.log.read_text().strip());self.assertIsNone(observe(pid))
        self.assertFalse(result['valid']);self.assertTrue(result['signalEscalated']);self.assertTrue(result['cleanupConfirmed'])

    def test_known_detached_descendant_is_stopped_and_exit_zero_is_not_approved(self):
        body="""import subprocess,sys,time
p=subprocess.Popen([sys.executable,'-u','-c','import os,time;print(os.getpid(),flush=True);time.sleep(60)'],start_new_session=True)
time.sleep(0.6)
"""
        result=self.run_command(body)
        pid=int(self.log.read_text().strip());self.assertIsNone(observe(pid))
        self.assertFalse(result['valid']);self.assertEqual(result['exitCode'],0);self.assertTrue(result['cleanupConfirmed'])
        self.assertEqual(result['code'],'BUILD_COMMAND_LEFT_CHILDREN')

    def test_identity_change_refuses_group_signalling(self):
        original=self.api.observe;seen=[]
        def mismatched(pid):
            value=original(pid)
            if pid==os.getpid():return value
            if value is not None and seen:
                value=dict(value,startIdentity='changed-identity')
            if value is not None:seen.append(True)
            return value
        with patch.object(self.api,'observe',side_effect=mismatched),patch.object(self.api.os,'killpg') as group_signal:
            result=self.run_command("print('must not run before identity confirmation')")
            self.assertFalse(result['valid']);group_signal.assert_not_called()
        self.assertFalse(self.log.read_text().strip())


if __name__=='__main__':unittest.main()
