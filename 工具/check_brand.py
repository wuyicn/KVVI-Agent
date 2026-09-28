#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
品牌残留检查 —— PRD §7.1 阶段二锚点 ③「上游默认品牌元素零残留（机器可检）」。

判据来源：docs/品牌检查清单.md 第一节。

**核心区分**：只把「会被渲染成用户可见文本」的出现算作残留。
包名 @deepseek-ai/*、变量名、文件路径一律不算 —— 把它们算残留会导致
误报泛滥，或被迫改包名而破坏上游升级。

故检查范围是**有限的一组载体**，而不是全仓库字符串搜索：

  载体                                    检查什么
  ──────────────────────────────────────  ──────────────────────────────
  apps/web/public/manifest.webmanifest     name / short_name（PWA 名，必然可见）
  apps/web/dist/index.html                 <title>
  packages/client/*/src/**/locales.ts      locale 字典的字符串**值**
  packages/client/*/lib/client.js          构建产物（用户真正加载的东西）

**为什么同时查源码与产物**：
  源码查得出「还没构建就已存在」的残留；产物查得出「源码已改但没重新构建」。
  只查其一都会漏。这两类是不同失败。

用法：
  python3 工具/check_brand.py            # 逐项核销
  python3 工具/check_brand.py --json     # 机读输出
  bash 工具/check_brand_自测.sh          # 反向测试：证明该红时会红
"""

import io
import json
import os
import re
import sys
from typing import Dict, List, Optional, Tuple

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DSH = os.path.join(ROOT, 'vendor', 'dsh')

C_OK, C_BAD, C_WARN, C_DIM, C_OFF = '\033[32m', '\033[31m', '\033[33m', '\033[90m', '\033[0m'

# 上游产品全名。带空格的完整产品名不会作为代码标识符出现，
# 所以在本检查限定的载体里，它的每一次出现都是用户可见文案。
UPSTREAM_NAME = 'DeepSeek Harness'
# manifest 里的短名（上游用它做 PWA 短名）。
UPSTREAM_SHORT = 'DSH'

# 预期产品名（构建期由 DSH_CLIENT_TITLE 注入）。
KVVI_NAME = 'KVVI 工作台'


def locale_files() -> List[str]:
    """所有 client 包的 locale 源码文件。"""
    out = []
    base = os.path.join(DSH, 'packages', 'client')
    for pkg in sorted(os.listdir(base)) if os.path.isdir(base) else []:
        src = os.path.join(base, pkg, 'src')
        for dirpath, _dirs, files in os.walk(src):
            for f in files:
                if f.endswith('.ts') and 'locale' in f.lower():
                    out.append(os.path.join(dirpath, f))
    return out


def client_bundles() -> List[str]:
    """所有 client 包的构建产物。"""
    out = []
    base = os.path.join(DSH, 'packages', 'client')
    for pkg in sorted(os.listdir(base)) if os.path.isdir(base) else []:
        p = os.path.join(base, pkg, 'lib', 'client.js')
        if os.path.isfile(p):
            out.append(p)
    return out


def occurrences(path: str, needle: str) -> List[Tuple[int, str]]:
    """返回 (行号, 上下文)。用 Python 逐行读，避免 grep 跨行导致的假阴性 —— 
    早先探查时 `grep -o` 因模式跨换行而匹配失败，一度得出「产物里没有该字样」的错误结论。"""
    out = []
    if not os.path.isfile(path):
        return out
    for i, line in enumerate(io.open(path, encoding='utf-8', errors='replace'), 1):
        if needle in line:
            idx = line.find(needle)
            out.append((i, line[max(0, idx - 40):idx + len(needle) + 40].strip()))
    return out


def rel(p: str) -> str:
    try:
        return os.path.relpath(p, ROOT)
    except ValueError:
        return p


def check_manifest() -> Tuple[bool, List[str]]:
    """R1：PWA 清单。name / short_name 必然对用户可见。"""
    findings = []
    path = os.path.join(DSH, 'apps', 'web', 'public', 'manifest.webmanifest')
    if not os.path.isfile(path):
        return True, ['%s（源码清单不存在，跳过）' % rel(path)]
    try:
        doc = json.load(io.open(path, encoding='utf-8'))
    except Exception as e:  # noqa: BLE001 - 解析失败必须显式暴露，不能静默跳过
        findings.append('%s 解析失败：%s' % (rel(path), e))
        return False, findings
    for key in ('name', 'short_name'):
        v = doc.get(key)
        if v is None:
            continue
        if UPSTREAM_NAME in str(v) or (key == 'short_name' and str(v) == UPSTREAM_SHORT):
            findings.append('%s 的 %s = %r' % (rel(path), key, v))
    return len(findings) == 0, findings


def check_title() -> Tuple[bool, List[str]]:
    """构建产物的 <title>。"""
    findings = []
    path = os.path.join(DSH, 'apps', 'web', 'dist', 'index.html')
    if not os.path.isfile(path):
        return True, ['%s（产物不存在，跳过）' % rel(path)]
    head = io.open(path, encoding='utf-8', errors='replace').read(4000)
    m = re.search(r'<title[^>]*>(.*?)</title>', head, re.S | re.I)
    if m and UPSTREAM_NAME in m.group(1):
        findings.append('%s 的 <title> = %r' % (rel(path), m.group(1).strip()))
    return len(findings) == 0, findings


def scan(targets: List[str]) -> Tuple[bool, List[str]]:
    """
    对给定载体列表做品牌残留扫描。

    ★ 载体的切分必须**互斥**：早先版本在「产物」这项里复用了
    `locale_files() + client_bundles()`，导致同一个源码文件被报告两次 ——
    重复计数会让残留数虚高，而虚高的数字会让人低估清理进度。
    """
    by_file: Dict[str, List[Tuple[int, str]]] = {}
    for p in targets:
        hits = occurrences(p, UPSTREAM_NAME)
        if hits:
            by_file[p] = hits
    findings = []
    for p, hits in sorted(by_file.items()):
        findings.append('%s（%d 处）' % (rel(p), len(hits)))
        for lineno, ctx in hits[:2]:
            findings.append('    L%-5d %s' % (lineno, ctx))
        if len(hits) > 2:
            findings.append('    …… 另有 %d 处' % (len(hits) - 2))
    return len(findings) == 0, findings


def main() -> int:
    as_json = '--json' in sys.argv
    checks = [
        ('R1 PWA 清单（name / short_name）', check_manifest()),
        ('R1b 页面 <title>', check_title()),
        ('R2-R4 locale 字典（源码）', scan(locale_files())),
        ('R2-R4 构建产物（lib/client.js）', scan(client_bundles())),
    ]

    if as_json:
        print(json.dumps({
            'upstream_name': UPSTREAM_NAME,
            'expected_name': KVVI_NAME,
            'checks': [{'name': n, 'ok': ok, 'findings': f} for n, (ok, f) in checks],
        }, ensure_ascii=False, indent=2))
        return 0 if all(ok for _, (ok, _) in checks) else 1

    print('%s=== 品牌残留检查（PRD §7.1 锚点 ③）===%s' % (C_OK, C_OFF))
    print('%s判据：只算「会被渲染成文本」的出现；包名/变量名/路径不算残留%s' % (C_DIM, C_OFF))
    print()

    failed = 0
    for name, (ok, findings) in checks:
        if ok:
            print('%s✓%s %s —— 无残留' % (C_OK, C_OFF, name))
            for f in findings:
                print('    %s%s%s' % (C_DIM, f, C_OFF))
        else:
            failed += 1
            print('%s✗%s %s —— %d 项残留' % (C_BAD, C_OFF, name, len(findings)))
            for f in findings:
                print('    %s' % f)

    print()
    if failed == 0:
        print('%s✓ 通过：无上游默认品牌元素残留%s' % (C_OK, C_OFF))
        return 0
    print('%s✗ 未通过 —— 上述残留须清理，清单见 docs/品牌检查清单.md%s' % (C_BAD, C_OFF))
    return 1


if __name__ == '__main__':
    sys.exit(main())
