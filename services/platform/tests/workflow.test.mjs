/**
 * N20 · 审批流**运行时**（0C-4）。
 *
 * 契约层早就有 `workflow-spec`，本文件测的是「有人按契约执行迁移」。
 * 三条规则各自配正向对照 —— 只测拒绝的集合永远是绿的。
 */
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { pool, closeAll } from '../src/db.mjs'
import { A, RECORDS, resetDatabase, makeSession, grantBaseline, adminQuery } from './harness.mjs'
import { judgeTransition, step, nextActions, WorkflowError } from '../src/workflow.mjs'
import { verifyChain } from '../src/audit.mjs'

const SPEC = {
  workflow_code: 'general_item_flow',
  states: [
    { state_code: 'draft', name: '草稿', initial: true, terminal: false },
    { state_code: 'submitted', name: '待审批', initial: false, terminal: false },
    { state_code: 'approved', name: '已通过', initial: false, terminal: true },
    { state_code: 'rejected', name: '已驳回', initial: false, terminal: false },
  ],
  actions: [
    { action_code: 'submit', kind: 'SUBMIT' },
    { action_code: 'approve', kind: 'APPROVE' },
    { action_code: 'reject', kind: 'REJECT' },
  ],
  transitions: [
    { transition_code: 'submit_flow', from_state: 'draft', to_state: 'submitted', action_code: 'submit' },
    { transition_code: 'approve_done', from_state: 'submitted', to_state: 'approved', action_code: 'approve' },
    { transition_code: 'reject_back', from_state: 'submitted', to_state: 'rejected', action_code: 'reject' },
  ],
}

let alice = null
let bob = null

before(async () => {
  await resetDatabase()
  await grantBaseline(A.alice)
  await grantBaseline(A.bob)
  // 流程动作权限：`canAct('FLOW', workflow_code, action)`
  for (const userId of [A.alice, A.bob]) {
    await pool('platform').query(
      `INSERT INTO policies (policy_id, company_id, role_id, dimension, resource_code,
         actions, data_scopes, field_visibility)
       SELECT gen_random_uuid(), $1, rm.role_id, 'FLOW', 'general_item_flow',
              '{submit,approve,reject}', '{}', NULL
         FROM role_members rm WHERE rm.user_id = $2 LIMIT 1`, [A.company, userId])
  }
  alice = await makeSession(A.alice, A.company)
  bob = await makeSession(A.bob, A.company)
})
after(closeAll)

describe('N20 审批流运行时：判定（纯函数）', () => {
  test('合法迁移给出目标状态', () => {
    const v = judgeTransition(SPEC, { from: 'draft', action: 'submit', actorUserId: A.alice })
    assert.equal(v.allowed, true)
    assert.equal(v.toState, 'submitted')
    assert.equal(v.kind, 'SUBMIT')
  })

  test('★ 终态不可写：已通过之后任何动作都拒', () => {
    for (const action of ['submit', 'approve', 'reject']) {
      const v = judgeTransition(SPEC, { from: 'approved', action, actorUserId: A.alice })
      assert.equal(v.allowed, false)
      assert.equal(v.reason, 'KVVI_TERMINAL_STATE', `终态上 ${action} 竟然放行`)
    }
  })

  test('★ 当前状态下未定义的动作拒（包括「顺理成章的下一步」）', () => {
    const v = judgeTransition(SPEC, { from: 'draft', action: 'approve', actorUserId: A.alice })
    assert.equal(v.allowed, false)
    assert.equal(v.reason, 'KVVI_TRANSITION_NOT_DEFINED')
  })

  test('★ **自审批被拒**：批准人不能是提交人（§9.6.1）', () => {
    const v = judgeTransition(SPEC, {
      from: 'submitted', action: 'approve',
      actorUserId: A.alice, submitterUserId: A.alice })
    assert.equal(v.allowed, false)
    assert.equal(v.reason, 'KVVI_SELF_APPROVAL_FORBIDDEN')
  })

  test('正向对照：他人批准放行', () => {
    const v = judgeTransition(SPEC, {
      from: 'submitted', action: 'approve',
      actorUserId: A.bob, submitterUserId: A.alice })
    assert.equal(v.allowed, true)
    assert.equal(v.toState, 'approved')
  })

  test('提交动作不受自审批禁令影响（提交人就是发起人）', () => {
    const v = judgeTransition(SPEC, {
      from: 'draft', action: 'submit',
      actorUserId: A.alice, submitterUserId: A.alice })
    assert.equal(v.allowed, true)
  })

  test('无流程动作权限 → 拒', () => {
    const v = judgeTransition(SPEC, {
      from: 'draft', action: 'submit', actorUserId: A.alice, hasFlowPermission: false })
    assert.equal(v.reason, 'KVVI_ACTION_NOT_PERMITTED')
  })

  test('未知状态 / 未知动作 → 拒（不是「默认放行」）', () => {
    assert.equal(judgeTransition(SPEC, { from: 'nope', action: 'submit' }).reason,
                 'KVVI_UNKNOWN_STATE')
    assert.equal(judgeTransition(SPEC, { from: 'draft', action: 'nope' }).reason,
                 'KVVI_UNKNOWN_ACTION')
  })

  test('可执行的下一步：终态返回空数组', () => {
    assert.deepEqual(nextActions(SPEC, 'draft').map((a) => a.action), ['submit'])
    assert.deepEqual(nextActions(SPEC, 'approved'), [])
  })
})

describe('N20 审批流运行时：执行（写状态 + 留痕）', () => {
  // ⚠️ 状态读写走**超级用户**：`pool('business')` 受 RLS 约束，
  // 不设作用域上下文时读到 0 行 —— 断言会拿到 undefined，
  // 看起来像「状态没落库」，实际是「这条查询没设上下文」。
  const applyTransition = (recordId) => async ({ toState }) => {
    await adminQuery('kvvi_business',
      'UPDATE business_records SET state = $2 WHERE record_id = $1', [recordId, toState])
    return { recordId, toState }
  }

  test('发起 → 审批 全流程跑通，且每步都留痕', async () => {
    const r = await step({ ctx: alice.ctx, spec: SPEC, recordId: RECORDS.aliceOwn,
                           from: 'draft', action: 'submit', applyTransition: applyTransition(RECORDS.aliceOwn) })
    assert.equal(r.to, 'submitted')
    const a = await step({ ctx: bob.ctx, spec: SPEC, recordId: RECORDS.aliceOwn,
                           from: 'submitted', action: 'approve',
                           submitterUserId: A.alice, applyTransition: applyTransition(RECORDS.aliceOwn) })
    assert.equal(a.to, 'approved')
    const { rows } = await adminQuery('kvvi_business',
      'SELECT state FROM business_records WHERE record_id = $1', [RECORDS.aliceOwn])
    assert.equal(rows[0].state, 'approved')

    const { rows: audit } = await pool('auditRead').query(
      `SELECT count(*)::int AS n FROM audit_entries
        WHERE action IN ('flow.submit','flow.approve') AND outcome = 'ALLOW'`)
    assert.ok(audit[0].n >= 2, '流程动作没有留痕')
  })

  test('★ 拒绝的迁移**不改变状态**，且留下拒绝痕', async () => {
    const before = (await adminQuery('kvvi_business',
      'SELECT state FROM business_records WHERE record_id = $1', [RECORDS.aliceOwn])).rows[0].state
    await assert.rejects(
      () => step({ ctx: alice.ctx, spec: SPEC, recordId: RECORDS.aliceOwn,
                   from: 'approved', action: 'submit', applyTransition: applyTransition(RECORDS.aliceOwn) }),
      (e) => e instanceof WorkflowError && e.code === 'KVVI_TERMINAL_STATE')
    const after1 = (await adminQuery('kvvi_business',
      'SELECT state FROM business_records WHERE record_id = $1', [RECORDS.aliceOwn])).rows[0].state
    assert.equal(after1, before, '被拒的迁移竟然改了状态')
    const { rows } = await pool('auditRead').query(
      `SELECT count(*)::int AS n FROM audit_entries
        WHERE reason = 'KVVI_TERMINAL_STATE' AND outcome = 'DENY'`)
    assert.ok(rows[0].n >= 1)
  })

  test('★ 自审批在执行层同样被拒（不只是判定层）', async () => {
    await adminQuery('kvvi_business',
      "UPDATE business_records SET state = 'submitted' WHERE record_id = $1", [RECORDS.bobOwn])
    await assert.rejects(
      () => step({ ctx: alice.ctx, spec: SPEC, recordId: RECORDS.bobOwn,
                   from: 'submitted', action: 'approve',
                   submitterUserId: A.alice, applyTransition: applyTransition(RECORDS.bobOwn) }),
      (e) => e.code === 'KVVI_SELF_APPROVAL_FORBIDDEN')
    const { rows } = await adminQuery('kvvi_business',
      'SELECT state FROM business_records WHERE record_id = $1', [RECORDS.bobOwn])
    assert.equal(rows[0].state, 'submitted', '自审批被拒后状态仍被改了')
  })

  test('审计链自洽', async () => {
    assert.equal((await verifyChain()).ok, true)
  })
})
