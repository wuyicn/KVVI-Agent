#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
发布通道的静态核查（N18、PRD §9.6.3）。

## 判据

> 业务权限策略**只能经发布通道**（差异报告 → 审批 → 发布）生效；
> 产品接口面**不提供旁路**。

## 它查什么

`services/platform/src/` 里对 `policies` 表的**写操作**（`INSERT` / `UPDATE` / `DELETE`）
只允许出现在 `publish.mjs` 里。别处出现即失败。

## ⚠️ 它是**静态**保证，必须如实说明

它证的是「**产品自己的代码**不给旁路」，**不是**「数据库层面拦住了直写」。
任何能拿到平台库连接的人仍可直接改 `policies` —— 那属于部署基线与基础设施管理员
的信任范围（§9.6.3 的范围声明：基础设施管理员不在防御范围内）。
数据库层的拦写记为 N24，**未做**。

用法：`python3 工具/check_publish_channel.py`
退出码：0 = 通过 / 1 = 有旁路 / 2 = 无法执行
"""

import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "services", "platform", "src")
ONLY = 'publish.mjs'
WRITE = re.compile(r'\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+policies\b', re.I)

C_OK, C_BAD, C_DIM, C_OFF = '\033[32m', '\033[31m', '\033[90m', '\033[0m'


def main() -> int:
    if not os.path.isdir(SRC):
        print('%s✗ 找不到 %s%s' % (C_BAD, SRC, C_OFF))
        return 2
    hits, scanned = [], 0
    for name in sorted(os.listdir(SRC)):
        if not name.endswith('.mjs'):
            continue
        scanned += 1
        path = os.path.join(SRC, name)
        with open(path, encoding='utf-8') as fh:
            for i, line in enumerate(fh, 1):
                if line.lstrip().startswith('--') or line.lstrip().startswith('*'):
                    continue
                if WRITE.search(line):
                    hits.append((name, i, line.strip()[:80]))

    print('=== 发布通道静态核查（N18 / §9.6.3）===')
    print('判据：产品代码里**只有** %s 能写 `policies`' % ONLY)
    print()
    if scanned < 5:
        print('%s✗ 只扫到 %d 个文件 —— 扫描面塌了%s' % (C_BAD, scanned, C_OFF))
        return 2
    print('[1] 扫描面：%d 个 .mjs' % scanned)
    print()
    print('[2] 写 `policies` 的位置')
    if not hits:
        print('  %s✓ 0 处 —— 产品代码里没有写策略的地方%s' % (C_OK, C_OFF))
        print('  %s（发布通道本身把写操作交给调用方传入的 apply 回调，%s'
              % (C_DIM, '所以这里也不出现）' + C_OFF))
    else:
        for name, line, text in hits:
            mark = '%s✓%s' % (C_OK, C_OFF) if name == ONLY else '%s✗%s' % (C_BAD, C_OFF)
            print('  %s %s:%d  %s' % (mark, name, line, text))
    bad = [h for h in hits if h[0] != ONLY]
    print()
    print('⚠️ 这是**静态**保证：证的是「产品自己的代码不给旁路」，')
    print('   **不是**「数据库层面拦住了直写」。数据库层拦写记为 N24，未做。')
    print()
    if bad:
        print('%s✗ 发现旁路：%s%s' % (C_BAD, '、'.join(sorted({b[0] for b in bad})), C_OFF))
        return 1
    print('%s✓ 通过：产品代码里对 `policies` 的写只出现在发布通道（或完全不在 src/）%s'
          % (C_OK, C_OFF))
    return 0


if __name__ == '__main__':
    sys.exit(main())
