/**
 * N16 残 · 账号生命周期与离职交接（§3.3）。
 *
 * 缺口是「离职者是**申请人**」那一半。按单据状态分流，三种状态各行其道。
 */
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { pool, closeAll } from '../src/db.mjs'
import { A, RECORDS, resetDatabase, makeSession, grantBaseline, adminQuery } from './harness.mjs'
import { offboard, handoverPlan, deleteAccount, findOrphans,
         LifecycleError, HANDOVER_BY_STATE } from '../src/lifecycle.mjs'
import { verifyToken } from '../src/identity.mjs'
import { verifyChain } from '../src/audit.mjs'

let actor = null
let leaver = null

before(async () => {
  await resetDatabase()
  await grantBaseline(A.alice)
  await grantBaseline(A.bob)
  actor = await makeSession(A.alice, A.company)
  leaver = await makeSession(A.bob, A.company)
})
after(closeAll)

const setState = (id, state) => adminQuery('kvvi_business',
  'UPDATE business_records SET state = $2, owner_id = $3 WHERE record_id = $1',
  [id, state, A.bob])

const ownerOf = async (id) => (await adminQuery('kvvi_business',
  'SELECT owner_id, data FROM business_records WHERE record_id = $1', [id])).rows[0]

describe('N16 §3.3.2 按单据状态分流', () => {
  test('分流表是**封闭**的：未知状态即拒，不猜', () => {
    assert.equal(handoverPlan('draft').flow, false)
    assert.equal(handoverPlan('submitted').flow, true)
    assert.equal(handoverPlan('approved').ownership, 'KEEP')
    assert.throws(() => handoverPlan('已冻结'), (e) => e.code === 'KVVI_UNKNOWN_RECORD_STATE')
    assert.deepEqual(Object.keys(HANDOVER_BY_STATE).sort(),
      ['approved', 'draft', 'rejected', 'submitted'])
  })

  test('★ 草稿：**归属转移**但不进流程（不指定继任者、不告警）', async () => {
    await setState(RECORDS.otherInSubDept, 'draft')
    const r = await offboard({ actor: actor.ctx, userId: A.bob,
                               successorUserId: A.carol,
                               records: [{ recordId: RECORDS.otherInSubDept, state: 'draft' }] })
    assert.deepEqual(r.transferred, [])
    assert.equal(r.skipped[0].reason, 'DRAFT_OWNERSHIP_ONLY')
    assert.equal(r.alerts.length, 0, '草稿不该触发兜底告警')
    assert.equal((await ownerOf(RECORDS.otherInSubDept)).owner_id, A.carol, '草稿归属没转移')
  })

  test('★ 在途：**显式交接 + 告警**（不得静默）', async () => {
    await pool('platform').query(`UPDATE users SET status='ACTIVE' WHERE user_id=$1`, [A.bob])
    await setState(RECORDS.store1Foreign, 'submitted')
    const r = await offboard({ actor: actor.ctx, userId: A.bob,
                               successorUserId: A.carol,
                               records: [{ recordId: RECORDS.store1Foreign, state: 'submitted' }] })
    assert.deepEqual(r.transferred, [RECORDS.store1Foreign])
    assert.equal(r.alerts.length, 1)
    assert.equal(r.alerts[0].reason, 'IN_FLIGHT_HANDOVER')
    assert.equal((await ownerOf(RECORDS.store1Foreign)).owner_id, A.carol)
  })

  test('★ 已完成：**只追加标记，不替换提交人**（历史不可改写）', async () => {
    await pool('platform').query(`UPDATE users SET status='ACTIVE' WHERE user_id=$1`, [A.bob])
    await setState(RECORDS.bobOwn, 'approved')
    const before = await ownerOf(RECORDS.bobOwn)
    const r = await offboard({ actor: actor.ctx, userId: A.bob,
                               successorUserId: A.carol,
                               records: [{ recordId: RECORDS.bobOwn, state: 'approved' }] })
    assert.deepEqual(r.marked, [RECORDS.bobOwn])
    const after1 = await ownerOf(RECORDS.bobOwn)
    assert.equal(after1.owner_id, before.owner_id,
      '已完成单据的归属被改了 —— 历史被改写')
    assert.equal(after1.data._submitter_left, true, '没有追加「提交人已离职」标记')
  })
})

describe('N16 §3.3.3 三条原则', () => {
  test('★ ① 顺序：先停用，再交接（反过来会出现「交接完还能登录」的窗口）', async () => {
    await pool('platform').query(`UPDATE users SET status='ACTIVE' WHERE user_id=$1`, [A.carol])
    const s = await makeSession(A.carol, A.company)
    assert.ok(await verifyToken(s.raw), '先确认令牌本来是有效的')
    await offboard({ actor: actor.ctx, userId: A.carol, successorUserId: A.alice,
                     records: [] })
    assert.equal(await verifyToken(s.raw), null, '离职后旧令牌仍然有效')
    await pool('platform').query(`UPDATE users SET status='ACTIVE' WHERE user_id=$1`, [A.carol])
  })

  test('★ ③ 账号只能停用，不能删除', () => {
    assert.throws(() => deleteAccount(), (e) => e instanceof LifecycleError
      && e.code === 'KVVI_ACCOUNT_DELETE_FORBIDDEN')
  })

  test('继任者不能是自己', async () => {
    await assert.rejects(
      () => offboard({ actor: actor.ctx, userId: A.alice, successorUserId: A.alice,
                       records: [] }),
      (e) => e.code === 'KVVI_SUCCESSOR_IS_SELF')
  })

  test('交接后不产生孤儿单据（在途必须有主）', async () => {
    const orphans = await findOrphans(A.company)
    assert.deepEqual(orphans, [], `出现孤儿单据：${orphans.join(',')}`)
  })

  test('离职动作留痕，且审计链自洽', async () => {
    const { rows } = await pool('auditRead').query(
      `SELECT count(*)::int AS n FROM audit_entries
        WHERE action = 'account.offboard' AND outcome = 'ALLOW'`)
    assert.ok(rows[0].n >= 3, '离职交接没有留痕')
    assert.equal((await verifyChain()).ok, true)
  })
})
