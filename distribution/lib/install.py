#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""首次安装：把一台装好 PostgreSQL 的 Mac 变成一台可用的 KVVI。

## 安装是一条**有序**的事，顺序本身就是内容

第一版把这些写成一个 `install.sh`，每一步都「理所当然」，于是没人能回答
「第 4 步失败时，机器处在什么状态」。这里把顺序显式化：

| # | 步骤 | 为什么必须在这个位置 |
|---|---|---|
| 1 | 环境前置检查 | 只在**读**的前提下判一次；不通过就什么都不做 |
| 2 | 建目录（0700） | 先于集群：socket 目录必须存在 |
| 3 | `initdb` | 先于一切数据库动作 |
| 4 | 起集群 | 先于建库 |
| 5 | 建角色、建库 | 先于迁移 |
| 6 | 跑迁移 | 先于写配置：配置里的 DSN 要对着真实存在的库 |
| 7 | 写配置（0600） | 先于起进程：进程读它 |
| 8 | 起平台与运行时 | 先于 bootstrap |
| 9 | bootstrap（一次性） | 最后：它要求前面全部就绪 |

## 计划与执行分开

`install_plan()` 是**纯函数**：不建目录、不起进程、不写文件。
`InstallPlan.apply()` 才动。§9.2 要求安装前展示「将创建的目录、数据库、角色和端口」，
而一份说不出自己改不改东西的计划没法展示 —— 所以每个步骤都带 `writes`，
且**只读步骤全部排在写步骤之前**（`test_read_only_steps_come_before_writes` 盯着）。

## 口令与密钥

全部 `secrets.token_urlsafe` 本地生成，**不来自任何模板**。库里存的仍是哈希：
`initdb` 的超级用户口令与四个角色口令只在安装期出现，之后写进配置文件（0600）
并交给进程使用；超级用户口令另存一份到 `$KVVI_HOME/secrets/`，
用于备份恢复与未来的升级 —— 那种时候没有它就什么都做不了。
"""

import os
import secrets
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional

from distribution.lib.pg import (
    DATABASES,
    ROLES,
    SUPERUSER,
    ClusterPlan,
    DatabasesPlan,
    cluster_is_running,
    cluster_plan,
    databases_plan,
    pg_bin_dir,
    stop_cluster,
)

#: 发行版默认端口。数据库端口刻意不用 5432：开发机上多半已经有一个 PostgreSQL。
DEFAULT_PG_PORT = 54329
DEFAULT_PLATFORM_PORT = 7400

#: 数据根目录。放在 Library 下，随卸载保留（§9.5 硬性验收第 6 条）。
DEFAULT_HOME = '~/Library/Application Support/KVVI-Agent'

#: 配置文件与密钥的相对位置。
CONFIG_REL = 'kvvi.env'
SECRETS_REL = 'secrets'


def release_root_path() -> Path:
    """
    发行版根目录（`distribution/` 的上一级）。

    ⚠️ **只有这一处算它。** 第一版在 `kvvi-admin` 里另算了一遍
    （`Path(__file__).parent.parent`），那算出来是 `distribution/` 而不是根 ——
    于是 supervisor 拿它去拼 `distribution/services/platform/src/server.mjs`，
    两个进程都报 MODULE_NOT_FOUND。**路径算两遍，就会算错一遍。**
    @returns 发行版根目录
    """
    return Path(__file__).resolve().parents[2]


def new_secrets() -> Dict[str, str]:
    """
    生成一套全新的口令/密钥。**每次调用都是新的** —— 没有任何模板值。
    @returns 名字 → 值
    """
    return {
        'pgSuperuser': secrets.token_urlsafe(24),
        'kvvi_platform': secrets.token_urlsafe(24),
        'kvvi_business': secrets.token_urlsafe(24),
        'kvvi_audit_writer': secrets.token_urlsafe(24),
        'kvvi_audit_reader': secrets.token_urlsafe(24),
        'internalToken': secrets.token_urlsafe(32),
        # 签名密钥**必须由 Node 用 ed25519 生成**，格式是
        # `{kid, privateKey(PEM), publicKey(PEM), previous: []}`。
        # 第一版这里写的是 `token_urlsafe(48)` —— 一个随机字符串。
        # 后果不是「签名不生效」，是**平台在第一次登录时整个进程崩掉**
        # （`JSON.parse` 一个不是 JSON 的文件），而 healthz 在此之前一直说
        # `signingKeyMounted: true`（它只看文件在不在）。
        # 所以这一项不在 Python 侧生成，见 `_write_signing_key()`。
        # 一次性首次初始化令牌。**必须生成** —— `bootstrapOwner` 在令牌为空时
        # 一律拒绝（那是有意的：没配等于不校验在生产里就是没有门）。
        # 第一版没生成它，于是装完之后第一次初始化永远 401，
        # 而客户手里没有任何东西能填进那个框。
        'bootstrapToken': secrets.token_urlsafe(32),
    }


def dsn_for(role: str, password: str, database: str, pg_port: int) -> str:
    """
    拼一条 DSN。
    @param role 角色名
    @param password 该角色口令
    @param database 目标库
    @param pg_port 集群端口
    @returns `postgres://` 连接串
    """
    return f'postgres://{role}:{password}@127.0.0.1:{pg_port}/{database}'


@dataclass
class InstallPlan:
    """一次首次安装的完整计划。"""
    home: Path
    release_root: Path
    pg_port: int
    platform_port: int
    pg_bin: Path
    secrets: Dict[str, str]
    cluster: ClusterPlan
    databases: DatabasesPlan
    steps: List[dict] = field(default_factory=list)
    runtime_port: int = 7401

    @property
    def config_path(self) -> Path:
        return self.home / CONFIG_REL

    @property
    def secrets_dir(self) -> Path:
        return self.home / SECRETS_REL

    def read_only_steps(self) -> List[dict]:
        """不改动任何东西的步骤。安装前的展示与 `--plan` 只跑这些。"""
        return [s for s in self.steps if not s['writes']]

    def describe(self) -> str:
        """
        给客户看的计划（§9.2 要求安装前展示）。
        @returns 多行文本
        """
        lines = ['将创建：', '', '  ' + self.cluster.describe().replace('\n', '\n  '), '']
        lines.append('  数据库与角色：')
        for database in DATABASES:
            lines.append(f"    {database['name']}  ← {', '.join(database['roles'])}"
                         f"    （{database['purpose']}）")
        lines += ['', f'  配置       {self.config_path}（0600）',
                  f'  密钥       {self.secrets_dir}（0600）',
                  f'  平台端口   {self.platform_port}',
                  f'  运行时端口 {self.runtime_port}',
                  f'  初始化令牌 {self.secrets_dir / "bootstrap.token"}（0600）'
                  f'　← 首次打开界面时要填它',
                  '', '不会碰到：',
                  '  客户已有的 PostgreSQL 集群（含 Homebrew 自己建的那个）',
                  '  客户已有的任何数据库、角色或数据',
                  '', '全部口令在**本机**随机生成，不来自任何模板。']
        return '\n'.join(lines)

    def apply(self) -> dict:
        """
        执行安装。
        @returns `{ok, steps, errors}`
        """
        done: List[str] = []
        errors: List[dict] = []

        for step in (s for s in self.steps if not s['writes']):
            done.append(step['kind'] + ': 只读，跳过')

        self.home.mkdir(parents=True, exist_ok=True)
        os.chmod(self.home, 0o700)
        done.append('create-home')

        cluster_result = self.cluster.apply()
        done.extend(cluster_result['steps'])
        if not cluster_result['ok']:
            return {'ok': False, 'steps': done, 'errors': cluster_result['errors']}

        databases_result = self.databases.apply(self.pg_bin)
        done.extend(databases_result['steps'])
        if not databases_result['ok']:
            return {'ok': False, 'steps': done, 'errors': databases_result['errors']}

        migrate = self._migrate()
        if not migrate['ok']:
            return {'ok': False, 'steps': done, 'errors': migrate['errors']}
        done.append('migrate')

        self._write_config()
        done.append('write-config')
        return {'ok': True, 'steps': done, 'errors': errors,
                'bootstrapTokenPath': str(self.secrets_dir / 'bootstrap.token')}

    def migrate_env(self) -> Dict[str, str]:
        """
        迁移要用的一组环境变量。
        @returns 环境变量字典
        """
        secrets_map = self.secrets
        return {
            'KVVI_ADMIN_DSN': dsn_for(SUPERUSER, secrets_map['pgSuperuser'], 'postgres', self.pg_port),
            'KVVI_PLATFORM_DSN': dsn_for('kvvi_platform', secrets_map['kvvi_platform'],
                                         'kvvi_platform', self.pg_port),
            'KVVI_BUSINESS_DSN': dsn_for('kvvi_business', secrets_map['kvvi_business'],
                                         'kvvi_business', self.pg_port),
            'KVVI_AUDIT_DSN': dsn_for('kvvi_audit_writer', secrets_map['kvvi_audit_writer'],
                                      'kvvi_audit', self.pg_port),
            'KVVI_AUDITREAD_DSN': dsn_for('kvvi_audit_reader', secrets_map['kvvi_audit_reader'],
                                          'kvvi_audit', self.pg_port),
            'KVVI_DB_PASSWORD': secrets_map['kvvi_platform'],
            'KVVI_BUSINESS_DB_PASSWORD': secrets_map['kvvi_business'],
            'KVVI_AUDIT_WRITER_PASSWORD': secrets_map['kvvi_audit_writer'],
            'KVVI_AUDIT_READER_PASSWORD': secrets_map['kvvi_audit_reader'],
        }

    def _write_signing_key(self) -> None:
        """
        生成签名密钥对。

        ⚠️ **用 Node 生成，不在 Python 里造。** 格式（`{kid, privateKey, publicKey,
        previous}`，PEM）由 `services/platform/src/signing.mjs` 定义，
        在这里照抄一遍就是第二份定义 —— 而它漂移的表现是整个平台崩在第一次登录上。
        所以直接**调用那个模块自己的生成路径**（`KVVI_DEV_KEYS=1` 下它会写盘）。
        @throws RuntimeError 生成失败时，错误信息里带 Node stderr
        """
        import subprocess
        key_path = self.secrets_dir / 'signing.key'
        if key_path.is_file():
            return
        module_url = (self.release_root / 'services' / 'platform' / 'src'
                      / 'signing.mjs').as_uri()
        # `KVVI_DEV_KEYS=1` 是它自己的「可以落盘生成一把」开关。
        # 生产环境那个开关必须是关的（`loadKeys` 会因此拒绝启动）——
        # 所以它**只在安装期**被设上，不进配置文件、不进进程环境。
        result = subprocess.run(['node', '--input-type=module', '--eval',
                                 "process.env.KVVI_SIGNING_KEY_PATH=process.argv[1];"
                                 "process.env.KVVI_DEV_KEYS='1';"
                                 "const m=await import(process.argv[2]);m.loadKeys();",
                                 str(key_path), module_url],
                                capture_output=True, text=True, timeout=120)
        if result.returncode != 0 or not key_path.is_file():
            raise RuntimeError('KVVI_SIGNING_KEY_GENERATION_FAILED: '
                               + (result.stderr.strip()[:300] or '未生成'))
        os.chmod(key_path, 0o600)

    def _migrate(self) -> dict:
        """跑 `services/platform/src/migrate.mjs`。**平台侧一行都不用改。**"""
        import subprocess
        env = dict(os.environ)
        env.update(self.migrate_env())
        env['LC_ALL'] = 'en_US.UTF-8'
        script = self.release_root / 'services' / 'platform' / 'src' / 'migrate.mjs'
        result = subprocess.run(['node', str(script)], capture_output=True, text=True,
                                env=env, timeout=900)
        if result.returncode != 0:
            return {'ok': False, 'errors': [{'kind': 'migrate',
                                             'stderr': result.stderr.strip()[:800]}]}
        return {'ok': True, 'errors': []}

    def _write_config(self) -> None:
        """写配置文件（0600）与密钥目录（0700）。"""
        self.secrets_dir.mkdir(parents=True, exist_ok=True)
        os.chmod(self.secrets_dir, 0o700)
        lines = [
            '# KVVI-Agent 实例配置。**含口令，勿提交、勿拷贝。**',
            '# 由 kvvi-admin install 生成；重建实例请重新安装而不是编辑它。',
            '',
            f'KVVI_HOME={self.home}',
            f'KVVI_PG_PORT={self.pg_port}',
            f'KVVI_PLATFORM_PORT={self.platform_port}',
            f'KVVI_RUNTIME_PORT={self.runtime_port}',
            f'KVVI_INTERNAL_TOKEN={self.secrets["internalToken"]}',
            # 签名私钥**不进发行包**（§9.4.1），本机安装时生成一份。
            # 不给这一行，平台会去找默认的 /run/kvvi-secrets/signing.key ——
            # 那是容器部署的挂载点，本机上不存在，而 healthz 只会说
            # signingKeyMounted:false，看不出该在哪里生成。
            f'KVVI_SIGNING_KEY_PATH={self.secrets_dir / "signing.key"}',
            f'KVVI_BOOTSTRAP_TOKEN={self.secrets["bootstrapToken"]}',
            '',
        ]
        lines += [f'{key}={value}' for key, value in sorted(self.migrate_env().items())]
        self.config_path.write_text('\n'.join(lines) + '\n')
        os.chmod(self.config_path, 0o600)
        # 超级用户口令另存：备份恢复与大版本升级都要用它，而那些时候
        # 配置文件（面向服务进程）里不该有它。
        superuser_file = self.secrets_dir / 'postgres-superuser.password'
        superuser_file.write_text(self.secrets['pgSuperuser'] + '\n')
        os.chmod(superuser_file, 0o600)
        self._write_signing_key()
        # 初始化令牌另存一份**单独的**文件：它要在第一次初始化时被读出来粘进界面，
        # 而 kvvi.env 面向的是服务进程、客户不该去翻它（里面的口令比它更敏感）。
        bootstrap_token = self.secrets_dir / 'bootstrap.token'
        bootstrap_token.write_text(self.secrets['bootstrapToken'] + '\n')
        os.chmod(bootstrap_token, 0o600)


def install_plan(home: str, pg_port: int = DEFAULT_PG_PORT,
                 platform_port: int = DEFAULT_PLATFORM_PORT,
                 pg_bin: Optional[Path] = None,
                 release_root: Optional[Path] = None,
                 secrets_map: Optional[Dict[str, str]] = None,
                 runtime_port: int = 7401) -> InstallPlan:
    """
    组一次首次安装的计划。**纯函数**：不建目录、不起进程、不写文件。
    @param home `$KVVI_HOME`
    @param pg_port 集群端口
    @param platform_port 平台服务端口
    @param pg_bin PostgreSQL 二进制目录；缺省自动查找
    @param release_root 发行版根目录
    @param secrets_map 预先给好的口令（测试用）；缺省随机生成
    @returns 计划
    """
    home_path = Path(home)
    resolved_bin = Path(pg_bin) if pg_bin is not None else pg_bin_dir()
    root = Path(release_root) if release_root is not None else release_root_path()
    secrets_map = dict(secrets_map) if secrets_map is not None else new_secrets()

    cluster = cluster_plan(home=home_path, pg_port=pg_port, pg_bin=resolved_bin,
                           superuser_password=secrets_map['pgSuperuser'])
    databases = databases_plan(
        superuser=SUPERUSER, superpass=secrets_map['pgSuperuser'], pg_port=pg_port,
        role_passwords={role: secrets_map[role] for role in ROLES})

    # 只读步骤：`--plan` 只跑这些，客户在**没有任何东西被改动**的前提下读它。
    read_only = [
        {'kind': 'verify-release', 'writes': False,
         'argv': ['test', '-f', str(root / 'services' / 'platform' / 'src' / 'migrate.mjs')]},
        {'kind': 'verify-binaries', 'writes': False,
         'argv': [str(resolved_bin / 'initdb'), '--version']},
        {'kind': 'verify-ports', 'writes': False, 'argv': []},
    ]
    writes = [
        {'kind': 'create-home', 'writes': True, 'argv': []},
        {'kind': 'cluster', 'writes': True, 'argv': []},
        {'kind': 'databases', 'writes': True, 'argv': []},
        {'kind': 'migrate', 'writes': True, 'argv': []},
        {'kind': 'write-config', 'writes': True, 'argv': []},
    ]
    return InstallPlan(home=home_path, release_root=root, pg_port=pg_port,
                       platform_port=platform_port, runtime_port=runtime_port, pg_bin=resolved_bin,
                       secrets=secrets_map, cluster=cluster, databases=databases,
                       steps=read_only + writes)
