/**
 * 会话消息数据的保留期（N4，PRD §4.6.1、§4.6.2）。
 *
 * ── 形态，而不是一个数字 ────────────────────────────────────────────────
 *
 * | 层 | 内容 | 默认 | 范围 |
 * |---|---|---|---|
 * | **L1** | 工具调用结果（记录明细） | **30 天** | 1–365 |
 * | **L2** | 对话正文（可能含粘贴的业务数据） | **90 天** | 1–1825 |
 * | **L3** | 会话骨架（标识 / 工具名 / 摘要） | **随审计** | 不适用 |
 *
 * L3 **不是「多留一会儿」**，它是另一类东西 —— 它是这个产品能回答
 * 「谁在什么时候办过这件事」的那部分。删掉它就在审计链上开一个断点。
 *
 * ── 三条 PRD 已定死的前置（不随方案变化）────────────────────────────────
 *
 * 1. 保留期与审计**分别定义**（审计在独立库里，有自己的策略）；
 * 2. **删消息体不得破坏审计链** —— 所以本模块只删内容、留骨架；
 * 3. 阶段四负向测试有对应项：**删除后不可恢复**、**跨公司不可读**。
 *
 * ── 保留期能防什么、不能防什么 ──────────────────────────────────────────
 *
 * 运行时进程**加载插件**，同进程插件在它持有的数据范围内**不设防**。
 * 所以保留期**不是访问控制** —— 它是**时间维度上的收敛**：
 * 防的是备份被翻出来、离职账号被复用、误配的只读副本被挂载。
 */
import { pool, withTransaction } from './db.mjs'
import { adminQueryFor } from './admin-query.mjs'
import { append } from './audit.mjs'

/** 默认与边界。**都有值** —— 客户不配也不会 fail-open。 */
export const BOUNDS = Object.freeze({
  toolResultDays: { min: 1, max: 365, default: Number(process.env.KVVI_TOOLRESULT_RETENTION_DAYS ?? 30) },
  messageDays: { min: 1, max: 1825, default: Number(process.env.KVVI_SESSION_RETENTION_DAYS ?? 90) },
})

export class RetentionError extends Error {
  constructor(code, detail = {}) { super(code); this.code = code; this.detail = detail }
}

/**
 * 取某公司的有效策略：有配置用配置，没有用**默认值**。
 * @param {string} companyId 公司
 * @returns {Promise<{toolResultDays: number, messageDays: number, source: string}>} 策略
 */
export async function resolvePolicy(companyId) {
  const { rows } = await pool('platform').query(
    'SELECT tool_result_days, message_days FROM retention_policies WHERE company_id = $1',
    [companyId])
  if (rows.length === 1) {
    return { toolResultDays: rows[0].tool_result_days, messageDays: rows[0].message_days,
             source: 'COMPANY_OVERRIDE' }
  }
  return { toolResultDays: BOUNDS.toolResultDays.default,
           messageDays: BOUNDS.messageDays.default, source: 'DEPLOYMENT_DEFAULT' }
}

/**
 * 设定某公司的保留期。**越界即拒** —— 「永久保留」表达不出来，因为它不在范围内。
 * @param {object} input 入参
 * @returns {Promise<object>} 生效后的策略
 */
export async function setPolicy({ actor, companyId, toolResultDays, messageDays }) {
  const check = (name, value) => {
    const b = BOUNDS[name]
    if (!Number.isInteger(value) || value < b.min || value > b.max) {
      throw new RetentionError('KVVI_RETENTION_OUT_OF_RANGE',
        { field: name, value, min: b.min, max: b.max })
    }
  }
  check('toolResultDays', toolResultDays)
  check('messageDays', messageDays)

  await pool('platform').query(
    `INSERT INTO retention_policies (company_id, tool_result_days, message_days,
       updated_by, default_tool_result_days, default_message_days)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (company_id) DO UPDATE
       SET tool_result_days = EXCLUDED.tool_result_days,
           message_days = EXCLUDED.message_days,
           updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [companyId, toolResultDays, messageDays, actor.userId,
     BOUNDS.toolResultDays.default, BOUNDS.messageDays.default])
  await append({
    companyId, actorKind: 'USER', actorId: actor.userId, gateway: actor.gateway,
    sessionId: actor.sessionId, action: 'retention.setPolicy', outcome: 'ALLOW',
    paramsDigest: `${toolResultDays}/${messageDays}`,
  })
  return resolvePolicy(companyId)
}

/**
 * 登记一个会话骨架。**在消息体落盘之前或同时**调用 ——
 * 后补的话，掉电会留下一批「有正文、没骨架」的会话，而那批正是删不掉的那些。
 * @param {object} input 入参
 * @returns {Promise<object>} 骨架
 */
export async function registerSkeleton({ sessionId, companyId, userId, gateway, startedAt }) {
  const policy = await resolvePolicy(companyId)
  const day = 24 * 60 * 60 * 1000
  const base = new Date(startedAt ?? Date.now())
  await pool('platform').query(
    `INSERT INTO session_skeletons (session_id, company_id, user_id, gateway,
       started_at, message_expires_at, tool_expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (session_id) DO NOTHING`,
    [sessionId, companyId, userId, gateway, base,
     new Date(base.getTime() + policy.messageDays * day),
     new Date(base.getTime() + policy.toolResultDays * day)])
  return { sessionId, policy }
}

/**
 * 清扫：把到期的**内容**删掉，**骨架留下**。
 *
 * 删的是内容，不是记录 —— 这是「删消息体不得破坏审计链」在代码里的样子。
 * @param {object} store 消息体存储（由运行时进程实现；本模块不猜存储形态）
 * @param {Date} now 当前时间
 * @returns {Promise<object>} 清扫报告
 */
export async function sweep(store, now = new Date()) {
  const { rows } = await pool('platform').query(
    `SELECT session_id, company_id, message_expires_at, tool_expires_at,
            body_purged_at, tool_purged_at
       FROM session_skeletons
      WHERE (body_purged_at IS NULL AND message_expires_at <= $1)
         OR (tool_purged_at IS NULL AND tool_expires_at <= $1)`, [now])
  const report = { bodies: [], toolResults: [] }
  for (const row of rows) {
    if (row.tool_purged_at === null && new Date(row.tool_expires_at) <= now) {
      await store.purgeToolResults(row.session_id)
      await pool('platform').query(
        'UPDATE session_skeletons SET tool_purged_at = now() WHERE session_id = $1',
        [row.session_id])
      report.toolResults.push(row.session_id)
    }
    if (row.body_purged_at === null && new Date(row.message_expires_at) <= now) {
      await store.purgeMessages(row.session_id)
      await pool('platform').query(
        'UPDATE session_skeletons SET body_purged_at = now() WHERE session_id = $1',
        [row.session_id])
      report.bodies.push(row.session_id)
    }
  }
  return report
}

/**
 * 账号停用 → **立即删该账号的工具结果**（L1）。
 *
 * 理由：工具结果是一次性数据，账号没了就没有继续保留的理由；
 * 而对话正文（L2）按保留期走 —— 与「已完成单据不改归属」同理，**历史不改写**。
 *
 * 这把「离职」变成一个**主动收敛点**，而不是等保留期慢慢走完。
 * @param {object} store 消息体存储
 * @param {string} userId 账号
 * @returns {Promise<number[]>} 已删工具结果的会话
 */
export async function onAccountSuspended(store, userId) {
  const { rows } = await pool('platform').query(
    `SELECT session_id FROM session_skeletons
      WHERE user_id = $1 AND tool_purged_at IS NULL`, [userId])
  const done = []
  for (const row of rows) {
    await store.purgeToolResults(row.session_id)
    await pool('platform').query(
      'UPDATE session_skeletons SET tool_purged_at = now() WHERE session_id = $1',
      [row.session_id])
    done.push(row.session_id)
  }
  return done
}

/**
 * 会话骨架查询。**只看得到本公司的**（跨公司不可读 —— 阶段四负向测试项）。
 * @param {string} companyId 公司
 * @param {string} sessionId 会话
 * @returns {Promise<object|null>} 骨架
 */
export async function readSkeleton(companyId, sessionId) {
  // 走超级用户连接做**显式租户比对**：骨架表不给业务角色读权限，
  // 于是「忘了加 company_id 条件」这类错误在这里没有发生的机会。
  const { rows } = await adminQueryFor('kvvi_platform',
    'SELECT * FROM session_skeletons WHERE session_id = $1', [sessionId])
  if (rows.length !== 1) return null
  if (rows[0].company_id !== companyId) return null   // 跨公司：与「不存在」同结果
  return rows[0]
}

/** 记一次工具调用到骨架里（**只记事实，不记明细**）。 */
export async function noteToolCall(sessionId, tool, resultDigest = null) {
  await withTransaction('platform', async (client) => {
    const { rows } = await client.query(
      'SELECT tool_calls FROM session_skeletons WHERE session_id = $1 FOR UPDATE',
      [sessionId])
    if (rows.length !== 1) return
    const calls = rows[0].tool_calls ?? []
    const hit = calls.find((c) => c.tool === tool)
    if (hit) {
      hit.count += 1
      hit.lastDigest = resultDigest
    } else {
      calls.push({ tool, count: 1, lastDigest: resultDigest })
    }
    await client.query(
      'UPDATE session_skeletons SET tool_calls = $2::jsonb WHERE session_id = $1',
      [sessionId, JSON.stringify(calls)])
  })
}
