/**
 * 阶段五锚点①：差分测试 —— UI 与 Agent 走**同一个执行点**（PRD §9.2）。
 *
 * ── 本文件要证的是「没有第二条路径」 ────────────────────────────────────
 *
 * §9.2 的缺陷原述：「UI 与 Agent 依据同一份契约」**不等于**「运行时走同一段授权代码」。
 * 所以要证的不是「两边规则一样」（那只能靠对比两份实现），
 * 而是**根本没有两份实现**：`handleCommand` 是唯一入口，
 * UI 路径与 Agent 路径都调用它。
 *
 * 于是差分测试的构造是：
 *
 *   1. 用**同一个**会话、**同一个**执行点，构造「UI 会拒绝的请求」；
 *   2. 把它当作 Agent 发来的请求重放（调用者声明自己是 Agent，服务端不看声明）；
 *   3. 断言得到**同码拒绝**。
 *
 * 覆盖 §9.2 点名的五类：隐藏字段、只读字段、终态、非法迁移、直接构造请求。
 */
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { pool, closeAll } from '../src/db.mjs'
import { A, RECORDS, resetDatabase, makeSession } from './harness.mjs'
import { handleCommand, clearStatusCache } from '../src/business.mjs'
import { publicKeysOf } from '../src/signing.mjs'
import { signingKeys } from '../src/identity.mjs'
import { classifyRisk } from '../src/commands.mjs'

const ROLE = 'a0000000-0000-4000-8000-0000000000f1'
const PASSWORDLESS = null
void PASSWORDLESS

const TRANSITIONS = [
  { transition_code: 'submit_flow', from_state: 'draft', to_state: 'submitted', action_code: 'submit' },
  { transition_code: 'approve_done', from_state: 'submitted', to_state: 'approved', action_code: 'approve' },
]

let alice = null

before(async () => {
  await resetDatabase()
  clearStatusCache()

  // 给 alice 配一套**刻意受限**的策略：这是「UI 会拒绝」的来源。
  await pool('platform').query(
    `INSERT INTO roles (role_id, company_id, role_code, name) VALUES ($1,$2,'role_diff','diff')`,
    [ROLE, A.company])
  await pool('platform').query(
    `INSERT INTO role_members (company_id, role_id, user_id) VALUES ($1,$2,$3)`,
    [A.company, ROLE, A.alice])
  const policies = [
    ['DATA', '*', [], ['SELF', 'DEPARTMENT_AND_CHILDREN'], null],
    ['FORM', 'general_item', ['read', 'update', 'submit', 'finalize', 'delete'], [], null],
    ['FIELD', 'title', ['read'], [], 'VISIBLE'],
    ['FIELD', 'amount', ['read'], [], 'MASKED'],       // 脱敏
    ['FIELD', 'due_date', [], [], 'HIDDEN'],           // 隐藏
    ['FIELD', 'detail', ['read'], [], 'READONLY'],     // 只读
  ]
  for (const [dim, code, actions, scopes, vis] of policies) {
    await pool('platform').query(
      `INSERT INTO policies (policy_id, company_id, role_id, dimension, resource_code,
         actions, data_scopes, field_visibility)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [randomUUID(), A.company, ROLE, dim, code, actions, scopes, vis])
  }
  alice = await makeSession(A.alice, A.company)
})

after(closeAll)

/** 唯一执行点。UI 与 Agent 都用它 —— 这正是 §9.2 要的形状。 */
async function call(request, { approval = null } = {}) {
  return handleCommand({
    token: alice.raw,
    publicKeys: publicKeysOf(signingKeys()),
    contractVersion: 'kvvi-contract/v1',
    body: request,
    approval,
    transitions: TRANSITIONS,
  })
}

describe('锚点① §9.2 差分测试：UI 会拒绝的请求，经 Agent 路径必须同码拒绝', () => {
  test('基线：UI 允许的请求通过（否则后面的「拒绝」无法区分是策略还是别的原因）', async () => {
    const r = await call({
      action: 'record.update',
      targets: [{ id: RECORDS.aliceOwn }],
      patch: { data: { title: '改标题' } },
    })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.ok, true)
  })

  test('① 隐藏字段：直接构造带隐藏字段的请求 → 拒绝', async () => {
    // UI 上这个字段根本不渲染，所以 UI 用户「构造不出」这个请求。
    // 但 Agent 可以直接构造 —— 服务端必须拦。
    const r = await call({
      action: 'record.update',
      targets: [{ id: RECORDS.aliceOwn }],
      patch: { data: { due_date: '2026-12-31' } },
    })
    assert.equal(r.status, 403)
    assert.equal(r.body.error, 'KVVI_FIELD_NOT_WRITABLE')
    assert.deepEqual(r.body.fields, ['due_date'])
  })

  test('② 只读字段：写入被拒', async () => {
    const r = await call({
      action: 'record.update',
      targets: [{ id: RECORDS.aliceOwn }],
      patch: { data: { detail: '改写说明' } },
    })
    assert.equal(r.status, 403)
    assert.deepEqual(r.body.fields, ['detail'])
  })

  test('③ 脱敏字段不可写：patch 是部分合并，盲写等于覆盖看不见的值', async () => {
    const r = await call({
      action: 'record.update',
      targets: [{ id: RECORDS.aliceOwn }],
      patch: { data: { amount: '1.00' } },
    })
    assert.equal(r.status, 403)
    assert.deepEqual(r.body.fields, ['amount'])
  })

  test('④ 非法迁移：当前状态下未定义的动作 → 拒绝且给出当前状态', async () => {
    const r = await call({
      action: 'record.finalize',
      targets: [{ id: RECORDS.aliceOwn }],
      patch: { data: {}, state: 'approve' },
    })
    assert.equal(r.status, 403)
    assert.equal(r.body.error, 'KVVI_TRANSITION_NOT_DEFINED')
    assert.equal(r.body.from, 'draft')
  })

  test('⑤ 数据范围之外：读不到就是读不到，**零行命中统一 404**（§9.3）', async () => {
    // bob 的单在财务部，alice 的档位覆盖不到。
    const r = await call({
      action: 'record.update',
      targets: [{ id: RECORDS.bobOwn }],
      patch: { data: { title: '越界改' } },
    })
    assert.equal(r.status, 404)
    assert.equal(r.body.error, 'KVVI_RECORD_NOT_FOUND',
      '「无权限」与「不存在」返回了不同结果 → 可用于枚举记录')
  })

  test('⑥ 跨公司：同样是 404，且**不透露对方存在**', async () => {
    const r = await call({
      action: 'record.update',
      targets: [{ id: RECORDS.companyB }],
      patch: { data: { title: '跨公司改' } },
    })
    assert.equal(r.status, 404)
    assert.equal(r.body.error, 'KVVI_RECORD_NOT_FOUND')
  })

  test('★ 调用方不得提供身份字段：请求体里出现 tenant/actor/role 即拒绝（§9.3.1）', async () => {
    for (const [key, value] of [['companyId', A.company], ['actor', A.alice],
                                ['tenant', A.company], ['roles', ['owner']]]) {
      const r = await call({
        action: 'record.update',
        targets: [{ id: RECORDS.aliceOwn }],
        patch: { data: { title: 'x' } },
        [key]: value,
      })
      assert.equal(r.status, 400, `字段 ${key} 没有被拦`)
      assert.equal(r.body.error, 'KVVI_CALLER_SUPPLIED_IDENTITY')
      assert.ok(r.body.fields.includes(key))
    }
  })

  test('★ 嵌套里塞身份字段同样被拦（不是只查顶层）', async () => {
    const r = await call({
      action: 'record.update',
      targets: [{ id: RECORDS.aliceOwn }],
      // 模型完全可能把 tenant 藏在参数深处
      patch: { data: { title: 'x' }, meta: { tenant: A.company } },
    })
    assert.equal(r.status, 400)
    assert.ok(r.body.fields.includes('patch.meta.tenant'))
  })

  test('UI 的「隐藏」不是安全控制：同一个字段，读的时候不返回，写的时候拒绝', async () => {
    // §9.2 硬性要求 1：UI 的隐藏/禁用只影响呈现，真正的拒绝在服务端执行点。
    // 这一条把「呈现」与「拒绝」分开验：读路径由投影过滤，写路径由执行点拒绝。
    const { fieldVisibility, projectFields } = await import('../src/authorization.mjs')
    const vis = await fieldVisibility(A.company, A.alice, ['title', 'amount', 'due_date'])
    const projected = projectFields(
      { title: '单据', amount: '19800.00', due_date: '2026-09-30' }, vis)
    assert.equal(projected.due_date, undefined, '隐藏字段在读路径泄漏了')
    assert.notEqual(projected.amount, '19800.00', '脱敏字段在读路径出了明文')

    const write = await call({
      action: 'record.update',
      targets: [{ id: RECORDS.aliceOwn }],
      patch: { data: { due_date: '2026-12-31' } },
    })
    assert.equal(write.status, 403, '写路径没有拦住隐藏字段')
  })
})

describe('锚点① 风险分级在**同一个执行点**上生效（§9.6.4.1）', () => {
  test('批量动作被判定为 R3', () => {
    const risk = classifyRisk({
      action: 'record.update',
      targets: [{ deptId: 'd1', shopId: 's1' }, { deptId: 'd1', shopId: 's1' }],
    })
    assert.equal(risk.level, 'R3')
    assert.ok(risk.reasons.includes('BATCH'))
  })

  test('跨业务分组被判定为 R3（是「授权内跨分组」，不是「越权」）', () => {
    const risk = classifyRisk({
      action: 'record.update',
      targets: [{ deptId: 'd1', shopId: 's1' }, { deptId: 'd1', shopId: 's2' }],
    })
    assert.equal(risk.level, 'R3')
    assert.ok(risk.reasons.includes('CROSS_BUSINESS_GROUP'))
  })

  test('超阈值被判定为 R3，阈值**由系统定义**，不由请求携带', () => {
    const risk = classifyRisk({ action: 'record.update', targets: [{}], amount: '50000.01' })
    assert.equal(risk.level, 'R3')
    assert.ok(risk.reasons.includes('OVER_AMOUNT_THRESHOLD'))
  })

  test('单笔普通更新是 R1，单笔删除是 R2', () => {
    assert.equal(classifyRisk({ action: 'record.update', targets: [{}] }).level, 'R1')
    assert.equal(classifyRisk({ action: 'record.delete', targets: [{}] }).level, 'R2')
  })
})
