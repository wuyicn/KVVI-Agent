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
    python3 check_prd.py --report   # 传播检查报告：把关键概念的全部出现位置摊开

## --report 为什么存在

本 PRD 反复出现同一类错误：**修了一处，没有把同一概念在别处的表述一起改**。
评审在连续四轮里各自独立指出过它：
  v2.6 「承认插件可绕过，只改了 §4.1.1 与 §9.6.3，漏 §9.2、红线 4」
  v2.7 「接口清单测试语义未特化」
  v2.8 「新写『插件可拦截审计』，未传播到任何审计条款」
  v2.9 「为修『改一半』而做的统一，本身又是改一半」

根因是**语义传播**，机械检查抓不到。但可以把它**变得可见**：
把同一关键词的全部出现行一次性列出来，作者扫一遍就能发现哪处没跟上。
这不能替代审阅，只能替代「靠记忆回想哪里还提到过」。
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


_D = {'一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9}


def cn2int(s):
    """中文数字转整数，覆盖 一~二十（评审轮次不会更多）。"""
    if not s:
        return None
    if '十' not in s:
        return _D.get(s)
    if s == '十':
        return 10
    head, _, tail = s.partition('十')
    tens = _D.get(head, 1) if head else 1
    ones = _D.get(tail, 0) if tail else 0
    return tens * 10 + ones


CN_NUM = _D


def true_round(lines):
    """从版本头的状态行解析「已完成评审轮次」——这是唯一权威来源。

    第十一轮复评发现旧实现有循环 bug：真值取自全文「N轮评审」的最大值，
    而排除关键词里的 '第' 又过宽，把真值来源行和错误行**一起跳过了**，
    于是「§9.12 写九轮、实际已十轮」静默通过。

    正确做法：真值来自版本头，不来自被检查的断言本身。
    """
    for line in lines[:40]:
        flat = strip_markdown(line)
        m = re.search(r'([一二三四五六七八九十]+)轮评审后修订', flat)
        if m:
            return cn2int(m.group(1))
    return None


def check_round_counts(lines):
    """「N轮评审」形式的**状态断言**必须等于真值。

    关键区分：「**第**N轮评审」是序数（指某一轮），合法；
    「N轮评审的发现已全部处理」是基数（断言已处理 N 轮），必须等于真值。
    因此只检查**前面不带「第」**的出现。
    """
    problems = []
    truth = true_round(lines)
    for i, line in enumerate(lines, 1):
        flat = strip_markdown(line)
        # 引号判定必须在**原始行**上做——strip_markdown 会剥掉反引号
        raw = line
        # 基数用法不止「N轮评审」一种——第十二轮复评指出「已十轮」漏网。
        # 覆盖：N轮评审 / 已N轮 / 共N轮 / 历N轮 / 累计N轮 / 截至…已N轮
        for m in re.finditer(r'([一二三四五六七八九十]+)轮(?:评审|(?=[，。、）)]|$))', flat):
            if m.start() > 0 and flat[m.start() - 1] == '第':
                continue                      # 序数，不是状态断言
            # 原始行中若该处处于未闭合引号/反引号内，则属引用
            # 裸「N轮」（非「N轮评审」）出现在描述历史变更的句子里时，属引用而非断言
            if not m.group(0).startswith(m.group(1) + '轮评审') and \
               any(k in flat for k in ['改为', '不符', '曾', '原', '描述', '更正', '前）']):
                continue
            raw_pos = raw.find(m.group(0)[:2])
            if raw_pos > 0:
                head = raw[:raw_pos]
                # 「」『』 区分开闭；反引号同一字符用于开闭，故用奇偶判断
                in_quote = (sum(head.count(c) for c in '「『')
                            > sum(head.count(c) for c in '」』'))
                in_code = (head.count('`') % 2 == 1)
                if in_quote or in_code:
                    continue
            # 处于**未闭合引号内**的匹配是引用（在描述某个问题），不是对本文档状态的断言。
            # 判据：匹配位置之前的开引号多于闭引号。引文往往比匹配更长，
            # 因此不能要求匹配两侧紧邻引号。
            head = flat[:m.start()]
            if sum(head.count(c) for c in '「『`') > sum(head.count(c) for c in '」』`'):
                continue
            val = cn2int(m.group(1))
            if truth and val and val != truth:
                problems.append(
                    f'  行{i}: 断言「{m.group(1)}轮评审」，但版本头声明已完成 {truth} 轮'
                    f' —— {flat.strip()[:80]}'
                )
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
    """「N 条/类/项 X」后紧跟的表格，行数应与 N 相符。

    「自称条数」检查连续三轮漏检（均由外部评审发现）：
      · 第十一轮：真值取自被检查的断言本身（循环判据）
      · 第十二轮：模式只覆盖「N轮评审」，漏裸基数「已N轮」
      · 第十三轮：只认标题形式（`### x.y N类`），漏**加粗正文**形式
        （如「**v2.13 修改的 17 项**」）
    故此处同时匹配标题与「…的 N 项」式加粗正文。
    """
    problems = []
    digits = {'一': 1, '二': 2, '三': 3, '四': 4, '五': 5,
              '六': 6, '七': 7, '八': 8, '九': 9, '十': 10}
    claim_re = re.compile(r'([一二三四五六七八九十])([条类项种])')
    for i, line in enumerate(lines):
        claimed = None
        # ① 标题形式：### x.y N类/条/项
        m = re.match(r'^#{3,4}\s+(\d+(?:\.\d+)*)\s+([一二三四五六七八九十])([条类项种])', line)
        if m:
            claimed = digits.get(m.group(2))
        else:
            # ② 标题形式之二：#### …… 的 N 项（阿拉伯数字）
            m_ar = re.match(r'^#{3,4}\s+.*?的\s*(\d+)\s*[条类项种]', line)
            if m_ar:
                claimed = int(m_ar.group(1))
            else:
                # ③ 加粗正文形式：**……的 N 项**（加粗段须**以单位结尾**，避免
                #    「一条结论」这类普通短语误报）
                m2 = re.search(r'\*\*[^*]*?的\s*(\d+|[一二三四五六七八九十])\s*([条类项种])\*\*', line)
                if m2:
                    claimed = int(m2.group(1)) if m2.group(1).isdigit() else digits.get(m2.group(1))
        if not claimed:
            continue
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
        if rows != claimed:
            problems.append(
                f'  行{i+1}: 自称 {claimed}（{line.strip()[:40]}…），'
                f'但表格有 {rows} 行数据 —— {line.strip()[:60]}'
            )
    return problems


def check_anchor_numbers(lines):
    """同一条表格单元格内的 ①…⑨ 编号必须按顺序出现。

    第九轮复评发现 §7.1 阶段一锚点为 ①②③⑥④⑤ —— 新增锚点插错位置。
    需排除两类误报：
      · 「§9.4.1 ②」这类**章节内子节引用**不是列表锚点
      · 「阶段一 ⑦ / 阶段四 ⑥」这类**跨阶段引用**本就不递增
    """
    problems = []
    order = '①②③④⑤⑥⑦⑧⑨'
    for i, line in enumerate(lines, 1):
        cleaned = re.sub(r'§\s*\d+(?:\.\d+)*\s*[①-⑨]', '', line)
        found = [c for c in cleaned if c in order]
        if len(found) < 2:
            continue
        if any(k in cleaned for k in ['乱序', '这类', '重排', '例如', '曾', '原为']):
            continue
        if cleaned.count('阶段') > 1 or re.search(r'[①-⑨][^①-⑨]{0,12}§', cleaned):
            continue
        idx = [order.index(c) for c in found]
        if idx != sorted(idx):
            problems.append(f'  行{i}: 锚点编号顺序错乱 {"".join(found)}')
    return problems


def check_cross_section_counts(lines):
    """跨节引用的计数必须与被引小节标题一致。

    第九轮复评发现 §4.6.5 写「§4.6.1 的三类数据」而 §4.6.1 标题是「四类」
    —— 沿用旧计数。这是「计数漂移」在**跨节引用**上的形态，
    与表格行数检查不同，故单列。

    注意：若被引小节标题**去数字化**（如「数据归属」），本检查失去比对基准
    —— 这是已知边界，故 §4.6.1 标题去数字化后，相关引用须人工核对。
    """
    problems = []
    titled = {}
    for line in lines:
        m = re.match(r'^#{3,4}\s+(\d+\.\d+)\s+([一二三四五六七八九十])([类条项种])', line)
        if m:
            titled[m.group(1)] = (m.group(2), m.group(3))
    for i, line in enumerate(lines, 1):
        for m in re.finditer(r'§(\d+\.\d+)\s*的?\s*\*{0,2}([一二三四五六七八九十])([类条项种])', line):
            sec, num, unit = m.group(1), m.group(2), m.group(3)
            if sec in titled and titled[sec] != (num, unit):
                problems.append(
                    f'  行{i}: 称「§{sec} 的 {num}{unit}」，但 §{sec} 标题为'
                    f'「{titled[sec][0]}{titled[sec][1]}」'
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


# 传播检查关注的「容易只改一处」的概念
PROPAGATION_TERMS = [
    '动作全集', '生命周期动作', '安装、注册', '加载', '卸载',
    '私钥', '签名进程', '身份层', '插件',
    '红线 3', '可追溯',
    '永远无法', '任何路径', '无一可豁免',
    '指纹', '内容指纹',
]


def report(lines):
    """把关键概念的全部出现位置摊开，供作者做传播核查。"""
    for term in PROPAGATION_TERMS:
        hits = [(i, l.strip()) for i, l in enumerate(lines, 1) if term in l]
        if not hits:
            continue
        print(f'\n══ 「{term}」 共 {len(hits)} 处 ' + '═' * 30)
        for i, l in hits:
            print(f'  {i:>5}  {l[:110]}')


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
        ('锚点编号顺序', check_anchor_numbers(lines)),
        ('跨节引用计数', check_cross_section_counts(lines)),
        ('结构完整性', check_structure(lines)),
    ]
    round_problems, rounds = check_round_counts(lines)
    sections.append(('评审轮次一致性', round_problems))

    if '--report' in sys.argv:
        report(lines)
        return 0

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
