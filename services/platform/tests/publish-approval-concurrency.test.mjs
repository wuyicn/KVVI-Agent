/** Real isolated PostgreSQL: a delayed approval must never rewind publication. */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { pool, closeAll } from '../src/db.mjs'
import { A, resetDatabase, grantPlatformRole, makeSession } from './harness.mjs'
import { publishSubmit, publishApprove, publishCommit } from '../src/publish-api.mjs'

let builder, firstOwner, lateOwner
before(async () => {
  await resetDatabase()
  await grantPlatformRole(A.bob, 'owner')
  await grantPlatformRole(A.carol, 'owner')
  builder = await makeSession(A.alice, A.company, 'BUILDER')
  firstOwner = await makeSession(A.bob, A.company)
  lateOwner = await makeSession(A.carol, A.company)
  await pool('platform').query(
    `INSERT INTO roles (role_id,company_id,role_code,name)
     VALUES (gen_random_uuid(),$1,'sales','approval fixture') ON CONFLICT DO NOTHING`, [A.company])
})
after(closeAll)

function contractsFor(assetId) {
  return {
    'business-schema': { fields: [] },
    'view-schema': { componentsTree: [] },
    'workflow-spec': { states: [] },
    'permission-spec': { roles: [{ role_code: 'sales', name: 'sales' }],
      policies: [{ policy_code: `p_${assetId}`, role_code: 'sales', dimension: 'FORM',
        resource_ref: { asset_id: assetId }, effect: 'ALLOW', actions: ['read'] }] },
    'tool-spec': { tools: [] },
    'app-model-command': { commands: [] },
  }
}

for (const decision of ['APPROVE', 'REJECT']) {
  test(`late ${decision} after another owner publishes never rewinds or republishes`, { timeout: 20000 }, async () => {
    const assetId = `approval_race_${decision.toLowerCase()}`
    const submitted = await publishSubmit({ session: { ...builder.ctx }, payload: { assetId, contracts: contractsFor(assetId) } })
    assert.equal(submitted.status, 201)
    const { draftId, changeDigest } = submitted.body
    const database = pool('platform'), original = database.query
    let reached, release, timer, delayed = false
    const readReached = new Promise(resolve => { reached = resolve })
    const resume = new Promise(resolve => { release = resolve })
    database.query = async function (...args) {
      const value = await original.apply(this, args)
      const text = typeof args[0] === 'string' ? args[0] : args[0]?.text
      const values = args[1] ?? args[0]?.values
      if (!delayed && /SELECT\s+\*\s+FROM\s+publish_drafts\s+WHERE\s+draft_id\s*=\s*\$1/i.test(text ?? '') && values?.[0] === draftId) {
        delayed = true; reached()
        await resume // Preserve an actual returned row; never invent query data.
      }
      return value
    }
    const late = publishApprove({ session: { ...lateOwner.ctx }, draftId, payload: { decision, changeDigest } })
      .then(value => ({ value }), error => ({ error }))
    try {
      await Promise.race([readReached, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('APPROVAL_READ_NOT_OBSERVED')), 5000)
      })])
      clearTimeout(timer)
      assert.equal((await publishApprove({ session: { ...firstOwner.ctx }, draftId,
        payload: { decision: 'APPROVE', changeDigest } })).status, 200)
      assert.equal((await publishCommit({ session: { ...firstOwner.ctx }, draftId, payload: {} })).status, 201)
      const winner = await original.call(database,
        'SELECT approved_by, approved_at, approval_opinion FROM publish_drafts WHERE draft_id=$1', [draftId])
      release()
      const settled = await late
      if (settled.error) throw settled.error
      const state = await original.call(database,
        'SELECT status, approved_by, approved_at, approval_opinion FROM publish_drafts WHERE draft_id=$1', [draftId])
      const repeated = await publishCommit({ session: { ...firstOwner.ctx }, draftId, payload: {} })
      const records = await original.call(database, 'SELECT count(*)::int AS n FROM publish_records WHERE draft_id=$1', [draftId])
      const versions = await original.call(database,
        `SELECT count(*)::int AS n FROM published_contracts WHERE company_id=$1 AND asset_id=$2 AND contract_type='business-schema'`,
        [A.company, assetId])
      assert.deepEqual({ lateStatus: settled.value.status, lateState: state.rows[0].status,
        repeatStatus: repeated.status, publishedRecords: records.rows[0].n, contractVersions: versions.rows[0].n },
      { lateStatus: 409, lateState: 'PUBLISHED', repeatStatus: 409, publishedRecords: 1, contractVersions: 1 })
      assert.equal(settled.value.body.error, 'KVVI_DRAFT_NOT_AWAITING_APPROVAL')
      assert.deepEqual({ approved_by: state.rows[0].approved_by, approved_at: state.rows[0].approved_at,
        approval_opinion: state.rows[0].approval_opinion }, winner.rows[0])
      assert.equal(state.rows[0].approved_by, A.bob)
      const audit = await pool('auditRead').query(
        `SELECT outcome, reason FROM audit_entries
          WHERE action='publish.approve' AND resource_id=$1 AND actor_id=$2`, [draftId, A.carol])
      assert.deepEqual(audit.rows, [{ outcome: 'DENY', reason: 'KVVI_DRAFT_NOT_AWAITING_APPROVAL' }])
    } finally {
      clearTimeout(timer); release(); database.query = original
      await late
    }
  })
}
