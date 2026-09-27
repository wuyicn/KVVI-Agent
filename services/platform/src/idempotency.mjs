/**
 * 幂等键：让「同一个动作重发一次」不产生第二次效果。
 *
 * ── 它补的是什么 ────────────────────────────────────────────────────────
 *
 * 会话连续性验收的第 ⑤ 条量出过一个事实：**写操作没有幂等键** ——
 * 同一条建记录的请求打三次，建出三条不同的记录。当时「重连不重放」
 * 靠的是**客户端不自动重试**，而不是服务端认得出重复。
 *
 * 这两件事不是一回事：前者是一个**约定**（任何一个新调用方都可能不遵守），
 * 后者是一个**判据**（调用方守不守规矩都成立）。
 * 而重连恰恰是最容易重复发一次的时刻 —— 请求发出去了、响应没回来、
 * 连接断了、客户端重连后**不知道那一次到底成没成**。
 * 此时唯一安全的重试方式，是带一个服务端认得的键。
 *
 * ── 为什么键由调用方给，而不是拿请求体摘要 ──────────────────────────────
 *
 * 摘要在**合法的重复**上会误判：同一个销售录入两条同名客户是常态
 * （契约里那条「先不做查重」就是为此）。摘要相同不等于同一次动作。
 * 只有调用方知道「这是不是同一次」。
 *
 * ── 重发回的是**当初那个响应**，不是错误 ────────────────────────────────
 *
 * 回「重复」会让重连的客户端以为失败 —— 而它其实成功了，只是没收到。
 * 所以窗口内重发直接回当初的 `{status, body}`，含那个 `recordId`。
 *
 * ── 键什么时候可以丢 ────────────────────────────────────────────────────
 *
 * 窗口由 `KVVI_IDEMPOTENCY_WINDOW_MS` 给（默认 24 小时：够覆盖「白天断了、
 * 下班前重试」）。窗口外的同一个键会被当成新的一次 —— 那不是漏判，
 * 那是「这么久之后的重试已经不是同一次了」。
 */
import { pool } from './db.mjs'

/** 保留窗口。 */
export const IDEMPOTENCY_WINDOW_MS = Number(
  process.env.KVVI_IDEMPOTENCY_WINDOW_MS ?? 24 * 60 * 60 * 1000)

/** 幂等键只能来自请求头 —— 放进请求体就会被模型当成一个可以自己写的参数。 */
export const IDEMPOTENCY_HEADER = 'idempotency-key'

/**
 * 从请求头取幂等键。
 *
 * ⚠️ **只认请求头，不认请求体。** 放进请求体的话，它就成了一条模型可见的
 * 参数 —— 而「同一个动作重发不产生第二次效果」这条判据不该由模型决定。
 * @param headers 请求头
 * @returns 键，或 `undefined`
 */
export function idempotencyKeyOf(headers) {
  const raw = headers?.[IDEMPOTENCY_HEADER]
  const value = Array.isArray(raw) ? raw[0] : raw
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * 跑一个**可能**带幂等键的动作。
 *
 * 没有键时直接执行 —— 幂等是调用方**选择**要的保证，不是强加的。
 * 有键且窗口内已经跑过：回当初那个响应，不再执行。
 *
 * @param {object} input 入参
 * @param {object} input.ctx 会话上下文（公司、账号从会话取，不从参数取）
 * @param {string} input.endpoint 端点标识（键按端点隔离）
 * @param {string|undefined} input.key 幂等键
 * @param {() => Promise<{status: number, body: object}>} input.run 真正的动作
 * @returns {Promise<{status: number, body: object, replayed?: boolean}>} 结果
 */
export async function withIdempotency({ ctx, endpoint, key, run }) {
  if (key === undefined) return await run()

  const scope = [ctx.companyId, ctx.userId, endpoint, key]
  const { rows } = await pool('platform').query(
    `SELECT response, status_code, created_at FROM idempotency_keys
      WHERE company_id = $1 AND user_id = $2 AND endpoint = $3 AND idem_key = $4`,
    scope)
  if (rows.length === 1
      && Date.now() - new Date(rows[0].created_at).getTime() < IDEMPOTENCY_WINDOW_MS) {
    return { status: rows[0].status_code, body: rows[0].response, replayed: true }
  }

  const result = await run()
  // ⚠️ **只记成功的那些。**
  //    记下失败会把「第一次因为权限不足被拒、第二次权限给了再试」变成
  //    「窗口内永远回那个 403」—— 一个瞬时的拒绝会变成永久的状态。
  if (result.status >= 200 && result.status < 300) {
    await pool('platform').query(
      `INSERT INTO idempotency_keys (company_id, user_id, idem_key, endpoint,
         response, status_code)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (company_id, user_id, endpoint, idem_key) DO UPDATE
         SET response = EXCLUDED.response, status_code = EXCLUDED.status_code,
             created_at = now()`,
      [ctx.companyId, ctx.userId, key, endpoint,
       JSON.stringify(result.body), result.status])
  }
  return result
}

/**
 * 清扫过期的键。
 * @param {Date} [now] 当前时间
 * @returns {Promise<number>} 删掉的条数
 */
export async function pruneIdempotencyKeys(now = new Date()) {
  const cutoff = new Date(now.getTime() - IDEMPOTENCY_WINDOW_MS)
  const { rowCount } = await pool('platform').query(
    'DELETE FROM idempotency_keys WHERE created_at < $1', [cutoff])
  return rowCount ?? 0
}
