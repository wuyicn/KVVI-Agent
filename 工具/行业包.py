#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
行业包检查器（阶段六锚点①、任务 `0C-6`）。

## 判据

> `0C-6`：报货单能通过模板契约和登记组件跑起来（**不改地基**）。

拆成两句，**两句都要能判**：

| 判据 | 怎么判 |
|---|---|
| **能跑起来** | 包里的产出物逐份过契约校验（能完整走的走完整校验） |
| **不改地基** | 加包**之前**记录的地基指纹，加包之后**必须仍然一致** |

## 为什么第二句要单独做

「不改地基」如果只写在文档里，它就是一个**没有执行点的承诺**。
`地基未改动.json` 在加包时记下各交付组件的内容指纹（复用
`工具/交付包.py` 的算法），本检查器复核它们**没有变**。

这样「豁免行业词」才不是「这一类检查在这里失效」——
行业词在这里合法，代价是**地基必须一动不动**。

用法：

    python3 工具/行业包.py --write     # 记录当前地基指纹（加包时执行一次）
    python3 工具/行业包.py --check     # 复核：产出物合法 + 地基未动
"""

import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import importlib.util

spec = importlib.util.spec_from_file_location('交付包', os.path.join(HERE, '交付包.py'))
delivery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(delivery)

PACK = os.path.join(ROOT, '样例', '行业包', '家具报货申请')
RECORD = os.path.join(PACK, '地基未改动.json')
CHECK = os.path.join(HERE, 'check_skill_output.py')

C_OK, C_BAD, C_WARN, C_DIM, C_OFF = '\033[32m', '\033[31m', '\033[33m', '\033[90m', '\033[0m'

# 行业包内**不属于交付地基**的组件类别 —— 它们不在指纹范围内。
FOUNDATION = [c for c in delivery.COMPONENTS if c[0] != 'schema-samples']

CONTRACTS = [
    ('01-数据模型.json', 'business-schema/v1', '样例/business-schema/context-新建.json'),
    ('02-表单.json', 'view-schema/lce-safe-v1', '样例/行业包/家具报货申请/context.json'),
    ('03-流程.json', 'workflow-spec/v1alpha1', None),
]


def foundation_digests():
    out = {}
    for name, rel, _desc, _v in FOUNDATION:
        abs_dir = os.path.join(ROOT, rel)
        if os.path.isdir(abs_dir):
            digest, count = delivery.component_digest(abs_dir)
            out[name] = {'path': rel, 'digest': 'sha256:%s' % digest, 'fileCount': count}
    return out


def main() -> int:
    if '--write' in sys.argv:
        payload = {
            'recordVersion': 'kvvi-foundation-snapshot/v2',
            'note': '行业扩展包安装**之前**的地基指纹。加包之后必须逐项一致 —— '
                    '这是「不改地基」这句承诺的执行点。',
            'foundation': foundation_digests(),
            'rebases': [],
        }
        with open(RECORD, 'w', encoding='utf-8') as fh:
            fh.write(json.dumps(payload, ensure_ascii=False, indent=2) + '\n')
        print('✓ 已记录地基指纹（%d 个组件）' % len(payload['foundation']))
        return 0

    if '--rebaseline' in sys.argv:
        # ⚠️ **重设基线必须是一次有记录的动作，不能是「跑一遍 --write 覆盖掉」**。
        # 地基**合法变更**（修 bug、加固构建）之后基线确实要跟着走，
        # 但如果只是覆盖，那次变更就**从证据里消失了** ——
        # 而「地基没被悄悄改过」正是这个文件存在的理由。
        # 所以每次重设都追加一条历史：什么时候、由什么原因。
        if '--reason' not in sys.argv:
            print('%s✗ 重设基线必须给 --reason：地基为什么变了%s' % (C_BAD, C_OFF))
            print('  （无理由的重设等于把证据删掉）')
            return 2
        reason = sys.argv[sys.argv.index('--reason') + 1]
        with open(RECORD, encoding='utf-8') as fh:
            old = json.load(fh)
        before = old['foundation']
        after = foundation_digests()
        changed = [name for name in before
                   if before[name]['digest'] != after.get(name, {}).get('digest')]
        old.setdefault('rebases', []).append({
            'reason': reason,
            'changedComponents': changed,
        })
        old['foundation'] = after
        with open(RECORD, 'w', encoding='utf-8') as fh:
            fh.write(json.dumps(old, ensure_ascii=False, indent=2) + '\n')
        print('✓ 基线已重设；本次变更的组件：%s' % ('、'.join(changed) or '无'))
        return 0

    problems = []
    print('%s=== 行业扩展包检查 ===%s' % (C_OK, C_OFF))
    print('判据：产出物过契约校验 + **地基未被改动**（PRD §5.7.3、任务 0C-6）')
    print()

    print('[1] 产出物逐份过契约校验')
    for rel, contract, ctx in CONTRACTS:
        path = os.path.join(PACK, rel)
        if not os.path.isfile(path):
            problems.append('缺少 %s' % rel)
            continue
        args = ['python3', CHECK, path, '--contract', contract]
        if ctx:
            args += ['--context', os.path.join(ROOT, ctx)]
        r = subprocess.run(args, capture_output=True, text=True)
        if r.returncode == 0:
            scope = '完整校验' if '语义 + 引用校验' in r.stdout and '通过' in r.stdout \
                else '仅结构'
            if ctx is None:
                scope = '仅结构'
            print('  %s✓%s %-16s %s（%s）' % (C_OK, C_OFF, rel, contract, scope))
        else:
            print('  %s✗%s %-16s 未通过' % (C_BAD, C_OFF, rel))
            for line in r.stdout.splitlines():
                if '✗' in line and '|' in line:
                    print('      %s%s%s' % (C_DIM, line.strip()[:96], C_OFF))
            problems.append('%s 未过契约校验' % rel)

    print()
    print('[2] 地基未被改动（这才是行业包「能装」的判据）')
    if not os.path.isfile(RECORD):
        print('  %s✗ 没有 %s —— 「不改地基」没有执行点%s'
              % (C_BAD, os.path.relpath(RECORD, ROOT), C_OFF))
        problems.append('缺少地基指纹记录')
    else:
        with open(RECORD, encoding='utf-8') as fh:
            record = json.load(fh)
        declared = record['foundation']
        rebases = record.get('rebases', [])
        if rebases:
            print('  %s（基线被重设过 %d 次，每次都有记录的原因）%s'
                  % (C_WARN, len(rebases), C_OFF))
            for rb in rebases:
                print('    · %s —— 变更组件：%s'
                      % (rb['reason'], '、'.join(rb['changedComponents']) or '无'))
        fresh = foundation_digests()
        for name, want in declared.items():
            got = fresh.get(name)
            if got is None:
                problems.append('地基组件 %s 不见了' % name)
                print('  %s✗%s %s 不见了' % (C_BAD, C_OFF, name))
            elif got['digest'] != want['digest']:
                problems.append('地基组件 %s 被改动了' % name)
                print('  %s✗%s %-26s 被改动了（%s → %s）'
                      % (C_BAD, C_OFF, name, want['digest'][7:19], got['digest'][7:19]))
            else:
                print('  %s✓%s %-26s 未改动' % (C_OK, C_OFF, name))

    print()
    if problems:
        print('%s✗ 行业包检查未通过：%d 项%s' % (C_BAD, len(problems), C_OFF))
        return 1
    print('%s✓ 行业包通过：产出物合法，且地基逐项未改动%s' % (C_OK, C_OFF))
    return 0


if __name__ == '__main__':
    sys.exit(main())
