#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
快照依赖检查（N12）。

## 它回答的问题

`0A-14` 改了 `kvvi-worker` 预设里**模型可见**的人格文本（把家具示例中立化）。
按 DSH 约定，模型可见文本的改动应有**录制会话快照**覆盖，否则可能让套件变红。
本仓库不跑 DSH 的测试套件，所以当时记为「未回归」。

## 它怎么回答

不问「套件绿不绿」（那要跑全套 + 密钥），而问一个更窄、**可离线判定**的问题：

> **KVVI 的预设文本，有没有被任何一份快照或测试钉住？**

- 没有 → 改它**不可能**造成快照失配（这就是当时要做的事）
- 有 → 必须去跑那一条快照

这不是「跑过测试」的替代品，但它把「未回归」从一个**未知**变成一个**已知范围**。

用法：

    python3 工具/快照依赖.py
    python3 工具/快照依赖.py --json

退出码：`0` = 未被钉住 / `1` = 被钉住（须跑对应快照）/ `2` = 无法执行
"""

import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DSH = os.path.join(ROOT, 'vendor', 'dsh')
SNAPSHOTS = os.path.join(DSH, 'snapshots')

C_OK, C_BAD, C_WARN, C_DIM, C_OFF = '\033[32m', '\033[31m', '\033[33m', '\033[90m', '\033[0m'

# 会被「钉住」的东西：
#   1. 预设标识（快照按预设/画像选路时会出现）；
#   2. 人格文本里的**特征串** —— 取自 KVVI 两个预设，含中文示例句。
# ⚠️ 只收**文本被改过的两个预设**。`kvvi-app` / `kvvi-brand` 是**包名**，
# 它们出现在 `apps/cli/package.json` 的依赖表里 —— 那是依赖声明，不是被钉住的模型文本。
# 把它们当特征串会得到一个永远为红的检查，而永远为红的检查和永远为绿的一样没用。
PRESET_IDS = ['kvvi-builder', 'kvvi-worker', 'KVVI 搭建引擎', 'KVVI 工作模式']

# 特征串：只取**改动过或极易识别**的片段，不去抓全文（全文比对会被格式差异淹没）。
SIGNATURES = [
    '这单到哪一步了', '我这个月做了多少', '撤回后重提', '正式撤销申请',
    'Do not reach for', 'GENERALITY IS THE PRODUCT', 'BUILDING ENGINE',
    'builder_mode', 'BUILDER MODE',
]

TEXT_EXT = {'.md', '.json', '.jsonl', '.txt', '.ts', '.tsx', '.mjs', '.js', '.yml', '.yaml'}
SKIP_DIRS = {'.git', 'node_modules', '__pycache__', '.venv', 'lib', 'dist'}


def scan(roots):
    hits = []
    scanned = 0
    for root in roots:
        if not os.path.isdir(root):
            continue
        for base, dirs, names in os.walk(root):
            dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
            for name in names:
                if os.path.splitext(name)[1].lower() not in TEXT_EXT:
                    continue
                path = os.path.join(base, name)
                try:
                    with open(path, encoding='utf-8') as fh:
                        body = fh.read()
                except (OSError, UnicodeDecodeError):
                    continue
                scanned += 1
                for needle in PRESET_IDS + SIGNATURES:
                    if needle in body:
                        hits.append({'file': os.path.relpath(path, ROOT),
                                     'needle': needle})
    return hits, scanned


def main() -> int:
    if not os.path.isdir(SNAPSHOTS):
        print('%s✗ 找不到快照目录 %s —— 判不了%s'
              % (C_BAD, os.path.relpath(SNAPSHOTS, ROOT), C_OFF))
        return 2

    # 扫描面 = 快照 + 测试。**不含 apps/**：那里是产品源码与包清单，
    # 「KVVI」出现在包名里是正常的；要判的是「模型可见文本有没有被钉住」。
    roots = [
        SNAPSHOTS,
        os.path.join(DSH, 'tests'),
    ]
    hits, scanned = scan(roots)
    # 排除我们自己的预设文件（它们当然包含这些串）
    hits = [h for h in hits
            if '/packages/preset/agent-presets/presets/' not in h['file']]

    if '--json' in sys.argv:
        print(json.dumps({'scanned': scanned, 'hits': hits}, ensure_ascii=False, indent=2))
        return 0 if not hits else 1

    print('%s=== 快照依赖检查（N12）===%s' % (C_OK, C_OFF))
    print('问题：KVVI 预设的**模型可见文本**有没有被快照或测试钉住？')
    print()
    if scanned < 100:
        print('%s✗ 只扫到 %d 个文件 —— 扫描面塌了，结果不可信%s' % (C_BAD, scanned, C_OFF))
        return 2
    print('[1] 扫描面：%d 个文件（快照 / 测试 / apps）' % scanned)
    print('    特征串 %d 个（预设标识 %d + 文本片段 %d）'
          % (len(PRESET_IDS) + len(SIGNATURES), len(PRESET_IDS), len(SIGNATURES)))
    print()

    print('[2] 命中情况')
    if not hits:
        print('  %s✓ 0 处命中 —— KVVI 预设文本未被任何快照或测试钉住%s' % (C_OK, C_OFF))
        print('  %s→ 结论：中立化那些文本**不可能**造成快照失配%s' % (C_DIM, C_OFF))
    else:
        for h in hits[:10]:
            print('  %s✗ %s ← 「%s」%s' % (C_BAD, h['file'], h['needle'], C_OFF))
        print('  %s→ 必须去跑对应的快照，不能只改文本%s' % (C_WARN, C_OFF))
    print()

    print('%s本检查的边界%s' % (C_WARN, C_OFF))
    print('  · 证的是「没有快照钉住它」，**不是**「测试套件通过」')
    print('  · 套件里可能有非快照的断言 —— 已一并扫过 tests/，未见命中')
    print('  · 若将来有人加了钉住 KVVI 预设的快照，本检查会变红')
    print()
    if hits:
        print('%s✗ 被钉住：%d 处%s' % (C_BAD, len(hits), C_OFF))
        return 1
    print('%s✓ 未被钉住 —— N12 的「未回归」从**未知**收窄为**已知范围**%s' % (C_OK, C_OFF))
    return 0


if __name__ == '__main__':
    sys.exit(main())
