#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""打磨一个**能带走的 macOS 试点发行包**。

## 这个包是什么，不是什么

| 是 | 不是 |
|---|---|
| 一次「部署安装测试」的载体：解到干净机器上，按手册走完安装 | 一键包（那个要把 Node 运行时与 1.9 GB 依赖都打进去，属方案 A） |
| 源码 + 安装器 + 一份前置检查 | 容器镜像（Linux 那条路已登记为后续） |

**为什么运行时的依赖不进包**：`vendor/dsh/node_modules` 是 **1.9 GB**，而且里面是
**darwin-arm64 的原生模块**（sharp、esbuild、cua-driver）。把它复制到另一台机器上，
轻则在别的架构上加载失败，重则装出一个「看起来装好了、一跑就崩」的实例 ——
本仓库的 Dockerfile 早就因为同一件事把「复制宿主 node_modules」判为不可用。
所以包只带**源码与构建产物**，依赖在客户机器上装一次。

**平台的依赖进包**：`services/platform/node_modules` 只有 828 KB，且全是纯 JS
（`pg` 及其同伴）。带上它，安装时少一步、少一个失败点。

## 包里必须有什么，为什么是这几样

| 内容 | 不带的后果 |
|---|---|
| `distribution/` | 没有安装器 —— 那就只是一个源码包 |
| `services/platform/`（含 node_modules） | 平台服务起不来 |
| `vendor/dsh/` 的**源码与 `lib/`** | 运行时入口 `apps/cli/lib/bin.js` 不在，界面打不开 |
| `contracts/` | 契约校验没有基准 |
| `安装手册.md` | 「只用发行包与操作手册」这句判据无从谈起 |

## 它**不带**什么

- `node_modules`（运行时的）、`.git`、`lib/types` 之外的构建残留；
- **任何密钥或口令**：它们在客户机器上现场生成（§9.4.1）；
- 开发用的 compose 覆盖文件与测试装置。

用法：

    python3 工具/发行包.py --build            # 生成 交付/发行/kvvi-macos-pilot.tar.gz
    python3 工具/发行包.py --check            # 校验已有包的内容与摘要
    python3 工具/发行包.py --self-test        # 反向测试：逐项破坏，必须变红
"""

import hashlib
import json
import os
import re
import shutil
import sys
import tarfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, '交付', '发行')
ARCHIVE = os.path.join(OUT_DIR, 'kvvi-macos-pilot.tar.gz')
MANIFEST = os.path.join(OUT_DIR, '发行包清单.json')

C_OK, C_BAD, C_WARN, C_DIM, C_OFF = '\033[32m', '\033[31m', '\033[33m', '\033[90m', '\033[0m'

#: 包内的顶层目录名。解出来是 `kvvi-macos-pilot/`，不是散落一地。
TOP = 'kvvi-macos-pilot'

#: 逐项收进来的内容：`(源相对路径, 包内相对路径, 是否整树)`。
#:
#: ⚠️ **逐项列出，不用「排除法」。** 排除法的问题在于新目录默认进包 ——
#: 而一个默认进包的目录迟早会把测试装置、评审稿或某份密钥带出去。
#: 这里的方向是反的：**不写进来就不进包**。
CONTENTS = [
    ('distribution', 'distribution'),
    ('services/platform', 'services/platform'),
    ('vendor/dsh', 'vendor/dsh'),
    ('contracts', 'contracts'),
    ('protocol', 'protocol'),
    # ⚠️ **搭建引擎的契约校验器，不能漏。**
    #
    # `kvvi-builder` 预设里每个构建 skill 都写着「用 `data-model` 建模，
    # 再用 `node tools/meta-schema/node/cli.mjs --contract … --checks complete` 校验」——
    # 而第一版的发行包里**没有 `tools/` 这个目录**。于是搭建者按 skill 里的命令去跑，
    # 找不到文件，只能自己找替代方案（实测它试了 ajv、翻了半天目录），
    # 「定契约」这一步就没有机器判据了。
    #
    # 它其实**本来就该跟着走**：`cli.mjs` 用 `dirname^4` 定位仓库根，
    # 然后去读 `protocol/kvvi-json-c14n/…` 与 `contracts/meta-schemas/…`——
    # 而这两样发行包里一直都有。少的就是 `tools/` 这一项。
    ('tools/meta-schema', 'tools/meta-schema'),
]

#: 单独收录的**单个文件**：`(源相对路径, 包内相对路径)`。
#:
#: `CONTENTS` 收的是目录；这三份是文件，且都必须落在包根的**固定相对位置**上
#: （`安装手册.md`、`README.md`、`package.json` 供安装器与客户直接读；
#: 后两份是契约校验器的溯源文件，见下面的说明）。
EXTRA_FILES = [
    '安装手册.md',
    'README.md',
    'package.json',
    # ⚠️ **校验器的两个溯源文件，按固定 sha256 校验，缺一个它就拒绝工作。**
    #
    # `tools/meta-schema/node/bundle-policy.mjs` 里写死了这两份文档的路径与摘要，
    # 每次调用都要逐字节核对。只补 `tools/` 而不补它们，校验器**能加载、
    # 但每次调用都返回 `EXECUTION_FAILED`** —— 而这一次是搭建者自己发现的：
    # 它按 skill 跑了一遍、拿到失败，于是把校验器连同这两份文档一起复制进工作区，
    # 才把校验做完，并在交付说明里写明了原因。
    #
    # 逐个列文件、不用整目录：`docs/` 下还有取证、计划、评审稿，那些不进包。
    'docs/PRD-AI无代码平台设计-v1.11.md',
    'docs/superpowers/specs/2026-09-08-0a-meta-schema-core-design.md',
]

#: 整树收录时排除的路径片段。缓存与 Git 元数据一律不进包。
SKIP_ANYWHERE = ('/.git/', '/__pycache__/', '/.cache/',
                 '/.pytest_cache/', '/.venv/', '/.dsh-build/')

#: ⚠️ `node_modules` **不能一律排除**，要按来源分开判：
#:
#: | 来源 | 处理 | 为什么 |
#: |---|---|---|
#: | `services/platform/node_modules`（828 KB） | **进包** | 全是纯 JS（`pg` 及其同伴），
#:   带进包就少一步安装、少一个失败点 |
#: | `vendor/dsh/node_modules`（1.9 GB） | **不进包** | 里面是 **darwin-arm64 的原生模块**
#:   （sharp、esbuild、cua-driver）。复制到别的机器上轻则加载失败，
#:   重则装出一个「看起来装好了、一跑就崩」的实例 |
#:
#: 第一版把 `node_modules` 写进 `SKIP_ANYWHERE`，于是平台的依赖也被甩掉，
#: 而那些必需文件是在 `--build` 之后才被 `REQUIRED` 检查抓到的 ——
#: **一个把该带的东西也甩掉的规则，与一个把不该带的东西带上的规则，同样坏。**
PORTABLE_DEPENDENCIES = ('services/platform', 'tools/meta-schema')

#: 只保留构建产物、不保留源码树里的临时文件。
SKIP_SUFFIX = ('.pyc', '.log', '.tsbuildinfo')

#: 绝不允许出现在包里的内容。私钥不进发行包（§9.4.1）。
FORBIDDEN = [
    (re.compile(rb'-----BEGIN [A-Z ]*PRIVATE KEY-----'), '私钥材料'),
    (re.compile(rb'\bKVVI_INTERNAL_TOKEN\s*=\s*[^\s$"{]{8,}'), '内嵌的进程间令牌'),
    (re.compile(rb'password_hash\s*=\s*\'[0-9a-f]{32}'), '硬编码的口令哈希'),
]

#: 包内必须存在的路径。少一个，包就是不能装的。
REQUIRED = [
    'distribution/bin/kvvi-admin',
    'distribution/lib/install.py',
    'distribution/lib/preflight.py',
    'distribution/manifest.json',
    'tools/meta-schema/node/cli.mjs',
    'tools/meta-schema/node/node_modules/ajv/package.json',
    'protocol/kvvi-json-c14n/v1/evidence-sets/prd-v1.11/node/kvvi-json-c14n.mjs',
    'docs/PRD-AI无代码平台设计-v1.11.md',
    'docs/superpowers/specs/2026-09-08-0a-meta-schema-core-design.md',
    'services/platform/src/server.mjs',
    'services/platform/src/migrate.mjs',
    'services/platform/node_modules/pg/package.json',
    'vendor/dsh/apps/cli/lib/bin.js',
    'vendor/dsh/packages/compaction/compaction-image-offload/lib/types/projection.js',
    'vendor/dsh/package.json',
    'contracts/meta-schemas/0a-full-r1/business-schema.v1.schema.json',
    '安装手册.md',
    'README.md',
]


def should_skip(source_rel: str, rel: str) -> bool:
    """
    该路径是否不进包。
    @param source_rel 它来自哪个顶层内容（`CONTENTS` 的第一列）
    @param rel 相对该内容根的路径
    @returns 跳过时为真
    """
    probe = '/' + rel.strip('/') + '/'
    if any(piece in probe for piece in SKIP_ANYWHERE):
        return True
    if '/node_modules/' in probe:
        # 只有被显式列为「可移植依赖」的那一份才进包。见 PORTABLE_DEPENDENCIES。
        return not any(source_rel == keep or source_rel.startswith(keep + '/')
                       or keep.startswith(source_rel + '/')
                       for keep in PORTABLE_DEPENDENCIES)
    if rel.endswith(SKIP_SUFFIX):
        return True
    if '/lib/types/' in probe and not rel.endswith('/') and not rel.endswith('.js'):
        # ⚠️ **`lib/types/` 不能整目录甩掉，目录本身更不能被剪掉。**
        #
        # 这里原来写的是「`lib/types/` 一律不进包」，理由是一句想当然：
        # 「`.d.ts` 是编译中间产物，运行时用不到」。**前提是错的。**
        # DSH 的 tsconfig 用 `outDir: lib/types`，所以 tsc 把**编译后的 `.js` 也落在那里**，
        # 而包与包之间正是按 `.js` 相对路径互相 import 的：
        # `.../session-format-catalog/lib/index.js`
        #   → `.../dsh-compaction-image-offload/lib/types/projection.js`。
        #
        # 代价：源树里 `lib/types/**` 有 1946 个 `.js`、1946 个 `.d.ts`、3892 个 `.map`；
        # 整目录一甩，1946 个运行时 `.js` 全没了（实测少 7785 个文件）。
        # 症状极具误导性：**安装成功、界面 HTTP 200、登录成功**，
        # 但运行时的 12 个条目 `failed to import`，24 个前端条目永远在等 `sessions` 服务 ——
        # 界面打开是「Failed to load plugins」和一整屏待激活清单，对话区根本出不来。
        # 而 G9 的验收只看 HTTP 200，于是这条一路绿灯。
        #
        # 现在只甩类型与 sourcemap（`.d.ts`、`.map`），`.js` 留下。
        return True
    return False


def collect() -> list:
    """
    收集要进包的文件。
    @returns `[(绝对路径, 包内相对路径)]`
    """
    entries = []
    for source_rel, into_rel in CONTENTS:
        source = os.path.join(ROOT, source_rel)
        if not os.path.isdir(source):
            raise SystemExit(f'{C_BAD}✗ 缺目录：{source_rel}{C_OFF}')
        for base, dirs, files in os.walk(source):
            dirs[:] = [d for d in dirs if not should_skip(
                source_rel, os.path.relpath(os.path.join(base, d), source) + '/')]
            for name in files:
                absolute = os.path.join(base, name)
                rel = os.path.relpath(absolute, source)
                if should_skip(source_rel, rel):
                    continue
                entries.append((absolute, os.path.join(into_rel, rel)))
    for extra in EXTRA_FILES:
        absolute = os.path.join(ROOT, extra)
        if os.path.isfile(absolute):
            entries.append((absolute, extra))
    return sorted(entries, key=lambda pair: pair[1])


def build() -> int:
    """
    生成发行包与清单。
    @returns 退出码
    """
    os.makedirs(OUT_DIR, exist_ok=True)
    entries = collect()
    print(f'{C_OK}=== 打包 ==={C_OFF}')
    print(f'  收进 {len(entries)} 个文件')

    missing = scan_required(entries)
    if missing:
        for path in missing:
            print(f'{C_BAD}✗ 缺必需文件：{path}{C_OFF}')
        return 1

    problems = []
    digest = hashlib.sha256()
    with tarfile.open(ARCHIVE, 'w:gz') as tar:
        for absolute, rel in entries:
            with open(absolute, 'rb') as handle:
                body = handle.read()
            for pattern, what in FORBIDDEN:
                if pattern.search(body):
                    problems.append((rel, what))
            digest.update(rel.encode('utf-8'))
            digest.update(b'\0')
            digest.update(hashlib.sha256(body).hexdigest().encode('ascii'))
            digest.update(b'\0')
            info = tar.gettarinfo(absolute, arcname=TOP + '/' + rel)
            info.uid = info.gid = 0
            info.uname = info.gname = 'root'
            info.mode = 0o755 if rel.endswith('kvvi-admin') else 0o644
            with open(absolute, 'rb') as handle:
                tar.addfile(info, handle)
        # 手册与 README 之外，再放一份「包里有什么」的清单进去 ——
        # 客户机器上没有本仓库，而核对内容需要它。
        payload = json.dumps({
            'bundleVersion': 'kvvi-macos-pilot/v1',
            'fileCount': len(entries),
            'files': [rel for _absolute, rel in entries],
        }, ensure_ascii=False, indent=2).encode('utf-8')
        import io
        info = tarfile.TarInfo(TOP + '/发行包清单.json')
        info.size = len(payload)
        info.mode = 0o644
        tar.addfile(info, io.BytesIO(payload))

    if problems:
        print(f'{C_BAD}✗ 包里有不该出现的内容：{C_OFF}')
        for rel, what in problems[:10]:
            print(f'    {rel} —— {what}')
        os.remove(ARCHIVE)
        return 1

    size = os.path.getsize(ARCHIVE) / (1024 ** 2)
    with open(MANIFEST, 'w', encoding='utf-8') as handle:
        json.dump({'bundleVersion': 'kvvi-macos-pilot/v1',
                   'archive': os.path.relpath(ARCHIVE, ROOT),
                   'fileCount': len(entries),
                   'contentDigest': 'sha256:' + digest.hexdigest(),
                   'archiveSha256': sha256_of(ARCHIVE),
                   'archiveBytes': os.path.getsize(ARCHIVE)},
                  handle, ensure_ascii=False, indent=2)
        handle.write('\n')
    print(f'{C_OK}✓ {os.path.relpath(ARCHIVE, ROOT)}（{size:.1f} MB，'
          f'{len(entries)} 个文件）{C_OFF}')
    print(f'  内容指纹 sha256:{digest.hexdigest()[:24]}')
    return 0


def sha256_of(path: str) -> str:
    """文件的 SHA-256。"""
    h = hashlib.sha256()
    with open(path, 'rb') as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b''):
            h.update(chunk)
    return 'sha256:' + h.hexdigest()


def scan_required(entries) -> list:
    """包内缺少的必需路径。"""
    have = {rel for _absolute, rel in entries}
    return [path for path in REQUIRED if path not in have]


def source_runtime_js_count() -> int:
    """
    源树里 `vendor/dsh/**/lib/types/**` 下的 `.js` 文件数（**任意深度**）。

    **这是发行包 `lib/types` 那一类文件的数量判据。** 逐个列 `REQUIRED` 只能钉住
    被点到的那几个；而这一类缺陷的形态是「整类少掉」。数量对齐是能同时抓住
    「漏了一类」与「多了一坨」的判据。

    ⚠️ 深度必须算全：`lib/types` 下还有子目录，只数直接落在 `lib/types/` 里那一层
    会漏掉四成（实测 1107 : 1946）—— 而**漏掉的那部分恰好在 `find` 的判据之外**。

    @returns 文件数；`vendor/dsh` 不在时返回 `0`（此时这一项不参与判定）
    """
    root = os.path.join(ROOT, 'vendor', 'dsh')
    if not os.path.isdir(root):
        return 0
    count = 0
    for base, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in ('node_modules', '.git')]
        rel = '/' + os.path.relpath(base, root).replace(os.sep, '/') + '/'
        if '/lib/types/' not in rel:
            continue
        count += sum(1 for name in files if name.endswith('.js'))
    return count


def packages_missing_main(root_rel: str = 'vendor/dsh') -> list:
    """
    源树里 `main` 指向的文件**不存在**的 workspace 包。

    ⚠️ **这一类缺陷的形态是「新加的包没跑构建」。**
    `@deepseek-ai/dsh-tool-kvvi-business` 就是这样：`package.json` 写着
    `main: lib/index.js`，源码在、`lib/types/` 也在（tsc 产出的），
    **只有 tsdown 那一步的 `lib/index.js` 没有** —— 因为它是在某次构建之后才加进来的包，
    而没有人再跑一遍 `build:lib:host`。

    后果不是「少个文件」，是**整个工作模式起不来**：
    `kvvi-worker` preset 里那一行 `tool-kvvi-business` 解析不到，
    会话创建直接失败 —— 而搭建模式（`kvvi-builder`）一切正常，
    于是「搭建者能搭、员工用不了」，排查方向天然会偏。

    逐个 `REQUIRED` 抓不住它：名单是人手写的，而这是「新增了一个包」这件事本身。

    @param root_rel 要扫的子树（相对仓库根）
    @returns `['dsh-xxx → path/lib/index.js', …]`
    """
    import json
    root = os.path.join(ROOT, root_rel)
    out = []
    for pattern in ('packages/*/*/package.json', 'apps/*/package.json'):
        import glob
        for manifest in glob.glob(os.path.join(root, pattern)):
            if 'node_modules' in manifest:
                continue
            try:
                with open(manifest, encoding='utf-8') as handle:
                    payload = json.load(handle)
            except (OSError, ValueError):
                continue
            main = payload.get('main')
            if not isinstance(main, str) or not main.endswith('.js'):
                continue
            package_dir = os.path.dirname(manifest)
            if not os.path.isfile(os.path.join(package_dir, main)):
                rel = os.path.relpath(package_dir, ROOT)
                out.append(f"{payload.get('name')} → {rel}/{main}")
    return sorted(out)


def check() -> int:
    """
    校验已有发行包。
    @returns 退出码
    """
    if not os.path.isfile(ARCHIVE) or not os.path.isfile(MANIFEST):
        print(f'{C_BAD}✗ 发行包不存在（先跑 --build）{C_OFF}')
        return 2
    with open(MANIFEST, encoding='utf-8') as handle:
        manifest = json.load(handle)
    problems = []

    actual = sha256_of(ARCHIVE)
    if actual != manifest['archiveSha256']:
        problems.append('压缩包本身与清单记录的摘要不符（包被改过）')

    with tarfile.open(ARCHIVE, 'r:gz') as tar:
        names = [name[len(TOP) + 1:] for name in tar.getnames()
                 if name.startswith(TOP + '/') and not tar.getmember(name).isdir()]
    for path in REQUIRED:
        if path not in names:
            problems.append(f'缺必需文件：{path}')
    # ⚠️ **每个包的 `main` 都要真的存在。** 见 `packages_missing_main()`：
    #    新加的包没跑构建，症状是「整个 preset 解析不到」，而报错只说
    #    「could not be resolved: @deepseek-ai/…」，看不出缺的是构建产物。
    for broken in packages_missing_main():
        problems.append(f'包声明了 main 但文件不存在（多半是没跑构建）：{broken}')

    for name in names:
        # ⚠️ 判据从 `PORTABLE_DEPENDENCIES` **取**，不在这里另写一份名单。
        #    第一版把 `services/platform/` 写死在条件里，于是第二个可移植依赖
        #    （`tools/meta-schema`）加上去时，规则立刻把它判成违规 ——
        #    而这其实是规则自己没跟上，不是包错了。名单写两处，就会漂移一处。
        if '/node_modules/' in '/' + name + '/':
            if not any(name.startswith(keep + '/') for keep in PORTABLE_DEPENDENCIES):
                problems.append(f'运行时依赖不该进包：{name}')

    # ⚠️ **整类文件的数量对齐。** 见 `should_skip` 里 `lib/types` 那一段：
    #    整整一类运行时 `.js` 曾经被静默甩掉，而逐个 `REQUIRED` 抓不住「少了一类」。
    expected = source_runtime_js_count()
    if expected > 0:
        packed = sum(1 for name in names
                     if name.startswith('vendor/dsh/') and '/lib/types/' in '/' + name
                     and name.endswith('.js'))
        if packed != expected:
            problems.append(f'运行时代码不齐：vendor/dsh 下 lib/types 的 .js '
                            f'源树有 {expected} 个，包里只有 {packed} 个')

    # ⚠️ **包里的字节必须还是当前源树的字节。**
    #
    # `archiveSha256` 只说「包自己没被改过」—— 源树改了、包没重打，它一声不响。
    # 第一版的 check 只拿 `vendor/dsh` 下 `lib/types` 的**文件数**比一比，于是：
    # 修完 `services/platform/src/server.mjs`（关停硬期限）与
    # `distribution/lib/supervisor.py`（SIGKILL 升级）之后，`--check` 依然全绿，
    # 而 tar 里是**旧字节** —— 拿它去部署，测的是修复前的行为（踩过一次）。
    #
    # 这里用**打包时自己那套算法**重算内容指纹：一致 = 包里每一个字节都还是
    # 当前源树的字节。名单也在 `collect()` 里，不另写一份。
    fresh = hashlib.sha256()
    for absolute, rel in collect():
        with open(absolute, 'rb') as handle:
            body = handle.read()
        fresh.update(rel.encode('utf-8'))
        fresh.update(b'\0')
        fresh.update(hashlib.sha256(body).hexdigest().encode('ascii'))
        fresh.update(b'\0')
    if 'sha256:' + fresh.hexdigest() != manifest['contentDigest']:
        problems.append('包的内容与当前源树不一致 —— 源树改过而包没重打（跑 --build）')

    print(f'{C_OK}=== 发行包复核 ==={C_OFF}')
    print(f'  {os.path.relpath(ARCHIVE, ROOT)}：{len(names)} 个文件，'
          f"{manifest['archiveBytes'] / (1024 ** 2):.1f} MB")
    print(f"  内容指纹 {manifest['contentDigest'][:32]}")
    if problems:
        for problem in problems[:10]:
            print(f'  {C_BAD}✗ {problem}{C_OFF}')
        return 1
    print(f'  {C_OK}✓ 内容、摘要与必需文件齐备{C_OFF}')
    return 0


def self_test() -> int:
    """
    反向测试：逐项破坏，检查器必须变红。
    @returns 退出码
    """
    print(f'{C_OK}=== 发行包检查器反向测试 ==={C_OFF}')
    cases = []

    def run_check() -> bool:
        """在当前包上跑一次 --check，返回是否通过。"""
        import io
        import contextlib
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            code = check()
        return code == 0

    cases.append(('正例：原样 → 通过', run_check()))

    # ① 改一个字节，摘要必然不符。
    with open(ARCHIVE, 'rb') as handle:
        original = handle.read()
    with open(ARCHIVE, 'wb') as handle:
        handle.write(original + b'x')
    cases.append(('压缩包被追加字节 → 红', not run_check()))
    with open(ARCHIVE, 'wb') as handle:
        handle.write(original)

    # ② 摘掉一个必需文件。
    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
        broken = os.path.join(tmp, 'broken.tar.gz')
        with tarfile.open(ARCHIVE, 'r:gz') as source:
            with tarfile.open(broken, 'w:gz') as target:
                for member in source.getmembers():
                    if member.name == TOP + '/distribution/bin/kvvi-admin':
                        continue
                    target.addfile(member, source.extractfile(member)
                                   if member.isfile() else None)
        with open(ARCHIVE, 'rb') as handle:
            saved = handle.read()
        shutil.copy2(broken, ARCHIVE)
        cases.append(('缺安装器 → 红', not run_check()))
        with open(ARCHIVE, 'wb') as handle:
            handle.write(saved)

    cases.append(('移除探针后恢复 → 通过', run_check()))

    # ④ **源树改了而包没重打。**
    #    这一条针对的是「计数对齐只覆盖 vendor/dsh 的 lib/types」那个盲区：
    #    修复 `services/platform/src/server.mjs` 之后 `--check` 依然全绿，
    #    而 tar 里是旧字节 —— 拿它去部署，测的是修复前的行为。踩过一次。
    victim = os.path.join(ROOT, 'services', 'platform', 'src', 'server.mjs')
    with open(victim, 'rb') as handle:
        saved = handle.read()
    with open(victim, 'ab') as handle:
        handle.write('\n// 反向测试注入\n'.encode('utf-8'))
    try:
        cases.append(('源树改过而包没重打 → 红', not run_check()))
    finally:
        with open(victim, 'wb') as handle:
            handle.write(saved)

    cases.append(('源树还原后 → 通过', run_check()))

    # ③ 摘掉一个**不在 `REQUIRED` 里**的 `lib/types/**.js`。
    #    这一条针对的是「整类运行时代码被甩掉」那个缺陷：只核对 `REQUIRED`
    #    逐个点名的文件是抓不住它的 —— 被点到的那个还在，少的是另外 1945 个。
    with tempfile.TemporaryDirectory() as tmp:
        broken = os.path.join(tmp, 'broken2.tar.gz')
        victim = None
        with tarfile.open(ARCHIVE, 'r:gz') as source:
            with tarfile.open(broken, 'w:gz') as target:
                for member in source.getmembers():
                    if (victim is None and member.isfile()
                            and '/lib/types/' in '/' + member.name and member.name.endswith('.js')
                            and member.name not in {TOP + '/' + rel for rel in REQUIRED}):
                        victim = member.name
                        continue
                    target.addfile(member, source.extractfile(member)
                                   if member.isfile() else None)
        with open(ARCHIVE, 'rb') as handle:
            saved = handle.read()
        shutil.copy2(broken, ARCHIVE)
        cases.append((f'少一个 lib/types 的 .js（{victim.split("/")[-1] if victim else "?"}）→ 红',
                      victim is not None and not run_check()))
        with open(ARCHIVE, 'wb') as handle:
            handle.write(saved)

    cases.append(('恢复后仍通过 → 通过', run_check()))

    failed = [name for name, ok in cases if not ok]
    for name, ok in cases:
        mark = f'{C_OK}✓{C_OFF}' if ok else f'{C_BAD}✗{C_OFF}'
        print(f'  {mark} {name}')
    if failed:
        print(f'{C_BAD}✗ {len(failed)}/{len(cases)} 项不符{C_OFF}')
        return 1
    print(f'{C_OK}✓ {len(cases)} 项全部符合{C_OFF}')
    return 0


def main() -> int:
    """
    分派。
    @returns 退出码
    """
    if '--build' in sys.argv:
        return build()
    if '--check' in sys.argv:
        return check()
    if '--self-test' in sys.argv:
        return self_test()
    print(__doc__)
    return 1


if __name__ == '__main__':
    sys.exit(main())
