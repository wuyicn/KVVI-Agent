/**
 * P1 阻塞项回归（2026-10-13 整体验收报告 S1 / S2 / S5）。
 *
 * 这三条都是「授权上下文丢失维度」一类：资源身份（schema）或资源维度（档位）
 * 在某个执行点被丢掉，于是「在 A 上有的权限」泄漏到「只在 B 上该有」的地方。
 *
 * | 项 | 缺陷 | 修法 |
 * |---|---|---|
 * | S1 | 记录 UUID 放进别的系统路径，读/写不看记录的真实 schema | 读/写按 schema 过滤 |
 * | S2 | DATA 档位跨资源取并集，COMPANY 泄漏到只有 SELF 的资源 | 档位按资源维度，RLS 按行 schema 解析 |
 * | S5 | 被委托者改自己所在角色的策略 = 自授权 | replacePolicies 加自成员闸 |
 */
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { pool, closeAll } from '../src/db.mjs'
import { A, RECORDS, resetDatabase, grantBaseline, grantPlatformRole,
         makeSession, adminQuery } from './harness.mjs'
import { handleApi } from '../src/api-router.mjs'
import { handleAuth } from '../src/auth.mjs'

let owner = null
let delegate = null

/** 直接调路由器（复用认证模块自己的会话端点，与 server 接线一致）。 */
async function api(method, path, session, body) {
  return await handleApi({
    method, path, query: '', body: body === undefined ? null : JSON.stringify(body),
    headers: session === null ? {} : { authorization: 'Bearer ' + session.raw },
    loadSession: (token) => handleAuth({
      method: 'GET', path: '/auth/session', body: null,
      headers: { authorization: 'Bearer ' + token },
      omitOtherGateway: true,
    }),
  })
}

/** 给某账号在某资源上授 FORM 动作与 DATA 档位（独立的临时角色）。 */
async function grantOnResource(userId, resourceCode, actions, dataScopes) {
  const { randomUUID } = await import('node:crypto')
  const roleId = randomUUID()
  await pool('platform').query(
    `INSERT INTO roles (role_id, company_id, role_code, name) VALUES ($1,$2,$3,'p1')`,
    [roleId, A.company, `p1_${roleId.slice(0, 8)}`])
  await pool('platform').query(
    `INSERT INTO role_members (company_id, role_id, user_id) VALUES ($1,$2,$3)`,
    [A.company, roleId, userId])
  if (actions.length > 0) {
    await pool('platform').query(
      `INSERT INTO policies (policy_id, company_id, role_id, dimension, resource_code,
         actions, data_scopes, field_visibility)
       VALUES ($1,$2,$3,'FORM',$4,$5,'{}',NULL)`,
      [randomUUID(), A.company, roleId, resourceCode, actions])
  }
  await pool('platform').query(
    `INSERT INTO policies (policy_id, company_id, role_id, dimension, resource_code,
       actions, data_scopes, field_visibility)
     VALUES ($1,$2,$3,'DATA',$4,'{}',$5,NULL)`,
    [randomUUID(), A.company, roleId, resourceCode, dataScopes])
}

/** 建一个已知名字的业务角色，并返回其 role_id。 */
async function ensureRole(code) {
  const { randomUUID } = await import('node:crypto')
  const { rows } = await pool('platform').query(
    `INSERT INTO roles (role_id, company_id, role_code, name) VALUES ($1,$2,$3,$3)
     ON CONFLICT (company_id, role_code) DO UPDATE SET name = EXCLUDED.name
     RETURNING role_id`, [randomUUID(), A.company, code])
  return rows[0].role_id
}

before(async () => {
  await resetDatabase()
  await grantBaseline(A.alice)
  await grantBaseline(A.bob)
  await grantPlatformRole(A.alice, 'owner')
  await grantPlatformRole(A.carol, 'admin')
  owner = await makeSession(A.alice, A.company)
  delegate = await makeSession(A.carol, A.company)
})
after(closeAll)

describe('P1 阻塞项回归', () => {
  test('S1 · schema 绑定：public_item 路径读不到 general_item 记录', async () => {
    await grantOnResource(A.alice, 'public_item', ['read'], ['COMPANY'])
    const r = await api('GET', `/api/v1/systems/public_item/records/${RECORDS.bobOwn}`, owner)
    assert.equal(r.status, 404, 'general_item 记录经 public_item 路径被读出来了')
  })

  test('S1 · schema 绑定：public_item 路径改不到 general_item 记录', async () => {
    await grantOnResource(A.alice, 'public_item', ['update'], ['COMPANY'])
    const p = await api('PATCH', `/api/v1/systems/public_item/records/${RECORDS.bobOwn}`,
      owner, { rowVersion: 1, data: { title: '被串改' } })
    assert.equal(p.status, 404, 'general_item 记录经 public_item 路径被改到了')
    const { rows } = await adminQuery('kvvi_business',
      `SELECT data FROM business_records WHERE record_id = $1`, [RECORDS.bobOwn])
    assert.equal(rows[0].data.title, 'bob 自己的单', '被拒的串改仍改了数据')
  })

  test('S2 · 数据范围按资源：public_item 的 COMPANY 不泄漏到 general_item', async () => {
    await grantOnResource(A.alice, 'public_item', ['read'], ['COMPANY'])
    const r = await api('GET', `/api/v1/systems/general_item/records/${RECORDS.bobOwn}`, owner)
    assert.equal(r.status, 404, 'public_item 的 COMPANY 泄漏到了 general_item')
  })

  test('S2 · 正向对照：general_item 自己授了 COMPANY 就能读', async () => {
    await grantOnResource(A.alice, 'general_item', [], ['COMPANY'])
    const r = await api('GET', `/api/v1/systems/general_item/records/${RECORDS.bobOwn}`, owner)
    assert.equal(r.status, 200, 'general_item 授了 COMPANY 却读不到自己的记录')
  })

  test('S5 · 被委托者改自己所在角色的策略 → 403 自授权', async () => {
    const staffId = await ensureRole('staff')
    await pool('platform').query(
      `INSERT INTO role_members (company_id, role_id, user_id) VALUES ($1,$2,$3)
       ON CONFLICT DO NOTHING`, [A.company, staffId, A.carol])
    const r = await api('PUT', '/api/v1/admin/roles/staff/policies', delegate, {
      policies: [{ dimension: 'DATA', resourceCode: '*', dataScopes: ['COMPANY'] }],
    })
    assert.equal(r.status, 403, '被委托者改自己所在角色的策略被放行')
    assert.equal(r.body.error, 'KVVI_SELF_GRANT_FORBIDDEN')
    const { rows } = await pool('platform').query(
      `SELECT count(*)::int AS n FROM policies p WHERE p.role_id = $1`, [staffId])
    assert.equal(rows[0].n, 0, '被拒的自我策略替换仍生效了')
  })

  test('S5 · 正向对照：被委托者改**别人**角色的策略 → 放行', async () => {
    const otherId = await ensureRole('warehouse')
    const r = await api('PUT', '/api/v1/admin/roles/warehouse/policies', delegate, {
      policies: [{ dimension: 'DATA', resourceCode: '*', dataScopes: ['COMPANY'] }],
    })
    assert.equal(r.status, 200, '被委托者改别人角色被误拒')
    const { rows } = await pool('platform').query(
      `SELECT count(*)::int AS n FROM policies p WHERE p.role_id = $1`, [otherId])
    assert.equal(rows[0].n, 1)
  })
})
