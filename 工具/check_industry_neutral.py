#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
`0A-14` 去行业化自查 —— 阶段三锚点② 的可执行判据。

## 判据来自哪里

`0A-14` 的验收原文（KVVI-Builder `docs/progress.json`）：

> **代码里没有「报货单」这类家具词。**

PRD §7.1 把 `0A-14` 列为阶段三锚点②；PRD §5.7.3 与 §9.1 给出理由：
**行业扩展包按需叠加，地基无需改动**。所以「没有行业词」不是洁癖 ——
地基里出现某个行业的词，说明某一行业的假设已经渗进了本该中立的层。

## 扫什么、不扫什么

| | 范围 | 为什么 |
|---|---|---|
| ✅ **扫** | 契约、协议、工具、测试、服务、脚本、样例，以及 **fork 里登记过的改动文件** | 这些是产品本体 |
| ❌ **不扫** | `docs/` / `评审/` / `冻结/` / `进度.md` / PRD | 过程文档**必须**引用 PRD 原文，而 PRD 的锚点① 本身就写着「家具『报货申请』样例」。扫它们只会得到一堆与产品无关的命中 |

> **为什么 fork 只扫「登记过的改动文件」**：`vendor/dsh` 的主体是上游代码，
> 上游是否出现行业词不归我们管。用 `forks/dsh/改造点指纹.json` 的文件清单，
> 恰好圈出**我们写的那些**。

## 两个方向都要查

只查「没有行业词」是半个判据 —— 一个把 `skills/` 目录写死的实现同样「没有行业词」，
但它**长不出任何行业**。所以本检查同时要求：

1. **负向**：扫描面内没有行业词（`0A-14` 的字面判据）；
2. **正向**：行业扩展点存在且可用 —— 预设的 Skill 目录是**可追加的列表**
   （PRD §5.7.3「追加 `skills/` 目录 + 组件包，地基无需改动」）。

## 防「恒绿的检查」

本检查器最容易退化成两类恒真：**扫描面为空**（什么都没扫 = 没命中）、
**词表为空**（没词可命中）。所以：

- 扫描文件数有**下限**（`MIN_FILES`），低于下限退出码 `2`；
- 每次运行都**打印词表规模**；
- `工具/check_industry_neutral_自测.sh` 往扫描面塞一个行业词，必须变红。

## 用法

    python3 工具/check_industry_neutral.py              # 扫默认范围
    python3 工具/check_industry_neutral.py --json       # 机读输出
    python3 工具/check_industry_neutral.py --paths 样例  # 只扫指定子树

退出码：`0` = 通过 / `1` = 有命中 / `2` = 无法执行（扫描面或词表不成立）
"""

import json
import os
import re
import sys
from typing import Dict, List, Tuple

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ── 扫描范围 ────────────────────────────────────────────────────────────
# 产品本体所在的目录。刻意**不含** docs / 评审 / 冻结 / 进度.md ——
# 那些是过程文档，必须引用 PRD 原文（见模块文档）。
SCOPE_DIRS = ['contracts', 'protocol', 'tools', 'tests', 'services', 'scripts', '样例']
SCOPE_FILES = ['docker-compose.kvvi.yml', 'docker-compose.yml', 'package.json']
FORK_MANIFEST = os.path.join('forks', 'dsh', '改造点指纹.json')
FORK_ROOT = os.path.join('vendor', 'dsh')

# 文本扩展名。二进制与未知类型直接跳过 —— 逐个试解码太慢。
TEXT_EXT = {
    '.md', '.json', '.jsonc', '.mjs', '.cjs', '.js', '.ts', '.tsx', '.jsx',
    '.py', '.sh', '.bash', '.yml', '.yaml', '.css', '.html', '.sql', '.toml',
    '.txt', '.svg',
}

# 扫描文件数下限。低于它说明范围塌了 —— 那是「恒绿」，不是「通过」。
MIN_FILES = 400

# ── 词表 ────────────────────────────────────────────────────────────────
#
# 收录标准（两条都满足才收）：
#   1. 该词**只在某个行业**里成立，不是通用平台词；
#   2. 命中即**必然是**行业假设渗入地基，不存在合理解释。
#
# 刻意**排除**的词与理由：
#   · 审批 / 状态机 / 权限 / 数据范围 —— 平台通用词，被契约正当使用
#   · 门店 / 客户 / 订单 / 库存 —— 跨行业通用，不是某一行业的「家具」
#   · 安装 / 送货 —— 软件安装、通用物流都会用，命中会有假阳性
#   · 工单 —— 制造与售后通用，不足以断言行业
# 宁可少收也不用会误报的词：**误报会让整套检查被绕过**。
LEXICON: Dict[str, List[str]] = {
    # ① 家具 —— `0A-14` 判据点名的「这类家具词」
    '家具': [
        '报货单', '报货', '量尺', '板材', '五金', '沙发', '橱柜', '衣柜',
        '木门', '地板', '卫浴', '灯具', '导购', '家具', '定制柜', '装修',
    ],
    # ② 其他垂直行业 —— 同为「地基被单一行业污染」的证据
    '餐饮': ['菜品', '桌台', '翻台', '后厨', '点单'],
    '医疗': ['病历', '门诊', '住院', '处方', '医嘱'],
    '政务': ['政务大厅', '行政许可', '办事指南'],
    '教育': ['学籍', '课程表', '班主任'],
    '物流': ['运单', '面单', '分拨'],
    # ⚠️ 刻意不收 `BOM` —— 它在 JSON 世界里是 **Byte Order Mark**，
    #    本仓库 `bundle-policy.mjs` 与 c14n 向量里都正当使用它。
    #    这是实测出来的假阳性：一个词表错误会让整套检查被当成噪声而绕过。
    '制造': ['产线', '工位'],
    '房产': ['房源', '看房', '佣金结算'],
}

# 整文件豁免：相对仓库根的路径前缀。
EXEMPT: Dict[str, str] = {
    # `0A-14` 的检查器本身要**写出**这些词，否则无法检查。
    '工具/check_industry_neutral.py': '本检查器；词表必须包含这些词才能检查',
    '工具/check_industry_neutral_自测.sh': '反向测试；必须注入行业词才能证明检查器会红',
    'docs/': '过程文档，必须引用 PRD 原文',
    # 行业扩展包（PRD §5.7.3、任务 `0C-6`）。
    #
    # ⚠️ 这是**唯一**一处按目录豁免行业词的地方，而且它是设计的一部分：
    # 行业内容**只允许**出现在扩展包里；地基出现行业词才是问题。
    # 「地基未被改动」由 `工具/check_industry_pack.py` 用加包前的内容指纹复核 ——
    # 否则「豁免」就等于「这一类检查在这里失效」。
    '样例/行业包/': '行业扩展包：按 PRD §5.7.3，行业内容只允许出现在这里；'
                    '地基是否被改动由 check_industry_pack.py 复核',
}

# 逐处豁免：`(相对路径, 词) -> 理由`。
#
# 这里的每一项都是**「禁止性提及」** —— 文件在**告诫不要使用**这些词。
# 告诫必须能叫出被禁止的名字，否则无法表达。
#
# 判据收紧的两点：
#   · 理由必填：空理由直接判为配置错误，不是通过；
#   · **过期检查**：每条豁免必须至少命中一处，否则报「豁免失效」——
#     和 G2 的登记项一样，避免清单越长越假。
ALLOWED_MENTIONS: Dict[Tuple[str, str], str] = {
    ('vendor/dsh/packages/preset/agent-presets/presets/kvvi-builder/agent.cordis.yml', '报货单'):
        '搭建引擎人格里**明令禁止**这些词：「Do not reach for …」',
    ('vendor/dsh/packages/preset/agent-presets/presets/kvvi-builder/agent.cordis.yml', '报货'):
        '同上，禁令的一部分',
    ('vendor/dsh/packages/preset/agent-presets/presets/kvvi-builder/agent.cordis.yml', '病历'):
        '同上，禁令的一部分',
    ('vendor/dsh/packages/preset/agent-presets/presets/kvvi-builder/skills/data-model/SKILL.md', '报货单'):
        'Skill 里**明令禁止**把行业词当原语：「也不要引入…这类行业家具当作原语」',
    ('vendor/dsh/packages/preset/agent-presets/presets/kvvi-builder/skills/data-model/SKILL.md', '报货'):
        '同上，禁令的一部分',
    ('vendor/dsh/packages/preset/agent-presets/presets/kvvi-builder/skills/data-model/SKILL.md', '病历'):
        '同上，禁令的一部分',
    ('vendor/dsh/packages/preset/agent-presets/presets/kvvi-builder/skills/data-model/SKILL.md', '家具'):
        '同上，禁令的一部分',
}

# ── 正向判据：行业扩展点 ────────────────────────────────────────────────
PRESET_DIR = os.path.join(
    'vendor', 'dsh', 'packages', 'preset', 'agent-presets', 'presets', 'kvvi-builder',
)
EXTENSION_EVIDENCE = [
    # (路径, 必须出现的内容, 说明)
    (os.path.join(PRESET_DIR, 'agent.cordis.yml'), 'customSkillDirs',
     'Skill 目录来自可追加的列表 —— 行业包以「多一个目录」的方式接入'),
    (os.path.join(PRESET_DIR, 'agent.cordis.yml'), 'skills/',
     '基础目录由 baseUrl 解析，随预设走'),
]


def in_exempt(rel: str) -> bool:
    for prefix in EXEMPT:
        if rel == prefix or rel.startswith(prefix):
            return True
    return False


def scope_paths(paths: List[str]):
    """产出 (绝对路径, 用于显示的相对路径) 的迭代器。"""
    for rel in paths:
        abs_path = os.path.join(ROOT, rel)
        if os.path.isfile(abs_path):
            yield abs_path, rel
            continue
        for base, dirs, files in os.walk(abs_path):
            dirs[:] = [d for d in dirs if d not in ('.git', 'node_modules', '__pycache__', '.venv')]
            for name in files:
                full = os.path.join(base, name)
                yield full, os.path.relpath(full, ROOT)


def default_paths() -> List[str]:
    paths = [d for d in SCOPE_DIRS if os.path.isdir(os.path.join(ROOT, d))]
    paths += [f for f in SCOPE_FILES if os.path.isfile(os.path.join(ROOT, f))]
    manifest = os.path.join(ROOT, FORK_MANIFEST)
    if os.path.isfile(manifest):
        with open(manifest, encoding='utf-8') as fh:
            for rel in json.load(fh).get('files', {}):
                paths.append(os.path.join(FORK_ROOT, rel))
    return paths


def scan(paths: List[str]) -> Tuple[List[Dict], int]:
    """返回 (命中列表, 实际扫描的文件数)。"""
    hits: List[Dict] = []
    scanned = 0
    for abs_path, rel in scope_paths(paths):
        if in_exempt(rel) or os.path.splitext(abs_path)[1].lower() not in TEXT_EXT:
            continue
        try:
            with open(abs_path, encoding='utf-8') as fh:
                lines = fh.read().splitlines()
        except (OSError, UnicodeDecodeError):
            continue
        scanned += 1
        for lineno, line in enumerate(lines, 1):
            for industry, words in LEXICON.items():
                for word in words:
                    if word in line:
                        hits.append({
                            'file': rel, 'line': lineno, 'industry': industry,
                            'word': word, 'text': line.strip()[:120],
                            'allowed': ALLOWED_MENTIONS.get((rel, word), ''),
                        })
    return hits, scanned


def audit_allowlist(hits: List[Dict]) -> List[str]:
    """检查豁免清单本身是否成立：理由必填、且不得成为空挂。"""
    problems = []
    for (rel, word), reason in ALLOWED_MENTIONS.items():
        if not reason.strip():
            problems.append('豁免 (%s, %s) 没有理由 —— 无理由的豁免等于取消检查' % (rel, word))
        elif not any(h['file'] == rel and h['word'] == word for h in hits):
            problems.append('豁免 (%s, %s) 已失效（扫描面里没有这处命中）—— 请删除' % (rel, word))
    return problems


def check_extension_point() -> List[str]:
    """正向判据：行业扩展点存在。返回问题列表（空 = 通过）。"""
    problems = []
    for rel, needle, why in EXTENSION_EVIDENCE:
        path = os.path.join(ROOT, rel)
        if not os.path.isfile(path):
            problems.append('缺少 %s —— %s' % (rel, why))
            continue
        with open(path, encoding='utf-8') as fh:
            if needle not in fh.read():
                problems.append('%s 里找不到 %r —— %s' % (rel, needle, why))
    # 基础 Skill 目录必须真的存在，否则「可追加」是空话
    skills = os.path.join(ROOT, PRESET_DIR, 'skills')
    if not os.path.isdir(skills):
        problems.append('缺少 %s —— 基础 Skill 目录不存在，扩展点无处可追加' % skills)
    return problems


def main() -> int:
    as_json = '--json' in sys.argv
    if '--paths' in sys.argv:
        index = sys.argv.index('--paths')
        paths = sys.argv[index + 1:]
        if not paths:
            print('✗ --paths 需要一个或多个路径')
            return 2
    else:
        paths = default_paths()

    hits, scanned = scan(paths)
    total_words = sum(len(v) for v in LEXICON.values())
    allowed = [h for h in hits if h['allowed']]
    violations = [h for h in hits if not h['allowed']]
    allowlist_problems = audit_allowlist(hits)

    if as_json:
        print(json.dumps({
            'scope': paths, 'scanned_files': scanned,
            'lexicon_size': total_words, 'hits': hits,
        }, ensure_ascii=False, indent=2))
        return 0 if not hits else 1

    print('=== `0A-14` 去行业化自查 ===')
    print('判据：代码里没有「报货单」这类家具词（KVVI-Builder progress.json）')
    print()

    # ── 先查「检查本身成立吗」 ──
    if total_words == 0:
        print('✗ 词表为空 —— 这是个恒绿的检查，不是通过')
        return 2
    if scanned < MIN_FILES:
        print('✗ 只扫到 %d 个文件（下限 %d）—— 扫描面塌了，结果不可信'
              % (scanned, MIN_FILES))
        print('  检查范围：%s' % ', '.join(paths[:8]))
        return 2

    print('[1] 扫描面')
    print('  文件 %d 个，词表 %d 个词（%d 个行业）'
          % (scanned, total_words, len(LEXICON)))
    print()

    print('[2] 负向：地基里没有行业词')
    if violations:
        print('  ✗ %d 处违规：' % len(violations))
        for hit in violations:
            print('    %s:%d  [%s] 「%s」' % (hit['file'], hit['line'],
                                            hit['industry'], hit['word']))
            print('        %s' % hit['text'])
    else:
        print('  ✓ 0 处违规')
    if allowed:
        print('  · %d 处为「禁止性提及」（豁免清单，逐条带理由）：' % len(allowed))
        for hit in allowed:
            print('    %s:%d 「%s」 —— %s' % (hit['file'], hit['line'],
                                             hit['word'], hit['allowed']))
    print()

    print('[3] 豁免清单自身是否成立')
    if allowlist_problems:
        for p in allowlist_problems:
            print('  ✗ %s' % p)
    else:
        print('  ✓ %d 条豁免全部有效（理由齐备、无失效条目）' % len(ALLOWED_MENTIONS))
    print()

    print('[4] 正向：行业扩展点存在（地基中立 ≠ 长不出行业）')
    problems = check_extension_point()
    if problems:
        for p in problems:
            print('  ✗ %s' % p)
    else:
        print('  ✓ 预设的 Skill 目录是可追加列表（`customSkillDirs`），'
              '行业包以「多一个目录」接入')
    print()

    ok = not violations and not problems and not allowlist_problems
    print('✓ 通过：地基中立，且留了行业扩展口' if ok
          else '✗ 未通过：%d 处违规 / %d 项扩展点问题 / %d 项豁免问题'
               % (len(violations), len(problems), len(allowlist_problems)))
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
