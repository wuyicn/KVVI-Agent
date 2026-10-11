import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { A, B, resetDatabase, grantPlatformRole, makeSession, adminQuery } from './harness.mjs'
import { closeAll, pool, withTransaction } from '../src/db.mjs'
import { createRecord, updateRecord, readRecord } from '../src/refs.mjs'
import { submitDraft, approveDraft, publishDraft, DIFF_FACES } from '../src/publish.mjs'

let owner, builder
before(async () => {
  await resetDatabase()
  await grantPlatformRole(A.alice, 'owner')
  owner = (await makeSession(A.alice, A.company, 'BUILDER')).ctx
  builder = (await makeSession(A.bob, A.company, 'BUILDER')).ctx
})
after(closeAll)
const scope = (ctx) => ({ companyId: ctx.companyId, userId: ctx.userId, scopes: ['SELF'] })
const model = (asset, indexes) => ({ schema_code: asset, fields: ['platform', 'account', 'note'].map(field_code =>
  ({ field_code, type: 'short_text', required: false, nullable: true, write_policy: 'MUTABLE' })), indexes })
const unique = (fields) => [{ index_code: 'no_duplicates', kind: 'UNIQUE', fields }]
async function publish(asset, indexes, extraModel = {}) {
  const draft = await submitDraft({ ctx: builder, change: { asset, nonce: randomUUID() }, diffReport: { faces: DIFF_FACES }, invariant: { ok: true } })
  await approveDraft({ ctx: owner, draftId: draft.draftId, decision: 'APPROVE' })
  return publishDraft({ ctx: owner, draftId: draft.draftId, apply: async () => ({}),
    system: { assetId: asset, schemaCode: asset, name: asset },
    contracts: [{ contractType: 'business-schema', assetId: asset, content: { ...model(asset, indexes), ...extraModel } }] })
}
const create = (asset, data, ctx = builder) => createRecord(ctx, scope(ctx), { schemaCode: asset, data })
const update = (record, data) => updateRecord(builder, scope(builder), { id: record.recordId }, { data, rowVersion: record.rowVersion })

test('a unique rule may refer to the system-generated record number declared by the contract', async () => {
  await publish('unique_number', unique(['business_no', 'account']), { record_number: { field_code: 'business_no' } })
  const a = await create('unique_number', { account: 'same' }), b = await create('unique_number', { account: 'same' })
  assert.notEqual(a.recordNo, b.recordNo)
})

test('malformed unique rules fail closed, and the cross-row helper refuses another company', async () => {
  for (const indexes of [null, {}, unique([]), unique(['unknown']), unique(['account', 'account']),
    [{ index_code: '', kind: 'UNIQUE', fields: ['account'] }],
    [{ index_code: 'bad', kind: 'BOGUS', fields: ['account'] }]]) {
    await assert.rejects(publish('unique_invalid', indexes), /KVVI_UNIQUE_RULE_INVALID/)
  }
  await assert.rejects(withTransaction('business', async client => {
    await client.query("SELECT set_config('kvvi.company_id',$1,true)", [A.company])
    await client.query('SELECT kvvi_unique_conflict($1,$2,$3,$4)', [B.company, 'unique_single', ['account'], { account: 'private-account' }])
  }), /KVVI_NOT_ALLOWED/)
})

test('single-field uniqueness rejects duplicates including records hidden by SELF, without leaking their values', async () => {
  await publish('unique_single', unique(['account']))
  const first = await create('unique_single', { account: 'private-account' }, owner)
  assert.equal(await readRecord(builder, scope(builder), { id: first.recordId }), null)
  await assert.rejects(create('unique_single', { account: 'private-account' }), error => {
    assert.equal(error.code, 'KVVI_FIELD_DUPLICATE')
    assert.equal(JSON.stringify(error).includes('private-account'), false)
    assert.equal(JSON.stringify(error).includes(first.recordId), false)
    return true
  })
  await create('unique_single', { account: 'private-account' }, { companyId: B.company, userId: B.dave })
  await create('another_form', { account: 'private-account' })
})

test('combined uniqueness checks the complete edited record and excludes itself even when schemaCode is absent', async () => {
  await publish('unique_combined', unique(['platform', 'account']))
  const a = await create('unique_combined', { platform: 'taobao', account: 'same' })
  const b = await create('unique_combined', { platform: 'jd', account: 'same' })
  await assert.rejects(create('unique_combined', { platform: 'taobao', account: 'same' }), /KVVI_FIELD_DUPLICATE/)
  await assert.rejects(update(b, { platform: 'taobao' }), /KVVI_FIELD_DUPLICATE/)
  assert.ok(await update(a, { note: 'self edit' }))
  assert.equal((await readRecord(builder, scope(builder), { id: b.recordId })).data.platform, 'jd')
})

test('optional blanks are exempt, raw case/whitespace remains distinct, NORMAL indexes do not enforce uniqueness', async () => {
  await publish('unique_blank', unique(['account']))
  for (const account of [null, '', undefined, null, '', undefined, 'ABC', 'abc', ' abc ']) {
    await create('unique_blank', { account })
  }
  await assert.rejects(create('unique_blank', { account: 'ABC' }), /KVVI_FIELD_DUPLICATE/)
  await publish('normal_index', [{ index_code: 'search', kind: 'NORMAL', fields: ['account'] }])
  await create('normal_index', { account: 'repeat' }); await create('normal_index', { account: 'repeat' })
})

test('concurrent inserts and updates allow exactly one winner and persist no duplicate', async () => {
  await publish('unique_concurrent', unique(['account']))
  const inserts = await Promise.allSettled(Array.from({ length: 8 }, () => create('unique_concurrent', { account: 'one' })))
  assert.equal(inserts.filter(r => r.status === 'fulfilled').length, 1)
  for (const r of inserts.filter(r => r.status === 'rejected')) assert.equal(r.reason.code, 'KVVI_FIELD_DUPLICATE')
  const a = await create('unique_concurrent', { account: 'a' }), b = await create('unique_concurrent', { account: 'b' })
  const edits = await Promise.allSettled([update(a, { account: 'two' }), update(b, { account: 'two' })])
  assert.equal(edits.filter(r => r.status === 'fulfilled').length, 1)
  const rows = await adminQuery('kvvi_business', "SELECT data->>'account' AS account,count(*) FROM business_records WHERE schema_code='unique_concurrent' GROUP BY 1")
  assert.ok(rows.rows.every(r => Number(r.count) === 1))
})

test('activating a rule refuses existing duplicates without deleting data or replacing the old model; repairs allow retry', async () => {
  await publish('unique_existing', [])
  await create('unique_existing', { account: 'old' })
  const b = await create('unique_existing', { account: 'old' })
  await assert.rejects(publish('unique_existing', unique(['account'])), /KVVI_UNIQUE_EXISTING_DUPLICATES/)
  assert.equal(Number((await adminQuery('kvvi_business', "SELECT count(*) FROM business_records WHERE schema_code='unique_existing'")).rows[0].count), 2)
  await update(b, { account: 'corrected' })
  await publish('unique_existing', unique(['account']))
  await assert.rejects(create('unique_existing', { account: 'old' }), /KVVI_FIELD_DUPLICATE/)
})

test('an interrupted publication durably blocks writes until the same approved publication completes', async () => {
  const asset = 'unique_interrupted'
  await publish(asset, [])
  await create(asset, { account: 'first' })
  const draft = await submitDraft({ ctx: builder, change: { asset }, diffReport: { faces: DIFF_FACES }, invariant: { ok: true } })
  await approveDraft({ ctx: owner, draftId: draft.draftId, decision: 'APPROVE' })
  const args = { ctx: owner, draftId: draft.draftId, system: { assetId: asset, schemaCode: asset, name: asset },
    contracts: [{ contractType: 'business-schema', assetId: asset, content: model(asset, unique(['account'])) }] }
  await assert.rejects(publishDraft({ ...args, apply: async () => { throw new Error('simulated publication interruption') } }), /simulated publication interruption/)
  await assert.rejects(create(asset, { account: 'first' }), /KVVI_UNIQUE_PUBLICATION_PENDING/)
  await publishDraft({ ...args, apply: async () => ({}) })
  await assert.rejects(create(asset, { account: 'first' }), /KVVI_FIELD_DUPLICATE/)
  await create(asset, { account: 'second' })
})

test('an in-flight publication cannot be mistaken for a completed identical model', async () => {
  const asset = 'unique_publication_race'
  await publish(asset, unique(['account']))
  await create(asset, { account: 'existing' })
  const draft = await submitDraft({ ctx: builder, change: { asset }, diffReport: { faces: DIFF_FACES }, invariant: { ok: true } })
  await approveDraft({ ctx: owner, draftId: draft.draftId, decision: 'APPROVE' })
  let release, entered
  const paused = new Promise(resolve => { release = resolve })
  const started = new Promise(resolve => { entered = resolve })
  const args = { ctx: owner, draftId: draft.draftId, system: { assetId: asset, schemaCode: asset, name: asset },
    contracts: [{ contractType: 'business-schema', assetId: asset, content: model(asset, unique(['account'])) }] }
  const publishing = publishDraft({ ...args, apply: async () => { entered(); await paused; return {} } })
  await started
  try {
    await assert.rejects(publish(asset, []), /KVVI_UNIQUE_PUBLICATION_PENDING/)
    await assert.rejects(create(asset, { account: 'new' }), /KVVI_UNIQUE_PUBLICATION_PENDING/)
  } finally { release(); await publishing }
  await assert.rejects(create(asset, { account: 'existing' }), /KVVI_FIELD_DUPLICATE/)
})

test('parallel attempts of the same draft cannot republish stale rules after another draft completes', async () => {
  const asset = 'unique_retry_race'
  await publish(asset, [])
  const draft = await submitDraft({ ctx: builder, change: { asset }, diffReport: { faces: DIFF_FACES }, invariant: { ok: true } })
  await approveDraft({ ctx: owner, draftId: draft.draftId, decision: 'APPROVE' })
  const args = { ctx: owner, draftId: draft.draftId, system: { assetId: asset, schemaCode: asset, name: asset },
    contracts: [{ contractType: 'business-schema', assetId: asset, content: model(asset, unique(['account'])) }] }
  let release, entered
  const paused = new Promise(resolve => { release = resolve })
  const started = new Promise(resolve => { entered = resolve })
  const delayed = publishDraft({ ...args, apply: async () => { entered(); await paused; return {} } })
  await started
  let duplicateApplied = false
  const repeated = publishDraft({ ...args, apply: async () => { duplicateApplied = true; return {} } })
  // Capture rejection before releasing the first publication to avoid an unhandled rejection.
  const results = Promise.allSettled([delayed, repeated])
  release()
  const settled = await results
  assert.equal(settled.filter(r => r.status === 'fulfilled' && r.value.ok).length, 1)
  assert.equal(duplicateApplied, false, 'the rejected duplicate must not execute permission writes')
  await publish(asset, [])
  await create(asset, { account: 'duplicate' }); await create(asset, { account: 'duplicate' })
  await create(asset, { account: 'duplicate' })
})

test('publication apply uses the model transaction and rolls back its writes on failure', async () => {
  const asset = 'unique_atomic_publish'
  const draft = await submitDraft({ ctx: builder, change: { asset }, diffReport: { faces: DIFF_FACES }, invariant: { ok: true } })
  await approveDraft({ ctx: owner, draftId: draft.draftId, decision: 'APPROVE' })
  const before = (await pool('platform').query('SELECT name FROM companies WHERE company_id=$1', [A.company])).rows[0].name
  await assert.rejects(publishDraft({ ctx: owner, draftId: draft.draftId,
    apply: async ({ client }) => {
      assert.ok(client, 'the real permission writer must receive the publication transaction')
      await client.query('UPDATE companies SET name=$2 WHERE company_id=$1', [A.company, 'uncommitted change'])
      throw new Error('simulated apply failure')
    }, contracts: [{ contractType: 'business-schema', assetId: asset, content: model(asset, []) }] }), /simulated apply failure/)
  assert.equal((await pool('platform').query('SELECT name FROM companies WHERE company_id=$1', [A.company])).rows[0].name, before)
  assert.equal((await pool('platform').query('SELECT status FROM publish_drafts WHERE draft_id=$1', [draft.draftId])).rows[0].status, 'APPROVED')
})
