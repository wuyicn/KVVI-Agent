#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
数据库部署面隔离检查（N15、PRD §4.6.1）。

## 判据

§4.6.1 对审计库的三条「不共享」：

| 要求 | 在这里的落点 |
|---|---|
| 不共享**主机管理域** | 三个独立容器（各自生命周期与 root 环境） |
| 不共享**备份通道** | 三个独立 named volume |
| 不共享 **DBA** | 三个独立 superuser 口令 |

外加一条更硬的：三个库**都不应在对外网络上** —— 用 `internal: true` 的网络，
比「不映射端口」更强，因为前者连网关都没有。

## ⚠️ 它**不**主张什么

**三者仍在同一台主机上。** 「独立主机」是托管面的事，compose 决定不了。
本检查证明的是「容器 / 卷 / 口令三层已分开」，不是「已分实例部署」。

用法：

    python3 工具/check_db_isolation.py           # 静态（读 compose 配置）
    python3 工具/check_db_isolation.py --runtime # 另起三个库容器实测
"""

import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
COMPOSE = os.path.join(ROOT, 'docker-compose.kvvi.yml')
PROJECT = 'kvvi-dbcheck'

C_OK, C_BAD, C_WARN, C_DIM, C_OFF = '\033[32m', '\033[31m', '\033[33m', '\033[90m', '\033[0m'

DBS = ['platform-db', 'business-db', 'audit-db']


def sh(cmd, timeout=600):
    return subprocess.run(cmd, shell=True, cwd=ROOT, capture_output=True, text=True,
                          timeout=timeout)


def config() -> dict:
    env = ('KVVI_INTERNAL_TOKEN=x KVVI_PLATFORM_DB_PASSWORD=a '
           'KVVI_BUSINESS_DB_PASSWORD=b KVVI_AUDIT_DB_PASSWORD=c')
    r = sh('%s docker compose -f %s config --format json' % (env, COMPOSE))
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip()[:300])
    return json.loads(r.stdout)


def main() -> int:
    try:
        cfg = config()
    except Exception as exc:
        print('%s✗ 读不到 compose 配置：%s%s' % (C_BAD, exc, C_OFF))
        return 2

    services = cfg.get('services', {})
    volumes = cfg.get('volumes', {})
    networks = cfg.get('networks', {})
    problems = []

    print('%s=== 数据库部署面隔离 ===%s' % (C_OK, C_OFF))
    print('判据：§4.6.1「审计库不共享主机管理域 / 备份通道 / DBA」')
    print()

    print('[1] 三个库分属三个容器')
    for name in DBS:
        if name not in services:
            problems.append('缺少服务 %s' % name)
            print('  %s✗ %s 不存在%s' % (C_BAD, name, C_OFF))
        else:
            svc = services[name]
            ports = svc.get('ports') or []
            net = list((svc.get('networks') or {}).keys())
            print('  %s✓%s %-13s 端口 %s  网络 %s  卷 %s'
                  % (C_OK, C_OFF, name, ports or '无对外端口', net,
                     [v.get('source') for v in (svc.get('volumes') or [])]))
            if ports:
                problems.append('%s 映射了宿主端口' % name)
            if 'control' in net:
                problems.append('%s 挂在对外网络上' % name)

    print()
    print('[2] 三个库各有独立卷（备份通道不共享）')
    mounts = {}
    for name in DBS:
        for v in (services.get(name, {}).get('volumes') or []):
            mounts.setdefault(v.get('source'), []).append(name)
    for vol, users in mounts.items():
        if len(users) > 1:
            problems.append('卷 %s 被多个库共用：%s' % (vol, users))
            print('  %s✗ %s ← %s%s' % (C_BAD, vol, users, C_OFF))
        else:
            print('  %s✓%s %-18s ← %s' % (C_OK, C_OFF, vol, users[0]))
    if len(mounts) < 3:
        problems.append('卷数少于 3（实际 %d）' % len(mounts))

    print()
    print('[3] 三个库各有独立 superuser 口令（DBA 不共享）')
    # ⚠️ 口令**不能从 `compose config` 的渲染结果里判**：渲染会把
    # `${VAR:?}` 替换成实际值，于是「变量注入」与「硬编码」在渲染后长得一模一样。
    # 要判的是**源文件里怎么写的**，所以这里读原文。
    raw = open(COMPOSE, encoding='utf-8').read()
    import re as _re
    users = set()
    for name in DBS:
        # 该服务块内第一个 POSTGRES_PASSWORD
        block = raw.split('\n  %s:' % name, 1)
        seg = block[1].split('\n  # ──', 1)[0] if len(block) > 1 else ''
        m = _re.search(r'POSTGRES_PASSWORD:\s*(\S+)', seg)
        u = _re.search(r'POSTGRES_USER:\s*(\S+)', seg)
        source = m.group(1) if m else '<缺失>'
        users.add(u.group(1) if u else '')
        injected = source.startswith('"${')
        print('  %s%s%s %-13s user=%-20s 口令来源=%s'
              % (C_OK if injected else C_BAD, '✓' if injected else '✗', C_OFF,
                 name, u.group(1) if u else '?',
                 '环境注入' if injected else source))
        if not injected:
            problems.append('%s 的口令不是环境注入（%s）' % (name, source))
    if len(users) < 3:
        problems.append('三个库的 superuser 不是三个不同账号')

    print()
    print('[4] 数据库网络是对内的（连网关都没有，比「不映射端口」更硬）')
    data = networks.get('data', {})
    if data.get('internal'):
        print('  %s✓%s data 网络 internal=true%s' % (C_OK, C_OFF, C_OFF))
    else:
        problems.append('data 网络不是 internal')
        print('  %s✗ data 网络不是 internal%s' % (C_BAD, C_OFF))

    if '--runtime' in sys.argv:
        print()
        print('[5] 实测：起三个库容器，看它们各自独立且无对外可达')
        down = 'docker compose -f %s -p %s down -v' % (COMPOSE, PROJECT)
        sh(down)
        env = ('KVVI_INTERNAL_TOKEN=x KVVI_PLATFORM_DB_PASSWORD=a '
               'KVVI_BUSINESS_DB_PASSWORD=b KVVI_AUDIT_DB_PASSWORD=c')
        up = ('%s docker compose -f %s -p %s up -d %s'
              % (env, COMPOSE, PROJECT, ' '.join(DBS)))
        r = sh(up, timeout=600)
        if r.returncode != 0:
            print('  %s✗ 启动失败：%s%s' % (C_BAD, (r.stderr or r.stdout)[-300:], C_OFF))
            sh(down)
            return 1
        try:
            ids = sh('docker compose -f %s -p %s ps -q %s'
                     % (COMPOSE, PROJECT, ' '.join(DBS))).stdout.split()
            print('  ✓ 三个容器 id 互不相同：%s' % (len(set(ids)) == 3))
            if len(set(ids)) != 3:
                problems.append('三个库不是三个独立容器')
            probe = sh('docker inspect --format "{{.Name}} {{json .NetworkSettings.Ports}}" %s'
                       % ' '.join(ids))
            for line in probe.stdout.strip().splitlines():
                has_port = '"5432/tcp":[{' in line
                print('  %s %s' % ('%s✗%s' % (C_BAD, C_OFF) if has_port else
                                   '%s✓%s' % (C_OK, C_OFF), line.strip()[:90]))
                if has_port:
                    problems.append('%s 有宿主端口映射' % line.split()[0])
        finally:
            sh(down)

    print()
    print('%s本检查不主张什么%s' % (C_WARN, C_OFF))
    print('  · **三者仍在同一台主机上** —— 「独立主机」是托管面的事，不由 compose 决定')
    print('  · 备份通道「不共享」在卷层面成立；实际备份作业的编排不在本检查内')
    print()
    if problems:
        for p in problems:
            print('  %s✗ %s%s' % (C_BAD, p, C_OFF))
        print('%s✗ 未通过%s' % (C_BAD, C_OFF))
        return 1
    print('%s✓ 通过：容器 / 卷 / 口令三层已分开，且数据库无对外入口%s' % (C_OK, C_OFF))
    return 0


if __name__ == '__main__':
    sys.exit(main())
