#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
G2 改造点校验器 —— PRD §7.5.3「未登记不得合并」的机械执行部分。

它做什么：
  用 git 现算 fork 相对基线的全部改动，与 forks/dsh/改造点清单.md 的登记比对。
    · 有改动但没登记  → 报「未登记」，退出码 1
    · 登记了但没这个改动 → 报「登记失效」，退出码 1
  指纹校验要求保留文件的摘要一致，登记删除的路径不存在；恢复删除路径同样失败。

指纹删除回归：python3 工具/test_g2_fingerprint.py

它不做什么（重要）：
  · 不判断改动「对不对」—— 只判断「有没有登记」
  · 不判断 B 类新文件的内容是否合理
  登记的正确性靠人评审，本工具只保证「登记表与代码不同步」这件事不会静默发生。
"""

import hashlib
import json
import os
import re
import subprocess
import sys
from typing import Dict, List, Optional, Tuple

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DSH = os.path.join(ROOT, 'vendor', 'dsh')
REGISTRY = os.path.join(ROOT, 'forks', 'dsh', '改造点清单.md')
FINGERPRINT = os.path.join(ROOT, 'forks', 'dsh', '改造点指纹.json')

C_OK, C_BAD, C_WARN, C_DIM, C_OFF = '\033[32m', '\033[31m', '\033[33m', '\033[90m', '\033[0m'


def git(*args: str) -> str:
    r = subprocess.run(['git', '-C', DSH] + list(args),
                       capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit('git %s 失败:\n%s' % (' '.join(args), r.stderr.strip()))
    return r.stdout


def baseline() -> str:
    """分支点 = kvvi 与 master 的 merge base。这是本清单的基线定义。"""
    for ref in ('master', 'origin/master'):
        r = subprocess.run(['git', '-C', DSH, 'merge-base', 'HEAD', ref],
                           capture_output=True, text=True)
        if r.returncode == 0 and r.stdout.strip():
            return r.stdout.strip()
    sys.exit('%s无法确定基线：vendor/dsh 里找不到 master 或 origin/master%s' % (C_BAD, C_OFF))


def actual_changes(base: str) -> List[Tuple[str, str]]:
    """返回 [(状态, 路径)]。状态取自 git 的 A/M/D/R。"""
    out = git('diff', '--name-status', '--find-renames', base, 'HEAD')
    rows = []
    for line in out.splitlines():
        parts = line.split('\t')
        if len(parts) < 2:
            continue
        status, path = parts[0][:1], parts[-1]
        rows.append((status, path))
    return rows


def registered() -> Dict[str, Tuple[str, Optional[int]]]:
    """
    解析清单里的登记项。约定：表格行以 `| **DSH-XX**` 开头，第 2 列是路径。
    路径可能是目录（以 / 结尾），校验时按前缀匹配其下所有文件。
    路径后可用「（N 个文件）」声明文件数 —— 该数字由本工具核对，不是装饰。
    """
    if not os.path.exists(REGISTRY):
        sys.exit('%s清单不存在：%s%s' % (C_BAD, REGISTRY, C_OFF))
    reg = {}
    row = re.compile(r'^\|\s*\*\*(DSH-[A-Z]\d+)\*\*\s*\|([^|]*)\|')
    for line in open(REGISTRY, encoding='utf-8'):
        m = row.match(line.strip())
        if not m:
            continue
        cid, cell = m.group(1), m.group(2)
        bt = re.findall(r'`([^`]+)`', cell)
        if not bt:
            continue
        declared = re.search(r'（\s*(\d+)\s*个文件', cell)
        path = bt[0].strip()
        # 去掉「（N 个文件，…）」这类尾注（若在反引号外）
        path = re.sub(r'\s*（.*?）\s*$', '', path).strip()
        reg[cid] = (path, int(declared.group(1)) if declared else None)
    return reg


def match(path: str, prefix: str) -> bool:
    """登记项可以是具体文件，也可以是目录前缀。"""
    if prefix.endswith('/'):
        return path.startswith(prefix)
    return path == prefix


def show() -> int:
    base = baseline()
    reg = registered()
    rows = actual_changes(base)
    print('%s=== DSH fork 改造点 ===%s' % (C_OK, C_OFF))
    print('基线 merge base : %s' % base)
    print('HEAD           : %s' % git('rev-parse', '--short', 'HEAD').strip())
    print('登记项         : %d 条' % len(reg))
    print('实际改动       : %d 个文件' % len(rows))
    print()
    print('%s-- 已登记 --%s' % (C_DIM, C_OFF))
    for cid, (prefix, declared) in sorted(reg.items()):
        hits = [p for st, p in rows if match(p, prefix)]
        n = len(hits)
        if n == 0:
            tag = '%s0 个文件%s' % (C_BAD, C_OFF)
        elif declared is not None and n != declared:
            tag = '%s%d 个文件（清单写 %d）%s' % (C_WARN, n, declared, C_OFF)
        else:
            tag = '%s%d 个文件%s' % (C_OK, n, C_OFF)
        print('  %-8s %-50s %s' % (cid, prefix, tag))
    return 0


def dirty() -> List[Tuple[str, str]]:
    """
    工作区未提交的改动。**必查**，因为它会让"已提交的 fork"和"你眼前的 fork"不是同一个东西。

    这不是洁癖：本项目真实发生过「以为削减好了、其实没提交」—— 当时如果 --check 会红，
    这个错误在当场就会暴露，而不是等到读 diff 时才发现方向都读反了。
    """
    out = git('status', '--porcelain')
    rows = []
    for line in out.splitlines():
        if not line.strip():
            continue
        status, path = line[:2].strip(), line[3:].strip()
        rows.append((status, path))
    return rows


def check() -> int:
    base = baseline()
    reg = registered()
    rows = actual_changes(base)
    paths = [p for p, _ in reg.values()]

    ok = True

    dirty_rows = dirty()
    if dirty_rows:
        ok = False
        print('%s✗ 工作区有未提交的改动 %d 处%s —— 未提交就无法登记，也无法与基线比对' %
              (C_BAD, len(dirty_rows), C_OFF))
        for status, path in dirty_rows:
            print('    %-2s %s' % (status, path))
        print('  %s→ 先 commit（走完登记）或 checkout 撤销，再跑本检查%s' % (C_DIM, C_OFF))
        print()


    unregistered = [(st, p) for st, p in rows
                    if not any(match(p, pre) for pre in paths)]
    if unregistered:
        ok = False
        print('%s✗ 未登记的改动 %d 处%s —— 违反 §7.5.3「未登记不得合并」' %
              (C_BAD, len(unregistered), C_OFF))
        for status, path in unregistered:
            print('    %s  %s' % (status, path))
        print('  %s→ 请登记进 forks/dsh/改造点清单.md，或撤销该改动%s' % (C_DIM, C_OFF))
        print()

    stale = []
    wrong_count = []
    for cid, (prefix, declared) in sorted(reg.items()):
        n = len([1 for st, p in rows if match(p, prefix)])
        if n == 0:
            stale.append((cid, prefix))
        elif declared is not None and n != declared:
            wrong_count.append((cid, prefix, declared, n))

    if stale:
        ok = False
        print('%s✗ 登记失效 %d 条%s —— 清单里登记了，但代码里没这个改动' %
              (C_WARN, len(stale), C_OFF))
        for cid, prefix in stale:
            print('    %s  %s' % (cid, prefix))
        print('  %s→ 上游可能已合并该能力，或改动被回退了，须人工确认后销项%s' % (C_DIM, C_OFF))
        print()

    if wrong_count:
        ok = False
        print('%s✗ 清单数字与代码不符 %d 条%s —— 手写的数字没跟着代码走' %
              (C_WARN, len(wrong_count), C_OFF))
        for cid, prefix, declared, n in wrong_count:
            print('    %-8s 清单写 %d，实际 %d   %s' % (cid, declared, n, prefix))
        print('  %s→ 数字是给人判断规模用的，写错会让人低估冲突面%s' % (C_DIM, C_OFF))
        print()

    if ok:
        print('%s✓ 通过：%d 个改动文件全部已登记，%d 条登记全部有效，声明数字全部相符%s'
              % (C_OK, len(rows), len(reg), C_OFF))
        return 0

    print('  基线: %s   实际改动: %d 个文件   登记: %d 条' % (base, len(rows), len(reg)))
    return 1


def sha256_of(rev: Optional[str], path: str) -> str:
    """rev 为 None 时读工作区文件；否则读该 revision 里的 blob。"""
    if rev is None:
        full = os.path.join(DSH, path)
        if not os.path.exists(full):
            return ''
        with open(full, 'rb') as f:
            return hashlib.sha256(f.read()).hexdigest()
    r = subprocess.run(['git', '-C', DSH, 'show', '%s:%s' % (rev, path)],
                       capture_output=True)
    return hashlib.sha256(r.stdout).hexdigest() if r.returncode == 0 else ''


def make_fingerprint() -> int:
    """
    记录 26 个改动文件的当前指纹，并为 5 个「修改上游文件」额外记上游基线指纹。

    为什么记上游基线指纹：将来评估升级时，只要比对「上游那时的新指纹」与
    「这里记的基线指纹」，就知道上游有没有动过我们改过的文件 ——
    **动了就说明我们那处补丁需要人工重做**，不必逐个文件去 diff。
    """
    base = baseline()
    head = git('rev-parse', 'HEAD').strip()
    rows = actual_changes(base)

    files = {}
    for status, path in rows:
        entry = {'status': status, 'sha256': sha256_of(None, path)}
        if status == 'M':
            entry['upstream_baseline_sha256'] = sha256_of(base, path)
        files[path] = entry

    doc = {
        'fork_head': head,
        'upstream_merge_base': base,
        'upstream_branch': 'master',
        'note': '由 工具/g2_改造点.py --manifest 生成，禁止手改。'
                'upstream_baseline_sha256 用于判断上游是否动过我们改过的文件。',
        'count': len(files),
        'files': files,
    }
    with open(FINGERPRINT, 'w', encoding='utf-8') as f:
        json.dump(doc, f, ensure_ascii=False, indent=2, sort_keys=True)
        f.write('\n')
    print('%s✓ 指纹已写入 %s（%d 个文件）%s' % (C_OK, FINGERPRINT, len(files), C_OFF))
    print('  fork HEAD : %s' % head)
    print('  上游基线  : %s' % base)
    return 0


def verify_fingerprint() -> int:
    if not os.path.exists(FINGERPRINT):
        print('%s✗ 指纹文件不存在，先跑 --manifest%s' % (C_BAD, C_OFF))
        return 1
    with open(FINGERPRINT, encoding='utf-8') as source:
        doc = json.load(source)

    head_now = git('rev-parse', 'HEAD').strip()
    bad = []

    if head_now != doc['fork_head']:
        bad.append(('fork HEAD 变了', doc['fork_head'], head_now))

    for path, entry in sorted(doc['files'].items()):
        if entry['status'] == 'D':
            if os.path.lexists(os.path.join(DSH, path)):
                bad.append((path, '路径已删除', '路径仍存在'))
            continue
        now = sha256_of(None, path)
        if not now:
            bad.append((path, entry['sha256'][:12], '文件不存在'))
        elif now != entry['sha256']:
            bad.append((path, entry['sha256'][:12], now[:12]))

    if bad:
        print('%s✗ 指纹不符 %d 处%s —— fork 内容已偏离登记' % (C_BAD, len(bad), C_OFF))
        for path, want, got in bad:
            print('    %-58s 登记 %s  实际 %s' % (path, want, got))
        print('  %s→ 若是有意改动，重新生成指纹并登记进改造点清单%s' % (C_DIM, C_OFF))
        return 1

    print('%s✓ 指纹相符：%d 个文件与登记一致（fork HEAD %s）%s'
          % (C_OK, len(doc['files']), doc['fork_head'][:8], C_OFF))
    return 0


def main() -> int:
    args = sys.argv[1:]
    if '--json' in args:
        base = baseline()
        reg = registered()
        rows = actual_changes(base)
        print(json.dumps({
            'baseline': base,
            'head': git('rev-parse', 'HEAD').strip(),
            'registered': {k: {'path': v[0], 'declared': v[1]} for k, v in reg.items()},
            'actual': [{'status': s, 'path': p} for s, p in rows],
            'unregistered': [p for st, p in rows if not any(match(p, pre) for pre, _ in reg.values())],
        }, ensure_ascii=False, indent=2))
        return 0
    if '--manifest' in args:
        return make_fingerprint()
    if '--verify-manifest' in args:
        return verify_fingerprint()
    if '--check' in args:
        return check()
    if '--help' in args or '-h' in args:
        print(__doc__)
        return 0
    return show()


if __name__ == '__main__':
    sys.exit(main())
