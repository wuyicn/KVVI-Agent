#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
阶段四验收检查器 —— 锚点①③④⑥（②包含在隔离测试里）。

## 为什么要有它，而不是直接跑 `npm test`

`npm test` 给的是一个总数。「60 个用例通过」不能说明**哪个锚点**通过了，
也不能说明**哪些没测**。而这个项目的反复教训是：
**看起来绿的东西，常常只是没被问到。**

所以本检查器按**锚点**归集用例，并且：

1. 起一个**一次性的 PostgreSQL**（阶段四的隔离在数据库里，不是纯内存逻辑）；
2. 先跑迁移，再跑测试；
3. 按锚点报结果，**并把「未覆盖」显式列出来**；
4. 数据库起不来时报「无法执行」（退出码 2），**不报「通过」**。

## 锚点与用例的对应

| 锚点 | 判据 | 用例文件 |
|---|---|---|
| ① | 员工看不到搭建引擎（§9.6.5） | `auth.test.mjs` |
| ② | 跨公司 RLS 负向测试（§9.9.x） | `isolation.test.mjs` |
| ③ | 审计防篡改可验证（§9.11.2） | `audit.test.mjs` |
| ④ | 金额精度、单号唯一并发 | `ledger.test.mjs` |
| ⑥ | 认证端点闭合 + 五类事件（§4.6.5） | `auth.test.mjs` |
| — | 0B-4/5/7 表单/字段/流程权限（**非锚点**） | `permissions.test.mjs` |

用法：

    python3 工具/check_stage4.py            # 起库、迁移、跑测试、按锚点报告
    python3 工具/check_stage4.py --keep     # 保留容器，便于手工排查

退出码：`0` = 全部锚点通过 / `1` = 有锚点不通过 / `2` = 无法执行
"""

import json
import os
import re
import shutil
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PLATFORM = os.path.join(ROOT, 'services', 'platform')
CONTAINER = 'kvvi-stage4-pg'
PORT = '55432'
PASSWORD = 'kvvi-test'

C_OK, C_BAD, C_WARN, C_DIM, C_OFF = '\033[32m', '\033[31m', '\033[33m', '\033[90m', '\033[0m'

# 锚点 → (标题, 判定用正则：出现在测试名里即算该锚点的用例)
ANCHORS = [
    ('①', '员工看不到搭建引擎（§9.6.5）', r'锚点①'),
    ('②', '多公司隔离与数据范围（§9.9.x / 0B-3 / 0B-6）', r'锚点②'),
    ('③', '审计防篡改（§9.11.2）', r'锚点③'),
    ('④', '金额精确与单号唯一（0B-8 / 0B-9）', r'锚点④'),
    ('⑥', '认证端点闭合与会话五类事件（§4.6.5）', r'锚点⑥'),
]

# 明确列出的**未覆盖**项。不列出来，「通过」就会被读成「都做了」。
GAPS = [
    '§4.6.1 的部署面要求（审计库不共享主机管理域 / DBA / 备份通道）**未满足**：'
    '开发环境里三个库在同一实例上，逻辑隔离做到了，部署隔离没有',
    '账号生命周期与离职交接（PRD §3.3）未实现',
    '身份源适配器路口（PRD §3.4）未实现 —— 目前只有自建账号一种',
    '双网关的**完整闭环**（0D-7）属阶段四+六，本次只做了产品级分类与拒绝路径',
    '搭建者不得为自己配置业务权限（§9.6.7）未实现',
    '限流与配额（§9.11.3）未实现',
]


def sh(args, **kw):
    return subprocess.run(args, capture_output=True, text=True, **kw)


def docker_ok() -> bool:
    return sh(['docker', 'info', '--format', '{{.ServerVersion}}']).returncode == 0


def start_db() -> bool:
    """起一次性 PostgreSQL。已存在则复用。"""
    sh(['docker', 'rm', '-f', CONTAINER])
    r = sh(['docker', 'run', '-d', '--name', CONTAINER,
            '-e', f'POSTGRES_PASSWORD={PASSWORD}', '-e', 'POSTGRES_USER=kvvi',
            '-p', f'127.0.0.1:{PORT}:5432', 'postgres:17-alpine'])
    if r.returncode != 0:
        print('%s✗ 起不了 PostgreSQL：%s%s' % (C_BAD, (r.stderr or r.stdout).strip()[:200], C_OFF))
        return False
    for _ in range(60):
        if sh(['docker', 'exec', CONTAINER, 'pg_isready', '-U', 'kvvi']).returncode == 0:
            return True
        time.sleep(0.5)
    print('%s✗ PostgreSQL 起来了但一直不接受连接%s' % (C_BAD, C_OFF))
    return False


def stop_db():
    sh(['docker', 'rm', '-f', CONTAINER])


def run_step(args, env_extra=None, timeout=900):
    env = dict(os.environ)
    env.update(env_extra or {})
    return subprocess.run(args, cwd=PLATFORM, env=env, capture_output=True,
                          text=True, timeout=timeout)


def main() -> int:
    keep = '--keep' in sys.argv
    if not docker_ok():
        print('%s✗ Docker 不可用 —— 阶段四的隔离在数据库里，没有库就判不了%s' % (C_BAD, C_OFF))
        return 2
    if not os.path.isdir(os.path.join(PLATFORM, 'node_modules', 'pg')):
        print('%s✗ services/platform 没有装依赖 —— 先跑 npm install%s' % (C_BAD, C_OFF))
        return 2

    print('%s=== 阶段四验收 ===%s' % (C_OK, C_OFF))
    print('判据：锚点①②③④⑥ 逐项可执行；数据库起不来时报「无法执行」而不是「通过」')
    print()
    print('[1] 起一次性 PostgreSQL')
    if not start_db():
        return 2
    print('  ✓ %s 就绪（127.0.0.1:%s）' % (CONTAINER, PORT))

    try:
        print()
        print('[2] 迁移（建三库、建角色、建 RLS 策略、建审计链）')
        r = run_step(['node', 'src/migrate.mjs'], {'KVVI_RESET': '1'})
        if r.returncode != 0:
            print('%s  ✗ 迁移失败：%s%s' % (C_BAD, (r.stderr or r.stdout)[-300:], C_OFF))
            return 2
        done = next((l for l in r.stdout.splitlines() if 'kvvi-migrate-done' in l), '')
        print('  ✓ %s' % done[:160])

        print()
        print('[3] 跑用例')
        r = run_step(['node', '--test', '--test-reporter=tap',
                      '--test-concurrency=1', 'tests/*.test.mjs'])
        tap = r.stdout

        # ── 按锚点归集 ──────────────────────────────────────────────
        # TAP 用缩进表示嵌套：`ok` 行本身可能是 describe 而不是用例。
        # 只按名字匹配会把「一个 describe」当成「一条用例」，
        # 报出来的条数比实际少一个数量级 —— 那种数字会让人以为测得很少，
        # 也可能反过来让人觉得「条数够了」。所以按**缩进层级**归集。
        entries = []
        for raw in tap.splitlines():
            m = re.match(r'^(\s*)(not ok|ok) \d+ - (.*)$', raw)
            if m:
                entries.append((len(m.group(1)), m.group(2) == 'ok', m.group(3).strip()))
        if not entries:
            print('%s  ✗ 一个用例都没跑到 —— 这不是「通过」，是没跑起来%s' % (C_BAD, C_OFF))
            print((r.stderr or '')[-400:])
            return 2

        def subtree(index):
            """取某一行之下的全部更深层行。"""
            depth = entries[index][0]
            out = []
            for j in range(index + 1, len(entries)):
                if entries[j][0] <= depth:
                    break
                out.append(entries[j])
            return out

        leaves = [e for i, e in enumerate(entries)
                  if not any(x[0] > e[0] for x in entries[i + 1:i + 2])] \
            if False else [
                e for i, e in enumerate(entries)
                if not (i + 1 < len(entries) and entries[i + 1][0] > e[0])]
        print('  叶子用例 %d 条，通过 %d 条' % (len(leaves), sum(1 for ok, _ in
              [(e[1], e[2]) for e in leaves] if ok)))

        print()
        print('[4] 按锚点归集')
        failed_anchors = []
        consumed = set()
        for num, title, pattern in ANCHORS:
            # ⚠️ 同一个锚点可能有**多个** describe（⑥ 就是两个：端点闭合、
            # 五类事件）。只取第一个会漏掉一半用例，并给出一个偏小的数字 ——
            # 偏小的数字看起来像「测了一点」，其实是「漏了没报」。
            suites = [i for i, (_d, _ok, name) in enumerate(entries)
                      if name and re.search(pattern, name)]
            if not suites:
                print('%s锚点%s%s %s' % (C_BAD, num, C_OFF, title))
                print('    ✗ 没有任何用例归到这个锚点 —— 它是「没测」，不是「通过」')
                failed_anchors.append(num)
                continue
            kids = []
            for suite in suites:
                kids.extend(subtree(suite))
                consumed.add(suite)
                for i in range(suite + 1, len(entries)):
                    if entries[i][0] <= entries[suite][0]:
                        break
                    consumed.add(i)
            bad = [name for _d, ok, name in kids if not ok]
            if bad or not kids:
                print('%s锚点%s%s %s' % (C_BAD, num, C_OFF, title))
                for name in bad:
                    print('    ✗ %s' % name)
                if not kids:
                    print('    ✗ 该锚点下没有任何用例')
                failed_anchors.append(num)
            else:
                print('%s锚点%s%s %s' % (C_OK, num, C_OFF, title))
                print('    %s✓ %d 条用例全部通过%s' % (C_DIM, len(kids), C_OFF))

        others = [(ok, name) for i, (_d, ok, name) in enumerate(entries)
                  if i not in consumed
                  and not any(re.search(p, name) for _, _, p in ANCHORS)]
        if others:
            print()
            print('非锚点（阶段四内容项，不计入锚点判定）')
            for ok, name in others:
                mark = '%s✓%s' % (C_OK, C_OFF) if ok else '%s✗%s' % (C_BAD, C_OFF)
                print('  %s %s' % (mark, name[:96]))

        # ── 未覆盖项：必须与「通过」一起读 ─────────────────────────
        print()
        print('%s本阶段未覆盖%s' % (C_WARN, C_OFF))
        for gap in GAPS:
            print('  · %s' % gap)

        print()
        if failed_anchors or any(not ok for _d, ok, _n in entries):
            print('%s✗ 阶段四未通过%s' % (C_BAD, C_OFF))
            return 1
        print('%s✓ 阶段四全部锚点通过（5/5：①②③④⑥）%s' % (C_OK, C_OFF))
        return 0
    finally:
        if not keep:
            stop_db()


if __name__ == '__main__':
    sys.exit(main())
