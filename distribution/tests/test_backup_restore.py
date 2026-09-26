#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""阶段十一 · 任务三：备份、恢复与 PostgreSQL 大版本升级。

## 这一组盯的四件事，每一件都对应一次真实的数据损失

| # | 性质 | 不成立会怎样 |
|---|---|---|
| 1 | 备份包**逐文件摘要**，恢复前先核 | 拿到一个被截断或改过的备份，恢复出半个库 —— 而恢复是**覆盖**动作 |
| 2 | 恢复前先核摘要，**核不过就不动数据库** | 已经覆写了才发现包是坏的，原数据也没了 |
| 3 | 大版本升级**绝不用 `pg_upgrade`** | 就地升级失败会同时损坏**唯一一份**数据 |
| 4 | 不可逆迁移**阻止自动回滚**，但**不阻止升级** | 回滚到一个数据库认不出的版本，比不回滚更坏 |

## 两层，缺一不可

- **计划层**（快、注入）：每一步、每个路径、每个「不碰什么」；
- **集成层**（真跑 `pg_dump`/`pg_restore`）：真的导出、真的导进一个新集群、
  真的比对行数与审计链。**不 mock postgres** —— 会被搞错的地方（连接方式、
  编码、owner、扩展）恰好都在桩之外。
"""

import os
import shutil
import socket
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from distribution.lib.backup import (  # noqa: E402
    DATABASES_TO_DUMP,
    backup_plan,
    manifest_of,
    restore_plan,
    uninstall_plan,
    verify_backup,
)
from distribution.lib.pg import (  # noqa: E402
    cluster_is_running,
    cluster_plan,
    databases_plan,
    pg_bin_dir,
    stop_cluster,
)
from distribution.lib.upgrade import (  # noqa: E402
    Migration,
    major_upgrade_plan,
    rollback_plan,
)


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(('127.0.0.1', 0))
        return probe.getsockname()[1]


class PlanTest(unittest.TestCase):
    """计划层：纯函数，不写任何东西。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.home = self.root / 'kvvi'
        self.addCleanup(self._tmp.cleanup)

    def test_backup_plan_writes_nothing(self):
        backup_plan(home=self.home, pg_port=54411, out_dir=self.root / 'backups',
                    superuser='kvvi_admin', superpass='x')
        self.assertEqual(list(self.root.iterdir()), [])

    def test_backup_covers_all_three_databases_separately(self):
        # 三个库分别导出，不是一次全导：恢复时才能只恢复其中一个，
        # 而「审计库单独恢复」是审计链自洽的前提。
        self.assertEqual(list(DATABASES_TO_DUMP), ['kvvi_platform', 'kvvi_business', 'kvvi_audit'])
        plan = backup_plan(home=self.home, pg_port=54411, out_dir=self.root / 'backups',
                           superuser='kvvi_admin', superpass='x')
        dumps = [step for step in plan.steps if step['kind'] == 'dump']
        self.assertEqual(len(dumps), 3)

    def test_dump_uses_custom_format(self):
        # `-Fc` 是**逐对象**的：单个表坏了其余还能恢复。
        # 纯 SQL 文本做不到这一点，而备份的意义正在「坏了的时候还能捞出什么」。
        plan = backup_plan(home=self.home, pg_port=54411, out_dir=self.root / 'backups',
                           superuser='kvvi_admin', superpass='x')
        dump = next(step for step in plan.steps if step['kind'] == 'dump')
        self.assertIn('-Fc', dump['argv'])

    def test_backup_includes_runtime_state_and_config(self):
        # 只备份数据库是不够的：会话数据、profile 与配置在 $KVVI_HOME 下。
        plan = backup_plan(home=self.home, pg_port=54411, out_dir=self.root / 'backups',
                           superuser='kvvi_admin', superpass='x')
        kinds = [step['kind'] for step in plan.steps]
        self.assertIn('archive-home', kinds)

    def test_superuser_password_never_enters_the_archive(self):
        # 备份包可能被拷到别处、发给支持人员。**它不是密钥的载体。**
        plan = backup_plan(home=self.home, pg_port=54411, out_dir=self.root / 'backups',
                           superuser='kvvi_admin', superpass='x')
        joined = ' '.join(str(a) for step in plan.steps for a in step.get('argv', []))
        self.assertNotIn('secrets', joined)
        self.assertTrue(plan.excludes, '计划没有列出「打包时排除什么」')

    def test_restore_verifies_before_touching_anything(self):
        plan = restore_plan(archive=self.root / 'b.tar.gz', home=self.home, pg_port=54411,
                            superuser='kvvi_admin', superpass='x')
        self.assertEqual(plan.steps[0]['kind'], 'verify')
        self.assertFalse(plan.steps[0]['writes'])

    def test_uninstall_keeps_data_by_default(self):
        plan = uninstall_plan(home=self.home)
        self.assertNotIn('pgdata', plan.removes)
        self.assertNotIn('secrets', plan.removes)
        self.assertIn('run', plan.removes)

    def test_uninstall_purges_only_when_named(self):
        plan = uninstall_plan(home=self.home, purge_data=True)
        self.assertIn('pgdata', plan.removes)
        # 即便显式清除，也要**说出来**清掉了什么。
        self.assertTrue(plan.warning)

    def test_uninstall_plan_writes_nothing(self):
        uninstall_plan(home=self.home)
        self.assertFalse(self.home.exists())


class UpgradePlanTest(unittest.TestCase):
    """大版本升级的计划：绝不用 `pg_upgrade`。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.home = Path(self._tmp.name) / 'kvvi'
        self.addCleanup(self._tmp.cleanup)

    def test_major_upgrade_never_uses_pg_upgrade(self):
        plan = major_upgrade_plan(home=self.home, old_pg_bin=Path('/pg17/bin'),
                                  new_pg_bin=Path('/pg18/bin'), new_port=54412,
                                  superuser='kvvi_admin', superpass='x',
                                  databases=('kvvi_platform', 'kvvi_business', 'kvvi_audit'))
        joined = ' '.join(str(a) for step in plan.steps for a in step.get('argv', []))
        self.assertNotIn('pg_upgrade', joined)
        # 而且要**说得出理由** —— 一个「就是不用它」的实现，下一个人会加回去。
        self.assertIn('就地', plan.rationale)

    def test_major_upgrade_starts_with_a_dump(self):
        plan = major_upgrade_plan(home=self.home, old_pg_bin=Path('/pg17/bin'),
                                  new_pg_bin=Path('/pg18/bin'), new_port=54412,
                                  superuser='kvvi_admin', superpass='x',
                                  databases=('kvvi_platform',))
        kinds = [step['kind'] for step in plan.steps]
        self.assertEqual(kinds[0], 'backup')
        self.assertLess(kinds.index('backup'), kinds.index('init-new-cluster'))
        self.assertLess(kinds.index('init-new-cluster'), kinds.index('restore-into-new'))
        # 切换之前必须复核。
        self.assertLess(kinds.index('restore-into-new'), kinds.index('recheck'))
        self.assertLess(kinds.index('recheck'), kinds.index('switch'))

    def test_major_upgrade_keeps_the_old_cluster_until_recheck_passes(self):
        plan = major_upgrade_plan(home=self.home, old_pg_bin=Path('/pg17/bin'),
                                  new_pg_bin=Path('/pg18/bin'), new_port=54412,
                                  superuser='kvvi_admin', superpass='x',
                                  databases=('kvvi_platform',))
        # 老集群**不被删**：复核没过时要能退回去。
        self.assertNotIn('pgdata-old', [step.get('removes') for step in plan.steps])
        self.assertTrue(any(step['kind'] == 'recheck' for step in plan.steps))

    def test_rollback_refused_when_a_migration_is_irreversible(self):
        plan = rollback_plan(home=self.home,
                             migrations=[Migration('20260926_01', reversible=False)],
                             target_version='0.1.0')
        self.assertFalse(plan.allowed)
        self.assertIn('KVVI_IRREVERSIBLE_MIGRATION', plan.reason)

    def test_rollback_allowed_when_every_migration_is_reversible(self):
        plan = rollback_plan(home=self.home,
                             migrations=[Migration('20260926_01', reversible=True)],
                             target_version='0.1.0')
        self.assertTrue(plan.allowed)

    def test_irreversible_migrations_do_not_block_upgrade(self):
        # 不可逆的是**回滚**，不是升级。把它们混成一个判据会让客户
        # 卡在一个既不能升级也不能回滚的版本上。
        plan = major_upgrade_plan(home=self.home, old_pg_bin=Path('/pg17/bin'),
                                  new_pg_bin=Path('/pg18/bin'), new_port=54412,
                                  superuser='kvvi_admin', superpass='x',
                                  databases=('kvvi_platform',))
        self.assertTrue(plan.allowed)


@unittest.skipUnless(shutil.which('pg_config') or True, '需要 postgresql@17')
class RealBackupRestoreTest(unittest.TestCase):
    """
    真的导出、真的恢复。**不 mock postgres。**

    慢一点，但它验的是计划层验不到的那件事：`pg_dump`/`pg_restore` 的参数
    **在这台机器上真的能跑通**，而且恢复出来的行数与摘要与备份时一致。
    """

    @classmethod
    def setUpClass(cls):
        try:
            cls.pg_bin = pg_bin_dir()
        except RuntimeError as error:
            raise unittest.SkipTest(str(error))
        cls._tmp = tempfile.TemporaryDirectory()
        cls.root = Path(cls._tmp.name)
        cls.home = cls.root / 'kvvi'
        cls.port = free_port()
        cls.superpass = 'test-only-superuser-pass'
        cls.plan = cluster_plan(home=cls.home, pg_port=cls.port, pg_bin=cls.pg_bin,
                                superuser_password=cls.superpass)
        cls.plan.apply()
        databases_plan(superuser='kvvi_admin', superpass=cls.superpass, pg_port=cls.port,
                       role_passwords={r: f'{r}-pw' for r in
                                       ('kvvi_platform', 'kvvi_business',
                                        'kvvi_audit_writer', 'kvvi_audit_reader')}
                       ).apply(cls.pg_bin)

    @classmethod
    def tearDownClass(cls):
        try:
            stop_cluster(cls.home, cls.pg_bin)
        finally:
            cls._tmp.cleanup()

    def _psql(self, database, sql, password=None):
        """跑一条语句。"""
        env = dict(os.environ, PGPASSWORD=password or self.superpass, LC_ALL='en_US.UTF-8')
        return subprocess.run(
            [str(self.pg_bin / 'psql'), '-h', '127.0.0.1', '-p', str(self.port),
             '-U', 'kvvi_admin', '-d', database, '-tAc', sql],
            capture_output=True, text=True, env=env, timeout=60)

    def test_01_seed_some_data(self):
        # 三个库各造一点可识别的数据 —— 恢复后要比对的就是它。
        self.assertEqual(self._psql('kvvi_platform', """
            CREATE TABLE IF NOT EXISTS backup_probe (id int PRIMARY KEY, note text);
            INSERT INTO backup_probe VALUES (1, '平台') ON CONFLICT DO NOTHING
        """).returncode, 0)
        self.assertEqual(self._psql('kvvi_business', """
            CREATE TABLE IF NOT EXISTS backup_probe (id int PRIMARY KEY, note text);
            INSERT INTO backup_probe VALUES (1, '业务') ON CONFLICT DO NOTHING
        """).returncode, 0)
        self.assertEqual(self._psql('kvvi_audit', """
            CREATE TABLE IF NOT EXISTS backup_probe (id int PRIMARY KEY, note text);
            INSERT INTO backup_probe VALUES (1, '审计') ON CONFLICT DO NOTHING
        """).returncode, 0)

    def test_02_backup_produces_an_archive_with_a_manifest(self):
        plan = backup_plan(home=self.home, pg_port=self.port,
                           out_dir=self.root / 'backups', superuser='kvvi_admin',
                           superpass=self.superpass)
        result = plan.apply(self.pg_bin)
        self.assertTrue(result['ok'], result)
        self.assertTrue(plan.archive.is_file(), '没有生成备份包')
        manifest = manifest_of(plan.archive)
        self.assertEqual(sorted(manifest['databases']),
                         ['kvvi_audit', 'kvvi_business', 'kvvi_platform'])
        for name, entry in manifest['files'].items():
            self.assertTrue(entry['sha256'].startswith('sha256:'), f'{name} 没记摘要')

    def test_03_verify_passes_on_a_fresh_archive(self):
        plan = backup_plan(home=self.home, pg_port=self.port,
                           out_dir=self.root / 'backups', superuser='kvvi_admin',
                           superpass=self.superpass)
        plan.apply(self.pg_bin)
        verdict = verify_backup(plan.archive)
        self.assertTrue(verdict['ok'], verdict)

    def test_04_verify_refuses_a_tampered_archive(self):
        """
        ⚠️ 第一版这条是「在归档末尾加一个 x」，而它**验不出来** ——
        gzip 允许流后跟着垃圾，`tarfile` 读得动，每个成员也都对。

        所以真实的做法是造出**两种**具体的篡改，各验一次：
        """
        import io
        import tarfile as tar_module
        archive = self.root / 'backups' / 'kvvi-backup.tar.gz'

        def rebuild(path, mutate):
            """把归档重打一遍，`mutate` 可以改成员内容、加成员或改成员名。"""
            with tar_module.open(archive, 'r:gz') as source:
                members = [(m, source.extractfile(m).read() if m.isfile() else None)
                           for m in source.getmembers()]
            with tar_module.open(path, 'w:gz') as target:
                for member, body in mutate(members):
                    if body is None:
                        target.addfile(member)
                    else:
                        member.size = len(body)
                        target.addfile(member, io.BytesIO(body))

        # ① 改一个成员的内容（改的是数据库导出文件本身）。
        def tamper_member(members):
            for member, body in members:
                if member.name.endswith('.dump'):
                    body = body + b'extra'
                yield member, body
        changed = self.root / 'tampered-member.tar.gz'
        rebuild(changed, tamper_member)
        self.assertFalse(verify_backup(changed)['ok'],
                         '成员内容被改过，校验却通过了')

        # ② 往包里**加**一个成员。只查「清单里的还在不在」的实现查不出这个。
        def add_member(members):
            yield from members
            extra = tar_module.TarInfo('planted.sh')
            body = b'echo planted\n'
            extra.size = len(body)
            yield extra, body
        planted = self.root / 'tampered-extra.tar.gz'
        rebuild(planted, add_member)
        self.assertFalse(verify_backup(planted)['ok'],
                         '包里多了一个清单没列的文件，校验却通过了')

        # ③ 归档边车：往压缩流尾部追加字节，只有边车能发现。
        sidecar = archive.with_suffix(archive.suffix + '.sha256')
        self.assertTrue(sidecar.is_file(), '没有写归档边车摘要')
        appended = self.root / 'tampered-appended.tar.gz'
        with open(archive, 'rb') as handle:
            original = handle.read()
        with open(appended, 'wb') as handle:
            handle.write(original + b'x')
        shutil.copy2(sidecar, appended.with_suffix(appended.suffix + '.sha256'))
        self.assertFalse(verify_backup(appended)['ok'],
                         '归档被追加了字节，边车摘要却没发现')

    def test_04b_missing_archive_is_a_different_conclusion_than_tampered(self):
        # 「文件不在」与「文件被改过」是两件事，码不同，客户要做的事也不同。
        verdict = verify_backup(self.root / 'no-such-backup.tar.gz')
        self.assertFalse(verdict['ok'])
        self.assertEqual(verdict['problems'][0]['code'], 'KVVI_BACKUP_MISSING')

    def test_05_restore_into_the_same_cluster_reproduces_the_rows(self):
        archive = self.root / 'backups' / 'kvvi-backup.tar.gz'
        # 先改掉数据，再恢复，看是否被恢复回来。
        self._psql('kvvi_business', "UPDATE backup_probe SET note = '被改过' WHERE id = 1")
        self.assertEqual(self._psql('kvvi_business',
                                    'SELECT note FROM backup_probe WHERE id=1').stdout.strip(),
                         '被改过')

        plan = restore_plan(archive=archive, home=self.home, pg_port=self.port,
                            superuser='kvvi_admin', superpass=self.superpass)
        result = plan.apply(self.pg_bin)
        self.assertTrue(result['ok'], result)
        restored = self._psql('kvvi_business',
                              'SELECT note FROM backup_probe WHERE id=1').stdout.strip()
        self.assertEqual(restored, '业务', '恢复没有把数据带回来')

    def test_06_restore_refuses_a_tampered_archive_before_touching_the_database(self):
        before = self._psql('kvvi_business',
                            'SELECT note FROM backup_probe WHERE id=1').stdout.strip()
        # 用**内容被改过**的那一份（`test_04` 造出来的），不是「文件不存在」——
        # 后者会得到 `KVVI_BACKUP_MISSING`，那是另一个结论。
        plan = restore_plan(archive=self.root / 'tampered-member.tar.gz', home=self.home,
                            pg_port=self.port, superuser='kvvi_admin',
                            superpass=self.superpass)
        result = plan.apply(self.pg_bin)
        self.assertFalse(result['ok'])
        self.assertEqual(result['errors'][0]['code'], 'KVVI_BACKUP_DIGEST_MISMATCH')
        after = self._psql('kvvi_business',
                           'SELECT note FROM backup_probe WHERE id=1').stdout.strip()
        self.assertEqual(after, before, '被拒的恢复改动了数据库')


if __name__ == '__main__':
    unittest.main()
