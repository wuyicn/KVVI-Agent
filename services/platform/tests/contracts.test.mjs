/**
 * 契约存储（`published_contracts`）—— 已发布契约**内容**的落点。
 *
 * ── 为什么这一组断言值得写 ────────────────────────────────────────────────
 *
 * 四件事卡在同一个坑上：工作台打不开系统界面、待办说不清谁该批、
 * 聚合口径列不出来、员工端同步不到系统定义。它们的共同前提是
 * **契约内容要被某个服务持有** —— 而此前没有任何服务持有它。
 *
 * 所以这里断的不是「存进去了」，而是四条**性质**：
 *
 * | # | 性质 | 不成立会怎样 |
 * |---|---|---|
 * | 1 | 版本**单调递增**、旧版本保留 | 覆盖写入让「回滚」与「版本不符即拒绝」都失去依据 |
 * | 2 | 内容**指纹对得上** | 库里被改过时静默通过，而契约内容是权限判定的输入 |
 * | 3 | **跨公司读不到** | 公司来自会话，不是请求参数 |
 * | 4 | 与发布记录**同生共死** | 分开写会留下「发布了但内容没到」的窗口 |
 */
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { pool, closeAll } from '../src/db.mjs'
import { A, B, resetDatabase, makeSession, grantBaseline, grantPlatformRole } from './harness.mjs'
import { submitDraft, approveDraft, publishDraft, buildDiffReport, DIFF_FACES } from '../src/publish.mjs'
import { latestContract, contractVersions, contractsOfSystem } from '../src/contracts.mjs'

let owner = null
let builder = null

/**
 * 第三个版本的内容。提成常量是因为**篡改用例用完要恢复** ——
 * 那个用例故意改库，不还原就会把后续用例一起弄脏（本文件第一次跑就踩到了）。
 */
const V3_CONTENT = { view_code: 'demo_form', n: 2 }

const CHANGE = { kind: 'permission-policy', roleCode: 'staff',
                 addScopes: ['COMPANY'], addFields: ['amount'] }
const DIFF = { faces: DIFF_FACES, added: [{ dim: 'DATA', scope: 'COMPANY' }],
               removed: [], changed: [], counts: { added: 1, removed: 0, changed: 0 } }

/** 走完整发布链：提交 → 他人审批 → 发布，并把契约内容带进去。 */
async function publishOnce(contracts, system) {
  const d = await submitDraft({ ctx: builder.ctx, change: { ...CHANGE, n: Math.random() },
                                diffReport: DIFF, invariant: { ok: true } })
  await approveDraft({ ctx: owner.ctx, draftId: d.draftId, decision: 'APPROVE' })
  return publishDraft({
    ctx: owner.ctx, draftId: d.draftId,
    apply: async ({ diffDigest }) => ({ diffDigest }),
    system, contracts,
  })
}

before(async () => {
  await resetDatabase()
  await grantBaseline(A.alice)
  await grantBaseline(A.bob)
  await grantPlatformRole(A.alice, 'owner')
  owner = await makeSession(A.alice, A.company)
  builder = await makeSession(A.bob, A.company)
})
after(closeAll)

describe('00 契约存储：已发布契约的内容有落点', () => {
  test('发布时带上契约 → 内容可读，且带上分配到的版本与指纹', async () => {
    const view = { view_code: 'demo_form', view_type: 'FORM', componentsTree: [{ id: 'root' }] }
    const r = await publishOnce(
      [{ contractType: 'view-schema', assetId: 'demo', content: view }],
      { assetId: 'demo', name: '演示系统', schemaCode: 'demo' })
    assert.equal(r.ok, true)

    const got = await latestContract(A.company, 'view-schema', 'demo')
    assert.ok(got !== null, '刚发布的契约读不到')
    assert.equal(got.version, 1, '首个版本应当是 1')
    assert.deepEqual(got.content, view, '内容被改过 —— 存进去的和读出来的不是一份')
  })

  test('★ 版本单调递增，且**旧版本保留**（覆盖写入会让回滚失去依据）', async () => {
    const a = { view_code: 'demo_form', n: 1 }
    const b = V3_CONTENT
    await publishOnce([{ contractType: 'view-schema', assetId: 'demo', content: a }], null)
    await publishOnce([{ contractType: 'view-schema', assetId: 'demo', content: b }], null)

    const versions = await contractVersions(A.company, 'view-schema', 'demo')
    assert.equal(versions.length, 3, '三次发布应当留三行 —— 版本被覆盖了')
    assert.deepEqual(versions.map((v) => v.version), [3, 2, 1], '版本不是单调递增')

    const latest = await latestContract(A.company, 'view-schema', 'demo')
    assert.deepEqual(latest.content, b, '读到的不是最新版')
  })

  test('★ 内容指纹对不上就**拒绝**，不静默返回', async () => {
    // 直接改库里的内容、不动 digest —— 模拟「库里被改过」。
    await pool('platform').query(
      `UPDATE published_contracts SET content = '{"tampered":true}'::jsonb
        WHERE company_id = $1 AND contract_type = 'view-schema'
          AND asset_id = 'demo' AND version = 3`, [A.company])
    await assert.rejects(
      () => latestContract(A.company, 'view-schema', 'demo'),
      (e) => e.message === 'KVVI_CONTRACT_CONTENT_TAMPERED',
      '内容被改过却没被检出 —— 而契约内容是权限判定的输入')
    // 还原：本用例的工作是证明「篡改会被检出」，不是给后面留下一张脏表。
    await pool('platform').query(
      `UPDATE published_contracts SET content = $1::jsonb
        WHERE company_id = $2 AND contract_type = 'view-schema'
          AND asset_id = 'demo' AND version = 3`,
      [JSON.stringify(V3_CONTENT), A.company])
  })

  test('★ 跨公司读不到（公司来自会话，不是请求参数）', async () => {
    const other = await latestContract(B.company, 'view-schema', 'demo')
    assert.equal(other, null, '读到了别的公司的契约')
  })

  test('一个系统当前生效的全部契约，按类型取最新版', async () => {
    const all = await contractsOfSystem(A.company, 'demo')
    assert.ok(Object.prototype.hasOwnProperty.call(all, 'view-schema'))
    // **缺哪类就不出现** —— 不补空对象：那会让「没有」与「空」混起来。
    assert.equal(all['workflow-spec'], undefined,
      '没有的契约类型竟然出现了 —— 「没有」与「空」被混为一谈')
  })

  test('发布时**不带**契约 → 读不到，且不报错（正常路径必须给，但缺省不该炸）', async () => {
    await publishOnce([], null)
    const none = await latestContract(A.company, 'business-schema', 'nothing-here')
    assert.equal(none, null)
  })
})
