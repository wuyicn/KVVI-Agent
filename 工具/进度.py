#!/usr/bin/env python3
"""KVVI-Agent 开发进度看板。

## 设计原则

**PRD 是基准（冻结、不可改）；`进度.md` 只记状态；本工具校验两者不脱节。**

为什么这样切：如果进度表里**手抄**一份锚点清单，PRD 一冻结、进度表一漂移，
两边就会各说各话。所以锚点**每次都从冻结的 PRD 里现抽**，
`进度.md` 只存「做没做」。

## 用法

    python3 工具/进度.py            # 打印看板（含锚点逐条清单与状态）
    python3 工具/进度.py --check    # 校验：PRD 指纹 / 锚点数 / 阶段数是否一致
    python3 工具/进度.py --next     # 只打印「下一步该做什么」
    python3 工具/进度.py --write    # 由本工具重新生成 进度.md 的锚点骨架
                                    # （状态列保留，锚点清单以 PRD 为准）

## 为什么 `--write` 存在

`进度.md` 里的锚点清单**必须与 PRD 逐字一致**。
手工抄写会在 PRD 修订后漂移 —— 本项目已多次发生同类问题。
故：**锚点清单由本工具生成，人只填状态列**。
"""
import hashlib
import re
import sys
from pathlib import Path
from typing import Optional

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
PRD = ROOT / 'KVVI-Agent 开发文档 PRD.md'
PROGRESS = ROOT / '进度.md'
MANIFEST = ROOT / '冻结' / '清单.sha256'

STATUS_ICON = {'未开始': '⬜', '进行中': '🟡', '已完成': '🟢'}
clean = lambda s: re.sub(r'\*+', '', s).strip()


def fingerprint() -> str:
    return hashlib.sha256(PRD.read_bytes()).hexdigest()


def frozen_fingerprint() -> Optional[str]:
    """从冻结清单里读 PRD 的指纹 —— 这是「基准」的权威来源。"""
    if not MANIFEST.is_file():
        return None
    for line in MANIFEST.read_text(encoding='utf-8').splitlines():
        if line.endswith('  KVVI-Agent 开发文档 PRD.md'):
            return line.split('  ', 1)[0]
    return None


def parse_stages():
    """从 PRD §7.1 现抽七阶段与验收锚点。"""
    lines = PRD.read_text(encoding='utf-8').splitlines()
    stages = []
    for line in lines:
        m = re.match(r'^\| \*\*(阶段[一二三四五六七]：.+?)\*\*', line)
        if not m:
            continue
        cells = [c.strip() for c in line.strip('|').split('|')]
        name = clean(cells[0])
        weeks = clean(cells[1])
        raw = cells[4] if len(cells) > 4 else ''
        raw = raw.split('<br>')[0]          # 去掉修订注记
        # 锚点以「；」分隔，且每段以 ①…⑨ 起头。
        # 不能用 `[①-⑨][^①-⑨]*` —— 锚点正文里可能出现「归阶段六④）」这类**引用**，
        # 会被误当成新锚点切开（阶段五② 就踩过这个坑）。
        anchors = []
        for part in raw.split('；'):
            part = clean(part).strip()
            if part and part[0] in '①②③④⑤⑥⑦⑧⑨':
                anchors.append(part.rstrip('；;'))
        stages.append({'name': name, 'weeks': weeks, 'anchors': anchors})
    return stages


def parse_gates():
    lines = PRD.read_text(encoding='utf-8').splitlines()
    gates = []
    for line in lines:
        if re.match(r'^\| \*\*G[1-5]\*\*', line):
            cells = [c.strip() for c in line.strip('|').split('|')]
            # 条件列**保留粗体**——直接抄进 进度.md，不要 clean()
            gates.append((clean(cells[0]), cells[1]))
    return gates


def parse_progress_status():
    """从 进度.md 读每阶段的状态、锚点达成数与备注。"""
    if not PROGRESS.is_file():
        return {}
    status = {}
    for line in PROGRESS.read_text(encoding='utf-8').splitlines():
        m = re.match(r'^\| (阶段[一二三四五六七]：[^|]+?) \| ([^|]*?) \| ([^|]*?) \| (\d+)/(\d+) \| ?([^|]*?) ?\|', line)
        if m:
            raw_status = clean(m.group(3))
            for icon in STATUS_ICON.values():        # 剥掉状态列里的图标
                raw_status = raw_status.replace(icon, '')
            status[clean(m.group(1))] = {
                'status': raw_status.strip(),
                'done': int(m.group(4)),
                'total': int(m.group(5)),
                'note': m.group(6).strip(),
            }
    return status


def parse_anchor_checks():
    """解析 进度.md 里的 `- [x] / - [ ]` —— **勾选才是真相**，不是计数。

    早先版本用「前 N 个算完成」渲染，遇到非连续完成（如 ③④⑧）就画错。
    锚点是否完成，以本文件里的 checkbox 为准。
    """
    if not PROGRESS.is_file():
        return {}
    out, cur = {}, None
    for line in PROGRESS.read_text(encoding='utf-8').splitlines():
        m = re.match(r'^\*\*(阶段[一二三四五六七]：[^*]+)\*\*', line)
        if m:
            cur = clean(m.group(1))
            continue
        m2 = re.match(r'^- \[([ xX])\] (.+)$', line)
        if m2 and cur:
            out.setdefault(cur, []).append(m2.group(1).lower() == 'x')
    return out


def parse_supplementary_stages():
    """从 `进度.md` 的「补充需求阶段状态」一节读阶段八至十二。

    ⚠️ 这些阶段**不在冻结 PRD 里** —— 它们来自
    `KVVI-Agent 私有化发行版与产品闭环补充需求-v1.0.md`。
    那个文件自称「未冻结」，所以本函数只读 `进度.md` 里**人工确认过的事实**，
    不去解析那份需求文件：**需求未冻结，就不该由工具把它当成阶段清单。**
    @returns {list} `[{name, status, gate, note}]`
    """
    if not PROGRESS.is_file():
        return []
    out = []
    for line in PROGRESS.read_text(encoding='utf-8').splitlines():
        m = re.match(r'^\| (阶段[八九十]+[一二三]?[：:][^|]+)\| ([^|]+)\| \*\*(G\d+)[^|]*\| ([^|]*)\|',
                     line)
        if not m:
            continue
        out.append({
            'name': clean(m.group(1)),
            'status': clean(m.group(2)),
            'gate': clean(m.group(3)),
            'note': clean(m.group(4)),
        })
    return out


def parse_supplementary_gates():
    """从「补充需求门禁」一节读 G6 及以后的判据。

    与 `parse_gates()` 分开：那个从**冻结 PRD** 抽，这个从 `进度.md` 抽。
    混在一起会让「PRD 里有几条门禁」这个校验失去意义。
    @returns {list} `[(门禁名, 判据)]`
    """
    if not PROGRESS.is_file():
        return []
    out = []
    for line in PROGRESS.read_text(encoding='utf-8').splitlines():
        m = re.match(r'^\| \*\*(G\d+)\*\* \| ([^|]+) \|', line)
        if m and m.group(1) not in {g[0] for g in parse_gates()}:
            out.append((m.group(1), clean(m.group(2))))
    return out


def parse_gate_status():
    if not PROGRESS.is_file():
        return {}
    out = {}
    for line in PROGRESS.read_text(encoding='utf-8').splitlines():
        m = re.match(r'^\| \*\*(G\d+)\*\* \| ([^|]+) \| ([^|]+) \|', line)
        if m:
            v = clean(m.group(3))
            for icon in STATUS_ICON.values():
                v = v.replace(icon, '')
            out[m.group(1)] = v.strip() or '未开始'
    return out


def run_check():
    stages = parse_stages()
    gates = parse_gates()
    actual, frozen = fingerprint(), frozen_fingerprint()
    problems = []

    if frozen is None:
        problems.append('冻结清单缺失或未包含 PRD —— 先运行 `cd 冻结 && python3 make_manifest.py`')
    elif actual != frozen:
        problems.append(f'PRD 指纹与冻结清单不一致\n'
                        f'    冻结清单：{frozen}\n'
                        f'    当前文件：{actual}\n'
                        f'    → PRD 在冻结后被改动过，或冻结清单未更新')

    if len(stages) != 7:
        problems.append(f'从 PRD 抽到的阶段数为 {len(stages)}，应为 7')

    st = parse_progress_status()
    for s in stages:
        rec = st.get(s['name'])
        if rec is None:
            problems.append(f'进度.md 缺少阶段「{s["name"]}」的状态行')
        elif rec['total'] != len(s['anchors']):
            problems.append(
                f'阶段「{s["name"]}」锚点数不一致：'
                f'进度.md 记 {rec["total"]}，PRD 实为 {len(s["anchors"])}'
            )

    gs = parse_gate_status()
    for name, _ in gates:
        if name not in gs:
            problems.append(f'进度.md 缺少门禁 {name} 的状态行')

    print(f'PRD 指纹 : {"✅ 与冻结清单一致" if actual == frozen else "❌ 不一致"}')
    print(f'阶段数   : {"✅" if len(stages) == 7 else "❌"} {len(stages)}')
    print(f'锚点总数 : {sum(len(s["anchors"]) for s in stages)}')
    print(f'门禁数   : {"✅" if len(gates) == 5 else "❌"} {len(gates)}')
    print()
    if problems:
        print('发现问题：')
        for p in problems:
            print(f'  ✗ {p}')
        return 1
    print('✅ 进度.md 与冻结 PRD 一致（锚点数、阶段数、门禁数、指纹）')
    return 0


def run_board():
    stages = parse_stages()
    gates = parse_gates()
    status = parse_progress_status()
    gstat = parse_gate_status()
    fp = fingerprint()
    frozen = frozen_fingerprint()

    total_anchors = sum(len(s['anchors']) for s in stages)
    _ck = parse_anchor_checks()
    done_anchors = sum(sum(v) for v in _ck.values())
    done_stages = sum(1 for s in stages
                      if status.get(s['name'], {}).get('status') == '已完成')

    print('═' * 74)
    print('  KVVI-Agent 开发进度')
    print('═' * 74)
    print(f'  PRD      v2.16  ' + (f'{fp[:16]}…' + ('  ✅ 与冻结一致' if fp == frozen else '  ⚠️ 与冻结不一致'))
          )
    # ⚠️ 这一行**只报 v2.16 的七阶段**，括号里把范围写出来。
    # 补充需求的阶段八至十二另起一段 —— 两者来源不同、冻结状态不同，
    # 把它们的完成度并进一个分子分母会让「7/7」这句话不可核对。
    print(f'  总进度   {done_stages}/{len(stages)} 阶段完成（v2.16 冻结范围）  ·  '
          f'锚点 {done_anchors}/{total_anchors}')
    supp_done = sum(1 for x in parse_supplementary_stages() if x['status'] == '已完成')
    supp_all = parse_supplementary_stages()
    if supp_all:
        print(f'  补充需求 {supp_done}/{len(supp_all)} 阶段完成（**未冻结**，见下表）')
    print('─' * 74)

    checks = parse_anchor_checks()
    for s in stages:
        rec = status.get(s['name'], {'status': '未开始', 'done': 0, 'total': len(s['anchors'])})
        icon = STATUS_ICON.get(rec['status'], '⬜')
        marks = checks.get(s['name'], [])
        bar_total = len(s['anchors'])
        bar_done = sum(marks) if len(marks) == bar_total else rec['done']
        bar = '█' * bar_done + '░' * (bar_total - bar_done) if bar_total else ''
        print(f'  {icon} {s["name"]}  [{s["weeks"]}]  {bar_done}/{bar_total}  {bar}')
        for i, a in enumerate(s['anchors']):
            mark = '✓' if (marks[i] if i < len(marks) else False) else ' '
            print(f'       [{mark}] {a[:96]}')
        print()

    # 补充需求的阶段**单独一段**。
    # 不与 v2.16 的七阶段混排：两者的来源、冻结状态、门禁编号都不同，
    # 混在一起会让「7/7 阶段完成」这句话变得不可核对。
    supp = parse_supplementary_stages()
    if supp:
        print('─' * 74)
        print('  补充需求阶段（来自私有化发行版与产品闭环补充需求，**未冻结**）')
        for st in supp:
            icon = STATUS_ICON.get(st['status'], '⬜')
            print(f'  {icon} {st["name"]}  [{st["gate"]}]  {st["status"]}')
        print()

    print('─' * 74)
    print('  阶段门禁' + '（未通过则下一阶段不得启动）')
    for name, cond in gates:
        st = gstat.get(name, '⬜')
        print(f'    {st} {name}  {cond[:70]}')
    for name, cond in parse_supplementary_gates():
        st = gstat.get(name, '⬜')
        print(f'    {st} {name}  {cond[:70]}')

    print('─' * 74)
    nxt = next((s for s in stages if status.get(s['name'], {}).get('status') != '已完成'),
               None)
    if nxt:
        # 第一条**未勾选**的锚点 —— 不是「第 done 条」。
        # 锚点可非连续完成，按序号取会把已完成的锚点当成下一步。
        marks = checks.get(nxt['name'], [])
        i = next((k for k, m in enumerate(marks) if not m), len(marks))
        print(f'  下一步   {nxt["name"]}')
        if i < len(nxt['anchors']):
            print(f'           {nxt["anchors"][i]}')
    print('═' * 74)


def anchor_marks(name: str, count: int) -> list:
    """该阶段每个锚点的勾选状态，长度恒为 `count`。

    **不能用「前 N 个算完成」。** 锚点可以**非连续**完成（阶段三就是 ①③ 完成、
    ②④ 未完成），按序号前缀渲染会把已完成的画成未完成、把未完成的画成已完成。

    早先版本正是这样：`- [x]` 从 ③ 挪到了 ① —— 一次 `--write` 就能把进度表
    **改成假的**，而且改得看不出来。所以这里以现有文件的 checkbox 为准。
    """
    marks = parse_anchor_checks().get(name, [])
    if len(marks) == count:
        return marks
    return [False] * count


def open_items() -> list:
    """原样取回「未关闭事项」一节（表头之后、下一个 `---` 之前）。

    这一节**没有任何 PRD 对应物** —— 它是人工积累的未决问题清单。
    `--write` 的职责是重生成锚点，不是丢弃它没能力生成的段落。

    只去掉两端由 `run_write` 固定重写的行：
    开头的 `| — |` 占位行、结尾的「冻结记录中…」说明段。
    中间可以夹任意内容（N3 的解决说明就是一段夹在表格中间的长引用）。
    """
    if not PROGRESS.is_file():
        return []
    lines = PROGRESS.read_text(encoding='utf-8').splitlines()
    try:
        start = lines.index('| # | 事项 | 阻断范围 | 状态 |') + 2
        # ⚠️ 结束边界**不是「表头之后的第一个 `---`」** —— 表头下面紧跟的
        # `|---|---|---|---|` 分隔行是连续的短横线，`line[1]` 不是 `-`，
        # 侥幸躲过了；但表格**下方**还可能有引用块与说明，而它们**之后**
        # 才真正出现 `---`。找「第一个」会把它们**整段吃掉**。
        # 正确的边界是：下一个二级标题之前的最后一条水平线（没有二级标题就取文末）。
        nxt = next((i for i in range(start, len(lines))
                    if lines[i].startswith('## ') and i > start), len(lines))
        end = max((i for i in range(start, nxt) if lines[i].startswith('---')),
                  default=nxt)
    except (ValueError, StopIteration):
        return []
    block = lines[start:end]

    def is_noise(line: str) -> bool:
        return not line.strip() or line.lstrip().startswith('>')

    while block and (block[0].startswith('| — |') or not block[0].strip()):
        block.pop(0)
    while block and (is_noise(block[-1]) or block[-1].startswith('| — |')):
        block.pop()
    return block


def _section(title: str) -> list:
    """原样取回 `进度.md` 里以 `### <title>` 开头的一整节（到下一个同级或更高级标题）。

    与 `open_items()` 同一个理由：`--write` 的职责是重生成锚点，
    **不是丢弃它没能力生成的段落**。补充需求那两节来自另一份文件，
    本工具无法生成它们 —— 所以必须搬回来。

    ⚠️ 第一次写这两个解析器时漏了这一步，实测 `--write` 把它们整段删掉。
    这个形态在本仓库出现过多次：**生成器只搬它认识的东西，不认识的就静默消失。**
    @param title 二级标题文本（不含 `### `）
    @returns 该节的行（含标题行）
    """
    if not PROGRESS.is_file():
        return []
    lines = PROGRESS.read_text(encoding='utf-8').splitlines()
    head = '### ' + title
    try:
        start = lines.index(head)
    except ValueError:
        return []
    end = len(lines)
    for i in range(start + 1, len(lines)):
        if lines[i].startswith('### ') or lines[i].startswith('## '):
            end = i
            break
    block = lines[start:end]
    # 去掉两端**由 run_write 固定重写**的那几行 —— 与 `open_items()` 同一个做法。
    # 不去掉的话它们既被生成器写一遍、又被本函数搬一遍，每跑一次 `--write`
    # 就多出一份（实测 diff 里重复出现）。
    GENERATED = ('> **状态取值**', '> **🟢 的判据**', '> **门禁的含义**')
    keep = []
    for line in block:
        if any(line.startswith(g) for g in GENERATED):
            continue
        keep.append(line)
    block = keep
    while block and (not block[-1].strip() or block[-1].strip() == '---'):
        block.pop()
    while block and not block[-1].strip():
        block.pop()
    return block


SUPPLEMENTARY_SECTIONS = ('补充需求阶段状态', '补充需求门禁')


def run_write():
    """由 PRD 重新生成 进度.md 的锚点骨架；已存在的状态列与勾选保留。"""
    stages = parse_stages()
    gates = parse_gates()
    old = parse_progress_status()
    old_g = parse_gate_status()
    frozen = frozen_fingerprint() or fingerprint()

    def status_of(name):
        rec = old.get(name)
        anchors = [s for s in stages if s['name'] == name][0]['anchors']
        if rec and rec['total'] == len(anchors):
            # 达成数**从勾选数推导**，不沿用旧计数 —— 否则两处会漂移。
            return rec['status'], sum(anchor_marks(name, len(anchors)))
        return '未开始', 0

    out = ["# KVVI-Agent 开发进度", "",
           "> **这是一份「打开就能看」的状态文件。** 详尽的定义在冻结的 PRD 里，此处只记**做到哪了**。",
           "> ⚠️ **不要手改锚点清单**——它由 `python3 工具/进度.py --write` 从 PRD 生成；",
           "> 手改会在 PRD 修订后漂移。**人只填两处**：「状态」列，以及锚点前的勾选框",
           "> （**勾选才是真相**）。「锚点达成」列与勾选框不一致时以勾选框为准。", "",
           "---", "", "## 基准", "", "| 项 | 值 |", "|---|---|",
           "| PRD 版本 | **v2.16**（冻结） |",
           f"| PRD 指纹 | `{frozen}` |",
           "| 冻结标签 | `prd-v2.16-freeze` |",
           "| 校验命令 | `python3 工具/进度.py --check` |",
           f"| 阶段数 / 锚点数 / 门禁数 | **{len(stages)} / {sum(len(s['anchors']) for s in stages)} / {len(gates)}** |",
           "", "---", "", "## 阶段状态", "",
           "| 阶段 | 周期 | 状态 | 锚点达成 | 备注 |", "|---|---|---|---|---|"]
    for s in stages:
        st, done = status_of(s['name'])
        # 备注列由人维护（进度依据、取证命令…），**必须原样保留** ——
        # 它不是 PRD 推导出来的。早先版本写死为空，一次 `--write` 就把它抹掉。
        note = (old.get(s['name']) or {}).get('note', '')
        out.append(f"| {s['name']} | {s['weeks']} | {st} | {done}/{len(s['anchors'])} | {note} |")

    # 补充需求的阶段表**紧跟在 v2.16 七阶段的表之后**。
    #
    # ⚠️ 位置要与人工维护时一致，否则每次 `--write` 都会把它搬到别处 ——
    # 内容没丢，但 diff 里看起来像被删了一遍（实测 48 行位移）。
    # 一个「每次都产生无意义 diff」的生成器，会让人不敢跑它。
    out += [""]
    for block in _section(SUPPLEMENTARY_SECTIONS[0]):
        out.append(block)

    out += ["", "> **状态取值**：`未开始` / `进行中` / `已完成`（可写 `进行中`，图标由看板渲染）。",
            "> **🟢 的判据**：该阶段**全部锚点通过**才算完成——不接受「基本做完」「功能可用」（PRD §7.1 表后规则）。",
            "", "### 各阶段锚点（由 PRD 生成，勿手改）", ""]
    for s in stages:
        st, done = status_of(s['name'])
        out.append(f"**{s['name']}**  [{s['weeks']}]")
        out.append("")
        for mark, a in zip(anchor_marks(s['name'], len(s['anchors'])), s['anchors']):
            out.append(f"- [{'x' if mark else ' '}] {a}")
        out.append("")

    out += ["---", "", "## 阶段门禁", "", "| 门禁 | 条件 | 状态 |", "|---|---|---|"]
    for name, cond in gates:
        out.append(f"| **{name}** | {cond} | {old_g.get(name, '未开始')} |")
    for block in _section(SUPPLEMENTARY_SECTIONS[1]):
        out.append(block)
    out += ["", "> **门禁的含义**（PRD §7.5.2）：**未通过，下一阶段不得启动**——不接受「先做后面、回头补」。",
            "", "---", "", "## 未关闭事项", "", "| # | 事项 | 阻断范围 | 状态 |", "|---|---|---|---|",
            "| — | *（PRD v2.16 终审通过，当前无阻断项）* | — | — |"]
    # ⚠️ 未关闭事项**全部由人维护**，PRD 里没有对应内容 —— 必须原样搬回来。
    # 早先版本在这里写死，一次 `--write` 就会把 N1…N11 与 N3 的解决说明整段删掉。
    out += open_items()
    # 表下的指引**由生成器自己产出**，不能指望手写留在文件里 ——
    # `open_items()` 只把「表行」搬回来，表与 `---` 之间的引用块属于噪声，会被清掉。
    # 早先这一段是手写的，于是每次 `--write` 都悄悄删掉它。
    out += ["", "> **优先级排序见 `docs/未关闭事项-优先级.md`** —— 按「会不会让已写下的结论失真 /",
            "> 是否卡住交付 / 需要谁决定」三条排序，并给出「只做三件事」与「只做一件」的建议。",
            ">",
            "> 冻结记录中「不主张什么」一节仍然有效：**不主张安全评审已完成**——",
            "> 进入实现阶段后仍须由专门人员按标准方法（威胁建模等）做正式安全评审（PRD §9.12）。",
            "", "---", "", "## 怎么查", "", "```bash",
            "python3 工具/进度.py            # 打印看板（含锚点逐条清单与状态）",
            "python3 工具/进度.py --next     # 只问「下一步做什么」",
            "python3 工具/进度.py --check    # 校验进度文件与冻结 PRD 是否一致",
            "```", "",
            "**三处可查**：", "", "| 想看什么 | 看哪里 |", "|---|---|",
            "| **做到哪了** | **本文件** + `python3 工具/进度.py` |",
            "| **要做什么**（完整定义） | `KVVI-Agent 开发文档 PRD.md` §7.1 |",
            "| **为什么这么定** | `冻结/PRD-v2.16-冻结记录.md` + `评审/v2.*/汇总.md` |", ""]
    PROGRESS.write_text('\n'.join(out) + '\n', encoding='utf-8')
    print(f'✓ 进度.md 已由 PRD 重新生成：{len(stages)} 阶段 / '
          f'{sum(len(s["anchors"]) for s in stages)} 锚点 / {len(gates)} 门禁')
    return 0


def run_next():
    stages = parse_stages()
    status = parse_progress_status()
    gates = parse_gates()
    gstat = parse_gate_status()
    # ⚠️ 补充需求的门禁**也要算进来**。
    # 只算 G1–G5 的话，七阶段全过之后这里会打印「待通过门禁：（无）」——
    # 而实际上 G7–G10 一个都没过。**一个说「没有待办」的状态行，
    # 比没有这一行更坏**：它会让人以为做完了。
    supp_gates = parse_supplementary_gates()
    all_gates = list(gates) + supp_gates
    pending = [n for n, _ in all_gates if gstat.get(n) not in ('已完成', '🟢')]
    pending_v216 = [n for n, _ in gates if gstat.get(n) not in ('已完成', '🟢')]
    pending_supp = [n for n, _ in supp_gates if gstat.get(n) not in ('已完成', '🟢')]
    if pending_v216:
        print('待通过门禁（v2.16）：', ', '.join(pending_v216))
    else:
        print('待通过门禁（v2.16）：无 —— 七阶段与 G1–G5 全部达成')
    if supp_gates:
        if pending_supp:
            print('待通过门禁（补充需求）：', ', '.join(pending_supp))
        else:
            print('待通过门禁（补充需求）：无')
    else:
        print('待通过门禁（补充需求）：未登记 —— 进度.md 里没有「补充需求门禁」一节')

    ck = parse_anchor_checks()
    nxt = next((s for s in stages if status.get(s['name'], {}).get('status') != '已完成'), None)
    if nxt:
        marks = ck.get(nxt['name'], [])
        print(f'当前阶段  ：{nxt["name"]}  [{nxt["weeks"]}]')
        i = next((k for k, m in enumerate(marks) if not m), None)
        if i is None:
            print('该阶段全部锚点已达成 —— 应在 进度.md 中标记为已完成')
        else:
            print(f'下一个锚点：{nxt["anchors"][i]}')
    else:
        # 七阶段走完之后，**下一步在补充需求里** —— 不指出来，
        # 这个命令会以「没有当前阶段」结束，像是没事可做了。
        supp = parse_supplementary_stages()
        sd = next((x for x in supp if x['status'] != '已完成'), None)
        if sd is not None:
            print(f'当前阶段  ：{sd["name"]}  [{sd["gate"]}]  —— 来自补充需求（未冻结）')
            print(f'门禁判据  ：{next((c for n, c in supp_gates if n == sd["gate"]), "未登记")}')
        elif supp:
            print('补充需求的阶段全部完成')
    return 0


def main():
    if '--check' in sys.argv:
        return run_check()
    if '--next' in sys.argv:
        return run_next()
    if '--write' in sys.argv:
        return run_write()
    run_board()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
