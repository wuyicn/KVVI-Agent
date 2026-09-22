#!/usr/bin/env python3
"""生成 PRD 冻结清单：对冻结范围内的所有文件做 SHA-256 指纹。

冻结范围（由 FREEZE_SET 显式枚举，避免递归时把清单自己也算进去）：
  - PRD 正文
  - 全部五轮评审的记录：汇总、视角定义、运行器、证据与记录
  - 历史清单快照（清单-v*.sha256）——旧指纹是历史版本可追溯的唯一依据
  - 冻结记录（*.md）

评审运行器与视角定义一并纳入，是为了让「另一台机器能否复现这次评审」
成为冻结的一部分——只冻结结论、不冻结复现方式，等于只冻结了一半。

用法：
    python3 make_manifest.py            # 生成/更新 清单.sha256
    python3 make_manifest.py --verify   # 按清单校验，输出逐项结果
"""
import hashlib
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent          # 冻结/
ROOT = HERE.parent                              # KVVI-Agent/
MANIFEST = HERE / '清单.sha256'
PRD_VERSION = 'v2.6'

FREEZE_SET = [
    ROOT / 'KVVI-Agent 开发文档 PRD.md',
    # 评审全树：汇总 / lenses.json / run_*.py / 证据/*（含 .record.json）
    *(p for p in sorted((ROOT / '评审').rglob('*')) if p.is_file()),
    # 冻结记录与历史清单快照（但不含 清单.sha256 自身——那会自指）
    *(p for p in sorted(HERE.glob('*.md')) if p.is_file()),
    *(p for p in sorted(HERE.glob('清单-v*.sha256')) if p.is_file()),
]


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def relative(path: Path) -> str:
    return str(path.relative_to(ROOT))


def main() -> int:
    files = [p for p in FREEZE_SET if p.is_file()]

    if '--verify' in sys.argv:
        if not MANIFEST.is_file():
            print('清单不存在，先运行不带参数的本脚本')
            return 1
        recorded = {}
        for line in MANIFEST.read_text(encoding='utf-8').splitlines():
            if '  ' in line and not line.startswith('#'):
                value, name = line.split('  ', 1)
                recorded[name] = value
        bad = 0
        for name, value in sorted(recorded.items()):
            path = ROOT / name
            if not path.is_file():
                print(f'缺失  {name}')
                bad += 1
            elif digest(path) != value:
                print(f'不一致 {name}')
                bad += 1
        extra = {relative(p) for p in files} - set(recorded)
        for name in sorted(extra):
            print(f'新增  {name}（未入清单）')
            bad += 1
        print(f'\n共校验 {len(recorded)} 项，异常 {bad} 项')
        return 1 if bad else 0

    lines = [
        f'# KVVI Agent PRD {PRD_VERSION} 冻结清单',
        '# 校验方式：python3 make_manifest.py --verify',
        f'# 条目数：{len(files)}',
        '',
    ]
    for path in files:
        lines.append(f'{digest(path)}  {relative(path)}')
    MANIFEST.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print(f'已写入 {MANIFEST}（{len(files)} 项）')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
