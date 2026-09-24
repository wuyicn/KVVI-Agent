/**
 * N18 · 发布通道（§9.6.3 / §9.6.6 / §9.8.1）。
 *
 * 三条路都必须被拒：**跳过差异报告**、**跳过审批**、**自批**。
 * 各配一条正向对照 —— 只测拒绝的集合永远是绿的。
 */
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { pool, closeAll } from '../src/db.mjs'
import { A, B, resetDatabase, makeSession, grantBaseline, grantPlatformRole } from './harness.mjs'
import { submitDraft, approveDraft, publishDraft, buildDiffReport,
         publishHistory, DIFF_FACES, PublishError } from '../src/publish.mjs'
import { checkEnabledTools } from '../src/publish.mjs'
import { verifyChain } from '../src/audit.mjs'

let owner = null
let builder = null

const CHANGE = { kind: 'permission-policy', roleCode: 'staff',
                 addScopes: ['COMPANY'], addFields: ['amount'] }
const DIFF = { faces: DIFF_FACES, added: [{ dim: 'DATA', scope: 'COMPANY' }],
               removed: [], changed: [], counts: { added: 1, removed: 0, changed: 0 } }

before(async () => {
  await resetDatabase()
  await grantBaseline(A.alice)
  await grantBaseline(A.bob)
  await grantPlatformRole(A.alice, 'owner')
  owner = await makeSession(A.alice, A.company)
  builder = await makeSession(A.bob, A.company)   // 搭建者，不是所有者
})
after(closeAll)

describe('N18 §9.6.3 发布是唯一的生效通道', () => {
  test('★ 第 0 步：**没有差异报告不得提交**（§9.6.6）', async () => {
    await assert.rejects(
      () => submitDraft({ ctx: builder.ctx, change: CHANGE, diffReport: null }),
      (e) => e instanceof PublishError && e.code === 'KVVI_DIFF_REPORT_REQUIRED')
    const { rows } = await pool('auditRead').query(
      `SELECT count(*)::int AS n FROM audit_entries
        WHERE action = 'publish.submitDraft' AND reason = 'KVVI_DIFF_REPORT_REQUIRED'`)
    assert.ok(rows[0].n >= 1, '被拒却没有留痕')
  })

  test('差异报告**必须覆盖 §9.6.6 的全部面**（少一面就不算完整影响）', async () => {
    await assert.rejects(
      () => submitDraft({ ctx: builder.ctx, change: CHANGE,
                          diffReport: { faces: ['见得到什么（人员范围）'] } }),
      (e) => e.code === 'KVVI_DIFF_REPORT_REQUIRED')
  })

  test('★ §9.8.1：违反聚合差分不变量的配置**一律拒绝，无审批放行路径**', async () => {
    await assert.rejects(
      () => submitDraft({ ctx: builder.ctx, change: CHANGE, diffReport: DIFF,
                          invariant: { ok: false, reason: 'L3' } }),
      (e) => e.code === 'KVVI_AGGREGATE_INVARIANT_VIOLATED')
  })

  test('正向对照：有报告且不变量通过 → 进入待审批', async () => {
    const d = await submitDraft({ ctx: builder.ctx, change: CHANGE, diffReport: DIFF,
                                  invariant: { ok: true } })
    assert.equal(d.status, 'AWAITING_APPROVAL')
    assert.ok(d.changeDigest.startsWith('sha256:'))
  })

  test('★ 提交人不能批准自己的草案（§9.6.4.1）', async () => {
    const d = await submitDraft({ ctx: builder.ctx, change: { ...CHANGE, n: 1 }, diffReport: DIFF,
                                  invariant: { ok: true } })
    const r = await approveDraft({ ctx: builder.ctx, draftId: d.draftId, decision: 'APPROVE' })
    assert.equal(r.ok, false)
    assert.equal(r.error, 'KVVI_SELF_APPROVAL_FORBIDDEN')
  })

  test('★ 非所有者也不能批准（§3.1：搭建权限不是自取的）', async () => {
    const d = await submitDraft({ ctx: owner.ctx, change: { ...CHANGE, n: 2 }, diffReport: DIFF,
                                  invariant: { ok: true } })
    const r = await approveDraft({ ctx: builder.ctx, draftId: d.draftId, decision: 'APPROVE' })
    assert.equal(r.ok, false)
    assert.equal(r.error, 'KVVI_NOT_A_PLATFORM_ADMIN')
  })

  test('★ 摘要不符 → 批的不是这一份', async () => {
    const d = await submitDraft({ ctx: builder.ctx, change: { ...CHANGE, n: 3 }, diffReport: DIFF,
                                  invariant: { ok: true } })
    const r = await approveDraft({ ctx: owner.ctx, draftId: d.draftId, decision: 'APPROVE',
                                   change: { 完全不同的内容: true } })
    assert.equal(r.ok, false)
    assert.equal(r.error, 'KVVI_APPROVAL_DIGEST_MISMATCH')
  })

  test('★ **跳过审批直接发布** → 拒', async () => {
    const d = await submitDraft({ ctx: builder.ctx, change: { ...CHANGE, n: 4 }, diffReport: DIFF,
                                  invariant: { ok: true } })
    let applied = false
    const r = await publishDraft({ ctx: owner.ctx, draftId: d.draftId,
                                   apply: async () => { applied = true } })
    assert.equal(r.ok, false)
    assert.equal(r.error, 'KVVI_DRAFT_NOT_APPROVED')
    assert.equal(applied, false, '未审批的草案竟然生效了')
  })

  test('正向对照：报告 → 他人审批 → 发布 全流程通过，并留下发布记录', async () => {
    const change = { ...CHANGE, n: 5 }
    const d = await submitDraft({ ctx: builder.ctx, change, diffReport: DIFF,
                                  invariant: { ok: true } })
    const a = await approveDraft({ ctx: owner.ctx, draftId: d.draftId, decision: 'APPROVE',
                                   opinion: '影响已核对' })
    assert.equal(a.ok, true)
    assert.equal(a.role, 'owner')

    let applied = false
    const p = await publishDraft({ ctx: owner.ctx, draftId: d.draftId,
                                   apply: async ({ diffDigest }) => { applied = true
                                     return { diffDigest } } })
    assert.equal(p.ok, true)
    assert.equal(applied, true)
    assert.equal(p.status, 'PUBLISHED')

    const history = await publishHistory(A.company)
    assert.ok(history.length >= 1)
    assert.equal(history[0].change_digest, d.changeDigest)
    assert.equal(history[0].approved_by, A.alice, '发布记录里的审批人不对')
    assert.equal(history[0].proposer_user_id, A.bob, '发布记录里的提交人不对')
  })

  test('跨公司草案 → 拒（租户不变式）', async () => {
    const d = await submitDraft({ ctx: builder.ctx, change: { ...CHANGE, n: 6 }, diffReport: DIFF,
                                  invariant: { ok: true } })
    const other = await makeSession(A.alice, A.company)
    const r = await approveDraft({ ctx: { ...other.ctx, companyId: B.company },
                                   draftId: d.draftId, decision: 'APPROVE' })
    assert.equal(r.ok, false)
    assert.equal(r.error, 'KVVI_CROSS_TENANT_DRAFT')
  })

  test('§9.6.5：启用范围不能超出该网关已属工具', () => {
    assert.equal(checkEnabledTools('USER', ['data.readView']).ok, true)
    const bad = checkEnabledTools('USER', ['schema.designModel'])
    assert.equal(bad.ok, false)
    assert.equal(bad.error, 'KVVI_ENABLE_EXCEEDS_GATEWAY')
  })

  test('差异报告能算出增/删/改三类', () => {
    const before = [{ dimension: 'DATA', resource_code: '*', role_code: 'staff', data_scopes: [] }]
    const after = [{ dimension: 'DATA', resource_code: '*', role_code: 'staff', data_scopes: ['COMPANY'] },
                   { dimension: 'FIELD', resource_code: 'amount', role_code: 'staff', field_visibility: 'MASKED' }]
    const d = buildDiffReport(before, after)
    assert.equal(d.counts.added, 1)
    assert.equal(d.counts.changed, 1)
    assert.equal(d.counts.removed, 0)
  })

  test('审计链在以上全部操作后仍然自洽', async () => {
    assert.equal((await verifyChain()).ok, true)
  })
})
