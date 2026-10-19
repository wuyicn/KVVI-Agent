/**
 * 业务侧的命令端点语义（PRD §9.2、§9.4.1、§9.4.2、§9.4.3、§9.4.4、§9.4.5）。
 *
 * ── 这一段代码扮演的是「业务系统」那一侧 ────────────────────────────────
 *
 * 它要回答的问题不是「谁能调」，而是「一次调用在什么情况下被拒、
 * 被拒时**说得清是哪一种拒**」。
 *
 * ── §9.4.4 的可用性要求，在代码里就是「顺序」──────────────────────────
 *
 * §4.6.2 规则 3 要求「平台不可用不应使业务系统停摆」。能兑现这一条的
 * 前提是**把不需要平台的检查与需要平台的检查分开**：
 *
 * | 检查 | 需要平台在线 | 平台不可用时 |
 * |---|---|---|
 * | 令牌签名验证（公钥在本地） | ❌ | **继续可用** |
 * | 短时有效期检查 | ❌ | **继续可用** |
 * | 契约版本比对（版本随调用传递） | ❌ | **继续可用** |
 * | 撤销状态 / 授权版本查询 | ✅ | 缓存窗口内降级，**超窗失败关闭** |
 * | 新令牌签发 | ✅ | **拒绝** |
 *
 * 所以本模块的顺序是：**先做完本地能做的**，再去问平台。
 * 把顺序写反（先查平台再验签）会让平台一挂就全挂 —— 那不是「保守」，
 * 那是把一个本地能判的事变成了远程依赖。
 *
 * ── §9.4.5：拒绝可诊断，但**不放松** ────────────────────────────────────
 *
 * 拒绝理由要区分（授权版本失配 / 契约版本失配 / 撤销不可用 / 令牌过期），
 * 并带上**双方版本码**；同时失配时**两个原因都要给出**。
 * 但拒绝本身不变 —— 可区分只是让它可诊断。
 */
import { TOKEN_TTL_MS, verifyExpiry, verifySignature } from './signing.mjs'
import { CommandError, detectCallerIdentityFields, execute } from './commands.mjs'
import { scopeContext } from './authorization.mjs'
import {RecordStateError} from './record-state.mjs'

/** 本业务系统当前激活的契约版本（§9.4.2 与 §9.4.3 是两个独立版本，不要合并）。 */
export const ACTIVE_CONTRACT_VERSION = process.env.KVVI_CONTRACT_VERSION ?? 'kvvi-contract/v1'

/**
 * 撤销与授权状态的本地缓存（§9.4.4）。
 *
 * ⚠️ **仅在平台不可达时启用**。平台在线时缓存必须被绕过 ——
 * §9.4.2 的「立即失效」与「缓存可继续接受」不能并存于在线场景。
 */
const statusCache = new Map()

/** 测试用：清空缓存。 */
export function clearStatusCache() {
  statusCache.clear()
}

/**
 * 取权威状态。默认实现直接读平台库；测试可以注入一个「不可达」的实现。
 * @param {object} claims 令牌声明
 * @returns {Promise<{ok: boolean, state?: string, av?: number, error?: string}>}
 */
export async function authoritativeStatus(claims) {
  const { pool } = await import('./db.mjs')
  const { rows } = await pool('platform').query(
    `SELECT s.state, u.authz_version AS av, u.status
       FROM sessions s JOIN users u ON u.user_id = s.user_id
      WHERE s.session_id = $1`, [claims.sid])
  if (rows.length !== 1) return { ok: false, error: 'KVVI_STATUS_UNKNOWN_SESSION' }
  const r = rows[0]
  return {
    ok: true,
    state: r.state === 'ACTIVE' && r.status === 'ACTIVE' ? 'ACTIVE' : 'REVOKED',
    av: r.av,
  }
}

/**
 * 命令端点：验签 → 到期 → 契约版本 → 撤销/授权版本 → 执行。
 *
 * @param {object} input 入参
 * @param {string} input.token 令牌
 * @param {object[]} input.publicKeys 业务系统持有的公钥集合
 * @param {string|null} input.contractVersion 调用方声明的契约版本（随调用传递，§9.4.5）
 * @param {object} input.body 请求体 `{action, targets, patch, confirmed, amount}`
 * @param {object|null} input.approval R3 审批
 * @param {object[]} input.transitions 状态机
 * @param {Function} [input.statusProvider] 权威状态来源（默认查平台库）
 * @param {number} [input.nowMs] 当前时间
 * @returns {Promise<{status: number, body: object}>} 响应
 */
export async function handleCommand({
  token, publicKeys, contractVersion, body,
  approval = null, transitions = [], statusProvider = authoritativeStatus, nowMs = Date.now(),
}) {
  const denied = (error, extra = {}) => ({
    status: error === 'KVVI_TOKEN_EXPIRED' ? 401 : 403,
    body: { ok: false, error, category: extra.category ?? 'AUTH',
            ...extra.extra, contractVersion: ACTIVE_CONTRACT_VERSION },
  })

  // ── 本地能做的，先做完（§9.4.4）──────────────────────────────
  const sig = verifySignature(token, publicKeys)
  if (!sig.ok) return denied(sig.error, { category: 'SIGNATURE' })

  const exp = verifyExpiry(sig.claims, nowMs)
  if (!exp.ok) {
    return { status: 401, body: { ok: false, error: exp.error, category: 'TOKEN_EXPIRED',
                                  contractVersion: ACTIVE_CONTRACT_VERSION } }
  }

  // 契约版本比对（§9.4.3）：版本**随调用传递**，本地比对，
  // 不引入「为取激活版本而查询平台」的新依赖（§9.4.5 末表）。
  const mismatches = []
  if (contractVersion && contractVersion !== ACTIVE_CONTRACT_VERSION) {
    mismatches.push({ error: 'KVVI_CONTRACT_VERSION_MISMATCH',
                     callerVersion: contractVersion, currentVersion: ACTIVE_CONTRACT_VERSION })
  }

  // ── 需要平台的：撤销 + 授权版本（§9.4.4）─────────────────────
  let status = null
  let online = false
  try {
    const fresh = await statusProvider(sig.claims, { nowMs })
    if (fresh?.ok) {
      online = true
      status = fresh
      statusCache.set(sig.claims.sid, { ...fresh, at: nowMs })
    }
  } catch {
    // 「不可达」的判定以**是否成功取到权威状态**为准，
    // 不是以「平台进程是否存活」为准（§9.4.4 v2.15 补充）。
    online = false
  }

  if (!online) {
    const cached = statusCache.get(sig.claims.sid)
    const stale = cached && nowMs - cached.at > TOKEN_TTL_MS
    if (!cached || stale) {
      // ⚠️ 顺序很重要：**本地已经判出来的拒绝，不能被远端不可达掩盖**。
      // 契约版本失配是本地事实（版本随调用传递，§9.4.5），
      // 若因为「查不到撤销状态」就改口报 503，运维会去查平台，
      // 而真正的问题在契约版本 —— 这正是 §9.4.5 要避免的「不可诊断的拒绝风暴」。
      if (mismatches.length > 0) {
        return {
          status: 403,
          body: {
            ok: false, error: mismatches[0].error, category: 'VERSION_REVOCATION',
            reasons: mismatches,
            // 如实说明：授权版本这一项**没查到**，不是「查了没问题」
            authorizationStatusChecked: false,
            offline: true,
            contractVersion: ACTIVE_CONTRACT_VERSION,
          },
        }
      }
      // 无有效缓存且没有本地可判的拒绝 → **失败关闭**（§9.4.4）
      return { status: 503, body: {
        ok: false,
        error: stale ? 'KVVI_STATUS_CACHE_EXPIRED' : 'KVVI_STATUS_UNAVAILABLE_NO_CACHE',
        category: 'REVOCATION_UNAVAILABLE', windowMs: TOKEN_TTL_MS,
        contractVersion: ACTIVE_CONTRACT_VERSION } }
    }
    status = { ...cached, offline: true }
  }

  // 在线时**禁用缓存放行**：缓存只在平台不可达时参与判定。
  if (online && status.state !== 'ACTIVE') {
    mismatches.push({ error: 'KVVI_SESSION_REVOKED' })
  }
  if (!online && status.state !== 'ACTIVE') {
    mismatches.push({ error: 'KVVI_SESSION_REVOKED' })
  }
  if (status.av !== sig.claims.av) {
    mismatches.push({ error: 'KVVI_AUTHZ_VERSION_MISMATCH',
                      callerVersion: sig.claims.av, currentVersion: status.av })
  }

  if (mismatches.length > 0) {
    // §9.4.5：**同时失配要全部返回**，不得只给其一。
    return {
      status: 403,
      body: {
        ok: false,
        error: mismatches[0].error,
        category: 'VERSION_REVOCATION',
        // 全部原因都在这里，运维据此判断是哪一条版本问题
        reasons: mismatches,
        contractVersion: ACTIVE_CONTRACT_VERSION,
        offline: !online,
      },
    }
  }

  // ── 调用方不得提供身份字段（§9.3.1、§9.2 硬性要求 2）─────────
  const forbidden = detectCallerIdentityFields(body)
  if (forbidden.length > 0) {
    return {
      status: 400,
      body: { ok: false, error: 'KVVI_CALLER_SUPPLIED_IDENTITY', category: 'POLICY',
              fields: forbidden,
              detail: '身份与租户只能由服务端从令牌导出（PRD §9.3.1、§9.2）。' },
    }
  }

  // ── 执行（唯一执行点：UI 与 Agent 走的是同一次调用）──────────
  const ctx = {
    sessionId: sig.claims.sid, userId: sig.claims.sub, companyId: sig.claims.ten,
    gateway: sig.claims.gw,
  }
  const scope = await scopeContext(ctx)
  try {
    const result = await execute({ ctx, scope, request: body, approval, transitions })
    return { status: 200, body: { ok: true, offline: !online, ...result } }
  } catch (error) {
    if(error instanceof RecordStateError)return {status:error.status,body:{ok:false,error:error.code,category:'POLICY',offline:!online}}
    if (error instanceof CommandError) {
      return { status: error.code === 'KVVI_RECORD_NOT_FOUND' ? 404 : 403,
               body: { ok: false, error: error.code, category: error.category,
                       ...error.extra, offline: !online } }
    }
    throw error
  }
}
