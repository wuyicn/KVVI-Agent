#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
验收证据包（历史阶段一至七 + 补充需求阶段八至十一）。

## 判据

> 验收证据包包含**阶段一至六的全部测试记录与指纹**。（PRD §7.1 阶段七）

## 它做了什么、没做什么

| 做 | 不做 |
|---|---|
| **跑**各阶段的验收判据，把输出**原样**收进证据包 | **不重新解释**判定 —— 判定由各阶段自己的检查器给出 |
| 记录每份证据的**摘指纹**，并给整包一个**总指纹** | 不主张「跑过了就等于正确」 |
| 把交付包组件清单的**内容指纹**一并收进来 | 不主张「指纹一致就等于安全」 |

## 为什么「原样收」很重要

如果本工具把各检查器的输出解析成自己的结论，那它会成为**第二个判定者** ——
两个判定者迟早会不一致，而不一致时无法判断该信谁。
所以这里只做两件事：**跑**、**原样存**、**记指纹**。

## 诚实边界

各检查器在输出末尾都会打印「本阶段未覆盖」一节。那些段落**一并收进证据包** ——
把「测过什么」和「没测什么」分开存放，会让后者在交付时消失。

用法：

    python3 工具/验收证据包.py            # 跑全部判据并生成证据包
    python3 工具/验收证据包.py --verify          # 只复核证据包与指纹
    python3 工具/验收证据包.py --append-stage8   # 保留旧条目，只追加 G6
    python3 工具/验收证据包.py --refresh-stage8  # 仅复验并替换尚未交付的 G6
    python3 工具/验收证据包.py --append-stage9   # 保留旧条目，只追加 G7
    python3 工具/验收证据包.py --refresh-stage9  # 仅复验并替换尚未交付的 G7
    python3 工具/验收证据包.py --append-stage10  # 保留旧条目，只追加 G8
    python3 工具/验收证据包.py --refresh-stage10 # 仅复验并替换尚未交付的 G8
    python3 工具/验收证据包.py --append-stage11  # 保留旧条目，只追加 G9
    python3 工具/验收证据包.py --refresh-stage11 # 仅复验并替换尚未交付的 G9
"""

import hashlib
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EVID = os.path.join(ROOT, '交付', '证据')
MANIFEST = os.path.join(EVID, '验收证据包.json')

C_OK, C_BAD, C_WARN, C_DIM, C_OFF = '\033[32m', '\033[31m', '\033[33m', '\033[90m', '\033[0m'

# 阶段 → 判据命令。**覆盖阶段一至六**（PRD §7.1）。
#
# ⚠️ 每条都注明它证的是什么。「跑了一堆命令」不等于「覆盖了六个阶段」。
STAGES = [
    ('阶段一', '基座就位', [
        ('G1 契约资产指纹', ['python3', '工具/g1_指纹.py', '--verify']),
        ('G2 fork 改造点', ['python3', '工具/g2_改造点.py', '--check']),
        ('两进程骨架与 N3 拓扑', ['python3', '工具/check_topology.py']),
        ('构建配置', ['python3', '工具/check_build.py']),
        # 问题 24：`stop` 报成功而进程还活着。静态侧 4 组 11 条判据 +
        # 反向测试 8 项（挖掉硬期限、SIGKILL 升级、僵尸判定、负向断言，各自必须变红）。
        # 它证的是「关停承诺有机器判据」，不是「关停行为正确」—— 行为由
        # `distribution/tests/test_supervisor.py` 的真进程负向用例负责。
        ('关停判据（问题 24）', ['bash', '工具/check_shutdown_自测.sh']),
    ]),
    ('阶段二', '品牌与外壳', [
        ('品牌残留', ['python3', '工具/check_brand.py']),
    ]),
    ('阶段三', '搭建引擎模式', [
        ('Skill 产出验收', ['python3', '工具/check_skill_output.py', '--self-test']),
        ('§9.8.1 不变量判定器', ['bash', '工具/check_invariant_自测.sh']),
        ('去行业化自查（0A-14）', ['python3', '工具/check_industry_neutral.py']),
        ('蓝图闭环（0D-1）', ['python3', '工具/check_blueprint.py', '样例/蓝图/通用事项管理系统']),
    ]),
    ('阶段四', '身份与隔离', [
        ('锚点①②③④⑥ 全量', ['python3', '工具/check_stage4.py']),
    ]),
    ('阶段五', '契约授权与运行时', [
        ('锚点①②③④ 全量', ['python3', '工具/check_stage5.py']),
    ]),
    ('阶段六', '工作模式', [
        ('锚点①②③④ 全量', ['python3', '工具/check_stage6.py']),
    ]),
    ('贯穿', '交付完整性', [
        ('交付包清单/版本/指纹', ['python3', '工具/交付包.py', '--check']),
        ('干净环境部署', ['python3', '工具/交付环境.py']),
        ('fork 可重建（N1/N2）', ['python3', '工具/fork.py', '--rebuild',
                                  '--into', '/tmp/kvvi-evidence-fork']),
    ]),
]

STAGE8 = ('阶段八', '身份入口闭环', [
    ('G6 身份与模式路由', ['python3', '工具/check_stage8.py', '--run-only']),
])

STAGE8_SOURCES = [
    'services/platform/src/auth.mjs',
    'services/platform/src/mode-policy.mjs',
    'services/platform/src/gate.mjs',
    'services/platform/src/proxy.mjs',
    'services/platform/src/runtime-auth.mjs',
    'services/platform/tests/mode-policy.test.mjs',
    'services/platform/tests/login-gate.test.mjs',
    'services/platform/tests/runtime-routing.test.mjs',
    'services/platform/tests/auth.test.mjs',
    'forks/dsh/变更/packages/api/gateway/src/index.ts',
    'forks/dsh/变更/packages/bundle/kvvi-app/cordis.patch.yml',
    'forks/dsh/变更/packages/host/kvvi-mode-router/src/index.ts',
    'forks/dsh/变更/packages/host/kvvi-mode-router/tests/mode-router.spec.ts',
    '工具/check_stage8.py',
]


STAGE9 = ('阶段九', '系统运行闭环', [
    ('G7 系统运行闭环', ['python3', '工具/check_stage9.py', '--run-only']),
])

STAGE10 = ('阶段十', '员工与管理闭环', [
    ('G8 UI 与 Agent 差异等价', ['python3', '工具/check_stage10.py', '--run-only']),
])

STAGE11 = ('阶段十一', '私有化发行版闭环', [
    ('G9 macOS 试点发行版', ['python3', '工具/check_stage11.py', '--run-only']),
])

STAGE11_SOURCES = [
    'distribution/bin/kvvi-admin',
    'distribution/lib/preflight.py',
    'distribution/lib/install.py',
    'distribution/lib/pg.py',
    'distribution/lib/supervisor.py',
    'distribution/lib/backup.py',
    'distribution/lib/upgrade.py',
    'distribution/skills/kvvi-install/SKILL.md',
    'distribution/skills/kvvi-install/scripts/_common.sh',
    'distribution/tests/test_preflight.py',
    'distribution/tests/test_pg.py',
    'distribution/tests/test_supervisor.py',
    'distribution/tests/test_backup_restore.py',
    'distribution/tests/test_install_skill.py',
    'services/platform/src/bootstrap.mjs',
    'services/platform/sql/19-instance-bootstrap.sql',
    '工具/发行包.py',
    '工具/check_stage11.py',
    '安装手册.md',
]

STAGE10_SOURCES = [
    'services/platform/src/admin-api.mjs',
    'services/platform/src/api-router.mjs',
    'services/platform/src/system-api.mjs',
    'services/platform/src/runtime-projection.mjs',
    'services/platform/src/workflow.mjs',
    'services/platform/tests/admin-api.test.mjs',
    'services/platform/tests/ui-agent-e2e.test.mjs',
    'services/platform/tests/api-router.test.mjs',
    'forks/dsh/变更/packages/tool/kvvi-business/src/client.ts',
    'forks/dsh/变更/packages/tool/kvvi-business/src/index.ts',
    'forks/dsh/变更/packages/tool/kvvi-business/tests/tools.spec.ts',
    'forks/dsh/变更/packages/client/kvvi-panel/src/client/AdminShell.tsx',
    'forks/dsh/变更/packages/client/kvvi-panel/src/client/MemberAdmin.tsx',
    'forks/dsh/变更/packages/client/kvvi-panel/src/client/RoleAdmin.tsx',
    'forks/dsh/变更/packages/client/kvvi-panel/src/client/PolicyEditor.tsx',
    'forks/dsh/变更/packages/client/kvvi-panel/tests/admin-ui.spec.tsx',
    'forks/dsh/变更/packages/preset/agent-presets/presets/kvvi-worker/agent.cordis.yml',
    '工具/check_stage10.py',
]

STAGE9_SOURCES = [
    'services/platform/src/api-router.mjs',
    'services/platform/src/system-api.mjs',
    'services/platform/src/runtime-projection.mjs',
    'services/platform/src/publish.mjs',
    'services/platform/src/refs.mjs',
    'services/platform/src/record-no.mjs',
    'services/platform/tests/publish-runtime-e2e.test.mjs',
    'services/platform/tests/system-api.test.mjs',
    'services/platform/tests/api-router.test.mjs',
    'services/platform/tests/runtime-projection.test.mjs',
    'forks/dsh/变更/packages/client/kvvi-panel/src/client/index.ts',
    'forks/dsh/变更/packages/client/kvvi-panel/src/client/registry.tsx',
    'forks/dsh/变更/packages/client/kvvi-panel/src/client/FormView.tsx',
    'forks/dsh/变更/packages/client/kvvi-panel/src/client/SystemShell.tsx',
    'forks/dsh/变更/packages/client/kvvi-panel/src/client/api.ts',
    'forks/dsh/变更/packages/client/kvvi-panel/tests/runtime-ui.spec.tsx',
    '工具/check_stage9.py',
]


def digest_of(text: str) -> str:
    return 'sha256:' + hashlib.sha256(text.encode('utf-8')).hexdigest()


def canonical_output(text: str) -> str:
    """只去掉终端渲染产生的行尾空格；保留行、顺序与所有可见内容。"""
    return '\n'.join(line.rstrip() for line in text.split('\n'))


def file_digest(rel: str) -> str:
    h = hashlib.sha256()
    with open(os.path.join(ROOT, rel), 'rb') as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b''):
            h.update(chunk)
    return 'sha256:' + h.hexdigest()


def run(cmd, timeout=3600):
    return subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=timeout)


def collect() -> int:
    os.makedirs(EVID, exist_ok=True)
    entries = []
    failed = []

    print('%s=== 验收证据包 ===%s' % (C_OK, C_OFF))
    print('判据：阶段一至六的**全部**测试记录与指纹（PRD §7.1 阶段七）')
    print()

    all_stages = STAGES + [STAGE8, STAGE9, STAGE10, STAGE11]
    for stage, title, checks in all_stages:
        print('%s%s · %s%s' % (C_OK, stage, title, C_OFF))
        for name, cmd in checks:
            try:
                r = run(cmd)
                ok = r.returncode == 0
                out = canonical_output(r.stdout + (('\n[stderr]\n' + r.stderr) if r.stderr else ''))
            except subprocess.TimeoutExpired:
                ok, out = False, 'TIMEOUT'
            slug = '%s-%s' % (stage, name.replace(' ', '-').replace('/', '_'))
            path = os.path.join(EVID, slug + '.txt')
            with open(path, 'w', encoding='utf-8') as fh:
                fh.write('$ %s\n\n%s' % (' '.join(cmd), out))
            entry = {
                'stage': stage, 'name': name, 'command': ' '.join(cmd),
                'exitCode': r.returncode if 'r' in dir() else 1,
                'ok': ok, 'evidence': os.path.relpath(path, ROOT),
                'digest': digest_of(out),
            }
            # 补充阶段（八、九）多记三层：提交、证据类、来源指纹。
            # 判定「这一条证据产生于哪一版代码」需要提交；判定「它覆盖了判据的哪一半」
            # 需要证据类；判定「来源有没有在取证之后被改过」需要来源指纹。
            supplementary = {
                '阶段八': (['role_policy', 'login_api', 'runtime_preset', 'topology'],
                         STAGE8_SOURCES),
                '阶段九': (['contracts', 'runtime_api', 'client_ui', 'end_to_end'],
                         STAGE9_SOURCES),
                '阶段十': (['admin_api', 'admin_ui', 'worker_tools', 'differential',
                           'signed_context', 'worker_composition'], STAGE10_SOURCES),
                '阶段十一': (['preflight', 'install', 'runtime', 'bootstrap', 'user_journey',
                            'backup_restore', 'uninstall', 'no_repo_leak'],
                           STAGE11_SOURCES),
            }
            if stage in supplementary:
                classes, sources = supplementary[stage]
                entry.update({
                    'commit': run(['git', 'rev-parse', 'HEAD']).stdout.strip(),
                    'evidenceClasses': list(classes),
                    'sourceDigests': {rel: file_digest(rel) for rel in sources},
                })
            entries.append(entry)
            mark = '%s✓%s' % (C_OK, C_OFF) if ok else '%s✗%s' % (C_BAD, C_OFF)
            print('  %s %-30s %s' % (mark, name, entries[-1]['digest'][:24]))
            if not ok:
                failed.append('%s/%s' % (stage, name))
        print()

    # 交付包组件指纹一并收进来
    delivery_digest = None
    if os.path.isfile(os.path.join(ROOT, '交付', '交付包清单.json')):
        with open(os.path.join(ROOT, '交付', '交付包清单.json'), encoding='utf-8') as fh:
            delivery_digest = json.load(fh).get('deliveryDigest')

    payload = {
        'bundleVersion': 'kvvi-evidence/v1',
        'stages': [{'stage': s, 'title': t} for s, t, _ in all_stages],
        'entries': entries,
        'deliveryDigest': delivery_digest,
        'failed': failed,
    }
    payload['bundleDigest'] = digest_of(json.dumps(payload, ensure_ascii=False,
                                                   sort_keys=True))
    with open(MANIFEST, 'w', encoding='utf-8') as fh:
        fh.write(json.dumps(payload, ensure_ascii=False, indent=2) + '\n')

    print('[汇总]')
    print('  证据条目 : %d 条，失败 %d 条' % (len(entries), len(failed)))
    print('  交付摘要 : %s' % (delivery_digest or '—'))
    print('  证据包指纹: %s' % payload['bundleDigest'])
    print()
    print('%s⚠️ 各检查器的「本阶段未覆盖」一节已**原样收进**各证据文件 —— '
          '不要把「通过」单独读。%s' % (C_WARN, C_OFF))
    print()
    if failed:
        print('%s✗ 证据包已生成，但有 %d 项未通过：%s%s'
              % (C_BAD, len(failed), '、'.join(failed), C_OFF))
        return 1
    print('%s✓ 证据包已生成：历史判据与 G6 全部通过%s' % (C_OK, C_OFF))
    return 0


def _write_stage(stage, title, checks, sources, classes, replace: bool) -> int:
    """
    跑一个补充阶段的判据并把记录写进证据包。

    ⚠️ 这是**唯一**一份写补充阶段证据的实现。此前 `--append-stage8` 与
    `--refresh-stage8` 是两段手抄的近似代码；再加一个阶段就是第三份 ——
    而三份手抄的东西迟早只有两份被改到，那正是本项目反复记录的失效模式。
    ``replace`` 区分两种语义：False 只追加（已存在则不动），
    True 复验并替换唯一那条（要求恰好一条，避免模糊替换）。

    @param stage 阶段名，如 `阶段九`
    @param title 阶段标题
    @param checks 判据列表 `[(名称, 命令)]`
    @param sources 该阶段的来源文件（逐个记内容指纹）
    @param classes 证据类集合；检查器会要求它与自己的集合相等
    @param replace 为真时替换既有条目，否则只追加
    @returns 进程退出码
    """
    if verify() != 0:
        print('%s✗ 旧证据包未通过指纹复核，拒绝写入%s' % (C_BAD, C_OFF))
        return 1
    with open(MANIFEST, encoding='utf-8') as fh:
        payload = json.load(fh)
    indexes = [i for i, entry in enumerate(payload.get('entries', []))
               if entry.get('stage') == stage]
    if replace:
        if len(indexes) != 1:
            print('%s✗ %s 记录不是唯一一条，拒绝模糊替换%s' % (C_BAD, stage, C_OFF))
            return 1
    elif indexes:
        print('%s✓ %s 证据已存在；未重写旧记录%s' % (C_OK, stage, C_OFF))
        return 0

    code = 0
    for name, cmd in checks:
        result = run(cmd)
        out = canonical_output(result.stdout + (('\n[stderr]\n' + result.stderr) if result.stderr else ''))
        path = os.path.join(EVID, '%s-%s.txt' % (stage, name.replace(' ', '-').replace('/', '_')))
        with open(path, 'w', encoding='utf-8') as fh:
            fh.write('$ %s\n\n%s' % (' '.join(cmd), out))
        entry = {
            'stage': stage,
            'name': name,
            'command': ' '.join(cmd),
            'exitCode': result.returncode,
            'ok': result.returncode == 0,
            'evidence': os.path.relpath(path, ROOT),
            'digest': digest_of(out),
            'commit': run(['git', 'rev-parse', 'HEAD']).stdout.strip(),
            'evidenceClasses': list(classes),
            'sourceDigests': {rel: file_digest(rel) for rel in sources},
        }
        if replace:
            payload['entries'][indexes[0]] = entry
        else:
            payload.setdefault('entries', []).append(entry)
        if result.returncode != 0:
            code = 1

    payload['failed'] = [item for item in payload.get('failed', [])
                         if not item.startswith(stage + '/')]
    if code != 0:
        payload['failed'].append('%s/%s' % (stage, checks[0][0]))
    if not replace and not any(s.get('stage') == stage for s in payload.get('stages', [])):
        payload.setdefault('stages', []).append({'stage': stage, 'title': title})
    payload.pop('bundleDigest', None)
    payload['bundleDigest'] = digest_of(json.dumps(payload, ensure_ascii=False, sort_keys=True))
    with open(MANIFEST, 'w', encoding='utf-8') as fh:
        fh.write(json.dumps(payload, ensure_ascii=False, indent=2) + '\n')
    if code != 0:
        print('%s✗ %s 判据失败，失败证据已写入%s' % (C_BAD, stage, C_OFF))
        return 1
    print('%s✓ %s 已%s；其余证据条目未重跑、未改写%s'
          % (C_OK, stage, '复验并替换' if replace else '追加', C_OFF))
    return 0


def append_stage8() -> int:
    """只追加阶段八；既有阶段、条目与证据文件不重跑、不改写。"""
    classes = ['role_policy', 'login_api', 'runtime_preset', 'topology']
    return _write_stage(*STAGE8, STAGE8_SOURCES, classes, replace=False)


def refresh_stage8() -> int:
    """只复验阶段八；历史阶段一至七的记录与证据文件保持逐字节不变。"""
    classes = ['role_policy', 'login_api', 'runtime_preset', 'topology']
    return _write_stage(*STAGE8, STAGE8_SOURCES, classes, replace=True)


def append_stage10() -> int:
    """只追加阶段十；既有阶段、条目与证据文件不重跑、不改写。"""
    classes = ['admin_api', 'admin_ui', 'worker_tools', 'differential',
               'signed_context', 'worker_composition']
    return _write_stage(*STAGE10, STAGE10_SOURCES, classes, replace=False)


def append_stage11() -> int:
    """只追加阶段十一；既有阶段、条目与证据文件不重跑、不改写。"""
    classes = ['preflight', 'install', 'runtime', 'bootstrap', 'user_journey',
               'backup_restore', 'uninstall', 'no_repo_leak']
    return _write_stage(*STAGE11, STAGE11_SOURCES, classes, replace=False)


def refresh_stage11() -> int:
    """只复验阶段十一；历史阶段的记录与证据文件保持逐字节不变。"""
    classes = ['preflight', 'install', 'runtime', 'bootstrap', 'user_journey',
               'backup_restore', 'uninstall', 'no_repo_leak']
    return _write_stage(*STAGE11, STAGE11_SOURCES, classes, replace=True)


def refresh_stage10() -> int:
    """只复验阶段十；历史阶段的记录与证据文件保持逐字节不变。"""
    classes = ['admin_api', 'admin_ui', 'worker_tools', 'differential',
               'signed_context', 'worker_composition']
    return _write_stage(*STAGE10, STAGE10_SOURCES, classes, replace=True)


def append_stage9() -> int:
    """只追加阶段九；既有阶段、条目与证据文件不重跑、不改写。"""
    classes = ['contracts', 'runtime_api', 'client_ui', 'end_to_end']
    return _write_stage(*STAGE9, STAGE9_SOURCES, classes, replace=False)


def refresh_stage9() -> int:
    """只复验阶段九；历史阶段的记录与证据文件保持逐字节不变。"""
    classes = ['contracts', 'runtime_api', 'client_ui', 'end_to_end']
    return _write_stage(*STAGE9, STAGE9_SOURCES, classes, replace=True)


def verify() -> int:
    if not os.path.isfile(MANIFEST):
        print('%s✗ 证据包不存在（先不带 --verify 跑一次）%s' % (C_BAD, C_OFF))
        return 2
    with open(MANIFEST, encoding='utf-8') as fh:
        payload = json.load(fh)
    problems = []
    for e in payload['entries']:
        path = os.path.join(ROOT, e['evidence'])
        if not os.path.isfile(path):
            problems.append('缺少证据文件 %s' % e['evidence'])
            continue
        with open(path, encoding='utf-8') as fh:
            body = fh.read()
        # 证据文件头是命令行，比对时去掉它
        if body.split('\n\n', 1)[-1] != '' and digest_of(body.split('\n\n', 1)[1]) != e['digest']:
            problems.append('%s 的内容与记录的指纹不符' % e['evidence'])
    recomputed = digest_of(json.dumps({k: v for k, v in payload.items()
                                       if k != 'bundleDigest'},
                                      ensure_ascii=False, sort_keys=True))
    if recomputed != payload.get('bundleDigest'):
        problems.append('证据包总指纹不符（清单被改过）')

    print('%s=== 验收证据包复核 ===%s' % (C_OK, C_OFF))
    print('条目 %d 条' % len(payload['entries']))
    if problems:
        for p in problems:
            print('  %s✗ %s%s' % (C_BAD, p, C_OFF))
        return 1
    print('  %s✓ 全部证据文件与指纹一致%s' % (C_OK, C_OFF))
    return 0


def main() -> int:
    if '--refresh-stage11' in sys.argv:
        return refresh_stage11()
    if '--append-stage11' in sys.argv:
        return append_stage11()
    if '--refresh-stage10' in sys.argv:
        return refresh_stage10()
    if '--append-stage10' in sys.argv:
        return append_stage10()
    if '--refresh-stage9' in sys.argv:
        return refresh_stage9()
    if '--append-stage9' in sys.argv:
        return append_stage9()
    if '--refresh-stage8' in sys.argv:
        return refresh_stage8()
    if '--append-stage8' in sys.argv:
        return append_stage8()
    if '--verify' in sys.argv:
        return verify()
    return collect()


if __name__ == '__main__':
    sys.exit(main())
