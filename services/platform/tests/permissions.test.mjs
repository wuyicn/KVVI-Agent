/**
 * 阶段四内容项：表单 / 字段 / 流程权限（0B-4、0B-5、0B-7）。
 *
 * 这三项**不是阶段四的验收锚点**，但属于「0B 安全地基整块」。
 * 记在这里是为了让覆盖范围明确 —— 没测的东西不该在报告里显得像测过了。
 */
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { pool, closeAll } from '../src/db.mjs'
import { A, resetDatabase } from './harness.mjs'
import { canAct, fieldVisibility, projectFields, resolveTransition, mask } from '../src/authorization.mjs'

before(async () => {
  await resetDatabase()
  const roleId = randomUUID()
  await pool('platform').query(
    `INSERT INTO roles (role_id, company_id, role_code, name) VALUES ($1,$2,'role_perm','perm')`,
    [roleId, A.company])
  await pool('platform').query(
    `INSERT INTO role_members (company_id, role_id, user_id) VALUES ($1,$2,$3)`,
    [A.company, roleId, A.alice])
  const rows = [
    ['FORM', 'general_item_form', ['read', 'create'], null],
    ['FIELD', 'amount', ['read'], 'MASKED'],
    ['FIELD', 'title', ['read'], 'VISIBLE'],
    ['FIELD', 'due_date', [], 'HIDDEN'],
    ['FLOW', 'general_item_flow', ['submit'], null],
  ]
  for (const [dim, res, actions, vis] of rows) {
    await pool('platform').query(
      `INSERT INTO policies (policy_id, company_id, role_id, dimension, resource_code,
         actions, data_scopes, field_visibility)
       VALUES ($1,$2,$3,$4,$5,$6,'{}',$7)`,
      [randomUUID(), A.company, roleId, dim, res, actions, vis])
  }
})
after(closeAll)

describe('0B-4 表单权限', () => {
  test('允许的动作放行，未授予的动作拒绝', async () => {
    assert.equal(await canAct(A.company, A.alice, 'FORM', 'general_item_form', 'read'), true)
    assert.equal(await canAct(A.company, A.alice, 'FORM', 'general_item_form', 'create'), true)
    assert.equal(await canAct(A.company, A.alice, 'FORM', 'general_item_form', 'delete'), false)
    assert.equal(await canAct(A.company, A.alice, 'FORM', 'other_form', 'read'), false)
  })
})

describe('0B-5 字段权限', () => {
  test('未配置的字段默认**不可见**（fail-closed）', async () => {
    const vis = await fieldVisibility(A.company, A.alice, ['title', 'amount', 'due_date', 'secret'])
    assert.equal(vis.title, 'VISIBLE')
    assert.equal(vis.amount, 'MASKED')
    assert.equal(vis.due_date, 'HIDDEN')
    assert.equal(vis.secret, 'HIDDEN', '没配过的字段竟然是可见的')
  })

  test('投影后**看不到**隐藏字段，脱敏字段只出掩码', async () => {
    const vis = await fieldVisibility(A.company, A.alice, ['title', 'amount', 'due_date'])
    const projected = projectFields(
      { title: '审批单', amount: '19800.00', due_date: '2026-09-30' }, vis)
    assert.equal(projected.title, '审批单')
    assert.equal(projected.due_date, undefined, '隐藏字段被投影出来了')
    assert.notEqual(projected.amount, '19800.00', '脱敏字段出了明文')
    assert.equal(projected.amount, mask('19800.00'))
  })

  test('同一字段被多条策略命中时取**最严**', async () => {
    const roleId = randomUUID()
    await pool('platform').query(
      `INSERT INTO roles (role_id, company_id, role_code, name) VALUES ($1,$2,'role_open','open')`,
      [roleId, A.company])
    await pool('platform').query(
      `INSERT INTO role_members (company_id, role_id, user_id) VALUES ($1,$2,$3)`,
      [A.company, roleId, A.alice])
    await pool('platform').query(
      `INSERT INTO policies (policy_id, company_id, role_id, dimension, resource_code,
         actions, data_scopes, field_visibility)
       VALUES (gen_random_uuid(),$1,$2,'FIELD','amount','{read}','{}','VISIBLE')`,
      [A.company, roleId])
    const vis = await fieldVisibility(A.company, A.alice, ['amount'])
    assert.equal(vis.amount, 'MASKED', '多给一个角色反而放开了字段 —— 合并规则取了最松的')
  })
})

describe('0B-7 流程权限（当前状态下能做什么）', () => {
  const transitions = [
    { transition_code: 'submit_flow', from_state: 'draft', to_state: 'submitted', action_code: 'submit' },
    { transition_code: 'approve_done', from_state: 'submitted', to_state: 'approved', action_code: 'approve' },
  ]
  test('合法动作给出目标状态', () => {
    assert.deepEqual(resolveTransition(transitions, 'draft', 'submit'),
      { allowed: true, toState: 'submitted' })
  })
  test('当前状态下未定义的动作被拒', () => {
    assert.equal(resolveTransition(transitions, 'draft', 'approve').allowed, false)
  })
  test('**终态不可写**：已通过之后没有任何迁移', () => {
    for (const action of ['submit', 'approve', 'withdraw']) {
      const v = resolveTransition(transitions, 'approved', action)
      assert.equal(v.allowed, false, `终态 approved 上竟然允许 ${action}`)
    }
  })
  test('契约歧义（同状态同动作两条去向）拒执行，而不是挑一条', () => {
    const ambiguous = [...transitions,
      { transition_code: 'x', from_state: 'draft', to_state: 'rejected', action_code: 'submit' }]
    assert.equal(resolveTransition(ambiguous, 'draft', 'submit').reason,
      'KVVI_TRANSITION_AMBIGUOUS')
  })
})
