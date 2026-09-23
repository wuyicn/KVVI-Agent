#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成 `样例/view-schema/context-看板.json` —— 卡 4 的验收上下文。

## 为什么要单独生成，而不是手写

参照的上下文（`context.json`）是**手写**的，而它的每一项 `ref.digest` 都是
内容经 `kvvi-json-c14n/v1` 规范化后的摘要。手写摘要链条意味着
「改一个字 → 摘要失效 → 校验报 digest mismatch」，且**没有任何东西告诉你
是哪个字段算错了**。

所以本脚本按正确的顺序重算：

    口径内容 ──c14n──▶ 口径 digest ──▶ 写进注册表 members
                                            │
                                            ▼
                                    注册表内容 ──c14n──▶ 注册表 digest
                                                              │
                                                              ▼
                                              view.capability_registry_ref.digest

## 与 `context.json` 的差别

只加了两条**聚合口径 capability**（`category: QUERY`），其余资产逐字不动：

| 新增 | 含义 | `itemKeys` |
|---|---|---|
| `caliber.monthly_sales` | 月度销售额（按完成时间、排除已撤销） | `["month"]` |
| `caliber.dept_completion` | 部门完成率 | `["dept"]` |

**为什么必须新增**：`context.json` 里只有 `records.list` / `records.get` /
`options.list` 三个 QUERY 能力，**没有一个是聚合口径**。不新增就只能拿「记录列表」
冒充口径，那样验出来的是「引用机制通」，不是「口径通」。

用法：

    python3 工具/看板样例上下文.py            # 生成
    python3 工具/看板样例上下文.py --check    # 只校验现有文件是否与生成结果一致
"""

import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, '样例', 'view-schema', 'context.json')
DST = os.path.join(ROOT, '样例', 'view-schema', 'context-看板.json')
C14N = os.path.join(
    ROOT, 'protocol', 'kvvi-json-c14n', 'v1', 'evidence-sets',
    'prd-v1.11', 'node', 'kvvi-json-c14n.mjs',
)

BUSINESS_SCHEMA_REF = {
    'scope_type': 'TENANT',
    'scope_id': '11111111-1111-4111-8111-111111111111',
    'app_id': '22222222-2222-4222-8222-222222222222',
    'module_id': '33333333-3333-4333-8333-333333333333',
    'asset_type': 'BUSINESS_SCHEMA',
    'asset_id': 'general_item',
    'version': 1,
    'digest': 'sha256:518077baee491b8146bc740bfa84d23bb2ef7f4bc81929eadefb7fd1691c9433',
}

SCOPES = ['SELF', 'STORE', 'DEPARTMENT', 'DEPARTMENT_AND_CHILDREN', 'COMPANY']

# 口径的 inputSchema 把 `dataScope` 设为**必填**。
# 这不是为了好看：§9.8.1 的判定需要「查询实际注入的档位」这个量，
# 而它在配置里唯一可能出现的位置就是这里。不设必填，注入档位就无处声明，
# 发布前的不变量检查也就无从判定（见 工具/check_invariant.py 的 `--input`）。
CALIBER_INPUT_SCHEMA = {
    'type': 'object',
    'properties': {
        'businessSchemaRef': {'const': BUSINESS_SCHEMA_REF},
        'dataScope': {
            'type': 'array',
            'items': {'enum': SCOPES},
            'minItems': 1,
            'uniqueItems': True,
        },
    },
    'required': ['businessSchemaRef', 'dataScope'],
    'additionalProperties': False,
}


def caliber(code, item_keys, output_schema, rate_limit):
    """一条聚合口径 capability 的完整内容。"""
    return {
        'fixture': True,
        'capability_code': code,
        'version': 1,
        'state': 'PUBLISHED',
        'category': 'QUERY',
        'inputSchema': CALIBER_INPUT_SCHEMA,
        'outputSchema': output_schema,
        'errorSchema': {
            'type': 'object',
            'properties': {'code': {'enum': ['FAKE_REJECTED']},
                           'retryable': {'const': False}},
            'required': ['code', 'retryable'],
            'additionalProperties': False,
        },
        'authorization': ['FAKE_ONLY'],
        'scope': 'current_business',
        'sideEffects': False,
        'idempotency': 'fixture-no-write',
        'retry': 'never',
        'runtimeDigest': 'sha256:' + '0' * 64,
        'timeoutMs': 2000,
        'rateLimit': rate_limit,
        'maxResults': 200,
        'itemKeys': item_keys,
        'recovery': 'return-fixed-error',
        'auditEvents': ['fake.validation'],
    }


def series(item_key, fields):
    """把一组标量字段摊成 outputSchema 的 items 结构。"""
    return {
        'type': 'object',
        'properties': {
            'items': {
                'type': 'array',
                'items': {
                    'type': 'object',
                    'properties': dict({item_key: {'type': 'string'}}, **fields),
                    'required': [item_key] + sorted(fields),
                    'additionalProperties': False,
                },
                'maxItems': 200,
            }
        },
        'required': ['items'],
        'additionalProperties': False,
    }


CALIBERS = [
    (caliber('caliber.monthly_sales', ['month'],
             series('month', {'amount': {'type': 'number'}}), 4), 'month'),
    (caliber('caliber.dept_completion', ['dept'],
             series('dept', {'completed': {'type': 'integer'},
                             'total': {'type': 'integer'},
                             'rate': {'type': 'number'}}), 4), 'dept'),
]


def digest(content):
    """内容经 kvvi-json-c14n/v1 规范化后的摘要 —— 与验证器用的是同一个工具。"""
    run = subprocess.run(
        ['node', C14N, '--profile', 'kvvi-json-c14n/v1'],
        input=json.dumps(content), capture_output=True, text=True,
    )
    if run.returncode != 0:
        raise SystemExit('规范化失败：%s' % run.stderr)
    return json.loads(run.stdout)['digest']


def capability_ref(code, content_digest):
    return {
        'scope_type': 'PLATFORM_CONTROL',
        'scope_id': 'kvvi-platform',
        'app_id': None,
        'module_id': None,
        'asset_type': 'CAPABILITY',
        'capability_code': code,
        'version': 1,
        'digest': content_digest,
    }


def build():
    with open(SRC, encoding='utf-8') as fh:
        context = json.load(fh)

    registry = None
    for asset in context['fake_assets']:
        if asset['ref'].get('asset_type') == 'CAPABILITY_REGISTRY':
            registry = asset
    if registry is None:
        raise SystemExit('源上下文里没有 CAPABILITY_REGISTRY')

    additions = []
    for content, _item_key in CALIBERS:
        ref = capability_ref(content['capability_code'], digest(content))
        additions.append({'ref': ref, 'content': content})
        registry['content']['members'].append(ref)

    # 注册表内容变了，它自己的摘要必须跟着变；否则 view.capability_registry_ref
    # 的 digest 会对不上 —— 这正是「改一处、不传播」在本样例里的样子。
    registry['ref']['digest'] = digest(registry['content'])
    context['view']['capability_registry_ref']['digest'] = registry['ref']['digest']

    context['fake_assets'].extend(additions)
    context['current']['asset_id'] = 'monthly_sales_dashboard'

    return context


def main() -> int:
    context = build()
    text = json.dumps(context, ensure_ascii=False, indent=2) + '\n'

    if '--check' in sys.argv:
        if not os.path.exists(DST):
            print('✗ %s 不存在，先跑一次不带 --check 的' % DST)
            return 1
        with open(DST, encoding='utf-8') as fh:
            current = fh.read()
        if current == text:
            print('✓ %s 与生成结果一致' % os.path.relpath(DST, ROOT))
            return 0
        print('✗ %s 与生成结果不一致 —— 有人手改了样例上下文' % os.path.relpath(DST, ROOT))
        return 1

    with open(DST, 'w', encoding='utf-8') as fh:
        fh.write(text)
    print('✓ 已写入 %s（%d 个资产，其中口径 %d 条）'
          % (os.path.relpath(DST, ROOT), len(context['fake_assets']),
             len(CALIBERS)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
