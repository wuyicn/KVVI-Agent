#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
关停判据检查器 —— 「`stop` 之后进程真的没了」这件事的机器判据。

## 为什么需要它

问题 24：试点上留下**两个活了两个半小时的孤儿平台进程**，各自还被一个浏览器
连着。`kvvi-admin stop` 早就报了成功。

三件事单独看都对，合起来却不保证进程没了：

    kvvi-admin stop      →  发 SIGTERM、删 pid 文件、报成功
    平台 SIGTERM handler →  server.close(() => process.exit(0))
    Node 的 server.close →  停止接受新连接、**放掉监听套接字**，
                            回调挂在「所有既有连接关闭」之后

浏览器长期持有 keep-alive 与流式连接，那个回调**永远不触发**。于是：

  · 监听套接字已释放 —— 新进程能绑上同一个端口，**看起来重启成功了**；
  · 旧进程一直活着 —— 它服务的是**撤权前就开着的那一页**，
    而它内存里的授权版本是撤权之前的那一份（PRD §9.4.4 要求撤销立即生效）；
  · `status` 读 pid 文件，而 pid 文件已被新进程覆盖 —— 旧进程**查不到**。

## 这个检查器验什么

四组判据，都是**源码文本层面**的：

| # | 判据 | 不成立会怎样 |
|---|---|---|
| A | 平台关停路径有**硬期限**（`closeAllConnections` + 定时器 `unref` + 回调里 `exit`） | 回到「放掉监听然后永远活着」 |
| B | `stop` 会**验证**进程退出，并在 SIGTERM 无效时升级 SIGKILL | 报成功而进程还在 |
| C | 「已退出」的判定认得出**僵尸**（`waitpid` + `WNOHANG`） | 已死的进程被判成「还在」，白等一轮再报一条假的「杀不掉」 |
| D | 存在**负向用例**：起一个真的忽略 SIGTERM 的进程，要求它被杀掉 | 这条判据只活在注释里 |

## 它验不到什么（如实说）

文本层面的检查**不能证明行为**：A 的三段都在，也可能摆在一条走不到的
分支里。行为由 `distribution/tests/test_supervisor.py` 的
`StopReallyEndsTheProcessTest`（D 组点名的那一个）负责 ——
**这一层只负责让「有人把硬期限删了」这件事不会静默发生。**
"""

import os
import sys
from typing import List, Tuple

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

C_OK = '\033[32m'
C_BAD = '\033[31m'
C_DIM = '\033[90m'
C_OFF = '\033[0m'

SERVER = os.path.join(ROOT, 'services', 'platform', 'src', 'server.mjs')
SUPERVISOR = os.path.join(ROOT, 'distribution', 'lib', 'supervisor.py')
SUPERVISOR_TEST = os.path.join(ROOT, 'distribution', 'tests', 'test_supervisor.py')

#: `(组号, 组名, 文件, 必需片段, 缺了会怎样)`
#:
#: 片段是**精确文本**而不是正则：这里要的正是「那一段还在不在」，
#: 用正则反而会把「写了但写错」放过。
MARKERS: List[Tuple[str, str, str, str, str]] = [
    ('A', '平台关停有硬期限', SERVER,
     'server.closeIdleConnections()',
     '空闲连接不再被放掉，纯粹靠等 —— 而等不到'),
    ('A', '平台关停有硬期限', SERVER,
     'server.closeAllConnections()',
     '没有强制关闭，卡住的连接会让进程永远不退出'),
    ('A', '平台关停有硬期限', SERVER,
     'hardStop.unref()',
     '定时器自己成了「进程活着」的理由 —— 一个关停用的定时器把进程钉住'),
    ('A', '平台关停有硬期限', SERVER,
     'SHUTDOWN_GRACE_MS',
     '硬期限被删了 —— 关停又变成「等所有连接自然关闭」'),

    ('B', 'stop 验证进程真的退出', SUPERVISOR,
     'os.kill(pid, 9)',
     'SIGTERM 无效时没有升级 —— 报成功而进程还在'),
    ('B', 'stop 验证进程真的退出', SUPERVISOR,
     '_await_exit(',
     '发完信号不等 —— 那正是问题 24 的原样'),
    ('B', 'stop 验证进程真的退出', SUPERVISOR,
     'SIGTERM 未生效，已用 SIGKILL 结束',
     '升级得静默，等于没发生 —— 平台的关停路径有 bug 而没人知道'),

    ('C', '「已退出」认得出僵尸', SUPERVISOR,
     'os.waitpid(pid, os.WNOHANG)',
     '一个已经退出、等着回收的子进程会被判成「还在」'),
    ('C', '「已退出」认得出僵尸', SUPERVISOR,
     'ChildProcessError',
     '没有「不是我的子进程」这条正常路径 —— 线上 `stop` 与拉起是两个进程'),

    ('D', '负向用例存在', SUPERVISOR_TEST,
     'signal.SIG_IGN',
     '没有那个忽略 SIGTERM 的进程，升级路径就没被验过'),
    ('D', '负向用例存在', SUPERVISOR_TEST,
     "'SIGKILL'",
     '升级发生了却没有断言 —— 用例可以一直绿而升级早已不再发生'),
]


def read(path: str) -> str:
    """
    读文件。
    @param path 路径
    @returns 内容；文件不存在返回空串
    """
    try:
        with open(path, encoding='utf-8') as handle:
            return handle.read()
    except OSError:
        return ''


def check() -> List[dict]:
    """
    逐条判据。
    @returns `[{group, name, file, marker, why, ok}]`
    """
    cache = {}
    rows = []
    for group, name, path, marker, why in MARKERS:
        if path not in cache:
            cache[path] = read(path)
        rows.append({'group': group, 'name': name, 'file': os.path.relpath(path, ROOT),
                     'marker': marker, 'why': why, 'ok': marker in cache[path]})
    return rows


def show(rows: List[dict]) -> int:
    """
    打印结果。
    @param rows 判据
    @returns 退出码
    """
    bad = [r for r in rows if not r['ok']]
    groups = []
    for row in rows:
        if not groups or groups[-1][0] != row['group']:
            groups.append((row['group'], row['name'], []))
        groups[-1][2].append(row)

    print('%s=== 关停判据 ===%s' % (C_OK, C_OFF))
    print('  %s两份文件 + 一份负向用例；判据 %d 条%s' % (C_DIM, len(rows), C_OFF))
    print()
    for group, name, members in groups:
        ok = all(m['ok'] for m in members)
        tag = '%s✓%s' % (C_OK, C_OFF) if ok else '%s✗%s' % (C_BAD, C_OFF)
        print('  %s %s %s(%s)%s' % (tag, name, C_DIM, group, C_OFF))
        print('      %s%s%s' % (C_DIM, members[0]['file'], C_OFF))
        for member in members:
            if not member['ok']:
                print('      %s✗ 缺 `%s`%s' % (C_BAD, member['marker'], C_OFF))
                print('        %s→ %s%s' % (C_DIM, member['why'], C_OFF))
    print()
    if bad:
        print('%s✗ %d/%d 条不符 —— 「stop 之后进程真的没了」这件事不再有机器判据%s'
              % (C_BAD, len(bad), len(rows), C_OFF))
        return 1
    print('%s✓ 通过：%d 条判据全部成立%s' % (C_OK, len(rows), C_OFF))
    return 0


def main() -> int:
    """
    入口。
    @returns 退出码
    """
    if '--quiet' in sys.argv:
        return 1 if [r for r in check() if not r['ok']] else 0
    return show(check())


if __name__ == '__main__':
    sys.exit(main())
