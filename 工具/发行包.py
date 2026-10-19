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

    python3 工具/发行包.py --build --runtime-source /absolute/qualified-dsh --git-objects /absolute/dsh-objects
    python3 工具/发行包.py --check --runtime-source /absolute/qualified-dsh --git-objects /absolute/dsh-objects
    python3 工具/发行包.py --self-test        # 反向测试：逐项破坏，必须变红
"""

import hashlib
import argparse
import importlib.util
import io
import json
import os
import re
import shutil
import sys
import tarfile
import tempfile
import subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)
from 工具.lib.package_outputs import PublicationError, output_guard, publish_pair
from 工具.lib.package_inventory import (InventoryError, VERSION, INTERNAL, MAX_MANIFEST_BYTES,
    snapshot, validate_rows, internal_manifest, verify_archive, load_json, validate_source_qualification, bind_fixed_source_rows, fixed_source_index, regular_entry_paths)
from 工具.lib.package_provenance import qualify_runtime_source
from 工具.lib.package_client import qualify_client_outputs, client_row_index, bind_client_rows, artifact_snapshots
from 工具.lib.package_policy import should_skip, PORTABLE_DEPENDENCIES
OUT_DIR = os.path.join(ROOT, '交付', '发行')
ARCHIVE = os.path.join(OUT_DIR, 'kvvi-macos-pilot.tar.gz')
MANIFEST = os.path.join(OUT_DIR, '发行包清单.json')
RUNTIME_SOURCE = None  # Always explicitly selected; vendor/dsh is only the archive destination.
GIT_OBJECTS = None

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
    'docs/操作手册.md',
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
# The executable policy lives in package_policy.py and is shared with build binding.

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
# PORTABLE_DEPENDENCIES is imported from the same shared policy.

#: 只保留构建产物、不保留源码树里的临时文件。
# Suffix filtering is also defined by the shared policy.

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
    'vendor/dsh/.dsh-build/client-build-environment.json',
    'contracts/meta-schemas/0a-full-r1/business-schema.v1.schema.json',
    '安装手册.md',
    'docs/操作手册.md',
    'README.md',
]


def runtime_source_root():
    try:
        selected = os.fspath(RUNTIME_SOURCE)
        if not isinstance(selected, str) or not selected or not os.path.isabs(selected) or '..' in selected.split(os.sep):
            raise InventoryError('PACKAGE_RUNTIME_SOURCE_REQUIRED_OR_INVALID')
        selected = os.path.normpath(selected)
        if os.path.islink(selected) or not os.path.isdir(selected):
            raise InventoryError('PACKAGE_RUNTIME_SOURCE_REQUIRED_OR_INVALID')
        return selected
    except TypeError:
        raise InventoryError('PACKAGE_RUNTIME_SOURCE_REQUIRED_OR_INVALID') from None


def selected_source_qualification():
    result = qualify_runtime_source(runtime_source_root(),GIT_OBJECTS,os.path.join(ROOT,'forks/dsh/改造点指纹.json'),include_source_rows=True)
    if result.get('valid') is not True:
        raise InventoryError('PACKAGE_FIXED_SOURCE_REJECTED')
    source_rows = result.pop('sourceRows',None)
    fixed_source_index(source_rows,result)
    return result,source_rows


def selected_client_qualification(source_qualification):
    result = qualify_client_outputs(runtime_source_root(),GIT_OBJECTS,os.path.join(ROOT,'forks/dsh/改造点指纹.json'),include_artifact_rows=True)
    if result.get('valid') is not True or result.get('sourceQualification') != source_qualification:
        raise InventoryError('PACKAGE_CLIENT_RECEIPT_REJECTED')
    client_rows = result.pop('clientRows',None)
    client_row_index(client_rows,result)
    return result,client_rows


def bind_selected_source(rows, source_rows, qualification):
    root = runtime_source_root()
    included = set()
    for path, kind, _ in source_rows:
        probe = path + '/' if kind == 'symlink' and os.path.isdir(os.path.join(root,path)) else path
        if not should_skip('vendor/dsh',probe): included.add(path)
    bind_fixed_source_rows(rows,source_rows,qualification,included)


def collect() -> list:
    """
    收集要进包的文件。
    @returns `[(绝对路径, 包内相对路径)]`
    """
    entries = []
    def direct_parents(relative, include_last):
        parts = relative.split('/') if include_last else relative.split('/')[:-1]
        parent = ROOT
        for part in parts:
            parent = os.path.join(parent, part)
            if os.path.islink(parent) or not os.path.isdir(parent):
                raise InventoryError('PACKAGE_SOURCE_PARENT_INVALID')
    for source_rel, into_rel in CONTENTS:
        if source_rel == 'vendor/dsh':
            source = runtime_source_root()
        else:
            direct_parents(source_rel, True)
            source = os.path.join(ROOT, source_rel)
        if not os.path.isdir(source):
            raise InventoryError('PACKAGE_SOURCE_DIRECTORY_MISSING')
        def walk_error(error):
            raise error
        for base, dirs, files in os.walk(source, onerror=walk_error):
            dirs[:] = [d for d in dirs if not should_skip(
                source_rel, os.path.relpath(os.path.join(base, d), source) + '/')]
            for name in list(dirs):
                absolute = os.path.join(base, name)
                if os.path.islink(absolute):
                    entries.append((absolute, os.path.join(into_rel, os.path.relpath(absolute, source))))
                    dirs.remove(name)
            for name in files:
                absolute = os.path.join(base, name)
                rel = os.path.relpath(absolute, source)
                if should_skip(source_rel, rel):
                    continue
                entries.append((absolute, os.path.join(into_rel, rel)))
    for extra in EXTRA_FILES:
        direct_parents(extra, False)
        absolute = os.path.join(ROOT, extra)
        if os.path.lexists(absolute):
            entries.append((absolute, extra))
    return sorted(entries, key=lambda pair: pair[1])


def build() -> int:
    """Build a candidate without truncating the previous published pair."""
    try:
        runtime_source_root()
        with output_guard(ARCHIVE, MANIFEST):
            source_qualification, source_rows = selected_source_qualification()
            client_qualification, client_rows = selected_client_qualification(source_qualification)
            if os.path.abspath(OUT_DIR) != os.path.dirname(os.path.abspath(ARCHIVE)):
                raise PublicationError('PACKAGE_OUTPUT_INVALID')
            if packages_missing_main(source_rows):
                raise InventoryError('PACKAGE_RUNTIME_MAIN_MISSING')
            entries = collect()
            print(f'{C_OK}=== 打包 ==={C_OFF}')
            print(f'  收进 {len(entries)} 个文件')
            missing = scan_required(entries)
            if missing:
                for path in missing:
                    print(f'{C_BAD}✗ 缺必需文件：{path}{C_OFF}')
                return 1
            rows = []
            with tempfile.TemporaryDirectory(prefix='kvvi-package-candidate-', dir=OUT_DIR) as candidate:
                pending_archive = os.path.join(candidate, 'candidate.tar.gz')
                pending_manifest = os.path.join(candidate, 'candidate-manifest.json')
                with tarfile.open(pending_archive, 'w:gz') as tar:
                    for absolute, rel in entries:
                        row, body = snapshot(absolute, rel)
                        for pattern, what in FORBIDDEN:
                            if body is not None and pattern.search(body):
                                print(f'{C_BAD}✗ 包中禁止内容：{rel} —— {what}{C_OFF}')
                                return 1
                        rows.append(row)
                        info = tarfile.TarInfo(TOP + '/' + rel)
                        info.uid = info.gid = 0; info.uname = info.gname = 'root'
                        info.mode = row['mode']
                        if row['type'] == 'file': info.size = len(body)
                        else: info.type = tarfile.SYMTYPE; info.linkname = row['target']
                        # The scanned snapshot is exactly the body supplied to tar.
                        tar.addfile(info, io.BytesIO(body) if body is not None else None)
                    internal = internal_manifest(rows,source_qualification,client_qualification)
                    bind_selected_source(rows,source_rows,source_qualification)
                    bind_client_rows(rows,client_rows,client_qualification)
                    if any(row['type'] != 'file' for row in rows if row['path'] in REQUIRED):
                        raise InventoryError('PACKAGE_REQUIRED_FILE_INVALID')
                    payload = json.dumps(internal, ensure_ascii=False, indent=2).encode('utf-8')
                    info = tarfile.TarInfo(TOP + '/' + INTERNAL); info.size = len(payload); info.mode = 0o644
                    info.uname = info.gname = 'root'
                    tar.addfile(info, io.BytesIO(payload))
                with tarfile.open(pending_archive, 'r:gz') as tar:
                    verify_archive(tar, TOP, rows, internal)
                size = os.path.getsize(pending_archive) / (1024 ** 2)
                with open(pending_manifest, 'w', encoding='utf-8') as handle:
                    json.dump(dict(internal, archive=os.path.relpath(ARCHIVE, ROOT),
                        archiveSha256=sha256_of(pending_archive), archiveBytes=os.path.getsize(pending_archive)),
                        handle, ensure_ascii=False, indent=2)
                    handle.write('\n')
                after_qualification, after_source_rows = selected_source_qualification()
                if after_qualification != source_qualification:
                    raise InventoryError('PACKAGE_FIXED_SOURCE_CHANGED')
                bind_selected_source(rows,after_source_rows,after_qualification)
                after_client, after_client_rows = selected_client_qualification(after_qualification)
                if after_client != client_qualification:
                    raise InventoryError('PACKAGE_CLIENT_RECEIPT_CHANGED')
                bind_client_rows(rows,after_client_rows,after_client)
                if packages_missing_main(after_source_rows,candidate_rows=rows):
                    raise InventoryError('PACKAGE_CANDIDATE_MAIN_MISSING')
                publish_pair(pending_archive, pending_manifest, ARCHIVE, MANIFEST)
    except (PublicationError, InventoryError, OSError, ValueError, tarfile.TarError) as error:
        code = str(error) if isinstance(error, (PublicationError, InventoryError)) else 'PACKAGE_BUILD_FAILED'
        print(f'{C_BAD}✗ {code}{C_OFF}')
        return 1
    print(f'{C_OK}✓ {os.path.relpath(ARCHIVE, ROOT)}（{size:.1f} MB，'
          f'{len(entries)} 个文件）{C_OFF}')
    print(f"  内容指纹 {internal['contentDigest'][:32]}")
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
    """Count nested lib/types JavaScript only in the explicitly selected runtime."""
    root = runtime_source_root(); count = 0
    def walk_error(error):
        raise error
    for base, dirs, files in os.walk(root, onerror=walk_error):
        dirs[:] = [d for d in dirs if d not in ('node_modules', '.git')]
        rel = '/' + os.path.relpath(base, root).replace(os.sep, '/') + '/'
        if '/lib/types/' in rel:
            count += sum(1 for name in files if name.endswith('.js'))
    return count


def packages_missing_main(source_rows=None, candidate_rows=None) -> list:
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

    @returns `['dsh-xxx → path/lib/index.js', …]`
    """
    root = runtime_source_root()
    if candidate_rows is None:
        selected_entries = {os.path.abspath(absolute):rel for absolute, rel in collect() if rel.startswith('vendor/dsh/')}
        available = {absolute for absolute in selected_entries if os.path.isfile(absolute)}
    else:
        selected_entries = {os.path.abspath(os.path.join(root,row['path'][len('vendor/dsh/'):])):row['path'] for row in candidate_rows if row['path'].startswith('vendor/dsh/')}
        available = {os.path.abspath(os.path.join(root,path[len('vendor/dsh/'):])) for path in regular_entry_paths(candidate_rows) if path.startswith('vendor/dsh/')}
    fixed = {path:(kind,digest) for path,kind,digest in source_rows} if source_rows is not None else None
    def metadata(path):
        relative = selected_entries.get(os.path.abspath(path))
        if relative is None:
            raise InventoryError('PACKAGE_RUNTIME_MANIFEST_NOT_COLLECTED')
        row, body = snapshot(path, relative, max_bytes=MAX_MANIFEST_BYTES)
        if row['type'] != 'file':
            raise InventoryError('PACKAGE_RUNTIME_MANIFEST_NOT_REGULAR')
        if fixed is not None and fixed.get(relative[len('vendor/dsh/'):]) != ('file',row['sha256'][7:]):
            raise InventoryError('PACKAGE_RUNTIME_METADATA_SOURCE_MISMATCH')
        return body
    def source_manifest(body):
        # Source package.json is interpreted by Node. Only top-level selection
        # fields are used here; nested dependency maps retain Node's semantics.
        # Artifact manifests still use load_json's strict duplicate rejection.
        class Object(dict):
            pass
        def pairs(items):
            result = Object(); result.duplicate = False
            for key, value in items:
                if key in result: result.duplicate = True
                result[key] = value
            return result
        def invalid_constant(_):
            raise ValueError()
        try:
            if len(body) > MAX_MANIFEST_BYTES: raise ValueError()
            value = json.loads(body.decode('utf-8'), object_pairs_hook=pairs, parse_constant=invalid_constant)
            if not isinstance(value, Object) or value.duplicate: raise ValueError()
            return value
        except (ValueError, UnicodeError, RecursionError):
            raise InventoryError('PACKAGE_RUNTIME_MANIFEST_INVALID') from None
    root_manifest = source_manifest(metadata(os.path.join(root, 'package.json')))
    if not isinstance(root_manifest, dict) or not isinstance(root_manifest.get('workspaces'), list):
        raise InventoryError('PACKAGE_WORKSPACE_LAYOUT_UNSUPPORTED')
    patterns = root_manifest['workspaces'][:]
    # This fixed source uses a top-level plain packages list. Reject other YAML
    # selection syntax rather than silently interpreting a partial workspace set.
    raw = metadata(os.path.join(root, 'pnpm-workspace.yaml')).decode('utf-8')
    active = False; found = False
    for line in raw.splitlines():
        if line.lstrip().startswith('#'): continue
        text = re.split(r'\s+#', line, maxsplit=1)[0].rstrip()
        if not text.strip(): continue
        if '\t' in text: raise InventoryError('PACKAGE_WORKSPACE_LAYOUT_UNSUPPORTED')
        if not text.startswith(' '):
            if not re.fullmatch(r'[A-Za-z][A-Za-z0-9]*:', text):
                raise InventoryError('PACKAGE_WORKSPACE_LAYOUT_UNSUPPORTED')
            active = text == 'packages:'
            if active:
                if found: raise InventoryError('PACKAGE_WORKSPACE_LAYOUT_UNSUPPORTED')
                found = True
        elif active:
            match = re.fullmatch(r'  - ([A-Za-z0-9_./*?-]+)', text)
            if not match: raise InventoryError('PACKAGE_WORKSPACE_LAYOUT_UNSUPPORTED')
            patterns.append(match[1])
    if not found or not patterns:
        raise InventoryError('PACKAGE_WORKSPACE_LAYOUT_UNSUPPORTED')
    for pattern in patterns:
        if not isinstance(pattern, str) or not all(re.fullmatch(r'[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*|\*', part) for part in pattern.split('/')):
            raise InventoryError('PACKAGE_WORKSPACE_LAYOUT_UNSUPPORTED')
    import glob
    manifests = {os.path.join(root, 'package.json')}
    if fixed is None:
        for pattern in patterns:
            manifests.update(glob.glob(os.path.join(glob.escape(root), pattern, 'package.json')))
    else:
        for path in fixed:
            if not path.endswith('/package.json'): continue
            components = path.split('/')[:-1]
            if any(len(components) == len(pattern.split('/')) and all(want == '*' or want == part for part,want in zip(components,pattern.split('/'))) for pattern in patterns):
                manifests.add(os.path.join(root,path))
    out = []
    for manifest in sorted(manifests):
        payload = source_manifest(metadata(manifest))
        if not isinstance(payload, dict): raise InventoryError('PACKAGE_RUNTIME_MANIFEST_INVALID')
        if 'main' not in payload: continue
        main = payload['main']
        if not isinstance(main, str) or not main:
            raise InventoryError('PACKAGE_RUNTIME_MAIN_INVALID')
        package_dir = os.path.dirname(manifest)
        portable = main[2:] if main.startswith('./') else main
        safe = not portable.startswith('/') and '\\' not in portable and all(part not in ('', '.', '..') for part in portable.split('/'))
        entry = os.path.join(package_dir, portable)
        if not safe or not os.path.isfile(entry) or os.path.abspath(entry) not in available:
            rel = 'vendor/dsh/' + os.path.relpath(package_dir, root)
            out.append(f"{payload.get('name')} → {rel}/{main}")
    return sorted(out)


def check() -> int:
    try:
        runtime_source_root()
        if not os.path.isdir(OUT_DIR):
            print(f'{C_BAD}✗ 发行包不存在（先跑 --build）{C_OFF}')
            return 2
        with output_guard(ARCHIVE, MANIFEST):
            return _check_existing()
    except (PublicationError, InventoryError, OSError, ValueError, TypeError, KeyError, RecursionError, tarfile.TarError, EOFError):
        print(f'{C_BAD}✗ PACKAGE_OUTPUT_UNAVAILABLE_OR_RECOVERY_REQUIRED{C_OFF}')
        return 1


def _check_existing() -> int:
    """
    校验已有发行包。
    @returns 退出码
    """
    if not os.path.isfile(ARCHIVE) or not os.path.isfile(MANIFEST):
        print(f'{C_BAD}✗ 发行包不存在（先跑 --build）{C_OFF}')
        return 2
    with open(MANIFEST, 'rb') as handle:
        manifest = load_json(handle.read(MAX_MANIFEST_BYTES + 1))
    fields = {'bundleVersion','archive','fileCount','contentDigest','entries','archiveSha256','archiveBytes','sourceQualification','clientQualification'}
    if not isinstance(manifest, dict) or set(manifest) != fields or manifest['bundleVersion'] != VERSION:
        raise InventoryError('PACKAGE_MANIFEST_VERSION_OR_SHAPE_INVALID')
    source_qualification, source_rows = selected_source_qualification()
    client_qualification, client_rows = selected_client_qualification(source_qualification)
    if client_qualification != manifest['clientQualification']:
        raise InventoryError('PACKAGE_CLIENT_BINDING_MISMATCH')
    if source_qualification != manifest['sourceQualification']:
        raise InventoryError('PACKAGE_FIXED_SOURCE_BINDING_MISMATCH')
    validate_rows(manifest['entries'])
    if type(manifest['fileCount']) is not int or manifest['fileCount'] != len(manifest['entries']):
        raise InventoryError('PACKAGE_MANIFEST_COUNT_INVALID')
    if type(manifest['archiveBytes']) is not int or manifest['archiveBytes'] != os.path.getsize(ARCHIVE) or manifest['archive'] != os.path.relpath(ARCHIVE, ROOT):
        raise InventoryError('PACKAGE_MANIFEST_ARCHIVE_INVALID')
    if manifest['archiveSha256'] != sha256_of(ARCHIVE):
        raise InventoryError('PACKAGE_ARCHIVE_DIGEST_MISMATCH')
    internal = internal_manifest(manifest['entries'],manifest['sourceQualification'],manifest['clientQualification'])
    bind_selected_source(manifest['entries'],source_rows,source_qualification)
    bind_client_rows(manifest['entries'],client_rows,client_qualification)
    if internal['contentDigest'] != manifest['contentDigest']:
        raise InventoryError('PACKAGE_INVENTORY_DIGEST_MISMATCH')
    with tarfile.open(ARCHIVE, 'r:gz') as tar:
        verify_archive(tar, TOP, manifest['entries'], internal)
    rows = []
    for absolute, rel in collect():
        row, body = snapshot(absolute, rel)
        if body is not None and any(pattern.search(body) for pattern, _ in FORBIDDEN):
            raise InventoryError('PACKAGE_SOURCE_FORBIDDEN')
        rows.append(row)
    validate_rows(rows)
    if rows != manifest['entries']:
        raise InventoryError('PACKAGE_SOURCE_INVENTORY_MISMATCH')
    regular = {row['path'] for row in rows if row['type'] == 'file'}
    if any(path not in regular for path in REQUIRED) or packages_missing_main(source_rows,candidate_rows=rows):
        raise InventoryError('PACKAGE_REQUIRED_FILE_OR_MAIN_MISSING')
    for row in rows:
        name = row['path']
        if '/node_modules/' in '/' + name + '/' and not any(name.startswith(keep + '/') for keep in PORTABLE_DEPENDENCIES):
            raise InventoryError('PACKAGE_RUNTIME_DEPENDENCY_FORBIDDEN')
    after_qualification, after_source_rows = selected_source_qualification()
    if after_qualification != source_qualification:
        raise InventoryError('PACKAGE_FIXED_SOURCE_CHANGED')
    bind_selected_source(rows,after_source_rows,after_qualification)
    after_client, after_client_rows = selected_client_qualification(after_qualification)
    if after_client != client_qualification: raise InventoryError('PACKAGE_CLIENT_RECEIPT_CHANGED')
    bind_client_rows(rows,after_client_rows,after_client)
    print(f'{C_OK}=== 发行包复核 ==={C_OFF}')
    print(f'  {os.path.relpath(ARCHIVE, ROOT)}：{len(rows)} 个源条目')
    print(f"  内容指纹 {internal['contentDigest'][:32]}")
    print(f'  {C_OK}✓ 归档实际成员、内外清单与当前源条目一致{C_OFF}')
    return 0


def _self_test_fixture() -> int:
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


def self_test() -> int:
    """Run destructive probes only on a generated disposable source/package pair."""
    from pathlib import Path
    with tempfile.TemporaryDirectory(prefix='kvvi-package-self-test-') as temporary:
        root = Path(temporary)
        spec = importlib.util.spec_from_file_location('_owned_package_self_test', __file__)
        fixture = importlib.util.module_from_spec(spec); spec.loader.exec_module(fixture)
        fixture.ROOT = str(root); fixture.OUT_DIR = str(root / 'out')
        fixture.RUNTIME_SOURCE = str(root / 'vendor/dsh')
        fixture.ARCHIVE = str(root / 'out/pilot.tar.gz'); fixture.MANIFEST = str(root / 'out/manifest.json')
        for source, _ in fixture.CONTENTS:
            (root / source).mkdir(parents=True, exist_ok=True)
        for rel in fixture.REQUIRED + fixture.EXTRA_FILES + ['vendor/dsh/packages/fixture/build/lib/types/probe.js']:
            if Path(rel).is_absolute() or '..' in Path(rel).parts:
                return 1
            path = root / rel; path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('{}\n' if path.suffix == '.json' else 'fixture source\n', encoding='utf-8')
        workspaces = ['vendor/*','packages/*/*','native/system','native/system/packages/*','apps/*','benchmarks','website','python/sdk-runtime']
        (root / 'vendor/dsh/package.json').write_text(json.dumps({'version':'1.0.0','workspaces':workspaces}))
        (root / 'vendor/dsh/pnpm-workspace.yaml').write_text('packages:\n' + ''.join('  - ' + path + '\n' for path in workspaces))
        vite = root / 'vendor/dsh/apps/web/vite.config.ts'; vite.parent.mkdir(parents=True,exist_ok=True); vite.write_text('// owned client layout')
        objects = root / 'source-objects'; shutil.copytree(fixture.RUNTIME_SOURCE,objects,symlinks=True,ignore=shutil.ignore_patterns('.dsh-build'))
        environment = {**os.environ,'GIT_CONFIG_GLOBAL':os.devnull,'GIT_CONFIG_SYSTEM':os.devnull}
        def git(*arguments):
            return subprocess.run(['git','-C',str(objects),*arguments],env=environment,check=True,
                stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True).stdout.strip()
        git('init','--quiet'); git('add','--all')
        git('-c','user.name=Package Self Test','-c','user.email=package@example.invalid','-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false','commit','--quiet','-m','owned source')
        trusted = root / 'forks/dsh/改造点指纹.json'; trusted.parent.mkdir(parents=True)
        head = git('rev-parse','HEAD')
        trusted.write_text(json.dumps({'upstream_merge_base':head,'fork_head':head,'count':0,'files':{}}))
        fixture.GIT_OBJECTS = str(objects)
        web = root / 'vendor/dsh/apps/web/dist/index.html'; web.parent.mkdir(parents=True); web.write_bytes(b'<html>owned self-test</html>')
        client_rows, client_digest = artifact_snapshots(root / 'vendor/dsh')
        receipt = root / 'vendor/dsh/.dsh-build/client-build-environment.json'; receipt.parent.mkdir(exist_ok=True)
        receipt.write_text(json.dumps({'formatVersion':1,'environment':{'DSH_CLIENT_COMMIT_HASH':head[:7],'DSH_CLIENT_VERSION':'1.0.0'},
                                      'artifacts':{'fileCount':len(client_rows),'sha256':client_digest}}))
        if fixture.build() != 0:
            return 1
        return fixture._self_test_fixture()


def main() -> int:
    """
    分派。
    @returns 退出码
    """
    parser = argparse.ArgumentParser(description='构建或核验发行包；runtime-source 必须显式指定绝对路径。')
    actions = parser.add_mutually_exclusive_group(required=True)
    actions.add_argument('--build', action='store_true')
    actions.add_argument('--check', action='store_true')
    actions.add_argument('--self-test', action='store_true')
    parser.add_argument('--runtime-source')
    parser.add_argument('--git-objects')
    args = parser.parse_args()
    if args.self_test:
        if args.runtime_source is not None or args.git_objects is not None:
            parser.error('--self-test 使用独立合成源码及Git对象，不接受来源参数')
        return self_test()
    if args.runtime_source is None or args.git_objects is None:
        parser.error('--build/--check 必须显式指定 --runtime-source 和 --git-objects')
    global RUNTIME_SOURCE, GIT_OBJECTS
    RUNTIME_SOURCE = args.runtime_source; GIT_OBJECTS = args.git_objects
    return build() if args.build else check()



if __name__ == '__main__':
    sys.exit(main())
