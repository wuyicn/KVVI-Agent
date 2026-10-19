#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""阶段九 G7：系统运行闭环。

判据：**一个新系统可从自然语言需求走到发布，并由员工打开和提交第一条真实记录。**

四类证据各自回答判据的一半，缺一不可：

| 证据类 | 回答的是 | 不成立会怎样 |
|---|---|---|
| ``contracts`` | 六份契约齐不齐、缺哪一份能不能说出来 | 「不能运行」是一句没有出路的报错 |
| ``runtime_api`` | 员工能不能只看本公司、只看自己看得到的字段 | 接口一开就是全公司数据的出口 |
| ``client_ui`` | 契约里的组件名会不会被当成代码执行 | 契约写一个远端脚本名就能加载远端脚本 |
| ``end_to_end`` | 一个**新建**系统从发布到第一条记录是否真的跑通 | 前面的检查全绿，而产品闭环是断的 |

默认模式既重跑四类判据，也要求验收证据包已追加阶段九；证据生成器使用
``--run-only`` 先运行判据，避免检查器与证据生成互相递归。
"""

import hashlib
import json
import shlex
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent.parent
PLATFORM = ROOT / 'services' / 'platform'
MANIFEST = ROOT / '交付' / '证据' / '验收证据包.json'
CONTAINER = f'kvvi-stage9-pg-{os.getpid()}'

# 每个证据类：其判据、跑的测试、以及跑完要看到的**通过条数下限**。
# 下限写死是有意的 —— 只断言「exit 0」时，一个把测试删光的提交也会通过。
CHECKS = {
    'contracts': {
        'files': ['contracts.test.mjs', 'runtime-projection.test.mjs'],
        'minimum': 12,
        'claim': '六份契约齐备才可运行；缺哪一份报得出来；跨契约绑定逐条校验',
    },
    'runtime_api': {
        'files': ['api-router.test.mjs', 'system-api.test.mjs'],
        'minimum': 12,
        'claim': '鉴权只认会话里的身份；只读员工改不动记录；陈旧版本不覆盖新记录',
    },
    'client_ui': {
        'files': ['runtime-ui.spec.tsx', 'record-views.spec.tsx', 'system-shell.spec.tsx'],
        'minimum': 30,
        'claim': '闭合组件表：表外的组件名一律阻断；HIDDEN 不渲染也不提交',
        'package': '@deepseek-ai/dsh-client-kvvi-panel',
    },
    'end_to_end': {
        'files': ['publish-runtime-e2e.test.mjs'],
        'minimum': 7,
        'claim': '新建系统 → 发布 → 员工拿投影 → 提交第一条记录 → 从列表读回',
    },
}

# 已知缺口：写进证据，不写成「已实现」。
GAPS = [
    '发布视图里的 `Table`（`DataBindingRef` → `queryCode`）**跑不起来**：'
    '平台没有查询端点，客户端明确阻断为 `KVVI_TABLE_QUERY_UNSUPPORTED` 而不是画一张空表。'
    '面板的「记录」半页是当前可用的替代（数据来自 `/records`）',
    '**生产组件注册表仍是黄金样例夹具**（N11）：仓库里只有 `样例/黄金样例/*/context.json`，'
    '客户端那张闭合表是与它手工对齐的，不是从注册表资产加载的',
    '**流程动作按钮未做**：投影带得到 workflow 状态与迁移，详情页也显示了当前状态的中文名，'
    '但没有「提交/通过/驳回」按钮 —— 平台没有迁移端点，放一个按不动的按钮比不放更坏',
    '员工端**只有 DSH 会话界面里的面板**，没有独立的移动端或大屏入口',
    '「自然语言需求 → 契约」这一段由搭建引擎模式（阶段八 preset）承担，'
    'G7 验的是**从契约到第一条记录**的后半段；前半段的自动化程度见阶段八取证',
]


def run(cmd, cwd=ROOT, env=None, timeout=1800):
    return subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True,
                          timeout=timeout)


def print_result(label, cmd, result):
    print(f'[{label}] $ {" ".join(str(x) for x in cmd)}')
    body = result.stdout + result.stderr
    print(body.rstrip())
    print(f'[{label}] exit={result.returncode}')
    return body


def start_db():
    """起一个临时 PostgreSQL，端口由内核分配 —— 固定端口会和别的检查器打架。"""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(('127.0.0.1', 0))
        port = probe.getsockname()[1]
    result = run([
        'docker', 'run', '-d', '--name', CONTAINER,
        '-e', 'POSTGRES_PASSWORD=kvvi-test', '-e', 'POSTGRES_USER=kvvi',
        '-p', f'127.0.0.1:{port}:5432', 'postgres:17-alpine',
    ], timeout=120)
    if result.returncode != 0:
        raise RuntimeError((result.stderr or result.stdout).strip())
    for _ in range(60):
        if run(['docker', 'exec', CONTAINER, 'pg_isready', '-U', 'kvvi']).returncode == 0:
            return port
        time.sleep(0.5)
    raise RuntimeError('PostgreSQL did not become ready')


def dsn_env(port):
    return {
        'KVVI_ADMIN_DSN': f'postgres://kvvi:kvvi-test@127.0.0.1:{port}/postgres',
        'KVVI_PLATFORM_DSN': f'postgres://kvvi_platform:kvvi-test@127.0.0.1:{port}/kvvi_platform',
        'KVVI_BUSINESS_DSN': f'postgres://kvvi_business:kvvi-test@127.0.0.1:{port}/kvvi_business',
        'KVVI_AUDIT_DSN': f'postgres://kvvi_audit_writer:kvvi-test@127.0.0.1:{port}/kvvi_audit',
        'KVVI_AUDITREAD_DSN': f'postgres://kvvi_audit_reader:kvvi-test@127.0.0.1:{port}/kvvi_audit',
    }


def dsh_source_link():
    """Worktree 中 vendor 被忽略时，临时链接主工作区的上游 git 对象。"""
    target = ROOT / 'vendor' / 'dsh'
    if target.exists():
        return None
    common = run(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'])
    if common.returncode != 0:
        raise RuntimeError('cannot locate git common directory for DSH source')
    source = Path(common.stdout.strip()).parent / 'vendor' / 'dsh'
    if not source.is_dir():
        raise RuntimeError(f'DSH source is unavailable: {source}')
    target.parent.mkdir(exist_ok=True)
    target.symlink_to(source, target_is_directory=True)
    return target


def remove_link(link):
    if link is None:
        return
    link.unlink(missing_ok=True)
    try:
        link.parent.rmdir()
    except OSError:
        pass


def node_suite(label, files, env, minimum):
    """
    跑一组 node:test 文件。

    ⚠️ 除了 ``exit 0``，还要求**实际通过的条数不少于 ``minimum``**：
    只判退出码时，一个把测试删掉的提交同样绿 —— 而绿得毫无意义。
    ``skipped`` 一律算失败：跳过的用例等于没验。
    """
    cmd = ['node', '--test', '--test-concurrency=1'] + [f'tests/{name}' for name in files]
    result = run(cmd, cwd=PLATFORM, env=env)
    body = print_result(label, cmd, result)
    if result.returncode != 0:
        raise RuntimeError(f'{label} 退出码非 0')
    passed = re.search(r'\bpass (\d+)', body)
    if passed is None or int(passed.group(1)) < minimum:
        raise RuntimeError(f'{label} 通过条数不足：需 ≥{minimum}，实为 '
                           f'{passed.group(1) if passed else "无"}')
    if not re.search(r'\bfail 0', body):
        raise RuntimeError(f'{label} 有失败用例')
    if re.search(r'\bskipped [1-9]\d*', body):
        raise RuntimeError(f'{label} 有跳过用例')


def client_suite(label, files, minimum):
    """跑客户端渲染器那一组（vitest，不需要数据库）。"""
    fork = ROOT / 'vendor' / 'dsh'
    args = ['npx', 'vitest', 'run', *[f'packages/client/kvvi-panel/tests/{f}' for f in files]]
    cmd = ['pnpm', 'exec', *args]
    result = run(cmd, cwd=fork, timeout=1800)
    body = print_result(label, cmd, result)
    if result.returncode != 0:
        raise RuntimeError(f'{label} 退出码非 0')
    passed = re.search(r'Tests\s+(\d+) passed', body)
    if passed is None or int(passed.group(1)) < minimum:
        raise RuntimeError(f'{label} 通过条数不足：需 ≥{minimum}，实为 '
                           f'{passed.group(1) if passed else "无"}')
    if re.search(r'\d+ failed', body):
        raise RuntimeError(f'{label} 有失败用例')
    if re.search(r'\d+ skipped', body):
        raise RuntimeError(f'{label} 有跳过用例')


def require_stage9_evidence():
    if not MANIFEST.is_file():
        raise RuntimeError('G7_EVIDENCE_MISSING: 验收证据包不存在')
    payload = json.loads(MANIFEST.read_text(encoding='utf-8'))
    entries = [e for e in payload.get('entries', []) if e.get('stage') == '阶段九']
    if len(entries) != 1:
        raise RuntimeError('G7_EVIDENCE_MISSING: 验收证据包尚未追加阶段九')
    entry = entries[0]
    if not entry.get('ok') or entry.get('exitCode') != 0:
        raise RuntimeError('G7_EVIDENCE_FAILED: 阶段九证据不是成功记录')
    try:
        command = entry.get('command')
        arguments = shlex.split(command) if isinstance(command, str) else []
    except ValueError:
        arguments = []
    if arguments != ['python3', '工具/check_stage9.py', '--run-only']:
        raise RuntimeError('G7_EVIDENCE_COMMAND_INVALID')
    evidence = ROOT / entry.get('evidence', '')
    if not evidence.is_file():
        raise RuntimeError('G7_EVIDENCE_FILE_MISSING')
    body = evidence.read_text(encoding='utf-8').split('\n\n', 1)[-1]
    digest = 'sha256:' + hashlib.sha256(body.encode('utf-8')).hexdigest()
    if digest != entry.get('digest'):
        raise RuntimeError('G7_EVIDENCE_DIGEST_MISMATCH')
    if set(entry.get('evidenceClasses', [])) != set(CHECKS):
        raise RuntimeError('G7_EVIDENCE_CLASSES_INCOMPLETE')


def run_gate():
    env = dict(os.environ)
    env.update({'KVVI_DEV_KEYS': '1',
                'KVVI_SIGNING_KEY_PATH': '/tmp/kvvi-stage9-signing.key'})
    link = None
    try:
        port = start_db()
        env.update(dsn_env(port))
        for label in ('contracts', 'runtime_api', 'end_to_end'):
            spec = CHECKS[label]
            node_suite(label, spec['files'], env, spec['minimum'])

        link = dsh_source_link()
        spec = CHECKS['client_ui']
        client_suite('client_ui', spec['files'], spec['minimum'])
    finally:
        run(['docker', 'rm', '-f', CONTAINER], timeout=60)
        remove_link(link)


def main():
    run_only = '--run-only' in sys.argv
    if not run_only:
        try:
            require_stage9_evidence()
        except Exception as error:
            print(f'✗ {error}')
            return 1
    try:
        run_gate()
    except Exception as error:
        print(f'✗ G7 未通过：{error}')
        return 1

    print()
    print('✓ G7 通过：一个新系统可从契约走到发布，并由员工打开、提交并读回第一条真实记录')
    for label, spec in CHECKS.items():
        print(f'  · {label:12s} — {spec["claim"]}')
    print()
    print('已知缺口（未实现 / 已移出首版 / 已知残留）：')
    for gap in GAPS:
        print(f'  ! {gap}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
