#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
试点账号的口令 —— **只从仓库外面读**。

## 为什么要单独抽这一份

试点账号（`owner` / `builder` / `staff-*`）的口令从前硬编码在三处脚本里，
另有两行写在 `docs/试点测试-问题清单.md` 的操作说明里。它那时是本机
`127.0.0.1` 上的一次性口令，看着无害 —— 但仓库要推到远端，而
**推进历史的东西撤不回来**，哪怕仓库是私有的。

所以口令只留一个来源，且那个来源不在仓库里：

| 顺序 | 来源 | 用途 |
|---|---|---|
| 1 | 环境变量 `KVVI_PILOT_PASSWORD` | CI、一次性调用 |
| 2 | `~/KVVI-Pilot/kvvi-pilot.secret` 的第一行 | 本机试点的常态 |

两处都没有时**报错退出**，不回落默认值 —— 回落会把「口令没配」伪装成
「口令就是那个默认值」，而那正是这一轮要清掉的东西。

用法：

    sys.path.insert(0, os.path.join(HERE, 'lib'))
    from pilot_secret import pilot_password
    PASSWORD = pilot_password()
"""

import os

#: 环境变量名。CI 与一次性调用用这个。
ENV_NAME = 'KVVI_PILOT_PASSWORD'
#: 本机试点口令文件（$HOME 展开）。它在仓库外面，所以不会被提交。
DEFAULT_FILE = '~/KVVI-Pilot/kvvi-pilot.secret'


class PilotPasswordMissing(RuntimeError):
    """两处来源都没有口令。**不回落默认值** —— 见模块头部。"""


def secret_path():
    """
    口令文件的绝对路径。
    @returns 展开 `~` 之后的路径
    """
    return os.path.expanduser(DEFAULT_FILE)


def pilot_password():
    """
    取试点口令。
    @returns 口令字符串（已去掉首尾空白）
    @raises PilotPasswordMissing 环境变量与口令文件都没有时
    """
    from_env = os.environ.get(ENV_NAME, '').strip()
    if from_env != '':
        return from_env

    path = secret_path()
    if os.path.isfile(path):
        # 只读第一行：文件里可以跟注释说明，不必是只有一个词的裸文件。
        with open(path, encoding='utf-8') as handle:
            first = handle.readline().strip()
        if first != '':
            return first

    raise PilotPasswordMissing(
        '取不到试点口令。二选一：\n'
        '  · 设环境变量 %s；或\n'
        '  · 把口令写进 %s（第一行）\n'
        '口令**不进仓库**：它一度硬编码在三个脚本里，推进远端历史就撤不回来了。'
        % (ENV_NAME, path))
