#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
「CLI 脚手架」与「Agent 工具」两条发布路的**装订对拍**。

## 判据

> 同一个工作区，经由 CLI 与经由 Agent 发上去的必须是**同样的东西**。

两处源码的注释都写着「必须同源」，但在本闸门之前**没有任何东西在管**。
不同源的表现不吵不闹：一次构建经由两条路会发上去不同的内容，
而两边都只报「缺某一份契约」，看不出是判据漂移。

## 它比什么

在**同一棵合成契约树**上跑两侧，比三样**决定**：

1. `candidates` —— 每个契约种类认出了哪些文件（认法同不同）
2. `picked`     —— 被采用的是哪一份（多份时挑错了就发错了）
3. `skipped`    —— 整目录跳过了哪些、各几份

**不比措辞**：一侧的注记给命令行的人看，一侧给模型看，措辞不同不是缺陷。

另外单独判一条：**跳过的目录，两侧的注记都要说出来**。
不判的话，两侧可以一起漏报而闸门照样绿 —— 而漏报正是要防的那件事。

## ⚠️ 它证不到什么

合成树覆盖的是**判据**，不是真实工作区的每一种目录命名。
真实目录里出现本树没有的形状时，两侧仍可能各走各的。

用法：`python3 工具/check_contract_binding_parity.py`
退出码：0 = 两侧一致 / 1 = 不一致 / 2 = 无法执行
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HARNESS = os.path.join(ROOT, '工具', 'lib', '契约装订对拍.mjs')
FORKS = os.path.join(ROOT, 'vendor', 'dsh')

C_OK, C_BAD, C_DIM, C_OFF = '\033[32m', '\033[31m', '\033[90m', '\033[0m'

# 合成树：把两侧**判断会分岔**的地方都摆进去。
# 每一条都对应一个具体的分岔点，不是随手凑的样例。
FIXTURE = {
    # 两张视图 → 平台每类只存一份，必须挑同一份（挑错了整条链发错内容）
    '契约/01-客户登记表单-view-schema.json': '{"which":"form"}',
    '契约/02-客户列表-view-schema.json': '{"which":"list"}',
    '契约/03-客户-business-schema.json': '{"b":1}',
    '契约/04-登记-workflow-spec.json': '{"w":1}',
    '契约/05-销售-permission-spec.json': '{"p":1}',
    '契约/06-客户-搭建命令.json': '{"c":1}',
    # 多份工具 → 按 {tools:[...]} 装订
    '契约/07-工具/assign.json': '{"tool":"assign"}',
    '契约/07-工具/close.json': '{"tool":"close"}',
    # 整目录跳过：**这是问题 29 当场抓到的那一条**，从前连注记都没有
    '契约/07-工具/schemas/request.json': '{}',
    '契约/07-工具/schemas/deep/response.json': '{}',
    '契约/_校验/结果/view-schema-副本.json': '{}',
    '契约/_校验环境/business-schema.json': '{}',
    '契约/fixture/x.json': '{}',
    # 非 .json：两侧都不该认
    '契约/08-说明.md': '# 不是契约',
}


def node_binary():
    """找 node。发行基线是 24，优先用它。"""
    local = os.path.expanduser('~/.local/opt/node-v24.20.0/bin/node')
    if os.path.exists(local):
        return local
    found = shutil.which('node')
    if found:
        return found
    return None


def build_tree():
    """把 FIXTURE 铺到临时目录，返回契约目录的绝对路径。"""
    root = tempfile.mkdtemp(prefix='kvvi-parity-')
    for rel, body in FIXTURE.items():
        path = os.path.join(root, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w', encoding='utf-8') as fh:
            fh.write(body)
    return os.path.join(root, '契约'), root


def python_side(tree):
    """跑 CLI 脚手架那一侧，回同样的三个决定。"""
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        'kvvi_scaffold', os.path.join(ROOT, '工具', '发布脚手架.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    found, skipped = module._scan_contract_tree(tree)
    _contracts, notes = module.read_contracts(tree)
    return {
        'candidates': {t: sorted(os.path.relpath(p, tree) for p in ps)
                       for t, ps in found.items()},
        'picked': {t: (None if not ps else os.path.relpath(ps[0], tree))
                   for t, ps in found.items()},
        'skipped': sorted([[s['path'], s['files']] for s in skipped]),
        'skippedInNotes': sorted(s['path'] for s in skipped
                                 if any('整目录跳过' in n and s['path'] in n for n in notes)),
    }


def node_side(tree, node):
    """跑 Agent 工具那一侧。"""
    result = subprocess.run(
        [node, '--import', 'tsx/esm', HARNESS, tree],
        cwd=FORKS, capture_output=True, text=True, timeout=180)
    if result.returncode != 0:
        raise RuntimeError('node 侧跑不起来（退出码 %d）：\n%s\n%s'
                           % (result.returncode, result.stdout[-800:], result.stderr[-800:]))
    return json.loads(result.stdout)


def main():
    print('=== 契约装订对拍：CLI 脚手架 vs Agent 工具 ===')
    print('判据：同一个工作区，两条路发上去的必须是同样的东西')
    print()

    if not os.path.exists(HARNESS):
        print('%s✗ 找不到对拍脚本 %s%s' % (C_BAD, HARNESS, C_OFF))
        return 2
    node = node_binary()
    if node is None:
        print('%s✗ 找不到 node%s' % (C_BAD, C_OFF))
        return 2

    tree, temp_root = build_tree()
    try:
        try:
            py = python_side(tree)
            js = node_side(tree, node)
        except Exception as error:  # noqa: BLE001 - 两侧任一跑不起来都必须报出来，不能当通过
            print('%s✗ %s%s' % (C_BAD, error, C_OFF))
            return 2

        print('[1] 合成树：%d 个文件，%d 个契约种类'
              % (len(FIXTURE), len(py['candidates'])))
        print('    node：%s' % node)
        print()

        bad = []
        for field, label in (('candidates', '认出了哪些文件'),
                             ('picked', '挑中的是哪一份'),
                             ('skipped', '整目录跳过了哪些')):
            print('[2] %s' % label)
            if py[field] == js[field]:
                print('  %s✓ 两侧一致%s' % (C_OK, C_OFF))
                # 把比的东西打出来 —— 只打「✓」的话，读者没法判断这一条到底比了什么、
                # 覆盖到没覆盖到（工具报绿 ≠ 事情对了）。
                if isinstance(py[field], dict):
                    for key, value in sorted(py[field].items()):
                        shown = value if isinstance(value, str) else '、'.join(value)
                        print('    %s%-18s %s%s' % (C_DIM, key, shown, C_OFF))
                else:
                    for path, count in py[field]:
                        print('    %s%-18s %d 个 .json%s' % (C_DIM, path, count, C_OFF))
            else:
                bad.append(label)
                print('  %s✗ 两侧不一致%s' % (C_BAD, C_OFF))
                print('    CLI 侧：%s' % json.dumps(py[field], ensure_ascii=False, sort_keys=True))
                print('    工具侧：%s' % json.dumps(js[field], ensure_ascii=False, sort_keys=True))
            print()

        # ⚠️ 单独判「说了没有」。不判的话两侧可以一起漏报而上面三条照样绿。
        print('[3] 跳过的目录，注记里说出来了吗')
        for side, data in (('CLI 侧', py), ('工具侧', js)):
            expected = sorted(p for p, _n in data['skipped'])
            missing = [p for p in expected if p not in data['skippedInNotes']]
            if missing:
                bad.append('%s 的注记漏报' % side)
                print('  %s✗ %s：跳过了却没说 —— %s%s'
                      % (C_BAD, side, '、'.join(missing), C_OFF))
            else:
                print('  %s✓ %s：%d 个跳过的目录都说了%s'
                      % (C_OK, side, len(expected), C_OFF))
        print()

        print('%s⚠️ 证到的是判据一致，不是真实工作区的每一种目录命名都覆盖了。%s' % (C_DIM, C_OFF))
        print()
        if bad:
            print('%s✗ 不一致：%s%s' % (C_BAD, '；'.join(bad), C_OFF))
            return 1
        print('%s✓ 通过：两条路在同一棵树上做出同样的装订决定，且都说了跳过了什么%s'
              % (C_OK, C_OFF))
        return 0
    finally:
        shutil.rmtree(temp_root, ignore_errors=True)


if __name__ == '__main__':
    sys.exit(main())
