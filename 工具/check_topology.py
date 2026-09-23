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

    # N3 的拓扑要求：**唯一对外入口**。platform 映射宿主端口，runtime 不映射。
    # 若 runtime 也映射，浏览器就能绕过那条请求分流直连它 —— 插件与认证流量
    # 重新同处一个可嗅探面，正是 PRD §4.6.5 要避免的。
    plat_ports = services.get('platform', {}).get('ports') or []
    run_ports = services.get('runtime', {}).get('ports') or []
    if plat_ports and not run_ports:
        print('  %s✓%s 唯一对外入口：platform 映射宿主端口，runtime 不映射'
              % (C_OK, C_OFF))
    else:
        ok = False
        print('  %s✗ 端口暴露不合要求：platform=%s runtime=%s%s'
              % (C_BAD, len(plat_ports), len(run_ports), C_OFF))
        print('  %s→ runtime 必须不映射宿主端口，否则可绕过请求分流直连%s' % (C_DIM, C_OFF))

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

    # ── N3：唯一入口与代理 ────────────────────────────────────────────
    print()
    print('%s[N3] 唯一入口与代理%s' % (C_OK, C_OFF))

    # 证据 1：直连 runtime 的宿主端口必须**失败** —— 证明它没暴露。
    port_r = os.environ.get('KVVI_RUNTIME_PORT', '7401')
    rc, out = run("curl -sS -o /dev/null -w '%%{http_code}' --max-time 5 'http://127.0.0.1:%s/'"
                  % port_r, timeout=15)
    if rc != 0 or out.strip() in ('000', ''):
        print('  %s✓%s 直连 runtime 宿主端口 %s 失败 —— 它没有对外暴露' % (C_OK, port_r, C_OFF))
    else:
        ok = False
        print('  %s✗ 直连 runtime 宿主端口 %s 得到 HTTP %s —— 它暴露了%s'
              % (C_BAD, port_r, out.strip(), C_OFF))
        print('  %s→ 浏览器可绕过请求分流直连它，违反 §4.6.5%s' % (C_DIM, C_OFF))

    # 证据 2：经 platform 能拿到 DSH web 的响应 —— 代理是通的。
    # 判据是「收到了 DSH web 的认证提示」而不是某个具体状态码：
    # 无 token 时 DSH 返回 401 + 那句提示，那正说明请求到达了运行时进程。
    port_p = os.environ.get('KVVI_PLATFORM_PORT', '7400')
    rc, body = run("curl -sS --max-time 10 'http://127.0.0.1:%s/'"
                   % port_p, timeout=20)
    if rc == 0 and 'dsh web authentication required' in body:
        print('  %s✓%s 经 platform 访问到达 DSH web（收到其认证提示）' % (C_OK, C_OFF))
    else:
        ok = False
        print('  %s✗ 经 platform 未到达 DSH web（%r）%s' % (C_BAD, body[:120], C_OFF))

    # 证据 3：端到端 —— 从 runtime 日志取 token，经 platform 带 token 访问，
    # 必须拿到**真正的页面**。前两条只证明「转发在发生」，这条证明「转发是对的」。
    #
    # 判据是「跟随重定向后 200 且标题为 KVVI」，不是「第一次响应是 2xx」：
    # DSH 收到 token 后回 303 把 token 从 URL 移走并换 cookie，那是**认证成功**
    # 的正常表现。早先版本只认 2xx，把一个完全正常的流程判成失败 ——
    # 假红会训练人忽略检查结果，比没有检查更坏。
    rc, logs = dc('logs', '--no-log-prefix', 'runtime', timeout=60)
    m = re.search(r'\?token=([A-Za-z0-9_\-]+)', logs or '')
    if not m:
        ok = False
        print('  %s✗ runtime 日志里找不到 web token —— 无法做端到端取证%s' % (C_BAD, C_OFF))
    else:
        token = m.group(1)
        rc, body = run(
            "curl -sS -L --max-time 20 -c /tmp/kvvi-e2e-cookies "
            "'http://127.0.0.1:%s/?token=%s'" % (port_p, token), timeout=30)
        rc2, code2 = run(
            "curl -sS -o /dev/null -w '%%{http_code}' --max-time 10 "
            "-b /tmp/kvvi-e2e-cookies 'http://127.0.0.1:%s/'" % port_p, timeout=20)
        if rc == 0 and '<title>KVVI' in body and code2.strip().startswith('2'):
            print('  %s✓%s 端到端：经 platform 带 token 拿到 KVVI 页面，'
                  '换 cookie 后复访 HTTP %s' % (C_OK, C_OFF, code2.strip()))
        else:
            ok = False
            print('  %s✗ 端到端失败：复访 HTTP %r；页面含 KVVI 标题=%s%s'
                  % (C_BAD, code2.strip(), '<title>KVVI' in body, C_OFF))

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
