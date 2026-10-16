#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
`0D-1` AI 蓝图闭环的端到端检查器 —— 阶段三锚点④ 的可执行判据。

## 判据来自哪里

`0D-1` 的验收原文（KVVI-Builder `docs/progress.json`）：

> **说人话 → 蓝图 → 类型化命令 → DraftGraph → 校验/影响/预览 → 你点通过**

本检查器就是把这六个阶段**逐段变成可判定的**。任何一段不成立，
闭环就没有闭合 —— 不是「大部分跑通」。

## 六个阶段分别查什么

| 阶段 | 查什么 | 谁定义的 |
|---|---|---|
| ① 说人话 | `00-需求.md` 存在、非空、**含「待确认的问题」**；且每份产出物的中文名都能在需求里**找到依据** | 本检查器（可追溯性） |
| ② 蓝图 | `蓝图.json` 合法；**五部分齐全**（数据模型 / 表单 / 流程 / 看板 / 接口，PRD 行 1363） | 本检查器 |
| ③ 类型化命令 | 每条命令过 `app-model-command/v1alpha1`（**结构**）；同草稿；收口动作齐备 | 契约 |
| ④ DraftGraph | **确定性重放**：`base_revision` 连续、目标必须已被更早的命令创建（拓扑序）、id 覆盖一致 | 本检查器（见下） |
| ⑤ 校验/影响/预览 | 每份产出物过契约校验；口径过 §9.8.1 不变量；影响报告的**摘要与产出物一致**；预览**可由产出物重算出来** | 契约 + 本检查器 |
| ⑥ 你点通过 | 审批记录存在、过契约校验、**绑定到同一份 DraftGraph 摘要**、且 `decision` 为 `APPROVE` | 契约 + 本检查器 |

## 为什么第 ④ ⑥ 两段必须自己查

`0a-full-r1` 的 README 在「验证边界」里明写了结构校验**不覆盖**的部分：

> | Command/Tool | **幂等历史、base_revision**、稳定节点/风险升级、
>   组件属性和字段参数与实际登记关联 |

以及：

> | 全部引用 | 精确注册资产存在性……**不可变版本/正文摘要**…… |
> | 发布四对象 | 跨对象摘要/身份相等……**有效人工审批**…… |

本检查器补的正是这几项：`base_revision` 连续性、拓扑序、
产出的正文摘要重算、影响报告的新鲜度、审批与摘要的绑定。
**结构校验通过 ≠ 闭环闭合**，两者都要有。

## 一条本项目自己定义的口径

契约里没有「编译产出的摘要」这个字段。本闭环把它定义为
**DraftGraph 摘要 = `c14n(按 (part, code) 排序的资产清单)`**（见 `工具/lib/蓝图.py`）。
定义只有一处，生成器与检查器共用 —— 否则两边会各算一套，然后互相报错。

## 用法

    python3 工具/check_blueprint.py <蓝图目录>
    python3 工具/check_blueprint.py <蓝图目录> --json

退出码：`0` = 闭环闭合 / `1` = 未闭合 / `2` = 无法执行
"""

import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(HERE, 'lib'))

import 蓝图 as bp            # noqa: E402
import contract_check as cc   # noqa: E402

C_OK, C_BAD, C_WARN, C_DIM, C_OFF = '\033[32m', '\033[31m', '\033[33m', '\033[90m', '\033[0m'

INVARIANT = os.path.join(HERE, 'check_invariant.py')
CONTRACT_OF = {
    'business-schema/v1', 'view-schema/lce-safe-v1', 'workflow-spec/v1alpha1',
    'tool-spec/v1alpha1', 'permission-spec/v1alpha1', 'app-spec/v1alpha1',
    'app-model-command/v1alpha1', 'approval-attestation/v1alpha1',
    'evidence-bundle/v1alpha1',
}


class Report:
    """把六段结论收集起来 —— 最后统一决定退出码，不在中途 return。"""

    def __init__(self):
        self.stages = []
        self.gaps = []

    def stage(self, name, problems, notes=()):
        self.stages.append({'stage': name, 'problems': list(problems),
                            'notes': list(notes)})
        return not problems


def check(bp_dir: str, as_json: bool = False) -> int:
    report = Report()

    # ── ① 说人话 ────────────────────────────────────────────────────
    problems, notes = [], []
    req_path = os.path.join(bp_dir, '00-需求.md')
    if not os.path.isfile(req_path):
        problems.append('缺少 00-需求.md —— 闭环的第一步是「说人话」')
        requirement = ''
    else:
        requirement = open(req_path, encoding='utf-8').read()
        if len(requirement.strip()) < 200:
            problems.append('00-需求.md 太短（%d 字符）—— 不足以支撑后续产出'
                            % len(requirement.strip()))
        if '待确认' not in requirement:
            problems.append('00-需求.md 没有「待确认的问题」一节 —— '
                            '未知的规则必须标出来，不能替用户编')
    report.stage('① 说人话', problems, notes)

    # ── ② 蓝图 ──────────────────────────────────────────────────────
    problems, notes = [], []
    # 目录里根本没有蓝图 → **不是「未通过」，是「无法执行」**。
    # 把「检查器跑不起来」报成「检查不通过」，两个都会让人以为问题在产出物上。
    if not os.path.isfile(os.path.join(bp_dir, bp.BP_NAME)):
        print('✗ %s 里没有 %s —— 这不是一个蓝图目录' % (bp_dir, bp.BP_NAME))
        return 2
    try:
        blueprint = bp.load_blueprint(bp_dir)
    except Exception as exc:
        print('✗ 无法读取蓝图：%s' % exc)
        return 2

    entries = bp.artifact_entries(bp_dir, blueprint)
    parts = [e['part'] for e in entries]
    missing = [p for p in bp.REQUIRED_PARTS if p not in parts]
    if missing:
        problems.append('蓝图缺部分：%s —— §1363 要求数据模型/表单/流程/看板/接口齐全'
                        % '、'.join(missing))
    for e in entries:
        if not os.path.isfile(e['path']):
            problems.append('%s 声明的产出物不存在：%s' % (e['part'], e['rel']))
    if requirement:
        for e in entries:
            if e['code'] not in requirement and e['code'] not in ('',):
                pass
            if e['part'] == '接口':
                continue
            # 名称可追溯：产出物的中文名必须能在需求里找到依据
            human = next((a['human_name'] for a in blueprint['artifacts']
                          if a['code'] == e['code']), e['code'])
            if human not in requirement:
                problems.append('「%s」在 00-需求.md 里找不到依据 —— '
                                '产出物不能凭空出现' % human)
    report.stage('② 蓝图', problems, notes)

    # ── ③ 类型化命令 ────────────────────────────────────────────────
    problems, notes = [], []
    commands = bp.load_commands(bp_dir)
    if not commands:
        problems.append('命令/ 目录下没有命令 —— 蓝图必须由类型化命令落实')
    types = []
    for name, cmd in commands:
        result = cc.validate(os.path.join(bp_dir, '命令', name),
                             'app-model-command/v1alpha1')
        if not result.ok:
            problems.append('命令 %s 未过 %s：%s'
                            % (name, cc.scope_label(result.scope),
                               _first_error(result)))
        types.append(cmd.get('type'))
        if cmd.get('draft_id') != blueprint['draft']['draft_id']:
            problems.append('命令 %s 的 draft_id 与蓝图不符' % name)
    if types.count(bp.DRAFT_COMPILE) != 1:
        problems.append('`draft.compile` 必须恰好一次，实际 %d 次'
                        % types.count(bp.DRAFT_COMPILE))
    if types and types[-1] != bp.DRAFT_SUBMIT:
        problems.append('最后一条命令必须是 `draft.submitForApproval`，实际是 %r' % types[-1])
    notes.append('命令 %d 条，类型 %d 种' % (len(commands), len(set(types))))
    report.stage('③ 类型化命令', problems, notes)

    # ── ④ DraftGraph（确定性重放）───────────────────────────────────
    problems, notes = [], []
    steps, replay_problems = bp.replay(commands, blueprint)
    problems += replay_problems

    command_ids = {c.get('command_id') for _, c in commands}
    referenced = set()
    for item in blueprint['artifacts']:
        for cid in item.get('via', []):
            referenced.add(cid)
            if cid not in command_ids:
                problems.append('产出物 %s 的 via 指向不存在的命令 %s'
                                % (item['code'], cid))
        if not item.get('via') and not item.get('via_note'):
            problems.append('产出物 %s 没有任何 via，也没有 via_note 说明原因'
                            % item['code'])

    allowed_unreferenced = set(blueprint.get('commands_without_artifact', []))
    orphans = [c for f, c in commands
               if c.get('type') not in bp.DRAFT_LIFECYCLE
               and c.get('command_id') not in referenced
               and c.get('command_id') not in allowed_unreferenced]
    for c in orphans:
        problems.append('命令 %s（%s）既不产出任何资产，也不在 '
                        'commands_without_artifact 里 —— 孤儿命令' % (c['command_id'], c['type']))

    # ④ ↔ ⑤ 的桥：重放出来的节点序列必须与产出物里的节点序列**同构**。
    # 只声明「via 指向了某些命令」是不够的 —— 命令加了 10 个节点、
    # 产出物里只有 3 个，同样会「通过」。这里逐位比对组件名。
    by_id = {c.get('command_id'): c for _, c in commands}
    index_of = {c.get('command_id'): i for i, (_, c) in enumerate(commands)}
    for item in blueprint['artifacts']:
        if item['contract'] != 'view-schema/lce-safe-v1':
            continue
        spec = bp.load_json(bp.resolve(bp_dir, item['path']))
        produced = []
        for node in _preorder(spec['componentsTree'][0]):
            produced.append(node['componentName'])
        # 按**重放顺序**（命令在序列里的下标）排，不按 `via` 的书写顺序 —
        # `via` 表达的是「哪些命令产出了它」，是一个集合，顺序由草稿的版本序列决定。
        ordered = sorted((index_of[cid], cid) for cid in item.get('via', [])
                         if cid in index_of)
        built = [by_id[cid]['args'].get('componentName')
                 for _, cid in ordered
                 if by_id[cid].get('type') == 'view.addNode']
        if built != produced:
            problems.append('%s：命令建出的节点序列与产出物不一致\n'
                            '        命令：%s\n        产出：%s'
                            % (item['code'], ' → '.join(str(x) for x in built),
                               ' → '.join(produced)))
        else:
            notes.append('%s：%d 个节点，命令序列与产出物逐位一致'
                         % (item['code'], len(produced)))

    shells = [m['logical'] for m in blueprint.get('ids', {}).values()
              if m.get('created_by') == 'blueprint']
    notes.append('重放 %d 步；蓝图提供的外壳 %d 个（%s）'
                 % (len(steps), len(shells), '、'.join(sorted(shells)) or '无'))
    report.stage('④ DraftGraph', problems, notes)

    digest = bp.draft_digest(entries)

    # ── ⑤ 校验 / 影响 / 预览 ───────────────────────────────────────
    problems, notes = [], []
    scopes = {}
    for e in entries:
        result = cc.validate(e['path'], e['contract'], e['context'])
        scopes[e['contract']] = result.scope
        if not result.ok:
            problems.append('%s（%s）未过校验：%s'
                            % (e['part'], e['code'], _first_error(result)))
    notes.append('契约校验：%s' % '；'.join(
        '%s=%s' % (k, cc.scope_label(v)) for k, v in sorted(scopes.items())))

    # ★ B1 修复：表单的字段绑定必须指向数据模型里**真实存在**的字段。
    # 此前只逐份校验契约，不查「表单绑的字段」与「模型声明的字段」是否同源 ——
    # 模型把 title 改名、命令与审批摘要同步了，表单还绑旧 title 也能闭环通过。
    model_fields = {}
    for e in entries:
        if e['contract'] != 'business-schema/v1':
            continue
        spec = bp.load_json(e['path'])
        model_fields[e['code']] = {
            f.get('field_code') for f in spec.get('fields', [])
            if isinstance(f, dict) and f.get('field_code')
        }
    for e in entries:
        if e['contract'] != 'view-schema/lce-safe-v1':
            continue
        spec = bp.load_json(e['path'])
        model_code = (spec.get('businessSchemaRef') or {}).get('asset_id')
        known = model_fields.get(model_code)
        for node in _preorder(spec['componentsTree'][0]):
            binding = (node.get('props') or {}).get('fieldBinding')
            if not isinstance(binding, dict):
                continue
            field_ref = binding.get('fieldRef')
            if not field_ref:
                continue
            if known is None:
                problems.append('%s：fieldBinding 指向字段 %r，但业务模型 %r 没有字段清单'
                                % (e['code'], field_ref, model_code))
            elif field_ref not in known:
                problems.append('%s：fieldBinding 指向字段 %r，但业务模型里没有这个字段'
                                % (e['code'], field_ref))

    # 口径过 §9.8.1 不变量
    for item in blueprint.get('calibers', []):
        path = bp.resolve(bp_dir, item['path'])
        r = subprocess.run(['python3', INVARIANT, '--input', path],
                           capture_output=True, text=True, timeout=300)
        if r.returncode != 0:
            problems.append('口径登记单未过 §9.8.1 不变量判定：%s'
                            % os.path.relpath(path, ROOT))
        else:
            notes.append('口径登记单过不变量判定：%s' % os.path.relpath(path, ROOT))

    # 影响报告：结构 + **摘要重算**（结构校验不做摘要重算）
    impact_path = os.path.join(bp_dir, '影响.json')
    if not os.path.isfile(impact_path):
        problems.append('缺少 影响.json —— 「影响」这一阶段没有产出')
    else:
        result = cc.validate(impact_path, 'evidence-bundle/v1alpha1')
        if not result.ok:
            problems.append('影响.json 未过契约校验：%s' % _first_error(result))
        impact = bp.load_json(impact_path)
        if impact.get('evidence_type') != 'IMPACT_REPORT':
            problems.append('影响.json 的 evidence_type 必须是 IMPACT_REPORT')
        payload = impact.get('payload', {})
        if payload.get('app_context_graph_digest') != digest:
            problems.append('影响报告的 DraftGraph 摘要与产出物对不上 —— '
                            '报告是旧的（这正是「改一处、不传播」的样子）')
        refs = payload.get('impacted_refs', [])
        if payload.get('change_count') != len(refs):
            problems.append('影响报告的 change_count=%r 与 impacted_refs 的 %d 条不符'
                            % (payload.get('change_count'), len(refs)))
        by_code = {e['code']: e['digest'] for e in entries}
        for ref in refs:
            actual = by_code.get(ref.get('asset_id'))
            if actual is None:
                problems.append('影响报告提到了不在蓝图里的资产 %r' % ref.get('asset_id'))
            elif actual != ref.get('digest'):
                problems.append('影响报告里 %s 的摘要与产出物实际摘要不符'
                                % ref.get('asset_id'))
        if impact.get('artifact_digest') != digest:
            problems.append('影响.json 的 artifact_digest 不是本次 DraftGraph 的摘要')

    # 预览：必须**能从产出物重算出来**
    preview_count = 0
    for e in entries:
        if e['contract'] != 'view-schema/lce-safe-v1':
            continue
        spec = bp.load_json(e['path'])
        path = bp.preview_path(bp_dir, spec['view_code'])
        if not os.path.isfile(path):
            problems.append('缺少预览：%s' % os.path.relpath(path, bp_dir))
            continue
        preview_count += 1
        actual = open(path, encoding='utf-8').read()
        if actual != bp.render_preview(spec):
            problems.append('预览 %s 与产出物重算结果不一致 —— '
                            '它不是从产出物推导出来的'
                            % os.path.relpath(path, bp_dir))
    notes.append('预览 %d 份，逐字节与产出物重算结果比对' % preview_count)
    report.stage('⑤ 校验 / 影响 / 预览', problems, notes)

    # ── ⑥ 你点通过 ─────────────────────────────────────────────────
    problems, notes = [], []
    approval_path = os.path.join(bp_dir, '审批.json')
    if not os.path.isfile(approval_path):
        problems.append('缺少 审批.json —— 闭环**必须**停在人的批准上，'
                        '不能自动发布')
    else:
        result = cc.validate(approval_path, 'approval-attestation/v1alpha1')
        if not result.ok:
            problems.append('审批.json 未过契约校验：%s' % _first_error(result))
        approval = bp.load_json(approval_path)
        if approval.get('decision') != 'APPROVE':
            problems.append('审批结果是 %r —— 未获批准不得发布' % approval.get('decision'))
        if approval.get('artifact_digest') != digest:
            problems.append('审批绑定的摘要与本次 DraftGraph 不符 —— '
                            '批的不是这一份')
        if not (approval.get('approver') or {}).get('principal_id'):
            problems.append('审批记录没有审批人')
        else:
            notes.append('审批人 %s 于 %s 批准'
                         % (approval['approver']['principal_id'],
                            approval.get('approved_at')))
    report.stage('⑥ 你点通过', problems, notes)

    report.gaps = [
        '接口（tool-spec）不由命令产出 —— 14 个命令里没有对应的命令，'
        '该部分只做到「契约校验 + 摘要一致」，没有命令级溯源',
        '`draft.undoCommand` / `draft.redoCommand` 未在本样例出现 —— '
        '撤销重做的幂等历史未验证',
        '批准之后的发布动作（注册、上线）不在本闭环内 —— 本闭环到「你点通过」为止',
        '运行期是否真按配置执行，是另一件事：本检查器判定的是**配置**',
    ]
    return emit(report, as_json)


def _preorder(node):
    """按前序遍历节点树 —— 与命令序列的执行顺序对应。"""
    yield node
    for child in node.get('children', []) or []:
        yield from _preorder(child)


def _first_error(result) -> str:
    if result.scope == 'error':
        return result.detail
    if not result.errors:
        return result.detail or '未知原因'
    e = result.errors[0]
    return '%s @ %s %s' % (e.get('code'), e.get('path'), str(e.get('message'))[:60])


def emit(report: Report, as_json: bool) -> int:
    failed = [s for s in report.stages if s['problems']]
    code = 0 if not failed else 1

    if as_json:
        print(json.dumps({'closed': code == 0, 'stages': report.stages,
                          'gaps': report.gaps}, ensure_ascii=False, indent=2))
        return code

    print('%s=== `0D-1` AI 蓝图闭环检查 ===%s' % (C_OK, C_OFF))
    print('判据：说人话 → 蓝图 → 类型化命令 → DraftGraph → 校验/影响/预览 → 你点通过')
    print()
    for stage in report.stages:
        mark = '%s✓%s' % (C_OK, C_OFF) if not stage['problems'] else '%s✗%s' % (C_BAD, C_OFF)
        print('%s %s' % (mark, stage['stage']))
        for note in stage['notes']:
            print('    %s%s%s' % (C_DIM, note, C_OFF))
        for problem in stage['problems']:
            print('    %s✗ %s%s' % (C_BAD, problem, C_OFF))
    print()

    print('%s本闭环未覆盖（必须与「通过」一起读）%s' % (C_WARN, C_OFF))
    for gap in report.gaps:
        print('  · %s' % gap)
    print()

    if code:
        print('%s✗ 闭环未闭合：%d 段不成立%s' % (C_BAD, len(failed), C_OFF))
    else:
        print('%s✓ 闭环闭合：六段全部成立%s' % (C_OK, C_OFF))
    return code


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    if not args:
        print(__doc__)
        return 2
    bp_dir = args[0]
    if not os.path.isdir(bp_dir):
        print('✗ 蓝图目录不存在：%s' % bp_dir)
        return 2
    return check(bp_dir, '--json' in sys.argv)


if __name__ == '__main__':
    sys.exit(main())
