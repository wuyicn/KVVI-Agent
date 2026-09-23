#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
两进程骨架取证 —— PRD §4.6.5 与阶段一锚点 ②⑥ 的机器可检证据。

锚点②：Docker 一键启动后健康检查通过。
锚点⑥：Docker 骨架中平台服务进程与 Agent 运行时进程分离，且平台服务进程不加载任何插件。

判据的来源是 PRD §9.4.1 —— 它把「平台服务进程不加载任何插件」列为
**可核验的启动配置**。所以本工具不接受任何自我声称，只接受两类事实：

  1. 镜像/容器里到底有没有 DSH 包（文件系统事实）
  2. profile 组合出来到底有多少插件行（启动配置事实）

「没有包」比「选择不加载」强得多：前者是能力缺失，后者是纪律承诺。
本工具按前者取证。

用法：
  python3 工具/check_topology.py          # 取证并给出裁决
  python3 工具/check_topology.py --static # 只查 compose 配置（不需要容器在跑）
"""

import json
import os
import re
import subprocess
import sys
from typing import Dict, List, Optional, Tuple

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
COMPOSE = os.path.join(ROOT, 'docker-compose.kvvi.yml')
ENV_FILE = os.path.join(ROOT, '.kvvi-docker.env')

C_OK, C_BAD, C_WARN, C_DIM, C_OFF = '\033[32m', '\033[31m', '\033[33m', '\033[90m', '\033[0m'
DSH_SCOPE = '@deepseek-ai'


def run(cmd: str, timeout: int = 60) -> Tuple[Optional[int], str]:
    try:
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True,
                           timeout=timeout, cwd=ROOT)
        return r.returncode, (r.stdout + r.stderr).strip()
    except subprocess.TimeoutExpired:
        return None, 'TIMEOUT'
    except Exception as e:  # noqa: BLE001 - 命令不存在等，按失败处理并显示原因
        return -1, str(e)


def compose_env() -> str:
    """compose 需要的变量。没有 env 文件时给一个占位，静态检查不依赖它。"""
    token = 'static-check-token'
    if os.path.exists(ENV_FILE):
        for line in open(ENV_FILE, encoding='utf-8'):
            if line.startswith('KVVI_INTERNAL_TOKEN='):
                token = line.split('=', 1)[1].strip()
    return token


def dc(*args: str, timeout: int = 60) -> Tuple[Optional[int], str]:
    q = ' '.join('"%s"' % a for a in args)
    # --env-file 只在文件存在时传：compose 对不存在的 env 文件直接报错，
    # 而没有 env 文件是完全正常的（首次静态检查时它还没被 kvvi-up.sh 生成）。
    env_part = '--env-file "%s"' % ENV_FILE if os.path.exists(ENV_FILE) else ''
    return run('KVVI_INTERNAL_TOKEN=%s docker compose -f "%s" %s %s'
               % (compose_env(), COMPOSE, env_part, q), timeout=timeout)


def compose_json() -> Optional[dict]:
    rc, out = dc('config', '--format', 'json')
    if rc != 0 or not out:
        return None
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        return None


# ── 静态：compose 配置 ──────────────────────────────────────────────

def check_static() -> bool:
    print('%s[静态] compose 配置%s' % (C_OK, C_OFF))
    cfg = compose_json()
    if cfg is None:
        print('  %s✗ 无法读取 compose 配置%s' % (C_BAD, C_OFF))
        return False

    ok = True
    services = cfg.get('services', {})

    want = {'platform', 'runtime'}
    got = set(services)
    if got == want:
        print('  %s✓%s 两个进程各为一个 service：%s' % (C_OK, C_OFF, ', '.join(sorted(got))))
    else:
        ok = False
        print('  %s✗ service 集合是 %s，期望 %s%s' % (C_BAD, sorted(got), sorted(want), C_OFF))

    # 无共享可写文件系统：两边的卷 source 不得相交
    mounts: Dict[str, List[str]] = {}
    for name, spec in services.items():
        srcs = [v['source'] for v in spec.get('volumes', []) if isinstance(v, dict) and 'source' in v]
        mounts[name] = srcs
    shared = set(mounts.get('platform', [])) & set(mounts.get('runtime', []))
    if shared:
        ok = False
        print('  %s✗ 两进程共享了卷 %s —— 违反 §4.6.5「无共享可写文件系统」%s'
              % (C_BAD, sorted(shared), C_OFF))
    else:
        print('  %s✓%s 无共享卷：platform=%s  runtime=%s'
              % (C_OK, C_OFF, mounts.get('platform') or '无', mounts.get('runtime') or '无'))

    # 禁止跨进程调试：不得共享 pid / ipc / network namespace
    bad_ns = [n for n, s in services.items() if s.get('pid') == 'host' or s.get('ipc') == 'host']
    if bad_ns:
        ok = False
        print('  %s✗ %s 共享了宿主 pid/ipc namespace —— 违反「禁止跨进程调试」%s'
              % (C_BAD, bad_ns, C_OFF))
    else:
        print('  %s✓%s 未共享 pid/ipc namespace（禁止跨进程调试）' % (C_OK, C_OFF))

    # 接口有调用方鉴别
    plat_env = services.get('platform', {}).get('environment', {}) or {}
    if 'KVVI_INTERNAL_TOKEN' in plat_env:
        print('  %s✓%s platform 受控接口要求调用方鉴别（KVVI_INTERNAL_TOKEN）' % (C_OK, C_OFF))
    else:
        ok = False
        print('  %s✗ platform 未要求调用方鉴别 —— 违反「接口有调用方鉴别」%s' % (C_BAD, C_OFF))

    # 部署基线：禁止提权
    for n, s in services.items():
        if 'no-new-privileges:true' in (s.get('security_opt') or []):
            print('  %s✓%s %s 设置 no-new-privileges' % (C_OK, C_OFF, n))
        else:
            ok = False
            print('  %s✗ %s 未设置 no-new-privileges%s' % (C_BAD, n, C_OFF))
    return ok


# ── 动态：运行状态 ─────────────────────────────────────────────────

def container_state(name: str) -> str:
    rc, out = dc('ps', '--format', 'json', timeout=30)
    if rc != 0:
        return 'unknown'
    for line in out.splitlines():
        try:
            d = json.loads(line)
        except json.JSONDecodeError:
            continue
        if d.get('Service') == name:
            return (d.get('Health') or d.get('State') or 'unknown').lower()
    return 'absent'


def http_json(url: str, timeout: int = 15) -> Optional[dict]:
    rc, out = run("curl -fsS --max-time %d '%s'" % (timeout, url), timeout=timeout + 5)
    if rc != 0 or not out:
        return None
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        return None


def check_dynamic() -> bool:
    print()
    print('%s[动态] 运行状态%s' % (C_OK, C_OFF))
    ok = True

    # 锚点②：健康检查通过
    for name in ('platform', 'runtime'):
        st = container_state(name)
        if st == 'healthy':
            print('  %s✓%s %s 容器 healthy' % (C_OK, C_OFF, name))
        else:
            ok = False
            print('  %s✗ %s 容器状态是 %r（期望 healthy）%s' % (C_BAD, name, st, C_OFF))

    # 锚点⑥ 证据链 1：容器里根本没有 DSH 包
    rc, out = dc('exec', '-T', 'platform', 'sh', '-c',
                 'ls node_modules/%s 2>&1 || echo NONE' % DSH_SCOPE, timeout=30)
    if rc == 0 and 'NONE' in out:
        print('  %s✓%s platform 容器内无 %s/ 目录 —— 加载不了插件是能力缺失' % (C_OK, DSH_SCOPE, C_OFF))
    elif rc == 0 and out:
        ok = False
        print('  %s✗ platform 容器内存在 DSH 包：%s%s' % (C_BAD, out[:200], C_OFF))
    else:
        ok = False
        print('  %s✗ 无法在 platform 容器内检查 DSH 包：%s%s' % (C_BAD, out[:200], C_OFF))

    # 锚点⑥ 证据链 2：平台进程自报的插件数（推导值，非断言）
    port = os.environ.get('KVVI_PLATFORM_PORT', '7400')
    health = http_json('http://127.0.0.1:%s/healthz' % port)
    if health is None:
        ok = False
        print('  %s✗ 读不到 platform /healthz%s' % (C_BAD, C_OFF))
    elif health.get('pluginsLoaded') == 0:
        print('  %s✓%s platform /healthz pluginsLoaded = 0（dshPackagesPresent=%s）'
              % (C_OK, C_OFF, health.get('dshPackagesPresent')))
    else:
        ok = False
        print('  %s✗ platform pluginsLoaded = %r，期望 0%s'
              % (C_BAD, health.get('pluginsLoaded'), C_OFF))

    # 锚点⑥ 对照：运行时进程确实加载了插件
    # 先问出 DSH_HOME，再拼绝对路径 —— **不经过 shell 变量**。
    #
    # 早先版本写的是 `sh -c 'grep ... "$DSH_HOME/..."'`，而那些参数会被
    # dc() 裹进双引号交给宿主 shell，于是 $DSH_HOME 在**宿主**上被展开成空串
    # （宿主没有这个变量），grep 去找 `/profile-tree.yml` 并返回 0。
    # 那是个**假红**，而且它长得像「profile 没组合上」，会把人引向完全错误的方向。
    # 转义层数很容易数错，所以这里索性换成不经 shell 的形式。
    rc_h, home = dc('exec', '-T', 'runtime', 'printenv', 'DSH_HOME', timeout=30)
    tree = os.path.join(home.strip() or '/data', 'profile-tree.yml')
    rc, out = dc('exec', '-T', 'runtime', 'grep', '-c', '^- id:', tree, timeout=30)
    rows: Optional[int] = None
    if rc == 0 and out.strip().isdigit():
        rows = int(out.strip())
    if rows is None:
        ok = False
        print('  %s✗ 读不到 runtime 的 profile 插件树：%s%s' % (C_BAD, out[:200], C_OFF))
    elif rows > 0:
        print('  %s✓%s runtime 组合出 %d 个插件行（对照：platform 0 个）' % (C_OK, C_OFF, rows))
    else:
        ok = False
        print('  %s✗ runtime 插件行为 0 —— profile 没组合上%s' % (C_BAD, C_OFF))

    # 运行时进程的 Web 服务真的在响应。
    #
    # 探针必须在**容器内**发：runtime 刻意不映射宿主端口（DSH 只允许它绑
    # 127.0.0.1，见 services/runtime/entrypoint.sh），所以从宿主探测必然失败。
    # 早先版本从宿主探 127.0.0.1:7401，报出来的是「Web UI 无响应」——
    # 那是**检查本身错**，不是服务错。
    #
    # 判据是「返回了 HTTP 状态」而不是 200：DSH web 自带 token 认证，
    # 无凭据时返回 401，那说明服务正常工作。用 200 判会让正常服务永远红。
    rc, out = dc('exec', '-T', 'runtime', 'node', '-e',
                 "fetch('http://127.0.0.1:7401/').then(r=>{"
                 "console.log('HTTP '+r.status);process.exit(r.status<500?0:1)"
                 "}).catch(e=>{console.log('ERR '+e.message);process.exit(1)})", timeout=40)
    if rc == 0 and 'HTTP' in out:
        code = out.split('HTTP')[1].strip().split()[0]
        print('  %s✓%s runtime Web 服务在响应（容器内 HTTP %s）' % (C_OK, C_OFF, code))
    else:
        ok = False
        print('  %s✗ runtime Web 服务无响应：%s%s' % (C_BAD, out[:120], C_OFF))

    return ok


def main() -> int:
    static_only = '--static' in sys.argv
    print('%s=== 两进程骨架取证（PRD §4.6.5 · 锚点 ②⑥）===%s' % (C_OK, C_OFF))
    print()
    results = [check_static()]
    if not static_only:
        results.append(check_dynamic())
    print()
    if all(results):
        print('%s✓ 通过%s' % (C_OK, C_OFF))
        return 0
    print('%s✗ 未通过 —— 上述标红项须处理%s' % (C_BAD, C_OFF))
    return 1


if __name__ == '__main__':
    sys.exit(main())
