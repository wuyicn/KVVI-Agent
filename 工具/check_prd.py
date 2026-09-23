#!/usr/bin/env python3
"""PRD 一致性自动核查器。

## 为什么要有这个工具

这句话在 PRD 的 §0.7 里被写过两次，而**同类错误仍然发生了三次**：

    计数、版本号、章节引用这类事实，必须用工具核实，不能凭记忆写。

第三次发生时（v2.7），评审者指出：

    「它发生在 v2.7 自己立下『计数必须用工具核实』规矩的同一版本里
      ——说明该教训仍未被工具化执行。」

**写进文档的教训，如果没有变成可执行的检查，就等于没写。**
本工具就是把那条教训变成机制：凡是「记忆容易写错、工具一查就准」的事实，
一律由本脚本核查，不再依赖人工。

## 核查项

| # | 检查 | 防的是已发生过的哪次错误 |
|---|---|---|
| 1 | 小节编号顺序 | §4.6.4 排在 §4.6.3 之前（v2.7 第七轮发现）|
| 2 | 交叉引用有效性 | 引用不存在的章节 |
| 3 | 表格列数一致 | 编辑时吞掉换行导致两行并一行（v2.5 发生过）|
| 4 | 转义管道符 | `\\|` 在表格内被误算成列分隔 |
| 5 | 评审轮次一致性 | §9.12 写「四轮」正文却五轮、§10.4 残留「四轮」（连续三次）|
| 6 | 版本状态残留 | 「v2.6 仍需独立验证」而 v2.7 已存在 |
| 7 | 已废弃表述残留 | 「技术上不可达」「构造性保证」「插件不得绕过」当作当前主张 |
| 8 | 数字自称与表格行数 | 「四条规则」表里只有三行（v2.6 发生过）|
| 9 | 代码围栏配对 / 标题层级 | 结构性损坏 |

用法：
    python3 check_prd.py            # 核查，输出问题列表；有问题则退出码 1
    python3 check_prd.py --quiet    # 只输出结论
"""
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
PRD = ROOT / 'KVVI-Agent 开发文档 PRD.md'

# 已废弃的表述：允许出现在「历史记录 / 已标注删除」的上下文里，
# 若出现在别处则视为残留。
RETIRED_PHRASES = {
    '技术上不可达': 'v2.6 已收窄为「对搭建者与员工」',
    '构造性保证': 'v2.5 声称，v2.6 判定不成立',
    '插件不得绕过': 'v2.7 已删除该保证性表述',
    '插件不得访问业务数据面': 'v2.7 已删除该保证性表述',
}
# 判定为「历史上下文」的标记
HISTORICAL_MARKERS = [
    '曾', '原写', '已删除', '已收窄', '已改', '不成立', '误用', '自我否定',
    '不能同时为真', 'v2.1', 'v2.2', 'v2.3', 'v2.4', 'v2.5', 'v2.6', 'v2.7',
    '历史', '⚠️', '~~', '复评', '第一轮', '第二轮', '第三轮', '第四轮',
    '第五轮', '第六轮', '第七轮', '订正', '更正',
]


def strip_markdown(s):
    """去掉强调符，使 `**四轮**评审` 也能被 `四轮评审` 匹配到。

    这个坑真实发生过两次：人工 grep「轮评审的发现已全部处理」漏掉了
    `**四轮**评审的发现已全部处理`，导致一度误判评审「编造问题」。
    """
    return s.replace('**', '').replace('*', '').replace('`', '')


def load():
    text = PRD.read_text(encoding='utf-8')
    return text, text.splitlines()


def blocks_of(lines):
    """把行切成连续非空块（段落/引用块/表格），返回 [(起始行号, 文本)]。"""
    out, start, buf = [], None, []
    for i, line in enumerate(lines, 1):
        if line.strip():
            if start is None:
                start = i
            buf.append(line)
        else:
            if buf:
                out.append((start, '\n'.join(buf)))
            start, buf = None, []
    if buf:
        out.append((start, '\n'.join(buf)))
    return out


def revision_history_span(lines):
    """§0 修订说明 的行号区间 —— 该区间内的版本状态陈述属历史记录。"""
    start = end = None
    for i, l in enumerate(lines, 1):
        if re.match(r'^##\s*0\.\s*修订说明', l):
            start = i
        elif start and re.match(r'^##\s*1\.\s', l):
            end = i
            break
    return (start or 1, end or 1)


def check_heading_order(lines):
    """小节编号必须在其父节内单调递增。"""
    problems = []
    seen = {}
    for i, line in enumerate(lines, 1):
        m = re.match(r'^(#{2,4})\s+(\d+(?:\.\d+)*)', line)
        if not m:
            continue
        num = m.group(2)
        parts = num.split('.')
        parent = '.'.join(parts[:-1])
        key = parts[-1]
        if not key.isdigit():
            continue
        key = int(key)
        if parent in seen and key < seen[parent][0]:
            problems.append(
                f'  行{i}: §{num} 出现在 §{parent}.{seen[parent][0]} 之后（行 {seen[parent][1]}）'
                f' —— 编号顺序错乱'
            )
        seen[parent] = (key, i)
    return problems


def check_cross_refs(lines, heads):
    problems = []
    for i, line in enumerate(lines, 1):
        for ref in set(re.findall(r'§(\d+(?:\.\d+)*)', line)):
            # §7.29 属 KVVI-Builder 的 PRD 章节号，是外部引用
            if ref.startswith('7.29'):
                continue
            if ref not in heads:
                problems.append(f'  行{i}: 引用了不存在的 §{ref}')
    return problems


def check_tables(lines):
    """表格列数一致 + 转义管道符检查。"""
    problems = []
    raw_pipe = lambda s: len(re.findall(r'(?<!\\)\|', s))

    i = 0
    while i < len(lines):
        if lines[i].strip().startswith('|') and i + 1 < len(lines) \
                and re.match(r'^\|[\s:|-]+\|$', lines[i + 1].strip()):
            start = i
            widths = []
            while i < len(lines) and lines[i].strip().startswith('|'):
                widths.append(raw_pipe(lines[i]))
                i += 1
            if len(set(widths)) > 1:
                problems.append(f'  行{start+1}: 表格列数不一致 {sorted(set(widths))}')
        i += 1
    return problems


CN_NUM = {'一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9}


def check_round_counts(lines):
    """评审轮次：取全文出现的最大轮次作为真值，报告与之不符的当前主张。"""
    problems = []
    chinese = CN_NUM
    claims = []
    for i, line in enumerate(lines, 1):
        flat = strip_markdown(line)
        for cn, val in chinese.items():
            if f'{cn}轮评审' in flat:
                claims.append((i, cn, val, flat.strip()[:70]))
    if not claims:
        return problems, 0
    truth = max(c[2] for c in claims)
    for i, cn, val, snippet in claims:
        if val == truth:
            continue
        # 历史/变更记录中的引用是合法的
        if any(k in snippet for k in ['改为', '标题', '与正文', '不符', '残留', '第', '漏掉', '原文是', '例如', '如 §']):
            continue
        problems.append(f'  行{i}: 写「{cn}轮评审」，但全文最大为 {truth} 轮 —— {snippet}')
    return problems, truth


def check_version_residue(lines, current):
    """「vX.Y 仍需/尚待 验证」状态声明。

    §0 修订说明区内的此类陈述是**当时状态的如实记录**，不算残留；
    区外（如 §9.12、§10.4）的同类陈述则必须是当前版本，否则是残留。
    """
    problems = []
    rstart, rend = revision_history_span(lines)
    # 引用旧文本作为「问题描述」的段落不算残留（如表中的「残留『v2.6 仍需…』」）
    quote_markers = ['残留', '改为', '曾写', '原写', '复评', '问题', '不适用']
    for i, line in enumerate(lines, 1):
        if rstart <= i < rend:
            continue
        if any(mk in line for mk in quote_markers):
            continue
        for m in re.finditer(r'v(\d+\.\d+)\s*\*{0,2}\s*(仍需|尚待|尚需|待第)', line):
            ver = 'v' + m.group(1)
            if ver != current:
                problems.append(
                    f'  行{i}: 仍写「{ver} {m.group(2)}…」，但当前版本是 {current} —— 状态残留'
                )
    return problems


def check_retired(lines):
    """已废弃表述若出现在**非历史语境**的段落块中，视为残留。

    只看单行会误报：同一段里往往前半句在讲「v2.5 曾写」，后半句才引用该表述。
    故以**连续非空块**为判断单位。
    """
    problems = []
    line_to_block = {}
    for start, body in blocks_of(lines):
        for offset in range(body.count('\n') + 1):
            line_to_block[start + offset] = body
    for i, line in enumerate(lines, 1):
        body = line_to_block.get(i, line)
        for phrase, why in RETIRED_PHRASES.items():
            if phrase not in line:
                continue
            if any(mk in body for mk in HISTORICAL_MARKERS):
                continue
            problems.append(
                f'  行{i}: 「{phrase}」出现在非历史上下文（{why}）—— {line.strip()[:70]}'
            )
    return problems


def check_count_claims(lines):
    """「N 条/类/项 X」后紧跟的表格，行数应与 N 相符。"""
    problems = []
    cn = {'一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10}
    for i, line in enumerate(lines):
        m = re.match(r'^#{3,4}\s+(\d+(?:\.\d+)*)\s+([一二三四五六七八九十])([条类项种])', line)
        if not m:
            continue
        claimed = cn.get(m.group(2))
        # 向下找第一个表格，数它的数据行
        j = i + 1
        while j < len(lines) and not lines[j].strip().startswith('|'):
            if lines[j].startswith('#'):
                break
            j += 1
        if j >= len(lines) or not lines[j].strip().startswith('|'):
            continue
        k = j
        while k < len(lines) and lines[k].strip().startswith('|'):
            k += 1
        rows = k - j - 2          # 减去表头与分隔行
        if claimed and rows != claimed:
            problems.append(
                f'  行{i+1}: 标题称「{m.group(2)}{m.group(3)}」，但表格有 {rows} 行数据'
                f' —— {line.strip()[:50]}'
            )
    return problems


def check_structure(lines):
    problems = []
    fences = sum(1 for l in lines if l.strip().startswith('```'))
    if fences % 2:
        problems.append(f'  代码围栏 {fences} 个，未配对')
    prev = 0
    for i, line in enumerate(lines, 1):
        m = re.match(r'^(#{1,6})\s', line)
        if m:
            lv = len(m.group(1))
            if prev and lv > prev + 1:
                problems.append(f'  行{i}: 标题层级从 h{prev} 跳到 h{lv}')
            prev = lv
    return problems


def current_version(lines):
    for line in lines:
        m = re.search(r'^>\s*版本：(v\d+\.\d+)', line)
        if m:
            return m.group(1)
    return None


def main():
    quiet = '--quiet' in sys.argv
    text, lines = load()
    heads = {}
    for i, l in enumerate(lines, 1):
        m = re.match(r'^(#{2,4})\s+(\d+(?:\.\d+)*)\.?\s', l)
        if m:
            heads[m.group(2)] = i

    version = current_version(lines) or '?'
    sections = [
        ('小节编号顺序', check_heading_order(lines)),
        ('交叉引用有效性', check_cross_refs(lines, heads)),
        ('表格列数', check_tables(lines)),
        ('版本状态残留', check_version_residue(lines, version)),
        ('已废弃表述残留', check_retired(lines)),
        ('自称条数与表行数', check_count_claims(lines)),
        ('结构完整性', check_structure(lines)),
    ]
    round_problems, rounds = check_round_counts(lines)
    chinese = CN_NUM
    # 补充：**当前版本**修订说明区内的「改为「N轮」」类指代必须等于真值。
    # （第八轮复评发现：§0.9 写「改为『六轮』」而 §10.4 是「七轮」，旧检查漏掉。）
    # 只查当前版本区：更早版本区内的「先改为五轮、再改六轮」是历史记录，不应报错。
    sec_headers = [i for i, l in enumerate(lines, 1) if re.match(r'^###\s*0\.\d+\s', l)]
    if sec_headers:
        cs = sec_headers[-1]
        ce = len(lines) + 1
        for i in range(cs, len(lines) + 1):
            if re.match(r'^##\s', lines[i - 1]):
                ce = i
                break
    else:
        cs, ce = 0, 0
    cur_span = range(cs, ce)
    for i, line in enumerate(lines, 1):
        if i not in cur_span:
            continue
        flat = strip_markdown(line)
        if any(k in flat for k in ['仍写', '不符', '描述', '原文是', '例如', '矛盾', '历史', '前）', '前)']):
            continue          # 引用旧文本作为说明，不是当前版本的主张
        for m in re.finditer(r'(改为|修正为|写|指向)\s*[「『"]?([一二三四五六七八九十])轮', flat):
            val = chinese.get(m.group(2))
            if val is not None and rounds and val != rounds:
                round_problems.append(
                    f'  行{i}: 称「{m.group(1)}「{m.group(2)}轮」」，但全文真值为 {rounds} 轮'
                    f' —— {flat.strip()[:70]}'
                )
    sections.append(('评审轮次一致性', round_problems))

    total = sum(len(p) for _, p in sections)
    if not quiet:
        print(f'PRD 版本 {version} · {len(lines)} 行 · 标题 {len(heads)} 个 · 轮次 {rounds}')
        print('─' * 62)
        for name, probs in sections:
            mark = '✓' if not probs else f'✗ {len(probs)}'
            print(f'{mark:>4}  {name}')
            for p in probs:
                print(p)
        print('─' * 62)
    if total:
        print(f'共 {total} 处问题 —— 未通过')
        return 1
    print('全部核查通过')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
