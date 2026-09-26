#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""macOS 试点发行版的**环境前置检查**。

## 它只做一件事：在写任何东西之前把环境问清楚

`preflight` 的三条硬规则，每条都有对应的负向测试：

| # | 规则 | 不成立会怎样 |
|---|---|---|
| 1 | **只读**。检查期间不创建目录、不写配置 | 检查到一半写了配置再失败，下次运行面对一个半成品；而客户以为「什么都没发生」 |
| 2 | **每一项自己报自己**。缺 PostgreSQL 与端口被占是两件事，各有自己的码与引导 | 「启动失败」把版本问题伪装成程序缺陷，客户去查程序而不是查环境 |
| 3 | **一次报完**。多个问题一起给 | 一次只报一个，客户要来回试几次才把环境弄对 |

## 为什么 PostgreSQL 大版本是**写死的**

第一版固定支持 PostgreSQL **17**，且要求用 Homebrew 的 **`postgresql@17`** formula，
不接受不带版本号的 `postgresql`。理由不是审美：

- 不带版本号的 formula 会**跟着 `brew upgrade` 走**。客户升级一次，行为就与取证时不一致，
  而我们没有任何办法知道当时跑的是哪个版本；
- 数据库是本产品唯一无法在运行期替换的依赖 —— 版本漂移的表现会出现在很久之后
  （排序、JSON 语义、`ON CONFLICT` 的细节），那时已经没人记得装的是什么。

## 为什么两套 Homebrew 前缀都要查

Apple Silicon 的 Homebrew 在 `/opt/homebrew`，Intel 在 `/usr/local`。只查前者的话，
Intel 机器上「装好了」会被报成「未安装」—— 而客户面前确实躺着那个 formula。
"""

import os
import shutil
import socket
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional, Sequence, Tuple

#: 第一版固定支持的 PostgreSQL 大版本。改它必须同时改需求、手册与取证。
KVVI_PG_MAJOR = 17

#: 第一版要求的最低 macOS 版本。低于它的 `launchd` 与 Python 3 行为没有把握。
MIN_MACOS_VERSION = (13, 0)

#: 时钟可接受的年份下界。令牌到期与审计顺序都依赖时钟。
MIN_CLOCK_YEAR = 2020

#: Homebrew formula 名。**带版本号**，见模块头。
PG_FORMULA = f'postgresql@{KVVI_PG_MAJOR}'

_BREW_PREFIX_BY_ARCH = {'arm64': '/opt/homebrew', 'x86_64': '/usr/local'}


@dataclass(frozen=True)
class HostEnv:
    """
    检查所需的主机事实。

    单独抽出来是为了让 `preflight` 成为**纯函数**：生产调用 `observe_host()`，
    测试直接构造。否则每一个用例都要在一台真机器上造出「装了错的 PostgreSQL」这种状态。
    """
    platform: str
    macos_version: Tuple[int, int]
    machine: str
    pg_config: Optional[Path]
    pg_major: Optional[int]
    busy_ports: Sequence[int] = ()
    free_disk_gib: float = 0.0
    memory_gib: float = 0.0
    year: int = 0
    pg_config_candidates: Sequence[Path] = field(default_factory=tuple)


def brew_prefix(machine: str) -> str:
    """
    该架构的 Homebrew 前缀。
    @param machine `platform.machine()` 的取值（`arm64` / `x86_64`）
    @returns Homebrew 前缀；未知架构退回 Apple Silicon 的路径
    """
    return _BREW_PREFIX_BY_ARCH.get(machine, '/opt/homebrew')


def pg_config_for(prefix: str) -> Path:
    """
    该前缀下 `postgresql@17` 的 `pg_config`。
    @param prefix Homebrew 前缀
    @returns `pg_config` 的路径（**不保证存在**）
    """
    return Path(prefix) / 'opt' / PG_FORMULA / 'bin' / 'pg_config'


def locate_pg_config(machine: str, extra_candidates: Sequence[Path] = ()) -> Optional[Path]:
    """
    在**两套前缀**与 PATH 里找可用且版本正确的 `pg_config`。

    ⚠️ 两套都找，不是「先找对的再找另一套」：Intel 机器上 `/opt/homebrew` 不存在，
    只查它必然报「未安装」—— 而客户面前确实躺着那个 formula。
    @param machine 当前架构
    @param extra_candidates 额外候选（测试与自定义安装用）
    @returns 可执行且大版本正确的 `pg_config`，找不到时为 `None`
    """
    candidates = [pg_config_for(brew_prefix(machine)),
                  pg_config_for(brew_prefix('arm64' if machine == 'x86_64' else 'x86_64'))]
    candidates.extend(Path(c) for c in extra_candidates)
    from_path = shutil.which('pg_config')
    if from_path is not None:
        candidates.append(Path(from_path))
    for candidate in candidates:
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return candidate
    return None


def pg_major_of(pg_config: Path) -> Optional[int]:
    """
    从 `pg_config --version` 读大版本。
    @param pg_config 可执行的 `pg_config`
    @returns 大版本号，例如 `17`；读不出来时为 `None`
    """
    import subprocess
    try:
        out = subprocess.run([str(pg_config), '--version'], capture_output=True,
                             text=True, timeout=10).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    # `PostgreSQL 17.4 (Homebrew)` → 17
    for token in out.split():
        head = token.split('.')[0]
        if head.isdigit():
            return int(head)
    return None


def _busy(port: int) -> bool:
    """该端口是否已被占用（本机回环）。"""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(0.5)
        return probe.connect_ex(('127.0.0.1', port)) == 0


def observe_host() -> HostEnv:
    """
    读一次真实主机。**只读**：不建目录、不写文件、不改任何配置。
    @returns 当前主机事实
    """
    import platform as host
    # ⚠️ 是 `host.mac_ver()`（返回元组），不是 `mac_version()` —— 后者不存在。
    #    第一版写错了，而 16 条用例全绿：它们**注入** `HostEnv`，所以从不调用
    #    `observe_host()`。**注入让判定可测，同时让观察无人测** ——
    #    下面那条 smoke 用例就是为这件事加的。
    raw = host.mac_ver()[0] or '0.0'
    version = raw.split('.')
    macos = (int(version[0]), int(version[1])) if len(version) >= 2 else (0, 0)
    machine = host.machine()
    pg_config = locate_pg_config(machine)
    # ⚠️ **端口探测属于「观察」，不属于「判定」。**
    #    第一版把 `_busy()` 写在 `_collect()` 里，于是测试只要不显式给
    #    `busy_ports`，就会去探**开发机上真实的端口** —— 而本机 7400 上正跑着
    #    KVVI 的 docker 栈，十条用例平白多出一个 `KVVI_PORT_IN_USE`。
    #    那不是被测代码的问题，是**判定里混进了对真实世界的读取**。
    #    判定只该消费 `HostEnv`；谁去探测，谁负责填。
    candidates = (int(os.environ.get('KVVI_PG_PORT', 54329)),
                  int(os.environ.get('KVVI_PLATFORM_PORT', 7400)))
    return HostEnv(
        platform=sys.platform,
        macos_version=macos,
        machine=machine,
        pg_config=pg_config,
        pg_major=pg_major_of(pg_config) if pg_config is not None else None,
        busy_ports=tuple(port for port in candidates if _busy(port)),
        free_disk_gib=shutil.disk_usage(Path.home()).free / (1024 ** 3),
        memory_gib=os.sysconf('SC_PAGE_SIZE') * os.sysconf('SC_PHYS_PAGES') / (1024 ** 3),
        year=__import__('datetime').date.today().year,
    )


def _error(code: str, guidance: str, **extra) -> dict:
    return {'code': code, 'guidance': guidance, **extra}


def _collect(config: dict, root: Path, env: HostEnv) -> list:
    """把所有不合适一次收齐。**顺序固定**：先环境、后资源、最后端口。"""
    errors = []

    if env.platform != 'darwin':
        errors.append(_error(
            'KVVI_NOT_MACOS',
            '第一版试点发行版只支持 macOS；Linux 企业服务器版见补充需求 §15。',
            found=env.platform))

    if env.platform == 'darwin' and env.macos_version < MIN_MACOS_VERSION:
        errors.append(_error(
            'KVVI_MACOS_TOO_OLD',
            f'需要 macOS {MIN_MACOS_VERSION[0]}.{MIN_MACOS_VERSION[1]} 或更高，'
            f"当前 {env.macos_version[0]}.{env.macos_version[1]}。",
            found=list(env.macos_version), required=list(MIN_MACOS_VERSION)))

    if env.pg_config is None:
        errors.append(_error(
            'KVVI_PG_NOT_FOUND',
            f'未找到可执行的 pg_config。请先安装：brew install {PG_FORMULA}',
            required=KVVI_PG_MAJOR))
    elif env.pg_major != KVVI_PG_MAJOR:
        errors.append(_error(
            'KVVI_PG_MAJOR_UNSUPPORTED',
            f'本版本固定使用 PostgreSQL {KVVI_PG_MAJOR}，'
            f'请安装 brew install {PG_FORMULA} 并把它放在 PATH 前面。',
            found=env.pg_major, required=KVVI_PG_MAJOR))

    home = Path(config['home'])
    parent = home if home.exists() else (home.parent if home.parent.exists() else None)
    if parent is None or not os.access(parent, os.W_OK):
        errors.append(_error(
            'KVVI_HOME_NOT_WRITABLE',
            f'{home} 的上一级目录不可写，KVVI 无法在那里建数据目录。',
            path=str(home)))

    if env.free_disk_gib < float(config['min_disk_gib']):
        errors.append(_error(
            'KVVI_DISK_LOW',
            f"磁盘可用空间不足：需要 {config['min_disk_gib']:.0f} GiB，"
            f'当前 {env.free_disk_gib:.1f} GiB。',
            found=round(env.free_disk_gib, 1), required=config['min_disk_gib']))

    if env.memory_gib < float(config['min_memory_gib']):
        errors.append(_error(
            'KVVI_MEMORY_LOW',
            f"内存不足：需要 {config['min_memory_gib']:.0f} GiB，"
            f'当前 {env.memory_gib:.1f} GiB。',
            found=round(env.memory_gib, 1), required=config['min_memory_gib']))

    if env.year < MIN_CLOCK_YEAR:
        errors.append(_error(
            'KVVI_CLOCK_SKEW',
            f'系统时间看起来不对（{env.year} 年）。令牌到期与审计顺序都依赖时钟，请先校准。',
            found=env.year, required=f'>= {MIN_CLOCK_YEAR}'))

    for key, label in (('pg_port', 'PostgreSQL'), ('platform_port', '平台服务')):
        port = int(config[key])
        if port in set(env.busy_ports):
            errors.append(_error(
                'KVVI_PORT_IN_USE',
                f'{label}要用的端口 {port} 已被占用。换一个端口，或先停掉占用它的进程。',
                port=port))
    return errors


def preflight(config: dict, root: Path, env: Optional[HostEnv] = None) -> dict:
    """
    只读的环境检查。

    ⚠️ **本函数不创建任何东西。** 想建目录的是调用方在 `--apply` 里做的事；
    前置检查里写一个文件，就等于让「检查通过」这件事带上了副作用 ——
    而客户在失败时会以为什么都没发生。
    @param config `home` / `pg_port` / `platform_port` / `min_disk_gib` / `min_memory_gib`
    @param root 发行版根目录（仅用于报告，不写入）
    @param env 主机事实；缺省时读真实主机
    @returns `{ok, errors, requiredPostgresMajor, hardware, postgres, paths}`
    """
    env = env if env is not None else observe_host()
    errors = _collect(config, root, env)
    return {
        'ok': not errors,
        'errors': errors,
        'requiredPostgresMajor': KVVI_PG_MAJOR,
        'hardware': {'architecture': env.machine,
                     'macosVersion': f'{env.macos_version[0]}.{env.macos_version[1]}',
                     'memoryGiB': round(env.memory_gib, 1),
                     'freeDiskGiB': round(env.free_disk_gib, 1)},
        'postgres': {'pgConfig': str(env.pg_config) if env.pg_config else None,
                     'major': env.pg_major, 'formula': PG_FORMULA,
                     'expectedPgConfig': str(pg_config_for(brew_prefix(env.machine)))},
        'paths': {'home': config['home'], 'releaseRoot': str(root),
                  'pgDataDir': str(Path(config['home']) / 'pgdata'),
                  'pgSocketDir': str(Path(config['home']) / 'run')},
        'ports': {'postgres': int(config['pg_port']),
                  'platform': int(config['platform_port'])},
    }
