#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
由**数据模型样例**重建 `样例/view-schema/` 的两份上下文，并保持摘要链一致。

## 它修的是什么问题

`0D-1` 的闭环检查发现了一件此前没被发现的事：

> **视图样例绑定的模型，和数据模型样例产出的模型，不是同一个。**

| 文件 | `general_item` 的字段 | 摘要 |
|---|---|---|
| `样例/business-schema/通用事项.spec.json`（卡 1 的验收基准） | `item_no` / `title` / `detail` / `amount` / `due_date` / `item_status` | `898c0ae1…` |
| `样例/view-schema/context.json` 内嵌的那份 | `title` / `category` / `quantity` / `amount` / `due_date` / `notes` | `518077ba…` |

两边**各自都过校验**，但**互相不一致** —— 视图绑定的字段（`category`、
`quantity`、`notes`）在真正的模型里根本不存在。
这正是「五份产出逐份通过校验」与「五份产出构成一个系统」之间的差距，
而**逐份校验永远看不出这个差距**。

## 方向：以数据模型样例为准

理由：它的 `item_status` 与流程样例的状态机（draft / submitted / approved /
rejected）对得上；`item_no` 与序号策略资产 `general_item_no` 对得上。
视图侧那份是早期的手写副本，没有别的资产跟它对应。

## 生成的链条（顺序不能变）

    模型内容 ──c14n──▶ 模型摘要
                         ├─▶ BUSINESS_SCHEMA 资产的 ref.digest
                         ├─▶ snapshot.ref.digest / registered.checksum / registered.spec
                         └─▶ 每个 capability 的 inputSchema 里内嵌的 businessSchemaRef.const
                                    │
                                    ▼
                              capability 内容变 → 各自摘要变 → 注册表 members 变
                                    │
                                    ▼
                              注册表内容变 → 注册表摘要变 → view.capability_registry_ref.digest

手写这条链必然在某一环算错，而校验只报「摘要不符」，**不告诉你是哪一环**。

用法：

    python3 工具/视图样例上下文.py            # 生成两份上下文
    python3 工具/视图样例上下文.py --check    # 校验落盘是否与生成结果一致
"""

import copy
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

MODEL = os.path.join(ROOT, '样例', 'business-schema', '通用事项.spec.json')
BASE_CONTEXT = os.path.join(ROOT, '样例', 'view-schema', 'context.json')
OUTPUTS = {
    'plain': BASE_CONTEXT,
    'dashboard': os.path.join(ROOT, '样例', 'view-schema', 'context-看板.json'),
}

C14N = os.path.join(
    ROOT, 'protocol', 'kvvi-json-c14n', 'v1', 'evidence-sets',
    'prd-v1.11', 'node', 'kvvi-json-c14n.mjs',
)

SCOPES = ['SELF', 'STORE', 'DEPARTMENT', 'DEPARTMENT_AND_CHILDREN', 'COMPANY']


def c14n_digest(content) -> str:
    run = subprocess.run(
        ['node', C14N, '--profile', 'kvvi-json-c14n/v1'],
        input=json.dumps(content), capture_output=True, text=True, timeout=60,
    )
    if run.returncode != 0:
        raise SystemExit('规范化失败：%s' % run.stderr)
    return json.loads(run.stdout)['digest']


def model_ref(model: dict, digest: str) -> dict:
    """视图侧引用模型时用的 AssetRef —— 与 `样例/view-schema/*.spec.json` 一致。"""
    return {
        'scope_type': 'TENANT',
        'scope_id': '11111111-1111-4111-8111-111111111111',
        'app_id': '22222222-2222-4222-8222-222222222222',
        'module_id': '33333333-3333-4333-8333-333333333333',
        'asset_type': 'BUSINESS_SCHEMA',
        'asset_id': model['schema_code'],
        'version': 1,
        'digest': digest,
    }


def replace_model_refs(node, ref: dict):
    """递归替换内容里任何内嵌的 `businessSchemaRef` 常量。"""
    if isinstance(node, dict):
        if node.get('asset_type') == 'BUSINESS_SCHEMA' and 'digest' in node:
            node.clear()
            node.update(copy.deepcopy(ref))
            return
        for value in node.values():
            replace_model_refs(value, ref)
    elif isinstance(node, list):
        for value in node:
            replace_model_refs(value, ref)


def caliber(code, item_key, fields, rate_limit, ref):
    """一条聚合口径 capability 的完整内容。"""
    return {
        'fixture': True,
        'capability_code': code,
        'version': 1,
        'state': 'PUBLISHED',
        'category': 'QUERY',
        'inputSchema': {
            'type': 'object',
            'properties': {
                'businessSchemaRef': {'const': copy.deepcopy(ref)},
                # `dataScope` 必填：§9.8.1 的判定需要「查询实际注入的档位」，
                # 而它在配置里唯一可能出现的位置就是这里。
                'dataScope': {'type': 'array', 'items': {'enum': SCOPES},
                              'minItems': 1, 'uniqueItems': True},
            },
            'required': ['businessSchemaRef', 'dataScope'],
            'additionalProperties': False,
        },
        'outputSchema': {
            'type': 'object',
            'properties': {'items': {
                'type': 'array',
                'items': {
                    'type': 'object',
                    'properties': dict({item_key: {'type': 'string'}}, **fields),
                    'required': [item_key] + sorted(fields),
                    'additionalProperties': False,
                },
                'maxItems': 200,
            }},
            'required': ['items'],
            'additionalProperties': False,
        },
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
        'itemKeys': [item_key],
        'recovery': 'return-fixed-error',
        'auditEvents': ['fake.validation'],
    }


CALIBERS = [
    ('caliber.monthly_sales', 'month', {'amount': {'type': 'number'}}, 4),
    ('caliber.dept_completion', 'dept',
     {'completed': {'type': 'integer'}, 'total': {'type': 'integer'},
      'rate': {'type': 'number'}}, 4),
]


def build(kind: str) -> dict:
    model = json.load(open(MODEL, encoding='utf-8'))
    digest = c14n_digest(model)
    ref = model_ref(model, digest)
    context = json.load(open(BASE_CONTEXT, encoding='utf-8'))

    registry = None
    for asset in context['fake_assets']:
        if asset['ref'].get('asset_type') == 'FIELD_TYPE_REGISTRY':
            # ⚠️ 同一份资产曾有两个名字：业务侧上下文与模型写的是
            # `fake-business-types`，视图侧写的是 `business-field-types-core`，
            # 摘要相同、asset_id 不同 —— 引用校验按 asset_id 找，于是找不到。
            # 以业务侧为准（模型 + 两份业务上下文都这么写）。
            asset['ref']['asset_id'] = 'fake-business-types'
        if asset['ref'].get('asset_type') == 'BUSINESS_SCHEMA':
            asset['content'] = model
            asset['ref']['digest'] = digest
        if asset['ref'].get('asset_type') == 'CAPABILITY':
            replace_model_refs(asset['content'], ref)
        if asset['ref'].get('asset_type') == 'CAPABILITY_REGISTRY':
            registry = asset

    # 模型变了 → 每个 capability 的内容变了 → 它们的摘要全部要重算，
    # 然后注册表 members 跟着变，注册表自己的摘要再跟着变。
    members = []
    for asset in context['fake_assets']:
        r = asset['ref']
        if r.get('asset_type') != 'CAPABILITY':
            continue
        r['digest'] = c14n_digest(asset['content'])
        members.append(copy.deepcopy(r))

    if kind == 'dashboard':
        for code, item_key, fields, rate in CALIBERS:
            content = caliber(code, item_key, fields, rate, ref)
            r = {'scope_type': 'PLATFORM_CONTROL', 'scope_id': 'kvvi-platform',
                 'app_id': None, 'module_id': None, 'asset_type': 'CAPABILITY',
                 'capability_code': code, 'version': 1,
                 'digest': c14n_digest(content)}
            context['fake_assets'].append({'ref': r, 'content': content})
            members.append(copy.deepcopy(r))

    registry['content']['members'] = members
    registry['ref']['digest'] = c14n_digest(registry['content'])
    context['view']['capability_registry_ref']['digest'] = registry['ref']['digest']

    # 已登记版本与快照
    for snap in context.get('snapshots', []):
        if snap['ref'].get('asset_type') != 'BUSINESS_SCHEMA':
            continue
        snap['ref']['digest'] = digest
        snap['registered']['spec'] = model
        snap['registered']['checksum'] = digest

    if kind == 'dashboard':
        context['current']['asset_id'] = 'monthly_sales_dashboard'
    return context


def main() -> int:
    outputs = {kind: json.dumps(build(kind), ensure_ascii=False, indent=2) + '\n'
               for kind in OUTPUTS}

    if '--check' in sys.argv:
        problems = []
        for kind, path in OUTPUTS.items():
            if not os.path.isfile(path):
                problems.append('缺少 %s' % os.path.relpath(path, ROOT))
            elif open(path, encoding='utf-8').read() != outputs[kind]:
                problems.append('%s 与生成结果不一致（有人手改过）' % os.path.relpath(path, ROOT))
        if problems:
            for p in problems:
                print('✗ %s' % p)
            return 1
        print('✓ 两份上下文均与生成结果一致')
        return 0

    for kind, path in OUTPUTS.items():
        with open(path, 'w', encoding='utf-8') as fh:
            fh.write(outputs[kind])
        print('✓ 已写入 %s' % os.path.relpath(path, ROOT))
    return 0


if __name__ == '__main__':
    sys.exit(main())
