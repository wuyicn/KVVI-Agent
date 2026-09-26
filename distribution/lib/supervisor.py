#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""两个进程的拉起、停止与状态。

## 这一层不拥有任何判据

它只做三件事：**检查依赖就绪**、**起/停进程**、**如实报告状态**。
权限、身份、业务都在平台与运行时进程里，这里一行都不碰。

## 「同用户运行」是**可观测**的，不是文档里的一句话

`PRD §4.6.5` 要求两进程分属不同容器**或**不同系统用户。macOS 试点两条都不满足：
两个进程都由安装它的那个用户拉起。这件事写在文档里是**我们的断言**；
写进 `status` 的 `user` 字段才是**可复核的事实**。

所以 `status_report()` 一定报出两个进程各自的 uid，`DEGRADATIONS` 一定说明
每一项**失去什么、保留什么**。取证文档引用的是这个报告，不是这段话。

## 为什么不用 launchd 直接拉起，而是自己起 + 用 launchd 保活

launchd 的 `KeepAlive` 能重启崩溃的进程，但它**不表达顺序**：两个 `RunAtLoad`
的 LaunchAgent 谁先起是不确定的，而平台必须先起（它是唯一对外入口）。
所以顺序由 `start_plan` 负责，launchd 只负责「起过一次之后别再让它死着」。
"""

import os
import plistlib
import shutil
import socket
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional

from distribution.lib.pg import cluster_is_running, pg_bin_dir

#: 启动顺序即元组顺序。平台在前。
PROGRAMS = ('platform', 'runtime')

DEFAULT_PLATFORM_PORT = 7400
DEFAULT_RUNTIME_PORT = 7401

LAUNCH_AGENT_LABEL = 'com.kvvi.agent'

#: 每一项降级的**失去什么 / 保留什么**。取证文档直接引用它。
DEGRADATIONS = (
    {
        'code': 'KVVI_SINGLE_POSTGRES_INSTANCE',
        'lost': '实例级的进程与配置隔离：三个库共用一个 postgresql.conf、一个端口、一个超级用户',
        'kept': '库、角色、RLS、审计只能经 audit_append 写入、普通写者无审计权限',
        'restoredBy': 'Linux 企业服务器版（三个独立实例）',
    },
    {
        'code': 'KVVI_SAME_USER_PROCESSES',
        'lost': 'PRD §4.6.5 的「不同容器或不同系统用户」两条都不满足：'
                '两个进程同用户运行，能读该用户文件的本地攻击者可同时触及两者',
        'kept': '内网令牌鉴权每一次平台→运行时调用；运行时只监听回环地址',
        'restoredBy': '给运行时代码单独建一个系统用户，或回到容器部署',
    },
)


@dataclass
class ProcessPlan:
    """起/停进程的计划。"""
    home: Path
    release_root: Path
    platform_port: int
    runtime_port: int
    internal_token: str
    kind: str  # 'start' | 'stop'
    steps: List[dict] = field(default_factory=list)

    def apply(self) -> dict:
        """
        执行。
        @returns `{ok, steps, errors, pids}`
        """
        done: List[str] = []
        errors: List[dict] = []
        pids: Dict[str, int] = {}
        log_dir = self.home / 'log'
        log_dir.mkdir(parents=True, exist_ok=True)

        if self.kind == 'stop':
            for step in self.steps:
                pid_file = self.home / 'run' / (step['program'] + '.pid')
                if not pid_file.is_file():
                    done.append(step['kind'] + ': 未运行')
                    continue
                pid = int(pid_file.read_text().strip() or '0')
                try:
                    os.kill(pid, 15)
                except ProcessLookupError:
                    done.append(step['kind'] + ': 进程已不在')
                except PermissionError:
                    errors.append({'kind': step['kind'], 'stderr': f'无权结束 pid {pid}'})
                    continue
                pid_file.unlink(missing_ok=True)
                done.append(step['kind'])
            return {'ok': not errors, 'steps': done, 'errors': errors, 'pids': pids}

        for step in self.steps:
            if step['kind'].startswith('start-'):
                pid = self._spawn(step, log_dir)
                if pid is None:
                    errors.append({'kind': step['kind'], 'stderr': '进程未能启动'})
                    return {'ok': False, 'steps': done, 'errors': errors, 'pids': pids}
                pids[step['program']] = pid
                done.append(step['kind'])
            else:
                done.append(step['kind'] + ': 只读')
        return {'ok': not errors, 'steps': done, 'errors': errors, 'pids': pids}

    def _spawn(self, step: dict, log_dir: Path) -> Optional[int]:
        """起一个进程，把 pid 写进 `$KVVI_HOME/run/<program>.pid`。"""
        env = dict(os.environ)
        env.update(step.get('env') or {})
        env['LC_ALL'] = 'en_US.UTF-8'
        log = open(log_dir / (step['program'] + '.log'), 'ab')
        try:
            process = subprocess.Popen([str(a) for a in step['argv']], env=env,
                                       stdout=log, stderr=subprocess.STDOUT,
                                       start_new_session=True)
        except OSError as error:
            log.close()
            return None
        finally:
            pass
        pid_dir = self.home / 'run'
        pid_dir.mkdir(parents=True, exist_ok=True)
        (pid_dir / (step['program'] + '.pid')).write_text(str(process.pid) + '\n')
        return process.pid


def _env_file_vars(home: Path) -> Dict[str, str]:
    """
    读 `$KVVI_HOME/kvvi.env`。
    @param home `$KVVI_HOME`
    @returns 键值对；文件不存在时为空
    """
    path = Path(home) / 'kvvi.env'
    if not path.is_file():
        return {}
    out: Dict[str, str] = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if line == '' or line.startswith('#') or '=' not in line:
            continue
        key, _, value = line.partition('=')
        out[key.strip()] = value.strip()
    return out


def readiness_report(home: Path, platform_port: int, runtime_port: int = DEFAULT_RUNTIME_PORT,
                     pg_bin: Optional[Path] = None) -> dict:
    """
    起进程**之前**的就绪判定。只读。
    @param home `$KVVI_HOME`
    @param platform_port 平台端口
    @param runtime_port 运行时端口
    @param pg_bin PostgreSQL 二进制目录
    @returns `{ok, issues}`
    """
    home = Path(home)
    issues: List[dict] = []

    resolved_bin = None
    try:
        resolved_bin = Path(pg_bin) if pg_bin is not None else pg_bin_dir()
    except RuntimeError:
        issues.append({'code': 'KVVI_PG_NOT_FOUND',
                       'guidance': '找不到 PostgreSQL 二进制；见 kvvi-admin preflight'})

    if resolved_bin is not None and not cluster_is_running(home, resolved_bin):
        issues.append({'code': 'KVVI_CLUSTER_NOT_RUNNING',
                       'guidance': f'数据库集群没在运行。先跑 kvvi-admin install --apply，'
                                   f'或手动起：pg_ctl -D {home / "pgdata"} start'})

    if not (home / 'kvvi.env').is_file():
        issues.append({'code': 'KVVI_CONFIG_MISSING',
                       'guidance': f'找不到 {home / "kvvi.env"} —— 安装没有完成，'
                                   f'请重新运行 kvvi-admin install --apply'})

    for name, port in (('platform', platform_port), ('runtime', runtime_port)):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.settimeout(0.5)
            if probe.connect_ex(('127.0.0.1', port)) == 0:
                issues.append({'code': 'KVVI_PORT_IN_USE', 'port': port, 'program': name,
                               'guidance': f'{name} 要用的端口 {port} 已被占用'})
    return {'ok': not issues, 'issues': issues}


def start_plan(home: Path, release_root: Path, platform_port: int = DEFAULT_PLATFORM_PORT,
               runtime_port: int = DEFAULT_RUNTIME_PORT, internal_token: str = '',
               pg_bin: Optional[Path] = None) -> ProcessPlan:
    """
    组一个启动计划。**纯函数**。只读步骤（就绪检查）排在全部启动步骤之前。
    @param home `$KVVI_HOME`
    @param release_root 发行版根目录
    @param platform_port 平台端口
    @param runtime_port 运行时端口
    @param internal_token 进程间令牌；缺省从配置文件读
    @param pg_bin PostgreSQL 二进制目录
    @returns 计划
    """
    home = Path(home)
    root = Path(release_root)
    if internal_token == '':
        internal_token = _env_file_vars(home).get('KVVI_INTERNAL_TOKEN', '')

    prepare = [
        {'kind': 'check-cluster', 'writes': False, 'program': 'platform', 'argv': []},
        {'kind': 'check-config', 'writes': False, 'program': 'platform', 'argv': []},
        {'kind': 'check-ports', 'writes': False, 'program': 'platform', 'argv': []},
    ]
    platform_step = {
        'kind': 'start-platform', 'writes': True, 'program': 'platform',
        'argv': ['node', str(root / 'services' / 'platform' / 'src' / 'server.mjs')],
        'env': {
            'KVVI_PLATFORM_PORT': str(platform_port),
            'KVVI_PLATFORM_HOST': '127.0.0.1',
            'KVVI_RUNTIME_URL': f'http://127.0.0.1:{runtime_port}',
            'KVVI_INTERNAL_TOKEN': internal_token,
            'KVVI_DSH_ROOT': str(root / 'vendor' / 'dsh'),
        },
    }
    # 运行时只绑回环：对外只有平台进程。`--trusted-host` 让平台按服务名访问时
    # 能过运行时的 browser-trust 栅栏；本机部署下这个名字就是 127.0.0.1。
    runtime_step = {
        'kind': 'start-runtime', 'writes': True, 'program': 'runtime',
        'argv': ['node', str(root / 'vendor' / 'dsh' / 'apps' / 'cli' / 'lib' / 'bin.js'),
                 '--profile', 'kvvi', '--host', '127.0.0.1',
                 '--port', str(runtime_port), '--no-open',
                 '--trusted-host', '127.0.0.1'],
        'env': {
            'KVVI_PROFILE': 'kvvi',
            'KVVI_RUNTIME_PORT': str(runtime_port),
            'KVVI_RUNTIME_CONTEXT_SECRET': internal_token,
            'KVVI_INTERNAL_TOKEN': internal_token,
            'DSH_HOME': str(home),
        },
    }
    return ProcessPlan(home=home, release_root=root, platform_port=platform_port,
                       runtime_port=runtime_port, internal_token=internal_token,
                       kind='start', steps=prepare + [platform_step, runtime_step])


def stop_plan(home: Path, release_root: Path) -> ProcessPlan:
    """
    组一个停止计划。**逆序**：先停运行时（它的调用来自平台），再停平台。
    @param home `$KVVI_HOME`
    @param release_root 发行版根目录
    @returns 计划
    """
    return ProcessPlan(
        home=Path(home), release_root=Path(release_root), platform_port=0, runtime_port=0,
        internal_token='', kind='stop',
        steps=[{'kind': 'stop-runtime', 'writes': True, 'program': 'runtime', 'argv': []},
               {'kind': 'stop-platform', 'writes': True, 'program': 'platform', 'argv': []}])


def status_report(home: Path, release_root: Path,
                  processes: Optional[Dict[str, dict]] = None) -> dict:
    """
    如实报告状态，**包括两进程各自的运行用户**。
    @param home `$KVVI_HOME`
    @param release_root 发行版根目录
    @param processes 预先给好的进程状态（测试用）；缺省从 pid 文件读
    @returns 报告
    """
    home = Path(home)
    report: Dict[str, dict] = {}
    for program in PROGRAMS:
        pid_file = home / 'run' / (program + '.pid')
        pid = None
        running = False
        if pid_file.is_file():
            try:
                pid = int(pid_file.read_text().strip() or '0')
            except ValueError:
                pid = None
            if pid:
                try:
                    os.kill(pid, 0)
                    running = True
                except (ProcessLookupError, PermissionError):
                    running = False
        # ⚠️ `user` 一定报出来：这是「两个进程同用户」这名话的可复核证据。
        report[program] = {'pid': pid, 'running': running, 'user': os.getuid(),
                           'userName': _user_name()}
    if processes:
        report.update(processes)
    return {'home': str(home), 'releaseRoot': str(release_root),
            'processes': report, 'degradations': list(DEGRADATIONS)}


def _user_name() -> str:
    """当前用户名（报告用）。"""
    import getpass
    try:
        return getpass.getuser()
    except (KeyError, OSError):
        return str(os.getuid())


def launchd_plist(home: Path, release_root: Path, platform_port: int,
                  runtime_port: int) -> str:
    """
    生成 LaunchAgent 的 plist。

    ⚠️ **plist 里不放任何口令。** 它会被 `plutil -p` 打印、被 Spotlight 索引，
    而配置文件是 0600 的。所以这里只**指向**配置文件，不抄它的内容。
    @param home `$KVVI_HOME`
    @param release_root 发行版根目录
    @param platform_port 平台端口
    @param runtime_port 运行时端口
    @returns plist XML
    """
    payload = {
        'Label': LAUNCH_AGENT_LABEL,
        'ProgramArguments': [str(Path(release_root) / 'distribution' / 'bin' / 'kvvi-admin'),
                             'start', '--apply', '--yes'],
        'EnvironmentVariables': {
            'KVVI_HOME': str(home),
            'KVVI_PLATFORM_PORT': str(platform_port),
            'KVVI_RUNTIME_PORT': str(runtime_port),
            'KVVI_CONFIG_FILE': str(Path(home) / 'kvvi.env'),
        },
        # 崩了要拉起来；登录时也要起（RunAtLoad）。
        # 顺序不由 launchd 负责 —— 见模块说明。
        'KeepAlive': True,
        'RunAtLoad': True,
        'StandardOutPath': str(Path(home) / 'log' / 'launchd.out.log'),
        'StandardErrorPath': str(Path(home) / 'log' / 'launchd.err.log'),
    }
    body = plistlib.dumps(payload, sort_keys=False).decode('utf-8')
    return body
