/**
 * 账号生命周期与离职交接（N16 残，PRD §3.3「按 Q13」）。
 *
 * ── 缺口的确切位置 ──────────────────────────────────────────────────────
 *
 * §3.3.1 说明「一半已经解决」：**离职者是审批人**时，契约里已有兜底
 * （只有 `在职` 可当审批人；直属主管离职 → 转交管理员并告警，流程挂起不静默卡住）。
 *
 * **缺口是另一半**：离职者是**申请人**时，他在途单据无人接管。
 *
 * ── 按单据状态分流（§3.3.2）────────────────────────────────────────────
 *
 * | 单据状态 | 处理 | 是否**流程**交接 |
 * |---|---|---|
 * | 草稿（未提交） | 归档封存，**所有权转移**给继任者 | ⚠️ **否** |
 * | 已提交 / 在途 | **显式交接**给继任者 | ✅ 是 |
 * | 待他审批的 | 复用已有兜底：转交管理员并告警 | 复用 |
 * | 已完成 | **不改归属**，仅追加「提交人已离职」标记 | 否 |
 *
 * ⚠️ 草稿那一格的 ⚠️ 是 S3 澄清的重点：「是否交接」指**是否进入流程交接**。
 * 草稿只是**归属转移**（否则成为孤儿数据，§3.3.6），**不**触发兜底告警、
 * **不**需要为它指定继任者。把两件事混起来会读成自相矛盾。
 *
 * ── 三条原则（§3.3.3）──────────────────────────────────────────────────
 *
 * 1. **历史不可改写** —— 已完成单据的提交人永远是他本人，只追加标记，不替换；
 * 2. **在途必须显式转移，不得静默** —— 直接引用契约既有立场：
 *    「卡住的流程无人知道要处理，是审批系统最隐蔽的故障」；
 * 3. **账号只能停用，不能删除** —— 单据通过 `AssetRef` 引用员工实体。
 */
import { pool, withTransaction } from './db.mjs'
import { applyScopeGucs } from './authorization.mjs'
import { append } from './audit.mjs'
import { suspendAccount } from './identity.mjs'
import { lockFormLifecycle, assertFormActive, FormArchivedError } from './business-lifecycle.mjs'

/** 分流表：**封闭**。状态不在表里即拒绝，不猜。 */
export const HANDOVER_BY_STATE = Object.freeze({
  draft: { ownership: 'TRANSFER', flow: false, terminal: false },
  submitted: { ownership: 'TRANSFER', flow: true, terminal: false },
  approved: { ownership: 'KEEP', flow: false, terminal: true },
  rejected: { ownership: 'KEEP', flow: false, terminal: true },
})

export class LifecycleError extends Error {
  constructor(code, detail = {}) {
    super(code)
    this.code = code
    this.detail = detail
  }
}

/**
 * 该状态下要不要交接，以及交接到哪一层。
 * @param {string} state 单据状态
 * @returns {{ownership: string, flow: boolean, terminal: boolean}} 分流结论
 */
export function handoverPlan(state) {
  const plan = HANDOVER_BY_STATE[state]
  if (!plan) throw new LifecycleError('KVVI_UNKNOWN_RECORD_STATE', { state })
  return plan
}

/**
 * 离职交接。
 *
 * 顺序是设计的一部分：
 *   ① 先停用账号（会话与令牌立即失效，§4.6.5 第四类事件）
 *   ② 再按状态分流处理在途单据
 *   ③ 最后写交接记录
 *
 * **反过来的顺序会出现一个窗口**：交接做完了但人还能登录。
 * @param {object} input 入参
 * @returns {Promise<object>} 交接报告
 */
export async function offboard({ actor, userId, successorUserId, records }) {
  if (userId === successorUserId) {
    throw new LifecycleError('KVVI_SUCCESSOR_IS_SELF')
  }
  // ① 停用：撤销全部活动会话与令牌
  const endedSessions = await suspendAccount(userId)

  const report = { transferred: [], marked: [], skipped: [], alerts: [] }
  // ⚠️ 业务库的表**受 RLS 约束**。不设作用域上下文时，`UPDATE ... WHERE record_id = $1`
  // 影响 **0 行且不报错** —— 交接会「跑成功但什么都没改」。
  // 这是本项目反复踩到的同一类：报错位置没错，但也没有报错。
  //
  // 离职交接是**公司级管理动作**：把上下文设成「该公司 + COMPANY 档位」，
  // 于是它能看到并改到本公司全部记录，但**仍然跨不过租户**。
  await withTransaction('business', async (client) => {
    await applyScopeGucs(client, {
      companyId: actor.companyId, userId: actor.userId, gateway: actor.gateway,
      deptId: null, deptSubtree: [], shopId: null, scopes: ['COMPANY'],
    })
    for (const record of records ?? []) {
      const actual=(await client.query('SELECT schema_code FROM business_records WHERE company_id=$1 AND record_id=$2',[actor.companyId,record.recordId])).rows[0]
      if(!actual) { report.skipped.push({recordId:record.recordId,reason:'KVVI_RECORD_NOT_FOUND'}); continue }
      await lockFormLifecycle(client,actor.companyId,actual.schema_code,'write')
      try { await assertFormActive(client,actor.companyId,actual.schema_code) }
      catch(error) {
        if(!(error instanceof FormArchivedError)) throw error
        report.skipped.push({recordId:record.recordId,reason:error.code})
        continue
      }
      const plan = handoverPlan(record.state)
      if (plan.terminal) {
        await client.query(
          `UPDATE business_records
              SET data = data || jsonb_build_object('_submitter_left', true)
            WHERE record_id = $1`, [record.recordId])
        report.marked.push(record.recordId)
        continue
      }
      if (!plan.flow) {
        await client.query(
          'UPDATE business_records SET owner_id = $2 WHERE record_id = $1',
          [record.recordId, successorUserId])
        report.skipped.push({ recordId: record.recordId, reason: 'DRAFT_OWNERSHIP_ONLY' })
        continue
      }
      await client.query(
        'UPDATE business_records SET owner_id = $2 WHERE record_id = $1',
        [record.recordId, successorUserId])
      report.transferred.push(record.recordId)
      report.alerts.push({ recordId: record.recordId,
                           reason: 'IN_FLIGHT_HANDOVER', to: successorUserId })
    }
  })

  void 0

  await pool('platform').query(
    `INSERT INTO session_events (session_id, user_id, company_id, kind, detail)
     VALUES (gen_random_uuid(), $1, $2, 'ACCOUNT_SUSPENDED', $3)`,
    [userId, actor.companyId,
     JSON.stringify({ reason: 'OFFBOARD', successor: successorUserId })])

  await append({
    companyId: actor.companyId, actorKind: 'USER', actorId: actor.userId,
    gateway: actor.gateway, sessionId: actor.sessionId,
    action: 'account.offboard', outcome: 'ALLOW',
    resourceKind: 'user', resourceId: userId,
    paramsDigest: JSON.stringify({ successorUserId, ...report }).slice(0, 512),
  })
  return { userId, successorUserId, endedSessions, ...report }
}

/**
 * 账号**只能停用，不能删除**（§3.3.3 第 3 条）。
 *
 * 单据通过 `AssetRef` 引用员工实体；删掉账号会让历史单据指向不存在的实体 ——
 * 那是**审计链上的断点**，而不是一次干净的删除。
 * @returns {never} 永远抛出
 */
export function deleteAccount() {
  throw new LifecycleError('KVVI_ACCOUNT_DELETE_FORBIDDEN',
    { why: '单据通过 AssetRef 引用员工实体；删除会让历史单据指向不存在的实体' })
}

/**
 * 交接后：在途单据必须**都有主**（不得产生孤儿，§3.3.6）。
 *
 * ⚠️ 走**超级用户**连接：这是一条跨范围的完整性检查，
 * 用受 RLS 约束的连接会把「别家公司/别的档位」的孤儿看漏 ——
 * 而检查本身返回空数组，看起来像「没有孤儿」。
 * @param {string} companyId 公司
 * @returns {Promise<string[]>} 孤儿单据 id
 */
export async function findOrphans(companyId) {
  const { adminQueryFor } = await import('./admin-query.mjs')
  // ⚠️ 两个库**跨库查不了**：`memberships` 在平台库，`business_records` 在业务库。
  // 写成一条 JOIN 会报 `42P01 relation "memberships" does not exist` ——
  // 看起来像「表没建」，实际是「查到了另一个库」。
  const records = await adminQueryFor('kvvi_business',
    `SELECT record_id, owner_id FROM business_records WHERE company_id = $1`, [companyId])
  const members = await adminQueryFor('kvvi_platform',
    `SELECT user_id FROM memberships WHERE company_id = $1`, [companyId])
  const known = new Set(members.rows.map((r) => r.user_id))
  return records.rows
    .filter((r) => r.owner_id === null || !known.has(r.owner_id))
    .map((r) => r.record_id)
}
