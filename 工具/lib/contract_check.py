#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
调用**官方验证器**的统一入口 —— 一个地方定义「什么叫通过 MetaSchema 校验」。

## 为什么要有这个模块

「通过 MetaSchema 校验」的权威定义在 `tools/meta-schema/node/cli.mjs` 里，
不在任何一个检查脚本里。而本仓库已经有三个地方需要调用它
（`check_skill_output.py`、`check_blueprint.py`、将来的其它门禁）。
各写一份 subprocess 调用，迟早会漂移成**三套略有不同的判据** ——
这正是「改一处、不传播」的典型形态。

## 两种校验强度，必须分清

| 强度 | 依据 | 契约 |
|---|---|---|
| `complete` | `cli.mjs` 的 `CONTRACTS` 白名单：结构 + 语义 + 引用 | `business-schema/v1`、`view-schema/lce-safe-v1`、`app-spec/v1alpha1` |
| `structure_only` | `tools/meta-schema-full` 的全量 schema，只有结构 | 其余 10 份（含 `app-model-command`、`approval-attestation`） |
| `unsupported` | 两者都不认 | 其余 |

**`structure_only` 不是「通过」** —— 它是「结构这一层通过」。
调用方必须把 `scope` 一起呈现，不能只报一个 OK。
"""

import json
import os
import subprocess
from typing import Dict, List, NamedTuple, Optional

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CLI = os.path.join(ROOT, 'tools', 'meta-schema', 'node', 'cli.mjs')
FULL_CHECKER = os.path.join(ROOT, '工具', 'lib', 'full_bundle_check.mjs')

# cli.mjs 的 CONTRACTS 白名单 —— 只有这三个能走完整校验
SUPPORTED = ('business-schema/v1', 'view-schema/lce-safe-v1', 'app-spec/v1alpha1')

# 白名单之外、但 `tools/meta-schema-full` 有 schema 的契约。
# 值 = (schema 文件名前缀, 根定义名)。
#
# ⚠️ 根定义**不都叫 Spec**：`app-model-command` 是 `Command`，
# `approval-attestation` 是 `Record`。把「根定义不叫 Spec」当成「不可校验」
# 会凭空造出不存在的阻塞（这个错误本项目犯过一次）。
FULL_ONLY: Dict[str, tuple] = {
    'workflow-spec/v1alpha1': ('workflow-spec-v1alpha1', 'Spec'),
    'tool-spec/v1alpha1': ('tool-spec-v1alpha1', 'Spec'),
    'permission-spec/v1alpha1': ('permission-spec-v1alpha1', 'Spec'),
    'app-model-command/v1alpha1': ('app-model-command-v1alpha1', 'Command'),
    'approval-attestation/v1alpha1': ('approval-attestation-v1alpha1', 'Record'),
    'artifact-manifest/v1alpha1': ('artifact-manifest-v1alpha1', 'Record'),
    'evidence-bundle/v1alpha1': ('evidence-bundle-v1alpha1', 'Record'),
}

EXIT_OK, EXIT_INVALID, EXIT_FAILED = 0, 2, 1


class Result(NamedTuple):
    """一次校验的结果。`scope` 必须与 `ok` 一起呈现。"""
    ok: bool
    scope: str                  # complete | structure_only | unsupported | error
    errors: List[Dict]
    detail: str = ''

    @property
    def exit_code(self) -> int:
        if self.scope == 'error':
            return EXIT_FAILED
        return EXIT_OK if self.ok else EXIT_INVALID


def _run(args: List[str], payload: Optional[bytes]) -> tuple:
    r = subprocess.run(args, input=payload, capture_output=True, timeout=300)
    try:
        return r.returncode, json.loads(r.stdout.decode('utf-8'))
    except Exception:
        return r.returncode, {'_raw': (r.stdout + r.stderr).decode('utf-8', 'replace')[:400]}


def validate(path: str, contract: str, context: Optional[str] = None) -> Result:
    """按契约校验一份产出物。不打印任何东西。"""
    if not os.path.isfile(path):
        return Result(False, 'error', [], '产出物不存在：%s' % path)

    if contract in SUPPORTED:
        payload = open(path, 'rb').read()
        args = ['node', CLI, '--contract', contract, '--entry', 'spec',
                '--checks', 'structure']
        _, doc = _run(args, payload)
        v = doc.get('validation', {})
        if 'execution' in doc:
            return Result(False, 'error', [], str(doc['execution']))
        if not v.get('valid'):
            return Result(False, 'complete', v.get('errors', []))
        if not context:
            # 结构通过但没给 context：**这是结构级结论，不是完整校验**
            return Result(True, 'structure_only', [], '未提供 context，只跑了结构校验')
        args = ['node', CLI, '--contract', contract, '--entry', 'spec',
                '--checks', 'complete', '--context', context]
        _, doc = _run(args, payload)
        v = doc.get('validation', {})
        if 'execution' in doc:
            return Result(False, 'error', [], str(doc['execution']))
        return Result(bool(v.get('valid')), 'complete', v.get('errors', []))

    if contract in FULL_ONLY:
        contract_id, entry = FULL_ONLY[contract]
        if not os.path.isfile(FULL_CHECKER):
            return Result(False, 'error', [], '找不到全量结构校验器：%s' % FULL_CHECKER)
        _, doc = _run(['node', FULL_CHECKER, contract_id, path, entry], None)
        if 'error' in doc:
            return Result(False, 'error', [], str(doc['error']))
        v = doc.get('validation', {})
        return Result(bool(v.get('valid')), 'structure_only', v.get('errors', []))

    return Result(False, 'unsupported', [],
                  '验证器不支持契约 %r；完整校验支持 %s，仅结构校验支持 %s'
                  % (contract, '、'.join(SUPPORTED), '、'.join(sorted(FULL_ONLY))))


def scope_label(scope: str) -> str:
    return {
        'complete': '完整校验（结构 + 语义 + 引用）',
        'structure_only': '⚠️ 仅结构校验（语义与引用未查）',
        'unsupported': '✗ 无校验路径',
        'error': '✗ 执行失败',
    }.get(scope, scope)
