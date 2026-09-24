/** N16 残 · §9.11.3 限流与配额（账号 / 工具 / 结果规模 / 批量 / 并发会话）。 */
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { pool, closeAll } from '../src/db.mjs'
import { A, resetDatabase, makeSession, grantBaseline } from './harness.mjs'
import { checkToolCall, checkResultSize, checkBatchSize, checkSessionQuota,
         prune, LIMITS, RateLimitError } from '../src/rate-limit.mjs'
import { verifyChain } from '../src/audit.mjs'

let alice = null

before(async () => {
  await resetDatabase()
  await grantBaseline(A.alice)
  alice = await makeSession(A.alice, A.company)
})
after(closeAll)

describe('N16 §9.11.3 限流', () => {
  test('正常调用放行', async () => {
    const r = await checkToolCall({ ctx: alice.ctx, tool: 'data.readView' })
    assert.equal(r.allowed, true)
  })

  test('★ 工具维度：超过窗口上限 → 拒绝，且说明**超的是哪一维**', async () => {
    const tool = 'probe.tool'
    for (let i = 0; i < LIMITS.toolPerWindow; i += 1) {
      await checkToolCall({ ctx: { ...alice.ctx, userId: `e0000000-0000-4000-8000-${String(i).padStart(12, '0')}` }, tool })
    }
    await assert.rejects(
      () => checkToolCall({ ctx: alice.ctx, tool }),
      (e) => e instanceof RateLimitError && e.code === 'KVVI_RATE_LIMITED_TOOL'
        && e.detail.dimension === 'TOOL' && e.detail.limit === LIMITS.toolPerWindow)
  })

  test('★ 账号维度：同一账号跨工具累计超限 → 拒绝', async () => {
    // ⚠️ 必须与上面工具维度用的账号段**不重叠**：重叠会让「账号额度」
  // 在本用例开始前就被别人用掉几个，于是拒绝发生得比预期早 ——
  // 单跑能过、全跑不过，是最难查的一类。
  const uid = 'f0000000-0000-4000-8000-00000000abcd'
    for (let i = 0; i < LIMITS.accountPerWindow; i += 1) {
      await checkToolCall({ ctx: { ...alice.ctx, userId: uid }, tool: `t${i}` })
    }
    await assert.rejects(
      () => checkToolCall({ ctx: { ...alice.ctx, userId: uid }, tool: 'any' }),
      (e) => e.code === 'KVVI_RATE_LIMITED_ACCOUNT')
  })

  test('★ 被拒的调用**不占额度**（否则会雪崩）', async () => {
    const tool = 'no-consume'
    for (let i = 0; i < LIMITS.toolPerWindow; i += 1) {
      await checkToolCall({ ctx: { ...alice.ctx, userId: `f0000000-0000-4000-8000-${String(i).padStart(12, '0')}` }, tool })
    }
    const before1 = await pool('platform').query(
      `SELECT count(*)::int AS n FROM rate_events WHERE dimension='TOOL' AND key=$1`, [tool])
    await checkToolCall({ ctx: alice.ctx, tool }).catch(() => {})
    const after1 = await pool('platform').query(
      `SELECT count(*)::int AS n FROM rate_events WHERE dimension='TOOL' AND key=$1`, [tool])
    assert.equal(after1.rows[0].n, before1.rows[0].n, '被拒的调用也记了账')
  })

  test('★ 超限留痕（拒绝不是静默的）', async () => {
    const { rows } = await pool('auditRead').query(
      `SELECT count(*)::int AS n FROM audit_entries
        WHERE reason IN ('KVVI_RATE_LIMITED_TOOL','KVVI_RATE_LIMITED_ACCOUNT')
          AND outcome = 'DENY'`)
    assert.ok(rows[0].n >= 1)
  })
})

describe('N16 §9.11.3 配额：**超限即拒，不截断**', () => {
  test('★ 结果规模超限 → 拒绝（不返回被截断的结果）', () => {
    assert.equal(checkResultSize(LIMITS.maxResultItems).allowed, true)
    const r = checkResultSize(LIMITS.maxResultItems + 1)
    assert.equal(r.allowed, false)
    assert.equal(r.limit, LIMITS.maxResultItems)
    // 它**不返回**任何数据 —— 截断会误导用户
    assert.equal('items' in r, false)
  })

  test('★ 批量对象数超限 → 拒绝', () => {
    assert.equal(checkBatchSize(LIMITS.maxBatchTargets).allowed, true)
    assert.equal(checkBatchSize(LIMITS.maxBatchTargets + 1).allowed, false)
  })

  test('★ 并发会话上限', async () => {
    for (let i = 0; i < LIMITS.maxConcurrentSessions; i += 1) {
      await makeSession(A.alice, A.company)
    }
    const r = await checkSessionQuota(A.company, A.alice)
    assert.equal(r.allowed, false)
    assert.equal(r.limit, LIMITS.maxConcurrentSessions)
    assert.ok(r.active >= LIMITS.maxConcurrentSessions)
  })

  test('正向对照：未达上限时放行', async () => {
    const r = await checkSessionQuota(A.company, 'f0000000-0000-4000-8000-0000000000ff')
    assert.equal(r.allowed, true)
    assert.equal(r.active, 0)
  })

  test('默认限额都有值（没配也不会静默关闭限流）', () => {
    for (const [k, v] of Object.entries(LIMITS)) {
      assert.equal(typeof v, 'number')
      assert.ok(v > 0, `${k} 没有默认值 —— 没配就等于关掉了限流`)
    }
  })

  test('清理过期窗口不影响判定，且审计链自洽', async () => {
    assert.equal(typeof (await prune()), 'number')
    assert.equal((await verifyChain()).ok, true)
  })
})
