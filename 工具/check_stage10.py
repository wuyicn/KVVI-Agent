#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""阶段十 G8：员工与管理闭环。

判据：**同一账号、同一动作、同一数据范围下，UI 与 Agent 的允许/拒绝与结果一致。**

四类证据各自回答判据的一半，缺一不可：

| 证据类 | 回答的是 | 不成立会怎样 |
|---|---|---|
| ``admin_api`` | 所有者能不能真的管人、管角色、管权限 | 「有管理界面」而管理动作落不了库 |
| ``admin_ui`` | 界面会不会替服务端说话 | 先显示成功再回滚，用户以为改动生效过 |
| ``worker_tools`` | Agent 拿的是谁的身份证 | 模型参数里的 tenant 被当成租户 |
| ``differential`` | 两条通道给的是不是同一个判定 | 「Agent 走同一个执行点」变成一句不可判定的话 |

另有两项**跨进程**检查，它们不放在任何一端的测试里：

1. **签名字节一致** —— 工具签的运行时会话上下文交给**平台自己的**验签函数。
   两侧各有一份实现，只有跨进程比对才看得见漂移。
2. **预置构成** —— `kvvi-worker` 里必须**有**业务工具、**没有**搭建工具。
   「两个网关分离」是产品红线，而它是靠这份构成落地的。

该检查器**不在 fork 的测试里**做这两件事，因为 fork 是独立交付物：
一个 import 平台源码的测试只在 KVVI-Agent 工作树里能过，交付出去就是坏的。
"""

import hashlib
import json
import shlex
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent.parent
PLATFORM = ROOT / 'services' / 'platform'
FORK = ROOT / 'vendor' / 'dsh'
MANIFEST = ROOT / '交付' / '证据' / '验收证据包.json'
CONTAINER = f'kvvi-stage10-pg-{os.getpid()}'
FRESH_FORK = Path('/tmp/kvvi-stage10-fork')

# 每个证据类：其判据、跑的测试、以及跑完要看到的**通过条数下限**。
# 下限写死是有意的 —— 只断言「exit 0」时，一个把测试删光的提交也会通过。
CHECKS = {
    'admin_api': {
        'files': ['admin-api.test.mjs', 'admin.test.mjs', 'permissions.test.mjs',
                  'lifecycle.test.mjs'],
        'minimum': 40,
        'claim': '所有者/被委托者/员工三层各自的能力边界；建账号原子性；停用立刻结束全部会话',
    },
    'differential': {
        'files': ['ui-agent-e2e.test.mjs', 'api-router.test.mjs'],
        'minimum': 18,
        'claim': '七个向量的 UI/Agent 判定等价；签名上下文可作凭据而身份以会话行为准',
    },
}

CLIENT_CHECKS = {
    'admin_ui': {
        'files': ['admin-ui.spec.tsx'],
        'minimum': 21,
        'claim': '员工看不到管理内容但接口各自判定；被拒显示服务端的码；停用是两步；数据范围是多选',
    },
}

TOOL_CHECKS = {
    'worker_tools': {
        'files': ['tools.spec.ts'],
        'minimum': 15,
        'claim': '身份只来自模式路由；身份字段在执行前递归拦下；平台拒绝码原样上报',
    },
}

# 已知缺口：写进证据，不写成「已实现」。
GAPS = [
    '**委托范围只有一种粒度**：本仓库里的委托机制就是平台保留角色 `admin`，'
    '没有「只管某个部门」这种更细的委托 —— 策略模型里没有承载它的字段，'
    '凭空加一层会让「谁管谁」出现第二份判据',
    '**`aggregate_read` 未注册**：平台没有聚合端点，§9.8.1 还要求'
    '「看得见汇总的人必须看得见每一条构成」，注册一个永远失败的工具有害无益',
    '**READONLY 字段的写入路径尚未逐字段拒绝**：当前执法点是字段可见性'
    '（读时给只读标记）。G8 证的是两条通道给**同样的可写性判定**，'
    '不是「写入被拒」',
    '**员工端没有独立的待办视图**：待办口径仍需要平台侧一个聚合端点',
    '**所有者管理界面没有分页**：成员与角色列表一次全取，'
    '上百人的公司会慢；当前规模下可用',
    '**流程动作按钮在详情页还没渲染**：端点已就位（阶段十补），'
    'Worker Agent 也已经能用（`workflow_available_actions` / `workflow_act`），'
    '但界面上还不能点',
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
    if FORK.exists():
        return None
    common = run(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'])
    if common.returncode != 0:
        raise RuntimeError('cannot locate git common directory for DSH source')
    source = Path(common.stdout.strip()).parent / 'vendor' / 'dsh'
    if not source.is_dir():
        raise RuntimeError(f'DSH source is unavailable: {source}')
    FORK.parent.mkdir(exist_ok=True)
    FORK.symlink_to(source, target_is_directory=True)
    return FORK


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


def vitest_suite(label, target, minimum, cwd=None):
    """跑一组 vitest 文件（客户端渲染器 / 工具包）。"""
    cmd = ['pnpm', 'exec', 'npx', 'vitest', 'run', target]
    result = run(cmd, cwd=cwd or FORK, timeout=1800)
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


def check_signed_context(fork: Path) -> None:
    """
    跨进程验签：**工具签的头，交给平台自己的验签函数**。

    两侧各有一份实现（平台的 `runtime-auth.mjs`、工具包的 `client.ts`），
    只有跨进程比对才看得见漂移 —— 漂移的表现是工具 401，
    而 401 看起来像「平台没配好」。
    """
    platform_module = (PLATFORM / 'src' / 'runtime-auth.mjs').as_uri()
    tool_expression = (
        "import {contextHeaders as h} from './packages/tool/kvvi-business/src/client.ts';"
        "const MODE={sessionId:'11111111-1111-4111-8111-111111111111',"
        "userId:'22222222-2222-4222-8222-222222222222',"
        "companyId:'33333333-3333-4333-8333-333333333333',gateway:'USER'};"
        "console.log(JSON.stringify(h(MODE,'stage10-cross',1700000000000)))"
    )
    signed = run(['pnpm', 'exec', 'tsx', '--eval', tool_expression], cwd=fork)
    if signed.returncode != 0:
        raise RuntimeError(f'工具包没能签出上下文：{signed.stderr.strip()[:200]}')
    headers = signed.stdout.strip().splitlines()[-1]

    verify_expression = (
        f"import {{verifyRuntimeContextHeaders as v}} from '{platform_module}';"
        f"const h=JSON.parse(process.env.KVVI_HEADERS);"
        f"const out=v(h,'stage10-cross',1700000000000);"
        f"if(out.sessionId!=='11111111-1111-4111-8111-111111111111')throw new Error('SID');"
        f"if(out.companyId!=='33333333-3333-4333-8333-333333333333')throw new Error('CID');"
        f"console.log('tool-signed headers verified by the platform')"
    )
    env = dict(os.environ)
    env['KVVI_HEADERS'] = headers
    verified = run(['node', '--input-type=module', '--eval', verify_expression], env=env)
    print_result('signed_context', ['node', '--eval', '<verify tool-signed headers>'], verified)
    if verified.returncode != 0:
        raise RuntimeError('工具签出的上下文被平台拒绝 —— 两侧的签名格式漂移了')

    # 反向：改一个字节就不该验得过。只验「能过」的检查，验不出「谁都过」。
    tampered = json.loads(headers)
    tampered['x-kvvi-company'] = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
    env['KVVI_HEADERS'] = json.dumps(tampered)
    refused = run(['node', '--input-type=module', '--eval', verify_expression], env=env)
    if refused.returncode == 0:
        raise RuntimeError('改过的上下文仍然验得过 —— 验签形同虚设')
    print('signed_context: tampered header refused as expected')


def check_worker_composition(fork: Path) -> None:
    """
    预置构成：**有**业务工具、**没有**搭建设施。

    这是「两个网关分离」这条产品红线的落地处。工具集是冻结常量与预置行的
    交集，所以只看预置文件不够 —— 还要看它真的挂着那个包。
    """
    preset = fork / 'packages/preset/agent-presets/presets/kvvi-worker/agent.cordis.yml'
    text = preset.read_text(encoding='utf-8')
    must_have = ['tool-kvvi-business', '@deepseek-ai/dsh-tool-kvvi-business']
    must_not_have = ['dsh-bash', 'dsh-fs', 'tool-skill', 'dsh-workflow',
                     'tool-subagent', 'dsh-web']
    for needle in must_have:
        if needle not in text:
            raise RuntimeError(f'kvvi-worker 预置里没有 {needle}')
    for needle in must_not_have:
        if needle in text:
            raise RuntimeError(f'kvvi-worker 预置里出现了搭建设施 {needle}')
    print(f'worker_composition: {len(must_have)} 项在场、{len(must_not_have)} 项不在场')


def require_stage10_evidence():
    if not MANIFEST.is_file():
        raise RuntimeError('G8_EVIDENCE_MISSING: 验收证据包不存在')
    payload = json.loads(MANIFEST.read_text(encoding='utf-8'))
    entries = [e for e in payload.get('entries', []) if e.get('stage') == '阶段十']
    if len(entries) != 1:
        raise RuntimeError('G8_EVIDENCE_MISSING: 验收证据包尚未追加阶段十')
    entry = entries[0]
    if not entry.get('ok') or entry.get('exitCode') != 0:
        raise RuntimeError('G8_EVIDENCE_FAILED: 阶段十证据不是成功记录')
    try:
        command = entry.get('command')
        arguments = shlex.split(command) if isinstance(command, str) else []
    except ValueError:
        arguments = []
    if arguments != ['python3', '工具/check_stage10.py', '--run-only']:
        raise RuntimeError('G8_EVIDENCE_COMMAND_INVALID')
    evidence = ROOT / entry.get('evidence', '')
    if not evidence.is_file():
        raise RuntimeError('G8_EVIDENCE_FILE_MISSING')
    body = evidence.read_text(encoding='utf-8').split('\n\n', 1)[-1]
    digest = 'sha256:' + hashlib.sha256(body.encode('utf-8')).hexdigest()
    if digest != entry.get('digest'):
        raise RuntimeError('G8_EVIDENCE_DIGEST_MISMATCH')
    expected = set(CHECKS) | set(CLIENT_CHECKS) | set(TOOL_CHECKS) | {
        'signed_context', 'worker_composition'}
    if set(entry.get('evidenceClasses', [])) != expected:
        raise RuntimeError('G8_EVIDENCE_CLASSES_INCOMPLETE')


def run_gate():
    env = dict(os.environ)
    env.update({'KVVI_DEV_KEYS': '1',
                'KVVI_SIGNING_KEY_PATH': '/tmp/kvvi-stage10-signing.key'})
    link = None
    try:
        port = start_db()
        env.update(dsn_env(port))
        for label, spec in CHECKS.items():
            node_suite(label, spec['files'], env, spec['minimum'])

        link = dsh_source_link()
        for label, spec in CLIENT_CHECKS.items():
            vitest_suite(label, f'packages/client/kvvi-panel/tests/{spec["files"][0]}',
                         spec['minimum'])
        for label, spec in TOOL_CHECKS.items():
            vitest_suite(label, f'packages/tool/kvvi-business/tests/{spec["files"][0]}',
                         spec['minimum'])

        # ⚠️ 下面两项必须在**从 fork.py 重建出来的干净副本**上跑：
        #    源码树里的 node_modules 可能让一个「其实解析不到」的预置行看起来是好的。
        rebuild = run(['python3', '工具/fork.py', '--rebuild', '--into', str(FRESH_FORK)])
        print_result('fork/rebuild', rebuild.args, rebuild)
        if rebuild.returncode != 0:
            raise RuntimeError('DSH fork rebuild failed')
        install = run(['pnpm', 'install', '--frozen-lockfile', '--offline'], cwd=FRESH_FORK)
        print_result('fork/install', install.args, install)
        if install.returncode != 0:
            raise RuntimeError('DSH dependency install failed')

        check_worker_composition(FRESH_FORK)
        check_signed_context(FRESH_FORK)
    finally:
        run(['docker', 'rm', '-f', CONTAINER], timeout=60)
        remove_link(link)


def main():
    if '--run-only' not in sys.argv:
        try:
            require_stage10_evidence()
        except Exception as error:
            print(f'✗ {error}')
            return 1
    try:
        run_gate()
    except Exception as error:
        print(f'✗ G8 未通过：{error}')
        return 1

    print()
    print('✓ G8 通过：同一账号、同一动作、同一数据范围下，UI 与 Agent 的判定与结果一致')
    for scope in (CHECKS, CLIENT_CHECKS, TOOL_CHECKS):
        for label, spec in scope.items():
            print(f'  · {label:18s} — {spec["claim"]}')
    print('  · signed_context      — 工具签的上下文能被平台自己的验签函数接受（改一个字节即拒）')
    print('  · worker_composition — kvvi-worker 有业务工具、没有任何搭建设施')
    print()
    print('已知缺口（未实现 / 已移出首版 / 已知残留）：')
    for gap in GAPS:
        print(f'  ! {gap}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
