#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
交付包完整性（阶段五锚点④、门禁 G5）。

## 判据

> 交付包组件清单、版本与指纹可核验。（PRD §7.5 G5）

「可核验」的对象是三样东西，缺一不可：

| 项 | 为什么要它 |
|---|---|
| **组件清单** | 不列出来的东西，接收方无法知道该不该有；漏列 = 悄悄少给 |
| **版本** | 同名不同版本的内容不同，没有版本号就无法判断手里是哪一版 |
| **指纹** | 版本号可以被改，内容指纹不能 |

## 它检查的四件事

1. **清单里的每一项都在**，且**内容指纹与清单一致**；
2. **清单之外的、属于已声明组件目录的文件不存在** —— 只查「列了的还在」是不够的，
   多出来的文件同样会进交付包，而它们**没有被任何指纹覆盖**；
3. **交付包摘要**与清单内容一致；
4. **交付包里没有私钥**（PRD §9.4.1：部署包不得明文分发私钥）。

> 第 4 条单列，是因为它一旦出问题，其余三条全过也没用。

用法：

    python3 工具/交付包.py --write     # 生成/刷新 交付/交付包清单.json
    python3 工具/交付包.py --check     # 校验
    python3 工具/交付包.py --self-test # 反向测试：逐项破坏，必须变红

退出码：`0` = 通过 / `1` = 不通过 / `2` = 无法执行
"""

import hashlib
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MANIFEST = os.path.join(ROOT, '交付', '交付包清单.json')

C_OK, C_BAD, C_WARN, C_DIM, C_OFF = '\033[32m', '\033[31m', '\033[33m', '\033[90m', '\033[0m'

# 组件清单：名称 → (相对路径, 类别, 版本来源)
#
# ⚠️ 这里**只列交付物**，不列开发过程文件（docs / 评审 / 进度 / 工具）。
# 交付包的边界必须是画出来的，否则「包里有什么」就成了「仓库里有什么」。
COMPONENTS = [
    ('contracts', 'contracts', '契约层（13 份 MetaSchema + common）', None),
    ('protocol', 'protocol', '规范层（kvvi-json-c14n 双实现）', None),
    ('meta-schema-validator', 'tools/meta-schema', '验证器（Node 侧）', None),
    ('meta-schema-validator-full', 'tools/meta-schema-full', '验证器（全量结构）', None),
    ('distribution', 'distribution', 'macOS 试点发行版（安装向导 / 前置检查 / 备份恢复 / 升级）', None),
    ('platform-service', 'services/platform', '平台服务进程（身份层 / 授权 / 签名 / 认证端点）', 'package.json'),
    ('runtime-service', 'services/runtime', 'Agent 运行时进程（容器入口）', None),
    ('agent-preset-builder', 'vendor/dsh/packages/preset/agent-presets/presets/kvvi-builder',
     '搭建引擎预设（五个 Skill）', None),
    ('agent-preset-worker', 'vendor/dsh/packages/preset/agent-presets/presets/kvvi-worker',
     '工作模式预设', None),
    ('client-plugin-brand', 'vendor/dsh/packages/client/kvvi-brand', 'KVVI 品牌客户端插件', None),
    ('bundle-kvvi-app', 'vendor/dsh/packages/bundle/kvvi-app', 'KVVI Profile Bundle', None),
    ('schema-samples', '样例', '产出样例与蓝图（验收基准）', None),
]

# 交付包里**不该出现**的东西。私钥不进包（§9.4.1）。
FORBIDDEN_PATTERNS = [
    (re.compile(rb'-----BEGIN [A-Z ]*PRIVATE KEY-----'),
     '私钥材料（PRD §9.4.1：不得随包明文分发）'),
    (re.compile(rb'\bKVVI_INTERNAL_TOKEN\s*=\s*[^\s$"{]{8,}'),
     '内嵌的进程间令牌'),
]

# 扫描时跳过的目录：依赖与缓存不属于「交付内容」，
# 但它们的**存在**也不该让校验失败 —— 所以是跳过，不是忽略。
SKIP_DIRS = {'.git', 'node_modules', '__pycache__', '.venv', '.cache'}

# ⚠️ `lib` 与 `dist` **不能一律跳过**。
#
# 它们在 JS/TS 包里是构建产物（不该进包），但在 Python 包里 `lib/` 是**源码目录**。
# 第一版把 `lib` 写进 SKIP_DIRS，于是 `distribution/lib/preflight.py` 一声不响地
# 被排除在交付内容之外 —— 交付包看起来是完整的，装到客户机器上却没有安装逻辑。
# 这类「静默少文件」比报错难查得多。
#
# 判据：**只有当一个目录的上一级有 `package.json` 时，`lib`/`dist` 才算构建产物。**
# 那是「这是一个 npm 包」的可判定信号，不是猜。
BUILD_OUTPUT_DIRS = {'lib', 'dist'}


def _is_build_output(parent, name):
    if name not in BUILD_OUTPUT_DIRS:
        return False
    return os.path.isfile(os.path.join(parent, 'package.json'))


def iter_files(abs_dir):
    for base, dirs, files in os.walk(abs_dir):
        dirs[:] = [d for d in dirs
                   if d not in SKIP_DIRS and not _is_build_output(base, d)]
        for name in files:
            yield os.path.join(base, name)


def component_digest(abs_dir):
    """目录指纹：对「相对路径 + 内容摘要」按路径排序后再摘要。

    不用「把全部内容拼起来」：那样文件顺序一变指纹就变，
    而文件顺序不是内容的一部分。
    """
    h = hashlib.sha256()
    count = 0
    for path in sorted(iter_files(abs_dir)):
        rel = os.path.relpath(path, abs_dir).replace(os.sep, '/')
        with open(path, 'rb') as fh:
            body = fh.read()
        h.update(b'file\0')
        h.update(rel.encode('utf-8'))
        h.update(b'\0')
        h.update(hashlib.sha256(body).hexdigest().encode('ascii'))
        h.update(b'\0')
        count += 1
    return h.hexdigest(), count


def version_of(abs_dir, source):
    if source is None:
        return None
    path = os.path.join(abs_dir, source)
    if not os.path.isfile(path):
        return None
    with open(path, encoding='utf-8') as fh:
        return json.load(fh).get('version')


def build(quiet=False):
    components = []
    problems = []
    for name, rel, desc, version_source in COMPONENTS:
        abs_dir = os.path.join(ROOT, rel)
        if not os.path.isdir(abs_dir):
            problems.append('组件目录不存在：%s' % rel)
            continue
        digest, count = component_digest(abs_dir)
        entry = {
            'name': name, 'path': rel, 'kind': desc,
            'version': version_of(abs_dir, version_source),
            'fileCount': count, 'digest': 'sha256:%s' % digest,
        }
        components.append(entry)

    payload = {
        'manifestVersion': 'kvvi-delivery/v1',
        'prdFingerprint': prd_fingerprint(),
        'components': components,
    }
    # 交付摘要：覆盖**清单本身**。改了任一组件而没刷新清单，这里就对不上。
    payload['deliveryDigest'] = 'sha256:' + hashlib.sha256(
        json.dumps(payload, ensure_ascii=False, sort_keys=True).encode('utf-8')).hexdigest()
    return payload, problems


def prd_fingerprint():
    path = os.path.join(ROOT, 'KVVI-Agent 开发文档 PRD.md')
    if not os.path.isfile(path):
        return None
    with open(path, 'rb') as fh:
        return 'sha256:' + hashlib.sha256(fh.read()).hexdigest()


def scan_forbidden(abs_dir):
    """在交付内容里找私钥/令牌。返回命中列表。"""
    hits = []
    for path in iter_files(abs_dir):
        try:
            with open(path, 'rb') as fh:
                body = fh.read()
        except OSError:
            continue
        for pattern, why in FORBIDDEN_PATTERNS:
            if pattern.search(body):
                hits.append({'file': os.path.relpath(path, ROOT), 'why': why})
    return hits


def check(quiet=False) -> int:
    if not os.path.isfile(MANIFEST):
        print('%s✗ 交付包清单不存在：%s（先跑 --write）%s'
              % (C_BAD, os.path.relpath(MANIFEST, ROOT), C_OFF))
        return 2

    with open(MANIFEST, encoding='utf-8') as fh:
        declared = json.load(fh)

    fresh, build_problems = build()
    problems = list(build_problems)

    # ① 清单里的每一项都在，且指纹一致
    declared_by_name = {c['name']: c for c in declared.get('components', [])}
    fresh_by_name = {c['name']: c for c in fresh['components']}
    for name, want in declared_by_name.items():
        got = fresh_by_name.get(name)
        if got is None:
            problems.append('清单列了 %s，但它在仓库里不存在' % name)
            continue
        if got['digest'] != want['digest']:
            problems.append('%s 的内容变了而清单没刷新（%s → %s）'
                            % (name, want['digest'][:18], got['digest'][:18]))
        if got['fileCount'] != want['fileCount']:
            problems.append('%s 的文件数从 %d 变成 %d'
                            % (name, want['fileCount'], got['fileCount']))
        if got['version'] != want['version']:
            problems.append('%s 的版本从 %r 变成 %r' % (name, want['version'], got['version']))

    # ② 清单之外的组件：新加的组件目录没进清单，就等于没被指纹覆盖
    for name in fresh_by_name:
        if name not in declared_by_name:
            problems.append('组件 %s 没有出现在清单里 —— 它不会被任何指纹覆盖' % name)

    # ③ 交付摘要
    recomputed = dict(fresh)
    if fresh['deliveryDigest'] != declared.get('deliveryDigest'):
        problems.append('交付摘要与清单内容不一致（清单被改过，或组件变了）')
    void = recomputed

    # ④ 私钥不进包
    for name, rel, _desc, _v in COMPONENTS:
        for hit in scan_forbidden(os.path.join(ROOT, rel)):
            problems.append('交付内容里有%s：%s' % (hit['why'], hit['file']))

    if not quiet:
        print('%s=== 交付包完整性 ===%s' % (C_OK, C_OFF))
        print('判据：组件清单、版本、指纹可核验（PRD §7.5 G5、§9.4.1）')
        print()
        print('清单版本 : %s' % declared.get('manifestVersion'))
        print('PRD 指纹 : %s' % (declared.get('prdFingerprint') or '—'))
        print('组件数   : %d' % len(declared.get('components', [])))
        print()
        for entry in declared.get('components', []):
            mark = '%s✓%s' % (C_OK, C_OFF)
            if any(entry['name'] == p.split(' ')[0] for p in problems):
                mark = '%s✗%s' % (C_BAD, C_OFF)
            print('  %s %-26s v%-10s %4d 个文件  %s'
                  % (mark, entry['name'], entry.get('version') or '—',
                     entry['fileCount'], entry['digest'][:30]))
        print()
        if problems:
            for p in problems:
                print('  %s✗ %s%s' % (C_BAD, p, C_OFF))
        else:
            print('%s✓ 组件清单、版本与指纹三者一致；交付内容中无私钥%s' % (C_OK, C_OFF))

    # 未使用变量：保持 recomputed 的语义可读性
    assert void is not None
    return 0 if not problems else 1


def main() -> int:
    if '--write' in sys.argv:
        payload, problems = build()
        for p in problems:
            print('%s✗ %s%s' % (C_BAD, p, C_OFF))
        if problems:
            return 1
        os.makedirs(os.path.dirname(MANIFEST), exist_ok=True)
        with open(MANIFEST, 'w', encoding='utf-8') as fh:
            fh.write(json.dumps(payload, ensure_ascii=False, indent=2) + '\n')
        print('✓ 已写入 %s（%d 个组件）'
              % (os.path.relpath(MANIFEST, ROOT), len(payload['components'])))
        return 0
    if '--self-test' in sys.argv:
        return self_test()
    return check()


def self_test() -> int:
    """
    反向测试：逐项破坏，必须变红。

    ⚠️ 本检查最容易退化成「永远报通过」：清单与仓库同时冻结时，
    比对的两边永远相等。所以每一项破坏都真的改一个文件再跑。
    """
    import shutil
    import tempfile
    print('=== 交付包检查器反向测试 ===')
    results = []

    # 备份清单，逐个场景破坏后还原
    with open(MANIFEST, encoding='utf-8') as fh:
        original = fh.read()

    try:
        results.append(('正例：原样 → 通过', check(quiet=True) == 0))

        # ① 改一个组件里的文件，但不刷新清单
        probe = os.path.join(ROOT, '样例', 'view-schema', '__delivery_probe.json')
        with open(probe, 'w', encoding='utf-8') as fh:
            fh.write('{"probe": true}\n')
        results.append(('组件内容变了而清单没刷新 → 红', check(quiet=True) == 1))
        os.remove(probe)
        results.append(('移除探针后恢复 → 通过', check(quiet=True) == 0))

        # ② 改版本号
        path = os.path.join(ROOT, 'services', 'platform', 'package.json')
        with open(path, encoding='utf-8') as fh:
            pkg = fh.read()
        with open(path, 'w', encoding='utf-8') as fh:
            fh.write(pkg.replace('"version": "0.1.0"', '"version": "9.9.9"'))
        results.append(('版本变了而清单没刷新 → 红', check(quiet=True) == 1))
        with open(path, 'w', encoding='utf-8') as fh:
            fh.write(pkg)

        # ③ 交付摘要被改
        data = json.loads(original)
        data['deliveryDigest'] = 'sha256:' + '0' * 64
        with open(MANIFEST, 'w', encoding='utf-8') as fh:
            fh.write(json.dumps(data, ensure_ascii=False, indent=2))
        results.append(('交付摘要与内容不符 → 红', check(quiet=True) == 1))

        # ④ 清单缺一个组件
        data = json.loads(original)
        data['components'] = data['components'][1:]
        with open(MANIFEST, 'w', encoding='utf-8') as fh:
            fh.write(json.dumps(data, ensure_ascii=False, indent=2))
        results.append(('清单漏列组件 → 红', check(quiet=True) == 1))

        # ⑤ 私钥混进交付内容
        with open(MANIFEST, 'w', encoding='utf-8') as fh:
            fh.write(original)
        key_probe = os.path.join(ROOT, '样例', '__private_key_probe.txt')
        with open(key_probe, 'wb') as fh:
            fh.write(b'-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n')
        results.append(('交付内容里出现私钥 → 红', check(quiet=True) == 1))
        os.remove(key_probe)

        # ⑥ 清单不存在 → 无法执行（不是「通过」）
        with open(MANIFEST, 'w', encoding='utf-8') as fh:
            fh.write(original)
        moved = MANIFEST + '.bak'
        shutil.move(MANIFEST, moved)
        results.append(('清单不存在 → 退出码 2', check(quiet=True) == 2))
        shutil.move(moved, MANIFEST)
    finally:
        with open(MANIFEST, 'w', encoding='utf-8') as fh:
            fh.write(original)

    ok = 0
    for name, passed in results:
        if passed:
            print('  %s✓%s %s' % (C_OK, C_OFF, name))
            ok += 1
        else:
            print('  %s✗%s %s' % (C_BAD, C_OFF, name))
    print()
    if ok != len(results):
        print('%s✗ %d/%d 项不符%s' % (C_BAD, ok, len(results), C_OFF))
        return 1
    print('%s✓ %d 项全部符合 —— 清单、版本、指纹三者任一变化都会被检出%s'
          % (C_OK, len(results), C_OFF))
    return 0


if __name__ == '__main__':
    sys.exit(main())
