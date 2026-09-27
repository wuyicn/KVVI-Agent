/**
 * 发布通道的**入口**：三条路由，以及它们各自守的那一条判据。
 *
 * ── 为什么这一组必须存在 ────────────────────────────────────────────────
 *
 * `publish.mjs` 的通道有 4 个测试文件守着，而**入口一条测试都没有** ——
 * 那正是它此前完全没有调用方的原因在测试上的投影：通道被测透了，
 * 「谁能进来」却没人问过。入口的三条判据各自拦一种误用：
 *
 * | # | 判据 | 不成立会怎样 |
 * |---|---|---|
 * | 1 | 提交必须是**搭建者会话** | 员工会话也能提交发布，等于把「搭建」从别的入口放进来 |
 * | 2 | 审批与发布必须是**所有者** | 被委托的管理员能发布，而 §3.1 里「能管理」与「能发布」是两件事 |
 * | 3 | 审批要带上**变更摘要** | 「批的必须是这一份」只剩一句注释：拿 A 的草案号可以批 B 的内容 |
 * | 4 | 发布**只认草案里存的内容** | 请求体里带什么就能发什么，「批的」与「发的」不是同一份 |
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'

import {
  publishApprove, publishCommit, publishDetail, publishList, publishRoutes, publishSubmit,
} from '../src/publish-api.mjs'
import { pool } from '../src/db.mjs'
import { A, B, resetDatabase, grantPlatformRole, makeSession, closeAll } from './harness.mjs'

const CONTRACTS = () => ({
  'business-schema': { fields: [] },
  'view-schema': { componentsTree: [] },
  'workflow-spec': { states: [] },
  'permission-spec': { roles: [{ role_code: 'sales', name: '销售' }],
    policies: [{ policy_code: 'p1', role_code: 'sales',
      role_ref: { subresource: { type: 'ROLE', code: 'sales' } },
      dimension: 'FORM', resource_ref: { asset_id: 'customer' }, effect: 'ALLOW',
      actions: ['read'] }] },
  'tool-spec': { tools: [] },
  'app-model-command': { commands: [] },
})

let builder
let owner
let employee
let foreigner

before(async () => {
  await resetDatabase()
  // ⚠️ **提交人与审批人必须是两个人。** 第一版把两者都设成 Alice，
  //    于是「所有者可以提交」那条用例撞上自审批禁令拿 409 ——
  //    而它要问的是「所有者审批能不能成」，与自审批毫无关系。
  //    两个身份分开之后，只有专门那条自审批用例会去撞它。
  await grantPlatformRole(A.bob, 'owner')
  await grantPlatformRole(A.alice, 'owner')
  owner = await makeSession(A.bob, A.company)
  builder = await makeSession(A.alice, A.company, 'BUILDER')
  employee = await makeSession(A.carol, A.company)
  foreigner = await makeSession(B.dave, B.company, 'BUILDER')
  // 契约要声明的角色必须先在平台上存在 —— 发布不负责凭空造角色。
  await pool('platform').query(
    `INSERT INTO roles (role_id, company_id, role_code, name)
     VALUES (gen_random_uuid(), $1, 'sales', '销售') ON CONFLICT DO NOTHING`,
    [A.company])
})

after(async () => { await closeAll() })

/** 每个用例用自己的系统代号，避免草案唯一索引互相影响。 */
let assetCounter = 0
const nextAsset = () => `asset_${(assetCounter += 1)}`

async function submitAs(session, assetId) {
  return await publishSubmit({
    session,
    payload: { assetId, contracts: CONTRACTS() },
  })
}

describe('入口：谁能提交', () => {
  test('★ 搭建者会话可以提交', async () => {
    const out = await submitAs({ ...builder.ctx }, nextAsset())
    assert.equal(out.status, 201)
    assert.equal(out.body.status, 'AWAITING_APPROVAL')
    // 差异报告与「声明了但执行不了」的清单当场交回给提交人：
    // 不问就不说，等于把「已声明 ≠ 已生效」留给下一次发布去发现。
    assert.ok(out.body.diffReport.counts.added > 0)
    assert.deepEqual(out.body.notEnforced, [])
  })

  test('★ 员工会话提交 → 403，且指名要的是搭建者会话', async () => {
    const out = await submitAs({ ...employee.ctx }, nextAsset())
    assert.equal(out.status, 403)
    assert.equal(out.body.error, 'KVVI_BUILDER_SESSION_REQUIRED')
    assert.equal(out.body.gateway, 'USER')
  })

  test('契约不齐 → 400，并且说出缺哪几份', async () => {
    const partial = CONTRACTS()
    delete partial['tool-spec']
    const out = await publishSubmit({
      session: { ...builder.ctx }, payload: { assetId: nextAsset(), contracts: partial },
    })
    assert.equal(out.status, 400)
    assert.equal(out.body.error, 'KVVI_PUBLISH_CONTRACTS_INCOMPLETE')
    assert.deepEqual(out.body.missing, ['tool-spec'])
  })

  test('缺 assetId → 400', async () => {
    const out = await publishSubmit({
      session: { ...builder.ctx }, payload: { contracts: CONTRACTS() },
    })
    assert.equal(out.status, 400)
    assert.equal(out.body.error, 'KVVI_ASSET_ID_REQUIRED')
  })
})

describe('入口：谁能审批', () => {
  test('★ 所有者可以，且必须带上变更摘要', async () => {
    const submitted = await submitAs({ ...builder.ctx }, nextAsset())
    const draftId = submitted.body.draftId

    // 不带摘要 → 400，并且把该带的摘要告诉调用方 —— 他要去看的是那一份内容。
    const withoutDigest = await publishApprove({
      session: { ...owner.ctx }, draftId, payload: { decision: 'APPROVE' },
    })
    assert.equal(withoutDigest.status, 400)
    assert.equal(withoutDigest.body.error, 'KVVI_APPROVAL_DIGEST_REQUIRED')
    assert.equal(withoutDigest.body.changeDigest, submitted.body.changeDigest)

    // 带错了摘要 → 409。批的必须是这一份。
    const wrongDigest = await publishApprove({
      session: { ...owner.ctx }, draftId,
      payload: { decision: 'APPROVE', changeDigest: 'sha256:not-it' },
    })
    assert.equal(wrongDigest.status, 409)
    assert.equal(wrongDigest.body.error, 'KVVI_APPROVAL_DIGEST_MISMATCH')

    // 带对了 → 批准。
    const ok = await publishApprove({
      session: { ...owner.ctx }, draftId,
      payload: { decision: 'APPROVE', changeDigest: submitted.body.changeDigest },
    })
    assert.equal(ok.status, 200)
    assert.equal(ok.body.status, 'APPROVED')
  })

  test('★ 非所有者审批 → 403（「能管理」与「能发布」是两件事）', async () => {
    const submitted = await submitAs({ ...builder.ctx }, nextAsset())
    const out = await publishApprove({
      session: { ...employee.ctx }, draftId: submitted.body.draftId,
      payload: { decision: 'APPROVE', changeDigest: submitted.body.changeDigest },
    })
    assert.equal(out.status, 403)
    assert.equal(out.body.error, 'KVVI_NOT_OWNER')
  })

  test('★ 自己提自己批 → 被拒，且原因是自审批（§9.6.1）', async () => {
    // Bob 既是搭建者又是所有者 —— 一个人两个身份、两个入口，
    // 正是 §9.6.1 要挡的形态：他在搭建台提的，不能在同一个人的手里批掉。
    const bobBuilder = await makeSession(A.bob, A.company, 'BUILDER')
    const submitted = await submitAs({ ...bobBuilder.ctx }, nextAsset())
    const out = await publishApprove({
      session: { ...owner.ctx }, draftId: submitted.body.draftId,
      payload: { decision: 'APPROVE', changeDigest: submitted.body.changeDigest },
    })
    assert.equal(out.status, 409)
    assert.equal(out.body.error, 'KVVI_SELF_APPROVAL_FORBIDDEN')
  })
})

describe('入口：发布只认草案里那一份', () => {
  test('★ 请求体里带什么，都改变不了发出去的东西', async () => {
    const assetId = nextAsset()
    // 提交人与审批人必须是两个人 —— 这一条测的是「发布用什么内容」，
    // 不该被自审批禁令挡在前面。
    const submitter = await makeSession(A.bob, A.company, 'BUILDER')
    const submitted = await submitAs({ ...submitter.ctx }, assetId)
    const draftId = submitted.body.draftId
    const approver = await makeSession(A.alice, A.company)

    const approved = await publishApprove({
      session: { ...approver.ctx }, draftId,
      payload: { decision: 'APPROVE', changeDigest: submitted.body.changeDigest },
    })
    assert.equal(approved.status, 200)

    // 发布时**故意**带上一份完全不同的内容：草案里存的资产代号不是它。
    const out = await publishCommit({
      session: { ...approver.ctx }, draftId,
      payload: { assetId: 'someone-elses', contracts: { 'business-schema': { fields: [] } } },
    })
    assert.equal(out.status, 201)

    const { rows } = await pool('platform').query(
      'SELECT asset_id FROM systems WHERE company_id = $1 AND asset_id IN ($2, $3)',
      [A.company, assetId, 'someone-elses'])
    assert.deepEqual(rows.map((r) => r.asset_id), [assetId],
      '请求体里的内容被采纳了 —— 「批的」与「发的」不是同一份')
  })

  test('草案里没有内容 → 409，并给出可操作的下一步', async () => {
    const assetId = nextAsset()
    const submitted = await submitAs({ ...builder.ctx }, assetId)
    // 模拟「改造之前提交的草案」：把 payload 掏空。
    await pool('platform').query(
      "UPDATE publish_drafts SET payload = '{}'::jsonb WHERE draft_id = $1",
      [submitted.body.draftId])
    const out = await publishCommit({
      session: { ...owner.ctx }, draftId: submitted.body.draftId, payload: {},
    })
    assert.equal(out.status, 409)
    assert.equal(out.body.error, 'KVVI_DRAFT_PAYLOAD_MISSING')
    assert.match(out.body.detail, /重新提交/)
  })

  test('未批准的草案发不出去', async () => {
    const submitted = await submitAs({ ...builder.ctx }, nextAsset())
    const out = await publishCommit({
      session: { ...owner.ctx }, draftId: submitted.body.draftId, payload: {},
    })
    assert.equal(out.status, 409)
    assert.equal(out.body.error, 'KVVI_DRAFT_NOT_APPROVED')
  })

  test('别家公司的草案读不到：404 而不是 403（不泄漏它存不存在）', async () => {
    const submitted = await submitAs({ ...builder.ctx }, nextAsset())
    const out = await publishDetail({
      session: { ...foreigner.ctx }, draftId: submitted.body.draftId,
    })
    assert.equal(out.status, 404)
  })
})

describe('入口：分派', () => {
  test('不是本模块的路径 → null（调用方继续往下走）', async () => {
    assert.equal(await publishRoutes({ method: 'GET', path: '/nope', session: owner.ctx }), null)
    assert.equal(await publishRoutes({ method: 'POST', path: 'drafts', session: owner.ctx })
      .then((r) => r === null), false)
  })

  test('列草案：本公司最近的若干张，带提交人', async () => {
    const out = await publishList({ session: { ...owner.ctx } })
    assert.equal(out.status, 200)
    assert.ok(out.body.items.length > 0)
    assert.ok('proposer' in out.body.items[0])
  })

  test('读不到不存在的草案 → 404', async () => {
    const out = await publishDetail({
      session: { ...owner.ctx }, draftId: '00000000-0000-4000-8000-000000000000',
    })
    assert.equal(out.status, 404)
  })
})
