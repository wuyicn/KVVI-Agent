#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
行业扩展包样例：家具「报货申请」（PRD §5.7.3、任务 `0C-6`）。

## 这一份为什么**允许**出现行业词

`0A-14` 去行业化自查要求地基里没有家具词。而 `0C-6` 要求一个**家具样例**。
两者不矛盾，因为它们说的不是一层东西（§5.7.3）：

| 层 | 允许行业词 | 判据 |
|---|---|---|
| **地基**（契约、工具、五个 Skill、预设） | ❌ | `工具/check_industry_neutral.py` |
| **行业扩展包**（追加 `skills/` 目录 + 组件包） | ✅ | **地基未被改动** |

所以本包放在 `样例/行业包/` 下，并**被显式豁免**（豁免理由写在检查器里）。
「地基未改动」不是一句声明 —— `地基未改动.json` 记录了加包**之前**各交付组件的
内容指纹，由 `工具/check_industry_pack.py` 复核。

## 生成的链条

模型内容 → 模型摘要 → 上下文里各资产的摘要 → 注册表摘要。
与 `工具/视图样例上下文.py` 同一套纪律：摘要链只能重算，不能手写。

用法：

    python3 工具/行业包样例.py            # 生成
    python3 工具/行业包样例.py --check    # 校验落盘是否与生成结果一致
"""

import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(HERE, 'lib'))

import 蓝图 as bp  # noqa: E402

PACK = os.path.join(ROOT, '样例', '行业包', '家具报货申请')
BASE_CONTEXT = os.path.join(ROOT, '样例', 'view-schema', 'context.json')

REQUIREMENT = """# 家具「报货申请」· 需求

> **这是行业扩展包，不是地基。** 里面出现「报货」「门店」「送货」是对的 ——
> 地基（契约、工具、五个 Skill）里出现它们才是问题（PRD §5.7.3、`0A-14`）。

门店店长每周要向总部报货。现在靠微信群发消息、总部手工汇总，
谁报的、报了多少、批没批，全靠人记。

要一个系统：

1. **报货**：店长填「报货申请单」——**门店**、**收货日期**、**报货数量**、
   **备注**；一条申请可以有**多个品项**（明细行）。
2. **审批**：总部确认。流程是 草稿 → 待审批 → 已通过 / 已驳回，驳回后可改后重提。
3. **不做的**：库存、物流、结算 —— 那些是别的系统的事。

## 待确认的问题

- 单次报货有没有金额上限？现在没有。
- 已通过的申请能不能追加品项？现在不能。
"""

# ── 模型：报货单 ────────────────────────────────────────────────────────
FIELDS = [
    ('request_no', 'short_text', '报货单号', True, {'write_policy': 'CREATE_ONLY'}),
    ('store_code', 'short_text', '门店', True, {}),
    ('delivery_date', 'date', '期望到货日期', True, {}),
    ('quantity', 'integer', '报货数量', True, {}),
    ('amount', 'money', '预估金额', False,
     {'type_config': {'currency_mode': 'FIXED', 'currency': 'CNY'}}),
    ('notes', 'long_text', '备注', False, {}),
    ('request_status', 'single_select', '状态', True,
     {'type_config': {'options': [
         {'code': 'draft', 'label': '草稿', 'order': 0, 'enabled': True},
         {'code': 'submitted', 'label': '待总部确认', 'order': 1, 'enabled': True},
         {'code': 'approved', 'label': '已通过', 'order': 2, 'enabled': True},
         {'code': 'rejected', 'label': '已驳回', 'order': 3, 'enabled': True},
     ]}}),
]

VIEW_TYPE_OF = {'short_text': 'ShortTextField', 'long_text': 'LongTextField',
                'integer': 'IntegerField', 'money': 'MoneyField',
                'date': 'DateField', 'single_select': 'SingleSelectField'}


def model_spec(ftr_ref):
    return {
        'schema_code': 'replenishment_request',
        'name': '家具报货申请单',
        'description': '行业扩展包样例：门店向总部报货',
        'field_type_registry_ref': ftr_ref,
        'fields': [
            dict({'field_code': code, 'label': label, 'type': ftype,
                  'required': required, 'nullable': not required,
                  'write_policy': extra.get('write_policy', 'MUTABLE'),
                  'query': {'searchable': ftype in ('short_text', 'long_text'),
                            'filterable': True, 'sortable': ftype not in ('long_text',)}},
                 **{k: v for k, v in extra.items() if k != 'write_policy'})
            for code, ftype, label, required, extra in FIELDS
        ],
    }


def form_spec(model_ref, form_page=True):
    """表单：录入 + **明细行**（`0C-3` 的子表，用 `loop`）。"""
    def field(node_id, code):
        ftype = next(f for c, f, _l, _r, _e in FIELDS if c == code)
        return {'id': node_id, 'componentName': VIEW_TYPE_OF[ftype],
                'props': {'fieldBinding': {'type': 'FieldRef', 'fieldRef': code}}}

    return {
        'view_code': 'replenishment_request_form',
        'name': '家具报货申请单',
        'view_type': 'FORM',
        'businessSchemaRef': model_ref,
        'componentRegistryRef': REGISTRY_REF,
        'queries': [{
            'query_code': 'q_request_items',
            # `params` 必须满足该 capability 的 `inputSchema`（它要求 businessSchemaRef）。
            # 空参数会被判 `VIEW_DATA_SOURCE_FORBIDDEN` —— 报错位置在参数上，
            # 容易被误读成「引用错了」。
            'query': {'type': 'DataQueryRef',
                      'queryRef': ITEM_QUERY_REF,
                      'params': {'businessSchemaRef': model_ref}},
        }],
        'componentsTree': [{
            'id': 'page_root', 'componentName': 'FormPage',
            'children': [
                {'id': 'basic_section', 'componentName': 'Section',
                 'props': {'title': '报货信息' if form_page else '明细'},
                 'children': [field('f_store', 'store_code'),
                              field('f_date', 'delivery_date'),
                              field('f_qty', 'quantity'),
                              field('f_amount', 'amount')]},
                # 明细行（`0C-3`）：节点级 `loop` 必须挂在 `loopSupported` 为 true 的
                # 组件上 —— 注册表里 `Table` 是 false，`Section` / `Grid` / `Text` 是 true。
                # 所以是「重复的 Section 里放一个 Table」，不是「给 Table 加 loop」。
                {'id': 'items_section', 'componentName': 'Section',
                 'props': {'title': '报货明细'},
                 'loop': {'type': 'DataBindingRef', 'queryCode': 'q_request_items',
                          'itemKey': 'id', 'maxItems': 200},
                 'loopArgs': ['item', 'index'],
                 'children': [{'id': 'items_table', 'componentName': 'Table',
                               'props': {'text': '明细行'}}]},
                {'id': 'notes_section', 'componentName': 'Section',
                 'props': {'title': '补充说明'},
                 'children': [field('f_notes', 'notes')]},
                {'id': 'btn_submit', 'componentName': 'SubmitButton'},
            ],
        }],
    }


def workflow_spec(model_ref):
    """流程：发起 → 通过 / 驳回（`0C-4`）。"""
    return {
        'businessSchemaRef': model_ref,
        'states': [
            {'state_code': 'draft', 'name': '草稿', 'initial': True, 'terminal': False},
            {'state_code': 'submitted', 'name': '待总部确认', 'initial': False, 'terminal': False},
            {'state_code': 'approved', 'name': '已通过', 'initial': False, 'terminal': True},
            {'state_code': 'rejected', 'name': '已驳回', 'initial': False, 'terminal': False},
        ],
        # `Action` 的必填是 `action_code` / `kind` / `capability_ref` ——
        # 没有 `name`。形状只能来自契约，不能凭直觉写。
        'actions': [
            {'action_code': 'submit', 'kind': 'SUBMIT', 'capability_ref': ACTION_CAP},
            {'action_code': 'approve', 'kind': 'APPROVE', 'capability_ref': ACTION_CAP},
            {'action_code': 'reject', 'kind': 'REJECT', 'capability_ref': ACTION_CAP},
        ],
        'transitions': [
            {'transition_code': 'submit_flow', 'from_state': 'draft',
             'to_state': 'submitted', 'action_code': 'submit'},
            {'transition_code': 'approve_done', 'from_state': 'submitted',
             'to_state': 'approved', 'action_code': 'approve'},
            {'transition_code': 'reject_back', 'from_state': 'submitted',
             'to_state': 'rejected', 'action_code': 'reject'},
        ],
        'approverRef': {
            'kind': 'SINGLE',
            'role_ref': {
                'permission_ref': {
                    'scope_type': 'TENANT', 'scope_id': 'fixture_tenant',
                    'app_id': '11111111-1111-4111-8111-111111111111',
                    'module_id': None, 'asset_type': 'PERMISSION',
                    'asset_id': 'role_directory', 'version': 1,
                    'digest': 'sha256:' + 'a' * 64},
                'subresource': {'type': 'ROLE', 'code': 'hq_manager'},
            },
        },
    }


REGISTRY_REF = {}
ITEM_QUERY_REF = {}
# 流程动作引用的 capability。动作**必须有** capability（契约必填）——
# 这一条本身就说明「动作不是名字，是要落到一个已登记能力上的」。
ACTION_CAP = {
    'scope_type': 'TENANT', 'scope_id': 'fixture_tenant',
    'app_id': '11111111-1111-4111-8111-111111111111', 'module_id': None,
    'asset_type': 'CAPABILITY', 'capability_code': 'flow.submit',
    'version': 1, 'digest': 'sha256:' + 'b' * 64,
}


def build():
    base = json.load(open(BASE_CONTEXT, encoding='utf-8'))
    registry = next(a for a in base['fake_assets']
                    if a['ref'].get('asset_type') == 'COMPONENT_REGISTRY')
    REGISTRY_REF.clear()
    REGISTRY_REF.update(registry['ref'])

    ftr = next(a['ref'] for a in base['fake_assets']
               if a['ref'].get('asset_type') == 'FIELD_TYPE_REGISTRY')

    model = model_spec(ftr)
    model_digest = bp.c14n_digest(model)
    model_ref = {
        'scope_type': 'TENANT', 'scope_id': '11111111-1111-4111-8111-111111111111',
        'app_id': '22222222-2222-4222-8222-222222222222',
        'module_id': '33333333-3333-4333-8333-333333333333',
        'asset_type': 'BUSINESS_SCHEMA', 'asset_id': model['schema_code'],
        'version': 1, 'digest': model_digest,
    }

    # 明细行的数据源：一条 QUERY capability（内容已含上文的 businessSchemaRef 常量）
    query_content = {
        'fixture': True, 'capability_code': 'request.items.list', 'version': 1,
        'state': 'PUBLISHED', 'category': 'QUERY',
        'inputSchema': {'type': 'object',
                        'properties': {'businessSchemaRef': {'const': model_ref}},
                        'required': ['businessSchemaRef'],
                        'additionalProperties': False},
        'outputSchema': {'type': 'object',
                         'properties': {'items': {'type': 'array', 'items': {
                             'type': 'object',
                             'properties': {'id': {'type': 'string'},
                                            'item_name': {'type': 'string'},
                                            'item_qty': {'type': 'integer'}},
                             'required': ['id', 'item_name', 'item_qty'],
                             'additionalProperties': False}}},
                         'required': ['items'], 'additionalProperties': False},
        'errorSchema': {'type': 'object',
                        'properties': {'code': {'enum': ['FAKE_REJECTED']},
                                       'retryable': {'const': False}},
                        'required': ['code', 'retryable'], 'additionalProperties': False},
        'authorization': ['FAKE_ONLY'], 'scope': 'current_business', 'sideEffects': False,
        'idempotency': 'fixture-no-write', 'retry': 'never',
        'runtimeDigest': 'sha256:' + '0' * 64, 'timeoutMs': 2000, 'rateLimit': 4,
        'maxResults': 200, 'itemKeys': ['id'], 'recovery': 'return-fixed-error',
        'auditEvents': ['fake.validation'],
    }
    query_ref = {'scope_type': 'PLATFORM_CONTROL', 'scope_id': 'kvvi-platform',
                 'app_id': None, 'module_id': None, 'asset_type': 'CAPABILITY',
                 'capability_code': 'request.items.list', 'version': 1,
                 'digest': bp.c14n_digest(query_content)}
    ITEM_QUERY_REF.clear()
    ITEM_QUERY_REF.update(query_ref)

    form = form_spec(model_ref)
    workflow = workflow_spec(model_ref)

    # ── 包自带的上下文：地基的上下文 + 本包的模型与查询 ──────────────
    context = json.loads(json.dumps(base))
    context['fake_assets'] = [a for a in context['fake_assets']
                              if a['ref'].get('asset_type') != 'BUSINESS_SCHEMA']
    context['fake_assets'].append({'ref': dict(model_ref, scope_type='TENANT'),
                                   'content': model})
    context['fake_assets'].append({'ref': query_ref, 'content': query_content})
    reg = next(a for a in context['fake_assets']
               if a['ref'].get('asset_type') == 'CAPABILITY_REGISTRY')
    members = [m for m in reg['content']['members'] if m.get('asset_type') == 'CAPABILITY']
    members.append(dict(query_ref))
    reg['content']['members'] = members
    reg['ref']['digest'] = bp.c14n_digest(reg['content'])
    context['view']['capability_registry_ref']['digest'] = reg['ref']['digest']
    # ⚠️ 已登记的模型要同时出现在 `snapshots` 里，**不能只放 fake_assets**。
    # 视图的引用校验走的是「已注册版本」那条路：只放进 fake_assets 会得到
    # `REFERENCE_NOT_FOUND | businessSchemaRef`，而那个报错看起来像引用写错了。
    snapshot = json.loads(json.dumps(base['snapshots'][0]))
    snapshot['ref'] = dict(model_ref)
    snapshot['registered']['spec'] = model
    snapshot['registered']['checksum'] = model_digest
    context['snapshots'] = [snapshot]
    context['current']['asset_id'] = 'replenishment_request_form'

    pack = {
        'packVersion': 'kvvi-industry-pack/v1',
        'industry': '家具',
        'name': '家具报货申请',
        'note': '行业扩展包：按 PRD §5.7.3，行业内容只允许出现在本目录，'
                '地基不得因此改动。',
        'adds': {
            'skills': ['skills/家具报货规范/SKILL.md'],
            'components': [],
            'contracts': ['01-数据模型.json', '02-表单.json', '03-流程.json'],
        },
        'foundationUnchanged': '地基未改动.json',
    }

    files = {
        '00-需求.md': REQUIREMENT + '\n',
        '行业包.json': json.dumps(pack, ensure_ascii=False, indent=2) + '\n',
        '01-数据模型.json': json.dumps(model, ensure_ascii=False, indent=2) + '\n',
        '02-表单.json': json.dumps(form, ensure_ascii=False, indent=2) + '\n',
        '03-流程.json': json.dumps(workflow, ensure_ascii=False, indent=2) + '\n',
        'context.json': json.dumps(context, ensure_ascii=False, indent=2) + '\n',
        'skills/家具报货规范/SKILL.md': SKILL + '\n',
    }
    return files


SKILL = """---
name: furniture-replenishment
description: 家具行业报货规范——门店报货的字段约定与审批口径。行业扩展包，随包安装，不改地基。
---

# 家具报货规范（行业扩展包）

> **本文件属于行业扩展包，不属于地基。** 出现「报货」「门店」是对的。
> 地基（契约、工具、五个通用 Skill）里出现它们才是问题（PRD §5.7.3、`0A-14`）。

## 字段约定

| 字段 | 约定 |
|---|---|
| `store_code` | 用总部主数据里的门店编码，不要自由填写 |
| `delivery_date` | 期望**到货**日期，不是下单日期 |
| `quantity` | 按最小包装单位计；散件单独在备注里说明 |
| `amount` | 预估金额，仅供参考，不作为结算依据 |

## 审批口径

- 提交后由总部确认；**驳回必须写原因**，否则门店无法修改重提。
- 已通过的申请**不允许追加品项** —— 追加等于新申请。
"""


def main() -> int:
    files = build()
    if '--check' in sys.argv:
        problems = []
        for rel, text in files.items():
            path = os.path.join(PACK, rel)
            if not os.path.isfile(path):
                problems.append('缺少 %s' % rel)
            elif open(path, encoding='utf-8').read() != text:
                problems.append('%s 与生成结果不一致' % rel)
        if problems:
            for p in problems:
                print('✗ %s' % p)
            return 1
        print('✓ %d 个文件与生成结果一致' % len(files))
        return 0
    for rel, text in files.items():
        path = os.path.join(PACK, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w', encoding='utf-8') as fh:
            fh.write(text)
    print('✓ 已生成 %s（%d 个文件）' % (os.path.relpath(PACK, ROOT), len(files)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
