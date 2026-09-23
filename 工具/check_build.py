#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
构建配置检查 —— 防止「品牌门控被设反」这类错误再发生。

背景：scripts/kvvi-web.sh 曾经这么写：
    # （不设 official，KVVI 的 kvvi-brand 插件才能拿到那两个插槽）。
    ( cd "$DSH_SRC" && DSH_CLIENT_BUILD_PROFILE=official ... pnpm build )
注释是对的，值填反了。后果不是构建失败（构建照样过），而是**页面起不来**：
上游 ui-brand-official 与 kvvi-brand 抢同一个 kind:'single' 的插槽，
同 priority 的第二个注册直接抛错。

检查三处：
  1. scripts/kvvi-web.sh 的构建命令
  2. .dsh-build/client-build-environment.json（构建产物记录，权威）
  3. 产物里 ui-brand-official 的门控是否被固化成 official
"""

import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LAUNCHER = os.path.join(ROOT, 'scripts', 'kvvi-web.sh')
DSH = os.path.join(ROOT, 'vendor', 'dsh')
RECORD = os.path.join(DSH, '.dsh-build', 'client-build-environment.json')
BRAND_BUNDLE = os.path.join(DSH, 'packages', 'client', 'ui-brand-official', 'lib', 'client.js')

C_OK, C_BAD, C_WARN, C_DIM, C_OFF = '\033[32m', '\033[31m', '\033[33m', '\033[90m', '\033[0m'
PROFILE_VAR = 'DSH_CLIENT_BUILD_PROFILE'
TITLE_VAR = 'DSH_CLIENT_TITLE'
KVVI_TITLE = 'KVVI 搭建引擎'


def code_lines(path: str):
    """产出 (行号, 去掉行内注释后的代码, 原行)。注释里提到变量名是允许的。"""
    if not os.path.exists(path):
        return
    for i, raw in enumerate(open(path, encoding='utf-8'), 1):
        line = raw.rstrip('\n')
        stripped = line.lstrip()
        if stripped.startswith('#'):
            continue
        code = line.split('#', 1)[0] if '#' in line else line
        yield i, code, line


def check_launcher() -> bool:
    """启动脚本不能把公开值设成 official，且必须注入标题。"""
    if not os.path.exists(LAUNCHER):
        print('%s✗ 启动脚本不存在：%s%s' % (C_BAD, LAUNCHER, C_OFF))
        return False

    ok = True
    offenders = []
    has_title = False
    for lineno, code, _ in code_lines(LAUNCHER):
        if re.search(r'%s\s*=\s*["\']?official' % PROFILE_VAR, code):
            offenders.append(lineno)
        if TITLE_VAR in code:
            has_title = True

    if offenders:
        ok = False
        print('%s✗ 启动脚本把 %s 设成了 official（第 %s 行）%s'
              % (C_BAD, PROFILE_VAR, ', '.join(map(str, offenders)), C_OFF))
        print('  %s→ 上游 ui-brand-official 会因此注册，与 kvvi-brand 抢同一个' % C_DIM)
        print('     kind:single 插槽，同 priority 的第二个注册抛错，页面起不来。%s' % C_OFF)
        print('  %s→ 删掉该变量即可（pnpm build 不带 --profile 时不强制 official）%s' % (C_DIM, C_OFF))
    else:
        print('%s✓%s %s 未被设为 official（kvvi-brand 能拿到品牌插槽）'
              % (C_OK, C_OFF, PROFILE_VAR))

    if not has_title:
        ok = False
        print('%s✗ 启动脚本没有注入 %s%s —— 产品名会回退到上游默认值'
              % (C_BAD, TITLE_VAR, C_OFF))
    else:
        print('%s✓%s 已注入 %s' % (C_OK, C_OFF, TITLE_VAR))
    return ok


def check_record() -> bool:
    """构建记录是权威：它记的就是嵌进产物的公开值。"""
    if not os.path.exists(RECORD):
        print('%s•%s 尚无构建记录（未完整构建过），跳过' % (C_WARN, C_OFF))
        return True
    doc = json.load(open(RECORD, encoding='utf-8'))
    env = doc.get('environment', {})
    ok = True

    profile = env.get(PROFILE_VAR)
    if profile == 'official':
        ok = False
        print('%s✗ 构建记录里 %s = "official"%s —— 这份产物的品牌会冲突' % (C_BAD, PROFILE_VAR, C_OFF))
        print('  %s→ 重新构建：scripts/kvvi-web.sh --rebuild%s' % (C_DIM, C_OFF))
    elif profile is None:
        print('%s✓%s 构建记录里没有 %s（上游品牌不注册）' % (C_OK, C_OFF, PROFILE_VAR))
    else:
        ok = False
        print('%s✗ 构建记录里 %s = %r，既不是缺失也不是 official —— 非预期值%s'
              % (C_BAD, PROFILE_VAR, profile, C_OFF))

    title = env.get(TITLE_VAR)
    if title == KVVI_TITLE:
        print('%s✓%s 构建记录里 %s = %r' % (C_OK, C_OFF, TITLE_VAR, title))
    else:
        ok = False
        print('%s✗ 构建记录里 %s = %r，期望 %r%s' % (C_BAD, TITLE_VAR, title, KVVI_TITLE, C_OFF))

    print('  %s产物：%s 个文件，sha256 %s%s'
          % (C_DIM, doc.get('artifacts', {}).get('fileCount'),
             str(doc.get('artifacts', {}).get('sha256'))[:16], C_OFF))
    return ok


def check_bundle() -> bool:
    """
    产物级检查：上游品牌门控在构建期被折叠成了什么。

    未设 profile 时 `process.env` 被 define 成 `{}`，于是源码
        if (process.env.DSH_CLIENT_BUILD_PROFILE !== 'official') return
    折叠为
        if ({}.DSH_CLIENT_BUILD_PROFILE !== 'official') return
    即 `undefined !== 'official'` 恒真 —— 上游品牌不注册。这是**正确**结果。

    所以判据不是「有没有出现 official 字样」（那在源码里本来就有），
    而是**该变量的取值来源**：
      · `{}.DSH_CLIENT_BUILD_PROFILE`   → 构建期已定死为 undefined → 正确
      · `process.env.DSH_CLIENT_BUILD_PROFILE` → 运行时才读，构建期没定死  → 红
      · 门控整段消失且直接进入注册                                        → 红
    """
    if not os.path.exists(BRAND_BUNDLE):
        print('%s•%s 尚无 ui-brand-official 产物，跳过' % (C_WARN, C_OFF))
        return True
    src = open(BRAND_BUNDLE, encoding='utf-8', errors='replace').read()
    pat = re.escape(PROFILE_VAR)

    if re.search(r'process\.env\.%s' % pat, src):
        print('%s✗ 产物里保留 process.env.%s —— 构建期没定死，品牌门控取决于运行时环境%s'
              % (C_BAD, PROFILE_VAR, C_OFF))
        return False

    m = re.search(r'(\{[^{}]*\}|void 0|undefined)\.%s' % pat, src)
    if m:
        print('%s✓%s 门控在构建期折叠为 %s.%s（恒为 undefined → 上游品牌不注册）'
              % (C_OK, C_OFF, m.group(1), PROFILE_VAR))
        return True

    # 既没残留 process.env，也没找到折叠痕迹 —— 门控可能整段消失了。
    apply_body = re.search(r'function apply\(ctx\)\s*\{(.{0,120})', src, re.S)
    head = apply_body.group(1).strip() if apply_body else ''
    if 'slots' in head or 'inject' in head:
        print('%s✗ 产物里 apply 直接进入注册，品牌门控不见了%s' % (C_BAD, C_OFF))
        print('  %s→ 说明该变量被嵌成了 \'official\'，上游品牌会与 kvvi-brand 撞 single 插槽%s'
              % (C_DIM, C_OFF))
        return False

    print('%s•%s 产物里找不到品牌门控（apply 体开头：%r），跳过' % (C_WARN, C_OFF, head[:40]))
    return True


def main() -> int:
    print('%s=== 构建配置检查 ===%s' % (C_OK, C_OFF))
    results = [check_launcher(), check_record(), check_bundle()]
    print()
    if all(results):
        print('%s✓ 构建配置正确%s' % (C_OK, C_OFF))
        return 0
    print('%s✗ 构建配置有问题 —— 上述标红项须处理%s' % (C_BAD, C_OFF))
    return 1


if __name__ == '__main__':
    sys.exit(main())
