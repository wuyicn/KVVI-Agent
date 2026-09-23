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
    """从 进度.md 读每阶段状态与锚点达成数。"""
    if not PROGRESS.is_file():
        return {}
    status = {}
    for line in PROGRESS.read_text(encoding='utf-8').splitlines():
        m = re.match(r'^\| (阶段[一二三四五六七]：[^|]+?) \| ([^|]*?) \| ([^|]*?) \| (\d+)/(\d+) \|', line)
        if m:
            raw_status = clean(m.group(3))
            for icon in STATUS_ICON.values():        # 剥掉状态列里的图标
                raw_status = raw_status.replace(icon, '')
            status[clean(m.group(1))] = {
                'status': raw_status.strip(),
                'done': int(m.group(4)),
                'total': int(m.group(5)),
            }
    return status


def parse_gate_status():
    if not PROGRESS.is_file():
        return {}
    out = {}
    for line in PROGRESS.read_text(encoding='utf-8').splitlines():
        m = re.match(r'^\| \*\*(G[1-5])\*\* \| ([^|]+) \| ([^|]+) \|', line)
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
    done_anchors = sum(status.get(s['name'], {}).get('done', 0) for s in stages)
    done_stages = sum(1 for s in stages
                      if status.get(s['name'], {}).get('status') == '已完成')

    print('═' * 74)
    print('  KVVI-Agent 开发进度')
    print('═' * 74)
    print(f'  PRD      v2.16  ' + (f'{fp[:16]}…' + ('  ✅ 与冻结一致' if fp == frozen else '  ⚠️ 与冻结不一致'))
          )
    print(f'  总进度   {done_stages}/{len(stages)} 阶段完成  ·  '
          f'锚点 {done_anchors}/{total_anchors}')
    print('─' * 74)

    for s in stages:
        rec = status.get(s['name'], {'status': '未开始', 'done': 0, 'total': len(s['anchors'])})
        icon = STATUS_ICON.get(rec['status'], '⬜')
        bar_total = len(s['anchors'])
        bar_done = rec['done']
        bar = '█' * bar_done + '░' * (bar_total - bar_done) if bar_total else ''
        print(f'  {icon} {s["name"]}  [{s["weeks"]}]  {bar_done}/{bar_total}  {bar}')
        for i, a in enumerate(s['anchors'], 1):
            mark = '✓' if i <= bar_done else ' '
            print(f'       [{mark}] {a[:96]}')
        print()

    print('─' * 74)
    print('  阶段门禁' + '（未通过则下一阶段不得启动）')
    for name, cond in gates:
        st = gstat.get(name, '⬜')
        print(f'    {st} {name}  {cond[:70]}')

    print('─' * 74)
    nxt = next((s for s in stages if status.get(s['name'], {}).get('status') != '已完成'),
               None)
    if nxt:
        rec = status.get(nxt['name'], {})
        i = rec.get('done', 0)
        print(f'  下一步   {nxt["name"]}')
        if i < len(nxt['anchors']):
            print(f'           {nxt["anchors"][i]}')
    print('═' * 74)


def run_write():
    """由 PRD 重新生成 进度.md 的锚点骨架；已存在的状态列保留。"""
    stages = parse_stages()
    gates = parse_gates()
    old = parse_progress_status()
    old_g = parse_gate_status()
    frozen = frozen_fingerprint() or fingerprint()

    def status_of(name):
        rec = old.get(name)
        if rec and rec['total'] == len([s for s in stages if s['name'] == name][0]['anchors']):
            return rec['status'], rec['done']
        return '未开始', 0

    out = ["# KVVI-Agent 开发进度", "",
           "> **这是一份「打开就能看」的状态文件。** 详尽的定义在冻结的 PRD 里，此处只记**做到哪了**。",
           "> ⚠️ **不要手改锚点清单**——它由 `python3 工具/进度.py --write` 从 PRD 生成；",
           "> 手改会在 PRD 修订后漂移。**人只填「状态」与「锚点达成」两列。**", "",
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
        out.append(f"| {s['name']} | {s['weeks']} | {st} | {done}/{len(s['anchors'])} | |")

    out += ["", "> **状态取值**：`未开始` / `进行中` / `已完成`（可写 `进行中`，图标由看板渲染）。",
            "> **🟢 的判据**：该阶段**全部锚点通过**才算完成——不接受「基本做完」「功能可用」（PRD §7.1 表后规则）。",
            "", "### 各阶段锚点（由 PRD 生成，勿手改）", ""]
    for s in stages:
        st, done = status_of(s['name'])
        out.append(f"**{s['name']}**  [{s['weeks']}]")
        out.append("")
        for i, a in enumerate(s['anchors'], 1):
            out.append(f"- [{'x' if i <= done else ' '}] {a}")
        out.append("")

    out += ["---", "", "## 阶段门禁", "", "| 门禁 | 条件 | 状态 |", "|---|---|---|"]
    for name, cond in gates:
        out.append(f"| **{name}** | {cond} | {old_g.get(name, '未开始')} |")
    out += ["", "> **门禁的含义**（PRD §7.5.2）：**未通过，下一阶段不得启动**——不接受「先做后面、回头补」。",
            "", "---", "", "## 未关闭事项", "", "| # | 事项 | 阻断范围 | 状态 |", "|---|---|---|---|",
            "| — | *（PRD v2.16 终审通过，当前无阻断项）* | — | — |", "",
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
    pending_gates = [n for n, _ in gates if gstat.get(n) not in ('已完成', '🟢')]
    print('待通过门禁：', ', '.join(pending_gates) if pending_gates else '（无）')
    nxt = next((s for s in stages if status.get(s['name'], {}).get('status') != '已完成'), None)
    if nxt:
        rec = status.get(nxt['name'], {})
        done = rec.get('done', 0)
        print(f'当前阶段  ：{nxt["name"]}  [{nxt["weeks"]}]')
        if done < len(nxt['anchors']):
            print(f'下一个锚点：{nxt["anchors"][done]}')
        else:
            print('该阶段全部锚点已达成 —— 应在 进度.md 中标记为 🟢')
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
