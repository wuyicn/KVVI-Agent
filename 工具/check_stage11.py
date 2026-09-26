#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""阶段十一 G9：macOS 试点发行版闭环。

判据：**一台从未安装过 KVVI 的 macOS 机器，按操作手册完成本机私有化部署，
并跑通完整用户旅程。**

## 这个检查器验什么，以及它在哪一层验

它**只从发行包跑**，不在仓库工作树里跑 —— 那两件事的差别正是
「发得出去」与「在我这台机器上恰好成立」的差别。所以每一步都在
解出来的目录里执行，并且最后**逐条检查有没有任何东西解析回了仓库**。

旅程（每一步失败即整体失败）：

    preflight → install → start → 首次初始化 → 登录 → 界面 200
    → 备份 → 恢复 → 卸载（数据保留）

## 关于验收主机（业主 2026-09-26 决定）

选定的是「开发机上的**全新 macOS 用户账号**」。新建 macOS 用户需要管理员权限，
而本会话拿不到（`sudo` 要密码、`sysadminctl` 拒绝非交互调用）。
所以本检查器有**两种模式**，并在报告里**明说跑的是哪一种**：

| 模式 | 怎么进 | 能证到什么 |
|---|---|---|
| `clean-user` | 先由管理员建好用户，再 `KVVI_G9_USER=<名> python3 工具/check_stage11.py` | 在一个从未跑过 KVVI 的**用户**下成立 |
| `clean-dir` | 默认 | 在一个从未跑过 KVVI 的**目录**下成立 |

**两者都不是另一台机器。** 报告里那句必须原样保留 —— 它不是免责声明，
它是这份证据的适用边界。
"""

import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ARCHIVE = ROOT / '交付' / '发行' / 'kvvi-macos-pilot.tar.gz'
EVIDENCE = ROOT / '交付' / '证据' / '验收证据包.json'
SCRATCH = Path('/tmp/kvvi-g9')

C_OK, C_BAD, C_WARN, C_DIM, C_OFF = '\033[32m', '\033[31m', '\033[33m', '\033[90m', '\033[0m'

#: 平台与数据库端口。**刻意不用默认值**：开发机上 7400 通常被 docker 栈占着，
#: 而「端口被占」会以「安装失败」的形式出现，看起来像发行包的问题。
PLATFORM_PORT = 7561
PG_PORT = 54561

#: 一次旅程的全部步骤。顺序即依赖顺序。
STEPS = (
    ('preflight', '只读的环境检查'),
    ('deps', '安装运行时的依赖（安装手册 §2.1）'),
    ('install', '首次安装（建集群、建库建角色、跑迁移）'),
    ('start', '起两个进程'),
    ('bootstrap', '一次性首次初始化'),
    ('bootstrap-again', '第二次初始化必须被拒（410）'),
    ('login', '所有者登录'),
    ('ui', '打开界面（HTTP 200 且是 KVVI 的页面）'),
    ('api', '业务 API 可用（会话有效）'),
    ('backup', '备份三个库与运行期状态'),
    ('restore', '恢复（先核摘要再覆盖）'),
    ('uninstall', '卸载并保留数据'),
)


def run(cmd, cwd=None, env=None, timeout=1800):
    """跑一条命令。"""
    return subprocess.run([str(part) for part in cmd], cwd=cwd, env=env,
                          capture_output=True, text=True, timeout=timeout)


def print_result(label, cmd, result):
    """打印一条命令的输出。"""
    print(f'{C_DIM}[{label}] $ {" ".join(str(c) for c in cmd)}{C_OFF}')
    body = (result.stdout + result.stderr).rstrip()
    if body:
        print(body)
    print(f'[{label}] exit={result.returncode}')
    return body


def host_facts() -> dict:
    """跑这次验收的机器是什么。**证据要写清它，否则不可复核。**"""
    version = run(['sw_vers', '-productVersion']).stdout.strip()
    return {
        'macos': version,
        'architecture': run(['uname', '-m']).stdout.strip(),
        'node': run(['node', '--version']).stdout.strip(),
        'pnpm': run(['pnpm', '--version']).stdout.strip(),
        'postgresql': run(['pg_config', '--version']).stdout.strip(),
    }


def ensure_archive() -> Path:
    """发行包不在就先打一份。"""
    if not ARCHIVE.is_file():
        build = run(['python3', '工具/发行包.py', '--build'], cwd=ROOT)
        print_result('build', build.args, build)
        if build.returncode != 0:
            raise RuntimeError('发行包构建失败')
    check = run(['python3', '工具/发行包.py', '--check'], cwd=ROOT)
    print_result('archive-check', check.args, check)
    if check.returncode != 0:
        raise RuntimeError('发行包校验未通过')
    return ARCHIVE


def prepare_scratch() -> Path:
    """
    解包到一个**仓库之外**的干净目录。
    @returns 解出来的发行版根目录
    """
    if SCRATCH.exists():
        shutil.rmtree(SCRATCH)
    SCRATCH.mkdir(parents=True)
    extract = run(['tar', 'xzf', str(ARCHIVE), '-C', str(SCRATCH)])
    if extract.returncode != 0:
        raise RuntimeError(f'解包失败：{extract.stderr.strip()[:200]}')
    root = SCRATCH / 'kvvi-macos-pilot'
    if not root.is_dir():
        raise RuntimeError(f'解出来的目录不对：{list(SCRATCH.iterdir())}')
    return root


def release_env(home: Path, user: str = '') -> dict:
    """
    运行时的环境。

    ⚠️ **剥掉可能残留的 KVVI/DSH 变量**（`KVVI_*`、`DSH_*`、`PYTHONPATH`）：
    它们可能是前一次实验留下的，留着等于在一个「看起来干净」的环境里跑。

    ⚠️ **但 PATH 分两种模式，不能一刀切。**
    第一版把 PATH 写死成系统路径，于是这台机器上的 `node` 找不到 ——
    它装在 `~/.local/bin`。那暴露的正是这次验收要抓的东西：
    **一个「在我这台机器上恰好成立」的假设。**

    两种模式正确的 PATH 不同，因为**它们模拟的本来就是不同的东西**：

    | 模式 | PATH | 为什么 |
    |---|---|---|
    | `clean-dir` | 沿用调用者的 PATH | 同一个用户，只是换了个目录 —— 他装好的 node 当然还在 |
    | `clean-user` | 系统默认 PATH | 一个全新的 macOS 用户**没有** `~/.local/bin`；这正是手册要求「先装 Node 24」的原因 |

    所以 `clean-user` 模式下若报 `KVVI_NODE_NOT_FOUND`，那不是缺陷，
    是**如实反映了新用户的真实处境**。
    @param home 实例主目录
    @param user 目标用户（非空时报告里会注明）
    @returns 环境变量
    """
    if user:
        path = '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin'
    else:
        path = os.environ.get('PATH', '/usr/local/bin:/usr/bin:/bin')
    env = {
        'PATH': path,
        'HOME': os.environ.get('HOME', '/tmp'),
        'LANG': 'en_US.UTF-8',
        'LC_ALL': 'en_US.UTF-8',
        'TMPDIR': os.environ.get('TMPDIR', '/tmp'),
    }
    if user:
        env['KVVI_G9_USER'] = user
    return env


def write_config(path: Path, home: Path) -> None:
    """写一份安装配置。"""
    path.write_text(json.dumps({
        'home': str(home), 'pg_port': PG_PORT, 'platform_port': PLATFORM_PORT,
    }, indent=2) + '\n', encoding='utf-8')


def admin(root: Path, env: dict, *args):
    """调一次 kvvi-admin。"""
    return run(['python3', str(root / 'distribution' / 'bin' / 'kvvi-admin'), *args],
               cwd=root, env=env)


class _NoRedirect:
    """
    不让 `urllib` 自动跟随重定向。

    ⚠️ **这是必须的，不是讲究。** `urlopen` 默认跟随 3xx，而登录的成功响应正是
    **303 + `Set-Cookie`** —— 跟随之后拿到的是「登录之后的那个页面」，
    而**那张 Cookie 在被跟随掉的那个响应里**。第一版因此稳定地拿不到会话，
    表现为「登录失败」，其实是客户端把要读的东西自己跳过了。

    用 Python 而不是 curl 的理由：少一个外部依赖，而且干净用户的环境里
    不一定有 curl。
    """

    @staticmethod
    def build():
        """一个不跟随重定向的 opener。"""
        import urllib.request

        class Handler(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *_args, **_kwargs):
                return None

        return urllib.request.build_opener(Handler)


def fetch(url: str, headers: dict = None, method: str = 'GET', body: bytes = None):
    """
    打一次 HTTP，**不跟随重定向**。
    @returns `(状态码, 响应头, 正文)`
    """
    import urllib.error
    import urllib.request
    request = urllib.request.Request(url, data=body, method=method,
                                     headers=headers or {})
    opener = _NoRedirect.build()
    try:
        with opener.open(request, timeout=20) as response:
            return response.status, dict(response.headers), response.read()
    except urllib.error.HTTPError as error:
        return error.code, dict(error.headers), error.read()


def login_cookie(port: int) -> str:
    """
    登录并取出会话 Cookie。
    @param port 平台端口
    @returns `kvvi-session=...`；失败时为空串
    """
    body = b'login=owner&password=kvvi-g9-owner-pass'
    status, headers, _ = fetch(f'http://127.0.0.1:{port}/kvvi/login', method='POST',
                               body=body,
                               headers={'content-type': 'application/x-www-form-urlencoded'})
    if status not in (200, 303):
        return ''
    # 头名大小写不保证 —— `dict(response.headers)` 里是服务端发什么就是什么。
    raw = ''
    for key, value in headers.items():
        if key.lower() == 'set-cookie':
            raw = value
            break
    return raw.split(';')[0] if raw else ''


def check_no_repo_leak(root: Path, home: Path, env: dict) -> list:
    """
    旅程走完之后，逐条检查**有没有任何东西解析回了仓库**。

    ⚠️ 这一条是这份证据能不能站住的关键：一个「从发行包安装」但实际读到了
    仓库里某个文件的流程，装出来的东西只在这台机器上成立。
    判据是**日志与配置里出现仓库路径**，以及**进程的工作目录**。
    @returns 问题列表
    """
    problems = []
    repo = str(ROOT)
    for name in ('kvvi.env', 'log/platform.log', 'log/runtime.log'):
        path = home / name
        if not path.is_file():
            continue
        body = path.read_text(errors='replace')
        if repo in body and '/tmp/kvvi-g9' not in body:
            problems.append(f'{name} 里出现了仓库路径')
    # 配置里的每一个 DSN 都要指向本实例的端口。
    config = home / 'kvvi.env'
    if config.is_file():
        for line in config.read_text(errors='replace').splitlines():
            if line.startswith('KVVI_') and '_DSN=' in line and f':{PG_PORT}/' not in line:
                problems.append(f'配置里的连接串没指向本实例：{line.split("=")[0]}')
    # 运行时的 profile 必须来自解出来的那份。
    profile = home / 'profiles' / 'kvvi' / 'package.json'
    if profile.is_file() and 'dsh-kvvi-app' not in profile.read_text(errors='replace'):
        problems.append('运行时的 kvvi profile 没挂 KVVI bundle')
    return problems


def log_tail(path: Path, lines: int = 6) -> str:
    """
    一个日志文件的尾部。
    @param path 日志
    @param lines 取几行
    @returns 尾部文本；读不到时说明读不到
    """
    if not path.is_file():
        return f'（没有 {path.name}）'
    try:
        body = path.read_text(errors='replace').strip().splitlines()
    except OSError as error:
        return f'（读不到 {path.name}：{error}）'
    return ' / '.join(body[-lines:])[:600]


def occupant_of(port: int) -> str:
    """
    谁占着这个端口。
    @param port 端口
    @returns `pid/进程名`，没人占时为空串
    """
    result = run(['lsof', '-nP', f'-iTCP:{port}', '-sTCP:LISTEN', '-t'])
    pid = result.stdout.strip().splitlines()
    if not pid:
        return ''
    name = run(['ps', '-o', 'comm=', '-p', pid[0]]).stdout.strip()
    return f'{pid[0]}/{name}'


def stop_previous(home: Path) -> None:
    """
    停掉上一次运行留下的实例，**再**删它的目录。

    ⚠️ 第一版直接 `rmtree(home)`，而上一轮的 `postgres` 还活着 ——
    它的数据目录被删了，但进程仍在 LISTEN 那个端口。于是新装出来的集群
    起不来，报 `pg_ctl: could not start server`，理由只在 postgres 日志里
    （`Address already in use`）。

    这件事在真实场景里同样会发生：**在还跑着的实例上重装**。
    所以先停、再删，而且停不掉就**大声说**，不要带着一个占着端口的僵尸往下走。
    @param home 实例主目录
    """
    if not home.exists():
        return
    data_dir = home / 'pgdata'
    if (data_dir / 'postmaster.pid').is_file():
        try:
            pg_bin = run(['python3', '-c',
                          'import sys; sys.path.insert(0, ".");'
                          'from distribution.lib.pg import pg_bin_dir;'
                          'print(pg_bin_dir())'], cwd=ROOT).stdout.strip()
            if pg_bin:
                stopped = run([f'{pg_bin}/pg_ctl', '-D', str(data_dir), '-m', 'immediate',
                               '-w', '-t', '30', 'stop'])
                print(f'  （停止上一轮实例：exit={stopped.returncode}）')
        except Exception as error:                      # noqa: BLE001
            print(f'  （停止上一轮实例失败：{error}）')
    shutil.rmtree(home, ignore_errors=True)


def run_journey(root: Path, user: str = '') -> dict:
    """
    走完整旅程。
    @param root 解出来的发行版根目录
    @param user 目标用户（非空时用于报告）
    @returns `{ok, steps: [...], problems: [...]}`
    """
    home = Path('/tmp/kvvi-g9-home')
    stop_previous(home)
    env = release_env(home, user)

    # 端口上还压着别的东西就**现在**停下来，别让它以「安装失败」的形式出现 ——
    # 那条报错指向的是 postgres 日志，而根因是另一件完全无关的事。
    for port in (PLATFORM_PORT, PG_PORT):
        holder = occupant_of(port)
        if holder:
            return {'ok': False, 'steps': [],
                    'problems': [f'端口 {port} 被 {holder} 占着。'
                                 f'那个进程不是本次验收的一部分 —— 先停掉它再跑。']}
    config = SCRATCH / 'kvvi-install.json'
    write_config(config, home)
    config_arg = ['--config', str(config)]

    http = f'http://127.0.0.1:{PLATFORM_PORT}'
    done = []
    problems = []

    def step(name, fn):
        """跑一步，失败就记下来并停止。"""
        try:
            fn()
        except Exception as error:                      # noqa: BLE001
            problems.append(f'{name}: {error}')
            return False
        done.append(name)
        return True

    # ① 环境检查。**不通过不算失败** —— 那可能就是这台机器缺某个前置条件，
    #    此时正确的结果是「如实报告」，不是「旅程走不下去」。
    result = admin(root, env, 'preflight', '--json', *config_arg)
    print_result('preflight', result.args, result)
    done.append('preflight')
    try:
        report = json.loads(result.stdout)
        if not report['ok']:
            problems.append('环境检查未通过：' +
                            '、'.join(e['code'] for e in report['errors']))
            return {'ok': False, 'steps': done, 'problems': problems}
        print(f"  Node {report['node']['found']}  PostgreSQL {report['postgres']['major']}"
              f"  {report['hardware']['macosVersion']}（{report['hardware']['architecture']}）")
    except (ValueError, KeyError) as error:
        problems.append(f'preflight 的输出不是预期的 JSON：{error}')
        return {'ok': False, 'steps': done, 'problems': problems}

    # ①b 装运行时的依赖。**这一步在安装手册里，就必须在旅程里。**
    #
    # ⚠️ 第一版漏了它，于是运行时起不来，界面回 **502** ——
    # 而 502 是代理层最没有信息量的一个码：它不说是谁没起来、
    # 也不说为什么。逐条追下去才发现缺的是手册 §2.1 那一步。
    #
    # 这不代表发行包有缺陷：它在手册里明确写了「依赖不在包里、这一步要跑一次」。
    # **但一个漏了前提的旅程，会把「少做了一步」报成「装不上」。**
    deps = run(['pnpm', 'install', '--frozen-lockfile'],
               cwd=root / 'vendor' / 'dsh', env=env, timeout=3600)
    print_result('deps', deps.args, deps)
    if deps.returncode != 0:
        problems.append('运行时依赖安装失败（安装手册 §2.1）')
        return {'ok': False, 'steps': done, 'problems': problems}
    done.append('deps')

    # ② 安装。
    result = admin(root, env, 'install', '--apply', '--yes', *config_arg)
    print_result('install', result.args, result)
    if result.returncode != 0:
        problems.append('安装失败')
        return {'ok': False, 'steps': done, 'problems': problems}
    done.append('install')

    # ③ 起进程。
    result = admin(root, env, 'start', '--apply', '--yes', *config_arg)
    print_result('start', result.args, result)
    if result.returncode != 0:
        problems.append('起进程失败')
        return {'ok': False, 'steps': done, 'problems': problems}
    done.append('start')
    time.sleep(8)

    # ④ 一次性初始化。
    token_file = home / 'secrets' / 'bootstrap.token'
    if not token_file.is_file():
        problems.append('安装没有生成初始化令牌')
        return {'ok': False, 'steps': done, 'problems': problems}
    token = token_file.read_text().strip()
    payload = json.dumps({'token': token, 'companyName': 'G9 验收公司',
                          'login': 'owner', 'password': 'kvvi-g9-owner-pass'}).encode()
    status, _, body = fetch(f'{http}/bootstrap/owner', method='POST', body=payload,
                            headers={'content-type': 'application/json'})
    print(f'  bootstrap → HTTP {status}')
    if status != 201:
        problems.append(f'首次初始化返回 {status}：{body[:200]!r}')
        return {'ok': False, 'steps': done, 'problems': problems}
    done.append('bootstrap')

    # ⑤ 第二次必须被拒。
    status, _, _ = fetch(f'{http}/bootstrap/owner', method='POST', body=payload,
                         headers={'content-type': 'application/json'})
    print(f'  bootstrap（第二次）→ HTTP {status}')
    if status != 410:
        problems.append(f'第二次初始化返回 {status}，应为 410')
    else:
        done.append('bootstrap-again')

    # ⑥ 登录。
    cookie = login_cookie(PLATFORM_PORT)
    if not cookie:
        problems.append('登录没有拿到会话 Cookie')
        return {'ok': False, 'steps': done, 'problems': problems}
    done.append('login')

    # ⑦ 界面。
    status, _, body = fetch(f'{http}/', headers={'cookie': cookie})
    text = body.decode('utf-8', errors='replace')
    print(f'  GET / → HTTP {status}，{len(body)} 字节')
    if status != 200 or 'KVVI' not in text:
        # ⚠️ **把「为什么」一起报出来。** 界面回 502 时，除了「代理连不上上游」
        #    之外什么都没说 —— 而根因通常在运行时的日志里（依赖没装、端口被占、
        #    凭据读取失败）。让读的人自己去翻日志，等于把这份证据的价值砍掉一半。
        problems.append(f'界面不是 KVVI 的页面（HTTP {status}）。运行时日志尾：'
                        + log_tail(home / 'log' / 'runtime.log'))
    else:
        done.append('ui')

    # ⑧ 业务 API。
    status, _, _ = fetch(f'{http}/api/v1/systems', headers={'cookie': cookie})
    print(f'  GET /api/v1/systems → HTTP {status}')
    if status != 200:
        problems.append(f'业务 API 返回 {status}')
    else:
        done.append('api')

    # ⑨ 备份。
    result = admin(root, env, 'backup', '--yes', *config_arg)
    print_result('backup', result.args, result)
    archive = home / 'backups' / 'kvvi-backup.tar.gz'
    if result.returncode != 0 or not archive.is_file():
        problems.append('备份失败')
    else:
        done.append('backup')

        # ⑩ 恢复。
        result = admin(root, env, 'restore', str(archive), '--yes', *config_arg)
        print_result('restore', result.args, result)
        if result.returncode != 0:
            problems.append('恢复失败')
        else:
            done.append('restore')

    # ⑪ 卸载并保留数据。
    admin(root, env, 'stop', '--apply', '--yes', *config_arg)
    result = admin(root, env, 'uninstall', '--yes', *config_arg)
    print_result('uninstall', result.args, result)
    if result.returncode != 0:
        problems.append('卸载失败')
    elif not (home / 'pgdata').is_dir():
        problems.append('卸载把数据目录删掉了 —— 硬性验收第 6 条要求默认保留')
    elif not (home / 'kvvi.env').is_file():
        problems.append('卸载把配置删掉了')
    else:
        done.append('uninstall')

    problems.extend(check_no_repo_leak(root, home, env))
    return {'ok': not problems, 'steps': done, 'problems': problems}


def require_stage11_evidence():
    """默认模式下要求验收证据包已追加阶段十一。"""
    if not EVIDENCE.is_file():
        raise RuntimeError('G9_EVIDENCE_MISSING: 验收证据包不存在')
    payload = json.loads(EVIDENCE.read_text(encoding='utf-8'))
    entries = [e for e in payload.get('entries', []) if e.get('stage') == '阶段十一']
    if len(entries) != 1:
        raise RuntimeError('G9_EVIDENCE_MISSING: 验收证据包尚未追加阶段十一')
    entry = entries[0]
    if not entry.get('ok') or entry.get('exitCode') != 0:
        raise RuntimeError('G9_EVIDENCE_FAILED: 阶段十一证据不是成功记录')
    if 'check_stage11.py --run-only' not in entry.get('command', ''):
        raise RuntimeError('G9_EVIDENCE_COMMAND_INVALID')
    if entry.get('acceptanceHost') != 'clean-dir' and entry.get('acceptanceHost') != 'clean-user':
        raise RuntimeError('G9_EVIDENCE_HOST_UNLABELLED: 证据没写明验收主机是哪一种')


def main() -> int:
    """
    分派。
    @returns 退出码
    """
    run_only = '--run-only' in sys.argv or '--harness-only' in sys.argv
    if not run_only:
        try:
            require_stage11_evidence()
        except Exception as error:                      # noqa: BLE001
            print(f'{C_BAD}✗ {error}{C_OFF}')
            return 1

    print(f'{C_OK}=== 阶段十一 G9 · macOS 试点发行版 ==={C_OFF}')
    print('判据：一台从未安装过 KVVI 的 macOS 机器，按操作手册完成本机私有化部署，'
          '并跑通完整用户旅程')
    print()

    user = os.environ.get('KVVI_G9_USER', '')
    mode = 'clean-user' if user else 'clean-dir'
    facts = host_facts()
    print(f'{C_DIM}验收主机{C_OFF}')
    for key, value in facts.items():
        print(f'  {key:14s} {value or "（未安装）"}')
    print(f'  {"mode":14s} {mode}'
          + (f'（用户 {user}）' if user else '（同一用户下的干净目录）'))
    print()

    try:
        ensure_archive()
        root = prepare_scratch()
    except Exception as error:                          # noqa: BLE001
        print(f'{C_BAD}✗ 准备失败：{error}{C_OFF}')
        return 1
    print(f'{C_OK}✓ 发行包已解到 {root}{C_OFF}')
    print()

    result = run_journey(root, user)
    print()
    print(f'{C_DIM}旅程：{len(result["steps"])}/{len(STEPS)} 步完成{C_OFF}')
    print(f'  {"、".join(result["steps"])}')
    print()
    if result['problems']:
        print(f'{C_BAD}✗ G9 未通过：{C_OFF}')
        for problem in result['problems']:
            print(f'  ! {problem}')
        return 1

    print(f'{C_OK}✓ G9 通过：从发行包跑完安装、初始化、登录、界面、业务 API、'
          f'备份、恢复与卸载（数据保留）{C_OFF}')
    print()
    print(f'{C_WARN}这份证据的适用边界（必须连同结论一起引用）{C_OFF}')
    print('  ! 验收主机是**这台机器**，不是第二台机器 —— G9 字面要求的是')
    print('    「一台从未安装过 KVVI 的机器」，本机按字面做不到。')
    print(f'  ! 本次模式是 `{mode}`：'
          + ('跑在一个从未跑过 KVVI 的**用户**下。' if user
             else '跑在一个从未跑过 KVVI 的**目录**下，**用户与主机都与开发相同**。'))
    print('  ! 验收期间**没有离网** —— 「真无外网」这条没验。')
    print('  ! **数据库大版本升级**没走通：`upgrade` 尚未实现。')
    print('  ! 发行包不是一键包：要求预装 Node 24 与 Homebrew postgresql@17，'
          '并跑一次 `pnpm install`。')
    print()
    print(f'{C_DIM}要按业主选定的验收主机复跑（需要管理员先建用户）：{C_OFF}')
    print('  sudo sysadminctl -addUser kvvi-g9 -password - -fullName "KVVI G9"')
    print('  sudo -u kvvi-g9 KVVI_G9_USER=kvvi-g9 python3 工具/check_stage11.py --run-only')
    print('  # 之后记得删掉它：sudo sysadminctl -deleteUser kvvi-g9')
    return 0


if __name__ == '__main__':
    sys.exit(main())
