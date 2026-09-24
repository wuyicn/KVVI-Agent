#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
样例层共用的**角色目录**（role directory）。

## 为什么需要单独一个文件

`workflow-spec` 里每一处 `role_ref` 都写着
`permission_ref.asset_id == 'role_directory'` 与一个 `subresource.code`。
契约把「这个 code 是否指向真实存在的角色」列为 complete check 的职责 ——
**可样例层从来没有人写过那份目录**，于是校验器只能报 UNKNOWN。

而「UNKNOWN」看着像「没事」，实际是「没查」。本文件把目录补上，
让 `工具/check_workflow_semantics.py` 的 #1 能真的判定。

## 收录范围 —— 只说事实

这里收录的是**本仓库样例中实际用到的**角色 code：

| code | 出现处 |
|---|---|
| `manager` | `工具/蓝图样例.py`（FLOW 策略的动作角色） |
| `supervisor` | `工具/黄金样例.py`（10 组标准需求的审批角色） |
| `hq_manager` | `工具/行业包样例.py`（家具报货：总部确认） |

⚠️ **这不是产品的角色表**。产品的角色目录由 permission-spec 在运行期给出，
本文件只是把**样例自己引用的那几个**写下来，好让检查器不至于永远无法判定。
把样例当成产品事实来引用，是这一类文件最容易犯的错。
"""

ROLE_DIRECTORY_ASSET_ID = 'role_directory'

# (asset_id, role_code) -> 名称
ROLES = {
    ('role_directory', 'manager'): '经理',
    ('role_directory', 'supervisor'): '主管',
    ('role_directory', 'hq_manager'): '总部经理',
}


def as_dicts():
    """给检查器用的扁平表：(asset_id, code) -> True。"""
    return {k: True for k in ROLES}


def declared_codes():
    return sorted({code for (_aid, code) in ROLES})


def role(code, name=None, asset_id=ROLE_DIRECTORY_ASSET_ID):
    """按契约的 `Role` 形态给出一条角色定义（`role_code` + `name`）。"""
    return {'role_code': code, 'name': name or ROLES.get((asset_id, code), code)}
