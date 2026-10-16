/**
 * 批次③ · 字段可写性与审计（验收报告 S6 / S7 / S8）。
 *
 * | 项 | 缺陷 | 期望 |
 * |---|---|---|
 * | S6 | 产品 API 写入不留审计 | 创建/更新都写 audit_entries |
 * | S7 | API 更新放行 MASKED 字段（命令执行器拒） | 可写 ⟺ VISIBLE，两处一致 |
 * | S8 | 创建放行 READONLY 字段（更新拒） | 创建/更新同一判据 |
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { pool, closeAll } from '../src/db.mjs'
import { A, resetDatabase, grantBaseline, grantPlatformRole, makeSession,
         adminQuery } from './harness.mjs'
import { submitDraft, approveDraft, publishDraft, DIFF_FACES } from '../src/publish.mjs'
import { handleApi } from '../src/api-router.mjs'
import { handleAuth } from '../src/auth.mjs'

const ASSET = 'write_item'
const CHANGE = { kind: 'permission-policy', roleCode: 'staff', addScopes: ['COMPANY'] }
const DIFF = { faces: DIFF_FACES, added: [{ dim: 'DATA', scope: 'COMPANY' }],
               removed: [], changed: [], counts: { added: 1, removed: 0, changed: 0 } }

let owner
let approver
let worker

function model() {
  return {
    schema_code: ASSET, name: '写入测试',
    fields: [
      { field_code: 'title', label: '标题', type: 'short_text', required: true },
      { field_code: 'amount', label: '金额', type: 'short_text', required: false },
      { field_code: 'locked', label: '锁定', type: 'short_text', required: false },
    ],
  }
}

async function publishSystem() {
  const contracts = [
    { contractType: 'business-schema', assetId: ASSET, content: model() },
    { contractType: 'view-schema', assetId: ASSET,
      content: { componentsTree: [] } },
    { contractType: 'workflow-spec', assetId: ASSET, content: { states: [] } },
    { contractType: 'permission-spec', assetId: ASSET, content: { roles: [], policies: [] } },
    { contractType: 'tool-spec', assetId: ASSET, content: { tools: [] } },
    { contractType: 'app-model-command', assetId: ASSET, content: { commands: [] } },
  ]
  const d = await submitDraft({ ctx: owner.ctx, change: { ...CHANGE, assetId: ASSET },
                                diffReport: DIFF, invariant: { ok: true } })
  const approved = await approveDraft({ ctx: approver.ctx, draftId: d.draftId, decision: 'APPROVE' })
  assert.equal(approved?.ok ?? true, true)
  const published = await publishDraft({
    ctx: approver.ctx, draftId: d.draftId,
    apply: async ({ diffDigest }) => ({ diffDigest }),
    system: { assetId: ASSET, name: '写入测试', schemaCode: ASSET },
    contracts,
  })
  assert.equal(published?.ok, true)
}

/** 给 worker 授 FORM 动作 + DATA 范围 + 字段可见性（amount=MASKED、locked=READONLY）。 */
async function grant() {
  const roleId = randomUUID()
  await pool('platform').query(
    `INSERT INTO roles (role_id, company_id, role_code, name) VALUES ($1,$2,$3,'w')`,
    [roleId, A.company, `w_${roleId.slice(0, 8)}`])
  await pool('platform').query(
    `INSERT INTO role_members (company_id, role_id, user_id) VALUES ($1,$2,$3)`,
    [A.company, roleId, A.alice])
  const policy = (dim, code, actions, scopes, vis) => pool('platform').query(
    `INSERT INTO policies (policy_id, company_id, role_id, dimension, resource_code,
       actions, data_scopes, field_visibility)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7)`,
    [A.company, roleId, dim, code, actions, scopes, vis])
  await policy('FORM', ASSET, ['read', 'create', 'update'], [], null)
  await policy('DATA', ASSET, [], ['COMPANY'], null)
  await policy('FIELD', 'title', ['read'], [], 'VISIBLE')
  await policy('FIELD', 'amount', ['read'], [], 'MASKED')
  await policy('FIELD', 'locked', ['read'], [], 'READONLY')
}

async function api(method, path, session, body) {
  return await handleApi({
    method, path, query: '', body: body === undefined ? null : JSON.stringify(body),
    headers: session === null ? {} : { authorization: 'Bearer ' + session.raw },
    loadSession: (token) => handleAuth({
      method: 'GET', path: '/auth/session', body: null,
      headers: { authorization: 'Bearer ' + token }, omitOtherGateway: true,
    }),
  })
}

/** 审计里某种动作的条数（含 ALLOW 与 DENY）。 */
async function auditCount(action) {
  const { rows } = await adminQuery('kvvi_audit',
    `SELECT count(*)::int AS n FROM audit_entries WHERE action = $1`, [action])
  return rows[0].n
}

before(async () => {
  await resetDatabase()
  await grantBaseline(A.alice)
  await grantBaseline(A.bob)
  await grantPlatformRole(A.alice, 'owner')
  await grantPlatformRole(A.bob, 'owner')
  owner = await makeSession(A.alice, A.company)
  approver = await makeSession(A.bob, A.company)
  worker = await makeSession(A.alice, A.company)
  await publishSystem()
  await grant()
})
after(closeAll)

describe('批次③ · 字段可写性与审计', () => {
  test('S8 · 创建 READONLY 字段 → 403（与更新同一判据）', async () => {
    const r = await api('POST', `/api/v1/systems/${ASSET}/records`, worker,
      { data: { title: '有只读字段', locked: '不该写' } })
    assert.equal(r.status, 403)
    assert.equal(r.body.error, 'KVVI_FIELD_NOT_WRITABLE')
    assert.deepEqual(r.body.fields, ['locked'])
  })

  test('S7 · 更新 MASKED 字段 → 403（与命令执行器同一判据）', async () => {
    const created = await api('POST', `/api/v1/systems/${ASSET}/records`, worker,
      { data: { title: '有掩码字段' } })
    assert.equal(created.status, 201)
    const r = await api('PATCH', `/api/v1/systems/${ASSET}/records/${created.body.recordId}`,
      worker, { data: { amount: '999' }, rowVersion: created.body.rowVersion })
    assert.equal(r.status, 403)
    assert.equal(r.body.error, 'KVVI_FIELD_NOT_WRITABLE')
    assert.deepEqual(r.body.fields, ['amount'])
  })

  test('正向对照：VISIBLE 字段创建与更新都放行', async () => {
    const created = await api('POST', `/api/v1/systems/${ASSET}/records`, worker,
      { data: { title: '正常字段' } })
    assert.equal(created.status, 201)
    const updated = await api('PATCH', `/api/v1/systems/${ASSET}/records/${created.body.recordId}`,
      worker, { data: { title: '改过了' }, rowVersion: created.body.rowVersion })
    assert.equal(updated.status, 200)
  })

  test('S6 · 产品 API 创建与更新都写审计', async () => {
    const before = await auditCount('record.create')
    const created = await api('POST', `/api/v1/systems/${ASSET}/records`, worker,
      { data: { title: '审计测试' } })
    assert.equal(created.status, 201)
    assert.equal(await auditCount('record.create'), before + 1, '创建没写审计')

    const upBefore = await auditCount('record.update')
    const updated = await api('PATCH', `/api/v1/systems/${ASSET}/records/${created.body.recordId}`,
      worker, { data: { title: '审计改' }, rowVersion: created.body.rowVersion })
    assert.equal(updated.status, 200)
    assert.equal(await auditCount('record.update'), upBefore + 1, '更新没写审计')
  })
})
