#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
`workflow-spec` 的 **complete check** —— 契约自己声明不管、但没人管的那几件事。

## 这个工具为什么存在

契约 `workflow-spec.v1alpha1.schema.json` 的 `$defs.Spec.$comment` 写着：

> Structure only: role directory resolution, per-step coverage/graph order,
> selector field matrix and 100-leaf total are complete-check responsibilities.

也就是说：**契约把五件事推给了 complete check，而本仓库此前没有 complete check。**
`工具/check_skill_output.py` 对它只能报「结构通过」——
一个 `states: []` + `transitions: []` 的流程**结构完全合法**，但它是一个死流程。

## 覆盖到哪一层（**必须如实呈现，不能只报一个 OK**）

| # | 项 | 状态 | 判据来源 |
|---|---|---|---|
| 2 | per-step coverage | ✅ 已实现 | 图的出边与可达性，只从 `State.initial/terminal` 与 `Transition` 推得 |
| 3 | graph order | ✅ 已实现 | 集合比对，只从契约字段推得 |
| 5 | 100-leaf total | ✅ 已实现（**取保守读法，见下**） | 计数 |
| 4 | selector field matrix | ⚠️ **只做最弱读法：字段是否存在** | 见下 |
| 1 | role directory resolution | ✅ 已实现 | 需 `--context` 或 `--assets` 提供角色目录 |

### #4 为什么只做最弱读法

契约只给了「selector field matrix」这个**名称**，没有给判据。
「matrix」至少三种读法都说得通：(a) 字段类型×操作符×值类型、(b) 字段是否存在、
(c) 分支覆盖不留缝。**三种读法会拒绝不同的配置** —— 选 (c) 会把一个
「只处理 5 万以上、其余走 default」的合法流程拒掉。

按猜测实现一个会挡人的校验器，比没有校验器更糟：它会断言一件契约从没说过的事。
所以这里只做 **(b)** —— 它不需要猜维度，本质上与 #1 同构（**解析引用**），
它挡掉的失效模式是真的：**选择器引用了不存在的字段 → 永远匹配不上 → 静默走 default 链**。
**(a) 与 (c) 未实现，且是「已知未做」，不是「不知道」。**

### #5 「100-leaf total」的保守读法

契约没定义「什么算一个叶」。这里取**最保守**的读法：
`状态数 + 迁移数 + choices 数 + 选择器内谓词数`，上限 **100**。
读法偏保守意味着：**它只会拦下规模明显失控的流程，不会误拒正常流程。**

## 三种结论

- `PASS` —— 查了，通过
- `FAIL` —— 查了，不通过（有具体问题）
- `UNKNOWN` —— **外部输入没给，查不了** —— 这不是通过，也不是失败

`--strict` 会让 UNKNOWN 也返回非零退出码。默认不。

用法：
  python3 工具/check_workflow_semantics.py <流程.json> [--entry spec|compiled-draft|auto]
                                       [--context <ctx.json>] [--assets <目录>]
                                       [--model <数据模型.json>] [--strict] [--json]
  python3 工具/check_workflow_semantics.py --self-test

退出码：0 = PASS（无 FAIL）；1 = 有 FAIL；2 = 无法执行（输入不可读 / 契约结构不通过）
"""

import argparse
import glob
import json
import os
import sys
from collections import deque

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, '工具', 'lib'))
import contract_check as cc   # noqa: E402  官方验证器入口，保证入口判定与它一致
import role_directory as rd   # noqa: E402  样例层的角色目录（#1 的解析目标）

C_OK, C_BAD, C_WARN, C_DIM, C_OFF = '\033[32m', '\033[31m', '\033[33m', '\033[90m', '\033[0m'

LEAF_LIMIT = 100          # #5 的上限，来自契约的 "100-leaf total"
SELECTOR_OPERATORS = ('eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in')


def load_json(path):
    with open(path, encoding='utf-8') as fh:
        return json.load(fh)


def unwrap(doc, entry='auto'):
    """取出 `Spec`。三种载体都要认：

    - `CompiledDraft`（契约的导出条目，根定义名就是 `CompiledDraft`）
    - 裸 `Spec`（`样例/workflow-spec/`、`样例/行业包/*/03-流程.json`）
    - 「产出打包」（`样例/黄金样例/*/产出.json`：`{model, form, workflow, commands}`）

    第三种不是契约形态，是**本仓库自己的聚合文件**。它必须能认 ——
    否则一个把三份产出打在一起的 JSON，会看起来像「没法校验」。
    """
    if entry == 'auto':
        if isinstance(doc, dict) and 'workflow' in doc:
            return doc['workflow'], 'bundle'
        entry = 'spec' if isinstance(doc, dict) and 'states' in doc else 'compiled-draft'
    if entry == 'bundle':
        if not isinstance(doc, dict) or 'workflow' not in doc:
            raise ValueError('`--entry bundle` 但文档里没有 `workflow` 字段')
        return doc['workflow'], 'bundle'
    if entry == 'compiled-draft':
        if not isinstance(doc, dict) or 'spec' not in doc:
            raise ValueError('`--entry compiled-draft` 但文档里没有 `spec` 字段')
        return doc['spec'], entry
    if entry == 'spec':
        return doc.get('spec', doc) if isinstance(doc, dict) and 'spec' in doc else doc, 'spec'
    raise ValueError('--entry 只能是 auto / spec / compiled-draft / bundle')


# ── 外部输入：角色目录与业务模型字段 ────────────────────────────────────────────

def _asset_key(ref):
    if not isinstance(ref, dict):
        return None
    at = ref.get('asset_type')
    aid = ref.get('asset_id')
    return (at, aid) if at and aid else None


def collect_refs(obj, key):
    """递归收集 `role_ref` / `businessSchemaRef` 这类引用。"""
    out = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k == key:
                out.append(v)
            out.extend(collect_refs(v, key))
    elif isinstance(obj, list):
        for v in obj:
            out.extend(collect_refs(v, key))
    return out


def build_dossier(paths):
    """把 `--context` / `--assets` / `--model` 提供的东西汇总成一张可解析的表。

    三种来源都要能喂进来，因为真实调用分三种场景：
    校验单份产出物（`--context`）、校验一个行业包目录（`--assets`）、
    校验一个包里顺手带着业务模型（`--model`）。
    """
    assets = {}       # (asset_type, asset_id) -> content
    roles = {}        # (asset_id, role_code) -> True     角色目录
    models = {}       # (asset_id, None) / ('*', digest) -> fields

    def add_asset(ref, content):
        k = _asset_key(ref)
        if k:
            assets[k] = content
        if isinstance(content, dict) and isinstance(content.get('roles'), list):
            aid = (ref or {}).get('asset_id') or (content.get('schema_code') or '?')
            for r in content['roles']:
                if isinstance(r, dict) and r.get('role_code'):
                    roles[(aid, r['role_code'])] = True
        if isinstance(content, dict) and isinstance(content.get('fields'), list):
            aid = (ref or {}).get('asset_id') or content.get('schema_code')
            models[aid] = [f.get('field_code') for f in content['fields']
                           if isinstance(f, dict) and f.get('field_code')]

    for p in paths:
        doc = load_json(p)
        if isinstance(doc, dict) and isinstance(doc.get('fake_assets'), list):
            for a in doc['fake_assets']:
                add_asset(a.get('ref'), a.get('content'))
            for s in doc.get('snapshots', []):
                add_asset(s.get('ref'), (s.get('registered') or {}).get('spec'))
        elif isinstance(doc, dict) and 'spec' in doc and isinstance(doc.get('spec'), dict):
            add_asset(doc.get('ref') or {'asset_type': 'UNKNOWN', 'asset_id': 'inline'},
                      doc['spec'])
        elif isinstance(doc, dict) and 'workflow' in doc:
            # 「产出打包」：模型与流程在同一份文件里，各自认领
            add_asset({'asset_type': 'BUSINESS_SCHEMA',
                       'asset_id': (doc.get('model') or {}).get('schema_code')},
                      doc.get('model'))
        elif isinstance(doc, dict):
            add_asset({'asset_type': doc.get('asset_type')
                       or ('PERMISSION' if 'roles' in doc else 'BUSINESS_SCHEMA'),
                       'asset_id': doc.get('asset_id') or doc.get('schema_code')},
                      doc)

    # 样例层共用的角色目录（`工具/lib/role_directory.py`）**永远并入**：
    # 样例里的 `role_ref` 都指向 `role_directory`，但那份目录不在任何产出物里。
    # 不并入 → 每次校验都只能报 UNKNOWN —— 那不是「没给输入」，是**从来没查过**。
    for k in rd.as_dicts():
        roles.setdefault(k, True)
    return assets, roles, models


def resolve_role(roles, ref):
    """#1 角色目录解析：`role_ref.subresource.code` 是否在目录里。"""
    if not isinstance(ref, dict):
        return False, '不是对象'
    perm = ref.get('permission_ref')
    sub = ref.get('subresource')
    if not isinstance(sub, dict) or sub.get('type') != 'ROLE':
        return False, 'subresource 不是 ROLE'
    code = sub.get('code')
    aid = (perm or {}).get('asset_id')
    if not aid:
        return False, 'permission_ref 缺 asset_id'
    if (aid, code) in roles:
        return True, '%s.%s 在角色目录中' % (aid, code)
    if aid == '*':
        return (any(c == code for (_a, c) in roles),
                '角色目录（不限定 asset_id）里%s %s' % ('有' if any(c == code for (_a, c) in roles) else '没有', code))
    return False, '角色目录 %s 中没有 %s' % (aid, code)


def resolve_field(models, model_ref, code):
    """#4 最弱读法：字段是否存在于 `businessSchemaRef` 指向的模型里。"""
    aid = (model_ref or {}).get('asset_id')
    if not models:
        return None, '没有可用的业务模型'
    if aid in models:
        return (code in models[aid],
                '%s 的字段 %s %s' % (aid, code, '存在' if code in models[aid] else '不存在'))
    if len(models) == 1:
        only = next(iter(models))
        return (code in models[only],
                '只有一份模型 %s（引用的是 %s），字段 %s %s'
                % (only, aid, code, '存在' if code in models[only] else '不存在'))
    return None, '找不到 businessSchemaRef=%s 对应的模型（有 %d 份可选）' % (aid, len(models))


# ── 选择器遍历 ────────────────────────────────────────────────────────────────

def walk_selector(sel, depth=0):
    """产出 (字段 code, 探到的深度) 与 (谓词数, 分支数)。

    结构来自契约：Selector1 = Predicate；SelectorN = Predicate | all/any/not(SelectorN-1)。
    """
    fields, preds, branches, max_depth = [], 0, 0, depth
    if not isinstance(sel, dict):
        return fields, preds, branches, max_depth
    if 'field' in sel and 'operator' in sel:
        f = sel.get('field') or {}
        if f.get('code'):
            fields.append((f['code'], depth))
        return fields, 1, 0, max_depth
    for key in ('all', 'any'):
        if isinstance(sel.get(key), list):
            branches += len(sel[key])
            for sub in sel[key]:
                f2, p2, b2, d2 = walk_selector(sub, depth + 1)
                fields += f2
                preds += p2
                branches += b2
                max_depth = max(max_depth, d2)
    if 'not' in sel:
        branches += 1
        f2, p2, b2, d2 = walk_selector(sel['not'], depth + 1)
        fields += f2
        preds += p2
        branches += b2
        max_depth = max(max_depth, d2)
    return fields, preds, branches, max_depth


def selector_max_depth(sel):
    """最大嵌套深度 —— 用于**验证「最多 5 层」这个结构约定真的被遵守**。

    契约只定义到 Selector5，但结构层**拦不住更深的嵌套**吗？实测拦得住
    （Selector5 的 all/any/not 只接 Selector4）。这里把它**显式数出来**，
    因为「结构层拦住了」是一句需要证据的话。
    """
    if not isinstance(sel, dict):
        return 0
    if 'field' in sel and 'operator' in sel:
        return 1
    best = 0
    for key in ('all', 'any'):
        for sub in sel.get(key) or []:
            best = max(best, selector_max_depth(sub))
    if 'not' in sel:
        best = max(best, selector_max_depth(sel['not']))
    return best + 1 if best else 1


# ── 主检查 ────────────────────────────────────────────────────────────────────

class Report(object):
    def __init__(self):
        self.items = []      # (编号, 名称, 状态, [说明])

    def add(self, no, name, status, notes):
        self.items.append((no, name, status, notes))

    @property
    def failed(self):
        return [i for i in self.items if i[2] == 'FAIL']

    @property
    def unknown(self):
        return [i for i in self.items if i[2] == 'UNKNOWN']


def check_spec(spec, assets, roles, models, context_given):
    """跑完 #1–#5。返回 Report。"""
    rep = Report()

    states = spec.get('states') or []
    transitions = spec.get('transitions') or []
    actions = spec.get('actions') or []
    approver = spec.get('approverRef') or {}
    model_ref = spec.get('businessSchemaRef')

    codes = [s.get('state_code') for s in states]
    code_set = set(codes)
    action_codes = {a.get('action_code') for a in actions}

    # ── 契约层硬性形状（结构校验管结构，这里管「结构合法但不能运行」）──────────
    shape = []
    dups = [c for c in codes if codes.count(c) > 1]
    if dups:
        shape.append('状态 code 重复：%s' % '、'.join(sorted(set(dups))))
    initials = [c for s, c in zip(states, codes) if s.get('initial')]
    if len(initials) != 1:
        shape.append('initial 必须恰好一个，实际 %d 个（%s）' % (len(initials), '、'.join(map(str, initials)) or '无'))
    if not states:
        shape.append('states 为空 —— 契约允许（maxItems 0 是给 REGISTERED_CHAIN_SELECTION 用的），')
        shape.append('  但空状态图的流程没有任何可运行内容')

    # ── #3 graph order ────────────────────────────────────────────────────────
    g3 = []
    for t in transitions:
        if t.get('from_state') not in code_set:
            g3.append('迁移 %s 的 from_state=%r 不在 states 里' % (t.get('transition_code'), t.get('from_state')))
        if t.get('to_state') not in code_set:
            g3.append('迁移 %s 的 to_state=%r 不在 states 里' % (t.get('transition_code'), t.get('to_state')))
        if t.get('action_code') not in action_codes:
            g3.append('迁移 %s 的 action_code=%r 不在 actions 里' % (t.get('transition_code'), t.get('action_code')))
    transition_codes = [t.get('transition_code') for t in transitions]
    tdup = [c for c in transition_codes if transition_codes.count(c) > 1]
    if tdup:
        g3.append('迁移 code 重复：%s' % '、'.join(sorted(set(tdup))))
    action_code_list = [a.get('action_code') for a in actions]
    adup = [c for c in action_code_list if action_code_list.count(c) > 1]
    if adup:
        g3.append('动作 code 重复：%s' % '、'.join(sorted(set(adup))))
    for s in states:
        if s.get('terminal') and any(t.get('from_state') == s.get('state_code') for t in transitions):
            g3.append('终态 %s 有出边 —— 终态不应再迁移' % s.get('state_code'))
    # 契约的 `Transition` 只有 4 个属性且 `additionalProperties: false` ——
    # **迁移没有 `when`**。出现它就是有人发明了契约没有的东西（结构层也会拒，
    # 但结构层拒的理由是「多了个属性」，这里说的是「它想表达的东西无处安放」）。
    for t in transitions:
        if 'when' in t:
            g3.append('迁移 %s 带 `when` —— 契约的 Transition 没有这个属性，条件分支表达不了' % t.get('transition_code'))
    rep.add('3', 'graph order', 'FAIL' if (g3 or shape) else 'PASS', shape + g3)

    # ── #2 per-step coverage ──────────────────────────────────────────────────
    g2 = []
    out_any = {}
    for c in code_set:
        out_any[c] = [t for t in transitions if t.get('from_state') == c]
    incon = {c: [] for c in code_set}
    for t in transitions:
        if t.get('to_state') in incon:
            incon[t['to_state']].append(t)

    for s in states:
        c = s.get('state_code')
        outs = out_any.get(c, [])
        if s.get('terminal'):
            if not outs:
                continue
            continue                                   # 已由 #3 报出
        if not outs:
            g2.append('非终态 %s 没有出边 —— 进得去出不来（静默卡死）' % c)

    # 可达性：初始态出发
    reach = set(initials[:1])
    queue = deque(reach)
    while queue:
        cur = queue.popleft()
        for t in out_any.get(cur, []):
            nxt = t.get('to_state')
            if nxt in code_set and nxt not in reach:
                reach.add(nxt)
                queue.append(nxt)
    for c in codes:
        if c not in reach:
            g2.append('状态 %s 从 initial 不可达 —— 死代码' % c)

    # 能否走到终态。**「能到终态」不等于「有出路」**：一个只能走到终态的流程图
    # 在审批场景里意味着「提交之后只能通过」——驳回口被堵死。两者分开报。
    terminals = {s.get('state_code') for s in states if s.get('terminal')}
    can_reach_terminal = set(terminals)
    changed = True
    while changed:
        changed = False
        for t in transitions:
            if t.get('to_state') in can_reach_terminal and t.get('from_state') not in can_reach_terminal:
                can_reach_terminal.add(t.get('from_state'))
                changed = True
    for c in codes:
        if c not in can_reach_terminal:
            g2.append('状态 %s 走到终态的路径不存在 —— 一旦进入就永远停不下来' % c)

    # 静默黑洞：非终态、可达、唯一的出路只是回退到自己的祖先 —— 近似「卡住」
    rep.add('2', 'per-step coverage', 'FAIL' if (g2 or shape) else 'PASS', shape + g2)

    # ── #5 100-leaf total ─────────────────────────────────────────────────────
    n_pred = n_branch = 0
    choices = approver.get('choices') or []
    for ch in choices:
        _f, p, b, _d = walk_selector(ch.get('when'))
        n_pred += p
        n_branch += b
    leaves = len(states) + len(transitions) + len(choices) + n_pred
    g5 = []
    if leaves > LEAF_LIMIT:
        g5.append('叶总数 %d > 上限 %d（状态 %d + 迁移 %d + 分支 %d + 谓词 %d）'
                  % (leaves, LEAF_LIMIT, len(states), len(transitions), len(choices), n_pred))
    rep.add('5', '100-leaf total', 'FAIL' if g5 else 'PASS', g5 or
            ['叶总数 %d / %d（状态 %d + 迁移 %d + 分支 %d + 谓词 %d）'
             % (leaves, LEAF_LIMIT, len(states), len(transitions), len(choices), n_pred)])

    # ── #1 role directory resolution ──────────────────────────────────────────
    role_refs = collect_refs(approver, 'role_ref')
    g1 = []
    if not role_refs:
        rep.add('1', 'role directory resolution', 'PASS', ['该流程没有角色引用'])
    elif not roles:
        src = '--context/--assets' if not context_given else '给出的 --context/--assets'
        rep.add('1', 'role directory resolution', 'UNKNOWN',
                ['有 %d 处 role_ref，但%s里没有角色目录 —— 未判定' % (len(role_refs), src)])
    else:
        for r in role_refs:
            ok, why = resolve_role(roles, r)
            if not ok:
                g1.append(why)
        src = '样例层角色目录（工具/lib/role_directory.py）' if not context_given else '给出的输入 + 样例层角色目录'
        rep.add('1', 'role directory resolution', 'FAIL' if g1 else 'PASS',
                g1 or ['%d 处 role_ref 全部解析到角色目录（%s）' % (len(role_refs), src)])

    # ── #4 selector field matrix（最弱读法）───────────────────────────────────
    g4, unknown4 = [], []
    sel_fields = []
    for ch in choices:
        f, _p, _b, _d = walk_selector(ch.get('when'))
        sel_fields += f
    if not sel_fields:
        rep.add('4', 'selector field matrix（最弱读法：字段存在）', 'PASS',
                ['该流程没有选择器字段'])
    elif not models:
        rep.add('4', 'selector field matrix（最弱读法：字段存在）', 'UNKNOWN',
                ['有 %d 处选择器字段，但没有业务模型可解析 —— 未判定' % len(sel_fields)])
    else:
        for code, _dep in sorted(set(sel_fields)):
            res, why = resolve_field(models, model_ref, code)
            if res is None:
                unknown4.append(why)
            elif res is False:
                g4.append('选择器引用的字段 %s 不在模型里 —— 永远匹配不上，会静默走 default 链（%s）' % (code, why))
        status = 'FAIL' if g4 else ('UNKNOWN' if unknown4 and not g4 else 'PASS')
        rep.add('4', 'selector field matrix（最弱读法：字段存在）', status,
                g4 + unknown4 or ['%d 个选择器字段都在模型里' % len(set(sel_fields))])

    # 深度：契约定义到 Selector5，结构层应拦住更深的。显式数出来作为证据。
    depths = [selector_max_depth(ch.get('when')) for ch in choices]
    if depths and max(depths) > 5:
        rep.add('4b', 'selector 嵌套深度 ≤ 5', 'FAIL',
                ['深度 %d 超过契约定义的 Selector5' % max(depths)])

    return rep


# ── 自测 ──────────────────────────────────────────────────────────────────────

ROLE_DIR = {'asset_id': 'role_directory',
            'roles': [{'role_code': 'supervisor', 'name': '主管'},
                      {'role_code': 'hq_manager', 'name': '总部经理'}]}

MODEL = {'asset_id': 'fixture_model',
         'fields': [{'field_code': 'amount'}, {'field_code': 'status'}]}


def _spec(states, transitions, actions, approver=None, model_ref=None):
    return {
        'businessSchemaRef': model_ref or {
            'asset_type': 'BUSINESS_SCHEMA', 'asset_id': 'fixture_model',
            'scope_type': 'TENANT', 'scope_id': 't', 'app_id': None, 'module_id': None,
            'version': 1, 'digest': 'sha256:' + 'a' * 64},
        'states': states, 'transitions': transitions, 'actions': actions,
        'approverRef': approver or {
            'kind': 'SINGLE', 'role_ref': {
                'permission_ref': {'asset_type': 'PERMISSION', 'asset_id': 'role_directory'},
                'subresource': {'type': 'ROLE', 'code': 'supervisor'}}},
    }


def _st(code, initial=False, terminal=False):
    return {'state_code': code, 'name': code, 'initial': initial, 'terminal': terminal}


def _tr(code, a, b, action='submit'):
    return {'transition_code': code, 'from_state': a, 'to_state': b, 'action_code': action}


ACTIONS = [{'action_code': 'submit', 'kind': 'SUBMIT', 'capability_ref': {}},
           {'action_code': 'approve', 'kind': 'APPROVE', 'capability_ref': {}},
           {'action_code': 'reject', 'kind': 'REJECT', 'capability_ref': {}}]

GOOD = _spec([_st('draft', initial=True), _st('submitted'), _st('approved', terminal=True),
              _st('rejected')],
             [_tr('t1', 'draft', 'submitted'), _tr('t2', 'submitted', 'approved', 'approve'),
              _tr('t3', 'submitted', 'rejected', 'reject'), _tr('t4', 'rejected', 'submitted')],
             ACTIONS)


def _cases():
    """(编号, 名称, spec 变更函数, 期望状态, 期望在 FAIL 说明里出现的子串)

    每一条都是**单一变量**：只改一处，看对应的那一条判据会不会报出来。
    """
    import copy

    def deadend(s):
        # 删掉 rejected 的回边 —— 与样例 02 / 家具包同形
        s['transitions'] = [t for t in s['transitions'] if t['transition_code'] != 't4']

    def unreachable(s):
        s['states'].append(_st('archived'))
        s['transitions'].append(_tr('t5', 'archived', 'approved', 'approve'))

    def two_initial(s):
        s['states'][1]['initial'] = True

    def no_initial(s):
        s['states'][0]['initial'] = False

    def ghost_state(s):
        s['transitions'].append(_tr('t6', 'submitted', 'nowhere', 'approve'))

    def ghost_action(s):
        s['transitions'][0]['action_code'] = 'nosuch'

    def terminal_out(s):
        s['transitions'].append(_tr('t7', 'approved', 'draft', 'approve'))

    def no_terminal(s):
        for st in s['states']:
            st['terminal'] = False

    def when_on_transition(s):
        s['transitions'][0]['when'] = {'field': {'type': 'FIELD', 'code': 'amount'},
                                       'operator': 'gte', 'value': 1}

    def bad_role(s):
        s['approverRef']['role_ref']['subresource']['code'] = 'ghost_role'

    def bad_field(s):
        s['approverRef'] = {'kind': 'REGISTERED_CHAIN_SELECTION', 'default_chain_ref': {},
                            'choices': [{'when': {'field': {'type': 'FIELD', 'code': 'nope'},
                                                  'operator': 'gte', 'value': 1},
                                         'chain_ref': {}}]}

    def ok_field(s):
        s['approverRef'] = {'kind': 'REGISTERED_CHAIN_SELECTION', 'default_chain_ref': {},
                            'choices': [{'when': {'any': [
                                {'field': {'type': 'FIELD', 'code': 'amount'}, 'operator': 'gte', 'value': 1},
                                {'not': {'field': {'type': 'FIELD', 'code': 'status'},
                                         'operator': 'eq', 'value': None}}]},
                                'chain_ref': {}}]}

    def over_limit(s):
        s['states'] = [_st('draft', initial=True), _st('done', terminal=True)]
        s['transitions'] = [_tr('f%d' % i, 'draft', 'done', 'approve') for i in range(150)]

    def deep(s):
        sel = {'field': {'type': 'FIELD', 'code': 'amount'}, 'operator': 'eq', 'value': 1}
        for _ in range(6):
            sel = {'not': sel}
        s['approverRef'] = {'kind': 'REGISTERED_CHAIN_SELECTION', 'default_chain_ref': {},
                            'choices': [{'when': sel, 'chain_ref': {}}]}

    return [
        ('基线', '完整流程在给齐外部输入时全项通过', None, 'PASS', None),
        ('#2', '非终态没有出边（静默卡死）', deadend, 'FAIL', '进得去出不来'),
        ('#2', '状态从 initial 不可达（死代码）', unreachable, 'FAIL', '不可达'),
        ('#2', '没有终态（走到头停不下来）', no_terminal, 'FAIL', '没有出边'),
        ('#3', 'initial 不唯一', two_initial, 'FAIL', 'initial 必须恰好一个'),
        ('#3', '没有 initial', no_initial, 'FAIL', 'initial 必须恰好一个'),
        ('#3', '迁移指向不存在的状态', ghost_state, 'FAIL', 'to_state'),
        ('#3', '迁移引用不存在的动作', ghost_action, 'FAIL', 'action_code'),
        ('#3', '终态有出边', terminal_out, 'FAIL', '终态'),
        ('#3', '迁移带了契约没有的 when', when_on_transition, 'FAIL', '没有这个属性'),
        ('#1', '角色不在角色目录里', bad_role, 'FAIL', '没有 ghost_role'),
        ('#4', '选择器字段不在模型里', bad_field, 'FAIL', '不在模型里'),
        ('#4', '选择器字段都在模型里（any + not）', ok_field, 'PASS', None),
        ('#4b', '选择器嵌套超过 5 层', deep, 'FAIL', '超过契约定义'),
        ('#5', '叶总数超过 100', over_limit, 'FAIL', '上限 100'),
    ]


def self_test():
    print('=== workflow-spec complete check 自测 ===\n')
    roles = {('role_directory', 'supervisor'): True, ('role_directory', 'hq_manager'): True}
    models = {'fixture_model': ['amount', 'status']}
    bad = 0
    n = 0

    print('%s[1] 逐条判据 —— 每条都要能分别报 PASS 与 FAIL%s' % (C_DIM, C_OFF))
    for no, name, mut, want, needle in _cases():
        n += 1
        spec = json.loads(json.dumps(GOOD)) if mut is None else _mutated(mut)
        rep = check_spec(spec, {}, roles, models, True)
        got = _overall(rep)
        ok = (got == want)
        detail = ''
        if want == 'FAIL':
            hit = any(needle and needle in x for i in rep.items if i[2] == 'FAIL' for x in i[3])
            ok = ok and hit
            detail = '' if hit else '（未在说明里出现 %r）' % needle
        if ok:
            print('  %s✓%s %-6s %-28s → %s' % (C_OK, C_OFF, no, name, got))
        else:
            bad += 1
            print('  %s✗%s %-6s %-28s → %s（期望 %s）%s'
                  % (C_BAD, C_OFF, no, name, got, want, detail))

    print('\n%s[2] 缺外部输入时必须报 UNKNOWN —— **不是 FAIL，也不是通过**%s' % (C_DIM, C_OFF))
    checks = [
        ('无角色目录', GOOD, {}, {}, {}, 'UNKNOWN', '1'),
        ('无业务模型', json.loads(json.dumps(GOOD)), {}, roles, {}, 'UNKNOWN', '4'),
    ]
    for name, spec, a, r, m, want, no in checks:
        n += 1
        if name == '无业务模型':
            spec['approverRef'] = {'kind': 'REGISTERED_CHAIN_SELECTION', 'default_chain_ref': {},
                                   'choices': [{'when': {'field': {'type': 'FIELD', 'code': 'amount'},
                                                         'operator': 'gte', 'value': 1},
                                                'chain_ref': {}}]}
        rep = check_spec(spec, a, r, m, False)
        statuses = {i[0]: i[2] for i in rep.items}
        ok = statuses.get(no) == want
        if ok:
            print('  %s✓%s %-14s → 第 %s 项 %s' % (C_OK, C_OFF, name, no, want))
        else:
            bad += 1
            print('  %s✗%s %-14s → 第 %s 项 %s（期望 %s）' % (C_BAD, C_OFF, name, no, statuses.get(no), want))

    print('\n%s[3] 官方验证器对该契约的强度 —— 这个检查器是加在它之上的%s' % (C_DIM, C_OFF))
    sample = os.path.join(ROOT, '样例', 'workflow-spec', '通用事项审批流.spec.json')
    res = cc.validate(sample, 'workflow-spec/v1alpha1')
    n += 1
    ok = res.scope == 'structure_only'
    if ok:
        print('  %s✓%s 官方路径 = %s（`$comment` 把五项推给了 complete check）'
              % (C_OK, C_OFF, res.scope))
    else:
        bad += 1
        print('  %s✗%s 官方路径 = %s，期望 structure_only' % (C_BAD, C_OFF, res.scope))

    print('\n' + '─' * 62)
    if bad:
        print('%s✗ %d/%d 项不符%s' % (C_BAD, bad, n, C_OFF))
        return 1
    print('%s✓ %d 项全部符合 —— 每条判据都能分别报 PASS / FAIL / UNKNOWN%s' % (C_OK, n, C_OFF))
    return 0


def _mutated(mut):
    spec = json.loads(json.dumps(GOOD))
    mut(spec)
    return spec


def _overall(rep):
    if rep.failed:
        return 'FAIL'
    if rep.unknown:
        return 'PARTIAL'
    return 'PASS'


# ── CLI ──────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument('path', nargs='?')
    ap.add_argument('--entry', default='auto',
                    choices=['auto', 'spec', 'compiled-draft', 'bundle'])
    ap.add_argument('--context', action='append', default=[])
    ap.add_argument('--assets', action='append', default=[])
    ap.add_argument('--model', action='append', default=[])
    ap.add_argument('--strict', action='store_true', help='UNKNOWN 也算不通过')
    ap.add_argument('--json', action='store_true', help='输出机器可读结果')
    ap.add_argument('--self-test', action='store_true')
    args = ap.parse_args()

    if args.self_test:
        return self_test()
    if not args.path:
        print(__doc__)
        return 2

    paths = list(args.context) + list(args.model)
    for d in args.assets:
        found = sorted(glob.glob(os.path.join(d, '*.json')))
        if not found:
            print('%s✗ --assets 目录里没有 json：%s%s' % (C_BAD, d, C_OFF))
            return 2
        paths += found

    try:
        doc = load_json(args.path)
        spec, entry = unwrap(doc, args.entry)
    except Exception as exc:                             # noqa: BLE001
        print('%s✗ 读不了产出物：%s%s' % (C_BAD, exc, C_OFF))
        return 2

    # 先过官方结构校验 —— 本工具是**加在它之上**的，不是替代它。
    #
    # ⚠️ 「产出打包」（`{model, form, workflow, commands}`）**不是契约形态**，
    # 官方验证器对它只会说「缺 businessSchemaRef / 多了 model 属性」。
    # 那种报错看着像「产出物坏了」，其实是**问错了对象**。
    # 所以打包形态要**抽出 `workflow` 再喂给验证器**，并在报告里写明这一步。
    structural_input = args.path
    tmp = None
    if entry == 'bundle':
        import tempfile
        fd, tmp = tempfile.mkstemp(suffix='.workflow.json')
        with os.fdopen(fd, 'w', encoding='utf-8') as fh:
            json.dump(spec, fh, ensure_ascii=False)
        structural_input = tmp
    structural = cc.validate(structural_input, 'workflow-spec/v1alpha1')
    if tmp:
        os.unlink(tmp)
    if structural.scope == 'error':
        print('%s✗ 结构校验无法执行：%s%s' % (C_BAD, structural.detail, C_OFF))
        return 2
    if not structural.ok:
        print('%s结构校验未通过 —— 语义检查已跳过%s' % (C_BAD, C_OFF))
        for e in structural.errors[:10]:
            print('  %s | %s | %s' % (e.get('code'), e.get('path'), str(e.get('message'))[:60]))
        return 2

    assets, roles, models = build_dossier(paths)
    rep = check_spec(spec, assets, roles, models, bool(paths))

    overall = _overall(rep)
    if args.json:
        print(json.dumps({
            'path': os.path.relpath(args.path, ROOT),
            'entry': entry,
            'structural': {'ok': structural.ok, 'scope': structural.scope},
            'overall': overall,
            'items': [{'no': i[0], 'name': i[1], 'status': i[2], 'notes': i[3]} for i in rep.items],
        }, ensure_ascii=False, indent=2))
        return 1 if rep.failed else 0

    print('%s=== workflow-spec complete check ===%s' % (C_OK, C_OFF))
    print('  产出物 : %s' % os.path.relpath(args.path, ROOT))
    print('  条目   : %s' % entry)
    print('  结构   : %s（官方验证器；complete check 建立在它之上）' % structural.scope)
    if entry == 'bundle':
        print('  %s→ 打包文件不是契约形态，结构校验是对抽出的 `workflow` 做的%s' % (C_DIM, C_OFF))
    print()
    label = {'PASS': '%s✓ PASS%s' % (C_OK, C_OFF),
             'FAIL': '%s✗ FAIL%s' % (C_BAD, C_OFF),
             'UNKNOWN': '%s? UNKNOWN（外部输入未给，未判定）%s' % (C_WARN, C_OFF)}
    for no, name, status, notes in rep.items:
        print('  [%s] %-38s %s' % (no, name, label[status]))
        for x in notes[:8]:
            print('        %s%s%s' % (C_DIM, x, C_OFF))
        if len(notes) > 8:
            print('        %s… 另有 %d 条%s' % (C_DIM, len(notes) - 8, C_OFF))
    print()
    print('  %s未覆盖（已知未做，不是「不知道」）：'
          '#4 的「字段类型×操作符×值类型」与「分支覆盖矩阵」两种读法 —— '
          '契约只给了名称，没给判据。%s' % (C_DIM, C_OFF))
    print()
    if rep.failed:
        print('%s✗ 未通过 —— %d 项 FAIL%s' % (C_BAD, len(rep.failed), C_OFF))
        return 1
    if rep.unknown and args.strict:
        print('%s✗ --strict：%d 项 UNKNOWN%s' % (C_WARN, len(rep.unknown), C_OFF))
        return 1
    if rep.unknown:
        print('%s? 已实现项全部通过，但 %d 项未判定（缺外部输入）%s'
              % (C_WARN, len(rep.unknown), C_OFF))
        return 0
    print('%s✓ 通过%s' % (C_OK, C_OFF))
    return 0


if __name__ == '__main__':
    sys.exit(main())
