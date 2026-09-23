#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
搭建 Skill 产出物的验收检查器 —— 阶段三锚点① 的可执行判据。

PRD §7.1 锚点①：「五个 Skill 的产出物**全部通过 MetaSchema 校验**」
PRD §5.6 判定标准：「如果一项产出**不能被 MetaSchema 校验**，它就不属于搭建引擎的产出」

本工具不自己实现校验 —— 它**调用官方验证器**（`tools/meta-schema/node/cli.mjs`），
因为「通过 MetaSchema 校验」的权威定义在那个验证器里，不在本文件里。
本项目已有的教训是：自制的判定器容易与权威实现漂移。

用法：
  python3 工具/check_skill_output.py <产出物.json> [--contract <名>] [--context <ctx.json>]
  python3 工具/check_skill_output.py --self-test

退出码：0 = 通过；1 = 未通过；2 = 无法执行（如验证器缺失）
"""

import json
import os
import subprocess
import sys
from typing import List, Optional, Tuple

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLI = os.path.join(ROOT, 'tools', 'meta-schema', 'node', 'cli.mjs')

C_OK, C_BAD, C_WARN, C_DIM, C_OFF = '\033[32m', '\033[31m', '\033[33m', '\033[90m', '\033[0m'

# 验证器只接受这三个契约。另外两个目标契约（workflow-spec / tool-spec）
# **不在其中** —— 这是任务卡里已记录的缺口，此处显式拒答而不是静默跳过。
SUPPORTED = ('business-schema/v1', 'view-schema/lce-safe-v1', 'app-spec/v1alpha1')

# cli.mjs 的退出码语义
EXIT_OK, EXIT_INVALID, EXIT_FAILED = 0, 2, 1


def run_cli(payload: bytes, contract: str, checks: str,
            context: Optional[str]) -> Tuple[int, dict]:
    args = ['node', CLI, '--contract', contract, '--entry', 'spec', '--checks', checks]
    if context:
        args += ['--context', context]
    r = subprocess.run(args, input=payload, capture_output=True, timeout=300)
    try:
        return r.returncode, json.loads(r.stdout.decode('utf-8'))
    except Exception:
        return r.returncode, {'_raw': (r.stdout + r.stderr).decode('utf-8', 'replace')[:400]}


def check(path: str, contract: str, context: Optional[str]) -> int:
    if not os.path.isfile(CLI):
        print('%s✗ 找不到验证器：%s%s' % (C_BAD, CLI, C_OFF))
        return 2
    if contract not in SUPPORTED:
        print('%s✗ 验证器不支持契约 %r%s' % (C_BAD, contract, C_OFF))
        print('  %s支持：%s%s' % (C_DIM, '、'.join(SUPPORTED), C_OFF))
        print('  %s→ 这是任务卡已记录的缺口（workflow-spec / tool-spec 无验证器入口），'
              '不是产出物的问题%s' % (C_DIM, C_OFF))
        return 2
    if not os.path.isfile(path):
        print('%s✗ 产出物不存在：%s%s' % (C_BAD, path, C_OFF))
        return 2

    payload = open(path, 'rb').read()
    print('%s=== 搭建产出验收 ===%s' % (C_OK, C_OFF))
    print('  产出物 : %s' % os.path.relpath(path, ROOT))
    print('  契约   : %s' % contract)
    print()

    ok = True

    print('%s[1/2] 结构校验%s' % (C_OK, C_OFF))
    code, doc = run_cli(payload, contract, 'structure', None)
    v = doc.get('validation', {})
    if 'execution' in doc:
        print('  %s✗ 执行失败：%s%s' % (C_BAD, doc['execution'], C_OFF))
        return 2
    if v.get('valid'):
        print('  %s✓%s 通过（stage=%s）' % (C_OK, C_OFF, doc.get('stage')))
    else:
        ok = False
        print('  %s✗ %d 个结构错误%s' % (C_BAD, len(v.get('errors', [])), C_OFF))
        for e in v.get('errors', [])[:10]:
            print('     %s | %s | %s' % (e.get('code'), e.get('path'),
                                         str(e.get('message'))[:60]))

    print()
    if not context:
        print('%s[2/2] 语义 + 引用校验 —— 跳过（未提供 --context）%s' % (C_WARN, C_OFF))
        print('  %s→ 只跑了结构校验。锚点① 要求「通过 MetaSchema 校验」，'
              '通常指完整校验，请提供 context%s' % (C_DIM, C_OFF))
    else:
        print('%s[2/2] 语义 + 引用校验%s' % (C_OK, C_OFF))
        code, doc = run_cli(payload, contract, 'complete', context)
        v = doc.get('validation', {})
        if 'execution' in doc:
            print('  %s✗ 执行失败：%s%s' % (C_BAD, doc['execution'], C_OFF))
            print('  %s→ CONTEXT_INVALID 通常表示 context 缺必需字段；'
                  '完整 context 需 8 项（fixture/suite_revision/current/business/'
                  'fake_assets/snapshots/histories/grants）%s' % (C_DIM, C_OFF))
            return 2
        if v.get('valid'):
            print('  %s✓%s 通过（stage=%s）' % (C_OK, C_OFF, doc.get('stage')))
        else:
            ok = False
            print('  %s✗ %d 个错误（stage=%s）%s'
                  % (C_BAD, len(v.get('errors', [])), doc.get('stage'), C_OFF))
            for e in v.get('errors', [])[:10]:
                print('     %s | %s' % (e.get('code'), e.get('path')))
            print('  %s→ 约束清单见 docs/business-schema-产出约束.md%s' % (C_DIM, C_OFF))

    print()
    if ok:
        print('%s✓ 通过%s' % (C_OK, C_OFF))
        return 0
    print('%s✗ 未通过%s' % (C_BAD, C_OFF))
    return 1


def self_test() -> int:
    """用已落盘的样例做反向测试：正例必须过、负例必须被拒。"""
    d = os.path.join(ROOT, '样例', 'business-schema')
    good = os.path.join(d, '通用事项.spec.json')
    ctx = os.path.join(d, 'context-新建.json')
    ctx_old = os.path.join(d, 'context-修改.json')

    print('=== 验收检查器自测 ===\n')
    results = []

    print('[1] 正例 + 新建 context（期望通过）')
    rc = check(good, 'business-schema/v1', ctx)
    results.append(('正例通过', rc == 0, rc))

    print('\n[2] 正例 + 修改 context（期望被拒 —— 含已注册版本，触发迁移检查）')
    rc = check(good, 'business-schema/v1', ctx_old)
    results.append(('修改场景被拒', rc == 1, rc))

    print('\n[3] 不支持的契约（期望无法执行，而非静默跳过）')
    rc = check(good, 'workflow-spec/v1alpha1', ctx)
    results.append(('不支持时拒答', rc == 2, rc))

    print()
    print('─' * 60)
    bad = 0
    for name, passed, rc in results:
        if passed:
            print('  %s✓%s %-22s 退出码 %d' % (C_OK, C_OFF, name, rc))
        else:
            bad += 1
            print('  %s✗%s %-22s 退出码 %d' % (C_BAD, C_OFF, name, rc))
    print()
    if bad:
        print('%s✗ %d 项不符%s' % (C_BAD, bad, C_OFF))
        return 1
    print('%s✓ %d 项全部符合 —— 检查器能区分通过、被拒与无法执行三种结果%s'
          % (C_OK, len(results), C_OFF))
    return 0


def main() -> int:
    args = sys.argv[1:]
    if '--self-test' in args:
        return self_test()
    if not args or args[0].startswith('--'):
        print(__doc__)
        return 2
    path = args[0]
    contract = 'business-schema/v1'
    context = None
    for i, a in enumerate(args):
        if a == '--contract' and i + 1 < len(args):
            contract = args[i + 1]
        if a == '--context' and i + 1 < len(args):
            context = args[i + 1]
    return check(path, contract, context)


if __name__ == '__main__':
    sys.exit(main())
