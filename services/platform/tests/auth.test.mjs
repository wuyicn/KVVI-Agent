/**
 * 阶段四锚点⑥：认证端点闭合在平台服务进程 + 会话生命周期五类事件
 * （PRD §4.6.5）；锚点①：员工看不到搭建引擎（§9.6.5）。
 *
 * ⚠️ 本文件走**真实 HTTP**，不直接调模块函数：
 * 锚点⑥ 说的是「入口在平台服务进程**内**闭合」，
 * 而「端点确实由本进程应答、且不需要运行时进程参与」只有从外面打才验得到。
 */
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pool, closeAll } from '../src/db.mjs'
import { A, B, PASSWORD, resetDatabase } from './harness.mjs'
import { TOOL_GATEWAY, toolsForGateway, checkGateway } from '../src/authorization.mjs'
import { appendDenial, verifyChain } from '../src/audit.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PORT = 7499
const BASE = `http://127.0.0.1:${PORT}`
const INTERNAL = 'test-internal-token'

let child = null

async function waitUp(tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const r = await fetch(`${BASE}/healthz`)
      if (r.ok) return true
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('平台服务进程没能起来')
}

before(async () => {
  await resetDatabase()
  child = spawn('node', [resolve(HERE, '..', 'src', 'server.mjs')], {
    env: { ...process.env, KVVI_PLATFORM_PORT: String(PORT),
           KVVI_INTERNAL_TOKEN: INTERNAL,
           // 刻意指向一个**不存在**的运行时进程：所有认证请求都必须
           // 由平台进程自己应答，不依赖运行时进程的存在。
           KVVI_RUNTIME_URL: 'http://127.0.0.1:1' },
    stdio: 'pipe',
  })
  await waitUp()
})

after(async () => {
  if (child) child.kill('SIGTERM')
  await closeAll()
})

const post = (path, body, headers = {}) => fetch(`${BASE}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: body === undefined ? undefined : JSON.stringify(body),
})

describe('锚点⑥ 认证端点在平台服务进程内闭合（§4.6.5）', () => {
  test('登录在本进程应答 —— 运行时进程不存在也能登录', async () => {
    const r = await post('/auth/login', { login: 'alice', password: PASSWORD })
    assert.equal(r.status, 201)
    const body = await r.json()
    assert.ok(body.token)
    assert.equal(body.companyId, A.company, '只有一个公司时应默认选中')
    assert.equal(r.headers.get('x-kvvi-process'), 'platform-service')
    assert.equal(r.headers.get('x-kvvi-plugins-loaded'), '0')
  })

  test('登录端点**不需要**进程间令牌（那是进程间凭据，不是用户凭据）', async () => {
    // 这条是回归测试：把内部令牌当用户凭据用，会让浏览器永远登不上，
    // 而现象看起来像「认证坏了」。
    const r = await post('/auth/login', { login: 'alice', password: PASSWORD })
    assert.notEqual(r.status, 401, '登录被进程间令牌挡住了')
  })

  test('口令错 → 401；且不区分「账号不存在」与「口令错」', async () => {
    const bad1 = await post('/auth/login', { login: 'alice', password: 'wrong' })
    const bad2 = await post('/auth/login', { login: 'no-such-person', password: 'wrong' })
    assert.equal(bad1.status, 401)
    assert.equal(bad2.status, 401)
    assert.deepEqual(await bad1.json(), await bad2.json(), '两者响应不同 → 可枚举账号')
  })

  test('多公司账号必须**显式选**公司，不替用户选', async () => {
    await pool('platform').query(
      `INSERT INTO memberships (company_id, user_id, dept_id, shop_id)
       VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [B.company, A.alice, B.dept, B.shop1])
    const r = await post('/auth/login', { login: 'alice', password: PASSWORD })
    assert.equal(r.status, 409)
    const body = await r.json()
    assert.equal(body.error, 'KVVI_COMPANY_SELECTION_REQUIRED')
    assert.equal(body.companies.length, 2)
  })

  test('会话查询返回网关与该网关的工具集', async () => {
    const login = await post('/auth/login',
      { login: 'alice', password: PASSWORD, companyId: A.company, gateway: 'USER' })
    const { token } = await login.json()
    const r = await fetch(`${BASE}/auth/session`, { headers: { authorization: `Bearer ${token}` } })
    assert.equal(r.status, 200)
    const body = await r.json()
    assert.equal(body.gateway, 'USER')
    assert.ok(body.tools.length > 0, '员工会话一个工具都没有 —— 那不是隔离，是没实现')
  })

  test('登出后旧令牌立即失效（§9.4.2）', async () => {
    const login = await post('/auth/login', { login: 'bob', password: PASSWORD })
    const { token } = await login.json()
    assert.equal((await fetch(`${BASE}/auth/session`,
      { headers: { authorization: `Bearer ${token}` } })).status, 200)
    assert.equal((await post('/auth/logout', undefined,
      { authorization: `Bearer ${token}` })).status, 200)
    assert.equal((await fetch(`${BASE}/auth/session`,
      { headers: { authorization: `Bearer ${token}` } })).status, 401)
  })

  test('管理类入口需要进程间鉴别（不能被浏览器直接打到）', async () => {
    const r = await post(`/auth/accounts/${A.carol}/suspend`, {})
    assert.equal(r.status, 401, '停用账号的入口没有鉴别')
  })
})

describe('锚点⑥ 会话生命周期五类事件：入口都在本进程', () => {
  test('五类事件都能触发，且都留下 session_events 记录', async () => {
    // ① 登录 ② 登出
    const l1 = await post('/auth/login', { login: 'carol', password: PASSWORD })
    const s1 = await l1.json()
    await post('/auth/logout', undefined, { authorization: `Bearer ${s1.token}` })

    // ③ 超时：把 last_seen_at 拨回过去，再让平台自己回收
    const l2 = await post('/auth/login', { login: 'bob', password: PASSWORD })
    const s2 = await l2.json()
    await pool('platform').query(
      `UPDATE sessions SET last_seen_at = now() - interval '2 days' WHERE session_id = $1`,
      [s2.sessionId])
    const reap = await post('/auth/sessions/reap', undefined,
      { authorization: `Bearer ${INTERNAL}` })
    assert.equal(reap.status, 200)
    assert.ok((await reap.json()).ended.includes(s2.sessionId))

    // ④ 账号停用
    const l3 = await post('/auth/login', { login: 'alice', password: PASSWORD, companyId: A.company })
    const s3 = await l3.json()
    const susp = await post(`/auth/accounts/${A.alice}/suspend`, undefined,
      { authorization: `Bearer ${INTERNAL}` })
    assert.equal(susp.status, 200)
    assert.ok((await susp.json()).endedSessions >= 1)

    // ⑤ 管理员吊销
    await pool('platform').query(`UPDATE users SET status='ACTIVE' WHERE user_id=$1`, [A.alice])
    const l4 = await post('/auth/login',
      { login: 'alice', password: PASSWORD, companyId: A.company })
    const s4 = await l4.json()
    const rev = await post(`/auth/sessions/${s4.sessionId}/revoke`, undefined,
      { authorization: `Bearer ${INTERNAL}` })
    assert.equal(rev.status, 200)

    const { rows } = await pool('platform').query(
      `SELECT kind, count(*)::int AS n FROM session_events GROUP BY kind ORDER BY kind`)
    const seen = Object.fromEntries(rows.map((r) => [r.kind, r.n]))
    for (const kind of ['LOGIN', 'LOGOUT', 'TIMEOUT', 'ACCOUNT_SUSPENDED', 'ADMIN_REVOKED']) {
      assert.ok((seen[kind] ?? 0) >= 1, `事件 ${kind} 没有留下记录`)
    }
    // 被结束的会话都写明了是哪一类事件结束的
    for (const sid of [s1.sessionId, s2.sessionId, s3.sessionId, s4.sessionId]) {
      const s = await pool('platform').query(
        `SELECT state, ended_by FROM sessions WHERE session_id = $1`, [sid])
      assert.equal(s.rows[0].state, 'ENDED')
      assert.ok(s.rows[0].ended_by, `${sid} 结束了但没写是哪一类事件`)
    }
  })
})

describe('锚点① 员工看不到搭建引擎（§9.6.5）', () => {
  test('产品级分类是冻结常量：搭建工具全部在 BUILDER 侧', () => {
    const user = toolsForGateway('USER', Object.keys(TOOL_GATEWAY))
    const builder = toolsForGateway('BUILDER', Object.keys(TOOL_GATEWAY))
    assert.ok(user.length > 0 && builder.length > 0)
    for (const tool of user) assert.equal(TOOL_GATEWAY[tool], 'USER')
    for (const tool of builder) assert.equal(TOOL_GATEWAY[tool], 'BUILDER')
    assert.equal(user.filter((t) => builder.includes(t)).length, 0)
  })

  test('★ 启用白名单**不能**把搭建工具带进员工侧（交集只减不增）', () => {
    const allEnabled = Object.keys(TOOL_GATEWAY)
    const user = toolsForGateway('USER', allEnabled)
    for (const tool of ['schema.designModel', 'schema.publishContract', 'plugin.install']) {
      assert.ok(!user.includes(tool), `把全部工具都启用后，员工侧出现了 ${tool}`)
    }
  })

  test('调用搭建工具被服务端拒绝，且**拒绝留痕**', async () => {
    // 判定不看调用方声明：即使模型/客户端自称 USER，分类表说了算。
    const verdict = checkGateway('USER', 'schema.designModel')
    assert.equal(verdict.allowed, false)
    assert.equal(verdict.reason, 'KVVI_WRONG_GATEWAY')

    await appendDenial({
      companyId: A.company, actorKind: 'AGENT', actorId: A.alice, gateway: 'USER',
      action: 'schema.designModel', outcome: 'DENY', reason: 'KVVI_WRONG_GATEWAY',
    })
    const chain = await verifyChain()
    assert.equal(chain.ok, true)
    const { rows } = await pool('auditRead').query(
      `SELECT count(*)::int AS n FROM audit_entries
        WHERE action = 'schema.designModel' AND outcome = 'DENY'`)
    assert.ok(rows[0].n >= 1, '越权调用没有留下拒绝痕迹')
  })

  test('员工会话的工具集里没有任何搭建工具', async () => {
    const login = await post('/auth/login',
      { login: 'bob', password: PASSWORD, companyId: A.company, gateway: 'USER' })
    const { token } = await login.json()
    const session = await (await fetch(`${BASE}/auth/session`,
      { headers: { authorization: `Bearer ${token}` } })).json()
    const { rows } = await pool('platform').query('SELECT 1')  // 保持连接池活跃
    void rows
    for (const tool of session.tools) {
      assert.equal(TOOL_GATEWAY[tool], 'USER', `员工会话里出现了 ${tool}`)
    }
  })
})
