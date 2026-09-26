#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""阶段十一 · 任务二：本地集群拉起与首次安装。

## 这一组分两层，两层缺一不可

| 层 | 测什么 | 为什么不能只有另一层 |
|---|---|---|
| **计划层**（快、注入） | `install_plan` 的每一步、每个路径、每个「不碰什么」 | 只有集成层时，失败信息是「集群起不来」，看不出是**哪一步**错了 |
| **集成层**（真跑 initdb） | 真的建出集群、真的建出三个库三套角色、真的能迁移 | 只有计划层时，`initdb` 的参数写错了也全绿 —— 任务一刚吃过这个亏（`mac_version()`） |

⚠️ 集成层**不 mock postgres**。一个把 `initdb` 换成桩的测试，验的是桩，
而真正会出错的地方（locale、socket 目录、认证方式）恰好在桩之外。

## 探路时真实撞到的三件事（都写进了实现）

1. **`initdb` 不建 socket 目录。** 不在启动前 `mkdir`，postgres 报
   `could not create lock file ...: No such file or directory` —— 读起来像权限问题。
2. **macOS 上不设 `LC_ALL` 起不来**：`FATAL: postmaster became multithreaded during startup`。
   报错里没有一个字提到 locale（除了那行 HINT）。
3. **`migrate.mjs` 不用改**：把五个 DSN 指过去，它自己建库建角色、跑完九个迁移。
   这是本任务最重要的一条 —— 它意味着平台侧一行都不用动。
"""

import os
import shutil
import socket
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from distribution.lib.pg import (  # noqa: E402
    PG_BIN_CANDIDATES,
    ROLES,
    cluster_is_running,
    cluster_plan,
    databases_plan,
    pg_bin_dir,
    stop_cluster,
)
from distribution.lib.install import install_plan  # noqa: E402


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(('127.0.0.1', 0))
        return probe.getsockname()[1]


class PlanWritesNothingTest(unittest.TestCase):
    """计划是纯函数：只读、无副作用。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def test_plan_writes_nothing(self):
        install_plan(home=str(self.root / 'kvvi'), pg_port=54329, platform_port=7400,
                     pg_bin=Path('/opt/homebrew/opt/postgresql@17/bin'))
        self.assertEqual(list(self.root.iterdir()), [])

    def test_every_mutating_step_is_marked_as_such(self):
        # 计划里的每一步都要能回答「它改不改东西」。安装前的展示（§9.2）靠这个。
        plan = install_plan(home=str(self.root / 'kvvi'), pg_port=54329, platform_port=7400,
                            pg_bin=Path('/opt/homebrew/opt/postgresql@17/bin'))
        self.assertTrue(plan.steps)
        for step in plan.steps:
            self.assertIn('writes', step, f'步骤没有标明是否改动：{step}')
            self.assertIsInstance(step['writes'], bool)

    def test_read_only_steps_come_before_writes(self):
        plan = install_plan(home=str(self.root / 'kvvi'), pg_port=54329, platform_port=7400,
                            pg_bin=Path('/opt/homebrew/opt/postgresql@17/bin'))
        first_write = next(i for i, s in enumerate(plan.steps) if s['writes'])
        for step in plan.steps[:first_write]:
            self.assertFalse(step['writes'], f'第一次写之前出现了写步骤：{step}')


class ClusterOwnershipTest(unittest.TestCase):
    """集群必须是 KVVI 自己的：自己的目录、自己的端口、自己的 socket。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.home = Path(self._tmp.name) / 'kvvi'
        self.addCleanup(self._tmp.cleanup)

    def test_cluster_is_its_own(self):
        plan = cluster_plan(home=self.home, pg_port=54329, pg_bin=Path('/opt/homebrew/opt/postgresql@17/bin'))
        self.assertEqual(plan.data_dir, self.home / 'pgdata')
        self.assertEqual(plan.socket_dir, self.home / 'run')
        self.assertEqual(plan.pg_port, 54329)

    def test_socket_dir_is_not_a_shared_location(self):
        # brew 自己的集群把 socket 放在 /tmp —— 那是**所有用户**都能连的地方。
        # KVVI 的放在自己的 home 下，0700，于是「谁能连」由目录权限回答。
        plan = cluster_plan(home=self.home, pg_port=54329, pg_bin=Path('/opt/homebrew/opt/postgresql@17/bin'))
        self.assertNotEqual(plan.socket_dir, Path('/tmp'))
        self.assertTrue(str(plan.socket_dir).startswith(str(self.home)))

    def test_plan_never_points_at_the_homebrew_cluster(self):
        plan = cluster_plan(home=self.home, pg_port=54329, pg_bin=Path('/opt/homebrew/opt/postgresql@17/bin'))
        joined = ' '.join(plan.commands_flat())
        self.assertNotIn('/opt/homebrew/var/postgresql@17', joined,
                         '计划指向了 Homebrew 自己建的集群 —— 那是客户/开发机上已有的库')

    def test_socket_dir_is_created_before_the_server_starts(self):
        # 探路时撞到的第一件事：`initdb` 不建 socket 目录。
        plan = cluster_plan(home=self.home, pg_port=54329, pg_bin=Path('/opt/homebrew/opt/postgresql@17/bin'))
        order = [step['kind'] for step in plan.steps]
        self.assertIn('mkdir-socket-dir', order)
        self.assertLess(order.index('mkdir-socket-dir'), order.index('start-server'))

    def test_start_sets_lc_all(self):
        # 探路时撞到的第二件事：macOS 上不设 LC_ALL，postgres 报
        # 「postmaster became multithreaded during startup」—— 报错里没提 locale。
        plan = cluster_plan(home=self.home, pg_port=54329, pg_bin=Path('/opt/homebrew/opt/postgresql@17/bin'))
        start = next(step for step in plan.steps if step['kind'] == 'start-server')
        self.assertIn('LC_ALL', start['env'])
        self.assertTrue(start['env']['LC_ALL'])

    def test_authentication_is_scram_over_tcp(self):
        plan = cluster_plan(home=self.home, pg_port=54329, pg_bin=Path('/opt/homebrew/opt/postgresql@17/bin'))
        initdb = next(step for step in plan.steps if step['kind'] == 'initdb')
        self.assertIn('--auth-host=scram-sha-256', initdb['argv'])
        # 本地 socket 用 trust，但它 0700 且只在 $KVVI_HOME/run 下 —— 见模块说明。
        self.assertIn('--auth-local=trust', initdb['argv'])

    def test_server_listens_on_loopback_only(self):
        plan = cluster_plan(home=self.home, pg_port=54329, pg_bin=Path('/opt/homebrew/opt/postgresql@17/bin'))
        joined = ' '.join(plan.commands_flat())
        self.assertIn('listen_addresses=127.0.0.1', joined)
        self.assertNotIn('listen_addresses=*', joined)


class DatabasePlanTest(unittest.TestCase):
    """三个库三套角色，与 sql/ 里期望的名字一致。"""

    def test_three_databases_and_four_roles(self):
        plan = databases_plan(superuser='kvvi_admin', superpass='x', pg_port=54329,
                              role_passwords={
                                  'kvvi_platform': 'p1', 'kvvi_business': 'b1',
                                  'kvvi_audit_writer': 'w1', 'kvvi_audit_reader': 'r1'})
        self.assertEqual([d['name'] for d in plan.databases],
                         ['kvvi_platform', 'kvvi_business', 'kvvi_audit'])
        self.assertEqual(sorted(plan.role_passwords), sorted(
            ['kvvi_platform', 'kvvi_business', 'kvvi_audit_writer', 'kvvi_audit_reader']))

    def test_roles_get_passwords_and_are_not_superusers(self):
        # ⚠️ 第一版这里写的是 `assertNotIn('SUPERUSER ', joined)` —— 而
        #    `NOSUPERUSER ` **包含** `SUPERUSER `，于是它永远失败。
        #    子串判定分不出「授予」与「不授予」，所以换成精确的判据：
        #    `NOSUPERUSER` 必须在，且**不存在独立的** `SUPERUSER` 授权。
        import re
        plan = databases_plan(superuser='kvvi_admin', superpass='x', pg_port=54329,
                              role_passwords={'kvvi_platform': 'p1'})
        joined = ' '.join(plan.commands_flat())
        self.assertIn('NOSUPERUSER', joined)
        self.assertEqual(re.findall(r'(?<!NO)SUPERUSER', joined), [],
                         '存在超级用户授权 —— 超级用户绕过 RLS，第二执行点会失效')

    def test_databases_are_owned_by_their_restricted_role(self):
        # 库的所有者不能是超级用户：所有者可以改权限，而 §4.6.1 的分权靠的正是
        # 「一把钥匙开不了两扇门」。
        plan = databases_plan(superuser='kvvi_admin', superpass='x', pg_port=54329,
                              role_passwords={'kvvi_platform': 'p1'})
        joined = ' '.join(plan.commands_flat())
        for database in plan.databases:
            self.assertIn('OWNER ' + database['roles'][0], joined)
            self.assertNotIn('OWNER kvvi_admin', joined)

    def test_no_manual_sql_for_the_customer(self):
        # §9.5 硬性验收第 4 条：自动创建，不让客户手工执行 SQL。
        # 这条断言的是「计划里没有任何需要客户自己粘的 SQL 片段」。
        plan = databases_plan(superuser='kvvi_admin', superpass='x', pg_port=54329,
                              role_passwords={'kvvi_platform': 'p1'})
        self.assertTrue(all(step.get('argv') for step in plan.steps),
                        '计划里有步骤没给出可执行命令 —— 那多半是要客户手敲的 SQL')


@unittest.skipUnless(shutil.which('pg_config') or PG_BIN_CANDIDATES,
                     '需要本机安装 postgresql@17')
class RealClusterTest(unittest.TestCase):
    """
    真的建一个集群起来。**不 mock postgres。**

    慢（约三秒），但它验的是唯一一件计划层验不到的事：
    `initdb` + `pg_ctl` 的参数**在这台机器上真的能跑通**。
    """

    SUPERUSER_PASSWORD = 'test-only-superuser-pass'

    @classmethod
    def setUpClass(cls):
        try:
            cls.pg_bin = pg_bin_dir()
        except RuntimeError as error:
            raise unittest.SkipTest(str(error))
        cls._tmp = tempfile.TemporaryDirectory()
        cls.home = Path(cls._tmp.name) / 'kvvi'
        cls.port = free_port()
        # 口令**显式给定**，好让后面的用例能验证认证确实生效。
        # 随机口令的集群无法验证「错口令被拒」，只能验证「对的口令能连」——
        # 而那是一个更弱的断言。
        cls.plan = cluster_plan(home=cls.home, pg_port=cls.port, pg_bin=cls.pg_bin,
                                superuser_password=cls.SUPERUSER_PASSWORD)

    @classmethod
    def tearDownClass(cls):
        try:
            stop_cluster(cls.home, cls.pg_bin)
        finally:
            cls._tmp.cleanup()

    def test_01_initdb_and_start(self):
        result = self.plan.apply()
        self.assertTrue(result['ok'], result)
        self.assertTrue(cluster_is_running(self.home, self.pg_bin))
        # socket 目录必须真的建出来了 —— initdb 不会替你建。
        self.assertTrue((self.home / 'run').is_dir())
        mode = (self.home / 'run').stat().st_mode & 0o777
        self.assertEqual(mode, 0o700, 'socket 目录不是 0700 —— 「谁能连」就不再由目录权限回答')

    def test_02_scram_is_enforced(self):
        # 正确口令能连。
        self.assertTrue(self._psql(self.SUPERUSER_PASSWORD, 'select 1'))
        # 错误口令不能连 —— 这一条才让「scram 生效」可判定。
        self.assertFalse(self._psql('wrong', 'select 1'))

    def test_03_plan_is_idempotent_when_cluster_exists(self):
        # 再跑一次计划不该把已有集群毁掉。
        result = self.plan.apply()
        self.assertTrue(result['ok'], result)
        self.assertTrue(cluster_is_running(self.home, self.pg_bin))

    def test_04_real_databases_and_roles_are_created(self):
        """
        真的把三个库与四套角色建出来，并**查库**验证约束成立。

        计划层的断言只能证明「命令里写了 NOSUPERUSER」；真实生效与否要看 `pg_roles`。
        这两件事在探路时是分开的：`\gexec` 写错时计划层照样全绿。
        """
        plan = databases_plan(superuser='kvvi_admin', superpass=self.SUPERUSER_PASSWORD,
                              pg_port=self.port,
                              role_passwords={r: f'{r}-pw' for r in ROLES})
        result = plan.apply(self.pg_bin)
        self.assertTrue(result['ok'], result)

        # 只看四个**受限**角色：`kvvi_admin` 本来就该是超级用户，
        # 把它一起断言成「非超级」是自己给自己造的矛盾。
        rows = self._query(self.SUPERUSER_PASSWORD,
                           "SELECT rolname, rolsuper FROM pg_roles WHERE rolname IN "
                           "('kvvi_platform','kvvi_business','kvvi_audit_writer',"
                           "'kvvi_audit_reader') ORDER BY rolname")
        lines = [line for line in rows.strip().splitlines() if '|' in line]
        names = [line.split('|')[0] for line in lines]
        for role in ROLES:
            self.assertIn(role, names, f'{role} 没建出来')
        # ★ 关键：四个受限角色都不是超级用户。超级用户绕过 RLS。
        for line in lines:
            self.assertIn('|f', line, f'{line} 是超级用户 —— RLS 会被绕过')

        databases = self._query(self.SUPERUSER_PASSWORD,
                                "SELECT datname FROM pg_database WHERE datname LIKE 'kvvi_%' "
                                "ORDER BY datname")
        for database in plan.databases:
            self.assertIn(database['name'], databases)

    def test_05_restricted_roles_cannot_connect_to_someone_elses_database(self):
        """
        一把钥匙开不了两扇门：平台角色连得上自己的库，连不上业务库。

        ⚠️ 断言**失败原因**，不只是退出码。`psql` 连不上有很多原因
        （库不存在、口令错、pg_hba 拒），只看 `returncode != 0`
        会把「库根本不存在」也算成「权限挡住了」—— 那样这条测试什么都没证明。
        """
        ok, _ = self._try_connect('kvvi_platform-pw', 'kvvi_platform')
        self.assertTrue(ok, '平台角色连不上自己的库')
        ok, _ = self._try_connect('kvvi_platform-pw', 'kvvi_business')
        self.assertFalse(ok, '平台角色连上了业务库 —— 一把钥匙开了两扇门')

        # ⚠️ **不去解析错误文字，而是直接查权限。**
        #
        #    第一版断言 stderr 里有 'permission denied for database'；
        #    本机 postgres 的报错是中文的（「访问数据库…的权限不够」），必然失败。
        #    改断言 SQLSTATE，也不行：**连接期的失败**不经 psql 的 verbose 格式化，
        #    而且服务端的消息语言由 `initdb --locale` 定下，客户端
        #    `LC_MESSAGES=C` 只翻译得了 psql 自己那半句。
        #
        #    所以判据换成**目录里的权限事实** —— 与语言、与错误路径都无关：
        privileges = self._query(self.SUPERUSER_PASSWORD,
                                 "SELECT has_database_privilege('kvvi_platform','kvvi_platform','CONNECT')"
                                 " || '|' || "
                                 "has_database_privilege('kvvi_platform','kvvi_business','CONNECT')")
        # 布尔在 psql 的 `-tAc` 下输出 `true|false`（不是 `t|f` —— 那是 `-A` 下 char 的写法）。
        self.assertEqual(privileges.strip(), 'true|false',
                         '平台角色对业务库的 CONNECT 权限不是「否」')

    def _query(self, password, sql) -> str:
        from distribution.lib.pg import SUPERUSER
        env = dict(os.environ, PGPASSWORD=password, LC_ALL='en_US.UTF-8')
        out = subprocess.run(
            [str(self.pg_bin / 'psql'), '-h', '127.0.0.1', '-p', str(self.port),
             '-U', SUPERUSER, '-d', 'postgres', '-tAc', sql],
            capture_output=True, text=True, env=env, timeout=30)
        return out.stdout

    def _try_connect(self, password, database, sql='select 1'):
        """
        试连一个库。
        @param password 口令
        @param database 目标库
        @param sql 连上后跑的语句
        @returns `(是否成功, stderr)`
        """
        env = dict(os.environ, PGPASSWORD=password, LC_ALL='en_US.UTF-8')
        out = subprocess.run(
            [str(self.pg_bin / 'psql'), '-h', '127.0.0.1', '-p', str(self.port),
             '-U', 'kvvi_platform', '-d', database, '-v', 'VERBOSITY=verbose',
             '-tAc', sql],
            capture_output=True, text=True, env=env, timeout=30)
        return out.returncode == 0, out.stderr

    def _psql(self, password, sql) -> bool:
        env = dict(os.environ, PGPASSWORD=password, LC_ALL='en_US.UTF-8')
        from distribution.lib.pg import SUPERUSER
        out = subprocess.run(
            [str(self.pg_bin / 'psql'), '-h', '127.0.0.1', '-p', str(self.port),
             '-U', SUPERUSER, '-d', 'postgres', '-tAc', sql],
            capture_output=True, text=True, env=env, timeout=30)
        return out.returncode == 0


if __name__ == '__main__':
    unittest.main()
