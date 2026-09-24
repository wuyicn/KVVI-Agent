#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
蓝图闭环（`0D-1`）的共用定义 —— 生成器与检查器共用**同一份**规则。

## 为什么必须共用

闭环里有几处「怎么算」是**契约没有规定**的，只能由本项目定义：

| 量 | 本项目的定义 | 为什么必须有 |
|---|---|---|
| `DraftGraph 摘要` | `c14n([{part, code, digest}…])`，按 `(part, code)` 排序 | 审批要绑定「被出示的那一份」。哪一份？没有摘要就绑定不了 |
| `影响报告.impacted_refs[].digest` | 对应产出物内容的 `c14n` 摘要 | 结构校验**明确不查**「摘要重算」（见 0a-full-r1 README 的「全部引用」行） |
| `预览` | 由 `view-schema` 的节点树**渲染**得到，逐字节可复现 | 「预览」如果是手写的，它就不是预览 |

这三条若在生成器和检查器里各写一份，就会漂移成两套规则 ——
**检查器会用另一套规则去查生成器的产出，然后报一堆假问题**。
所以定义只有一处：本文件。

## DraftGraph 摘要在哪一层

`app-model-command` 有 14 个命令，末尾两个是 `draft.compile` 与
`draft.submitForApproval` —— 闭环的收口动作。但契约里**没有**「编译产出的摘要」
这个字段（那是引擎运行时的产物）。本闭环用「资产清单的 c14n 摘要」充当它：
确定性、可重算、能被审批绑定。
"""

import json
import os
import subprocess
from typing import Dict, List, Optional, Tuple

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
C14N = os.path.join(
    ROOT, 'protocol', 'kvvi-json-c14n', 'v1', 'evidence-sets',
    'prd-v1.11', 'node', 'kvvi-json-c14n.mjs',
)

# §1363：可运行业务系统的全套定义 = 数据模型 / 表单 / 流程 / 看板 / 接口。
# 蓝图**必须**这五部分齐全，缺一部分就不是「整包建系统」。
REQUIRED_PARTS = ('数据模型', '表单', '流程', '看板', '接口')

BP_NAME = '蓝图.json'
DRAFT_COMPILE = 'draft.compile'
DRAFT_SUBMIT = 'draft.submitForApproval'
DRAFT_LIFECYCLE = {'draft.undoCommand', 'draft.redoCommand', DRAFT_COMPILE, DRAFT_SUBMIT}

# 命令 target_ref 里各 id 字段的含义 —— 决定「它必须先被谁创建」。
TARGET_ID_KINDS = {
    'app_id': 'app',
    'module_id': 'module',
    'business_object_id': 'business_object',
    'field_id': 'field',
    'view_id': 'view',
    'node_id': 'node',
    'parent_node_id': 'node',
    'workflow_id': 'workflow',
    'permission_id': 'permission',
}


def c14n_digest(obj) -> str:
    """内容经 `kvvi-json-c14n/v1` 规范化后的摘要 —— 与验证器用的是同一个工具。"""
    run = subprocess.run(
        ['node', C14N, '--profile', 'kvvi-json-c14n/v1'],
        input=json.dumps(obj), capture_output=True, text=True, timeout=60,
    )
    if run.returncode != 0:
        raise RuntimeError('规范化失败：%s' % run.stderr)
    return json.loads(run.stdout)['digest']


def draft_digest(entries: List[Dict]) -> str:
    """DraftGraph 的摘要：资产清单的规范化摘要，按 `(part, code)` 排序。

    **这是本项目定义的口径**，不是契约里的字段（见模块文档）。
    它的用途只有一个：让「审批」能绑定到一个确定的、可重算的值上。
    """
    canonical = sorted(
        ({'part': e['part'], 'code': e['code'], 'digest': e['digest']} for e in entries),
        key=lambda e: (e['part'], e['code']),
    )
    return c14n_digest(canonical)


def load_json(path: str):
    with open(path, encoding='utf-8') as fh:
        return json.load(fh)


def load_blueprint(bp_dir: str) -> Dict:
    path = os.path.join(bp_dir, BP_NAME)
    if not os.path.isfile(path):
        raise FileNotFoundError('蓝图缺少 %s' % BP_NAME)
    data = load_json(path)
    if data.get('blueprint_version') != 'kvvi-blueprint/v1':
        raise ValueError('%s 的 blueprint_version 必须是 kvvi-blueprint/v1' % BP_NAME)
    return data


def artifact_entries(bp_dir: str, blueprint: Dict) -> List[Dict]:
    """把蓝图声明的产出物解析成 `{part, code, digest, path, contract, context}`。"""
    out = []
    for item in blueprint.get('artifacts', []):
        path = resolve(bp_dir, item['path'])
        digest = c14n_digest(load_json(path))
        out.append({
            'part': item['part'], 'code': item['code'],
            'contract': item['contract'],
            'path': path, 'rel': item['path'],
            'context': resolve(bp_dir, item['context']) if item.get('context') else None,
            'via': item.get('via', []),
            'digest': digest,
        })
    return out


def resolve(bp_dir: str, rel: str) -> str:
    return os.path.normpath(os.path.join(bp_dir, rel))


def load_commands(bp_dir: str) -> List[Tuple[str, Dict]]:
    """按文件名排序读入 `命令/*.json`。顺序即执行顺序。"""
    cmd_dir = os.path.join(bp_dir, '命令')
    if not os.path.isdir(cmd_dir):
        return []
    out = []
    for name in sorted(os.listdir(cmd_dir)):
        if name.endswith('.json'):
            out.append((name, load_json(os.path.join(cmd_dir, name))))
    return out


def replay(commands: List[Tuple[str, Dict]], blueprint: Dict) -> Tuple[List[Dict], List[str]]:
    """**确定性地重放命令序列**，返回 (每一步的推导结果, 问题列表)。

    这一步是结构校验器**明确不做**的部分。0a-full-r1 的 README 在
    「Command/Tool」一行写着仍需完整 Linter 负责的是：

    > 幂等历史、**base_revision**、稳定节点/风险升级、组件属性和字段参数与实际登记关联

    本函数查其中的两项：**base_revision 连续**与**目标必须已被创建**（拓扑序）。

    ⚠️ 「哪个命令创建了哪个 id」写**在蓝图里**（`ids[id].created_by`），
    **不写在命令里** —— `Command` 是 `additionalProperties: false`，
    加一个 `creates` 字段会让它结构校验不过。产出物必须原样是契约，不能挂私货。
    """
    problems: List[str] = []
    steps: List[Dict] = []
    ids = blueprint.get('ids', {})
    seen_command_ids: Dict[str, str] = {}

    # command_id -> 它在序列里的下标
    position = {}
    for index, (_, cmd) in enumerate(commands):
        cid = cmd.get('command_id')
        if cid is not None and cid not in position:
            position[cid] = index

    for index, (name, cmd) in enumerate(commands):
        cid = cmd.get('command_id', '<缺 command_id>')
        created_here = [i for i, meta in ids.items() if meta.get('created_by') == cid]

        if cid in seen_command_ids:
            problems.append('%s：command_id %s 重复（%s 已用过）'
                            % (name, cid, seen_command_ids[cid]))
        seen_command_ids[cid] = name

        if cmd.get('draft_id') != blueprint.get('draft', {}).get('draft_id'):
            problems.append('%s：draft_id 与蓝图不符（跨草稿的命令不能混在一条序列里）' % name)

        if cmd.get('base_revision') != index:
            problems.append('%s：base_revision=%r，但它是第 %d 条 —— '
                            '乐观并发要求每条命令作用于紧接着的下一版'
                            % (name, cmd.get('base_revision'), index))

        # 目标必须已经存在：app 由蓝图给出，其余必须由**更早**的命令创建
        for key, value in (cmd.get('target_ref') or {}).items():
            if value is None:
                # `view.addNode` 的 `parent_node_id: null` = 建根节点，
                # 没有「先创建父节点」这一说。
                continue
            if key == 'app_id':
                if value != blueprint.get('app', {}).get('app_id'):
                    problems.append('%s：target app_id 不是蓝图里的应用' % name)
                continue
            meta = ids.get(value)
            if meta is None:
                problems.append('%s：target %s=%s 不在蓝图的 id 表里' % (name, key, value))
                continue
            expected_kind = TARGET_ID_KINDS.get(key)
            if expected_kind and meta.get('kind') != expected_kind:
                problems.append('%s：target %s 期望 kind=%s，蓝图声明的是 %s'
                                % (name, key, expected_kind, meta.get('kind')))
            creator = meta.get('created_by')
            if creator == 'blueprint':
                # 蓝图自带的外壳（视图/流程/权限）在草稿里已存在，
                # 命令只做增量 —— 它们从第 0 步起就可见。检查器会把这批计数报出。
                continue
            creator_index = position.get(creator)
            if creator_index is None:
                problems.append('%s：target %s 的创建者 %r 不在命令序列里'
                                % (name, key, creator))
            elif creator_index >= index:
                problems.append('%s：target %s 由第 %d 条命令创建，'
                                '但它在这一条（第 %d 条）之后 —— 拓扑序不成立'
                                % (name, key, creator_index, index))

        steps.append({'index': index, 'file': name, 'command_id': cid,
                      'type': cmd.get('type'), 'creates': created_here})

    return steps, problems


def declared_ids(blueprint: Dict) -> Dict[str, Dict]:
    """蓝图声明的 id 表：`id -> {kind, logical, created_by}`。"""
    return blueprint.get('ids', {})


def render_preview(spec: Dict) -> str:
    """把 `view-schema` 的节点树渲染成预览 —— **逐字节可复现**。

    ⚠️ 这是**结构级预览**，不是运行时渲染（那属于 `0C-2` 页面运行时）。
    它证明的是「产出物能被推导成一个人能看的东西」，不是「页面能跑」。

    刻意**不含时间戳、随机数、路径** —— 否则检查器无法用「重算一遍是否相同」
    来证明预览是推导出来的，而不是手写的。
    """
    root = spec['componentsTree'][0]
    queries = {q['query_code']: q['query'].get('queryRef', {}).get('capability_code', '')
               for q in spec.get('queries', [])}
    lines = [
        '<!doctype html>',
        '<html lang="zh-CN">',
        '<head>',
        '<meta charset="utf-8">',
        '<title>%s（结构级预览）</title>' % escape(spec['name']),
        '</head>',
        '<body>',
        '<h1>%s</h1>' % escape(spec['name']),
        '<p class="view-type">view_code=%s · view_type=%s</p>' % (
            escape(spec['view_code']), escape(spec['view_type'])),
        '<ol class="nodes">',
    ]

    def walk(node, depth):
        bound = (node.get('props') or {}).get('data') or {}
        bind = ''
        if bound.get('queryCode'):
            bind = ' data-query-code="%s" data-caliber="%s"' % (
                escape(bound['queryCode']), escape(queries.get(bound['queryCode'], '')))
        lines.append(
            '<li data-node-id="%s" data-component="%s" data-depth="%d"%s>%s%s</li>'
            % (escape(node['id']), escape(node['componentName']), depth,
               bind, '&nbsp;' * (depth * 4), escape(node['componentName'])))
        for child in node.get('children', []) or []:
            walk(child, depth + 1)

    walk(root, 0)
    lines += ['</ol>', '</body>', '</html>', '']
    return '\n'.join(lines)


def escape(text) -> str:
    return (str(text).replace('&', '&amp;').replace('<', '&lt;')
            .replace('>', '&gt;').replace('"', '&quot;'))


def preview_path(bp_dir: str, view_code: str) -> str:
    return os.path.join(bp_dir, '预览', '%s.html' % view_code)
