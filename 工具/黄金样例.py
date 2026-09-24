#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
黄金样例（阶段六锚点②、任务 `0D-2`）：10 组标准需求，反复跑，结果**稳定**。

## ⚠️ 「稳定」在这里的确切含义 —— 必须说清楚

`0D-2` 的验收原文是「10 组标准需求反复跑，结果稳定」。
「稳定」有两种可能的读法，本工具**只兑现其中一种**：

| 读法 | 本工具 | 说明 |
|---|---|---|
| **装配的确定性**：同一份蓝图反复装，产出逐字节相同 | ✅ **兑现** | 这是可机器判定的那一半 |
| **模型的稳定性**：同一个需求问模型十次，十次给出同一份蓝图 | ❌ **未兑现** | 需要真实模型参与，且**本来就不该承诺逐字相同** |

第二条**不应**被含糊地算作已兑现：它既没测，也不该这样测。
所以本工具每次运行都会把这句话打印出来，避免「通过了」被读成「模型稳定了」。

## 这一层真正防的是什么

防的是**装配环节里的非确定性**：遍历顺序、时间戳、随机 id、字典序不定 ——
这些会让「同一份蓝图装两次得到两个包」，而它们**在单次运行时看不出来**。
判据是把同一份输入装两次，**逐字节比对**。

用法：

    python3 工具/黄金样例.py --write     # 生成 10 组样例
    python3 工具/黄金样例.py --check     # 复核：逐份合法 + 重复装配逐字节一致
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(HERE, 'lib'))

import 蓝图 as bp  # noqa: E402

OUT = os.path.join(ROOT, '样例', '黄金样例')
BASE_CONTEXT = os.path.join(ROOT, '样例', 'view-schema', 'context.json')
CHECK = os.path.join(HERE, 'check_skill_output.py')

C_OK, C_BAD, C_WARN, C_DIM, C_OFF = '\033[32m', '\033[31m', '\033[32m', '\033[31m', '\033[0m'

# ── 10 组标准需求 ───────────────────────────────────────────────────────
#
# ⚠️ 全部**刻意中立**（无行业词）—— 它们是地基能力的检验，
# 不是行业样例。行业样例是 `样例/行业包/`。
BRIEFS = [
    ('01-事项登记', '登记一件需要流转的事项，能填标题、分类、数量、金额与期限。',
     [('title', 'short_text', '标题', True), ('category', 'single_select', '分类', True),
      ('quantity', 'integer', '数量', True), ('amount', 'money', '金额', False),
      ('due_date', 'date', '期限', False)]),
    ('02-申请审批', '员工提交申请，主管审批通过或驳回。',
     [('title', 'short_text', '事由', True), ('applicant', 'short_text', '申请人', True),
      ('amount', 'money', '金额', False)]),
    ('03-设备借用', '登记设备的借出与归还。',
     [('asset_no', 'short_text', '设备编号', True), ('borrower', 'short_text', '借用人', True),
      ('borrowed_on', 'date', '借出日期', True), ('returned_on', 'date', '归还日期', False)]),
    ('04-差旅报销', '提交差旅费用明细并走审批。',
     [('trip_purpose', 'short_text', '出差事由', True), ('amount', 'money', '报销金额', True),
      ('notes', 'long_text', '说明', False)]),
    ('05-合同登记', '登记合同基本信息与生效期限。',
     [('contract_no', 'short_text', '合同编号', True), ('party', 'short_text', '对方', True),
      ('effective_on', 'date', '生效日期', True), ('expires_on', 'date', '到期日期', False)]),
    ('06-物资领用', '登记物资领用数量与用途。',
     [('item_name', 'short_text', '物资', True), ('quantity', 'integer', '数量', True),
      ('purpose', 'long_text', '用途', False)]),
    ('07-供应商准入', '供应商资料登记与资质审批。',
     [('supplier_name', 'short_text', '供应商', True), ('contact', 'short_text', '联系人', False),
      # ⚠️ 不能叫 `status` —— 它是契约的 12 个保留字之一
      # （`id` / `status` / `created_at` …）。用保留字报的是
      # `FIELD_CODE_INVALID`，看起来像「字段名写错了」，实际是「这个名字被平台占用了」。
      ('admission_status', 'single_select', '准入状态', True)]),
    ('08-用章申请', '登记用章事由与用章类型。',
     [('purpose', 'short_text', '用章事由', True), ('seal_type', 'single_select', '印章类型', True),
      ('used_on', 'date', '用章日期', True)]),
    ('09-异常上报', '上报异常情况并跟踪处理。',
     [('summary', 'short_text', '概要', True), ('detail', 'long_text', '详情', True),
      ('severity', 'single_select', '严重程度', True)]),
    ('10-培训报名', '员工报名培训并记录参与情况。',
     [('course_name', 'short_text', '课程', True), ('attendee', 'short_text', '参加人', True),
      ('attend_on', 'date', '参加日期', True)]),
]

VIEW_OF = {'short_text': 'ShortTextField', 'long_text': 'LongTextField',
           'integer': 'IntegerField', 'money': 'MoneyField',
           'date': 'DateField', 'single_select': 'SingleSelectField'}

OPTIONS = [{'code': 'draft', 'label': '草稿', 'order': 0, 'enabled': True},
           {'code': 'submitted', 'label': '待审批', 'order': 1, 'enabled': True},
           {'code': 'approved', 'label': '已通过', 'order': 2, 'enabled': True},
           {'code': 'rejected', 'label': '已驳回', 'order': 3, 'enabled': True}]


def build_one(index, slug, brief, fields):
    schema_code = 'golden_%02d' % index
    model = {
        'schema_code': schema_code,
        'name': slug.split('-', 1)[1],
        'description': brief,
        'field_type_registry_ref': FTR_REF,
        'fields': [{
            'field_code': code, 'label': label, 'type': ftype, 'required': required,
            'nullable': not required, 'write_policy': 'MUTABLE',
            'query': {'searchable': ftype in ('short_text', 'long_text'),
                      'filterable': True, 'sortable': ftype != 'long_text'},
            # 按字段类型补齐**契约要求的** type_config：
            # `money` 要 currency_mode + currency，`single_select` 要 options。
            # 少了它报的是 `CONTRACT_SHAPE_INVALID | fields[n].type_config` ——
            # 指向一个「看起来跟这个字段没关系」的位置。
            **({'type_config': {'currency_mode': 'FIXED', 'currency': 'CNY'}}
               if ftype == 'money' else
               {'type_config': {'options': OPTIONS}}
               if ftype == 'single_select' else {}),
        } for code, ftype, label, required in fields],
    }
    model_digest = bp.c14n_digest(model)
    model_ref = {
        'scope_type': 'TENANT', 'scope_id': '11111111-1111-4111-8111-111111111111',
        'app_id': '22222222-2222-4222-8222-222222222222',
        'module_id': '33333333-3333-4333-8333-333333333333',
        'asset_type': 'BUSINESS_SCHEMA', 'asset_id': schema_code,
        'version': 1, 'digest': model_digest,
    }
    form = {
        'view_code': '%s_form' % schema_code,
        'name': '%s登记表单' % slug.split('-', 1)[1],
        'view_type': 'FORM',
        'businessSchemaRef': model_ref,
        'componentRegistryRef': REGISTRY_REF,
        'componentsTree': [{
            'id': 'page_root', 'componentName': 'FormPage',
            'children': [
                {'id': 'main_section', 'componentName': 'Section',
                 'props': {'title': '基本信息'},
                 'children': [{'id': 'f_%s' % code,
                               'componentName': VIEW_OF[ftype],
                               'props': {'fieldBinding': {'type': 'FieldRef',
                                                          'fieldRef': code}}}
                              for code, ftype, _l, _r in fields]},
                {'id': 'btn_submit', 'componentName': 'SubmitButton'},
            ],
        }],
    }
    workflow = {
        'businessSchemaRef': model_ref,
        'states': [
            {'state_code': 'draft', 'name': '草稿', 'initial': True, 'terminal': False},
            {'state_code': 'submitted', 'name': '待审批', 'initial': False, 'terminal': False},
            {'state_code': 'approved', 'name': '已通过', 'initial': False, 'terminal': True},
            {'state_code': 'rejected', 'name': '已驳回', 'initial': False, 'terminal': False},
        ],
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
                'subresource': {'type': 'ROLE', 'code': 'supervisor'}},
        },
    }

    # 类型化命令序列：由模型**确定性推导**，不含时间戳/随机量
    app_id = 'a0000000-0000-4000-8000-%012d' % index
    draft_id = 'd0000000-0000-4000-8000-%012d' % index
    module_id = 'b0000000-0000-4000-8000-%012d' % index
    object_id = 'c0000000-0000-4000-8000-%012d' % index
    commands = []

    def emit(type_, target_ref, args):
        idx = len(commands)
        commands.append({
            'command_version': 'app-model-command/v1alpha1',
            'command_id': 'e0000000-0000-4000-8000-%012d' % (index * 100 + idx),
            'draft_id': draft_id, 'base_revision': idx, 'type': type_,
            'target_ref': target_ref, 'args': args,
        })

    emit('app.createModule', {'app_id': app_id},
         {'module_code': schema_code, 'name': slug.split('-', 1)[1]})
    emit('businessObject.create', {'module_id': module_id},
         {'schema_code': schema_code, 'name': slug.split('-', 1)[1],
          'field_type_registry_ref': FTR_REF})
    for code, ftype, label, required in fields:
        emit('field.add', {'business_object_id': object_id},
             {'field_code': code, 'field_type': ftype, 'label': label,
              'required': required})
    emit('draft.compile', {}, {})
    emit('draft.submitForApproval', {}, {})

    return {
        'brief': brief, 'slug': slug,
        'model': model, 'form': form, 'workflow': workflow,
        'commands': commands,
        'ids': {
            ('module', schema_code): module_id,
            ('business_object', schema_code): object_id,
        },
    }


REGISTRY_REF = {}
FTR_REF = {}
ACTION_CAP = {
    'scope_type': 'TENANT', 'scope_id': 'fixture_tenant',
    'app_id': '11111111-1111-4111-8111-111111111111', 'module_id': None,
    'asset_type': 'CAPABILITY', 'capability_code': 'flow.submit',
    'version': 1, 'digest': 'sha256:' + 'b' * 64,
}


def context_for(schema_code, model, model_ref):
    base = json.load(open(BASE_CONTEXT, encoding='utf-8'))
    model_digest = model_ref['digest']
    context = json.loads(json.dumps(base))
    context['fake_assets'] = [a for a in context['fake_assets']
                              if a['ref'].get('asset_type') != 'BUSINESS_SCHEMA']
    context['fake_assets'].append({'ref': dict(model_ref), 'content': model})
    snapshot = json.loads(json.dumps(base['snapshots'][0]))
    snapshot['ref'] = dict(model_ref)
    snapshot['registered']['spec'] = model
    snapshot['registered']['checksum'] = model_digest
    context['snapshots'] = [snapshot]
    context['current']['asset_id'] = '%s_form' % schema_code
    return context


def build_all():
    base = json.load(open(BASE_CONTEXT, encoding='utf-8'))
    registry = next(a['ref'] for a in base['fake_assets']
                    if a['ref'].get('asset_type') == 'COMPONENT_REGISTRY')
    ftr = next(a['ref'] for a in base['fake_assets']
               if a['ref'].get('asset_type') == 'FIELD_TYPE_REGISTRY')
    REGISTRY_REF.clear()
    REGISTRY_REF.update(registry)
    FTR_REF.clear()
    FTR_REF.update(ftr)

    files = {}
    summary = []
    for i, (slug, brief, fields) in enumerate(BRIEFS, 1):
        one = build_one(i, slug, brief, fields)
        d = one['model']['schema_code']
        files['%s/需求.md' % slug] = '# %s\n\n%s\n\n## 待确认的问题\n\n- 未在原文中说明的规则不臆造。\n' % (
            slug.split('-', 1)[1], brief)
        files['%s/产出.json' % slug] = json.dumps(
            {k: one[k] for k in ('model', 'form', 'workflow', 'commands')},
            ensure_ascii=False, indent=2) + '\n'
        ctx = context_for(d, one['model'], one['form']['businessSchemaRef'])
        files['%s/context.json' % slug] = json.dumps(ctx, ensure_ascii=False,
                                                     indent=2) + '\n'
        summary.append('%s  字段 %d 个  命令 %d 条'
                       % (slug, len(one['model']['fields']), len(one['commands'])))
    files['清单.json'] = json.dumps({
        'sampleVersion': 'kvvi-golden/v1',
        'count': len(BRIEFS),
        'note': '10 组标准需求。**稳定 == 装配确定性**：同一份输入装两次逐字节相同；'
                '不主张「模型十次给出同一份蓝图」。',
        'briefs': [{'slug': s, 'brief': b} for s, b, _f in BRIEFS],
    }, ensure_ascii=False, indent=2) + '\n'
    return files, summary


def write_to(dest, files):
    for rel, text in files.items():
        path = os.path.join(dest, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w', encoding='utf-8') as fh:
            fh.write(text)


def main() -> int:
    files, summary = build_all()

    if '--write' in sys.argv:
        if os.path.isdir(OUT):
            shutil.rmtree(OUT)
        write_to(OUT, files)
        print('✓ 已生成 %d 组黄金样例（%d 个文件）' % (len(BRIEFS), len(files)))
        for line in summary:
            print('  %s' % line)
        return 0
    if '--check' in sys.argv:
        return check(files)

    print(__doc__)
    return 2


def check(files) -> int:
    problems = []
    print('%s=== 黄金样例检查 ===%s' % (C_OK, C_OFF))
    print('判据：10 组标准需求逐份合法 + **反复跑结果稳定**（任务 0D-2）')
    print()
    print('%s⚠️ 「稳定」= 装配确定性，不是模型稳定性。后者未测，也不该这样测。%s'
          % (C_WARN, C_OFF))
    print()

    print('[1] 落盘是否与生成结果一致（同一份输入装两次）')
    for rel, text in sorted(files.items()):
        path = os.path.join(OUT, rel)
        if not os.path.isfile(path):
            problems.append('缺少 %s' % rel)
        elif open(path, encoding='utf-8').read() != text:
            problems.append('%s 与生成结果不一致' % rel)
    if problems:
        for p in problems[:6]:
            print('  %s✗ %s%s' % (C_BAD, p, C_OFF))
    else:
        print('  %s✓ %d 个文件逐字节一致%s' % (C_OK, len(files), C_OFF))

    print()
    print('[2] 10 组产出逐份过契约校验')
    ok_count = 0
    for slug, _brief, _fields in BRIEFS:
        produced = json.load(open(os.path.join(OUT, slug, '产出.json'), encoding='utf-8'))
        ctx = os.path.join(OUT, slug, 'context.json')
        results = []
        for key, contract in (('model', 'business-schema/v1'),
                              ('form', 'view-schema/lce-safe-v1'),
                              ('workflow', 'workflow-spec/v1alpha1')):
            tmp = os.path.join(tempfile.mkdtemp(), '%s.json' % key)
            with open(tmp, 'w', encoding='utf-8') as fh:
                json.dump(produced[key], fh, ensure_ascii=False)
            args = ['python3', CHECK, tmp, '--contract', contract]
            if key in ('model', 'form'):
                args += ['--context', '样例/business-schema/context-新建.json'
                         if key == 'model' else ctx]
            r = subprocess.run(args, cwd=ROOT, capture_output=True, text=True)
            results.append(r.returncode == 0)
        # 命令序列的拓扑序（`base_revision` 连续 + 收口动作齐备）
        types = [c['type'] for c in produced['commands']]
        topo = (all(c['base_revision'] == i for i, c in enumerate(produced['commands']))
                and types.count('draft.compile') == 1
                and types[-1] == 'draft.submitForApproval')
        if all(results) and topo:
            ok_count += 1
            print('  %s✓%s %-22s 三份产出合法，命令 %d 条拓扑正确'
                  % (C_OK, C_OFF, slug, len(types)))
        else:
            problems.append('%s 未通过' % slug)
            print('  %s✗%s %-22s 契约 %s / 拓扑 %s'
                  % (C_BAD, C_OFF, slug, results, topo))

    print()
    if problems:
        print('%s✗ 黄金样例未通过：%d 项%s' % (C_BAD, len(problems), C_OFF))
        return 1
    print('%s✓ 黄金样例通过：%d/%d 组合法，且重复装配逐字节一致%s'
          % (C_OK, ok_count, len(BRIEFS), C_OFF))
    return 0


if __name__ == '__main__':
    sys.exit(main())
