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
import { canAct, fieldVisibility } from '../src/authorization.mjs'
import { verifyChain } from '../src/audit.mjs'

//: 流程契约。⚠️ **没有 `workflow_code`** —— 契约的 `Spec` 里没有这个字段
//: （只有 `businessSchemaRef/states/transitions/actions/approverRef`），
//: 而运行时曾经拿 `spec.workflow_code ?? '*'` 去问权限，于是恒为 `'*'`。
//: 流程的身份就是**业务对象**：它没有独立身份。
const ASSET = 'general_item'          // 业务对象代号，也是 FLOW 权限的资源
const SPEC = {
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
  // 流程动作权限：`canAct('FLOW', 业务对象, 动作类别, {state})`
  //
  // ⚠️ 这两行**曾经写错**，而且错法与运行时同源（两边一起错，于是测试全绿）：
  //    资源写的是 `general_item_flow`（流程自造的名字，契约里根本没有），
  //    动作写的是 `{submit,approve,reject}`（**业务名**），
  //    而 `permission-spec` 的 FLOW `actions` 是**类别的闭枚举**。
  //    真实契约按 schema 写 `SUBMIT` 这类类别，于是到了真实数据上一条都匹配不上。
  for (const userId of [A.alice, A.bob]) {
    await pool('platform').query(
      `INSERT INTO policies (policy_id, company_id, role_id, dimension, resource_code,
         state_code, actions, data_scopes, field_visibility)
       SELECT gen_random_uuid(), $1, rm.role_id, 'FLOW', $3,
              NULL, '{SUBMIT,APPROVE,REJECT}', '{}', NULL
         FROM role_members rm WHERE rm.user_id = $2 LIMIT 1`,
      [A.company, userId, ASSET])
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

describe('流程权限的三处词表（问题 28）', () => {
  // 这三条各自独立，任何一条错了都表现为同一个症状：**员工点流程按钮被拒**。
  // 它们的共同点是把「契约写的」和「运行时读的」放在一起对，而不是各测各的。

  test('★ 判权限用的资源是**业务对象**，不是流程自造的名字', async () => {
    const spec = { ...SPEC }
    // 用流程名当资源**不该**放行 —— 契约里根本没有那个名字，
    // 它只是一串字符串，而字符串相等曾经被当成「资源对上了」。
    const wrong = await canAct(A.company, A.alice, 'FLOW', 'general_item_flow', 'SUBMIT',
                               { state: 'draft' })
    const right = await canAct(A.company, A.alice, 'FLOW', ASSET, 'SUBMIT', { state: 'draft' })
    assert.equal(wrong, false, '流程名竟然也能匹配上')
    assert.equal(right, true)
    assert.ok(spec)
  })

  test('★ 判权限的动作是**类别**（kind），不是 action_code', async () => {
    // 装置里给的是 `SUBMIT`（类别）。业务名 `submit` 不该匹配 ——
    // 而它就是此前运行时传进来的那个值。
    assert.equal(await canAct(A.company, A.alice, 'FLOW', ASSET, 'submit', { state: 'draft' }),
                 false, '业务名竟然匹配上了类别')
    assert.equal(await canAct(A.company, A.alice, 'FLOW', ASSET, 'SUBMIT', { state: 'draft' }),
                 true)
  })

  test('★ 状态限定：策略写了状态就只在那个状态下成立', async () => {
    // 给 alice 加一条**只在 following 状态**上的 CLOSE（不动原有那两条）。
    await pool('platform').query(
      `INSERT INTO policies (policy_id, company_id, role_id, dimension, resource_code,
         state_code, actions, data_scopes, field_visibility)
       SELECT gen_random_uuid(), $1, rm.role_id, 'FLOW', $3, 'following',
              '{CLOSE}', '{}', NULL
         FROM role_members rm WHERE rm.user_id = $2 LIMIT 1`, [A.company, A.alice, ASSET])
    try {
      assert.equal(await canAct(A.company, A.alice, 'FLOW', ASSET, 'CLOSE',
                                { state: 'following' }), true)
      assert.equal(await canAct(A.company, A.alice, 'FLOW', ASSET, 'CLOSE',
                                { state: 'won' }), false,
                   '状态限定的策略在别的状态下也放行了')
      // 不写状态的策略（装置里那两条）在任何状态下都成立。
      assert.equal(await canAct(A.company, A.alice, 'FLOW', ASSET, 'SUBMIT',
                                { state: '随便什么状态' }), true)
    } finally {
      await pool('platform').query(
        "DELETE FROM policies WHERE company_id = $1 AND state_code = 'following'", [A.company])
    }
  })

  test('nextActions 同时给出**业务名**与**类别**', () => {
    const [first] = nextActions(SPEC, 'draft')
    assert.equal(first.action, 'submit')      // 回传给 /transitions 的是它
    assert.equal(first.kind, 'SUBMIT')        // 判权限用的是它
    assert.equal(first.to, 'submitted')
  })

  test('未知动作不报「没权限」，报「契约里没有它」', async () => {
    // 这两种拒的处置完全不同：一个是「你配的权限不够」，一个是「这个动作不存在」。
    await assert.rejects(
      () => step({ ctx: alice.ctx, spec: SPEC, assetId: ASSET, recordId: RECORDS.aliceOwn,
                   from: 'draft', action: 'nope',
                   applyTransition: async () => ({ recordId: RECORDS.aliceOwn }) }),
      (e) => e.code === 'KVVI_UNKNOWN_ACTION')
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
    const r = await step({ ctx: alice.ctx, spec: SPEC, assetId: ASSET, recordId: RECORDS.aliceOwn,
                           from: 'draft', action: 'submit', applyTransition: applyTransition(RECORDS.aliceOwn) })
    assert.equal(r.to, 'submitted')
    const a = await step({ ctx: bob.ctx, spec: SPEC, assetId: ASSET, recordId: RECORDS.aliceOwn,
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
      () => step({ ctx: alice.ctx, spec: SPEC, assetId: ASSET, recordId: RECORDS.aliceOwn,
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
      () => step({ ctx: alice.ctx, spec: SPEC, assetId: ASSET, recordId: RECORDS.bobOwn,
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
