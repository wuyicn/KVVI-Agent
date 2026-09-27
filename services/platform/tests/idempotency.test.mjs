/**
 * 幂等键：让「同一个动作重发一次」不产生第二次效果。
 *
 * ── 它补的是哪一条 ──────────────────────────────────────────────────────
 *
 * 会话连续性验收的第 ⑤ 条量出过一个事实：**写操作没有幂等键** ——
 * 同一条建记录的请求打三次，建出三条不同的记录。
 * 当时「重连不重放」靠的是**客户端不自动重试**，那是一个**约定**；
 * 而重连恰恰是最容易重复发一次的时刻（响应没回来、连接断了、
 * 客户端不知道那一次到底成没成）。
 *
 * | # | 性质 | 不成立会怎样 |
 * |---|---|---|
 * | 1 | 同一个键重发 → 回**当初那个响应**，不再执行一遍 | 重连的客户端以为失败，而它其实成功了 |
 * | 2 | 只记成功的动作 | 一次瞬时的 403 会变成窗口内的永久状态 |
 * | 3 | 键按 (公司, 账号, 端点) 隔离 | 换个人或换个端点，同一个字符串会互相顶掉 |
 * | 4 | 窗口外的键当新动作 | 「下班前重试」会被当成上午那次，白重试 |
 * | 5 | 键只能来自请求头 | 放进请求体就是一条模型可见的参数 |
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { pool, closeAll } from '../src/db.mjs'
import {
  IDEMPOTENCY_HEADER, IDEMPOTENCY_WINDOW_MS, idempotencyKeyOf, pruneIdempotencyKeys,
  withIdempotency,
} from '../src/idempotency.mjs'
import { A, resetDatabase, grantPlatformRole } from './harness.mjs'

const ctx = { companyId: A.company, userId: A.alice, gateway: 'USER', sessionId: 's-1' }

before(async () => {
  await resetDatabase()
  await grantPlatformRole(A.alice, 'owner')
})

after(async () => { await closeAll() })

/** 清掉这个账号的键，免得用例之间互相影响。 */
async function clearKeys() {
  await pool('platform').query('DELETE FROM idempotency_keys WHERE company_id = $1',
    [A.company])
}

describe('幂等键：重发不产生第二次效果', () => {
  test('★ 同一个键重发，回的是当初那个响应，动作只跑了一次', async () => {
    await clearKeys()
    let runs = 0
    const run = async () => {
      runs += 1
      return { status: 201, body: { recordId: 'r-' + runs, recordNo: 'R-001' } }
    }
    const first = await withIdempotency({ ctx, endpoint: 'POST /x', key: 'k1', run })
    const second = await withIdempotency({ ctx, endpoint: 'POST /x', key: 'k1', run })

    assert.equal(runs, 1, '动作跑了两次 —— 重发产生了第二次效果')
    assert.equal(first.body.recordId, 'r-1')
    assert.equal(second.body.recordId, 'r-1',
      '重发回的不是当初那个响应 —— 重连的客户端会以为失败，而它其实成功了')
    assert.equal(second.replayed, true)
    assert.equal(first.replayed, undefined)
  })

  test('没有键就直接执行（幂等是调用方选择要的保证）', async () => {
    let runs = 0
    const run = async () => { runs += 1; return { status: 201, body: { n: runs } } }
    await withIdempotency({ ctx, endpoint: 'POST /y', key: undefined, run })
    await withIdempotency({ ctx, endpoint: 'POST /y', key: undefined, run })
    assert.equal(runs, 2)
  })

  test('不同的键各跑一次', async () => {
    await clearKeys()
    let runs = 0
    const run = async () => { runs += 1; return { status: 201, body: { n: runs } } }
    await withIdempotency({ ctx, endpoint: 'POST /z', key: 'a', run })
    await withIdempotency({ ctx, endpoint: 'POST /z', key: 'b', run })
    assert.equal(runs, 2)
  })
})

describe('幂等键：只记成功的那些', () => {
  test('★ 失败的动作不落键 —— 瞬时的拒绝不能变成永久状态', async () => {
    await clearKeys()
    let runs = 0
    // 第一次权限不足（403），第二次权限给了再来一次 —— 必须真的再跑一遍。
    const denied = await withIdempotency({ ctx, endpoint: 'POST /k', key: 'kk', run: async () => {
      runs += 1
      return { status: 403, body: { error: 'KVVI_NOT_ALLOWED' } }
    } })
    assert.equal(denied.status, 403)
    const allowed = await withIdempotency({ ctx, endpoint: 'POST /k', key: 'kk', run: async () => {
      runs += 1
      return { status: 201, body: { ok: true } }
    } })
    assert.equal(runs, 2, '第一次的 403 被记下来了 —— 窗口内永远回那个 403')
    assert.equal(allowed.status, 201)
    const { rows } = await pool('platform').query(
      'SELECT count(*)::int AS n FROM idempotency_keys WHERE company_id = $1', [A.company])
    assert.equal(rows[0].n, 1, '失败的动作也落了键')
  })
})

describe('幂等键：按 (公司, 账号, 端点) 隔离', () => {
  test('★ 换个端点，同一个字符串是另一件事', async () => {
    await clearKeys()
    let runs = 0
    const run = async () => { runs += 1; return { status: 201, body: { n: runs } } }
    await withIdempotency({ ctx, endpoint: 'POST /systems/a/records', key: 'same', run })
    await withIdempotency({ ctx, endpoint: 'POST /systems/b/records', key: 'same', run })
    assert.equal(runs, 2, '两个端点用同一个键互相顶掉了')
  })

  test('换个账号，同一个字符串是另一件事', async () => {
    await clearKeys()
    let runs = 0
    const run = async () => { runs += 1; return { status: 201, body: { n: runs } } }
    await withIdempotency({ ctx, endpoint: 'POST /w', key: 'same2', run })
    await withIdempotency({ ctx: { ...ctx, userId: A.bob }, endpoint: 'POST /w',
      key: 'same2', run })
    assert.equal(runs, 2, '两个账号用同一个键互相顶掉了')
  })
})

describe('幂等键：窗口', () => {
  test('★ 窗口外的键当新动作', async () => {
    await clearKeys()
    let runs = 0
    const run = async () => { runs += 1; return { status: 201, body: { n: runs } } }
    await withIdempotency({ ctx, endpoint: 'POST /old', key: 'old', run })
    // 把那条键的时间往前挪到窗口之外 —— 模拟「很久以后又点了一次」。
    await pool('platform').query(
      `UPDATE idempotency_keys SET created_at = now() - ($2 || ' milliseconds')::interval
        WHERE idem_key = $1`, ['old', String(Math.ceil(IDEMPOTENCY_WINDOW_MS) + 60_000)])
    await withIdempotency({ ctx, endpoint: 'POST /old', key: 'old', run })
    assert.equal(runs, 2, '窗口外的键被当成了同一次 —— 「很久以后再点一次」会白点')
  })

  test('清扫只删窗口外的那些', async () => {
    await clearKeys()
    const run = async () => ({ status: 201, body: { ok: true } })
    await withIdempotency({ ctx, endpoint: 'POST /p', key: 'fresh', run })
    await withIdempotency({ ctx, endpoint: 'POST /p', key: 'stale', run })
    await pool('platform').query(
      `UPDATE idempotency_keys SET created_at = now() - ($2 || ' milliseconds')::interval
        WHERE idem_key = $1`, ['stale', String(Math.ceil(IDEMPOTENCY_WINDOW_MS) + 60_000)])
    const removed = await pruneIdempotencyKeys()
    assert.equal(removed, 1)
    const { rows } = await pool('platform').query(
      "SELECT idem_key FROM idempotency_keys WHERE company_id = $1", [A.company])
    assert.deepEqual(rows.map((r) => r.idem_key), ['fresh'])
  })
})

describe('幂等键：只能来自请求头', () => {
  test('★ 取键只认请求头', () => {
    assert.equal(idempotencyKeyOf({ [IDEMPOTENCY_HEADER]: 'abc' }), 'abc')
    assert.equal(idempotencyKeyOf({ [IDEMPOTENCY_HEADER]: '  abc  ' }), 'abc')
    assert.equal(idempotencyKeyOf({ [IDEMPOTENCY_HEADER]: '' }), undefined)
    assert.equal(idempotencyKeyOf({ [IDEMPOTENCY_HEADER]: '   ' }), undefined)
    assert.equal(idempotencyKeyOf({ [IDEMPOTENCY_HEADER]: ['abc', 'def'] }), 'abc')
    assert.equal(idempotencyKeyOf({}), undefined)
    assert.equal(idempotencyKeyOf(undefined), undefined)
    // 头名大小写在 HTTP 里不敏感，而 node 已经把入站头名小写了 ——
    // 这里钉住的是「我们读的是小写那个」。
    assert.equal(IDEMPOTENCY_HEADER, 'idempotency-key')
  })
})
