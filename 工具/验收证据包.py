#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
验收证据包（阶段七锚点③）。

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
    python3 工具/验收证据包.py --verify   # 只复核证据包与指纹
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


def digest_of(text: str) -> str:
    return 'sha256:' + hashlib.sha256(text.encode('utf-8')).hexdigest()


def run(cmd, timeout=3600):
    return subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=timeout)


def collect() -> int:
    os.makedirs(EVID, exist_ok=True)
    entries = []
    failed = []

    print('%s=== 验收证据包 ===%s' % (C_OK, C_OFF))
    print('判据：阶段一至六的**全部**测试记录与指纹（PRD §7.1 阶段七）')
    print()

    for stage, title, checks in STAGES:
        print('%s%s · %s%s' % (C_OK, stage, title, C_OFF))
        for name, cmd in checks:
            try:
                r = run(cmd)
                ok = r.returncode == 0
                out = r.stdout + (('\n[stderr]\n' + r.stderr) if r.stderr else '')
            except subprocess.TimeoutExpired:
                ok, out = False, 'TIMEOUT'
            slug = '%s-%s' % (stage, name.replace(' ', '-').replace('/', '_'))
            path = os.path.join(EVID, slug + '.txt')
            with open(path, 'w', encoding='utf-8') as fh:
                fh.write('$ %s\n\n%s' % (' '.join(cmd), out))
            entries.append({
                'stage': stage, 'name': name, 'command': ' '.join(cmd),
                'exitCode': r.returncode if 'r' in dir() else 1,
                'ok': ok, 'evidence': os.path.relpath(path, ROOT),
                'digest': digest_of(out),
            })
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
        'stages': [{'stage': s, 'title': t} for s, t, _ in STAGES],
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
    print('%s✓ 证据包已生成：阶段一至六全部判据通过%s' % (C_OK, C_OFF))
    return 0


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
    if '--verify' in sys.argv:
        return verify()
    return collect()


if __name__ == '__main__':
    sys.exit(main())
