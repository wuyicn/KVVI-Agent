#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""契约 schema 的**扩展**判据 —— 让「我们改了契约层什么」这件事可复核。

## 为什么需要它

契约层（`contracts/meta-schemas/`）是从 KVVI-Builder 一次性并入的，
并入时宣称「与源仓库逐字节一致」。**那句话从我们第一次有意扩展它起就不再成立** ——
于是必须成立的是另一件事：**每一处偏离都有记录，且记录与代码一致**。

本轮就有一次这样的扩展：`FieldPolicy.required_field`（按角色的字段必填，
见 `contracts/来源与指纹.md` §五·补）。

## 它判什么

| # | 判据 | 不成立会怎样 |
|---|---|---|
| A | 每个 schema 文件的 sha256 与 `manifest.json` 里记的一致 | `verify.py`（本仓库跑不起来，缺 `jsonschema`）逐字节核对的就是这一条；不一致时**没人会发现** |
| B | `FieldPolicy` 有 `required_field` 且**不在 `required` 数组里** | 前者丢了 = 搭建者写不了；后者进了 = **既有契约全部失效**（那是破坏性变更，必须另起一版 schema） |
| C | 两种契约都合法：**不带** `required_field` 的老写法、**带** `true` 的新写法 | 扩展必须是**向后兼容**的；这条把「兼容」变成可执行的判据 |
| D | 类型错的 `required_field`（字符串）被拒 | 可选属性容易写成「随便什么都收」——那它就不是 schema 的一部分了 |

## 用法

    python3 工具/check_contract_schema.py
    python3 工具/check_contract_schema.py --quiet
"""

import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SUITE = ROOT / 'contracts' / 'meta-schemas' / '0a-full-r1'
MANIFEST = SUITE / 'manifest.json'
TARGET = 'permission-spec.v1alpha1.schema.json'
#: 用官方套件自带的那个 ajv —— 不自带一份，版本漂移会让判据与验证器不同源。
AJV = ROOT / 'tools' / 'meta-schema' / 'node' / 'node_modules'

C_OK, C_BAD, C_DIM, C_OFF = '\033[32m', '\033[31m', '\033[90m', '\033[0m'


def sha256_of(path: Path) -> str:
    """
    文件的 SHA-256。
    @param path 路径
    @returns 十六进制摘要
    """
    return hashlib.sha256(path.read_bytes()).hexdigest()


def manifest_mismatches() -> list:
    """
    逐资源核对 schema 与 manifest。
    @returns `[(文件名, manifest 记的, 实际的)]`
    """
    manifest = json.loads(MANIFEST.read_text(encoding='utf-8'))
    out = []
    for name, record in (manifest.get('resources') or {}).items():
        path = SUITE / name
        if not path.is_file():
            out.append((name, record.get('sha256', '?'), '（文件不存在）'))
            continue
        actual = sha256_of(path)
        if actual != record.get('sha256'):
            out.append((name, record.get('sha256'), actual))
    return out


#: 用同一份 schema 编译出的三条用例。`(名字, 策略对象, 期望是否合法)`
def cases() -> list:
    """
    三条用例。
    @returns `[(名字, 策略, 期望合法)]`
    """
    base = {
        'policy_code': 'field_x',
        'role_code': 'sales',
        'role_ref': {'permission_ref': {'scope_type': 'TENANT', 'scope_id': 't',
                                        'app_id': None, 'module_id': None,
                                        'asset_type': 'PERMISSION',
                                        'asset_id': 'p', 'version': 1,
                                        'digest': 'sha256:' + 'a' * 64},
                     'subresource': {'type': 'ROLE', 'code': 'sales'}},
        'dimension': 'FIELD',
        'resource_ref': {'scope_type': 'TENANT', 'scope_id': 't', 'app_id': None,
                         'module_id': None, 'asset_type': 'BUSINESS_SCHEMA',
                         'asset_id': 'customer', 'version': 1,
                         'digest': 'sha256:' + 'b' * 64},
        'subresource': {'type': 'FIELD', 'code': 'contact_phone'},
        'field_mode': 'EDITABLE',
    }
    return [
        ('老写法：不带 required_field', dict(base), True),
        ('新写法：required_field = true', dict(base, required_field=True), True),
        ('错误类型：required_field 是字符串', dict(base, required_field='yes'), False),
    ]


def run_ajv() -> dict:
    """
    用官方 ajv 编译 schema 并跑三条用例。
    @returns `{名字: 是否合法}`
    @throws RuntimeError node 不可用或 schema 编译失败时
    """
    # ⚠️ 路径**全部走 stdin**，不走 argv：`node -e` 下 `process.argv` 的布局
    #    随写法而变（`--` 会被 node 自己吃掉），上一版把 schema 的路径当成了
    #    ajv 的路径，报的是「找不到模块 <schema>/ajv/dist/2020.js」——
    #    那个路径本身就很说明问题。
    script = """
const fs = require('node:fs');
const path = require('node:path');
const Ajv2020 = require(process.env.KVVI_AJV + '/ajv/dist/2020.js');
const addFormats = require(process.env.KVVI_AJV + '/ajv-formats/dist/index.js');
const cases = JSON.parse(fs.readFileSync(0, 'utf8'));
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
// ⚠️ **先把整套 schema 都注册进去再编译。** 字段策略里的 `MachineCode` 等
//    是按 URN 跨文件引用的（`urn:kvvi:meta-schema:0a-full-r1:business-schema-v1#/…`），
//    只编译一个文件会报「can't resolve reference … from id #」——
//    那个报错看起来像 schema 坏了，实际是**我只喂了它一份**。
for (const name of fs.readdirSync(process.env.KVVI_SUITE).filter(n => n.endsWith('.schema.json'))) {
  ajv.addSchema(JSON.parse(fs.readFileSync(path.join(process.env.KVVI_SUITE, name), 'utf8')));
}
const validate = ajv.compile({ $ref: 'urn:kvvi:meta-schema:0a-full-r1:permission-spec-v1alpha1#/$defs/FieldPolicy' });
const out = {};
for (const [name, value] of cases) out[name] = validate(value) === true;
process.stdout.write(JSON.stringify(out));
"""
    payload = json.dumps([[name, value] for name, value, _ in cases()])
    env = dict(os.environ, KVVI_AJV=str(AJV), KVVI_SUITE=str(SUITE))
    result = subprocess.run(
        ['node', '--input-type=commonjs', '-e', script],
        input=payload, capture_output=True, text=True, timeout=120, env=env)
    if result.returncode != 0:
        raise RuntimeError('ajv 跑不起来：%s' % (result.stderr.strip()[:300] or '未知原因'))
    return json.loads(result.stdout)


def main() -> int:
    """
    入口。
    @returns 退出码
    """
    quiet = '--quiet' in sys.argv
    problems = []

    mismatched = manifest_mismatches()
    for name, want, got in mismatched:
        problems.append('schema 与 manifest 不一致：%s（manifest %s… 实际 %s…）'
                        % (name, str(want)[:12], str(got)[:12]))

    schema = json.loads((SUITE / TARGET).read_text(encoding='utf-8'))
    field = schema.get('$defs', {}).get('FieldPolicy', {})
    props = field.get('properties') or {}
    if 'required_field' not in props:
        problems.append('FieldPolicy 缺 `required_field` —— 按角色的字段必填写不出来')
    if 'required_field' in (field.get('required') or []):
        problems.append('`required_field` 进了必填数组 —— 那是**破坏性**变更，'
                        '既有契约会全部失效；要那样必须另起一版 schema')
    if props.get('required_field', {}).get('type') != 'boolean':
        problems.append('`required_field` 的类型不是 boolean')

    try:
        results = run_ajv()
    except (RuntimeError, OSError) as error:
        problems.append(str(error))
        results = {}
    for name, _value, want in cases():
        got = results.get(name)
        if got != want:
            problems.append('用例「%s」期望%s，实际%s' % (name, '合法' if want else '被拒',
                                                     '合法' if got else '被拒'))

    if quiet:
        return 1 if problems else 0
    print('%s=== 契约 schema 扩展判据 ===%s' % (C_OK, C_OFF))
    print('  %s%s（%d 条用例）%s' % (C_DIM, TARGET, len(cases()), C_OFF))
    if problems:
        for problem in problems:
            print('  %s✗ %s%s' % (C_BAD, problem, C_OFF))
        return 1
    print('  %s✓ sha256 与 manifest 一致（%d 个 schema）；'
          '`required_field` 可选且向后兼容%s'
          % (C_OK, len(json.loads(MANIFEST.read_text(encoding='utf-8'))['resources']), C_OFF))
    return 0


if __name__ == '__main__':
    sys.exit(main())
