"""CLI orchestration only; never contacts a database or stops a real service."""
import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from distribution.tests.test_cli_configuration import admin


class RecoveryCliTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.home = self.root / 'instance'
        self.config = self.root / 'config.json'
        self.config.write_text(json.dumps(dict(home=str(self.home), pg_port=18402,
                                              platform_port=18400, runtime_port=18401)))
        self.args = SimpleNamespace(config=str(self.config), archive=str(self.root / 'backup.tar.gz'),
                                    yes=True, plan=False, purge_data=False)
        self.password = patch.object(admin, '_superuser_password', return_value='test-only')
        self.password.start()
        self.addCleanup(self.password.stop)

    def restore(self, result, start_result=None):
        def apply(_pg, stop_services):
            stop_services()
            return result
        with patch.object(admin, 'restore_plan') as restore, \
             patch.object(admin, 'stop_plan') as stop, patch.object(admin, 'start_plan') as start, \
             patch.object(admin, 'pg_bin_dir', return_value=self.root), \
             contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            restore.return_value.apply.side_effect = apply
            stop.return_value.apply.return_value = {'ok': True, 'steps': []}
            start.return_value.apply.return_value = start_result or {'ok': True, 'steps': []}
            code = admin.cmd_restore(self.args)
        return code, start

    def test_partial_restore_failure_keeps_services_stopped(self):
        code, start = self.restore({'ok': False, 'steps': ['restore kvvi_platform'],
                                    'errors': [{'kind': 'restore', 'database': 'kvvi_business'}]})
        self.assertEqual(code, admin.EXIT_APPLY_FAILED)
        start.assert_not_called()

    def test_successful_restore_preserves_all_ports_on_restart(self):
        code, start = self.restore({'ok': True, 'steps': [], 'errors': []})
        self.assertEqual(code, 0)
        self.assertEqual(start.call_args.kwargs['runtime_port'], 18401)
        self.assertEqual(start.call_args.kwargs['pg_port'], 18402)

    def test_restart_failure_is_not_restore_success(self):
        code, _ = self.restore({'ok': True, 'steps': [], 'errors': []},
                               {'ok': False, 'errors': [{'kind': 'start'}]})
        self.assertEqual(code, admin.EXIT_APPLY_FAILED)

    def test_uninstall_stop_failure_does_not_delete(self):
        with patch.object(admin, 'stop_plan') as stop, patch.object(admin, 'uninstall_plan') as plan:
            stop.return_value.apply.return_value = {'ok': False, 'errors': [{'kind': 'stop'}]}
            plan.return_value.purge_data = False
            with contextlib.redirect_stderr(io.StringIO()):
                code = admin.cmd_uninstall(self.args)
            self.assertEqual(code, admin.EXIT_APPLY_FAILED)
            plan.return_value.apply.assert_not_called()

    def test_purge_cluster_stop_failure_does_not_delete(self):
        with patch.object(admin, 'stop_plan') as stop, patch.object(admin, 'uninstall_plan') as plan, \
             patch.object(admin, 'stop_cluster', return_value=False), \
             patch.object(admin, 'pg_bin_dir', return_value=self.root):
            stop.return_value.apply.return_value = {'ok': True}
            plan.return_value.purge_data = True
            with contextlib.redirect_stderr(io.StringIO()):
                code = admin.cmd_uninstall(self.args)
            self.assertEqual(code, admin.EXIT_APPLY_FAILED)
            plan.return_value.apply.assert_not_called()
