#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""发布脚手架：把工作区里的六份契约**发上去**，然后回头看员工能不能用。

## 为什么先做脚手架而不是先做界面

「搭建 → 发布 → 员工可用」这条链上，每一段都有实现，而**它在真实数据上从来没跑通过**：

| 段 | 状态 |
|---|---|
| 搭建者产出六份契约 | ✅ 能做到（试点里真的做出来了） |
| 契约 → 策略的编译 | ❌ **此前不存在**（`policy-compile.mjs` 是本次补的） |
| 发布通道（报告 → 审批 → 发布） | ✅ 实现完整、4 组测试 —— 但**没有任何调用方** |
| 发布 → 运行时投影 | ✅ 有，且有测试 |
| 投影 → 员工真的能用 | ❓ 从没在真实契约上试过 |

先把这条链用一条命令打通，是为了在**界面还没有**的时候就能回答那个问题：
中间那一段到底通不通。界面做完才发现链子中间是断的，界面要返工。

## 三个阶段，两个人

```
① 提交   —— 用**搭建者**的会话。差异报告在这里算出来（§9.6.6）。
② 审批   —— 用**所有者**的会话。§9.6.1：不能自审批。
③ 发布   —— 用**所有者**的会话。策略、系统、契约内容同一个事务落库。
```

## 用法

    python3 工具/发布脚手架.py --workspace <契约目录> --plan
    python3 工具/发布脚手架.py --workspace <契约目录> --apply

`--plan` 只打印**它将发什么**：六份契约各自对应哪个文件、编译出哪些策略、
哪几条是「声明了但运行时执行不了」的。`--apply` 才真的发。

参数（都有默认值，指向试点实例）：

    --platform   http://127.0.0.1:7500
    --asset-id   业务系统代号（默认 customer）
    --builder    builder / <试点口令>
    --owner      owner / <试点口令>
"""

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from http.cookiejar import CookieJar

#: 六份契约。与 `runtime-projection.REQUIRED_CONTRACTS` 同源 —— 少一份就不是可运行系统。
CONTRACT_TYPES = ('business-schema', 'view-schema', 'workflow-spec',
                  'permission-spec', 'tool-spec', 'app-model-command')

#: 从文件名认契约种类。**列出的是「文件名里出现什么就归哪一类」**，
#: 而不是按目录顺序猜 —— 猜错的表现是「发布成功但员工看不到界面」。
FILENAME_HINTS = (
    ('app-model-command', '搭建命令'),
    ('business-schema', 'business-schema'),
    ('view-schema', 'view-schema'),
    ('workflow-spec', 'workflow-spec'),
    ('permission-spec', 'permission-spec'),
    ('tool-spec', '工具'),
)


class CliError(Exception):
    """脚手架自己的错误。与平台错误码分开 —— 两者要报告给不同的人。"""


# ── HTTP ──────────────────────────────────────────────────────────────────────

class Session:
    """一个登录会话：自己带 Cookie，自己解 JSON。"""

    def __init__(self, platform, login, password, gateway='USER'):
        self.platform = platform.rstrip('/')
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(CookieJar()),
            _NoRedirect())
        self.login = login
        self.password = password
        self.gateway = gateway
        self.cookies = {}

    def _post_form(self, path, fields):
        body = urllib.parse.urlencode(fields).encode('utf-8')
        request = urllib.request.Request(
            self.platform + path, data=body,
            headers={'content-type': 'application/x-www-form-urlencoded'})
        try:
            response = self.opener.open(request, timeout=30)
            return response.status, response.headers.get_all('Set-Cookie') or [], b''
        except urllib.error.HTTPError as error:
            # ⚠️ 303 是**成功**：登录把凭据放在重定向的响应头里（§9.4.1 不让令牌进 URL）。
            #    用 `get_all` 而不是 `dict(headers)`：后者会把同名的多个头折叠成一个，
            #    而本平台一次发两张 Cookie（凭据 + 到期时刻）。
            return error.code, error.headers.get_all('Set-Cookie') or [], error.read()
        except urllib.error.URLError as error:
            raise CliError('连不上平台 %s：%s' % (self.platform, error.reason))

    def sign_in(self):
        """
        从**对应网关的登录入口**登录。

        搭建者必须走 `/kvvi/builder/login` —— 走员工入口拿到的是 USER 会话，
        而提交发布要求 BUILDER。走错入口的表现是提交时 403
        `KVVI_BUILDER_SESSION_REQUIRED`，看起来像权限没给。
        """
        entry = '/kvvi/builder/login' if self.gateway == 'BUILDER' else '/kvvi/login'
        status, cookies, body = self._post_form(entry, {
            'login': self.login, 'password': self.password,
            'requestedGateway': self.gateway,
        })
        if status not in (200, 303) or not cookies:
            text = body.decode('utf-8', 'replace')[:200]
            raise CliError('%s 登录失败（HTTP %s）%s' % (self.login, status, text))
        # 取会话凭据（`kvvi-session=`；到期时刻那张不是）。
        for piece in _cookie_pairs(cookies):
            if piece.startswith('kvvi-session='):
                self.cookies['kvvi-session'] = piece.split('=', 1)[1].split(';')[0]
        if 'kvvi-session' not in self.cookies:
            raise CliError('%s 登录后没有拿到会话凭据' % self.login)
        return self

    def call(self, method, path, payload=None):
        """
        调一条 `/api/v1/*`。
        @param method HTTP 方法
        @param path 路径（含 `/api/v1` 前缀）
        @param payload 请求体，或 None
        @returns `(status, body)`
        """
        data = None if payload is None else json.dumps(payload).encode('utf-8')
        headers = {'accept': 'application/json',
                   'cookie': '; '.join('%s=%s' % kv for kv in self.cookies.items())}
        if data is not None:
            headers['content-type'] = 'application/json'
        request = urllib.request.Request(self.platform + path, data=data,
                                         headers=headers, method=method)
        try:
            response = self.opener.open(request, timeout=120)
            return response.status, _json_of(response.read())
        except urllib.error.HTTPError as error:
            return error.code, _json_of(error.read())
        except urllib.error.URLError as error:
            raise CliError('调 %s 失败：%s' % (path, error.reason))


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """不跟随重定向 —— 登录成功的凭据在 303 的响应头里，跟丢了就没了。"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _cookie_pairs(values):
    """把若干 `Set-Cookie` 头的值拆成 `名字=值` 片段。"""
    pairs = []
    for raw in values or []:
        for piece in raw.split(','):
            piece = piece.strip()
            if '=' in piece:
                pairs.append(piece)
    return pairs


def _json_of(body):
    try:
        return json.loads(body.decode('utf-8'))
    except (ValueError, UnicodeDecodeError):
        return {'_raw': body.decode('utf-8', 'replace')[:400]}


# ── 契约目录 ──────────────────────────────────────────────────────────────────

def contract_files(tree):
    """
    从目录里认出六份契约分别对应哪个文件。
    @param tree 契约目录
    @returns `{contractType: path}`，以及 `{contractType: [候选…]}` 的歧义表
    """
    found = {t: [] for t in CONTRACT_TYPES}
    for base, _dirs, files in os.walk(tree):
        for name in sorted(files):
            if not name.endswith('.json'):
                continue
            if '_校验' in base or '/fixture' in base:
                continue  # 校验环境与固定装置不是交付物
            if os.path.basename(base) == 'schemas':
                # `06-工具/schemas/` 放的是请求/响应体的 JSON Schema 片段，
                # 它们的摘要被工具契约引用，但**它们本身不是契约**。
                # 不排除的话，装订出来的 `{tools: [...]}` 里会混进 8 份
                # 长得像工具、其实没有 `tool_code` 的东西。
                continue
            # ⚠️ 判据是**相对路径**，不只是文件名。
            # 工具契约在 `06-工具/` 目录下，文件名本身（`customer_assign.json`）
            # 里没有任何线索 —— 只看文件名的话，这一类永远认不出来，
            # 而报错是「目录里找不到对应的文件」，看起来像文件不存在。
            relative = os.path.relpath(os.path.join(base, name), tree)
            for contract_type, hint in FILENAME_HINTS:
                if hint in relative:
                    found[contract_type].append(os.path.join(base, name))
                    break
    return found


def _load(path):
    """读一个 JSON 文件。"""
    with open(path, encoding='utf-8') as handle:
        return json.load(handle)


def read_contracts(tree):
    """
    读出六份契约的内容。

    ── 这里要处理一件事：平台的契约存储**装不下真实系统的形状** ──────────────
    平台的 `published_contracts` 是 **「(类型, 系统代号) 一份」**：
    `latestContract(companyId, 'view-schema', assetId)` 回来只有一份内容。

    而搭出来的真实系统是：
      · **两张视图**（登记表单 + 列表）—— 平台每类只存一份；
      · **七个工具**（`06-工具/*.json`）—— 平台每类只存一份，
        而契约 schema 的 `tool-spec#/$defs/Spec` 又只描述**一个**工具。

    这不「多几份不占地方」，它是**存储形状与产品形状对不上**：
    发布能成功，员工看到的却是其中一张视图；其余的工具契约发上去了，
    而没有任何读取路径会看到它们。

    所以本脚手架**不假装它解决了**，而是两件事都做：
      1. 按一套**明说的约定**装订（下面 `CONVENTIONS`），让整条链能真的跑一遍；
      2. 把「装订丢掉了什么」逐条打印出来，交给决定的人。

    @param tree 契约目录
    @returns `(contracts, notes)` —— 内容表，与「装订约定」和「丢掉了什么」的说明
    """
    found = contract_files(tree)
    contracts, notes = {}, []
    for contract_type in CONTRACT_TYPES:
        paths = found[contract_type]
        if len(paths) == 0:
            notes.append('✗ %s：目录里找不到对应的文件' % contract_type)
            continue
        if len(paths) == 1:
            contracts[contract_type] = _load(paths[0])
            continue

        if contract_type == 'tool-spec':
            # 约定：把 N 份单工具契约装进 `{tools: [...]}`。
            # 依据是**平台自己的测试**用的就是这个形状
            # （`{ 'tool-spec': { tools: [] } }`），而不是契约 schema ——
            # schema 描述的是单个工具。这是**采用了一个约定**，不是发现了它。
            contracts[contract_type] = {'tools': [_load(p) for p in paths]}
            notes.append('⚠ tool-spec：%d 份单工具契约，按 `{tools: [...]}` 装订'
                         '（依据是平台自己的测试用的形状，不是契约 schema 规定的）'
                         % len(paths))
            continue

        # 其余类型：平台每类只存一份，**必须挑一份**，并说清挑了什么、丢下了什么。
        contracts[contract_type] = _load(paths[0])
        notes.append('⚠ %s：找到 %d 份，用了 %s，**其余 %d 份平台没有位置放**'
                     % (contract_type, len(paths), os.path.basename(paths[0]), len(paths) - 1))
        for extra in paths[1:]:
            notes.append('      丢下的：%s' % os.path.relpath(extra, tree))
    return contracts, notes


# ── 主流程 ────────────────────────────────────────────────────────────────────

def build_parser():
    """命令行。"""
    parser = argparse.ArgumentParser(description='KVVI 发布脚手架')
    parser.add_argument('--workspace', default=None,
                        help='契约目录（默认 ~/KVVI-Pilot/工作区/客户登记系统/契约）')
    parser.add_argument('--platform', default='http://127.0.0.1:7500')
    parser.add_argument('--asset-id', default='customer')
    parser.add_argument('--builder', default='builder/<试点口令>')
    parser.add_argument('--owner', default='owner/<试点口令>')
    parser.add_argument('--plan', action='store_true', help='只打印将要发什么')
    parser.add_argument('--create-roles', action='store_true',
                        help='契约里的角色在平台上不存在时，先用所有者把它们建出来')
    parser.add_argument('--apply', action='store_true', help='真的发')
    return parser


def split_login(value, what):
    """
    解 `账号/口令`。
    @param value 原值
    @param what 用途（报错用）
    @returns `(login, password)`
    """
    if '/' not in value:
        raise CliError('--%s 要写成 账号/口令' % what)
    login, password = value.split('/', 1)
    return login, password


def main():
    """入口。"""
    args = build_parser().parse_args()
    if not args.plan and not args.apply:
        print('✗ 需要指明 --plan 或 --apply。', file=sys.stderr)
        return 1

    tree = args.workspace or os.path.join(
        os.path.expanduser('~'), 'KVVI-Pilot', '工作区', '客户登记系统', '契约')
    if not os.path.isdir(tree):
        print('✗ 找不到契约目录：%s' % tree, file=sys.stderr)
        return 1

    contracts, notes = read_contracts(tree)
    print('=== ① 工作区 ===')
    print('  %s' % tree)
    for contract_type in CONTRACT_TYPES:
        keep = '✓' if contract_type in contracts else '✗'
        print('  %s %-18s %s' % (keep, contract_type,
                                 '有' if contract_type in contracts else '**缺**'))
    for note in notes:
        print('  %s' % note)
    missing = [t for t in CONTRACT_TYPES if t not in contracts]
    if missing:
        # 少一份就不发 —— 与平台侧 `KVVI_PUBLISH_CONTRACTS_INCOMPLETE` 同一个判据。
        print('\n✗ 缺 %d 份契约，不发。' % len(missing), file=sys.stderr)
        return 2

    builder_login, builder_password = split_login(args.builder, 'builder')
    owner_login, owner_password = split_login(args.owner, 'owner')

    if args.plan:
        print('\n=== ② 将要提交（搭建者 %s）===' % builder_login)
        print('  契约：%s' % ', '.join(sorted(contracts)))
        permission = contracts.get('permission-spec', {})
        print('  权限契约里的角色：%s'
              % ', '.join(r.get('role_code', '?') for r in permission.get('roles', [])))
        print('  权限契约里的策略：%d 条' % len(permission.get('policies', [])))
        print('\n  ⚠️ 编译（契约 → policies 行）与「声明了但执行不了」的清单，'
              '要**发上去之后**才由平台算出来 ——')
        print('     那一步的判据在平台上，脚手架不在这里另算一份。')

    # ── 契约声明的角色必须先在平台上存在 ──────────────────────────────────
    #
    # ⚠️ 这一步**不是发布通道该做的**（`policy-compile.mjs` 的注释里写了理由：
    #    角色是「人」的组织方式，在企业管理里建，带着自己的成员；
    #    发布时凭空造一个角色，会多出一个没有成员、也没人知道从哪来的角色）。
    #    但脚手架的用途是**把整条链跑通**，所以它把这一步显式地做出来，
    #    而且要 `--create-roles` 才做 —— 默认只报告缺哪几个。
    owner = Session(args.platform, owner_login, owner_password, gateway='USER').sign_in()
    permission = contracts.get('permission-spec', {})
    wanted = [(r.get('role_code'), r.get('name')) for r in permission.get('roles', [])]
    status, body = owner.call('GET', '/api/v1/admin/roles')
    if status != 200:
        print('  ✗ 读角色列表失败：HTTP %s %s'
              % (status, json.dumps(body, ensure_ascii=False)[:200]), file=sys.stderr)
        return 3
    # ⚠️ 平台这一侧返回的是 **camelCase**（`roleCode`），而契约里是 `role_code`。
    #    两边都对，只是它们是两个东西：契约面向搭建者，接口面向界面。
    #    我的第一版按契约的拼法读接口，于是「角色明明建过了」却报成没有 ——
    #    而报错说「契约声明了、平台上还没有」，看起来像角色真没建。
    have = {(r.get('roleCode') or r.get('role_code')) for r in body.get('items', [])}
    absent = [(code, name) for code, name in wanted if code not in have]
    if absent:
        print('\n=== ② 契约声明了、平台上还没有的角色 ===')
        for code, name in absent:
            print('  ✗ %s（%s）' % (code, name))
        if not args.create_roles:
            print('  它们必须先在企业管理里建出来 —— 或加 --create-roles 让脚手架建。')
            print('  （发布通道**故意**不替调用方造角色：凭空出现的角色没有成员，'
                  '也没人知道从哪来，而它在列表里和别的角色长得一样。）')
            return 2
        for code, name in absent:
            status, body = owner.call('POST', '/api/v1/admin/roles',
                                      {'roleCode': code, 'name': name or code})
            if status not in (200, 201):
                print('  ✗ 建角色 %s 失败：HTTP %s %s'
                      % (code, status, json.dumps(body, ensure_ascii=False)[:200]),
                      file=sys.stderr)
                return 3
            print('  ✓ 建了角色 %s（%s）' % (code, name or code))

    print('\n=== ③ 提交（搭建者 %s，走 /kvvi/builder/login）===' % builder_login)
    builder = Session(args.platform, builder_login, builder_password,
                      gateway='BUILDER').sign_in()
    status, body = builder.call('POST', '/api/v1/publish/drafts',
                                {'assetId': args.asset_id, 'contracts': contracts})
    if status == 200 and body.get('reused') is True:
        # 同一份变更已经有一张开着的草案 —— 那是 `publish_drafts_one_open`
        # 唯一索引在说话：**同一份变更别提两次**。脚手架重跑不该失败，
        # 所以沿着已有那张往下走。
        print('  · 这份变更已经有一张开着的草案，继续用它：%s' % body.get('draftId'))
    elif status != 201:
        print('  ✗ HTTP %s %s' % (status, json.dumps(body, ensure_ascii=False)[:400]))
        return 3
    draft_id = body.get('draftId')
    print('  ✓ 草案 %s，状态 %s' % (draft_id, body.get('status')))
    # ★ 提交时拿到的**变更摘要**：审批与发布都要带着它走。
    #   它回答的是「批的是不是这一份」，而不是「批的是不是一个叫这个名字的东西」。
    change_digest = body.get('changeDigest')
    if change_digest is None:
        _, detail = builder.call('GET', '/api/v1/publish/drafts/%s' % draft_id)
        change_digest = detail.get('change_digest')
    print('  变更摘要 %s' % str(change_digest)[:32])
    counts = (body.get('diffReport') or {}).get('counts') or {}
    print('  差异：新增 %s / 删除 %s / 改动 %s'
          % (counts.get('added'), counts.get('removed'), counts.get('changed')))
    not_enforced = body.get('notEnforced') or []
    if not_enforced:
        # ★ 这一条是这次发布**最该被人看到**的东西：契约里有、而运行时执行不了的规则。
        print('  ⚠️ 声明了但运行时执行不了：%d 条' % len(not_enforced))
        for item in not_enforced[:8]:
            print('     %s  %s' % (item.get('reason'), item.get('policyCode')))
    if not args.apply:
        return 0

    print('\n=== ④ 审批（所有者 %s）===' % owner_login)
    status, body = owner.call(
        'POST', '/api/v1/publish/drafts/%s/approve' % draft_id,
        {'decision': 'APPROVE', 'changeDigest': change_digest})
    if status != 200:
        # 已经在 APPROVED / PUBLISHED 上的草案再批一次会被拒 —— 那是对的
        # （审批是状态的迁移，不是幂等的写）。重跑脚手架时它会出现，
        # 所以这里往下走，由发布那一步给出真正的结论。
        print('  · HTTP %s %s' % (status, json.dumps(body, ensure_ascii=False)[:160]))
    else:
        print('  ✓ %s' % json.dumps(body, ensure_ascii=False)[:200])

    print('\n=== ⑤ 发布（所有者 %s）===' % owner_login)
    status, body = owner.call(
        'POST', '/api/v1/publish/drafts/%s/publish' % draft_id,
        {'assetId': args.asset_id, 'name': args.asset_id, 'schemaCode': args.asset_id,
         'contracts': contracts})
    if status != 201:
        print('  ✗ HTTP %s %s' % (status, json.dumps(body, ensure_ascii=False)[:400]))
        return 3
    print('  ✓ %s' % json.dumps(body, ensure_ascii=False)[:400])

    print('\n=== ⑥ 平台上现在有什么 ===')
    status, body = owner.call('GET', '/api/v1/publish/contracts/%s' % args.asset_id)
    if status == 200:
        for item in body.get('items', []):
            print('  %-18s v%s  %s' % (item['contractType'], item['version'],
                                       (item['digest'] or '')[:24]))
    status, body = owner.call('GET', '/api/v1/systems/%s/runtime' % args.asset_id)
    print('  运行时投影：HTTP %s %s' % (status, json.dumps(body, ensure_ascii=False)[:300]))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except CliError as error:
        print('✗ %s' % error, file=sys.stderr)
        sys.exit(1)
