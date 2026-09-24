/**
 * 速率限制与资源配额（N16 残，PRD §9.11.3）。
 *
 * ── 访客维度已经有了，缺的是账号与工具维度 ──────────────────────────────
 *
 * §3.5.2 定义了访客的四维度（链接/来源/签发人/公司）。§9.11.3 管的是**有账号**的那一侧：
 *
 * | 维度 | 约束 |
 * |---|---|
 * | **账号** | 按账号限制调用频率 |
 * | **工具** | 按工具限制调用频率 |
 * | **资源配额** | 单次查询结果规模、批量动作对象数 |
 * | **并发上限** | 单账号与单租户的并发会话与并发工具调用 |
 *
 * ── 最容易被做错的一条：**超限时拒绝，不静默截断** ──────────────────────
 *
 * 「截断会误导用户」—— 用户以为看到了全部结果，实际只看到前 N 条。
 * 那比报错更糟：**报错可以被处理，截断不能被发现**。
 * 所以本模块只有两种结局：放行（完整结果）或拒绝（说明超了什么）。
 *
 * ── 窗口与计数放在哪 ────────────────────────────────────────────────────
 *
 * 放平台库，不放进程内存：内存计数在多进程/重启后失效，
 * 而失效的方向是**放行**（限流失效 = 无限流）。
 */
import { pool } from './db.mjs'
import { appendDenial } from './audit.mjs'

/** 默认限额。全部可由环境覆盖，但**都有默认值** —— 没配也有值，不静默关闭。 */
export const LIMITS = Object.freeze({
  windowMs: Number(process.env.KVVI_RATE_WINDOW_MS ?? 60_000),
  accountPerWindow: Number(process.env.KVVI_RATE_ACCOUNT ?? 600),
  toolPerWindow: Number(process.env.KVVI_RATE_TOOL ?? 300),
  maxResultItems: Number(process.env.KVVI_RATE_MAX_ITEMS ?? 200),
  maxBatchTargets: Number(process.env.KVVI_RATE_MAX_BATCH ?? 50),
  maxConcurrentSessions: Number(process.env.KVVI_RATE_MAX_SESSIONS ?? 10),
})

export class RateLimitError extends Error {
  constructor(code, detail = {}) {
    super(code)
    this.code = code
    this.detail = detail
  }
}

/**
 * 记一次调用（滑动窗口记账表）。
 * @param {object} input `{companyId, dimension, key}`
 */
async function record({ companyId, dimension, key }) {
  await pool('platform').query(
    `INSERT INTO rate_events (company_id, dimension, key, at)
     VALUES ($1,$2,$3, now())`, [companyId, dimension, key])
}

/** 窗口内的计数。 */
async function count({ companyId, dimension, key, windowMs }) {
  const { rows } = await pool('platform').query(
    `SELECT count(*)::int AS n FROM rate_events
      WHERE company_id = $1 AND dimension = $2 AND key = $3
        AND at > now() - ($4 || ' milliseconds')::interval`,
    [companyId, dimension, key, String(windowMs)])
  return rows[0].n
}

/**
 * 检查并记账一次工具调用。
 *
 * **先检查、后记账**：反过来的话，被拒的调用也占额度，
 * 于是一个被限流的人只会越来越被限流 —— 那不是保护，是雪崩。
 * @param {object} input 入参
 * @returns {Promise<{allowed: boolean, error?: string, detail?: object}>} 结论
 */
export async function checkToolCall({ ctx, tool }) {
  const checks = [
    { dimension: 'ACCOUNT', key: ctx.userId, limit: LIMITS.accountPerWindow,
      code: 'KVVI_RATE_LIMITED_ACCOUNT' },
    { dimension: 'TOOL', key: tool, limit: LIMITS.toolPerWindow,
      code: 'KVVI_RATE_LIMITED_TOOL' },
  ]
  for (const c of checks) {
    const n = await count({ companyId: ctx.companyId, dimension: c.dimension,
                            key: c.key, windowMs: LIMITS.windowMs })
    if (n >= c.limit) {
      const detail = { dimension: c.dimension, limit: c.limit, windowMs: LIMITS.windowMs,
                       observed: n }
      await appendDenial({
        companyId: ctx.companyId, actorKind: 'AGENT', actorId: ctx.userId,
        gateway: ctx.gateway, sessionId: ctx.sessionId,
        action: tool, outcome: 'DENY', reason: c.code,
      })
      throw new RateLimitError(c.code, detail)
    }
  }
  await record({ companyId: ctx.companyId, dimension: 'ACCOUNT', key: ctx.userId })
  await record({ companyId: ctx.companyId, dimension: 'TOOL', key: tool })
  return { allowed: true }
}

/**
 * 结果规模配额。**超限即拒绝，不截断**（§9.11.3：「截断会误导用户」）。
 * @param {number} requested 请求条数
 * @returns {{allowed: boolean, limit: number}} 结论
 */
export function checkResultSize(requested) {
  if (requested > LIMITS.maxResultItems) {
    return { allowed: false, limit: LIMITS.maxResultItems }
  }
  return { allowed: true, limit: LIMITS.maxResultItems }
}

/**
 * 批量动作对象数配额。批量同时是 §9.6.4.1 的 R3 触发条件之一 ——
 * 两条规则各有各的作用：这条防资源耗尽，那条防越权。
 * @param {number} targets 目标数
 * @returns {{allowed: boolean, limit: number}} 结论
 */
export function checkBatchSize(targets) {
  return targets > LIMITS.maxBatchTargets
    ? { allowed: false, limit: LIMITS.maxBatchTargets }
    : { allowed: true, limit: LIMITS.maxBatchTargets }
}

/**
 * 并发会话上限（单账号）。
 * @param {string} companyId 公司
 * @param {string} userId 账号
 * @returns {Promise<{allowed: boolean, limit: number, active: number}>} 结论
 */
export async function checkSessionQuota(companyId, userId) {
  const { rows } = await pool('platform').query(
    `SELECT count(*)::int AS n FROM sessions
      WHERE company_id = $1 AND user_id = $2 AND state = 'ACTIVE'`,
    [companyId, userId])
  const active = rows[0].n
  return active >= LIMITS.maxConcurrentSessions
    ? { allowed: false, limit: LIMITS.maxConcurrentSessions, active }
    : { allowed: true, limit: LIMITS.maxConcurrentSessions, active }
}

/** 清理过期窗口（运维用；不影响判定正确性，只控制表增长）。 */
export async function prune(windowMs = LIMITS.windowMs) {
  const { rowCount } = await pool('platform').query(
    `DELETE FROM rate_events WHERE at <= now() - ($1 || ' milliseconds')::interval`,
    [String(windowMs * 4)])
  return rowCount
}
