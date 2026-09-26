#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""KVVI 自己的 PostgreSQL 集群。

## 为什么是「自己的集群」而不是「用 brew 那个」

Homebrew 装 `postgresql@17` 时会**顺手建一个集群**（`/opt/homebrew/var/postgresql@17`），
而且 `pg_hba.conf` 里本地与 127.0.0.1 一律是 **`trust`** —— 任何本机进程都能以超级用户
连上去，不要口令。那不是 Homebrew 的疏忽，是它给开发者单机环境定的默认。

KVVI 不碰那个集群，原因有两条，都不是洁癖：

1. **不能污染客户的库。** brew 那个集群里可能已经有客户自己的数据库；我们的迁移脚本
   一旦连上去，`provision()` 会建角色、建库、改权限。
2. **那个集群的认证方式不可接受。** `trust` + world-accessible socket 目录，
   等于本机上任何进程都能读写全部数据。KVVI 自己 `initdb`，用 `scram-sha-256` 走 TCP，
   socket 放在 `$KVVI_HOME/run`（**0700**）。

## macOS 专有的坑（探路时真撞到的）

| 坑 | 现象 | 处理 |
|---|---|---|
| socket 目录不存在 | `could not create lock file ...: No such file or directory` —— 读起来像权限问题 | 启动**前** `mkdir`，并且 `chmod 700` |
| 未设 `LC_ALL` | `FATAL: postmaster became multithreaded during startup` —— 报错里没提 locale | 启动时注入 `LC_ALL` |
| 路径含空格 | `postgres: invalid argument: "Support/…/run"` —— 报错里看不见那个空格 | **不把启动参数塞进 `pg_ctl -o`**，改写进 `postgresql.conf` |

## 为什么端口、监听地址和 socket 目录必须写进 `postgresql.conf`

第一版把三样都塞在 `pg_ctl -o '-p … -c listen_addresses=… -c unix_socket_directories=…'`
这一个字符串里。它在 `/tmp/kvvi-…` 这种无空格的验收目录下**一路绿灯**，于是问题
被留到了客户机器上——而 macOS 的默认数据目录是
`~/Library/Application Support/KVVI-Agent/…`，**含一个空格**：`pg_ctl` 按空白切分
`-o` 的实参，`postgres` 收到的是 `Support/KVVI-Agent/…/run`，报
`invalid argument` 然后拒绝启动。安装**卡在第 4 步**，界面永远起不来。

修的时候顺带看到一个更要紧的后果：只写在 `-o` 里意味着这三样**不是集群的属性，
而是那一条命令的属性**。任何不经过这条命令的启动（人工 `pg_ctl start -D pgdata`、
将来的 launchd 单元、崩溃后的手工拉起）都会**静默退回**
`/tmp` socket + `port 5432` + `listen_addresses='localhost'`，而 `initdb` 设的是
`--auth-local=trust` —— 也就是本机任一进程都能免密以超级用户连上 KVVI 的库。
写进配置文件之后，「这个集群监听哪里、socket 在哪」只有一处答案。

写进去的值带单引号（`unix_socket_directories = '/路径 含空格/run'`）：
配置文件的值由 postgres 自己的词法器读，**支持带引号的字符串**，
而 `-o` 那条路不支持。

## 不解析 postgres 的报错文字

服务端消息的语言由 `initdb --locale` 定下，**客户端设 `LC_MESSAGES=C` 只翻译得了
`psql:` 开头的那半句**，`致命错误:` 之后仍是服务端的语言（本机是中文）。
所以任何「报错里包含某串」的判定都会在别的 locale 上失效。

要判「有没有权限」就问目录：`has_database_privilege(...)`、
`pg_roles.rolsuper`、`pg_database.datname`。**断言事实，不要断言措辞。**

## 必须跑在 macOS 自带的 Python 3.9 上

客户机器上不一定装了别的 Python，而 macOS 的 Command Line Tools 自带 3.9。
所以这个包**不能**用 3.10+ 的语法：没有 `match`，没有 `X | None`，
f-string 里也不能嵌套同类引号（3.12 才允许，3.9 会报 `unmatched '['`）。
第一版就在 `\gexec` 那一段踩了最后一条 —— 在本机 `python3`（3.9.6）下直接语法错误。

## 计划的形状

每一步是一个 dict：`{kind, argv, writes, env?, ...}`。**`writes` 是必填的** ——
安装前要展示「将创建什么」（§9.2），而一份说不出自己改不改东西的计划没法展示。
只读步骤排在所有写步骤之前，`install_plan` 的顺序测试盯着这一点。
"""

import getpass
import os
import secrets
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Sequence

#: 支持的 PostgreSQL 大版本。与 `preflight.KVVI_PG_MAJOR` 同源，改一处要改两处 ——
#: 之所以不 import，是因为 `preflight` 面向客户环境、`pg` 面向已就绪的二进制，
#: 两个模块各自可以被单独测试。
KVVI_PG_MAJOR = 17
PG_FORMULA = f'postgresql@{KVVI_PG_MAJOR}'

#: 集群超级用户。**只给安装与迁移用**；平台服务进程用四个受限角色。
SUPERUSER = 'kvvi_admin'

#: 三个数据库与四个角色。名字必须与 `services/platform/sql/` 和 `db.mjs` 的期望一致 ——
#: 对不上的表现是迁移报「role does not exist」，看不出是这里写错了。
DATABASES = (
    {'name': 'kvvi_platform', 'roles': ['kvvi_platform'],
     'purpose': '身份、授权、契约、发布、会话'},
    {'name': 'kvvi_business', 'roles': ['kvvi_business'],
     'purpose': '业务记录（RLS 强制租户与行范围）'},
    {'name': 'kvvi_audit', 'roles': ['kvvi_audit_writer', 'kvvi_audit_reader'],
     'purpose': '审计链（只能经 audit_append 写入）'},
)
ROLES = ('kvvi_platform', 'kvvi_business', 'kvvi_audit_writer', 'kvvi_audit_reader')

#: 已知的安装位置。Apple Silicon 与 Intel 各一条。
PG_BIN_CANDIDATES = (
    Path(f'/opt/homebrew/opt/{PG_FORMULA}/bin'),
    Path(f'/usr/local/opt/{PG_FORMULA}/bin'),
)


def pg_bin_dir(explicit: Optional[Path] = None) -> Path:
    """
    找到可用的 PostgreSQL 二进制目录。
    @param explicit 显式指定（测试与自定义安装用）
    @returns 含 `initdb` / `pg_ctl` / `psql` 的目录
    @throws RuntimeError 找不到时，错误信息里带安装命令
    """
    candidates = ([Path(explicit)] if explicit is not None else []) + list(PG_BIN_CANDIDATES)
    for candidate in candidates:
        if (candidate / 'initdb').is_file():
            return candidate
    raise RuntimeError(
        f'找不到 PostgreSQL {KVVI_PG_MAJOR} 的二进制（找过 '
        f'{", ".join(str(c) for c in candidates)}）。安装：brew install {PG_FORMULA}')


def _run(argv: Sequence[str], env: Optional[Dict[str, str]] = None,
         timeout: int = 120) -> subprocess.CompletedProcess:
    return subprocess.run([str(a) for a in argv], capture_output=True, text=True,
                          env=env, timeout=timeout)


#: 写进 `postgresql.conf` 的那一段的首尾标记。
#: 用标记圈起来是为了**可重写**：安装会重跑（文档承诺幂等），
#: 每次都先删掉旧的一段再追加，否则重跑十次就有十份 `port = …`，
#: 而 postgres 取最后一份 —— 表面上「改过了」，实际生效的是最早那次的值。
CLUSTER_CONF_BEGIN = '# >>> KVVI-Agent 写入的开始'
CLUSTER_CONF_END = '# <<< KVVI-Agent 写入的结束'


def cluster_conf_block(pg_port: int, socket_dir: Path) -> str:
    """
    要追加到 `postgresql.conf` 的一段。**纯函数**。

    @param pg_port 集群端口
    @param socket_dir socket 目录（可能含空格，所以带引号）
    @returns 含首尾标记的文本块
    """
    return '\n'.join([
        CLUSTER_CONF_BEGIN + '（勿手改：重装会覆盖这一段）',
        '# 端口、监听地址与 socket 目录写在**集群配置**里，不写在 `pg_ctl -o` 里。',
        '# `-o` 的实参由 pg_ctl 按空白切分，而默认数据目录里有一个空格'
        '（Application Support），',
        '# 会被切碎；更要紧的是，只写在 `-o` 里的话，不经过那条命令的启动'
        '（人工拉起、launchd）',
        '# 会静默退回 /tmp socket + 5432，而本地认证是 trust。',
        f'port = {pg_port}',
        "listen_addresses = '127.0.0.1'",
        "unix_socket_directories = '" + str(socket_dir) + "'",
        CLUSTER_CONF_END,
        '',
    ])


def write_cluster_config(conf_path: Path, pg_port: int, socket_dir: Path) -> str:
    """
    把上面那一段写进 `postgresql.conf`（先删旧块，再追加）。**幂等**。

    @param conf_path `postgresql.conf` 的路径
    @param pg_port 集群端口
    @param socket_dir socket 目录
    @returns 写进去的文本块
    """
    block = cluster_conf_block(pg_port, socket_dir)
    existing = conf_path.read_text(encoding='utf-8') if conf_path.is_file() else ''
    if CLUSTER_CONF_BEGIN in existing and CLUSTER_CONF_END in existing:
        head = existing.split(CLUSTER_CONF_BEGIN)[0]
        tail = existing.split(CLUSTER_CONF_END, 1)[1]
        # 旧块前后各有自己的换行，去掉首尾多余空行后再拼，避免重跑一次多一行。
        existing = head.rstrip('\n') + '\n' + tail.lstrip('\n')
    if existing and not existing.endswith('\n'):
        existing += '\n'
    conf_path.write_text(existing + block, encoding='utf-8')
    return block


@dataclass
class ClusterPlan:
    """拉起一个集群的完整计划。"""
    home: Path
    data_dir: Path
    socket_dir: Path
    pg_port: int
    pg_bin: Path
    log_file: Path
    password_file: Path
    superuser_password: str
    steps: List[dict] = field(default_factory=list)

    def commands_flat(self) -> List[str]:
        """全部命令拼平，便于断言「没有指向别处的集群」。

        写进 `postgresql.conf` 的那一段也算在内 —— 它是**会生效的配置**，
        不像 `argv` 那样只影响一次调用。漏掉它，「只监听回环」这类断言
        就只检查了半句话。
        """
        out: List[str] = []
        for step in self.steps:
            out.extend(str(a) for a in step.get('argv', []))
            if step.get('content'):
                out.append(str(step['content']))
            out.extend(f'{k}={v}' for k, v in (step.get('env') or {}).items())
        return out

    def describe(self) -> str:
        """给人看的一行段说明（安装前展示用）。"""
        lines = [f'数据目录   {self.data_dir}',
                 f'socket 目录 {self.socket_dir}（0700，只有本机当前用户能连）',
                 f'端口       {self.pg_port}（只监听 127.0.0.1）',
                 f'日志       {self.log_file}']
        return '\n'.join(lines)

    def apply(self) -> dict:
        """
        执行计划。**幂等**：集群已存在时不重建。
        @returns `{ok, steps: [...], errors: [...]}`
        """
        done: List[str] = []
        for step in self.steps:
            kind = step['kind']
            if kind == 'initdb' and (self.data_dir / 'PG_VERSION').is_file():
                done.append('initdb: 已存在，跳过')
                continue
            if kind == 'start-server' and cluster_is_running(self.home, self.pg_bin):
                done.append('start-server: 已在运行，跳过')
                continue
            if kind == 'mkdir-socket-dir':
                # 一并把日志目录建出来：`pg_ctl -l` 不会替我们建，而它失败时
                # 报的是「could not open log file」，同样像权限问题。
                self.socket_dir.mkdir(parents=True, exist_ok=True)
                os.chmod(self.socket_dir, 0o700)
                self.log_file.parent.mkdir(parents=True, exist_ok=True)
                done.append('mkdir-socket-dir')
                continue
            if kind == 'write-cluster-config':
                # ⚠️ **即使 initdb 被跳过也要写。** 集群已存在但配置段缺失，
                #    正是「上一版装的机器」的样子 —— 而它下一次启动就会退回 /tmp。
                #    这一段是幂等重写，跑多少次结果一样。
                write_cluster_config(self.data_dir / 'postgresql.conf',
                                     self.pg_port, self.socket_dir)
                done.append('write-cluster-config')
                continue
            if kind == 'initdb':
                self.home.mkdir(parents=True, exist_ok=True)
                self.password_file.write_text(self.superuser_password)
                os.chmod(self.password_file, 0o600)
            result = _run(step['argv'], env=step.get('env'))
            if result.returncode != 0:
                return {'ok': False, 'steps': done,
                        'errors': [{'kind': kind, 'stderr': result.stderr.strip()[:500],
                                    'stdout': result.stdout.strip()[:500]}]}
            done.append(kind)
        # 口令文件用完即删：它只服务于 initdb，留在盘上就是一份明文超级用户口令。
        if self.password_file.exists():
            self.password_file.unlink()
        return {'ok': True, 'steps': done, 'errors': []}


def cluster_start_step(home: Path, pg_bin: Path) -> dict:
    """
    起集群的那一步：`{kind, argv, env}`。**只有这一处定义。**

    `cluster_plan()` 与 `supervisor.start_plan()` 都用它 —— 起集群的命令写在两处，
    就是「两处会漂移」的老问题：其中一处漏了 `LC_ALL` 的那种漂移，
    症状是「按提示手动起一下」这句建议**本身跑不起来**。

    ⚠️ `LC_ALL` 必须给。macOS 上不给会得到
    `FATAL: postmaster became multithreaded during startup`，
    而报错里除了那行 HINT 一个字都没提 locale。

    @param home `$KVVI_HOME`
    @param pg_bin PostgreSQL 二进制目录
    @returns 一个可执行的步骤（含 `argv` 与 `env`）
    """
    home = Path(home)
    pg_bin = Path(pg_bin)
    return {
        'kind': 'start-cluster',
        'argv': [str(pg_bin / 'pg_ctl'), '-D', str(home / 'pgdata'),
                 '-l', str(home / 'log' / 'postgres.log'), '-w', '-t', '60', 'start'],
        'env': dict(os.environ, LC_ALL='en_US.UTF-8'),
    }


def cluster_plan(home: Path, pg_port: int, pg_bin: Path,
                 superuser_password: Optional[str] = None) -> ClusterPlan:
    """
    组一个集群拉起计划。**纯函数**：不建目录、不起进程、不写文件。
    @param home `$KVVI_HOME`
    @param pg_port 集群监听的端口
    @param pg_bin PostgreSQL 二进制目录
    @param superuser_password 超级用户口令；缺省随机生成
    @returns 计划
    """
    home = Path(home)
    pg_bin = Path(pg_bin)
    password = superuser_password or secrets.token_urlsafe(24)
    data_dir = home / 'pgdata'
    socket_dir = home / 'run'
    log_file = home / 'log' / 'postgres.log'
    password_file = home / 'initdb.pw'

    initdb_argv = [
        str(pg_bin / 'initdb'), '-D', str(data_dir), '-U', SUPERUSER,
        f'--pwfile={password_file}',
        # 本地 socket 用 trust：它的目录是 0700 且只在 $KVVI_HOME 下，
        # 所以「谁能连」由**目录权限**回答，而不是由 postgres 再问一次口令。
        # 跨机/回环 TCP 一律 scram —— 应用走的是 TCP。
        '--auth-local=trust', '--auth-host=scram-sha-256',
        '-E', 'UTF8',
    ]
    # 起集群的命令**不在这里再写一遍**：见 `cluster_start_step()`。
    # 这里只把步骤名换成 `cluster_plan` 自己的那一个（`apply()` 按它判幂等）。
    start_step = dict(cluster_start_step(home, pg_bin), kind='start-server', writes=True)
    steps = [
        {'kind': 'verify-binaries', 'argv': [str(pg_bin / 'initdb'), '--version'],
         'writes': False},
        # ⚠️ 必须在 initdb/start 之前：`initdb` **不会**建 socket 目录，
        #    少了它会得到 `could not create lock file ...: No such file or directory`。
        {'kind': 'mkdir-socket-dir', 'writes': True},
        {'kind': 'initdb', 'argv': initdb_argv, 'writes': True},
        # ⚠️ 必须在 **initdb 之后、start 之前**：`postgresql.conf` 由 initdb 生成。
        #    端口、监听地址、socket 目录都在这一段里 —— 见模块说明里
        #    「为什么端口、监听地址和 socket 目录必须写进 postgresql.conf」。
        {'kind': 'write-cluster-config', 'writes': True,
         'content': cluster_conf_block(pg_port, socket_dir)},
        start_step,
    ]
    return ClusterPlan(home=home, data_dir=data_dir, socket_dir=socket_dir,
                       pg_port=pg_port, pg_bin=pg_bin, log_file=log_file,
                       password_file=password_file, superuser_password=password,
                       steps=steps)


def cluster_is_running(home: Path, pg_bin: Path) -> bool:
    """
    集群是否在跑。
    @param home `$KVVI_HOME`
    @param pg_bin PostgreSQL 二进制目录
    @returns 在跑时为真
    """
    data_dir = Path(home) / 'pgdata'
    if not (data_dir / 'postmaster.pid').is_file():
        return False
    return _run([Path(pg_bin) / 'pg_ctl', '-D', str(data_dir), 'status'],
                timeout=30).returncode == 0


def stop_cluster(home: Path, pg_bin: Path, mode: str = 'fast') -> bool:
    """
    停集群。
    @param home `$KVVI_HOME`
    @param pg_bin PostgreSQL 二进制目录
    @param mode `fast` / `immediate` / `smart`
    @returns 是否停成功（本来就没跑也算成功）
    """
    data_dir = Path(home) / 'pgdata'
    if not (data_dir / 'postmaster.pid').is_file():
        return True
    return _run([Path(pg_bin) / 'pg_ctl', '-D', str(data_dir), '-m', mode, '-w', 'stop'],
                timeout=120).returncode == 0


@dataclass
class DatabasesPlan:
    """建库建角色的计划。"""
    superuser: str
    superpass: str
    pg_port: int
    role_passwords: Dict[str, str]
    steps: List[dict] = field(default_factory=list)

    @property
    def databases(self) -> List[dict]:
        return [dict(d) for d in DATABASES]

    def commands_flat(self) -> List[str]:
        return [str(a) for step in self.steps for a in step.get('argv', [])]

    def psql(self, sql: str) -> List[str]:
        """一条以超级用户跑的单语句 `psql`。"""
        return ['psql', '-h', '127.0.0.1', '-p', str(self.pg_port), '-U', self.superuser,
                '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-tAc', sql]

    def apply(self, pg_bin: Path) -> dict:
        """
        执行：建角色、建库、逐个授权。

        ⚠️ **一条语句一次 `psql`。** 两条语句放进同一个 `-c`。
        psql 会把它们当成一个简单查询发过去，于是整个字符串落在一个隐式事务里 ——
        而 `CREATE DATABASE` 不能在事务块里跑，结果是**前一条也一起回滚**
        （如 `CREATE ROLE`），随后报的是「口令认证失败」，看不出根因。
        探路时撞到的就是这个。

        ⚠️ **`\gexec` 不能用。** 它是 psql 的元命令，只在 stdin/交互模式下展开；
        写在 `-c` 里会被原样发给服务器，报 `语法错误 在 "\" 或附近的`。
        所以「库不存在才建」改为**先查后建**：安装是单进程动作，没有并发窗口，
        而 `CREATE DATABASE` 本身也没有 `IF NOT EXISTS`。

        @param pg_bin PostgreSQL 二进制目录
        @returns `{ok, steps, errors}`
        """
        env = dict(os.environ, PGPASSWORD=self.superpass, LC_ALL='en_US.UTF-8')
        done: List[str] = []

        def run(sql: str) -> Optional[str]:
            argv = [str(pg_bin / 'psql'), '-h', '127.0.0.1', '-p', str(self.pg_port),
                    '-U', self.superuser, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1',
                    '-tAc', sql]
            result = _run(argv, env=env, timeout=120)
            if result.returncode != 0:
                return result.stderr.strip()[:500] or result.stdout.strip()[:500]
            return None

        for step in self.steps:
            if step['kind'] == 'database':
                name = step['name']
                probe = run("SELECT 1 FROM pg_database WHERE datname='" + name + "'")
                if probe is not None:
                    return {'ok': False, 'steps': done,
                            'errors': [{'sql': step['sql'], 'stderr': probe}]}
                exists = _run([str(pg_bin / 'psql'), '-h', '127.0.0.1', '-p', str(self.pg_port),
                               '-U', self.superuser, '-d', 'postgres', '-tAc',
                               "SELECT 1 FROM pg_database WHERE datname='" + name + "'"],
                              env=env, timeout=120).stdout.strip()
                if exists == '1':
                    done.append('database ' + name + ': 已存在，跳过')
                    continue
                failure = run(step['sql'])
                if failure is not None:
                    return {'ok': False, 'steps': done,
                            'errors': [{'sql': step['sql'], 'stderr': failure}]}
                done.append('database ' + name)
                continue
            failure = run(step['sql'])
            if failure is not None:
                return {'ok': False, 'steps': done,
                        'errors': [{'sql': step['sql'], 'stderr': failure}]}
            done.append(step['sql'][:60])
        return {'ok': True, 'steps': done, 'errors': []}


def databases_plan(superuser: str, superpass: str, pg_port: int,
                   role_passwords: Dict[str, str]) -> DatabasesPlan:
    """
    组建库建角色计划。**纯函数**。

    ⚠️ 角色一律 `NOSUPERUSER NOCREATEDB NOCREATEROLE`：§4.6.1 的分权靠的正是
    「一把钥匙开不了两扇门」，而超级用户**绕过 RLS** —— 那会让第二执行点失效。
    @param superuser 超级用户
    @param superpass 超级用户口令
    @param pg_port 集群端口
    @param role_passwords 角色 → 口令
    @returns 计划
    """
    plan = DatabasesPlan(superuser=superuser, superpass=superpass, pg_port=pg_port,
                         role_passwords=dict(role_passwords))
    for role in ROLES:
        password = plan.role_passwords.get(role)
        if password is None:
            continue
        # `DO $$ ... $$` 让重复执行成为幂等：已存在则改口令，不存在则建。
        sql = (f"DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='{role}') "
               f"THEN CREATE ROLE {role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE "
               f"PASSWORD '{password}'; ELSE ALTER ROLE {role} WITH LOGIN NOSUPERUSER "
               f"NOCREATEDB NOCREATEROLE PASSWORD '{password}'; END IF; END $$;")
        plan.steps.append({'kind': 'role', 'sql': sql, 'argv': plan.psql(sql)})
    for database in DATABASES:
        name = database['name']
        owner = database['roles'][0]
        create = "CREATE DATABASE " + name + " OWNER " + owner
        plan.steps.append({'kind': 'database', 'name': name, 'sql': create,
                           'argv': plan.psql(create)})
        # PUBLIC 默认对新库有 CONNECT。收回它，于是「谁连得上这个库」变成
        # 一条明确的授权，而不是「默认人人可连」。
        revoke = "REVOKE ALL ON DATABASE " + name + " FROM PUBLIC"
        plan.steps.append({'kind': 'revoke-public', 'name': name, 'sql': revoke,
                           'argv': plan.psql(revoke)})
    return plan
