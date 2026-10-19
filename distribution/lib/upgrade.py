#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""升级与回滚。

## 两条完全不同的路，永远不要合并

| | 数据库大版本升级 | 应用版本升级/回滚 |
|---|---|---|
| 做的是 | 把数据搬到**另一个** PostgreSQL 集群 | 换发行版目录、按账本跑迁移 |
| 失败代价 | **很可能同时损坏唯一一份数据** | 换回上一个目录 |
| 判据 | 复核通过才切换 | 每个迁移是否可逆 |

把它们混成一个 `upgrade` 命令，就会出现「升个版本结果数据库没了」。

## 大版本升级绝不用 `pg_upgrade`

`pg_upgrade` 是**就地**的：它在原数据目录上操作。客户那台机器上通常只有
**一份**数据；就地升级失败时，PostgreSQL 自己的建议是「从你的备份恢复」——
而如果没有备份，就没有退路。

所以走**导出 → 新集群 → 导入 → 复核 → 切换**：老集群在复核通过之前**一直保留**，
失败时退回去即可，代价只是一次多余拷贝。

## 不可逆的迁移阻止**回滚**，不阻止升级

两件事，别混。把它们合成一个判据，客户会卡在一个既不能升也不能退的版本上。
"""

from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional, Sequence

#: 新集群的数据目录名。老的一直保留到复核通过。
NEW_DATA_DIR = 'pgdata-next'

#: 复核要看的项。**每一项都对应一次真实的迁移事故。**
RECHECK_ITEMS = (
    ('row-counts', '每个库、每张表的数据行数与导出时一致'),
    ('audit-chain', '审计链自洽（逐条 hash 可重算）'),
    ('contract-digests', '已发布契约的内容指纹与发布记录一致'),
    ('accounts', '账号、成员关系与角色数量一致'),
)


@dataclass(frozen=True)
class Migration:
    """一条迁移记录。"""
    name: str
    reversible: bool
    note: Optional[str] = None


@dataclass
class MajorUpgradePlan:
    """PostgreSQL 大版本升级的计划。"""
    home: Path
    old_pg_bin: Path
    new_pg_bin: Path
    new_port: int
    superuser: str
    superpass: str
    databases: Sequence[str]
    rationale: str
    steps: List[dict] = field(default_factory=list)
    allowed: bool = True

    def describe(self) -> str:
        """给人看的计划。"""
        lines = [
            f'数据库大版本升级：{self.old_pg_bin.parent.parent.name} → '
            f'{self.new_pg_bin.parent.parent.name}',
            '',
            '步骤：',
            '  1. 先做一次完整备份（走 backup.py，含逐文件摘要）',
            '  2. 在新版本上建**另一个**集群（不碰原数据目录）',
            '  3. 把数据导进新集群',
            '  4. 复核：' + '；'.join(f'{name}' for name, _ in RECHECK_ITEMS),
            '  5. 复核通过才切换；不通过就退回老集群',
            '',
            f'⚠️ 不用 `pg_upgrade`：{self.rationale}',
            '',
            '老集群在切换之前**一直保留**。它占用额外磁盘，那是这次升级的代价。',
        ]
        return '\n'.join(lines)

    def apply(self) -> dict:
        """
        执行。步骤实现见阶段十一后续任务；此处只保证计划本身可判定。
        @returns `{ok, steps, errors}`
        """
        return {'ok': False, 'steps': [], 'errors': [{
            'code': 'KVVI_UPGRADE_EXECUTOR_UNAVAILABLE',
            'detail': '尚无已验证的数据库大版本迁移执行器；没有修改数据库或切换实例。'}]}


def major_upgrade_plan(home: Path, old_pg_bin: Path, new_pg_bin: Path, new_port: int,
                       superuser: str, superpass: str,
                       databases: Sequence[str]) -> MajorUpgradePlan:
    """
    组一个数据库大版本升级的计划。**纯函数**。
    @returns 计划
    """
    rationale = ('`pg_upgrade` 是**就地**的，失败会同时损坏唯一一份数据目录；'
                 '客户那台机器上通常没有第二份。导出到新集群失败时，老集群还是好的。')
    steps = [
        {'kind': 'backup', 'writes': True,
         'why': '任何升级的第一步都是备份 —— 这是唯一能为「复核失败」兜底的东西'},
        {'kind': 'init-new-cluster', 'writes': True,
         'dataDir': str(Path(home) / NEW_DATA_DIR),
         'why': '新版集群建在另一个目录，原数据目录一动不动'},
        {'kind': 'restore-into-new', 'writes': True,
         'why': '导的是刚备份的那一份，不是「再读一次线上库」——后者会在升级过程中变'},
        {'kind': 'recheck', 'writes': False, 'items': [name for name, _ in RECHECK_ITEMS],
         'why': '复核不通过就不切换，这是这次升级唯一的判据'},
        {'kind': 'switch', 'writes': True,
         'why': '只有复核通过才切；切换之后老集群仍保留，供回退'},
    ]
    return MajorUpgradePlan(home=Path(home), old_pg_bin=Path(old_pg_bin),
                            new_pg_bin=Path(new_pg_bin), new_port=new_port,
                            superuser=superuser, superpass=superpass,
                            databases=tuple(databases), rationale=rationale, steps=steps)


@dataclass
class RollbackPlan:
    """应用版本回滚的计划。"""
    home: Path
    target_version: str
    migrations: Sequence[Migration]
    allowed: bool
    reason: Optional[str] = None

    @property
    def irreversible(self) -> List[Migration]:
        """不可逆的那些迁移。"""
        return [m for m in self.migrations if not m.reversible]

    def describe(self) -> str:
        """给人看的计划。"""
        if not self.allowed:
            names = '、'.join(m.name for m in self.irreversible)
            return ('\n'.join([
                f'**不能回滚到 {self.target_version}。**',
                '',
                f'  原因：{self.reason}',
                f'  涉及的迁移：{names}',
                '',
                '  「回滚」是把程序换回旧版本，但数据已经按新结构写过了。',
                '  换回去之后旧程序读不懂那些数据 —— 那比不回滚更坏。',
                '',
                '  仍可用的路：继续向前修，或从备份恢复（`kvvi-admin restore`）。',
            ]))
        return f'可以回滚到 {self.target_version}。全部迁移均可逆。'


def rollback_plan(home: Path, migrations: Sequence[Migration],
                  target_version: str) -> RollbackPlan:
    """
    组一个应用版本回滚的计划。**纯函数**。
    @param home `$KVVI_HOME`
    @param migrations 已应用过的迁移
    @param target_version 要回到的版本
    @returns 计划；`allowed` 为假时理由是稳定的错误码
    """
    irreversible = [m for m in migrations if not m.reversible]
    if irreversible:
        return RollbackPlan(home=Path(home), target_version=target_version,
                            migrations=tuple(migrations), allowed=False,
                            reason='KVVI_IRREVERSIBLE_MIGRATION')
    return RollbackPlan(home=Path(home), target_version=target_version,
                        migrations=tuple(migrations), allowed=True)


def migrations_from_ledger(rows: Sequence[dict]) -> List[Migration]:
    """
    把账本行折成迁移记录。
    @param rows `schema_migrations` 的行
    @returns 迁移记录
    """
    return [Migration(name=row['file'],
                      # 缺省**保守判为不可逆**：把一个真的不可逆迁移当成可逆，
                      # 代价是回滚之后数据读不出来；反过来只是多拦一次。
                      reversible=bool(row.get('reversible', False)))
            for row in rows]
