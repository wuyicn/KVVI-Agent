#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
`工具/fork.py` 的反向测试 —— 证明每一条判据**在应该红的时候会红**。

为什么需要：本仓的纪律是「一个从没失败过的校验器不是证据」。fork.py 的两条新判据
（删除被表达、导出先建成再替换）都属于「绿了也说明不了什么」的类型 ——
删除记录少一条，重建出的 fork 一样能跑，只有这里能证明它会被抓住。

覆盖 7 条：

  ① 删除被记录        —— 镜像里的删除记录 === 清单里 status=="D" 的条目
  ② ①能变红          —— 清单标 D、文件其实还在 DSH → 响亮失败，且不碰已有镜像
  ③ 导出中途失败不破坏镜像（**真 CLI**：临时换掉仓库指纹文件，跑真命令）
  ④ 删除被应用        —— 重建结果里那 8 个路径确实不存在
  ⑤ ④能变红          —— 把被删文件放回重建结果 → --verify 必须红；删回去又绿
  ⑥ 镜像混进清单外文件 → --verify 必须红（缺陷①的残留形态，不许静默）
  ⑦ 删除记录与清单不一致 → --rebuild 必须拒绝（不静默重建）
  ⑧ 删除记录整个丢掉 → --rebuild 必须拒绝（不许拿指纹清单兜住当绿的）

用法：python3 工具/fork_自测.py      （只在 /tmp 与临时换指纹之间干活，结束自动还原）
"""

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FORK = os.path.join(ROOT, '工具', 'fork.py')
MANIFEST = os.path.join(ROOT, 'forks', 'dsh', '改造点指纹.json')
DSH = os.path.join(ROOT, 'vendor', 'dsh')
DELETED = '.删除的路径.json'

C_OK, C_BAD, C_DIM, C_OFF = '\033[32m', '\033[31m', '\033[90m', '\033[0m'

RESULTS = []


def run(*args) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, FORK] + list(args),
                          capture_output=True, text=True, cwd=ROOT)


def head(text: str, n: int = 6) -> str:
    return '\n'.join('        ' + l for l in text.strip().splitlines()[:n])


def check(name: str, ok: bool, why: str, detail: str = '') -> None:
    RESULTS.append(ok)
    print('%s %s' % ('%s✓%s' % (C_OK, C_OFF) if ok else '%s✗%s' % (C_BAD, C_OFF), name))
    if detail:
        print(detail)
    if not ok:
        print('    %s未通过：%s%s' % (C_BAD, why, C_OFF))


def sh256(path: str) -> str:
    return hashlib.sha256(open(path, 'rb').read()).hexdigest()


def main() -> int:
    tmp = tempfile.mkdtemp(prefix='fork-selftest-')
    man = json.load(open(MANIFEST, encoding='utf-8'))
    declared_d = sorted(r for r, e in man['files'].items() if e['status'] == 'D')

    print('%s=== fork.py 反向测试 ===%s' % (C_OK, C_OFF))
    print('临时区 %s' % tmp)
    print()

    # ── ⓪ 指纹清单读不到 → 普通错误，不是 traceback ────────────────
    shutil.move(MANIFEST, MANIFEST + '.selftest-gone')
    try:
        r0 = run('--export')
    finally:
        shutil.move(MANIFEST + '.selftest-gone', MANIFEST)
    check('⓪指纹清单不存在 → 报错退出，不是 traceback',
          r0.returncode != 0 and 'Traceback' not in r0.stderr
          and '指纹清单不存在' in r0.stdout,
          '退出码 %d，stderr 有 traceback=%s'
          % (r0.returncode, 'Traceback' in r0.stderr),
          '          退出码 %d；%s' % (r0.returncode, head(r0.stdout, 1).strip()))

    # ── ① 删除被记录：导出到临时镜像，删除记录必须与清单逐条相等 ──────
    mirror = os.path.join(tmp, '镜像')
    r = run('--export', '--into', mirror)
    rec_path = os.path.join(mirror, DELETED)
    recorded, blob = [], ''
    if os.path.isfile(rec_path):
        blob = open(rec_path, encoding='utf-8').read()
        recorded = json.loads(blob).get('deleted', [])
    # 导出必须**不留下**被删路径的内容文件（否则它会被重建复制进 fork）
    left = [p for p in declared_d if os.path.isfile(os.path.join(mirror, p))]
    check('①删除被记录：镜像的删除记录 === 清单的 %d 条 D' % len(declared_d),
          r.returncode == 0 and recorded == declared_d and not left,
          '记录=%d 条，清单=%d 条，镜像里仍留有内容文件 %d 个'
          % (len(recorded), len(declared_d), len(left)),
          '          退出码 %d，记录 %d 条，内容文件 %d 个\n%s'
          % (r.returncode, len(recorded), len(left), head(blob, 4)))

    # ── ② ①能变红：清单标 D、但 DSH 里文件还在 ────────────────────
    # 做法：把 DSH 里**真实存在**的一个文件的路径改成 status=D。
    # 这正是「有人把删掉的文件改回来、却没重新生成指纹」的样子。
    fake = json.loads(json.dumps(man))
    fake['files']['apps/cli/package.json']['status'] = 'D'
    sys.path.insert(0, os.path.join(ROOT, '工具'))
    import fork as forkmod

    sentinel = os.path.join(tmp, '哨兵')
    os.makedirs(os.path.join(sentinel, 'apps/cli'), exist_ok=True)
    keep = os.path.join(sentinel, 'apps/cli/package.json')
    open(keep, 'w').write('哨兵内容，不许被改\n')
    rc = forkmod.export(changes=sentinel, dsh=DSH, man=fake)
    intact = open(keep).read() == '哨兵内容，不许被改\n'
    check('②清单标 D 但文件其实还在 → 响亮失败（且不碰已有镜像）',
          rc != 0 and intact,
          '退出码 %d（应为非 0），哨兵完好=%s' % (rc, intact),
          '          退出码 %d；哨兵文件未被改动=%s' % (rc, intact))

    # ── ③ 导出中途失败不破坏已有镜像（**真 CLI**）─────────────────
    # 临时把仓库的指纹文件换成一个「登记了不存在的文件」的坏指纹，
    # 跑真命令 `python3 工具/fork.py --export --into <已有镜像>`；
    # 结束后把真指纹放回去（无论成败）—— 这就是修复前会毁掉镜像的那条路径。
    broken = json.loads(json.dumps(man))
    broken['files']['packages/不存在/这个文件.ts'] = {'status': 'A', 'sha256': '0' * 64}
    # 拿**真镜像的 123 个文件**当「已有镜像」：修复前这条路会把它删空。
    # 先把每个文件的摘要记下来，失败后逐个比 —— 只查两个哨兵太弱。
    live = os.path.join(ROOT, 'forks', 'dsh', '变更')
    live_before = {}
    for base, _d, names in os.walk(live):
        for n in names:
            p = os.path.join(base, n)
            live_before[os.path.relpath(p, live)] = sh256(p)
    olddir = os.path.join(tmp, '已有镜像')
    os.makedirs(os.path.join(olddir, 'packages'), exist_ok=True)
    names = ('packages/哨兵-a.ts', 'packages/哨兵-b.ts')
    for rel in names:
        open(os.path.join(olddir, rel), 'w').write('老镜像的内容\n')
    before = {rel: sh256(os.path.join(olddir, rel)) for rel in names}
    backup = MANIFEST + '.selftest-bak'
    shutil.copy2(MANIFEST, backup)
    try:
        json.dump(broken, open(MANIFEST, 'w', encoding='utf-8'), ensure_ascii=False)
        r2 = run('--export', '--into', olddir)          # 临时镜像
        r2b = run('--export')                            # 真镜像
    finally:
        shutil.move(backup, MANIFEST)
    after = {rel: sh256(os.path.join(olddir, rel)) for rel in names}
    extra = sorted(set(os.listdir(olddir)) - {'packages'})
    live_after = {}
    for base, _d, walked in os.walk(live):
        for n in walked:
            p = os.path.join(base, n)
            live_after[os.path.relpath(p, live)] = sh256(p)
    check('③导出中途失败：真 CLI 退出码非 0，临时镜像逐字节不变',
          r2.returncode != 0 and before == after and not extra,
          '退出码 %d，镜像变化=%s，多余条目=%s'
          % (r2.returncode, before != after, extra),
          '          退出码 %d；两个哨兵 sha256 前后一致=%s；镜像顶层=%s'
          % (r2.returncode, before == after, extra or '只有 packages'))
    check('③-对照：同一次失败对**真镜像的 %d 个文件**也没有影响（一个都不少）'
          % len(live_before),
          r2b.returncode != 0 and live_before == live_after,
          '退出码 %d；文件数 %d → %d'
          % (r2b.returncode, len(live_before), len(live_after)),
          '          真镜像退出码 %d；%d/%d 个文件摘要一致'
          % (r2b.returncode, sum(1 for k, v in live_before.items()
                                 if live_after.get(k) == v), len(live_before)))
    check('③-对照：指纹文件已还原（自测不留副作用）',
          json.load(open(MANIFEST, encoding='utf-8'))['count'] == man['count'],
          '指纹 count 对不上，可能没还原')

    # ── 用真镜像重建一次，给 ④⑤⑥ 共用 ────────────────────────────
    print()
    print('%s-- 用真镜像重建（--rebuild 走真 CLI）--%s' % (C_DIM, C_OFF))
    into = os.path.join(tmp, 'fork')
    r3 = run('--rebuild', '--into', into)
    print(head(r3.stdout, 8))

    # ── ④ 删除被应用：重建结果里那 8 个路径必须不存在 ───────────────
    survivors = [p for p in declared_d if os.path.exists(os.path.join(into, p))]
    upstream_had = sum(
        1 for p in declared_d
        if subprocess.run(['git', '-C', DSH, 'cat-file', '-e',
                           '%s:%s' % (man['upstream_merge_base'], p)],
                          capture_output=True).returncode == 0)
    check('④删除被应用：重建结果里 %d 个路径确实不存在（上游本有 %d 个）'
          % (len(declared_d), upstream_had),
          r3.returncode == 0 and not survivors and upstream_had == len(declared_d),
          '残留 %d 个，上游本有 %d 个' % (len(survivors), upstream_had),
          '          重建退出码 %d；残留 %s' % (r3.returncode, survivors or '无'))

    # ── ⑤ ④能变红：把一个被删文件放回重建结果 → verify 必须红 ──────
    victim = declared_d[0]
    back = os.path.join(into, victim)
    os.makedirs(os.path.dirname(back), exist_ok=True)
    open(back, 'w').write('# 上游那份文件又回来了\n')
    r4 = run('--verify', '--into', into)
    check('⑤把被删文件放回重建结果 → --verify 红',
          r4.returncode != 0 and '该删没删' in r4.stdout,
          '退出码 %d，输出里没有「该删没删」' % r4.returncode,
          head(r4.stdout, 3))
    os.remove(back)
    r5 = run('--verify', '--into', into)
    check('⑤-对照：删回之后 --verify 又绿（红的不是别的东西）',
          r5.returncode == 0, '退出码 %d' % r5.returncode, head(r5.stdout, 2))

    # ── ⑥ 镜像里混进清单外的文件 → 必须红（缺陷①的残留形态）────────
    # 旧版本按 os.walk 镜像复制，半套残留会被原样覆盖进 fork，
    # 而 --verify 只看登记文件，照样报绿 —— 这条判据封住的就是这个假绿。
    mirror2 = os.path.join(tmp, '镜像-半套')
    shutil.copytree(mirror, mirror2)
    stray = os.path.join(mirror2, 'apps/web/tests/stray.ts')
    os.makedirs(os.path.dirname(stray), exist_ok=True)
    open(stray, 'w').write('上次失败导出留下的半套\n')
    r6 = forkmod.verify(into, changes=mirror2)
    check('⑥镜像里混进清单外的文件 → --verify 红（不静默当绿的）',
          r6 != 0, '返回 %d（应为非 0）' % r6)

    # ── ⑦⑧ 删除记录与清单不一致 / 整个丢掉 → --rebuild 必须拒绝 ────
    # 这两条要动**真镜像**：`rebuild` 读的是固定的 `forks/dsh/变更/`，不接收注入
    # （故意如此 —— 交付路径只走一个镜像目录）。做法是把记录文件挪开一秒，
    # 无论成败都放回去；镜像内容一个字节都不改。
    mirror_live = os.path.join(ROOT, 'forks', 'dsh', '变更')
    rec_live = os.path.join(mirror_live, DELETED)
    backup = rec_live + '.selftest-bak'
    if not os.path.isfile(rec_live):
        check('⑦⑧前提：真镜像里有删除记录', False, '记录文件不存在，先跑 --export')
    else:
        shutil.copy2(rec_live, backup)
        # ⑦ 少记一条
        doc = json.load(open(rec_live, encoding='utf-8'))
        doc['deleted'] = doc['deleted'][:-1]
        json.dump(doc, open(rec_live, 'w', encoding='utf-8'), ensure_ascii=False)
        rc7 = run('--rebuild', '--into', os.path.join(tmp, 'fork-少一条'))
        check('⑦删除记录少一条 → --rebuild 拒绝重建（不静默少删一个）',
              rc7.returncode != 0, '退出码 %d（应为非 0）' % rc7.returncode,
              head(rc7.stdout, 3))
        # ⑧ 整个丢掉 —— 实测出来的假绿：拆掉 --export 写记录那一段后，
        # 镜像里没有记录，--rebuild 拿指纹清单兜住、--verify 照样报 8/8 删除已生效。
        # 即「删除这件事没随改动集一起走」完全不可见。现在直接判错。
        os.remove(rec_live)
        rc8 = run('--rebuild', '--into', os.path.join(tmp, 'fork-无记录'))
        check('⑧删除记录整个丢掉 → --rebuild 拒绝（不许拿清单兜住当绿的）',
              rc8.returncode != 0, '退出码 %d（应为非 0）' % rc8.returncode,
              head(rc8.stdout, 3))
        shutil.move(backup, rec_live)
        check('⑧-对照：真镜像的删除记录已还原（自测不留副作用）',
              json.load(open(rec_live, encoding='utf-8'))['deleted'] == declared_d,
              '还原后记录与清单不符')

    # ── 总结 ──────────────────────────────────────────────────────
    print()
    n = len(RESULTS)
    if all(RESULTS):
        print('%s✓ %d/%d 条反向测试全部符合预期%s' % (C_OK, sum(RESULTS), n, C_OFF))
        print('  即：每一条判据都被证明过「应该红的时候会红」')
        code = 0
    else:
        print('%s✗ %d/%d 条未通过%s' % (C_BAD, n - sum(RESULTS), n, C_OFF))
        code = 1
    shutil.rmtree(tmp, ignore_errors=True)
    return code


if __name__ == '__main__':
    sys.exit(main())
