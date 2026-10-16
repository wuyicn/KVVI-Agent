#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""D1/D2/D3 生命周期安全回归（2026-10-13 整体验收）。

| 项 | 缺陷 | 期望 |
|---|---|---|
| D1 | 恢复宣称停服务，实际直接 pg_restore | 动库之前先停服务 |
| D2 | pg_restore 中文「错误: 连接失败」被当成功 | 跨语言识别真失败 |
| D3 | 卸载删 PID 文件但进程还活着 | 删文件之前先停进程 |
"""

import io
import json
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from distribution.lib.backup import (  # noqa: E402
    _restore_failed,
    restore_plan,
    sha256_file,
    uninstall_plan,
)


class RestoreFailureDetectionTest(unittest.TestCase):
    """D2：`_restore_failed` 跨语言识别 pg_restore 的真失败。"""

    def test_zero_exit_is_not_failure(self):
        self.assertFalse(_restore_failed(SimpleNamespace(returncode=0, stderr='')))

    def test_english_error_is_failure(self):
        self.assertTrue(_restore_failed(
            SimpleNamespace(returncode=1, stderr='pg_restore: error: connection refused')))

    def test_chinese_error_is_failure(self):
        # 服务器/libpq 的 locale 不由客户端 LC_ALL 决定 —— 中文是「错误: 连接失败」。
        self.assertTrue(_restore_failed(
            SimpleNamespace(returncode=1, stderr='错误: 连接失败')))

    def test_chinese_fatal_is_failure(self):
        self.assertTrue(_restore_failed(
            SimpleNamespace(returncode=2, stderr='致命错误: 无法连接')))

    def test_nonzero_without_error_marker_is_not_failure(self):
        # 「对象不存在，跳过」一类：非零但没有任何错误标记，不算真失败。
        self.assertFalse(_restore_failed(
            SimpleNamespace(returncode=1, stderr='warning: some objects skipped')))


class RestoreStopsServicesTest(unittest.TestCase):
    """D1：恢复在动库之前先停服务。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def _minimal_archive(self, path: Path) -> Path:
        """造一个 0 库、0 文件的合法备份包（核摘要能过）。"""
        manifest = {'bundleVersion': 'kvvi-backup/v1', 'createdAt': '2026-01-01T00:00:00Z',
                    'pgPort': 1, 'databases': [], 'files': {}}
        with tarfile.open(path, 'w:gz') as tar:
            body = json.dumps(manifest).encode('utf-8')
            info = tarfile.TarInfo('backup-manifest.json')
            info.size = len(body)
            tar.addfile(info, io.BytesIO(body))
        sidecar = path.with_suffix(path.suffix + '.sha256')
        sidecar.write_text(sha256_file(path) + '\n')
        return path

    def test_stop_services_is_called_before_restore(self):
        archive = self._minimal_archive(self.root / 'b.tar.gz')
        plan = restore_plan(archive=archive, home=self.root / 'kvvi',
                            pg_port=1, superuser='kvvi_admin', superpass='x')
        calls = []

        def stop():
            calls.append('stopped')
            return 'done'

        result = plan.apply(Path('/nonexistent'), stop_services=stop)
        self.assertTrue(result['ok'], result)
        self.assertEqual(calls, ['stopped'], '恢复没有在动库之前调用 stop_services')
        self.assertIn('verify', result['steps'])
        self.assertTrue(any(s.startswith('stop-services') for s in result['steps']),
                        '恢复步骤里没有记录「停服务」')

    def test_verify_failure_does_not_stop_services(self):
        # 包坏了：核摘要就拒绝，不该停服务、也不该动任何东西。
        plan = restore_plan(archive=self.root / 'missing.tar.gz', home=self.root / 'kvvi',
                            pg_port=1, superuser='kvvi_admin', superpass='x')
        calls = []

        def stop():
            calls.append('stopped')

        result = plan.apply(Path('/nonexistent'), stop_services=stop)
        self.assertFalse(result['ok'])
        self.assertEqual(calls, [], '核不过摘要却停了服务')


class UninstallStopsServicesTest(unittest.TestCase):
    """D3：卸载在删文件之前先停进程。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def test_stop_services_is_called_before_removing(self):
        plan = uninstall_plan(home=self.root / 'kvvi')
        calls = []

        def stop():
            calls.append('stopped')

        result = plan.apply(stop_services=stop)
        self.assertTrue(result['ok'])
        self.assertEqual(calls, ['stopped'], '卸载没有在删文件之前调用 stop_services')


if __name__ == '__main__':
    unittest.main()
