/** N4 · 会话消息保留期（分层默认 + 按公司配置 + 删内容留骨架）。 */
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { pool, closeAll } from '../src/db.mjs'
import { A, B, resetDatabase, makeSession, grantBaseline } from './harness.mjs'
import { resolvePolicy, setPolicy, registerSkeleton, sweep, onAccountSuspended,
         readSkeleton, noteToolCall, BOUNDS, RetentionError } from '../src/retention.mjs'
import { verifyChain } from '../src/audit.mjs'

let actor = null
const store = { purged: [], async purgeMessages(id) { this.purged.push(`M:${id}`) },
                async purgeToolResults(id) { this.purged.push(`T:${id}`) } }
const day = 24 * 60 * 60 * 1000

before(async () => {
  await resetDatabase()
  await grantBaseline(A.alice)
  actor = await makeSession(A.alice, A.company)
})
after(closeAll)

describe('N4 分层默认值', () => {
  test('未配置的公司 → 用**部署默认**（不配也不会 fail-open）', async () => {
    const p = await resolvePolicy(A.company)
    assert.equal(p.source, 'DEPLOYMENT_DEFAULT')
    assert.equal(p.toolResultDays, 30)
    assert.equal(p.messageDays, 90)
  })

  test('★ 两个默认值**都是正数** —— 没有「无保留期」这个状态', () => {
    assert.ok(BOUNDS.toolResultDays.default > 0)
    assert.ok(BOUNDS.messageDays.default > 0)
    assert.equal(BOUNDS.toolResultDays.max, 365)
    assert.equal(BOUNDS.messageDays.max, 1825)
  })
})

describe('N4 按公司配置', () => {
  test('配置生效，且只影响该公司', async () => {
    const p = await setPolicy({ actor: actor.ctx, companyId: A.company,
                                toolResultDays: 7, messageDays: 365 })
    assert.equal(p.source, 'COMPANY_OVERRIDE')
    assert.equal(p.toolResultDays, 7)
    const other = await resolvePolicy(B.company)
    assert.equal(other.source, 'DEPLOYMENT_DEFAULT', '配置串到了别的公司')
  })

  test('★ 越界即拒 —— 「永久保留」表达不出来', async () => {
    for (const [t, m] of [[0, 90], [366, 90], [30, 0], [30, 1826]]) {
      await assert.rejects(
        () => setPolicy({ actor: actor.ctx, companyId: A.company,
                          toolResultDays: t, messageDays: m }),
        (e) => e instanceof RetentionError && e.code === 'KVVI_RETENTION_OUT_OF_RANGE')
    }
  })

  test('配置动作留痕', async () => {
    const { rows } = await pool('auditRead').query(
      `SELECT count(*)::int AS n FROM audit_entries
        WHERE action = 'retention.setPolicy' AND outcome = 'ALLOW'`)
    assert.ok(rows[0].n >= 1)
  })
})

describe('N4 骨架：删内容，留骨架', () => {
  test('★ 到期后**删内容**，但骨架与工具事实**留下**', async () => {
    const sid = randomUUID()
    await setPolicy({ actor: actor.ctx, companyId: A.company,
                      toolResultDays: 1, messageDays: 2 })
    await registerSkeleton({ sessionId: sid, companyId: A.company, userId: A.alice,
                             gateway: 'USER', startedAt: new Date(Date.now() - 5 * day) })
    await noteToolCall(sid, 'data.readView', 'sha256:abc')
    await noteToolCall(sid, 'data.readView', 'sha256:def')

    store.purged.length = 0
    const report = await sweep(store, new Date())
    assert.ok(report.toolResults.includes(sid))
    assert.ok(report.bodies.includes(sid))
    assert.ok(store.purged.includes(`T:${sid}`) && store.purged.includes(`M:${sid}`))

    // 骨架还在，而且**工具事实可查** —— 这就是「不破坏审计链」
    const skel = await readSkeleton(A.company, sid)
    assert.ok(skel, '骨架被删了 —— 审计链上出现了断点')
    assert.equal(skel.tool_calls[0].tool, 'data.readView')
    assert.equal(skel.tool_calls[0].count, 2)
    assert.ok(skel.body_purged_at && skel.tool_purged_at)
  })

  test('★ 未到期的会话不被清扫（不是「一跑全清」）', async () => {
    const sid = randomUUID()
    await registerSkeleton({ sessionId: sid, companyId: A.company, userId: A.alice,
                             gateway: 'USER', startedAt: new Date() })
    store.purged.length = 0
    await sweep(store, new Date())
    assert.ok(!store.purged.includes(`M:${sid}`), '未到期的会话被清了')
  })

  test('★ 跨公司不可读：读别家的骨架与「不存在」结果一致', async () => {
    const sid = randomUUID()
    await registerSkeleton({ sessionId: sid, companyId: A.company, userId: A.alice,
                             gateway: 'USER', startedAt: new Date() })
    assert.ok(await readSkeleton(A.company, sid))
    assert.equal(await readSkeleton(B.company, sid), null, '跨公司读到了别家的会话骨架')
    assert.equal(await readSkeleton(A.company, randomUUID()), null)
  })

  test('★ 账号停用 → 立即删该账号的**工具结果**（L1），正文按保留期', async () => {
    const sid = randomUUID()
    await registerSkeleton({ sessionId: sid, companyId: A.company, userId: A.alice,
                             gateway: 'USER', startedAt: new Date() })
    store.purged.length = 0
    const done = await onAccountSuspended(store, A.alice)
    assert.ok(done.includes(sid))
    assert.ok(store.purged.includes(`T:${sid}`), '停用后工具结果还留着')
    assert.ok(!store.purged.includes(`M:${sid}`), '停用不该把未到期的正文也删了')
  })

  test('清扫只作用于**登记过骨架**的会话（登记在落盘之前或同时）', async () => {
    // ⚠️ 前提：用**另一个公司**。用 A 公司的话，前面几个用例登记的骨架
    // 会在 +10 天时到期并被清掉 —— 那是正常行为，却会让这条断言失败，
    // 看起来像「清扫逻辑坏了」。
    store.purged.length = 0
    const report = await sweep(store, new Date(Date.now() + 10 * day))
    assert.deepEqual(report.bodies.filter((s) => s === undefined), [])
    // B 公司没有登记过任何骨架 → 不产生任何清扫动作
    const bSkeletons = await pool('platform').query(
      'SELECT count(*)::int AS n FROM session_skeletons WHERE company_id = $1',
      [B.company])
    assert.equal(bSkeletons.rows[0].n, 0, 'B 公司不该有骨架')
  })

  test('审计链自洽', async () => {
    assert.equal((await verifyChain()).ok, true)
  })
})
