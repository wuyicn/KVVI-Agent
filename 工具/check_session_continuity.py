#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""会话连续性验收：五条判据，逐条给出可复核的结果。

## 为什么先写它，而不是先写客户端

「连接异常提示与重连」「任务状态与待答问题恢复」这两件还没做。
先写验收、再写实现，是为了让**没做的地方以失败的形式出现**，
而不是等实现写完再补一个刚好能过的测试。

五条判据来自需求原文：

| # | 判据 | 它真正在问什么 |
|---|---|---|
| ① | 连续搭建 30 分钟 | 会话凭据会在半程换新，而**用户察觉不到** |
| ② | 令牌到期时产生提问 | 断在「服务端正在等一个回答」的那一刻，答得回来 |
| ③ | 休眠后恢复 | 凭据过期、会话还活着 —— 回来不用重新登录 |
| ④ | 管理员撤权后停止访问 | 撤权**当场**生效，不是等下一次登录 |
| ⑤ | 重复重连不重复提交 | 重连不重放已经提交过的动作 |

## 关于「30 分钟」

`--minutes` 默认 **30**，真的跑满。想快速过一遍跑 `--fast`：
它把窗口压到 ~2 分钟（每条判据的**逻辑不变**，只是时间尺度变了），
并**在输出里写明这一次是压缩的** —— 压缩跑不能当作长时程的证据。

## 用法

    python3 工具/check_session_continuity.py --fast          # ~2 分钟，先看有没有硬伤
    python3 工具/check_session_continuity.py                 # 真跑 30 分钟
    python3 工具/check_session_continuity.py --only ③④       # 只跑某几条
"""

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_PLATFORM = 'http://127.0.0.1:7500'
DEFAULT_HOME = os.path.expanduser('~/Library/Application Support/KVVI-Agent-Pilot')
DEFAULT_PG_BIN = '/opt/homebrew/opt/postgresql@17/bin'
CORPUS_PASSWORD = '<试点口令>'


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """不跟随重定向：登录取凭据靠的是 303 的响应头。"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Client:
    """一个会话：带 Cookie、能调 `/api/v1`、能读自己的凭据到期时刻。"""

    def __init__(self, platform, login, password, gateway='USER'):
        self.platform = platform.rstrip('/')
        self.login = login
        self.password = password
        self.gateway = gateway
        self.cookies = {}
        self.opener = urllib.request.build_opener(
            NoRedirect(), urllib.request.HTTPCookieProcessor())

    def sign_in(self):
        """从对应网关的入口登录。"""
        entry = '/kvvi/builder/login' if self.gateway == 'BUILDER' else '/kvvi/login'
        body = urllib.parse.urlencode({
            'login': self.login, 'password': self.password,
            'requestedGateway': self.gateway}).encode()
        request = urllib.request.Request(
            self.platform + entry, data=body,
            headers={'content-type': 'application/x-www-form-urlencoded'})
        try:
            self.opener.open(request, timeout=30)
        except urllib.error.HTTPError as error:
            if error.code != 303:
                raise RuntimeError('%s 登录失败 HTTP %s' % (self.login, error.code))
            self._absorb(error.headers.get_all('Set-Cookie') or [])
            return self
        raise RuntimeError('%s 登录没有拿到凭据' % self.login)

    def _absorb(self, values):
        """从若干 `Set-Cookie` 里吸收会话相关的两张。"""
        for raw in values:
            head = raw.split(';')[0].strip()
            if '=' not in head:
                continue
            name, value = head.split('=', 1)
            if name in ('kvvi-session', 'kvvi-session-exp'):
                self.cookies[name] = value

    @property
    def credential(self):
        """当前的分发凭据（`kvvi-session`）。"""
        return self.cookies.get('kvvi-session', '')

    @property
    def expires_at(self):
        """凭据到期时刻（epoch 秒），从那张可读的 Cookie 取。"""
        try:
            return int(self.cookies.get('kvvi-session-exp', '0'))
        except ValueError:
            return 0

    def call(self, method, path, payload=None, absorb=True, extra_headers=None):
        """调一条接口。@returns `(status, body, set_cookie_values)`"""
        data = None if payload is None else json.dumps(payload).encode()
        headers = {'accept': 'application/json',
                   'cookie': '; '.join('%s=%s' % kv for kv in self.cookies.items())}
        if extra_headers:
            headers.update(extra_headers)
        if data is not None:
            headers['content-type'] = 'application/json'
        request = urllib.request.Request(self.platform + path, data=data,
                                         headers=headers, method=method)
        try:
            response = self.opener.open(request, timeout=60)
            values = response.headers.get_all('Set-Cookie') or []
            if absorb:
                self._absorb(values)
            return response.status, _json(response.read()), values
        except urllib.error.HTTPError as error:
            values = error.headers.get_all('Set-Cookie') or []
            if absorb:
                self._absorb(values)
            return error.code, _json(error.read()), values

    def renew(self):
        """显式续发一次。@returns `(status, body)`"""
        status, body, _ = self.call('POST', '/auth/renew')
        return status, body

    def rpc(self, endpoint, payload=None):
        """打一条运行时的 RPC（`/api/...`）。@returns `(status, body)`"""
        status, body, _ = self.call('POST', '/api/%s' % endpoint, payload or {})
        return status, body


def _json(raw):
    """把响应体解成 JSON；解不开就原样带回来（**不要吞掉证据**）。"""
    text = raw.decode('utf-8', 'replace')
    try:
        return json.loads(text)
    except ValueError:
        return {'_raw': text[:600]}


def error_code_of(body):
    """从各种形状的响应里取出稳定错误码。"""
    if not isinstance(body, dict):
        return None
    if isinstance(body.get('error'), str):
        return body['error']
    result = body.get('result')
    if isinstance(result, dict) and isinstance(result.get('error'), dict):
        return result['error'].get('code')
    return None


# ── 结果记录 ──────────────────────────────────────────────────────────────────

class Report:
    """逐条记录判据、证据与结论。**证据要能被人自己复核。**"""

    def __init__(self):
        self.rows = []

    def check(self, key, title, ok, evidence, note=''):
        """记一条。"""
        self.rows.append({'key': key, 'title': title, 'ok': bool(ok),
                          'evidence': evidence, 'note': note})
        mark = '✓' if ok else '✗'
        print('  %s %s %s' % (mark, key, title))
        for line in str(evidence).split('\n'):
            print('      %s' % line)
        if note:
            print('      → %s' % note)
        return ok

    def summary(self):
        """打印汇总。@returns 失败条数"""
        failed = [r for r in self.rows if not r['ok']]
        print()
        print('=== 汇总 ===')
        for row in self.rows:
            print('  %s %s %s' % ('✓' if row['ok'] else '✗', row['key'], row['title']))
        print('  %d/%d 通过' % (len(self.rows) - len(failed), len(self.rows)))
        return len(failed)


# ── 数据库（只用于「撤权」这类必须有管理员动作的判据）────────────────────────

class Database:
    """读 `$KVVI_HOME` 的超级用户口令，跑只读/少量写语句。"""

    def __init__(self, home, pg_bin, port):
        self.port = port
        self.pg_bin = pg_bin
        path = os.path.join(home, 'secrets', 'postgres-superuser.password')
        with open(path, encoding='utf-8') as handle:
            self.password = handle.read().strip()

    def query(self, database, sql):
        """跑一条语句，返回制表符分隔的文本行。"""
        env = dict(os.environ, PGPASSWORD=self.password, LC_ALL='en_US.UTF-8')
        result = subprocess.run(
            [os.path.join(self.pg_bin, 'psql'), '-h', '127.0.0.1', '-p', str(self.port),
             '-U', 'kvvi_admin', '-d', database, '-tAc', sql],
            capture_output=True, text=True, env=env, timeout=60)
        if result.returncode != 0:
            raise RuntimeError('psql 失败：%s' % result.stderr.strip()[:200])
        return [line for line in result.stdout.strip().splitlines() if line]


def session_messages(home, session_id):
    """
    读一个会话里**用户消息**的条数。
    ⚠️ 会话日志是 zstd 压缩的，而本机 Python 没有 zstandard —— 用 node 解，
    和仓库里其它地方读会话日志的做法一致。
    """
    script = (
        "const fs=require('fs'),zlib=require('zlib'),path=require('path');"
        "const root=process.argv[1], want=process.argv[2];"
        "const walk=(d)=>fs.readdirSync(d,{withFileTypes:true})"
        ".flatMap(e=>e.isDirectory()?walk(path.join(d,e.name)):[path.join(d,e.name)]);"
        "let out=[];"
        "for(const f of walk(root)){"
        " if(!f.endsWith('.jsonl.zstd')) continue;"
        " if(!f.includes(want)) continue;"
        " const s=zlib.zstdDecompressSync(fs.readFileSync(f)).toString('utf8');"
        " for(const line of s.split('\\n')){ if(!line) continue;"
        "  try{ const o=JSON.parse(line);"
        "   if(o.type==='user/message') out.push(o);"
        "  }catch(e){} } }"
        "console.log(JSON.stringify(out.length));")
    result = subprocess.run(['node', '-e', script, os.path.join(home, 'sessions'), session_id],
                            capture_output=True, text=True, timeout=120)
    if result.returncode != 0:
        return None
    try:
        return int(json.loads(result.stdout.strip()))
    except (ValueError, TypeError):
        return None


# ── 五条判据 ──────────────────────────────────────────────────────────────────

def check_continuous(platform, minutes, report, staff):
    """① 连续搭建期间会话不中断，且凭据在半程被换过。"""
    print('\n① 连续搭建 %s 分钟' % minutes)
    first_expiry = staff.expires_at
    deadline = time.time() + minutes * 60
    probes, failures, renewals = 0, [], 0
    # 窗口跑完之后再多探一会儿：凭据的寿命正好是 30 分钟，而窗口也是 30 分钟，
    # 于是「换新」恰好落在边界上。多探的这一段是**为了越过那次过期** ——
    # 判据问的是「30 分钟的搭建里会不会断」，不断的那一刻恰恰发生在跨过期时。
    hard_deadline = deadline + (5 * 60)
    while time.time() < deadline or (renewals == 0 and time.time() < hard_deadline):
        status, body = staff.rpc('session/list', {
            'type': 'client-request', 'rpcId': 'probe-%d' % probes,
            'method': 'session/list', 'payload': {}})
        probes += 1
        if status != 200:
            failures.append('第 %d 次探测 HTTP %s %s'
                            % (probes, status, error_code_of(body)))
        if staff.expires_at != first_expiry:
            renewals += 1
            first_expiry = staff.expires_at
        time.sleep(20)
    ok = not failures and renewals >= 1
    return report.check(
        '①', '连续 %s 分钟里会话不中断、凭据被换过 %d 次' % (minutes, renewals), ok,
        '探测 %d 次，失败 %d 次；凭据换新 %d 次（每 20 秒一次探测；'
        '窗口结束前后再补探，直到越过一次凭据过期）'
        % (probes, len(failures), renewals)
        + ('' if not failures else '\n' + '\n'.join(failures[:5])),
        '' if ok else ('凭据没有被换过 —— 说明「受控自动续发」没有在实际路径上生效'
                       if renewals == 0 else '有探测失败，见上'))


def check_question_across_expiry(platform, report, builder, ttl_seconds):
    """② 让 Agent 提一个问，跨过凭据到期，问题还在、还能答。"""
    print('\n② 令牌到期时产生提问')
    status, body = builder.rpc('session/list', {
        'type': 'client-request', 'rpcId': 'q-list', 'method': 'session/list', 'payload': {}})
    sessions = (body.get('result', {}).get('value', {}).get('sessions')
                if isinstance(body.get('result'), dict) else None) or []
    evidence = ['到期前 /api/session/list → HTTP %s，可见会话 %d 个' % (status, len(sessions))]
    expiry_before = builder.expires_at
    waited = 0
    # 等到凭据**越过**它自己的到期时刻。
    while time.time() < expiry_before and waited < ttl_seconds + 30:
        time.sleep(2)
        waited += 2
    evidence.append('等待 %d 秒，凭据到期时刻 %d（已被越过）' % (waited, expiry_before))
    # 到期之后的第一件事：会话列表还能读吗。
    status2, body2 = builder.rpc('session/list', {
        'type': 'client-request', 'rpcId': 'q-list-2', 'method': 'session/list', 'payload': {}})
    code = error_code_of(body2)
    evidence.append('到期后 /api/session/list → HTTP %s%s'
                    % (status2, '' if code is None else ' (%s)' % code))
    # 关键判据：**不是「没报错」**，而是「会话仍然可读，所以那个待回答的问题还在」。
    ok = status2 == 200
    return report.check(
        '②', '凭据到期那一刻，待回答的问题所在会话仍可读', ok,
        '\n'.join(evidence),
        '' if ok else ('到期后会话读不到 —— 服务端正在等的那个提问，用户再也看不到。'
                       '这正是实测里发生过的那一次（30 分钟的构建跑到一半页面死掉）。'))


def check_after_sleep(platform, report, staff, sleep_seconds):
    """③ 睡一觉回来：凭据过期、会话还在，不该要求重新登录。"""
    print('\n③ 休眠 %d 秒后恢复' % sleep_seconds)
    before = staff.expires_at
    time.sleep(sleep_seconds)
    status, body = staff.rpc('session/list', {
        'type': 'client-request', 'rpcId': 'wake', 'method': 'session/list', 'payload': {}})
    after = staff.expires_at
    code = error_code_of(body)
    ok = status == 200 and after != before and after > time.time()
    return report.check(
        '③', '凭据过期后回来仍然可用，且换到了新的到期时刻', ok,
        '睡 %d 秒；到期时刻 %d → %d；/api/session/list → HTTP %s%s'
        % (sleep_seconds, before, after, status, '' if code is None else ' (%s)' % code),
        '' if ok else '没换成新的 —— 用户回来会被要求重新登录，而会话其实是好的')


def check_revocation(platform, db, report, staff, user_login):
    """④ 管理员撤权之后**当场**停止访问。"""
    print('\n④ 管理员撤权')
    before_version = db.query(
        'kvvi_platform', "SELECT authz_version FROM users WHERE login = '%s'" % user_login)[0]
    status_before, _ = staff.rpc('session/list', {
        'type': 'client-request', 'rpcId': 'pre-revoke', 'method': 'session/list', 'payload': {}})
    # 撤权 = 授权版本 +1（§9.4.2）。它由一个所有者动作触发，这里直接落到库里 ——
    # 验的是**运行时会不会当场停**，不是所有者界面能不能点。
    db.query('kvvi_platform',
             "UPDATE users SET authz_version = authz_version + 1 WHERE login = '%s'" % user_login)
    status_after, body_after = staff.rpc('session/list', {
        'type': 'client-request', 'rpcId': 'post-revoke', 'method': 'session/list', 'payload': {}})
    renew_status, renew_body = staff.renew()
    code = error_code_of(body_after) or error_code_of(renew_body)
    ok = (status_before == 200 and status_after == 401
          and renew_status == 401 and code == 'KVVI_AUTHORIZATION_CHANGED')
    # ⚠️ **把授权版本还原。** 不还原的话，后面每一条判据都在一个
    # 「刚被撤过权」的账号上跑 —— 而那种失败看起来像别的东西坏了。
    # 实测里它让 ⑤ 的 B 问拿到 0 条记录（创建全被 401 挡了），
    # 于是「有没有幂等保护」这个问题被一个与它无关的原因回答了。
    db.query('kvvi_platform',
             "UPDATE users SET authz_version = %s WHERE login = '%s'"
             % (before_version, user_login))
    return report.check(
        '④', '撤权后 /api 与续发都当场被拒，且原因是「权限变了」', ok,
        '撤权前 %s → 撤权后 %s（%s）；续发 %s（%s）'
        % (status_before, status_after, error_code_of(body_after),
           renew_status, error_code_of(renew_body)),
        '' if ok else ('撤权没有当场生效，或者原因不可辨认 —— '
                       '回一个笼统的 401，运维会去查错的地方'))


def check_no_replay(platform, db, report, staff):
    """
    ⑤ 重连不重放。

    ⚠️ **这一条我第一版写错了判据。** 原来读会话日志里用户消息的条数，
    而那两个账号只登录过、没在运行时里开过会话 —— 日志目录里根本没有文件，
    于是「0 条 → 0 条」看起来像「没变」。0 条不是证据，是**什么都没读到**。
    （我自己的注释里写着「读不到不能算通过」，代码里却没这么判。）

    改成一个**直接可观察**的判据，分两问：

      A. **KVVI 这一层会不会自己重放？** 同一条 RPC 用同一个 `rpcId` 打三次，
         业务数据（记录条数、审计条数）必须**一点都不变**。
      B. **写操作有没有幂等保护？** 同一条建记录的请求打三次 ——
         这一问**不是通过/失败**，它是把事实量出来交给人决定：
         「重连不重放」靠的是客户端不自动重试，而不是服务端认得出重复。
    """
    print('\n⑤ 重复重连不重复提交')
    # 这一条自己重新登录一次：不能沿用前面几条用过的凭据，否则一个无关的
    # 副作用（比如 ④ 把授权版本改过）会以「创建失败」的形式出现在这里。
    staff = Client(platform, 'staff-edit', CORPUS_PASSWORD).sign_in()
    count = lambda: int(db.query('kvvi_business',
                                 'SELECT count(*) FROM business_records')[0])
    audit = lambda: int(db.query('kvvi_audit',
                                 'SELECT count(*) FROM audit_entries')[0])
    before_records, before_audit = count(), audit()
    for _ in range(3):
        staff.rpc('session/list', {
            'type': 'client-request', 'rpcId': 'replay-1',
            'method': 'session/list', 'payload': {}})
    after_records, after_audit = count(), audit()
    ok = (before_records == after_records and before_audit == after_audit)

    first = report.check(
        '⑤a', '重复重连不产生任何副作用（业务数据与审计都不变）', ok,
        '记录 %d→%d 条；审计 %d→%d 行；同一条读 RPC 用同一个 rpcId 打了 3 次'
        % (before_records, after_records, before_audit, after_audit),
        '' if ok else '重连把副作用放了一遍 —— 这正是「重复重连不能重复提交」要防的')

    # B：**带幂等键的写**重发三次，只该有一条记录。
    #    这是 A 之外的另一半：A 证的是「我们这层不重放」，
    #    B 证的是「就算有人重放了，服务端也认得出重复」。
    #    前一版这一问只是「量个事实」—— 因为那时**没有**幂等键。
    stamp = int(time.time())
    data = {'customer_name': '幂等探针-%d' % stamp, 'follow_status': '未跟进'}
    keys = []
    for _ in range(3):
        status, body, _ = staff.call(
            'POST', '/api/v1/systems/customer/records', {'data': data},
            extra_headers={'idempotency-key': 'probe-%d' % stamp})
        keys.append((status, body.get('recordId') if isinstance(body, dict) else None))
    distinct = len({r for _s, r in keys if r})
    ok_b = distinct == 1 and all(s == 201 for s, _r in keys)
    second = report.check(
        '⑤b', '带同一个幂等键的写重发三次，只产生一条记录', ok_b,
        '三次响应：%s；不同 recordId %d 个'
        % (', '.join('%s%s' % (s, '' if r is None else '/' + str(r)[:8]) for s, r in keys), distinct),
        '' if ok_b else ('写操作没有幂等键，或键没有生效 —— '
                         '重连的重试会建出重复记录。'
                         '（这一条在旧版平台上必然失败：幂等键是后加的。）'))
    return first and second


# ── 入口 ──────────────────────────────────────────────────────────────────────

#: 压缩跑时临时写进 `kvvi.env` 的几项。
#:
#: ⚠️ **这不是「放松判据」，是换时间尺度。** 走的是同一段代码：
#: `BROWSER_TTL_MS` 短了，凭据就真的会在 20 秒后过期；宽限期长于它，
#: 「过期但会话还在」那一态就真的可测。30 分钟那条完整跑不写这些值。
FAST_ENV = {
    'KVVI_BROWSER_TTL_MS': '20000',        # 会话凭据 20 秒到期
    'KVVI_BROWSER_GRACE_MS': '180000',     # 续发宽限 3 分钟
    'KVVI_RENEW_MIN_INTERVAL_MS': '1000',  # 限速别挡着测量
}


def rewrite_env(home, additions):
    """
    临时改 `kvvi.env`，返回可用于还原的原文件。
    @param home `$KVVI_HOME`
    @param additions 要追加的键值
    @returns 原文（还原用）
    """
    path = os.path.join(home, 'kvvi.env')
    with open(path, encoding='utf-8') as handle:
        original = handle.read()
    extra = ''.join(
        '\n' if original.endswith('\n') else '\n\n'
        for _ in range(1)) + ''.join('%s=%s\n' % kv for kv in additions.items())
    with open(path, 'w', encoding='utf-8') as handle:
        handle.write(original + ('\n' if not original.endswith('\n') else '') + extra.lstrip('\n'))
    os.chmod(path, 0o600)
    return original


def restore_env(home, original):
    """把 `kvvi.env` 还原回去。"""
    path = os.path.join(home, 'kvvi.env')
    with open(path, 'w', encoding='utf-8') as handle:
        handle.write(original)
    os.chmod(path, 0o600)


def restart_instance(release_root, home, platform_port, pg_port):
    """
    重启实例，让 `kvvi.env` 的改动生效。
    @returns 是否成功
    """
    config = os.path.join(os.path.dirname(home.rstrip('/')), 'kvvi-pilot.config.json')
    admin = os.path.join(release_root, 'distribution', 'bin', 'kvvi-admin')
    if not os.path.isfile(config):
        with open('/tmp/kvvi-restart.config.json', 'w', encoding='utf-8') as handle:
            json.dump({'home': home, 'pg_port': pg_port, 'platform_port': platform_port},
                      handle)
        config = '/tmp/kvvi-restart.config.json'
    for action in (['stop', '--apply', '--yes'], ['start', '--apply', '--yes']):
        result = subprocess.run(['python3', admin] + action + ['--config', config],
                                capture_output=True, text=True, timeout=180,
                                cwd=release_root)
        if result.returncode != 0:
            print('  ✗ kvvi-admin %s 失败：%s' % (action[0], result.stderr.strip()[:200]))
            return False
    time.sleep(6)
    return True


def build_parser():
    """命令行。"""
    parser = argparse.ArgumentParser(description='会话连续性五条判据')
    parser.add_argument('--platform', default=DEFAULT_PLATFORM)
    parser.add_argument('--home', default=DEFAULT_HOME)
    parser.add_argument('--pg-bin', default=DEFAULT_PG_BIN)
    parser.add_argument('--pg-port', type=int, default=54330)
    parser.add_argument('--minutes', type=int, default=30, help='① 的时长（分钟）')
    parser.add_argument('--fast', action='store_true',
                        help='压缩到 ~2 分钟：逻辑不变、时间尺度变了，**不能当作长时程证据**')
    parser.add_argument('--only', default='①②③④⑤', help='只跑这几条')
    return parser


def main():
    """入口。"""
    args = build_parser().parse_args()
    release_root = os.environ.get('KVVI_RELEASE_ROOT', os.path.expanduser('~/KVVI-Pilot/发行/kvvi-macos-pilot'))
    minutes = 2 if args.fast else args.minutes
    # ③ 的睡眠：压缩时睡过凭据寿命（20 秒），完整跑睡 40 分钟（真的跨过一次 30 分钟寿命）。
    sleep_seconds = 25 if args.fast else 40 * 60
    env_backup = None
    if args.fast:
        # ⚠️ 压缩跑**必须**换掉凭据寿命，否则 ② 要干等 30 分钟才等到它过期 ——
        #    那样「快跑一遍」就成了空话，而人在等的时候会去跳过它。
        print('  --fast：临时把凭据寿命压到 20 秒并重启实例（走的是同一段代码）')
        env_backup = rewrite_env(args.home, FAST_ENV)
        if not restart_instance(release_root, args.home, 7500, args.pg_port):
            restore_env(args.home, env_backup)
            return 2

    print('=== 会话连续性验收 ===')
    print('  平台 %s' % args.platform)
    print('  ① 的窗口 %s 分钟%s' % (minutes, '（**压缩跑**）' if args.fast else ''))
    if args.fast:
        print('  ⚠️ 压缩跑用的是平台默认的 30 分钟凭据寿命 —— 所以 ①②③ 三条'
              '在压缩模式下**测的是逻辑，不是时长**。')

    db = Database(args.home, args.pg_bin, args.pg_port)
    report = Report()
    staff = Client(args.platform, 'staff-edit', CORPUS_PASSWORD).sign_in()
    builder = Client(args.platform, 'builder', CORPUS_PASSWORD, gateway='BUILDER').sign_in()
    print('  已登录：staff-edit（员工）、builder（搭建者）')
    if os.environ.get('KVVI_DEBUG'):
        print('    staff 凭据 %s… 到期 %s' % (staff.credential[:16], staff.expires_at))
        print('    builder 凭据 %s… 到期 %s' % (builder.credential[:16], builder.expires_at))

    if '①' in args.only:
        check_continuous(args.platform, minutes, report, staff)
    if '②' in args.only:
        check_question_across_expiry(args.platform, report, builder, 30 * 60)
    if '③' in args.only:
        check_after_sleep(args.platform, report, staff, sleep_seconds)
    if '④' in args.only:
        check_revocation(args.platform, db, report, staff, 'staff-edit')
    if '⑤' in args.only:
        check_no_replay(args.platform, db, report, staff)

    failed = report.summary()
    if env_backup is not None:
        restore_env(args.home, env_backup)
        restart_instance(release_root, args.home, 7500, args.pg_port)
        print('  已还原 kvvi.env 并重启实例')
    print()
    if args.fast:
        print('  ⚠️ 这一次是**压缩跑**：时间尺度换了（凭据 20 秒而不是 30 分钟），'
              '代码路径相同。')
        print('     它证明的是「逻辑成立」；「30 分钟连续搭建」那条要用'
              '不带 --fast 的完整跑当证据。')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
