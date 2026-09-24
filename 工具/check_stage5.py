#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
阶段五验收检查器 —— 锚点①②③④（门禁 G5）。

## 判据对照

| 锚点 | 判据 | 落在哪里 |
|---|---|---|
| ① | §9.2 差分测试（UI 与 Agent 同一端点，结论一致） | `tests/diff.test.mjs` |
| ② | §9.3.1/§9.4.1/§9.4.2/§9.4.3/§9.4.4/§9.4.5/§9.7.3 全部负向测试 | `tests/token.test.mjs` |
| ③ | §9.6.4.1 的 R1/R2/R3 逐项验证 | `tests/risk.test.mjs` |
| ④ | 交付包完整性（组件清单、版本、指纹可核验） | `工具/交付包.py --check` |

## 与阶段四检查器的分工

阶段四起一次性 PostgreSQL、跑用例、按锚点归集；本检查器沿用同一套装置，
只换锚点映射。**不重复实现**，避免两个脚本各自解释一遍「什么叫通过」。

用法：

    python3 工具/check_stage5.py

退出码：`0` = 全部锚点通过 / `1` = 有不通过 / `2` = 无法执行
"""

import os
import re
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PLATFORM = os.path.join(ROOT, 'services', 'platform')
CONTAINER = 'kvvi-stage5-pg'
PORT = '55432'
PASSWORD = 'kvvi-test'

C_OK, C_BAD, C_WARN, C_DIM, C_OFF = '\033[32m', '\033[31m', '\033[33m', '\033[90m', '\033[0m'

ANCHORS = [
    ('①', '§9.2 差分测试：UI 与 Agent 走同一执行点', r'锚点①'),
    ('②', '§9.3.1/§9.4.x/§9.7.3 负向测试', r'锚点②'),
    ('③', '§9.6.4.1 风险分级 R1/R2/R3', r'锚点③'),
]

GAPS = [
    '§9.6.3 发布通道本身（文档的发布、差异报告展示、批准记录）未实现 —— '
    '本阶段做的是「发布前必须过的校验」，不是「发布这个动作」',
    '§9.6.7 搭建者不得为自己配置业务权限：未实现',
    '§3.5 访客路径（签发资格、行范围、归属篡改、越权关联）未实现 —— '
    '§9.4.4 的访客链接缓存 TTL 已按同一配置项落地，但访客功能本身属阶段六',
    '§9.4.1 的残留项：**插件可冒用活跃会话的既有令牌**不防（PRD 自述），'
    '本阶段只保证「声明不可伪造」与「单令牌 ≤5 分钟」',
    '§9.4.4 的「恢复后补传撤销与版本变更、并对窗口期内操作补做校验」未实现',
    '§9.6.4.1 的 R3 阈值只有一个全局常量，未做成「与聚合口径同源」的配置',
]


def sh(args, **kw):
    return subprocess.run(args, capture_output=True, text=True, **kw)


def start_db() -> bool:
    # 先把**另一个阶段**的同端口容器也清掉：两个检查器用同一个端口，
    # 上一个没清理干净时，报错会是「容器网络起不来」——
    # 那个报错看起来像 Docker 坏了，实际是端口被占。
    sh(['docker', 'rm', '-f', CONTAINER, 'kvvi-stage4-pg'])
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
    return False


def stop_db():
    sh(['docker', 'rm', '-f', CONTAINER])


def main() -> int:
    if sh(['docker', 'info', '--format', '{{.ServerVersion}}']).returncode != 0:
        print('%s✗ Docker 不可用 —— 阶段五的执行点在数据库上，没有库就判不了%s' % (C_BAD, C_OFF))
        return 2

    print('%s=== 阶段五验收 ===%s' % (C_OK, C_OFF))
    print('判据：①差分测试 ②契约授权负向测试 ③风险分级 ④交付包完整性')
    print()
    print('[1] 起一次性 PostgreSQL')
    if not start_db():
        return 2
    print('  ✓ %s 就绪' % CONTAINER)

    env = dict(os.environ)
    env.update({
        'KVVI_DEV_KEYS': '1',
        'KVVI_SIGNING_KEY_PATH': '/tmp/kvvi-stage5-signing.key',
    })

    failed = []
    try:
        print()
        print('[2] 迁移')
        r = subprocess.run(['node', 'src/migrate.mjs'], cwd=PLATFORM, env={**env, 'KVVI_RESET': '1'},
                           capture_output=True, text=True, timeout=600)
        if r.returncode != 0:
            print('  %s✗ 迁移失败：%s%s' % (C_BAD, (r.stderr or r.stdout)[-300:], C_OFF))
            return 2
        print('  ✓ 三库 + RLS + 审计链就绪')

        print()
        print('[3] 跑用例')
        r = subprocess.run(['node', '--test', '--test-reporter=tap', '--test-concurrency=1',
                            'tests/*.test.mjs'],
                           cwd=PLATFORM, env=env, capture_output=True, text=True, timeout=1800)
        tap = r.stdout

        entries = []
        for raw in tap.splitlines():
            m = re.match(r'^(\s*)(not ok|ok) \d+ - (.*)$', raw)
            if m:
                entries.append((len(m.group(1)), m.group(2) == 'ok', m.group(3).strip()))
        if not entries:
            print('  %s✗ 一个用例都没跑到%s' % (C_BAD, C_OFF))
            print((r.stderr or '')[-500:])
            return 2
        leaves = [e for i, e in enumerate(entries)
                  if not (i + 1 < len(entries) and entries[i + 1][0] > e[0])]
        print('  叶子用例 %d 条，通过 %d 条'
              % (len(leaves), sum(1 for e in leaves if e[1])))

        print()
        print('[4] 按锚点归集')
        consumed = set()
        for num, title, pattern in ANCHORS:
            suites = [i for i, (_d, _ok, name) in enumerate(entries)
                      if name and re.search(pattern, name)]
            if not suites:
                print('%s锚点%s%s %s' % (C_BAD, num, C_OFF, title))
                print('    ✗ 没有任何用例归到这个锚点 —— 它是「没测」，不是「通过」')
                failed.append(num)
                continue
            kids = []
            for suite in suites:
                depth = entries[suite][0]
                consumed.add(suite)
                for i in range(suite + 1, len(entries)):
                    if entries[i][0] <= depth:
                        break
                    consumed.add(i)
                    kids.append(entries[i])
            bad = [name for _d, ok, name in kids if not ok]
            if bad or not kids:
                print('%s锚点%s%s %s' % (C_BAD, num, C_OFF, title))
                for name in bad:
                    print('    ✗ %s' % name)
                failed.append(num)
            else:
                print('%s锚点%s%s %s' % (C_OK, num, C_OFF, title))
                print('    %s✓ %d 条用例全部通过%s' % (C_DIM, len(kids), C_OFF))

        print()
        print('[5] 交付包完整性（锚点④ / 门禁 G5）')
        r = subprocess.run(['python3', os.path.join(ROOT, '工具', '交付包.py'), '--check'],
                           capture_output=True, text=True, timeout=600)
        tail = [line for line in r.stdout.splitlines() if line.strip()][-1:] or ['']
        if r.returncode == 0:
            print('%s锚点④%s 交付包完整性' % (C_OK, C_OFF))
            print('    %s✓ %s%s' % (C_DIM, re.sub(r'\x1b\[[0-9;]*m', '', tail[0]), C_OFF))
        else:
            print('%s锚点④%s 交付包完整性' % (C_BAD, C_OFF))
            for line in r.stdout.splitlines()[-8:]:
                print('    %s' % line)
            failed.append('④')

        print()
        print('%s本阶段未覆盖%s' % (C_WARN, C_OFF))
        for gap in GAPS:
            print('  · %s' % gap)

        print()
        if failed or any(not ok for _d, ok, _n in entries):
            print('%s✗ 阶段五未通过：%s%s' % (C_BAD, '、'.join(str(f) for f in failed), C_OFF))
            return 1
        print('%s✓ 阶段五全部锚点通过（4/4：①②③④）%s' % (C_OK, C_OFF))
        return 0
    finally:
        stop_db()


if __name__ == '__main__':
    sys.exit(main())
