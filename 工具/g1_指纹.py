#!/usr/bin/env python3
"""G1：契约资产并入的指纹固化与校验。

并入策略（PRD §5.3）：一次性搬迁，记录各资产 SHA-256 作为并入完成证据。

**为什么不搬成 §5.3 写的 contracts/validator/node 那样**：
`verify.py` / `test_structure.py` 里**硬编码**了 `tools/meta-schema*/` 与
`tests/meta-schema*/` 路径（见 verify.py 第 190-196 行、test_structure.py 第 30/50 行）。
按 §5.3 的路径搬会让验证器**直接跑不起来**。

**取舍**：**保持原布局**——① 可字节级比对（指纹才有意义）；② 验证器零改动可跑。
§5.3 的 validator 路径**记录为待修订**（那是看不到资产时写的）。

用法：
    python3 工具/g1_指纹.py            # 生成/更新 契约资产清单.sha256
    python3 工具/g1_指纹.py --verify   # 按清单校验
"""
import hashlib, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / 'contracts' / '契约资产清单.sha256'
PROVENANCE = ROOT / 'contracts' / '来源与指纹.md'

# 并入范围：契约、验证器、测试、以及验证器要求的源绑定文件
INCLUDE = ['contracts', 'tools/meta-schema', 'tools/meta-schema-full',
           'tests/meta-schema', 'tests/meta-schema-full',
           '.github/workflows/meta-schema-files.yml',
           'docs/PRD-AI无代码平台设计-v1.11.md',
           'docs/superpowers/specs']
EXCLUDE_PARTS = {'__pycache__', 'node_modules', '.venv'}


def files():
    out = []
    for item in INCLUDE:
        p = ROOT / item
        if p.is_file():
            out.append(p)
        elif p.is_dir():
            out += [f for f in p.rglob('*') if f.is_file()]
    return sorted({f for f in out
                   if not any(x in f.parts for x in EXCLUDE_PARTS)
                   and f.suffix != '.pyc'
                   and f != MANIFEST})       # 清单自身不入清单（自指）


def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def main():
    fs = files()
    if '--verify' in sys.argv:
        if not MANIFEST.is_file():
            print('清单不存在，先运行不带参数的版本'); return 1
        rec = {}
        for line in MANIFEST.read_text(encoding='utf-8').splitlines():
            if '  ' in line and not line.startswith('#'):
                v, n = line.split('  ', 1); rec[n] = v
        bad = 0
        for n, v in sorted(rec.items()):
            p = ROOT / n
            if not p.is_file():
                print(f'  缺失   {n}'); bad += 1
            elif sha(p) != v:
                print(f'  不一致 {n}'); bad += 1
        for n in sorted({str(p.relative_to(ROOT)) for p in fs} - set(rec)):
            print(f'  新增   {n}（未入清单）'); bad += 1
        print(f'\n共校验 {len(rec)} 项，异常 {bad} 项')
        return 1 if bad else 0

    lines = ['# KVVI-Agent 契约资产清单（G1 并入证据）',
             '# 来源：KVVI-Builder worktree 0a-5-meta-schemas',
             '#        commit 0be4475  branch feat/0a-5-meta-schemas',
             '# 校验：python3 工具/g1_指纹.py --verify',
             f'# 条目数：{len(fs)}', '']
    for p in fs:
        lines.append(f'{sha(p)}  {p.relative_to(ROOT)}')
    MANIFEST.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print(f'✓ 已写入 {MANIFEST}（{len(fs)} 项）')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
