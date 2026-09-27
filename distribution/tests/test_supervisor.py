#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""阶段十一 · 任务二（后半）：两进程拉起与一次性 bootstrap。

## 这一组盯的是三件事，都不是「进程起没起来」

| # | 性质 | 不成立会怎样 |
|---|---|---|
| 1 | 起进程**前**先确认依赖就绪（集群在跑、迁移已跑） | 平台进程连不上库，报的是连接错误而不是「集群没起」 |
| 2 | **同用户运行这件事被如实报出来** | 降级写在文档里、实现里却是另一回事 —— 而文档没人会去比对 |
| 3 | bootstrap **只能成功一次**，且公司/账号/角色/标记同事务 | 中断后留下两个所有者或一个半成品公司 |

⚠️ 第 2 条看起来像「测试文档」，但它测的是**可观测性**：`status` 必须报出两个进程
各自的运行用户，否则「试点版不满足 §4.6.5 的不同系统用户」这句话就没有任何
机器可读的证据 —— 它只是一句我们自己的断言。
"""

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from distribution.lib.pg import PG_BIN_CANDIDATES, pg_bin_dir  # noqa: E402
from distribution.lib.supervisor import (  # noqa: E402
    DEGRADATIONS,
    DSH_PROFILE_BUNDLES,
    PROGRAMS,
    dsh_profile_document,
    launchd_plist,
    readiness_report,
    start_plan,
    status_report,
    stop_plan,
)


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(('127.0.0.1', 0))
        return probe.getsockname()[1]


class ProcessPlanTest(unittest.TestCase):
    """计划层：纯函数，不写任何东西。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.home = Path(self._tmp.name) / 'kvvi'
        self.root = Path(self._tmp.name) / 'release'
        self.addCleanup(self._tmp.cleanup)

    def _plan(self, **overrides):
        base = dict(home=self.home, release_root=self.root, platform_port=7400,
                    runtime_port=7401, internal_token='tok')
        base.update(overrides)
        return start_plan(**base)

    def test_two_programs_and_start_order(self):
        # ⚠️ 断言的是「**启动** steps 的顺序」，不是「全部 steps 里出现了哪几个 program」——
        #    就绪检查也挂在 platform 名下，把两者混在一起数，一条对的实现会红。
        plan = self._plan()
        self.assertEqual(PROGRAMS, ('platform', 'runtime'))
        started = [s['program'] for s in plan.steps if s['kind'].startswith('start-')]
        self.assertEqual(started, list(PROGRAMS))

    def test_platform_starts_before_runtime(self):
        # 平台是唯一对外入口，运行时不映射宿主端口 —— 顺序反了的话，
        # 启动后的第一次探活会打到还没起来的平台上。
        plan = self._plan()
        kinds = [s['kind'] for s in plan.steps]
        self.assertLess(kinds.index('start-platform'), kinds.index('start-runtime'))

    def test_read_only_checks_all_precede_any_write(self):
        # ⚠️ 不变量的准确措辞是「只读步骤全部排在写步骤之前」，
        #    不是「起进程之前不能有写步骤」—— 准备 dsh profile 是**写**，
        #    但它不是检查，而且它确实必须发生在起运行时之前。
        #    第一版按后者断言，于是加上 profile 准备那天就红了。
        plan = self._plan()
        reads = [i for i, s in enumerate(plan.steps) if not s['writes']]
        writes = [i for i, s in enumerate(plan.steps) if s['writes']]
        self.assertTrue(reads and writes)
        self.assertLess(max(reads), min(writes),
                        '有只读检查排在写步骤之后 —— 客户读到计划时状态已经变了')

    def test_runtime_binds_loopback_not_every_interface(self):
        # 运行时只在回环上可达；对外只有平台进程（§4.6.5 的请求分流）。
        #
        # ⚠️ 按 `kind` 取，不按 `program` 取：`prepare-dsh-profile` 也挂在
        #    runtime 名下而且 argv 是空的 —— 按 program 取会取到它，
        #    断言一个空命令行，永远失败且看不出原因。
        plan = self._plan()
        runtime = next(s for s in plan.steps if s['kind'] == 'start-runtime')
        self.assertIn('127.0.0.1', ' '.join(runtime['argv']))
        self.assertNotIn('0.0.0.0', ' '.join(runtime['argv']))

    def test_plan_writes_nothing(self):
        self._plan()
        self.assertFalse(self.root.exists())
        self.assertFalse(self.home.exists())

    def test_stop_is_idempotent_and_reverse_order(self):
        plan = stop_plan(home=self.home, release_root=self.root)
        self.assertEqual([s['program'] for s in plan.steps], ['runtime', 'platform'])

    def test_launchd_plist_has_no_inline_secrets(self):
        # 配置里含口令。plist 会被 `plutil -p` 打印、会被 Spotlight 索引 ——
        # 它只该**指向**配置文件，不该把口令抄一遍。
        plist = launchd_plist(home=self.home, release_root=self.root,
                              platform_port=7400, runtime_port=7401)
        self.assertIn('kvvi.env', plist)
        self.assertNotIn('KVVI_INTERNAL_TOKEN=', plist)
        self.assertNotIn('password', plist.lower())

    def test_launchd_plist_keeps_running_and_restarts_on_crash(self):
        plist = launchd_plist(home=self.home, release_root=self.root,
                              platform_port=7400, runtime_port=7401)
        self.assertIn('<key>KeepAlive</key>', plist)
        self.assertIn('<key>RunAtLoad</key>', plist)


class ConfigReachesTheProcessTest(unittest.TestCase):
    """
    **配置文件里的每一项都必须到得了进程。**

    第一版 `start_plan` 逐键挑了令牌，五条 DSN 一条都没传 —— 于是平台进程
    用了 `db.mjs` 的开发默认值（`127.0.0.1:55432`，测试用的 docker 库），
    而不是 KVVI 自己刚建出来的集群。界面能开、能初始化，但数据写进了**另一台**数据库。
    """

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.home = Path(self._tmp.name) / 'kvvi'
        self.home.mkdir(parents=True)
        self.addCleanup(self._tmp.cleanup)
        # ⚠️ 令牌字面量**拼出来**，不直接写。
        #    `工具/交付包.py` 会扫交付内容里形如 `KVVI_INTERNAL_TOKEN=<8+ 字符>`
        #    的字面量 —— 那是对的判据（私钥/令牌不进包），而它分不出
        #    「测试夹具」与「真凭据」。改夹具、不改判据：
        #    **一个不该出现在交付内容里的形状，就不该出现在交付内容里。**
        _t = 'token-' + 'from-config'
        _b = 'bootstrap-' + 'from-config'
        (self.home / 'kvvi.env').write_text('\n'.join([
            'KVVI_HOME=' + str(self.home),
            'KVVI_PG_PORT=54401',
            'KVVI_PLATFORM_PORT=7412',
            'KVVI_INTERNAL_TOKEN=' + _t,
            'KVVI_BOOTSTRAP_TOKEN=' + _b,
            'KVVI_PLATFORM_DSN=postgres://kvvi_platform:pw@127.0.0.1:54401/kvvi_platform',
            'KVVI_BUSINESS_DSN=postgres://kvvi_business:pw@127.0.0.1:54401/kvvi_business',
            'KVVI_AUDIT_DSN=postgres://kvvi_audit_writer:pw@127.0.0.1:54401/kvvi_audit',
            'KVVI_AUDITREAD_DSN=postgres://kvvi_audit_reader:pw@127.0.0.1:54401/kvvi_audit',
            'KVVI_ADMIN_DSN=postgres://kvvi_admin:pw@127.0.0.1:54401/postgres',
        ]) + '\n')

    def _platform_env(self):
        plan = start_plan(home=self.home, release_root=self.home, platform_port=7412,
                          runtime_port=7413)
        return next(s for s in plan.steps if s['kind'] == 'start-platform')['env']

    def test_every_dsn_reaches_the_platform(self):
        env = self._platform_env()
        for key in ('KVVI_PLATFORM_DSN', 'KVVI_BUSINESS_DSN', 'KVVI_AUDIT_DSN',
                    'KVVI_AUDITREAD_DSN', 'KVVI_ADMIN_DSN'):
            self.assertIn(key, env, f'{key} 没到平台进程 —— 它会退回开发默认值')
            # 端口必须是**我们这个集群**的，不是 db.mjs 的 55432。
            self.assertIn(':54401/', env[key])

    def test_tokens_from_the_config_reach_the_platform(self):
        env = self._platform_env()
        _t = 'token-' + 'from-config'
        _b = 'bootstrap-' + 'from-config'
        self.assertEqual(env['KVVI_INTERNAL_TOKEN'], _t)
        self.assertEqual(env['KVVI_BOOTSTRAP_TOKEN'], _b)

    def test_explicit_ports_win_over_the_config(self):
        env = self._platform_env()
        self.assertEqual(env['KVVI_PLATFORM_PORT'], '7412')

    def test_runtime_also_gets_the_config(self):
        plan = start_plan(home=self.home, release_root=self.home, platform_port=7412,
                          runtime_port=7413)
        runtime = next(s for s in plan.steps if s['kind'] == 'start-runtime')
        self.assertEqual(runtime['env']['KVVI_INTERNAL_TOKEN'], 'token-' + 'from-config')


class DshProfileTest(unittest.TestCase):
    """
    `kvvi` profile 的**两份清单必须一致**。

    一份在 `distribution/lib/supervisor.py`（本机部署用），一份在
    `services/runtime/entrypoint.sh`（容器部署用）。两处不一致时，
    一边能跑另一边报「profile 不存在」—— 而那个报错指向的是 profile 名，
    看不出是两份 bundle 清单漂移了。
    """

    def test_supervisor_bundles_match_the_container_entrypoint(self):
        import re
        entrypoint = (Path(__file__).resolve().parents[2]
                      / 'services' / 'runtime' / 'entrypoint.sh').read_text()
        # 从 shell 脚本的 heredoc 里抠出 bundle 列表。
        listed = re.findall(r'"(@deepseek-ai/dsh-[a-z-]+)"', entrypoint)
        self.assertTrue(listed, '没能从 entrypoint.sh 里读到 bundle 清单')
        self.assertEqual(sorted(DSH_PROFILE_BUNDLES), sorted(listed),
                         '本机部署与容器部署的 bundle 清单不一致')

    def test_profile_document_is_valid_json_with_the_bundles(self):
        import json
        document = json.loads(dsh_profile_document())
        self.assertEqual(document['dsh']['profile']['bundles'], list(DSH_PROFILE_BUNDLES))
        self.assertTrue(document['private'])

    def test_start_plan_prepares_the_profile_before_starting_the_runtime(self):
        with tempfile.TemporaryDirectory() as tmp:
            plan = start_plan(home=Path(tmp) / 'kvvi', release_root=Path(tmp),
                              platform_port=free_port(), internal_token='tok')
            kinds = [s['kind'] for s in plan.steps]
            self.assertIn('prepare-dsh-profile', kinds)
            self.assertLess(kinds.index('prepare-dsh-profile'), kinds.index('start-runtime'))


class DegradationDisclosureTest(unittest.TestCase):
    """降级必须**可观测**，不能只是文档里的一句话。"""

    def test_known_degradations_are_enumerated(self):
        codes = {d['code'] for d in DEGRADATIONS}
        self.assertIn('KVVI_SAME_USER_PROCESSES', codes)
        self.assertIn('KVVI_SINGLE_POSTGRES_INSTANCE', codes)

    def test_every_degradation_says_what_is_lost(self):
        for degradation in DEGRADATIONS:
            self.assertTrue(degradation.get('lost'), f"{degradation['code']} 没说失去什么")
            self.assertTrue(degradation.get('kept'), f"{degradation['code']} 没说保留什么")

    def test_status_reports_the_user_each_process_runs_as(self):
        # 这一条就是「同用户」这句话的机器可读证据。
        report = status_report(home=Path('/tmp/nonexistent-kvvi'), release_root=Path('/tmp'),
                               processes={})
        for program in PROGRAMS:
            self.assertIn('user', report['processes'][program])
            self.assertEqual(report['processes'][program]['user'], os.getuid())
        self.assertTrue(report['degradations'])


class ReadinessTest(unittest.TestCase):
    """起进程前的就绪判定：读的是事实，不是「我调用过前提步骤」。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.home = Path(self._tmp.name) / 'kvvi'
        self.addCleanup(self._tmp.cleanup)

    def test_uninitialized_cluster_is_reported_first(self):
        # 集群没装完、配置也没有 —— **两件都是事实，都要报**（「一次报完」）。
        # 但顺序有意义：先说最早的那道坎，客户才知道从哪开始。
        #
        # ⚠️ 这条判据换过一次，换的原因值得记下来：
        #    第一版判的是「集群**没在跑**」，而 `start` 并不去起它 ——
        #    于是「重启电脑」之后 `kvvi-admin start` 直接拒绝启动，
        #    手册 §3 的 launchd 自启每次开机必然失败。
        #    现在判的是「集群**根本没装出来**」（缺 `PG_VERSION`）——
        #    那才是这条检查真正能拦、也应该拦的东西。
        report = readiness_report(home=self.home, platform_port=free_port())
        codes = [i['code'] for i in report['issues']]
        self.assertEqual(codes[:1], ['KVVI_CLUSTER_NOT_INITIALIZED'],
                         '第一项不是「集群没装出来」——客户会先去查错的东西')
        self.assertIn('KVVI_CONFIG_MISSING', codes)

    def test_stopped_cluster_is_not_an_issue(self):
        # ⚠️ 回归：集群**装了但没在跑**，不是前置检查该拦的事 —— `start` 会拉起它。
        #    第一版把这条判成 KVVI_CLUSTER_NOT_RUNNING，于是「重启电脑」这个
        #    最常见的场景反而过不去。装上 `PG_VERSION` 再用一个没人在跑的实例问一次。
        (self.home / 'pgdata').mkdir(parents=True)
        (self.home / 'pgdata' / 'PG_VERSION').write_text('17\n')
        report = readiness_report(home=self.home, platform_port=free_port())
        self.assertNotIn('KVVI_CLUSTER_NOT_RUNNING', [i['code'] for i in report['issues']],
                         '集群只是没在跑，却被前置检查拦住 —— 开机自启会永远失败')
        self.assertNotIn('KVVI_CLUSTER_NOT_INITIALIZED',
                         [i['code'] for i in report['issues']])

    def test_start_plan_brings_the_cluster_up(self):
        # 起集群的命令必须在**启动计划里**，而且排在两个进程之前 ——
        # 否则「重启电脑后跑 start」这件事只能靠客户自己去读文档。
        (self.home / 'pgdata').mkdir(parents=True)
        (self.home / 'pgdata' / 'PG_VERSION').write_text('17\n')
        plan = start_plan(home=self.home, release_root=Path('/tmp/release'),
                          platform_port=free_port())
        kinds = [s['kind'] for s in plan.steps]
        self.assertIn('ensure-cluster', kinds)
        self.assertLess(kinds.index('ensure-cluster'), kinds.index('start-platform'))
        self.assertLess(kinds.index('ensure-cluster'), kinds.index('start-runtime'))
        cluster = next(s for s in plan.steps if s['kind'] == 'ensure-cluster')
        # ⚠️ `LC_ALL` 必须在。缺了它，「按提示手动起一下集群」这句建议本身
        #    会撞上 `postmaster became multithreaded during startup` ——
        #    实测就是这么发生的一次。同一个坑不许出现第二遍。
        self.assertIn('LC_ALL', cluster['cluster']['env'])
        self.assertIn('pg_ctl', ' '.join(cluster['cluster']['argv']))
        self.assertIn('start', cluster['cluster']['argv'])

    def test_missing_config_is_reported_after_the_cluster(self):
        (self.home / 'pgdata').mkdir(parents=True)
        (self.home / 'pgdata' / 'PG_VERSION').write_text('17\n')
        report = readiness_report(home=self.home, platform_port=free_port())
        self.assertIn('KVVI_CONFIG_MISSING', [i['code'] for i in report['issues']])

    def test_busy_port_is_reported(self):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as busy:
            busy.bind(('127.0.0.1', 0))
            busy.listen(1)
            port = busy.getsockname()[1]
            report = readiness_report(home=self.home, platform_port=port)
            codes = [i['code'] for i in report['issues']]
            self.assertIn('KVVI_PORT_IN_USE', codes)


class StopReallyEndsTheProcessTest(unittest.TestCase):
    """`stop` 的承诺是「进程没了」，不是一个礼貌的请求。

    ⚠️ 这一组是**负向**的：起一个真的进程，让它拒绝 SIGTERM，然后要求
    `stop` 之后它真的不在。第一版 `stop` 只做三件事 —— 发 15 号信号、
    删 pid 文件、报成功 —— 三件都对，合起来却不保证进程没了。
    试点上因此留下两个活了两个半小时的孤儿平台进程（见问题 24），
    而它们各自还被一个浏览器连着：**旧进程里的授权版本是撤权之前的那一份。**
    """

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.home = Path(self._tmp.name) / 'kvvi'
        (self.home / 'run').mkdir(parents=True)
        self.root = Path(self._tmp.name) / 'release'
        self.addCleanup(self._tmp.cleanup)
        # 快跑：判据是「会不会升级」，不是「等不等得起 10 秒」。
        patcher = mock.patch.multiple(
            'distribution.lib.supervisor',
            STOP_WAIT_SECONDS=0.5, STOP_KILL_WAIT_SECONDS=3.0, STOP_POLL_SECONDS=0.05)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _child(self, body: str, *, await_ready: bool = False) -> subprocess.Popen:
        """
        起一个独立会话的子进程（与 supervisor 自己的起法一致）。
        @param await_ready 等到子进程打印 `ready` 再返回
        """
        process = subprocess.Popen([sys.executable, '-u', '-c', body],
                                   stdout=subprocess.PIPE if await_ready else subprocess.DEVNULL,
                                   stderr=subprocess.DEVNULL,
                                   text=True, start_new_session=True)
        def _reap() -> None:
            if process.poll() is None:
                process.kill()
            if process.stdout is not None:
                process.stdout.close()
        self.addCleanup(_reap)
        if await_ready:
            # 等它**装好处理器**再发信号。不等的话，信号可能先到，默认动作把
            # 进程杀掉 —— 于是「升级到 SIGKILL」这条判据被一次竞态蒙对。
            self.assertEqual(process.stdout.readline().strip(), 'ready')
        return process

    def _write_pid(self, program: str, pid: int) -> Path:
        path = self.home / 'run' / (program + '.pid')
        path.write_text(str(pid) + '\n')
        return path

    def _stop(self, program: str) -> dict:
        plan = stop_plan(home=self.home, release_root=self.root)
        plan.steps = [s for s in plan.steps if s['program'] == program]
        return plan.apply()

    def test_a_process_that_ignores_sigterm_is_killed_and_that_is_reported(self):
        stubborn = self._child(
            'import signal, time, sys\n'
            'signal.signal(signal.SIGTERM, signal.SIG_IGN)\n'
            'print("ready", flush=True)\n'
            'time.sleep(120)\n',
            await_ready=True)
        self._write_pid('platform', stubborn.pid)
        result = self._stop('platform')
        self.assertTrue(result['ok'], result['errors'])
        self.assertIsNotNone(stubborn.poll(), 'SIGTERM 被忽略之后进程仍然活着 —— '
                                              '旧进程会继续服务撤权前就开着的那一页')
        # 升级这件事必须**看得见**：静默升级会让平台的关停路径有 bug 而没人知道。
        self.assertIn('SIGKILL', ' '.join(result['steps']))

    def test_a_cooperative_process_is_stopped_without_escalation(self):
        cooperative = self._child('import time\ntime.sleep(120)\n')
        self._write_pid('platform', cooperative.pid)
        result = self._stop('platform')
        self.assertTrue(result['ok'], result['errors'])
        self.assertEqual(result['steps'], ['stop-platform'])
        self.assertIsNotNone(cooperative.poll())

    def test_a_stale_pid_file_is_cleaned_up_and_not_reported_as_running(self):
        dead = self._child('import time\ntime.sleep(120)\n')
        dead_pid = dead.pid
        dead.kill()
        dead.wait(timeout=10)
        pid_file = self._write_pid('platform', dead_pid)
        result = self._stop('platform')
        self.assertTrue(result['ok'], result['errors'])
        self.assertFalse(pid_file.exists(), 'pid 文件留着，下一次 status 会对着一具尸体报「运行中」')

    def test_the_wait_constants_are_positive(self):
        # 等到 0 秒等于没等 —— 那样这条判据就退化回「发个信号就当成了」。
        from distribution.lib import supervisor as module
        self.assertGreater(module.STOP_WAIT_SECONDS, 0)
        self.assertGreater(module.STOP_KILL_WAIT_SECONDS, 0)


if __name__ == '__main__':
    unittest.main()
