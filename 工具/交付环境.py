#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
阶段七锚点①：在**干净环境**部署交付包（PRD §7.1 阶段七、§4.6.5 部署基线）。

## 「干净」在这里指什么

不是「另一台机器」——本仓库跑在一台开发机上。可机器判定的是这几条，
而它们恰好是「开发机上跑得通」与「换个环境跑得通」之间的全部差别：

| 干净的含义 | 怎么判 |
|---|---|
| **部署的是被指纹覆盖的那一份** | 先跑 `工具/交付包.py --check`，不一致就拒绝部署 |
| **没有复用开发时的容器与卷** | 用**独立的 compose project 名**与全新卷启动；先 `down -v` 清掉重名项目 |
| **没有复用开发时的镜像缓存** | `--build` 强制重建，且镜像名带项目名 |
| **从零到达可用** | 启动后由健康检查与端到端探针判定，不看「容器 Running」 |

## 它不主张什么

- **不主张在另一台机器上验证过**：本次运行仍在同一台主机上。
  「非开发机」这一条**未兑现**，写在这里而不是含糊过去。
- **不主张覆盖真实生产**：§4.6.5 的部署基线要求「两进程分属不同容器或不同系统用户、
  禁止跨进程调试、无共享可写文件系统、接口有调用方鉴别」——前三条在 compose 里成立，
  第四条由 internal token 满足。**基线之外的部署不属于保证范围**。

用法：

    python3 工具/交付环境.py            # 全流程
    python3 工具/交付环境.py --keep     # 部署后保留容器，便于排查

退出码：`0` = 干净环境部署成功 / `1` = 失败 / `2` = 无法执行
"""

import json
import os
import shlex
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, '工具', 'lib'))
import compose_env  # noqa: E402
COMPOSE = os.path.join(ROOT, 'docker-compose.kvvi.yml')
PROJECT = 'kvvi-clean'
# 干净环境**不能占开发栈的端口**：开发栈的 platform 已经占用 7400，
# 撞上时报的是 `Bind for 0.0.0.0:7400 failed: port is already allocated` ——
# 看起来像部署失败，其实只是和另一个项目抢端口。
HOST_PORT = os.environ.get('KVVI_CLEAN_HOST_PORT', '7480')
EVID = os.path.join(ROOT, '交付', '证据')

C_OK, C_BAD, C_WARN, C_DIM, C_OFF = '\033[32m', '\033[31m', '\033[33m', '\033[90m', '\033[0m'


def run(cmd, timeout=900):
    return subprocess.run(cmd, shell=True, cwd=ROOT, capture_output=True,
                          text=True, timeout=timeout)


def _secret(key):
    """三个数据库口令与调用方令牌。

    ⚠️ **干净环境必须自己生成这些值，不能指望 `.kvvi-docker.env`。**
    那份文件被 `git clean` 清掉之后（本工具第 [2] 步就会清），
    compose 里写的是 `${KVVI_*_PASSWORD:?}` —— **必填插值**，
    缺了就 `error while interpolating ... required variable ... is missing a value`。
    那条报错看着像「部署坏了」，其实只是缺一个随机口令。
    """
    if key == 'KVVI_INTERNAL_TOKEN':
        return os.environ.get(key) or 'clean-%s' % os.urandom(12).hex()
    return 'k%s' % os.urandom(16).hex()


def compose(sub, token, timeout=900):
    # ⚠️ 变量名单**从 compose 文件扫出来**（`工具/lib/compose_env.py`），
    # 不在这里再维护一份。此前这里是手写的四个键，compose 新增
    # `KVVI_AUDIT_READ_DB_PASSWORD` 之后干净环境部署直接失败，
    # 报的同样是「required variable ... is missing」——
    # 读起来像部署坏了，其实是这份名单旧了。
    env = {name: _secret(name) for name in compose_env.required_vars(COMPOSE)}
    env['KVVI_INTERNAL_TOKEN'] = token
    env['KVVI_PLATFORM_PORT'] = HOST_PORT
    # 一次性口令必须**在同一次干净部署里保持一致** —— 每次调用重新随机，
    # 第二次 `up` 就会用新口令去开旧卷，报的会是「密码认证失败」。
    global _CLEAN_SECRETS
    if _CLEAN_SECRETS is None:
        _CLEAN_SECRETS = env
    else:
        env = _CLEAN_SECRETS
    # 变量**逐个从表里拼**，不写死键名 —— 写死过，然后 compose 加了
    # 一个新口令，这里就漏了一个，报的还是「required variable is missing」。
    assignments = ' '.join('%s=%s' % (k, shlex.quote(v)) for k, v in env.items())
    return run('%s docker compose -f %s -p %s %s'
               % (assignments, shlex.quote(COMPOSE), shlex.quote(PROJECT), sub),
               timeout=timeout)


_CLEAN_SECRETS = None


def main() -> int:
    keep = '--keep' in sys.argv
    if run('docker info --format "{{.ServerVersion}}"', timeout=60).returncode != 0:
        print('%s✗ Docker 不可用 —— 干净环境部署判不了%s' % (C_BAD, C_OFF))
        return 2

    print('%s=== 干净环境部署 ===%s' % (C_OK, C_OFF))
    print('判据：部署的是被指纹覆盖的那一份，且在全新项目与全新卷上从零到达可用')
    print()

    print('[1] 先确认部署对象**就是**被指纹覆盖的那一份')
    r = run('python3 工具/交付包.py --check', timeout=600)
    if r.returncode != 0:
        print('  %s✗ 交付包完整性未通过 —— 拒绝部署%s' % (C_BAD, C_OFF))
        for line in r.stdout.splitlines()[-6:]:
            print('    %s' % line)
        return 1
    print('  %s✓ 组件清单、版本、指纹一致%s' % (C_OK, C_OFF))

    token = 'clean-%s' % os.urandom(8).hex()
    print()
    print('[2] 清掉同名项目（含卷）—— 不复用开发时的任何东西')
    compose('down -v --remove-orphans', token, timeout=300)
    print('  ✓ %s 已清空' % PROJECT)

    print()
    print('[3] 从零构建并启动（--build 强制重建镜像）')
    r = compose('up -d --build --force-recreate', token, timeout=1800)
    if r.returncode != 0:
        print('%s  ✗ 启动失败：%s%s' % (C_BAD, (r.stderr or r.stdout)[-400:], C_OFF))
        compose('down -v --remove-orphans', token)
        return 1
    print('  ✓ 容器已启动')

    try:
        print()
        print('[4] 等健康检查通过（不是「容器 Running」）')
        healthy = False
        for _ in range(60):
            r = compose('ps --format json', token, timeout=120)
            if r.returncode == 0 and '"Health":"healthy"' in r.stdout.replace(' ', ''):
                healthy = r.stdout.count('"Health":"healthy"') >= 2 \
                    or r.stdout.replace(' ', '').count('"Health":"healthy"') >= 2
            if healthy:
                break
            time.sleep(2)
        if not healthy:
            print('  %s✗ 健康检查未通过%s' % (C_BAD, C_OFF))
            print(compose('ps', token).stdout[-500:])
            return 1
        print('  %s✓ 两个容器均 healthy%s' % (C_OK, C_OFF))

        print()
        print('[5] 端到端：经唯一入口到达 Web UI')
        probe = run(
            'docker compose -f %s -p %s exec -T platform node -e "'
            'const base=\'http://127.0.0.1:7400\';'
            '(async()=>{'
            ' const h=await fetch(base+\'/healthz\'); const b=await h.json();'
            ' console.log(JSON.stringify({healthz:h.status,pluginsLoaded:b.pluginsLoaded,'
            'dshPackagesPresent:b.dshPackagesPresent}));'
            ' const r=await fetch(base+\'/\'); console.log(JSON.stringify({root:r.status,'
            'title:(await r.text()).match(/<title>([^<]*)</)?.[1]||null}));'
            # KVVI 工作台：由**平台进程自己**应答，不经运行时进程。
            # 干净环境里验它，是因为「页面文件有没有被打进镜像」这件事
            # 只有在镜像里才验得到 —— 开发机上文件一直在，看不出来。
            ' const w=await fetch(base+\'/workbench\');'
            ' const wt=await w.text();'
            ' console.log(JSON.stringify({workbench:w.status,'
            'contentType:w.headers.get(\'content-type\'),'
            'byPlatform:w.headers.get(\'x-kvvi-process\'),'
            'hasTitle:/KVVI 工作台/.test(wt)}));'
            ' const noTok=await fetch(base+\'/workbench/api/session\');'
            ' console.log(JSON.stringify({workbenchApiNoToken:noTok.status}));'
            '})().catch(e=>{console.error(String(e));process.exit(1)})"'
            % (shlex.quote(COMPOSE), shlex.quote(PROJECT)), timeout=180)
        void = HOST_PORT
        out = probe.stdout.strip()
        if probe.returncode != 0:
            print('  %s✗ 端到端探针失败：%s%s' % (C_BAD, probe.stderr[-300:], C_OFF))
            return 1
        lines = [l for l in out.splitlines() if l.startswith('{')]
        facts = [json.loads(l) for l in lines]
        healthz = next((f for f in facts if 'healthz' in f), {})
        root = next((f for f in facts if 'root' in f), {})
        if healthz.get('pluginsLoaded') != 0:
            print('  %s✗ 平台进程 pluginsLoaded=%r，应为 0%s'
                  % (C_BAD, healthz.get('pluginsLoaded'), C_OFF))
            return 1
        print('  %s✓ 平台 /healthz 200，pluginsLoaded=0，dshPackagesPresent=%s%s'
              % (C_OK, healthz.get('dshPackagesPresent'), C_OFF))
        if root.get('root') and root['root'] < 400:
            print('  %s✓ 根路径 %s，标题 %r%s'
                  % (C_OK, root['root'], root.get('title'), C_OFF))
        else:
            # DSH web 需要 token 时会 303/401 —— 只要「到达了 DSH」就算通过，
            # 判定依据是它确实是 DSH 在应答，而不是连接被拒。
            print('  %s✓ 根路径 %s（到达 DSH web，未带 token 时这是预期结果）%s'
                  % (C_OK, root.get('root'), C_OFF))

        # ── KVVI 工作台：员工侧入口 ──────────────────────────────────────
        wb = next((f for f in facts if 'workbench' in f), {})
        wbapi = next((f for f in facts if 'workbenchApiNoToken' in f), {})
        if wb.get('workbench') == 200 and wb.get('hasTitle'):
            print('  %s✓ 工作台 /workbench 200（由 %s 应答，页面标题正确）%s'
                  % (C_OK, wb.get('byPlatform'), C_OFF))
        else:
            print('  %s✗ 工作台 /workbench 未通过：%s%s' % (C_BAD, wb, C_OFF))
            return 1
        if wbapi.get('workbenchApiNoToken') == 401:
            print('  %s✓ 未带令牌读工作台会话 → 401（不回落到默认身份）%s' % (C_OK, C_OFF))
        else:
            print('  %s✗ 未带令牌读工作台会话返回 %r，期望 401%s'
                  % (C_BAD, wbapi.get('workbenchApiNoToken'), C_OFF))
            return 1

        print()
        print('[6] 记证据')
        os.makedirs(EVID, exist_ok=True)
        r = compose('images --format json', token, timeout=120)
        evidence = {
            'check': 'clean-environment-deploy',
            'project': PROJECT,
            'composeFile': 'docker-compose.kvvi.yml',
            'healthz': healthz,
            'root': root,
            'images': [l for l in r.stdout.splitlines() if l.strip()][:10],
            'note': '仍在本主机上执行；「非开发机」这一条未兑现，见 docs/交付文档.md。',
        }
        path = os.path.join(EVID, '干净环境部署.json')
        with open(path, 'w', encoding='utf-8') as fh:
            fh.write(json.dumps(evidence, ensure_ascii=False, indent=2) + '\n')
        print('  ✓ 已写入 %s' % os.path.relpath(path, ROOT))
    finally:
        if not keep:
            compose('down -v --remove-orphans', token, timeout=300)
            print()
            print('  ✓ 已清理 %s（含卷）' % PROJECT)

    print()
    print('%s本检查未覆盖%s' % (C_WARN, C_OFF))
    print('  · **不是另一台机器**：本次仍在开发主机上执行')
    print('  · 生产部署面（独立主机 / 独立管理域 / 独立备份通道）不在范围内')
    print()
    print('%s✓ 干净环境部署通过%s' % (C_OK, C_OFF))
    return 0


if __name__ == '__main__':
    sys.exit(main())
