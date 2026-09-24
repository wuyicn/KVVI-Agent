#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成 `0D-1` 蓝图的**可复现样例**：`样例/蓝图/通用事项管理系统/`。

## 为什么是生成器而不是手写的目录

蓝图里到处是 id 与摘要：命令的 `command_id`、`base_revision` 序号、
产出物的 `c14n` 摘要、DraftGraph 摘要、影响报告里的 `impacted_refs`、
审批里绑定的 `artifact_digest`。手写它们等于手工维护一条**摘要链**，
链条任意一处接不上，检查器只会报「摘要不符」，**不告诉你是哪一环**。

生成器按正确顺序算出来，并支持 `--check` 检出「生成结果与落盘不一致」——
即有人手改过样例。

## 它不做什么

生成器**不产出契约本身**（`business-schema` / `view-schema` …）。
那些是五个 Skill 的产出，已经被 `工具/check_skill_output.py` 逐份验收过
（见 `样例/*/`）。蓝图**引用**它们，不复制它们 —— 一份产出只有一个家。

用法：

    python3 工具/蓝图样例.py            # 生成
    python3 工具/蓝图样例.py --check    # 只校验落盘是否与生成结果一致

## 一个必须说清的缺口

`14 个命令里没有任何一个产出 `tool-spec`（接口）。所以「接口」这一部分的
`via` 是**空的**，并带 `via_note` 说明原因。检查器会把它作为
「命令词汇表覆盖不到的部分」**显式报出来**，而不是让它静默通过。
"""

import json
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(HERE, 'lib'))

import 蓝图 as bp  # noqa: E402

TARGET = os.path.join(ROOT, '样例', '蓝图', '通用事项管理系统')


def u(n: int) -> str:
    """稳定的测试用 UUID：`c0ffee00-…` 前缀 + 序号。"""
    return 'c0ffee00-0000-4000-8000-%012d' % n


APP = u(1)
DRAFT = u(2)
MODULE = u(3)
BUSINESS_OBJECT = u(4)
FIELDS = {'item_no': u(10), 'title': u(11), 'detail': u(12),
          'amount': u(13), 'due_date': u(14), 'item_status': u(15)}
# 逐字镜像 `样例/business-schema/通用事项.spec.json` —— 命令序列必须产出**那一份**模型，
# 否则「蓝图闭环」就是把两份互不相干的产出装在一起（这个错误在本项目真实发生过：
# 视图样例曾绑在一个字段完全不同的模型副本上）。
FIELD_SPECS = [
    ('item_no', 'short_text', '事项编号', True,
     {'write_policy': 'CREATE_ONLY'}),
    ('title', 'short_text', '标题', True, {}),
    ('detail', 'long_text', '说明', False, {}),
    ('amount', 'money', '金额', True,
     {'type_config': {'currency_mode': 'FIXED', 'currency': 'CNY'}}),
    ('due_date', 'date', '截止日期', False, {}),
    ('item_status', 'single_select', '状态', True,
     {'type_config': {'options': [
         {'code': 'draft', 'label': '草稿', 'order': 0, 'enabled': True},
         {'code': 'submitted', 'label': '待审批', 'order': 1, 'enabled': True},
         {'code': 'approved', 'label': '已通过', 'order': 2, 'enabled': True},
         {'code': 'rejected', 'label': '已驳回', 'order': 3, 'enabled': True},
     ]}}),
]

# 表单里可填的字段（item_no 是系统生成的单号、item_status 由流程驱动，都不作为输入）
FORM_INPUTS = ('title', 'detail', 'amount', 'due_date')
READONLY = (('item_no', 'Description'), ('item_status', 'StatusBadge'))

DASHBOARD_NODES = [
    ('trend', 'root', 'Section', {'title': '近 12 个月销售趋势'}),
    ('trend_table', 'trend', 'Table',
     {'text': '近 12 个月销售趋势',
      'data': {'type': 'DataBindingRef', 'queryCode': 'q_monthly_sales',
               'itemKey': 'month', 'maxItems': 12}}),
    ('dept', 'root', 'Section', {'title': '各部门完成情况'}),
    ('dept_table', 'dept', 'Table',
     {'text': '各部门完成情况',
      'data': {'type': 'DataBindingRef', 'queryCode': 'q_dept_completion',
               'itemKey': 'dept', 'maxItems': 20}}),
    ('detail', 'root', 'Section', {'title': '待处理明细'}),
    ('detail_table', 'detail', 'Table',
     {'text': '待处理明细',
      'data': {'type': 'DataBindingRef', 'queryCode': 'q_records',
               'itemKey': 'id', 'maxItems': 50}}),
]

VIEW_FORM = u(20)
NODE_FORM = {'root': u(21), 'basic_section': u(22), 'system_section': u(23),
             'btn': u(29)}
NODE_FIELD = {code: u(30 + i) for i, code in enumerate(FORM_INPUTS)}
NODE_READONLY = {code: u(36 + i) for i, code in enumerate(('item_no', 'item_status'))}
VIEW_DASH = u(40)
NODE_DASH = {'root': u(41), 'trend': u(42), 'trend_table': u(43),
             'dept': u(44), 'dept_table': u(45),
             'detail': u(46), 'detail_table': u(47)}
WORKFLOW = u(60)
PERMISSION = u(61)

FIELD_TYPE_REGISTRY_REF = {
    'scope_type': 'PLATFORM_CONTROL', 'scope_id': 'kvvi-platform',
    'app_id': None, 'module_id': None,
    'asset_type': 'FIELD_TYPE_REGISTRY',
    'asset_id': 'business-field-types-core', 'version': 1,
    'digest': 'sha256:' + '0' * 64,          # 生成时用真实值覆盖
}

REQUIREMENT = """# 通用事项管理系统 · 需求（说人话）

> 这一份是**业务原话**，不是契约。它存在的意义是：后面所有产出物里出现的
> 名称，都必须能在这里找到依据 —— 否则「AI 蓝图」就变成了「AI 想象」。

## 业务在做什么

公司里每天有很多**临时事项**需要登记和流转：采购申请、用章申请、外出报备之类。
现在靠群消息和表格，谁提交了、走到哪一步、谁批的，都靠人记。

我们想要一个系统：

1. **登记**：员工填一张「通用事项登记表单」，写清楚**事项标题**、**事项分类**、
   **数量**，需要的话再填**金额**、**期望完成日期**和**备注**。
2. **流转**：提交之后要有人批。流程是**通用事项审批流**：
   草稿 → 待审批 → 已通过 / 已驳回；驳回以后可以改完重新提交。
3. **看数**：管理层要一块**月度销售趋势看板**，看近 12 个月的量、各部门完成情况，
   以及还没处理完的明细。
4. **对外**：别的系统要能查事项，所以需要一个**通用事项查询工具**的接口约定。

## 待确认的问题

> 这些是**没有答案**的问题。按搭建引擎的规则，未知的规则要**标出来**，
> 不能替用户编。

- 金额超过多少要加一级审批？现在是单级。
- 已通过的事项能不能撤回？现在**没有**撤回迁移。
- 「数量」是整数还是可以有小数？
"""


def command_id(index: int) -> str:
    return u(1000 + index)


def build():
    """按顺序构造命令序列，并记下每条命令创建了哪些 id。"""
    commands = []
    ids = {}

    # id 表按 (kind, 逻辑名) 索引；**节点要带视图前缀** ——
    # 两个视图各有自己的 `root`，只用 `root` 当键会互相覆盖（踩过一次）。
    id_table = {
        ('module', 'general_item'): MODULE,
        ('business_object', 'general_item'): BUSINESS_OBJECT,
        ('view', 'general_item_form'): VIEW_FORM,
        ('view', 'monthly_sales_dashboard'): VIEW_DASH,
        ('workflow', 'general_item_flow'): WORKFLOW,
        ('permission', 'general_item_roles'): PERMISSION,
    }
    id_table.update({('field', code): value for code, value in FIELDS.items()})
    for name, value in NODE_FORM.items():
        id_table[('node', 'general_item_form/' + name)] = value
    for code in FORM_INPUTS:
        id_table[('node', 'general_item_form/' + code)] = NODE_FIELD[code]
    for name, value in NODE_DASH.items():
        id_table[('node', 'monthly_sales_dashboard/' + name)] = value
    for name, value in READONLY:
        id_table[('node', 'general_item_form/' + name)] = NODE_READONLY[name]

    def logical_id(kind, logical):
        return id_table[(kind, logical)]

    # 视图外壳 / 流程 / 权限的外壳**不由 14 个命令创建** —— 它们在草稿里已存在，
    # 命令只做增量（加节点、加迁移、改策略）。这是命令词汇表的真实形状，
    # 不掩盖：`created_by: "blueprint"` 会被检查器计数并报出。
    for kind, logical in (('view', 'general_item_form'),
                          ('view', 'monthly_sales_dashboard'),
                          ('workflow', 'general_item_flow'),
                          ('permission', 'general_item_roles')):
        ids[logical_id(kind, logical)] = {
            'kind': kind, 'logical': logical, 'created_by': 'blueprint',
        }

    def emit(type_, target_ref, args, creates):
        index = len(commands)
        cid = command_id(index)
        commands.append({
            'file': '%02d-%s.command.json' % (index + 1, type_.replace('.', '-')),
            'command': {
                'command_version': 'app-model-command/v1alpha1',
                'command_id': cid,
                'draft_id': DRAFT,
                'base_revision': index,
                'type': type_,
                'target_ref': target_ref,
                'args': args,
            },
        })
        for kind, logical in creates:
            ids[logical_id(kind, logical)] = {
                'kind': kind, 'logical': logical, 'created_by': cid,
            }
        return cid

    # ── 应用与数据模型 ───────────────────────────────────────────────
    c_module = emit('app.createModule', {'app_id': APP},
                    {'module_code': 'general_item', 'name': '通用事项管理'},
                    [('module', 'general_item')])
    c_object = emit('businessObject.create', {'module_id': MODULE},
                    {'schema_code': 'general_item', 'name': '通用事项',
                     'field_type_registry_ref': FIELD_TYPE_REGISTRY_REF},
                    [('business_object', 'general_item')])

    field_commands = {}
    for code, ftype, label, required, extra in FIELD_SPECS:
        args = {'field_code': code, 'field_type': ftype, 'label': label,
                'required': required}
        args.update(extra)
        field_commands[code] = emit(
            'field.add', {'business_object_id': BUSINESS_OBJECT}, args,
            [('field', code)])

    c_constraint = emit(
        'field.changeConstraint',
        {'business_object_id': BUSINESS_OBJECT, 'field_id': FIELDS['amount']},
        {'constraints': {'minimum': 0, 'maximum': 10000000}}, [])

    # ── 表单（view-schema，FORM）── 与 样例/view-schema/通用事项登记表单.spec.json 同构
    node_commands = {}
    c_root = emit('view.addNode', {'view_id': VIEW_FORM, 'parent_node_id': None},
                  {'componentName': 'FormPage', 'props': {}, 'position': 0},
                  [('node', 'general_item_form/root')])
    c_basic = emit('view.addNode',
                   {'view_id': VIEW_FORM, 'parent_node_id': NODE_FORM['root']},
                   {'componentName': 'Section', 'props': {'title': '事项信息'}, 'position': 0},
                   [('node', 'general_item_form/basic_section')])

    component_of = {'title': 'ShortTextField', 'detail': 'LongTextField',
                    'amount': 'MoneyField', 'due_date': 'DateField'}
    for position, code in enumerate(FORM_INPUTS):
        node_commands[code] = emit(
            'view.addNode',
            {'view_id': VIEW_FORM, 'parent_node_id': NODE_FORM['basic_section']},
            {'componentName': component_of[code], 'props': {}, 'position': position},
            [('node', 'general_item_form/' + code)])

    c_system = emit('view.addNode',
                    {'view_id': VIEW_FORM, 'parent_node_id': NODE_FORM['root']},
                    {'componentName': 'Section', 'props': {'title': '系统字段（只读）'},
                     'position': 1},
                    [('node', 'general_item_form/system_section')])
    for position, (code, component) in enumerate(READONLY):
        node_commands[code] = emit(
            'view.addNode',
            {'view_id': VIEW_FORM, 'parent_node_id': NODE_FORM['system_section']},
            {'componentName': component, 'props': {}, 'position': position},
            [('node', 'general_item_form/' + code)])

    bind_commands = {}
    for code in FORM_INPUTS:
        bind_commands[code] = emit(
            'view.bindField', {'view_id': VIEW_FORM, 'node_id': NODE_FIELD[code]},
            {'business_object_id': BUSINESS_OBJECT, 'field_id': FIELDS[code]}, [])

    c_btn = emit('view.addNode', {'view_id': VIEW_FORM, 'parent_node_id': NODE_FORM['root']},
                 {'componentName': 'SubmitButton', 'props': {}, 'position': 2},
                 [('node', 'general_item_form/btn')])

    # ── 看板（view-schema，LIST）── 与 样例/view-schema/月度销售看板.spec.json 同构
    c_dash_root = emit('view.addNode', {'view_id': VIEW_DASH, 'parent_node_id': None},
                       {'componentName': 'ListPage', 'props': {'title': '月度销售趋势看板'},
                        'position': 0}, [('node', 'monthly_sales_dashboard/root')])
    dash_commands = {}
    for position, (name, parent, component, props) in enumerate(DASHBOARD_NODES):
        dash_commands[name] = emit(
            'view.addNode',
            {'view_id': VIEW_DASH, 'parent_node_id': NODE_DASH[parent]},
            {'componentName': component, 'props': props, 'position': position},
            [('node', 'monthly_sales_dashboard/' + name)])

    # ── 流程与权限（外壳由蓝图提供，命令只做增量）─────────────────
    c_transition = emit(
        'workflow.addTransition', {'workflow_id': WORKFLOW},
        {'transition': {'transition_code': 'submit_flow', 'from_state': 'draft',
                        'to_state': 'submitted', 'action_code': 'submit'}}, [])

    c_policy = emit(
        'permission.changeRolePolicy', {'permission_id': PERMISSION},
        {'policy': {
            'policy_code': 'flow_approve', 'role_code': 'manager',
            'role_ref': {
                'permission_ref': {
                    'scope_type': 'TENANT', 'scope_id': 'fixture_tenant',
                    'app_id': APP, 'module_id': None, 'asset_type': 'PERMISSION',
                    'asset_id': 'role_directory', 'version': 1,
                    'digest': 'sha256:' + 'a' * 64},
                'subresource': {'type': 'ROLE', 'code': 'manager'}},
            'dimension': 'FLOW', 'effect': 'ALLOW',
            'resource_ref': {
                'scope_type': 'TENANT', 'scope_id': 'fixture_tenant', 'app_id': APP,
                'module_id': None, 'asset_type': 'WORKFLOW', 'asset_id': 'general_item_flow',
                'version': 1, 'digest': 'sha256:' + 'b' * 64},
            'subresource': {'type': 'STATE', 'code': 'submitted'},
            'actions': ['APPROVE'],
            'capability_refs': []}}, [])

    c_route = emit('navigation.addRoute', {'app_id': APP},
                   {'route_code': 'general_item_entry', 'path': '/general-item',
                    'view_id': VIEW_FORM}, [])

    # ── 收口：编译 → 提交审批 ──────────────────────────────────────
    c_compile = emit('draft.compile', {}, {}, [])
    c_submit = emit('draft.submitForApproval', {}, {}, [])

    form_via = ([c_root, c_basic, c_system, c_btn]
                + [node_commands[c] for c in FORM_INPUTS]
                + [node_commands[c] for c, _ in READONLY]
                + list(bind_commands.values()))
    dash_via = [c_dash_root] + list(dash_commands.values())

    artifacts = [
        {'part': '数据模型', 'code': 'general_item', 'human_name': '通用事项',
         'contract': 'business-schema/v1',
         'path': '../../business-schema/通用事项.spec.json',
         'context': '../../business-schema/context-新建.json',
         'via': [c_module, c_object] + list(field_commands.values()) + [c_constraint]},
        {'part': '表单', 'code': 'general_item_form', 'human_name': '通用事项登记表单',
         'contract': 'view-schema/lce-safe-v1',
         'path': '../../view-schema/通用事项登记表单.spec.json',
         'context': '../../view-schema/context.json',
         'via': form_via},
        {'part': '看板', 'code': 'monthly_sales_dashboard', 'human_name': '月度销售趋势看板',
         'contract': 'view-schema/lce-safe-v1',
         'path': '../../view-schema/月度销售看板.spec.json',
         'context': '../../view-schema/context-看板.json',
         'via': dash_via},
        {'part': '流程', 'code': 'general_item_flow', 'human_name': '通用事项审批流',
         'contract': 'workflow-spec/v1alpha1',
         'path': '../../workflow-spec/通用事项审批流.spec.json',
         'context': None,
         'via': [c_transition]},
        {'part': '接口', 'code': 'general_item.get', 'human_name': '通用事项查询工具',
         'contract': 'tool-spec/v1alpha1',
         'path': '../../tool-spec/通用事项查询工具.spec.json',
         'context': None,
         'via': [],
         'via_note': '14 个命令里没有任何一个产出 tool-spec —— 接口不来自命令序列。'
                     '这是命令词汇表覆盖不到的部分，检查器会显式报出。'},
    ]

    blueprint = {
        'blueprint_version': 'kvvi-blueprint/v1',
        'app': {'app_id': APP, 'module_code': 'general_item', 'name': '通用事项管理'},
        'draft': {'draft_id': DRAFT},
        'ids': ids,
        'artifacts': artifacts,
        'calibers': [{'path': '../../view-schema/看板-口径登记.json'}],
        'commands_without_artifact': [c_policy, c_route, c_compile, c_submit],
    }
    return blueprint, commands


def build_derived(bp_dir, blueprint):
    """由蓝图 + 命令序列推导出：影响报告、预览、审批。"""
    entries = bp.artifact_entries(bp_dir, blueprint)
    digest = bp.draft_digest(entries)

    impacted = []
    for e in entries:
        ref = {
            'scope_type': 'TENANT',
            'scope_id': '11111111-1111-4111-8111-111111111111',
            'app_id': APP,
            'module_id': MODULE,
            'asset_type': {
                'business-schema/v1': 'BUSINESS_SCHEMA',
                'view-schema/lce-safe-v1': 'VIEW_SCHEMA',
                'workflow-spec/v1alpha1': 'WORKFLOW',
                'tool-spec/v1alpha1': 'TOOL_SPEC',
            }[e['contract']],
            'asset_id': e['code'],
            'version': 1,
            'digest': e['digest'],
        }
        impacted.append(ref)

    impact = {
        'contract_version': 'evidence-bundle/v1alpha1',
        'canonicalization_profile': 'kvvi-json-c14n/v1',
        'evidence_id': u(9001),
        'artifact_digest': digest,
        'evidence_type': 'IMPACT_REPORT',
        'environment': 'DEVELOPMENT',
        'promotion_ref': None,
        'producer': {'source_id': 'kvvi_blueprint_loop', 'run_id': u(9002),
                     'method_version': 'kvvi-blueprint/v1',
                     'execution_kind': 'REFERENCE', 'dataset_kind': 'NONE'},
        'observed_at': '2026-09-23T00:00:00Z',
        'payload': {
            'report_attachment_id': 'impact_report',
            'app_context_graph_digest': digest,
            'base_artifact_digest': None,
            'change_count': len(impacted),
            'impacted_refs': impacted,
            'risk': 'MEDIUM',
        },
        'attachments': [{
            'content': {'content_id': 'impact_report', 'digest': digest,
                        'media_type': 'application/json'},
            'byte_length': 1,
        }],
        'audit': {'actor': {'scope_id': 'kvvi-platform', 'principal_id': u(9003)},
                  'recorded_at': '2026-09-23T00:00:00Z', 'trace_id': 'blueprint_trace'},
        'record_digest': digest,
    }

    approval = {
        'contract_version': 'approval-attestation/v1alpha1',
        'canonicalization_profile': 'kvvi-json-c14n/v1',
        'attestation_id': u(9004),
        'artifact_digest': digest,
        'approver': {'scope_id': 'kvvi-platform', 'principal_id': u(9005)},
        'permission_version': 1,
        'approved_at': '2026-09-23T00:01:00Z',
        'decision': 'APPROVE',
        'opinion': '蓝图与影响报告已核对，同意进入发布。',
        'presentation_ref': {'evidence_id': u(9001), 'record_digest': digest},
        'audit': {'actor': {'scope_id': 'kvvi-platform', 'principal_id': u(9005)},
                  'recorded_at': '2026-09-23T00:01:00Z', 'trace_id': 'blueprint_trace'},
        'attestation_digest': digest,
    }

    previews = {}
    for e in entries:
        if e['contract'] != 'view-schema/lce-safe-v1':
            continue
        spec = bp.load_json(e['path'])
        previews[bp.preview_path(bp_dir, spec['view_code'])] = bp.render_preview(spec)

    return impact, approval, previews


def materialize(bp_dir: str):
    blueprint, commands = build()

    # 字段类型注册表的摘要取自 context —— 不写死
    ctx = bp.load_json(os.path.join(ROOT, '样例', 'view-schema', 'context.json'))
    for asset in ctx['fake_assets']:
        if asset['ref'].get('asset_type') == 'FIELD_TYPE_REGISTRY':
            FIELD_TYPE_REGISTRY_REF['digest'] = asset['ref']['digest']
            FIELD_TYPE_REGISTRY_REF['scope_type'] = asset['ref']['scope_type']
            FIELD_TYPE_REGISTRY_REF['scope_id'] = asset['ref']['scope_id']

    files = {'00-需求.md': REQUIREMENT + '\n',
             '蓝图.json': json.dumps(blueprint, ensure_ascii=False, indent=2) + '\n'}
    for item in commands:
        files['命令/' + item['file']] = json.dumps(item['command'],
                                                   ensure_ascii=False, indent=2) + '\n'

    impact, approval, previews = build_derived(bp_dir, blueprint)
    files['影响.json'] = json.dumps(impact, ensure_ascii=False, indent=2) + '\n'
    files['审批.json'] = json.dumps(approval, ensure_ascii=False, indent=2) + '\n'
    for path, text in previews.items():
        files[os.path.relpath(path, bp_dir)] = text
    return files


def main() -> int:
    files = materialize(TARGET)

    if '--check' in sys.argv:
        problems = []
        for rel, text in files.items():
            path = os.path.join(TARGET, rel)
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

    if os.path.isdir(TARGET):
        shutil.rmtree(TARGET)
    for rel, text in files.items():
        path = os.path.join(TARGET, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w', encoding='utf-8') as fh:
            fh.write(text)
    print('✓ 已生成 %s（%d 个文件）' % (os.path.relpath(TARGET, ROOT), len(files)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
