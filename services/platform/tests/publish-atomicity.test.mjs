/**
 * 批次② · 发布原子性与多系统共存（验收报告 S3 / S4）。
 *
 * | 项 | 缺陷 | 期望 |
 * |---|---|---|
 * | S3 | 契约保存失败时策略已提交，草案停在 APPROVED、无发布记录 | 整次发布原子回滚 |
 * | S4 | 发布第二个系统时把第一个系统的策略整体删光 | 按系统保留策略，多系统共存 |
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { pool, closeAll } from '../src/db.mjs'
import { A, resetDatabase, grantPlatformRole, makeSession, adminQuery } from './harness.mjs'
import { publishSubmit, publishApprove, publishCommit } from '../src/publish-api.mjs'

let builder
let owner

before(async () => {
  await resetDatabase()
  // 提交人与审批人必须是两个人（自审批禁令）。
  await grantPlatformRole(A.bob, 'owner')
  owner = await makeSession(A.bob, A.company)
  builder = await makeSession(A.alice, A.company, 'BUILDER')
  // 契约要声明的角色必须先存在。
  await pool('platform').query(
    `INSERT INTO roles (role_id, company_id, role_code, name)
     VALUES (gen_random_uuid(), $1, 'sales', '销售') ON CONFLICT DO NOTHING`,
    [A.company])
})
after(closeAll)

/** 为某个系统代号构造六份契约，FORM 策略挂在它自己的 asset_id 上。 */
function contractsFor(assetId) {
  return {
    'business-schema': { fields: [] },
    'view-schema': { componentsTree: [] },
    'workflow-spec': { states: [] },
    'permission-spec': { roles: [{ role_code: 'sales', name: '销售' }],
      policies: [{ policy_code: `p_${assetId}`, role_code: 'sales',
        dimension: 'FORM', resource_ref: { asset_id: assetId }, effect: 'ALLOW',
        actions: ['read'] }] },
    'tool-spec': { tools: [] },
    'app-model-command': { commands: [] },
  }
}

/** 提交 → 审批 → 发布，一条龙走完。 */
async function publishSystem(assetId) {
  const submitted = await publishSubmit({
    session: { ...builder.ctx }, payload: { assetId, contracts: contractsFor(assetId) },
  })
  assert.equal(submitted.status, 201, '提交失败')
  const draftId = submitted.body.draftId
  const approved = await publishApprove({
    session: { ...owner.ctx }, draftId,
    payload: { decision: 'APPROVE', changeDigest: submitted.body.changeDigest },
  })
  assert.equal(approved.status, 200, '审批失败')
  const published = await publishCommit({ session: { ...owner.ctx }, draftId, payload: {} })
  assert.equal(published.status, 201, '发布失败')
  return { draftId }
}

/** 某资源码在当前公司还有多少条策略。 */
async function policyCount(resourceCode) {
  const { rows } = await pool('platform').query(
    `SELECT count(*)::int AS n FROM policies WHERE company_id = $1 AND resource_code = $2`,
    [A.company, resourceCode])
  return rows[0].n
}

describe('批次② · 发布原子性与多系统共存', () => {
  test('S4 · 发布第二个系统不删第一个系统的策略', async () => {
    await publishSystem('s4_a')
    await publishSystem('s4_b')
    assert.ok((await policyCount('s4_a')) >= 1, 's4_a 的策略被 s4_b 的发布删光了')
    assert.ok((await policyCount('s4_b')) >= 1, 's4_b 的策略没写进去')
  })

  test('S3 · 契约保存失败时整次发布原子回滚', async () => {
    const assetId = 's3_atomic'
    const submitted = await publishSubmit({
      session: { ...builder.ctx }, payload: { assetId, contracts: contractsFor(assetId) },
    })
    const draftId = submitted.body.draftId
    await publishApprove({
      session: { ...owner.ctx }, draftId,
      payload: { decision: 'APPROVE', changeDigest: submitted.body.changeDigest },
    })

    // 在契约保存这一环注入存储错误：把契约表改名，INSERT 会 42P01。
    await adminQuery('kvvi_platform',
      'ALTER TABLE published_contracts RENAME TO contracts_unavailable')
    try {
      await assert.rejects(
        () => publishCommit({ session: { ...owner.ctx }, draftId, payload: {} }),
        { code: '42P01' },
      )
    } finally {
      await adminQuery('kvvi_platform',
        'ALTER TABLE contracts_unavailable RENAME TO published_contracts')
    }

    // 失败后：草案仍 APPROVED，无发布记录，无系统登记，策略也没提交。
    const { rows: draft } = await pool('platform').query(
      'SELECT status FROM publish_drafts WHERE draft_id = $1', [draftId])
    assert.equal(draft[0].status, 'APPROVED', '发布失败后草案状态不是 APPROVED')
    const rec = await pool('platform').query(
      'SELECT count(*)::int AS n FROM publish_records WHERE draft_id = $1', [draftId])
    assert.equal(rec.rows[0].n, 0, '发布失败却留下了发布记录')
    const sys = await pool('platform').query(
      'SELECT count(*)::int AS n FROM systems WHERE company_id = $1 AND asset_id = $2',
      [A.company, assetId])
    assert.equal(sys.rows[0].n, 0, '发布失败却登记了系统')
    assert.equal(await policyCount(assetId), 0, '发布失败但策略已提交')
  })
})
