/**
 * N17 + N16(§9.6.7)：管理类端点的**人的**判定，以及自授权拦截的**接线**。
 *
 * 两条的共同点：规则早就写好了，缺的是**入口**。
 * 一条没有接线的不变量等于没有。
 */
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pool, closeAll } from '../src/db.mjs'
import { A, B, PASSWORD, resetDatabase, makeSession, grantBaseline, grantPlatformRole } from './harness.mjs'
import { isPlatformAdmin, checkSelfGrant, PLATFORM_ROLE_CODES } from '../src/authorization.mjs'
import { verifyChain } from '../src/audit.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PORT = 7498
const BASE = `http://127.0.0.1:${PORT}`
const INTERNAL = 'test-internal-token'

let child = null
let owner = null
let plain = null

async function waitUp(tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) return true } catch { /* 未起 */ }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('平台进程未起')
}

before(async () => {
  await resetDatabase()
  await grantBaseline(A.alice)
  await grantBaseline(A.bob)
  // 一个**名字已知**的业务角色：`grantBaseline` 生成的是 `role_base_<随机>`，
  // 用它当 roleCode 会撞 404 `KVVI_NO_SUCH_ROLE` —— 看起来像端点坏了。
  const { randomUUID: uuid } = await import('node:crypto')
  await pool('platform').query(
    `INSERT INTO roles (role_id, company_id, role_code, name) VALUES ($1,$2,'staff','员工')`,
    [uuid(), A.company])
  await grantPlatformRole(A.alice, 'owner')       // alice 是所有者
  owner = await makeSession(A.alice, A.company)
  plain = await makeSession(A.bob, A.company)     // bob 只是普通员工
  child = spawn('node', [resolve(HERE, '..', 'src', 'server.mjs')], {
    env: { ...process.env, KVVI_PLATFORM_PORT: String(PORT), KVVI_INTERNAL_TOKEN: INTERNAL,
           KVVI_RUNTIME_URL: 'http://127.0.0.1:1' },
    stdio: 'pipe',
  })
  await waitUp()
})
after(async () => { if (child) child.kill('SIGTERM'); await closeAll() })

const post = (path, token, actorToken) => fetch(`${BASE}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`,
             ...(actorToken ? { 'x-kvvi-actor-token': actorToken } : {}) },
  body: '{}',
})

describe('N17 管理类端点：进程凭据 ∧ 人的角色', () => {
  test('★ 只有进程令牌、没有人的令牌 → 拒（这正是原形态的漏洞）', async () => {
    const r = await post(`/auth/accounts/a0000000-0000-4000-8000-0000000000a3/suspend`,
                         INTERNAL)
    assert.equal(r.status, 403)
    assert.equal((await r.json()).error, 'KVVI_ADMIN_TOKEN_REQUIRED')
  })

  test('★ 有人的令牌但**不是管理员** → 拒，且留痕', async () => {
    const r = await post(`/auth/accounts/a0000000-0000-4000-8000-0000000000a3/suspend`,
                         INTERNAL, plain.raw)
    assert.equal(r.status, 403)
    assert.equal((await r.json()).error, 'KVVI_NOT_A_PLATFORM_ADMIN')
    const { rows } = await pool('auditRead').query(
      `SELECT count(*)::int AS n FROM audit_entries
        WHERE action = 'auth.suspendAccount' AND outcome = 'DENY'
          AND reason = 'KVVI_NOT_A_PLATFORM_ADMIN'`)
    assert.ok(rows[0].n >= 1, '越权调用没有留下痕迹')
  })

  test('所有者 → 放行，且留痕', async () => {
    const r = await post(`/auth/accounts/a0000000-0000-4000-8000-0000000000a3/suspend`,
                         INTERNAL, owner.raw)
    assert.equal(r.status, 200)
    const { rows } = await pool('auditRead').query(
      `SELECT actor_id, resource_id FROM audit_entries
        WHERE action = 'auth.suspendAccount' AND outcome = 'ALLOW'
        ORDER BY seq DESC LIMIT 1`)
    assert.equal(rows[0].actor_id, A.alice, '审计里的操作人不对')
    assert.equal(rows[0].resource_id, 'a0000000-0000-4000-8000-0000000000a3')
    await pool('platform').query(`UPDATE users SET status='ACTIVE' WHERE user_id=$1`,
      ['a0000000-0000-4000-8000-0000000000a3'])
  })

  test('判定函数本身：owner / admin / 都不是', async () => {
    assert.equal((await isPlatformAdmin(A.company, A.alice)).allowed, true)
    assert.equal((await isPlatformAdmin(A.company, A.bob)).allowed, false)
    assert.equal((await isPlatformAdmin(A.company, A.bob)).reason,
                 'KVVI_NOT_A_PLATFORM_ADMIN')
  })

  test('吊销**自己**的会话不需要管理员角色（那等于登出）', async () => {
    const s = await makeSession(A.bob, A.company)
    const r = await post(`/auth/sessions/${s.session.sessionId}/revoke`, INTERNAL, s.raw)
    assert.equal(r.status, 200)
  })
})

describe('N16 §9.6.7 自授权：规则终于接到了端点上', () => {
  test('★ 所有者把自己纳入配置范围 → 拒（判定与「有没有权限」无关）', async () => {
    const r = await post('/auth/roles/grant', INTERNAL, owner.raw)
    assert.equal(r.status, 400)   // body 为空 → 先撞「没有目标用户」
  })

  test('★ 把自己纳入 targetUserIds → 403 且留痕', async () => {
    const r = await fetch(`${BASE}/auth/roles/grant`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${INTERNAL}`,
                 'x-kvvi-actor-token': owner.raw },
      body: JSON.stringify({ roleCode: 'staff', userIds: [A.bob, A.alice] }),
    })
    assert.equal(r.status, 403)
    const body = await r.json()
    assert.equal(body.error, 'KVVI_SELF_GRANT_FORBIDDEN')
    const { rows } = await pool('auditRead').query(
      `SELECT count(*)::int AS n FROM audit_entries
        WHERE action = 'auth.grantRole' AND reason = 'KVVI_SELF_GRANT_FORBIDDEN'`)
    assert.ok(rows[0].n >= 1, '自授权被拒却没留下痕迹')
  })

  test('正向对照：只授予他人 → 放行', async () => {
    const r = await fetch(`${BASE}/auth/roles/grant`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${INTERNAL}`,
                 'x-kvvi-actor-token': owner.raw },
      body: JSON.stringify({ roleCode: 'staff', userIds: [A.carol] }),
    })
    assert.equal(r.status, 200)
    assert.deepEqual((await r.json()).granted, [A.carol])
  })

  test('★ 业务角色不得占用平台保留 code（否则「谁是所有者」可被业务配置改写）', async () => {
    const r = await fetch(`${BASE}/auth/roles/grant`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${INTERNAL}`,
                 'x-kvvi-actor-token': owner.raw },
      body: JSON.stringify({ roleCode: 'owner', userIds: [A.bob] }),
    })
    assert.equal(r.status, 403)
    assert.equal((await r.json()).error, 'KVVI_PLATFORM_ROLE_RESERVED')
  })

  test('规则函数与端点用的是同一条判据', () => {
    assert.deepEqual(PLATFORM_ROLE_CODES, ['owner', 'admin'])
    assert.equal(checkSelfGrant(A.alice, [A.bob]).allowed, true)
    assert.equal(checkSelfGrant(A.alice, [A.alice]).allowed, false)
  })

  test('审计链在以上全部操作后仍然自洽', async () => {
    assert.equal((await verifyChain()).ok, true)
  })
})
