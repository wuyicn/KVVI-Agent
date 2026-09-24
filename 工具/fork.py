#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
`vendor/dsh` 的可重建交付（N1 + N2）。

## 它解决的问题

产品运行离不开 `vendor/dsh`（两个进程、五个 Skill、品牌插件、Bundle 都在里面），
而它在 `.gitignore` 里 —— **克隆本仓库得不到可运行的产品**。

本工具把「重建」变成一条**可验证**的命令：

    上游源码（干净副本） + 我们的 35 个文件  =  与指纹清单逐字节一致的 fork

## 为什么存**文件**而不是存补丁

两种都能做，选了后者：

| | 存补丁（`git diff`） | **存文件（本工具）** |
|---|---|---|
| 冲突 | 上游一变就可能打不上 | 覆盖即可 |
| 可读性 | 看不出最终样子 | 打开就是最终内容 |
| 验证 | 需要 patch 工具 | 逐文件 sha256 比对 |

真正的判据不是「补丁应用成功」，而是**结果与指纹逐字节一致**。
存文件让这个判据直接就是重建过程本身。

## ⚠️ 上游来源：默认用**本地**副本

`--upstream local`（默认）从 `vendor/dsh` 自己的 git 对象里导出基线提交的干净副本 ——
**不需要网络**。`--upstream git` 从 GitHub 克隆。

**本机当前无法访问 GitHub**（`git ls-remote` 超时），所以本次演练走的是 local 路径。
`git` 路径**未演练**，见 N23。

用法：

    python3 工具/fork.py --export                 # 把 35 个文件导出到 forks/dsh/变更/
    python3 工具/fork.py --rebuild --into /tmp/fork
    python3 工具/fork.py --verify  --into /tmp/fork
    python3 工具/fork.py --bundle  --out 交付/包/kvvi-delivery.tar.gz
"""

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tarfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DSH = os.path.join(ROOT, 'vendor', 'dsh')
MANIFEST = os.path.join(ROOT, 'forks', 'dsh', '改造点指纹.json')
CHANGES = os.path.join(ROOT, 'forks', 'dsh', '变更')

C_OK, C_BAD, C_WARN, C_DIM, C_OFF = '\033[32m', '\033[31m', '\033[33m', '\033[90m', '\033[0m'


def sh(cmd, cwd=None, timeout=1800):
    return subprocess.run(cmd, shell=True, cwd=cwd or ROOT, capture_output=True,
                          text=True, timeout=timeout)


def manifest() -> dict:
    with open(MANIFEST, encoding='utf-8') as fh:
        return json.load(fh)


def sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, 'rb') as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b''):
            h.update(chunk)
    return 'sha256:' + h.hexdigest()


# ── 导出：把我们的 35 个文件存进仓库 ─────────────────────────────────
def export() -> int:
    m = manifest()
    files = sorted(m['files'])
    if os.path.isdir(CHANGES):
        shutil.rmtree(CHANGES)
    for rel in files:
        src = os.path.join(DSH, rel)
        if not os.path.isfile(src):
            print('%s✗ 登记文件不存在：%s%s' % (C_BAD, rel, C_OFF))
            return 1
        dst = os.path.join(CHANGES, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(src, dst)
    os.chmod(CHANGES, 0o755)
    for base, dirs, names in os.walk(CHANGES):
        os.chmod(base, 0o755)
        for n in names:
            os.chmod(os.path.join(base, n), 0o644)
    total = sum(os.path.getsize(os.path.join(CHANGES, f)) for f in files)
    print('✓ 已导出 %d 个文件（%.0f KB）到 %s'
          % (len(files), total / 1024, os.path.relpath(CHANGES, ROOT)))
    print('  基线提交 %s' % m['upstream_merge_base'][:12])
    return 0


# ── 重建：上游干净副本 + 覆盖我们的文件 ──────────────────────────────
def pristine(upstream: str, into: str) -> bool:
    m = manifest()
    base = m['upstream_merge_base']
    if upstream == 'git':
        url = 'https://github.com/deepseek-ai/deepseek-harness.git'
        r = sh('git clone --quiet %s %s' % (url, into), timeout=3600)
        if r.returncode != 0:
            print('%s✗ 从上游克隆失败：%s%s' % (C_BAD, r.stderr.strip()[:200], C_OFF))
            return False
        r = sh('git checkout --quiet %s' % base, cwd=into)
        if r.returncode != 0:
            print('%s✗ 基线提交 %s 在克隆里不存在%s' % (C_BAD, base[:12], C_OFF))
            return False
        shutil.rmtree(os.path.join(into, '.git'), ignore_errors=True)
        return True

    # local：从 vendor/dsh 自己的对象里导出基线提交的干净副本。
    # 这条路**不需要网络**，但它证的是「重建逻辑对」，
    # 不是「GitHub 能连上」—— 后者见 N23。
    os.makedirs(into, exist_ok=True)
    r = sh('git archive %s | tar -x -C %s' % (base, into), cwd=DSH, timeout=900)
    if r.returncode != 0:
        print('%s✗ 从本地对象导出基线失败：%s%s' % (C_BAD, r.stderr.strip()[:200], C_OFF))
        return False
    return True


def rebuild(into: str, upstream: str) -> int:
    if os.path.exists(into):
        shutil.rmtree(into)
    os.makedirs(into)
    print('▸ 第 1 步：取上游干净副本（基线 %s，来源 %s）'
          % (manifest()['upstream_merge_base'][:12], upstream))
    if not pristine(upstream, into):
        return 1
    n_upstream = sum(len(fs) for _b, _d, fs in os.walk(into))
    print('  ✓ %d 个文件' % n_upstream)

    print('▸ 第 2 步：覆盖我们的改动')
    count = 0
    for base, _dirs, names in os.walk(CHANGES):
        for name in names:
            src = os.path.join(base, name)
            rel = os.path.relpath(src, CHANGES)
            dst = os.path.join(into, rel)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy2(src, dst)
            os.chmod(dst, 0o644)
            count += 1
    print('  ✓ %d 个文件' % count)

    print('▸ 第 3 步：逐字节比对指纹')
    return verify(into)


def verify(into: str) -> int:
    if not os.path.isdir(into):
        print('%s✗ 目录不存在：%s%s' % (C_BAD, into, C_OFF))
        return 2
    m = manifest()
    bad, missing, upstream_drift = [], [], []
    for rel, meta in sorted(m['files'].items()):
        want = 'sha256:' + meta['sha256']
        path = os.path.join(into, rel)
        if not os.path.isfile(path):
            missing.append(rel)
            continue
        got = sha256(path)
        if got == want:
            continue
        # 对**改上游**的文件，进一步区分「我们放错了」与「上游那个文件变了」：
        # 若重建结果等于**上游基线**的摘要，说明变更压根没应用上；
        # 两者都不等，说明上游的那份内容与我们改时的基线不同 —— 那才是真漂移。
        if meta.get('status') == 'M' and meta.get('upstream_baseline_sha256'):
            if got == 'sha256:' + meta['upstream_baseline_sha256']:
                bad.append((rel, '变更未应用（结果=上游基线）', got))
                continue
            upstream_drift.append((rel, got))
            continue
        bad.append((rel, want, got))
    ok = len(m['files']) - len(bad) - len(missing) - len(upstream_drift)
    print('  %s✓ %d/%d 个文件与指纹一致%s' % (C_OK, ok, len(m['files']), C_OFF))
    for r in missing[:5]:
        print('    %s✗ 缺失 %s%s' % (C_BAD, r, C_OFF))
    for r, why, _g in bad[:5]:
        print('    %s✗ %s：%s%s' % (C_BAD, r, why, C_OFF))
    for r, got in upstream_drift[:5]:
        print('    %s⚠ %s：重建结果既不是我们要的，也不是基线 —— '
              '**上游的那个文件变了**，需要重新对齐（这正是希望它大声失败的情形）%s'
              % (C_WARN, r, C_OFF))
    if bad or missing:
        print('%s✗ 重建结果与指纹不一致%s' % (C_BAD, C_OFF))
        return 1
    if upstream_drift:
        print('%s✗ 上游漂移：%d 个文件需要重新对齐%s'
              % (C_BAD, len(upstream_drift), C_OFF))
        return 1
    print('%s✓ 重建结果与指纹逐字节一致%s' % (C_OK, C_OFF))
    return 0


# ── 打包：自包含交付 tar ────────────────────────────────────────────
BUNDLE_INCLUDE = [
    'contracts', 'protocol', 'tools', 'services', '样例', '交付',
    'scripts', 'forks', 'docker-compose.kvvi.yml', 'package.json',
]
BUNDLE_SKIP = {'.git', 'node_modules', '__pycache__', '.venv', '.cache',
               'lib', 'dist', '.pytest_cache'}


def bundle(out: str, into: str) -> int:
    if not os.path.isdir(into):
        print('%s✗ 先跑 --rebuild（打包用的是**重建出来的** fork，不是工作副本）%s'
              % (C_BAD, C_OFF))
        return 2
    if verify(into) != 0:
        print('%s✗ 重建结果不可信，拒绝打包%s' % (C_BAD, C_OFF))
        return 1

    os.makedirs(os.path.dirname(out), exist_ok=True)
    written = 0
    with tarfile.open(out, 'w:gz') as tar:
        for rel in BUNDLE_INCLUDE:
            path = os.path.join(ROOT, rel)
            if os.path.isfile(path):
                tar.add(path, arcname=os.path.join('kvvi', rel))
                written += 1
                continue
            if not os.path.isdir(path):
                continue
            for base, dirs, names in os.walk(path):
                dirs[:] = [d for d in dirs if d not in BUNDLE_SKIP]
                for name in names:
                    full = os.path.join(base, name)
                    tar.add(full, arcname=os.path.join('kvvi', os.path.relpath(full, ROOT)))
                    written += 1
        # 重建出来的 fork —— **这是包能被跑起来的那一半**
        for base, dirs, names in os.walk(into):
            dirs[:] = [d for d in dirs if d not in BUNDLE_SKIP]
            for name in names:
                full = os.path.join(base, name)
                tar.add(full, arcname=os.path.join(
                    'kvvi', 'vendor', 'dsh', os.path.relpath(full, into)))
                written += 1

    size = os.path.getsize(out)
    print('✓ 已打包 %s' % os.path.relpath(out, ROOT))
    print('  条目 %d 个，%.1f MB' % (written, size / 1024 / 1024))
    print('  含 vendor/dsh（重建产物）—— 解压即可运行，不需要联网')
    evidence = os.path.join(ROOT, '交付', '证据', '交付包构建.json')
    os.makedirs(os.path.dirname(evidence), exist_ok=True)
    with open(evidence, 'w', encoding='utf-8') as fh:
        fh.write(json.dumps({
            'check': 'delivery-bundle',
            'file': os.path.relpath(out, ROOT),
            'entries': written, 'bytes': size,
            'sha256': hashlib.sha256(open(out, 'rb').read()).hexdigest(),
            'forkUpstream': 'local-archive',
            'note': 'fork 取自**重建产物**而非工作副本；重建结果已与指纹逐字节比对。',
        }, ensure_ascii=False, indent=2) + '\n')
    print('  ✓ 证据已写入 %s' % os.path.relpath(evidence, ROOT))
    return 0


def main() -> int:
    args = sys.argv[1:]
    if '--export' in args:
        return export()
    if '--rebuild' in args:
        into = args[args.index('--into') + 1] if '--into' in args else '/tmp/kvvi-fork'
        upstream = args[args.index('--upstream') + 1] if '--upstream' in args else 'local'
        return rebuild(into, upstream)
    if '--verify' in args:
        into = args[args.index('--into') + 1] if '--into' in args else '/tmp/kvvi-fork'
        return verify(into)
    if '--bundle' in args:
        out = args[args.index('--out') + 1] if '--out' in args else \
            os.path.join(ROOT, '交付', '包', 'kvvi-delivery.tar.gz')
        into = args[args.index('--into') + 1] if '--into' in args else '/tmp/kvvi-fork'
        return bundle(out, into)
    print(__doc__)
    return 2


if __name__ == '__main__':
    sys.exit(main())
