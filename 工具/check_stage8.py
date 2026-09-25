#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""阶段八 G6：身份入口与运行时模式闭环。

默认模式既重跑四类判据，也要求验收证据包已追加阶段八；证据生成器使用
``--run-only`` 先运行判据，避免检查器与证据生成互相递归。
"""

import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent.parent
PLATFORM = ROOT / 'services' / 'platform'
MANIFEST = ROOT / '交付' / '证据' / '验收证据包.json'
CONTAINER = 'kvvi-stage8-pg'

CHECKS = {
    'role_policy': ['mode-policy.test.mjs'],
    'login_api': ['auth.test.mjs', 'login-gate.test.mjs', 'gateway.test.mjs'],
    'runtime_preset': ['runtime-routing.test.mjs', 'mode-router.spec.ts'],
    'topology': ['check_topology.py'],
}


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
    for name in (CONTAINER, 'kvvi-stage4-pg', 'kvvi-stage5-pg', 'kvvi-stage6-pg'):
        run(['docker', 'rm', '-f', name], timeout=60)
    result = run([
        'docker', 'run', '-d', '--name', CONTAINER,
        '-e', 'POSTGRES_PASSWORD=kvvi-test', '-e', 'POSTGRES_USER=kvvi',
        '-p', '127.0.0.1:55432:5432', 'postgres:17-alpine',
    ], timeout=120)
    if result.returncode != 0:
        raise RuntimeError((result.stderr or result.stdout).strip())
    for _ in range(60):
        if run(['docker', 'exec', CONTAINER, 'pg_isready', '-U', 'kvvi']).returncode == 0:
            return
        time.sleep(0.5)
    raise RuntimeError('PostgreSQL did not become ready')


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


def require_stage8_evidence():
    if not MANIFEST.is_file():
        raise RuntimeError('G6_EVIDENCE_MISSING: 验收证据包不存在')
    payload = json.loads(MANIFEST.read_text(encoding='utf-8'))
    entries = [e for e in payload.get('entries', []) if e.get('stage') == '阶段八']
    if len(entries) != 1:
        raise RuntimeError('G6_EVIDENCE_MISSING: 验收证据包尚未追加阶段八')
    entry = entries[0]
    if not entry.get('ok') or entry.get('exitCode') != 0:
        raise RuntimeError('G6_EVIDENCE_FAILED: 阶段八证据不是成功记录')
    if 'check_stage8.py --run-only' not in entry.get('command', ''):
        raise RuntimeError('G6_EVIDENCE_COMMAND_INVALID')
    evidence = ROOT / entry.get('evidence', '')
    if not evidence.is_file():
        raise RuntimeError('G6_EVIDENCE_FILE_MISSING')
    body = evidence.read_text(encoding='utf-8').split('\n\n', 1)[-1]
    digest = 'sha256:' + hashlib.sha256(body.encode('utf-8')).hexdigest()
    if digest != entry.get('digest'):
        raise RuntimeError('G6_EVIDENCE_DIGEST_MISMATCH')
    required = {'role_policy', 'login_api', 'runtime_preset', 'topology'}
    if set(entry.get('evidenceClasses', [])) != required:
        raise RuntimeError('G6_EVIDENCE_CLASSES_INCOMPLETE')


def node_suite(label, files, env):
    cmd = ['node', '--test', '--test-concurrency=1'] + [f'tests/{name}' for name in files]
    result = run(cmd, cwd=PLATFORM, env=env)
    body = print_result(label, cmd, result)
    if result.returncode != 0 or not re.search(r'\bpass [1-9]\d*', body) or not re.search(r'\bfail 0', body):
        raise RuntimeError(f'{label} did not execute a passing test set')
    if re.search(r'\bskipped [1-9]\d*', body):
        raise RuntimeError(f'{label} skipped tests')


def run_gate():
    env = dict(os.environ)
    env.update({'KVVI_DEV_KEYS': '1',
                'KVVI_SIGNING_KEY_PATH': '/tmp/kvvi-stage8-signing.key'})
    link = None
    try:
        start_db()
        node_suite('role_policy', CHECKS['role_policy'], env)
        node_suite('login_api', CHECKS['login_api'], env)
        node_suite('runtime_preset/platform', ['runtime-routing.test.mjs'], env)

        link = dsh_source_link()
        fork = Path('/tmp/kvvi-stage8-g6-fork')
        rebuild = run(['python3', '工具/fork.py', '--rebuild', '--into', str(fork)])
        print_result('runtime_preset/rebuild', rebuild.args, rebuild)
        if rebuild.returncode != 0:
            raise RuntimeError('DSH fork rebuild failed')
        install = run(['pnpm', 'install', '--frozen-lockfile', '--offline'], cwd=fork)
        print_result('runtime_preset/install', install.args, install)
        if install.returncode != 0:
            raise RuntimeError('DSH dependency install failed')
        dsh_test = run(['pnpm', '--filter', '@deepseek-ai/dsh-host-kvvi-mode-router', 'test'], cwd=fork)
        dsh_body = print_result('runtime_preset/dsh', dsh_test.args, dsh_test)
        if dsh_test.returncode != 0 or 'Tests  5 passed' not in dsh_body:
            raise RuntimeError('runtime preset tests failed or were skipped')

        platform_module = (PLATFORM / 'src' / 'runtime-auth.mjs').as_uri()
        js = ("import {runtimeContextHeaders as h} from '" + platform_module + "';"
              "console.log(JSON.stringify(h({sessionId:'s',companyId:'c',gateway:'USER'},"
              "'stage8-cross-boundary-secret')))" )
        signed = run(['node', '--input-type=module', '--eval', js])
        if signed.returncode != 0:
            raise RuntimeError('platform could not produce runtime context')
        cross_env = dict(env)
        cross_env['KVVI_HEADERS'] = signed.stdout.strip()
        cross = ("import {verifyModeHeaders as v} from "
                 "'./packages/host/kvvi-mode-router/src/index.ts';"
                 "const c=v(JSON.parse(process.env.KVVI_HEADERS!),"
                 "'stage8-cross-boundary-secret');"
                 "if(c.gateway!=='USER'||c.preset!=='kvvi-worker') throw new Error('MODE_MISMATCH');"
                 "console.log('UI/session USER -> runtime kvvi-worker')")
        cross_result = run(['pnpm', 'exec', 'tsx', '--eval', cross], cwd=fork, env=cross_env)
        print_result('runtime_preset/cross-boundary', cross_result.args, cross_result)
        if cross_result.returncode != 0:
            raise RuntimeError('UI gateway and runtime preset differ')

        topology = run(['python3', '工具/check_topology.py', '--static'])
        print_result('topology', topology.args, topology)
        if topology.returncode != 0:
            raise RuntimeError('topology check failed')
    finally:
        run(['docker', 'rm', '-f', CONTAINER], timeout=60)
        remove_link(link)


def main():
    if '--run-only' not in sys.argv:
        try:
            require_stage8_evidence()
        except Exception as error:
            print(f'✗ {error}')
            return 1
    try:
        run_gate()
    except Exception as error:
        print(f'✗ G6 未通过：{error}')
        return 1
    print('✓ G6 通过：普通员工在界面、API、会话和工具四层均无法获得搭建能力')
    return 0


if __name__ == '__main__':
    sys.exit(main())
