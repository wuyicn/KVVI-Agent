#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
阶段六验收检查器 —— 锚点①②③④。

| 锚点 | 判据 | 落在哪里 |
|---|---|---|
| ① | 家具「报货申请」样例端到端（`0C-6`） | `工具/行业包.py` |
| ② | 黄金样例 10 组反复跑，结果稳定（`0D-2`） | `工具/黄金样例.py --check` |
| ③ | 双网关隔离负向测试（`0D-7` 隔离部分） | `services/platform/tests/gateway.test.mjs` |
| ④ | 访客路径全部测试（§3.5） | `services/platform/tests/visitor.test.mjs` |

用法：

    python3 工具/check_stage6.py

退出码：`0` = 全部锚点通过 / `1` = 有不通过 / `2` = 无法执行
"""

import os
import re
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PLATFORM = os.path.join(ROOT, 'services', 'platform')
CONTAINER = 'kvvi-stage6-pg'
PORT = '55432'
PASSWORD = 'kvvi-test'

C_OK, C_BAD, C_WARN, C_DIM, C_OFF = '\033[32m', '\033[31m', '\033[33m', '\033[90m', '\033[0m'

ANCHORS = [
    ('③', '双网关隔离：工具串用/数据旁路/自授权/自审批', r'锚点③'),
    ('④', '访客路径：签发资格、行范围与归属、越权关联、限流', r'锚点④'),
]

GAPS = [
    '0C-3「子表 / 关联 / **文件上传**」只做了**明细行**（节点级 loop）；'
    '附件上传未实现 —— 它被 §Q19 移出首版的是「文件上传」后半，本条只覆盖前两半',
    '0C-4 审批流只做到**契约层**（workflow-spec Spec）；'
    '运行时的「发起 → 通过/驳回」状态迁移执行器未实现（属阶段七之后的运行时）',
    '0D-5 付款 Fake 流程未做（已移出首版）',
    '访客界面（§7.1 阶段六「交付访客界面并完成端到端」）未做 —— '
    '本阶段交付的是访客**后端接口与全部负向测试**，界面属前端交付物',
    '§3.5.3「确认界面须标注来源」未做（没有确认界面）',
    '§9.11.3 的账号/工具维度限流未实现；访客维度已实现（§3.5.2 四维度）',
]


def sh(args, **kw):
    return subprocess.run(args, capture_output=True, text=True, **kw)


def start_db() -> bool:
    sh(['docker', 'rm', '-f', CONTAINER, 'kvvi-stage5-pg', 'kvvi-stage4-pg'])
    r = sh(['docker', 'run', '-d', '--name', CONTAINER,
            '-e', f'POSTGRES_PASSWORD={PASSWORD}', '-e', 'POSTGRES_USER=kvvi',
            '-p', f'127.0.0.1:{PORT}:5432', 'postgres:17-alpine'])
    if r.returncode != 0:
        print('%s✗ 起不了 PostgreSQL：%s%s' % (C_BAD, (r.stderr or r.stdout).strip()[:160], C_OFF))
        return False
    for _ in range(60):
        if sh(['docker', 'exec', CONTAINER, 'pg_isready', '-U', 'kvvi']).returncode == 0:
            return True
        time.sleep(0.5)
    return False


def run_tool(args) -> tuple:
    r = subprocess.run(['python3'] + args, cwd=ROOT, capture_output=True, text=True, timeout=900)
    return r.returncode, r.stdout


def main() -> int:
    if sh(['docker', 'info', '--format', '{{.ServerVersion}}']).returncode != 0:
        print('%s✗ Docker 不可用%s' % (C_BAD, C_OFF))
        return 2

    print('%s=== 阶段六验收 ===%s' % (C_OK, C_OFF))
    print('判据：①家具样例 ②黄金样例 ③双网关隔离 ④访客路径')
    print()

    failed = []

    print('[1] 锚点① 家具「报货申请」样例（行业扩展包，不改地基）')
    code, out = run_tool([os.path.join(ROOT, '工具', '行业包样例.py'), '--check'])
    if code == 0:
        print('  %s✓%s 包内文件与生成结果一致' % (C_OK, C_OFF))
    else:
        print('  %s✗ 包内文件被手改过%s' % (C_BAD, C_OFF))
        failed.append('①')
    code, out = run_tool([os.path.join(ROOT, '工具', '行业包.py')])
    tail = [l for l in out.splitlines() if l.strip()][-1:]
    if code == 0:
        print('  %s✓%s %s' % (C_OK, C_OFF, re.sub(r'\x1b\[[0-9;]*m', '', tail[0])))
        print('     %s地基 10 个组件逐项未改动 —— 这是「不进地基」的执行点%s'
              % (C_DIM, C_OFF))
    else:
        print('  %s✗ 行业包检查未通过%s' % (C_BAD, C_OFF))
        for line in out.splitlines()[-6:]:
            print('     %s' % line)
        failed.append('①')

    print()
    print('[2] 锚点② 黄金样例（10 组标准需求）')
    code, out = run_tool([os.path.join(ROOT, '工具', '黄金样例.py'), '--check'])
    tail = [l for l in out.splitlines() if l.strip()][-1:]
    if code == 0:
        print('  %s✓%s %s' % (C_OK, C_OFF, re.sub(r'\x1b\[[0-9;]*m', '', tail[0])))
        print('     %s⚠️ 「稳定」= 装配确定性（同一输入两次逐字节一致）；'
              '不主张「模型十次给出同一份蓝图」%s' % (C_WARN, C_OFF))
    else:
        print('  %s✗ 黄金样例未通过%s' % (C_BAD, C_OFF))
        for line in out.splitlines()[-6:]:
            print('     %s' % line)
        failed.append('②')

    print()
    print('[3] 起一次性 PostgreSQL（锚点③④）')
    if not start_db():
        return 2
    env = dict(os.environ)
    env.update({'KVVI_DEV_KEYS': '1', 'KVVI_SIGNING_KEY_PATH': '/tmp/kvvi-stage6-signing.key'})
    try:
        print('  ✓ %s 就绪' % CONTAINER)
        print()
        print('[4] 跑用例')
        r = subprocess.run(['node', '--test', '--test-reporter=tap', '--test-concurrency=1',
                            'tests/visitor.test.mjs', 'tests/gateway.test.mjs'],
                           cwd=PLATFORM, env=env, capture_output=True, text=True, timeout=1800)
        entries = []
        for raw in r.stdout.splitlines():
            m = re.match(r'^(\s*)(not ok|ok) \d+ - (.*)$', raw)
            if m:
                entries.append((len(m.group(1)), m.group(2) == 'ok', m.group(3).strip()))
        if not entries:
            print('  %s✗ 一个用例都没跑到%s' % (C_BAD, C_OFF))
            print((r.stderr or '')[-400:])
            return 2
        leaves = [e for i, e in enumerate(entries)
                  if not (i + 1 < len(entries) and entries[i + 1][0] > e[0])]
        print('  叶子用例 %d 条，通过 %d 条' % (len(leaves), sum(1 for e in leaves if e[1])))

        print()
        print('[5] 按锚点归集')
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
                for i in range(suite + 1, len(entries)):
                    if entries[i][0] <= depth:
                        break
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
    finally:
        sh(['docker', 'rm', '-f', CONTAINER])

    print()
    print('%s本阶段未覆盖%s' % (C_WARN, C_OFF))
    for gap in GAPS:
        print('  · %s' % gap)

    print()
    if failed or any(not ok for _d, ok, _n in entries):
        print('%s✗ 阶段六未通过：%s%s' % (C_BAD, '、'.join(str(f) for f in failed), C_OFF))
        return 1
    print('%s✓ 阶段六全部锚点通过（4/4：①②③④）%s' % (C_OK, C_OFF))
    return 0


if __name__ == '__main__':
    sys.exit(main())
