#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""三员工权限矩阵 —— 「员工按权限使用已发布的系统」这条的逐格实测。

## 为什么要有这一格

阶段十验的是「同一账号、同一动作、同一数据范围下 UI 与 Agent 一致」，
验的是**判据**；这里验的是**三档人在真实系统上真的拿到不同的结果**。
前者可以全绿而后者一格不成立（例如某档根本没配角色，于是它和「无权限」
在界面上长得一模一样）。

## 矩阵

| 角色 | 契约怎么写的 | 应得 |
|---|---|---|
| `sales_viewer`（staff-view） | FORM=[read] + DATA=[COMPANY] + FIELD=READ_ONLY，**没有 FLOW** | 读得到全部、一格都写不了 |
| `sales`（staff-edit） | FORM=[read,create,update] + DATA=[SELF] | 读得到自己的、能建能改 |
| 无角色（staff-none） | 契约里没有它 | 全拒 |

矩阵是三格：**读 / 建 / 改**。流程不在这里 —— 它不是这三档的差别
（三档拿到的可执行动作都是空的），是一条独立的缺陷（见问题 28），跑完单独报。

用法：
    python3 工具/验收-员工权限矩阵.py            # 跑一遍并打印矩阵
    python3 工具/验收-员工权限矩阵.py --json     # 输出 JSON
"""

import argparse
import importlib.util
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

#: 契约里的角色 → 试点的账号。**角色在契约里，账号在企业管理里** —— 两者靠
#: `role_members` 连起来，而这一层最容易出现「契约写好了、没人被分到这个角色」。
ACCOUNTS = {
    'staff-view':  {'role': 'sales_viewer', 'expect_read': True,
                    'expect_create': False, 'expect_update': False},
    'staff-edit':  {'role': 'sales',        'expect_read': True,
                    'expect_create': True,  'expect_update': True},
    'staff-none':  {'role': None,           'expect_read': False,
                    'expect_create': False, 'expect_update': False},
}

PASSWORD = '<试点口令>'
ASSET = 'customer'


def scaffold():
    """复用发布脚手架的会话实现 —— 登录与 Cookie 的处理只该有一份。"""
    spec = importlib.util.spec_from_file_location(
        'kvvi_scaffold', os.path.join(HERE, '发布脚手架.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def one(login, platform, witness=None):
    """
    跑一个账号的三格。
    @param login 账号
    @param platform 平台地址
    @param witness 别的账号读到的一条记录 `{recordId, rowVersion}` ——
        **无权限那一档必须用得上它**：那个人既读不到记录、也读不到 `rowVersion`，
        于是「改」这一格会以「拿不到 rowVersion」草草通过，而它本该证明的是
        **一次真的 PATCH 被拒**。拿别人的记录与版本号去试，才是那件事。
    @returns `{read, create, update, flow}`
    """
    mod = scaffold()
    session = mod.Session(platform, login, PASSWORD).sign_in()
    cells = {}

    status, body = session.call('GET', '/api/v1/systems/%s/records' % ASSET)
    items = (body.get('items') or []) if isinstance(body, dict) else []
    cells['read'] = {'status': status, 'n': len(items),
                     'error': (body or {}).get('error') if isinstance(body, dict) else None}

    status, body = session.call('POST', '/api/v1/systems/%s/records' % ASSET,
                                {'data': {'customer_name': '权限矩阵-由 %s 建' % login}})
    cells['create'] = {'status': status,
                       'error': (body or {}).get('error') if isinstance(body, dict) else None}
    made = None
    if isinstance(body, dict):
        made = body.get('recordId') or body.get('id')

    # 改的目标：能建就用自己刚建的，不能建就用读到的第一条，再不行借别人的。
    target = made or (items[0].get('recordId') if items else None)
    if target is None and witness:
        target = witness.get('recordId')
    if target is None:
        cells['update'] = {'status': None, 'error': '没有可改的记录（读不到也建不出）'}
        cells['flow'] = {'status': None, 'state': None, 'actions': None}
        return cells

    # ⚠️ `rowVersion` **必填**（乐观并发）。普通 PATCH 不带它就是 400 ——
    #    而 400 看起来像「被拒了」，于是这一格会被误判成「权限生效」。
    #    第一版就是这么错的：三档的「改」全是 400，其中两档其实是**用例自己**错了。
    status, body = session.call('GET', '/api/v1/systems/%s/records/%s' % (ASSET, target))
    row_version = (body or {}).get('rowVersion') if isinstance(body, dict) else None
    state = (body or {}).get('state') if isinstance(body, dict) else None
    if row_version is None and witness:
        # 读不到就借：**这一格要证的是「写被拒」，不是「读不到版本号」**。
        row_version = witness.get('rowVersion')
    if row_version is None:
        cells['update'] = {'status': None, 'error': '读不到 rowVersion'}
    else:
        status, body = session.call('PATCH', '/api/v1/systems/%s/records/%s' % (ASSET, target),
                                    {'rowVersion': row_version,
                                     'data': {'customer_name': '权限矩阵-由 %s 改' % login}})
        cells['update'] = {'status': status,
                           'error': (body or {}).get('error') if isinstance(body, dict) else None,
                           'fields': (body or {}).get('fields') if isinstance(body, dict) else None}

    status, body = session.call('GET', '/api/v1/systems/%s/records/%s/actions' % (ASSET, target))
    cells['flow'] = {'status': status, 'state': state,
                     'actions': (body or {}).get('actions') if isinstance(body, dict) else None}
    return cells


def verdict(cells, expect):
    """
    三格逐格判。
    @param cells 实测
    @param expect 该角色的期望
    @returns `[(格, 实测码, 期望, 是否成立)]`
    """
    return [
        ('读', cells['read']['status'],
         '期望 200' if expect['expect_read'] else '期望 403',
         (cells['read']['status'] == 200) == expect['expect_read']),
        ('建', cells['create']['status'],
         '期望 201' if expect['expect_create'] else '期望 403',
         (cells['create']['status'] == 201) == expect['expect_create']),
        ('改', cells['update']['status'],
         '期望 200' if expect['expect_update'] else '期望 403',
         (cells['update']['status'] == 200) == expect['expect_update']),
    ]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--platform', default='http://127.0.0.1:7500')
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args()

    report = {'platform': args.platform, 'asset': ASSET, 'accounts': {}}
    bad = 0
    witness = None
    for login, expect in ACCOUNTS.items():
        cells = one(login, args.platform, witness)
        # 谁读得到，谁就提供一条真记录给后面读不到的人去试写。
        if witness is None and cells['read']['n']:
            status, body = scaffold().Session(args.platform, login, PASSWORD).sign_in().call(
                'GET', '/api/v1/systems/%s/records' % ASSET)
            items = (body.get('items') or []) if isinstance(body, dict) else []
            if items:
                first = items[0]
                witness = {'recordId': first.get('recordId'), 'rowVersion': first.get('rowVersion')}
                report['witness'] = dict(witness, **{'from': login})
        rows = verdict(cells, expect)
        report['accounts'][login] = {
            'role': expect['role'], 'cells': cells,
            'rows': [{'cell': r[0], 'status': r[1], 'expect': r[2], 'ok': r[3]} for r in rows],
        }
        bad += sum(1 for r in rows if not r[3])

    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 1 if bad else 0

    print('=== 三员工权限矩阵 ===')
    print('  系统 %s   平台 %s' % (ASSET, args.platform))
    for login, data in report['accounts'].items():
        print()
        print('  %s（角色 %s）' % (login, data['role'] or '无'))
        for row in data['rows']:
            mark = '✓' if row['ok'] else '✗'
            print('    %s %-4s HTTP %-5s  %s' % (mark, row['cell'], row['status'], row['expect']))

    print()
    print('  ── 流程（单独报，不计入矩阵）──')
    for login, data in report['accounts'].items():
        flow = data['cells']['flow']
        print('    %-12s 记录状态 %-14s 可执行动作 %s'
              % (login, flow.get('state'), flow.get('actions')))
    print()
    if bad:
        print('✗ %d 格不符' % bad)
        return 1
    print('✓ 全部 %d 格成立' % (len(ACCOUNTS) * 3))
    return 0


if __name__ == '__main__':
    sys.exit(main())
