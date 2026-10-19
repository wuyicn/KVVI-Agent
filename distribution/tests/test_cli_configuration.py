"""Read-only plans and instance configuration must survive the CLI boundary."""
import contextlib
import importlib.machinery
import importlib.util
import io
import json
import os
import plistlib
import tempfile
import unittest
import socket
from pathlib import Path
from unittest.mock import patch

from distribution.lib.supervisor import launchd_plist, start_plan
from distribution.lib.install import install_plan
from distribution.lib.preflight import preflight

CLI = Path(__file__).resolve().parents[1] / 'bin' / 'kvvi-admin'
loader = importlib.machinery.SourceFileLoader('kvvi_admin_test_config', str(CLI))
spec = importlib.util.spec_from_loader(loader.name, loader)
admin = importlib.util.module_from_spec(spec)
loader.exec_module(admin)


class ConfigurationTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.home = self.root / 'uninitialized-instance'
        self.config = self.root / 'config.json'
        self.values = dict(home=str(self.home), platform_port=18400,
                           runtime_port=18401, pg_port=18402)
        self.config.write_text(json.dumps(self.values))

    def test_start_and_stop_plan_work_without_initializing_or_writing(self):
        for command in ('start', 'stop'):
            with self.subTest(command=command), contextlib.redirect_stdout(io.StringIO()) as out:
                result = admin.main([command, '--plan', '--config', str(self.config)])
                self.assertEqual(result, 0)
                self.assertIn(str(self.home), out.getvalue())
                self.assertFalse(self.home.exists())

    def test_launchd_environment_round_trips_all_instance_ports(self):
        doc = plistlib.loads(launchd_plist(self.home, self.root, 18400, 18401,
                                         pg_port=18402).encode())
        with patch.dict(os.environ, doc['EnvironmentVariables'], clear=True):
            self.assertEqual({k: admin.load_config(None)[k] for k in self.values}, self.values)

    def test_explicit_json_overrides_launchd_environment(self):
        with patch.dict(os.environ, {'KVVI_HOME': '/wrong', 'KVVI_PLATFORM_PORT': '19500',
                                    'KVVI_RUNTIME_PORT': '19501', 'KVVI_PG_PORT': '19502'}, clear=True):
            self.assertEqual({k: admin.load_config(self.config)[k] for k in self.values}, self.values)

    def test_json_overrides_invalid_lower_priority_ports(self):
        self.home.mkdir()
        (self.home / 'kvvi.env').write_text('KVVI_RUNTIME_PORT=invalid\n')
        with patch.dict(os.environ, {'KVVI_PLATFORM_PORT': 'invalid'}, clear=True):
            self.assertEqual({k: admin.load_config(self.config)[k] for k in self.values}, self.values)

    def test_start_refuses_mismatched_installed_pg_port(self):
        self.home.mkdir()
        for line in ('KVVI_PG_PORT=19402\n',
                     'KVVI_BUSINESS_DSN=postgres://test@127.0.0.1:19402/kvvi_business\n'):
            with self.subTest(line=line):
                (self.home / 'kvvi.env').write_text(line)
                with self.assertRaisesRegex(ValueError, 'KVVI_INSTANCE_PORT_MISMATCH'):
                    start_plan(self.home, self.root, pg_port=18402)

    def test_preflight_probes_configured_runtime_port(self):
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            listener.listen()
            config = dict(self.values, runtime_port=listener.getsockname()[1],
                          min_disk_gib=0, min_memory_gib=0)
            result = preflight(config, self.root)
            self.assertTrue(any(e['code'] == 'KVVI_PORT_IN_USE' and
                                e['port'] == config['runtime_port'] for e in result['errors']))
            self.assertEqual(result['ports']['runtime'], config['runtime_port'])

    def test_launchd_cli_preserves_explicit_json_ports(self):
        with contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(admin.main(['launchd', '--config', str(self.config)]), 0)
        env = plistlib.loads(out.getvalue().encode())['EnvironmentVariables']
        self.assertEqual(env['KVVI_RUNTIME_PORT'], '18401')
        self.assertEqual(env['KVVI_PLATFORM_PORT'], '18400')
        self.assertEqual(env['KVVI_PG_PORT'], '18402')

    def test_install_config_persists_custom_runtime_port(self):
        plan = install_plan(str(self.home), pg_port=18402, platform_port=18400,
                            runtime_port=18401, pg_bin=Path('/unused'), release_root=CLI.parents[2])
        self.assertIn('18401', plan.describe())
        self.home.mkdir()
        plan._write_config()
        with patch.dict(os.environ, {'KVVI_HOME': str(self.home)}, clear=True):
            self.assertEqual(admin.load_config(None)['runtime_port'], 18401)

    def test_installed_env_supplies_ports_without_copying_secrets_to_plan(self):
        self.home.mkdir()
        (self.home / 'kvvi.env').write_text('KVVI_PLATFORM_PORT=18400\nKVVI_RUNTIME_PORT=18401\n'
                                          'KVVI_PG_PORT=18402\nKVVI_INTERNAL_TOKEN=secret-sentinel\n')
        with patch.dict(os.environ, {'KVVI_HOME': str(self.home)}, clear=True):
            config = admin.load_config(None)
            self.assertEqual({k: config[k] for k in self.values}, self.values)
        plan = start_plan(self.home, self.root, platform_port=18400, runtime_port=18401)
        self.assertNotIn('secret-sentinel', plan.describe())
        self.assertIn('18401', plan.describe())

    def test_cli_start_passes_runtime_port_to_readiness_and_plan(self):
        args = type('Args', (), dict(config=str(self.config), plan=False, apply=True, yes=True))()
        with patch.object(admin, 'readiness_report', return_value={'ok': True}) as readiness, \
             patch.object(admin, 'start_plan') as start:
            start.return_value.apply.return_value = {'ok': True, 'steps': []}
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(admin.cmd_start(args), 0)
            self.assertEqual(readiness.call_args.kwargs['runtime_port'], 18401)
            self.assertEqual(start.call_args.kwargs['runtime_port'], 18401)
