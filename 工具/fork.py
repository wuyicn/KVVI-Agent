#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
`vendor/dsh` 的可重建交付（N1 + N2）。

## 它解决的问题

产品运行离不开 `vendor/dsh`（两个进程、五个 Skill、品牌插件、Bundle 都在里面），
而它在 `.gitignore` 里 —— **克隆本仓库得不到可运行的产品**。

本工具把「重建」变成一条**可验证**的命令：

    固定基线（干净副本） + 登记改动 − 登记删除  =  与指纹清单逐字节一致的 fork

## 为什么存**文件**而不是存补丁

两种都能做，选了后者：

| | 存补丁（`git diff`） | **存文件（本工具）** |
|---|---|---|
| 冲突 | 上游一变就可能打不上 | 覆盖即可 |
| 可读性 | 看不出最终样子 | 打开就是最终内容 |
| 验证 | 需要 patch 工具 | 逐文件 sha256 比对 |

真正的判据不是「补丁应用成功」，而是**结果与指纹逐字节一致**。
存文件让这个判据直接就是重建过程本身。

## 「删除」怎么表达

改动里有 **8 条是删除**（清内测欢迎提示时删掉的文件）。文件存不进镜像 ——
删掉的东西没有内容可存 —— 所以镜像里另放一份**删除记录**：

    forks/dsh/变更/.删除的路径.json   {"deleted": [相对路径, ...]}

它是从指纹清单里 `status == "D"` 的条目生成的（清单由
`工具/g2_改造点.py --manifest` 生成，`--rebuild` 时再与清单交叉核对一遍）。

**过去的两个缺陷，为什么必须两件一起修**：

- 不表达删除 → 重建出的 fork 把那 8 个**本该被删掉的文件留在原地**，交付包一直带着
  不该有的东西，而 `--verify` 只看登记文件、看不见这种残留；
- 导出中途失败 → 重建的 fork 里留着上一次改动过的文件，而它不在清单里，
  `--verify` 照样报绿 —— **这就是缺陷①真正危险的地方**，不是「少了文件」。
  两者都会让 `--verify` 的绿是假绿，所以它现在同时校验「该在的在」「该没的没」「没多余的」。

## ⚠️ 上游来源：默认用**本地**副本

`--upstream local`（默认）从 `vendor/dsh` 自己的 git 对象里导出基线提交的干净副本 ——
**不需要网络**。`--upstream git` 从本仓库的 `vendor-dsh` 分支取得源码，
再检出指纹清单固定的导入基线。该基线是 KVVI 自己的导入提交，不在官方 DSH 仓库里；
分支仅提供 Git 对象，重建仍使用固定提交加登记的变更，不使用分支最新代码。

用法：

    python3 工具/fork.py --export                 # 把改动导出到 forks/dsh/变更/（先建成、再替换）
    python3 工具/fork.py --export --into /tmp/m   # 导到别处（自测用；语义与上面完全相同）
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

# 删除记录。放在镜像目录里（而不是另开一个文件），这样「改动集」是一个自洽的整体。
DELETED = '.删除的路径.json'

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


# ── 导出：把我们的改动存进仓库 ─────────────────────────────────────
def normalize_modes(base_dir: str) -> None:
    """目录 755 / 文件 644 —— 交付包的权限不该取决于导出机的 umask。"""
    for base, _dirs, names in os.walk(base_dir):
        os.chmod(base, 0o755)
        for n in names:
            os.chmod(os.path.join(base, n), 0o644)
    os.chmod(base_dir, 0o755)


def read_deletions(changes: str = CHANGES, manifest_deleted=None):
    """读镜像里的删除记录。返回 (路径列表, 错误说明)。

    为什么「记录丢了」要报错、而不是拿指纹清单兜住：清单里的 `status == "D"`
    确实是删除的第二份记录，但它**不在改动集里** —— 只依赖它，等于「删除这件事
    没有随交付一起走」。实测拆掉 `--export` 写记录那一段后，镜像里没有记录、
    `--rebuild` 仍用清单兜住、`--verify` 照样报 8/8 删除已生效 —— 一个**假绿**：
    记录的丢失完全不可见。清单有 D 而镜像没有记录，就是这两份记录对不上，
    必须响亮失败（这条路径由自测的 ⑧ 钉住）。
    """
    path = os.path.join(changes, DELETED)
    if not os.path.isfile(path):
        if manifest_deleted:
            return [], ('改动集里没有删除记录（%s），但指纹清单里有 %d 条 status=="D" '
                        '—— 两份记录对不上' % (DELETED, len(manifest_deleted)))
        return [], None
    try:
        with open(path, encoding='utf-8') as fh:
            doc = json.load(fh)
    except Exception as exc:
        return [], '%s 读不出来：%s' % (DELETED, exc)
    rows = doc.get('deleted')
    if not isinstance(rows, list):
        return [], '%s 里没有 deleted 数组' % DELETED
    return [str(r) for r in rows], None


def export(changes: str = CHANGES, dsh: str = DSH, man: str = None) -> int:
    """
    导出改动到 `changes`。**先建成、再替换。**

    为什么必须这样：旧版本先 `rmtree(changes)` 再逐个复制，于是
    「登记表里有、DSH 里没有」的第 129 个文件（实测）会让它中途退出 ——
    镜像已经是个空壳，76 个文件没了。**一个失败的导出不该有破坏性副作用。**

    所以：全部校验 → 全部写进兄弟目录 `.new-*` → 原子替换。
    失败发生在替换之前的任何一步，旧镜像**一个字节都没动**。
    """
    m = manifest() if man is None else man
    files = sorted(m['files'])
    deleted_paths = sorted(rel for rel, meta in m['files'].items()
                           if meta.get('status') == 'D')

    # ── 第 1 步：全量校验。此步只读，不动镜像 ────────────────────────
    for rel in files:
        src = os.path.join(dsh, rel)
        exists = os.path.isfile(src)
        if m['files'][rel].get('status') == 'D':
            if exists:
                # 清单说它已删，DSH 里却还在：清单与代码不一致。
                # **响亮地失败**，而不是悄悄跳过 —— 悄悄跳过等于把一个
                # 上游文件留在交付包里，且此后没有任何一步会再看见它。
                print('%s✗ 清单标为「删除」，但 DSH 里文件还在：%s%s'
                      % (C_BAD, rel, C_OFF))
                print('  %s→ 要么真的删掉它，要么重新生成指纹（工具/g2_改造点.py '
                      '--manifest）；两者都不做就是在交付一个不该有的文件%s' % (C_DIM, C_OFF))
                return 1
            continue
        if not exists:
            print('%s✗ 登记文件不存在：%s%s' % (C_BAD, rel, C_OFF))
            print('  %s→ 镜像未被改动（校验全部通过才开始写）%s' % (C_DIM, C_OFF))
            return 1

    # ── 第 2 步：建到兄弟目录。父目录相同才能用 rename 原子替换 ──────
    parent = os.path.dirname(os.path.abspath(changes)) or '.'
    os.makedirs(parent, exist_ok=True)
    staging = os.path.join(parent, '.fork-变更.new-%d' % os.getpid())
    if os.path.exists(staging):
        shutil.rmtree(staging)
    written = 0
    try:
        for rel in files:
            if m['files'][rel].get('status') == 'D':
                continue
            dst = os.path.join(staging, rel)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy2(os.path.join(dsh, rel), dst)
            written += 1
        with open(os.path.join(staging, DELETED), 'w', encoding='utf-8') as fh:
            fh.write(json.dumps({
                'note': '由 工具/fork.py --export 从指纹清单里 status=="D" 的条目生成，'
                        '禁止手改。重建时先覆盖、再按本表删除。',
                'deleted': deleted_paths,
            }, ensure_ascii=False, indent=2, sort_keys=True) + '\n')
        normalize_modes(staging)
    except Exception as exc:
        shutil.rmtree(staging, ignore_errors=True)
        print('%s✗ 导出失败（%s）—— 原有镜像未被触碰%s' % (C_BAD, exc, C_OFF))
        return 1

    # ── 第 3 步：原子替换。老镜像先挪开，新镜像再就位 ────────────────
    old = os.path.join(parent, '.fork-变更.old-%d' % os.getpid())
    shutil.rmtree(old, ignore_errors=True)
    if os.path.exists(changes):
        os.replace(changes, old)
    try:
        os.replace(staging, changes)
    except Exception as exc:
        if os.path.exists(old):          # 新镜像没就位 → 把旧镜像放回去
            os.replace(old, changes)
        shutil.rmtree(staging, ignore_errors=True)
        print('%s✗ 替换镜像失败（%s）—— 已回滚到原有镜像%s' % (C_BAD, exc, C_OFF))
        return 1
    shutil.rmtree(old, ignore_errors=True)

    size = sum(os.path.getsize(os.path.join(changes, r)) for r in files
               if m['files'][r].get('status') != 'D')
    print('✓ 已导出 %d 个文件（%.0f KB），%d 条删除记录，到 %s'
          % (written, size / 1024, len(deleted_paths), os.path.relpath(changes, ROOT)))
    print('  基线提交 %s' % m['upstream_merge_base'][:12])
    return 0


# ── 重建：上游干净副本 + 覆盖我们的文件 ──────────────────────────────
def pristine(upstream: str, into: str) -> bool:
    m = manifest()
    base = m['upstream_merge_base']
    if upstream == 'git':
        url = 'https://github.com/wuyicn/KVVI-Agent.git'
        r = sh('git clone --quiet --single-branch --branch vendor-dsh %s %s'
               % (url, into), timeout=3600)
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


def rebuild(into: str, upstream: str, changes: str = CHANGES) -> int:
    if os.path.exists(into):
        shutil.rmtree(into)
    os.makedirs(into)
    m = manifest()
    print('▸ 第 1 步：取上游干净副本（基线 %s，来源 %s）'
          % (m['upstream_merge_base'][:12], upstream))
    if not pristine(upstream, into):
        return 1
    n_upstream = sum(len(fs) for _b, _d, fs in os.walk(into))
    print('  ✓ %d 个文件' % n_upstream)

    # 删除有两份记录：镜像里的 `.删除的路径.json`（随改动集一起走）与指纹清单的
    # status=="D"。清单说删了、镜像没记录，或两边条数不等，都不许重建 ——
    # 这两种不一致都会**静默**产出多带文件的 fork，而 verify 的单文件比对
    # 只会报「该在的都在」。删除这件事必须有两个来源互相钉住。
    in_manifest = sorted(r for r, e in m['files'].items() if e.get('status') == 'D')
    recorded, why = read_deletions(changes, in_manifest)
    if why:
        print('%s✗ 删除记录不可用：%s%s' % (C_BAD, why, C_OFF))
        return 1
    only_m = sorted(set(in_manifest) - set(recorded))
    only_r = sorted(set(recorded) - set(in_manifest))
    if only_m or only_r:
        print('%s✗ 删除记录与指纹清单不一致%s' % (C_BAD, C_OFF))
        for r in only_m:
            print('    %s清单标 D，镜像无记录：%s%s' % (C_BAD, r, C_OFF))
        for r in only_r:
            print('    %s镜像有记录，清单没标 D：%s%s' % (C_BAD, r, C_OFF))
        print('  %s→ 重新跑 --export（它会按清单重写删除记录），'
              '或重新生成指纹%s' % (C_DIM, C_OFF))
        return 1

    print('▸ 第 2 步：覆盖我们的改动（镜像 %s）' % os.path.relpath(changes, ROOT))
    count = 0
    # 按清单走，而不是按镜像目录走：镜像里多出来的文件**不许**混进 fork
    # （旧版本 os.walk 镜像，失败导出残留的半套文件会被原样复制进来）。
    for rel, meta in sorted(m['files'].items()):
        if meta.get('status') == 'D':
            continue
        src = os.path.join(changes, rel)
        if not os.path.isfile(src):
            print('%s✗ 镜像里缺少登记文件：%s%s' % (C_BAD, rel, C_OFF))
            print('  %s→ 先跑 --export%s' % (C_DIM, C_OFF))
            return 1
        dst = os.path.join(into, rel)
        os.makedirs(os.path.dirname(dst) or into, exist_ok=True)
        shutil.copy2(src, dst)
        os.chmod(dst, 0o644)
        count += 1
    print('  ✓ %d 个文件' % count)

    print('▸ 第 3 步：应用删除（%d 条）' % len(recorded))
    removed, absent = 0, 0
    for rel in recorded:
        dst = os.path.join(into, rel)
        if os.path.isdir(dst):                      # 目录型路径：连子树一起删
            shutil.rmtree(dst)
            removed += 1
            continue
        if os.path.isfile(dst):
            os.remove(dst)
            removed += 1
        else:
            # 上游基线的这个提交里就没有它 —— 不算错，但要说出来
            absent += 1
    print('  ✓ 删除 %d 个（上游本就没有的 %d 个）' % (removed, absent))

    print('▸ 第 4 步：逐字节比对指纹')
    return verify(into, changes=changes)


def verify(into: str, changes: str = CHANGES) -> int:
    if not os.path.isdir(into):
        print('%s✗ 目录不存在：%s%s' % (C_BAD, into, C_OFF))
        return 2
    m = manifest()
    bad, missing, upstream_drift, survivors = [], [], [], []
    n_deleted = 0
    for rel, meta in sorted(m['files'].items()):
        path = os.path.join(into, rel)
        if meta.get('status') == 'D':
            # 被删的路径：**不存在**才算对。这里过去完全不看，所以那 8 个
            # 上游文件一直躺在交付包里，而 --verify 照样报绿。
            n_deleted += 1
            if os.path.exists(path):
                survivors.append(rel)
            continue
        want = 'sha256:' + meta['sha256']
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

    # 镜像里清单之外的多余文件：**这就是缺陷①真正危险的地方**。旧版本先删镜像再
    # 复制，中途失败会在镜像里留下一个「半套」；旧版本的重建又是按镜像目录 os.walk
    # 复制的，于是那半套会被原样覆盖进 fork —— 既不在本文改动集里、又盖掉了上游原件，
    # 而 --verify 只看登记文件，照样报绿。所以「镜像没多余的」与「该在的在」并列成判据，
    # 且它在重建/校验时都会被检查（bundle 也走这里）。
    expected = {r for r, e in m['files'].items() if e.get('status') != 'D'}
    extra = []
    for base, _dirs, names in os.walk(changes):
        for n in names:
            rel = os.path.relpath(os.path.join(base, n), changes)
            if rel != DELETED and rel not in expected:
                extra.append(rel)

    ok = len(expected) - len(bad) - len(missing) - len(upstream_drift)
    print('  %s✓ %d/%d 个文件与指纹一致，%d/%d 条删除已生效%s'
          % (C_OK, ok, len(m['files']), n_deleted - len(survivors), n_deleted, C_OFF))
    for r in missing[:5]:
        print('    %s✗ 缺失 %s%s' % (C_BAD, r, C_OFF))
    for r, why, _g in bad[:5]:
        print('    %s✗ %s：%s%s' % (C_BAD, r, why, C_OFF))
    for r in survivors[:5]:
        print('    %s✗ 该删没删 %s%s' % (C_BAD, r, C_OFF))
    for r in extra[:5]:
        print('    %s✗ 镜像里有清单之外的文件 %s%s' % (C_BAD, r, C_OFF))
    for r, got in upstream_drift[:5]:
        print('    %s⚠ %s：重建结果既不是我们要的，也不是基线 —— '
              '**上游的那个文件变了**，需要重新对齐（这正是希望它大声失败的情形）%s'
              % (C_WARN, r, C_OFF))
    if bad or missing or survivors or extra:
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


def bundle(out: str, into: str, changes: str = CHANGES) -> int:
    if not os.path.isdir(into):
        print('%s✗ 先跑 --rebuild（打包用的是**重建出来的** fork，不是工作副本）%s'
              % (C_BAD, C_OFF))
        return 2
    if verify(into, changes=changes) != 0:
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
    def opt(name: str, default: str) -> str:
        return args[args.index(name) + 1] if name in args else default
    # 指纹清单丢了就是一条普通错误，不该是一串 traceback ——
    # 每个判据都靠它，读不到就没法判断任何事。
    if not os.path.isfile(MANIFEST):
        print('%s✗ 指纹清单不存在：%s%s' % (C_BAD, os.path.relpath(MANIFEST, ROOT), C_OFF))
        print('  %s→ 先跑 python3 工具/g2_改造点.py --manifest%s' % (C_DIM, C_OFF))
        return 1
    if '--export' in args:
        # --into 只为自测而存在：让自测能对**真的 CLI**跑「失败不许破坏镜像」，
        # 否则那条判据只能测到内部函数（自测里另有一条拿真镜像比 123 个摘要的对照）。
        return export(changes=opt('--into', CHANGES))
    if '--rebuild' in args:
        into = opt('--into', '/tmp/kvvi-fork')
        upstream = opt('--upstream', 'local')
        return rebuild(into, upstream)
    if '--verify' in args:
        return verify(opt('--into', '/tmp/kvvi-fork'))
    if '--bundle' in args:
        out = opt('--out', os.path.join(ROOT, '交付', '包', 'kvvi-delivery.tar.gz'))
        return bundle(out, opt('--into', '/tmp/kvvi-fork'))
    print(__doc__)
    return 2


if __name__ == '__main__':
    sys.exit(main())
