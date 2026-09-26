#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""阶段十一 · 任务一：发行版布局与 macOS 环境前置检查。

## 这一组测的是「检查器自己」，不是「环境好不好」

`preflight` 唯一的判据是**在写任何东西之前**把环境问清楚。所以这里的断言分两类：

| # | 性质 | 不成立会怎样 |
|---|---|---|
| 1 | 每一种不合适的环境给出**自己的**错误码与引导 | 「启动失败」把版本问题伪装成程序缺陷 |
| 2 | 检查失败时**目录里一个文件都没多** | 检查到一半写了配置，再失败；下次运行面对一个半成品 |
| 3 | Apple Silicon 与 Intel 两套 Homebrew 前缀都能找到 | Intel 机器上把「已安装」报成「未安装」 |
| 4 | PostgreSQL 大版本**固定**，不跟随 Homebrew 最新版 | 客户 `brew upgrade` 后行为与取证时不一致 |
| 5 | 端口占用报出来的是**哪一个**端口、被谁占用 | 客户只知道「起不来」 |

⚠️ 第 2 条是这一组里最容易写出假绿的一条：一个「先建目录再检查」的实现，
在环境**合适**时断言不出来，只有环境**不合适**时才暴露 —— 所以每个失败用例都查目录。
"""

import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from distribution.lib.preflight import (  # noqa: E402
    KVVI_PG_MAJOR,
    HostEnv,
    brew_prefix,
    preflight,
)


def healthy_env(**overrides) -> HostEnv:
    """一台各项都合适的主机。用例只覆盖自己关心的那一项。"""
    base = dict(
        platform='darwin',
        macos_version=(14, 5),
        machine='arm64',
        pg_config=Path('/opt/homebrew/opt/postgresql@17/bin/pg_config'),
        pg_major=KVVI_PG_MAJOR,
        busy_ports=(),
        free_disk_gib=50.0,
        memory_gib=16.0,
        year=2026,
        node_path=Path('/usr/local/bin/node'),
        node_version=(24, 19, 0),
        pnpm_path=Path('/usr/local/bin/pnpm'),
    )
    base.update(overrides)
    return HostEnv(**base)


def config(**overrides) -> dict:
    base = dict(home='/tmp/kvvi-home-check', pg_port=54329, platform_port=7400,
                min_disk_gib=10.0, min_memory_gib=4.0)
    base.update(overrides)
    return base


def codes(result) -> list:
    return [e['code'] for e in result['errors']]


def code_set(result) -> set:
    return set(codes(result))


class PreflightTest(unittest.TestCase):

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    # ── 合适的环境 ────────────────────────────────────────────────────────
    def test_healthy_host_passes_and_writes_nothing(self):
        result = preflight(config(home=str(self.root / 'kvvi')), self.root, env=healthy_env())
        self.assertTrue(result['ok'], result['errors'])
        self.assertEqual(list(self.root.iterdir()), [],
                         '前置检查通过了，却留下了文件')

    # ── 每一条不合适都有自己的码与引导 ────────────────────────────────────
    def test_missing_postgres_names_the_formula(self):
        result = preflight(config(), self.root,
                           env=healthy_env(pg_config=None, pg_major=None))
        self.assertFalse(result['ok'])
        self.assertEqual(codes(result), ['KVVI_PG_NOT_FOUND'])
        guidance = result['errors'][0]['guidance']
        self.assertIn('brew install postgresql@17', guidance)

    def test_wrong_postgres_major_names_both_versions(self):
        result = preflight(config(), self.root, env=healthy_env(pg_major=16))
        self.assertFalse(result['ok'])
        self.assertEqual(codes(result), ['KVVI_PG_MAJOR_UNSUPPORTED'])
        error = result['errors'][0]
        self.assertEqual(error['found'], 16)
        self.assertEqual(error['required'], KVVI_PG_MAJOR)
        # 引导必须说清装哪个 formula，而不是「版本不支持」。
        self.assertIn('postgresql@17', error['guidance'])

    def test_intel_homebrew_prefix_is_found(self):
        self.assertEqual(brew_prefix('x86_64'), '/usr/local')
        self.assertEqual(brew_prefix('arm64'), '/opt/homebrew')

    def test_intel_host_locates_its_own_pg_config(self):
        self.assertEqual(
            find_pg_config_for('x86_64'),
            Path('/usr/local/opt/postgresql@17/bin/pg_config'))

    def test_non_macos_is_refused_with_its_own_code(self):
        result = preflight(config(), self.root, env=healthy_env(platform='linux'))
        self.assertEqual(codes(result), ['KVVI_NOT_MACOS'])

    def test_old_macos_is_refused(self):
        result = preflight(config(), self.root, env=healthy_env(macos_version=(12, 7)))
        self.assertEqual(codes(result), ['KVVI_MACOS_TOO_OLD'])

    def test_port_collision_names_the_port_and_nothing_is_written(self):
        target = self.root / 'kvvi'
        result = preflight(config(home=str(target), pg_port=54329),
                           self.root, env=healthy_env(busy_ports=(54329,)))
        self.assertFalse(result['ok'])
        self.assertEqual(codes(result), ['KVVI_PORT_IN_USE'])
        self.assertEqual(result['errors'][0]['port'], 54329)
        self.assertEqual(list(self.root.iterdir()), [],
                         '端口检查失败，却留下了文件')

    def test_both_ports_are_checked(self):
        result = preflight(config(pg_port=54329, platform_port=7400), self.root,
                           env=healthy_env(busy_ports=(7400,)))
        self.assertEqual(codes(result), ['KVVI_PORT_IN_USE'])
        self.assertEqual(result['errors'][0]['port'], 7400)

    def test_disk_floor_is_enforced(self):
        result = preflight(config(min_disk_gib=20.0), self.root,
                           env=healthy_env(free_disk_gib=5.0))
        self.assertEqual(codes(result), ['KVVI_DISK_LOW'])

    def test_memory_floor_is_enforced(self):
        result = preflight(config(min_memory_gib=8.0), self.root,
                           env=healthy_env(memory_gib=4.0))
        self.assertEqual(codes(result), ['KVVI_MEMORY_LOW'])

    def test_unwritable_home_is_reported_before_anything_else_runs(self):
        blocked = self.root / 'blocked'
        blocked.mkdir()
        os.chmod(blocked, 0o500)
        self.addCleanup(os.chmod, blocked, 0o700)
        result = preflight(config(home=str(blocked / 'kvvi')), self.root,
                           env=healthy_env())
        self.assertEqual(codes(result), ['KVVI_HOME_NOT_WRITABLE'])

    def test_clock_year_is_sanity_checked(self):
        # 令牌与审计都带时间；一台时钟跑到 1970 的机器会让到期判定失效。
        result = preflight(config(), self.root, env=healthy_env(year=1970))
        self.assertEqual(codes(result), ['KVVI_CLOCK_SKEW'])

    # ── Node 与 pnpm ──────────────────────────────────────────────────────
    def test_missing_node_is_refused_with_install_guidance(self):
        # macOS **不自带 node**。而安装器与两个进程都要它 ——
        # 一个未声明的前置条件，在客户机器上是必然踩到的坑。
        result = preflight(config(), self.root,
                           env=healthy_env(node_path=None, node_version=None))
        self.assertEqual(codes(result), ['KVVI_NODE_NOT_FOUND'])
        self.assertIn('nodejs.org', result['errors'][0]['guidance'])

    def test_old_node_names_both_versions(self):
        result = preflight(config(), self.root, env=healthy_env(node_version=(20, 11, 0)))
        self.assertEqual(codes(result), ['KVVI_NODE_TOO_OLD'])
        self.assertEqual(result['errors'][0]['found'], '20.11.0')
        self.assertEqual(result['errors'][0]['required'], '^22.19.0 || >=24.0.0')

    def test_the_accepted_ranges_are_the_harness_engines_range(self):
        # 判据必须与 DSH 自己的 engines 一致：不一致的表现是
        # 「装上了但运行时起不来」，而报错来自 dsh，看不出是版本门槛写错了。
        from distribution.lib.preflight import node_supported
        self.assertTrue(node_supported((22, 19, 0)))
        self.assertTrue(node_supported((22, 20, 1)))
        self.assertTrue(node_supported((24, 0, 0)))
        self.assertTrue(node_supported((25, 1, 0)))
        self.assertFalse(node_supported((22, 18, 9)))
        self.assertFalse(node_supported((20, 11, 0)))
        self.assertFalse(node_supported((23, 9, 0)))   # 23 不在 ^22.19 || >=24 里

    def test_missing_pnpm_is_reported_because_the_package_needs_it_once(self):
        # 发行包装的是**源码 + 安装器**：运行时的 1.9 GB 依赖不在包里
        # （里面有 darwin-arm64 的原生模块，装不到别人的机器上）。
        # 所以装完包之后有一次 `pnpm install`，pnpm 因此是前置条件。
        result = preflight(config(), self.root, env=healthy_env(pnpm_path=None))
        self.assertEqual(codes(result), ['KVVI_PNPM_NOT_FOUND'])
        self.assertIn('pnpm', result['errors'][0]['guidance'])

    def test_node_is_reported_before_postgres(self):
        # 顺序有意义：先说最上游的那道坎。node 没有，后面什么都做不了。
        result = preflight(config(), self.root,
                           env=healthy_env(node_path=None, node_version=None,
                                           pg_config=None, pg_major=None))
        self.assertEqual(codes(result)[0], 'KVVI_NODE_NOT_FOUND')

    def test_report_carries_the_node_requirement_and_what_was_found(self):
        result = preflight(config(), self.root, env=healthy_env())
        self.assertEqual(result['node']['required'], '^22.19.0 || >=24.0.0')
        self.assertEqual(result['node']['found'], '24.19.0')

    def test_observe_host_reports_this_machines_node_and_pnpm(self):
        from distribution.lib.preflight import observe_host
        env = observe_host()
        self.assertIsNotNone(env.node_path, '本机有 node，observe_host 却没读到')
        self.assertIsNotNone(env.node_version)
        self.assertIsNotNone(env.pnpm_path, '本机有 pnpm，observe_host 却没读到')

    # ── 多错并报 ──────────────────────────────────────────────────────────
    def test_every_problem_is_reported_at_once(self):
        result = preflight(config(min_disk_gib=20.0, min_memory_gib=32.0), self.root,
                           env=healthy_env(pg_config=None, pg_major=None,
                                           free_disk_gib=1.0, memory_gib=2.0,
                                           node_path=None, node_version=None,
                                           pnpm_path=None))
        self.assertEqual(sorted(codes(result)),
                         ['KVVI_DISK_LOW', 'KVVI_MEMORY_LOW', 'KVVI_NODE_NOT_FOUND',
                          'KVVI_PG_NOT_FOUND', 'KVVI_PNPM_NOT_FOUND'],
                         '前置检查一次只报一个问题，客户要来回试几次')

    def test_failures_still_write_nothing(self):
        for env in (healthy_env(pg_config=None, pg_major=None),
                    healthy_env(macos_version=(12, 0)),
                    healthy_env(free_disk_gib=0.1)):
            with self.subTest(env=env):
                result = preflight(config(home=str(self.root / 'kvvi')), self.root, env=env)
                self.assertFalse(result['ok'])
                self.assertEqual(list(self.root.iterdir()), [])

    # ── 观察路径 ──────────────────────────────────────────────────────────
    def test_observe_host_runs_on_this_机器_and_reports_something_sane(self):
        # ⚠️ 这一条存在的理由：上面所有用例都**注入** `HostEnv`，于是
        #    `observe_host()` 一行都没被跑过。第一版它写着 `mac_version()` ——
        #    一个不存在的函数，16 条用例全绿，真机上直接崩。
        #    注入让判定可测，同时也让观察无人测；这条就是补那个缺口。
        from distribution.lib.preflight import observe_host
        env = observe_host()
        self.assertIn(env.platform, ('darwin', 'linux'))
        self.assertGreaterEqual(env.macos_version[0], 0)
        self.assertNotEqual(env.machine, '')
        self.assertGreater(env.free_disk_gib, 0.0)
        self.assertGreater(env.memory_gib, 0.0)
        self.assertGreaterEqual(env.year, 2020)

    def test_pg_major_of_reads_a_version_string(self):
        from distribution.lib.preflight import pg_major_of
        import tempfile, os as _os
        # 用一个可执行的假 `pg_config`，只为验解析，不去动真机器。
        with tempfile.TemporaryDirectory() as tmp:
            fake = Path(tmp) / 'pg_config'
            fake.write_text('#!/bin/sh\necho "PostgreSQL 17.4 (Homebrew)"\n')
            _os.chmod(fake, 0o755)
            self.assertEqual(pg_major_of(fake), 17)
            broken = Path(tmp) / 'broken'
            broken.write_text('#!/bin/sh\nexit 3\n')
            _os.chmod(broken, 0o755)
            self.assertIsNone(pg_major_of(broken))

    # ── 报告形状 ──────────────────────────────────────────────────────────
    def test_report_carries_the_required_postgres_major(self):
        result = preflight(config(), self.root, env=healthy_env())
        self.assertEqual(result['requiredPostgresMajor'], KVVI_PG_MAJOR)
        self.assertEqual(result['hardware']['architecture'], 'arm64')
        self.assertEqual(result['postgres']['major'], KVVI_PG_MAJOR)


def find_pg_config_for(machine: str) -> Path:
    """测试用的薄封装：按架构取该前缀下的 `pg_config`。"""
    from distribution.lib.preflight import pg_config_for
    return pg_config_for(brew_prefix(machine))


class AdminCliTest(unittest.TestCase):
    """
    `kvvi-admin` 的**退出码**是契约的一部分 —— 安装脚本与安装 Agent 靠它分支。
    """

    def _run(self, *argv):
        import subprocess
        from pathlib import Path as _Path
        binary = _Path(__file__).resolve().parents[1] / 'bin' / 'kvvi-admin'
        return subprocess.run([sys.executable, str(binary), *argv],
                              capture_output=True, text=True)

    def test_no_subcommand_is_usage_error(self):
        self.assertEqual(self._run().returncode, 1)

    def test_unknown_subcommand_is_usage_error(self):
        self.assertEqual(self._run('frobnicate').returncode, 1)

    def test_every_planned_command_is_actually_unimplemented(self):
        """
        「尚未实现」与「没有这个子命令」必须分开：混成一句话，客户会以为是自己打错字了。

        ⚠️ 这条用例的样本**从 `PLANNED` 里取**，不写死。
        第一版写死的是 `install`，实现它的那天就红了；
        第二版写死 `backup`，同样在实现它的那天红了。
        **两次都不是行为变了，是用例选错了样本。**
        现在它遍历清单，实现一个就自动少测一个，永远不会误报。
        """
        from importlib.machinery import SourceFileLoader
        admin = SourceFileLoader('kvvi_admin', str(
            Path(__file__).resolve().parents[1] / 'bin' / 'kvvi-admin'))
        planned = admin.load_module().PLANNED
        self.assertTrue(planned, 'PLANNED 空了 —— 那这条测试已经没有意义，应删除')
        for name in planned:
            with self.subTest(command=name):
                result = self._run(name, '--plan')
                self.assertEqual(result.returncode, 1, f'{name} 的退出码不是用法错误')
                self.assertIn('尚未实现', result.stdout)
                self.assertIn('preflight', result.stdout)

    def test_preflight_exit_code_matches_the_environment(self):
        # 不把环境结果写死：这台机器装了 PostgreSQL 就 0，没装就 2 —— 两者都合法，
        # 断言的是「退出码与环境一致」，而不是「这台机器上必须是某一个值」。
        result = self._run('preflight', '--json')
        import json as _json
        self.assertIn(result.returncode, (0, 2))
        report = _json.loads(result.stdout)
        self.assertEqual(result.returncode == 0, report['ok'])

    def test_preflight_reports_the_required_postgres_major(self):
        import json as _json
        report = _json.loads(self._run('preflight', '--json').stdout)
        self.assertEqual(report['requiredPostgresMajor'], KVVI_PG_MAJOR)


if __name__ == '__main__':
    unittest.main()
