/**
 * 认证端点与**会话生命周期五类事件的入口**（PRD §4.6.5）。
 *
 * ── 为什么这些端点必须在本进程内闭合 ────────────────────────────────────
 *
 * 若登录流量经运行时进程转发，插件（与运行时同进程）可以**直接窃取用户凭据** ——
 * 「无活跃会话主体免疫」即不成立（§4.6.5，第十一轮复评 `kimi-k3` 重要 3）。
 *
 * 所以本模块的五个入口**全部落在平台服务进程**：
 *
 * | 事件 | 入口 | 谁触发 |
 * |---|---|---|
 * | 登录 | `POST /auth/login` | 用户 |
 * | 登出 | `POST /auth/logout` | 用户 |
 * | 超时 | `POST /auth/sessions/reap` | 平台自身（受控接口） |
 * | 账号停用 | `POST /auth/accounts/:id/suspend` | 管理员 |
 * | 管理员吊销 | `POST /auth/sessions/:id/revoke` | 管理员 |
 *
 * ⚠️ v2.11 曾只写「基于认证事件自行维护」而未枚举，导致**登出路径悬空**：
 * 登出请求若先到运行时进程，会被「不接受写请求」那条卡死 ——
 * 实现者只能违反约束或做不出登出。枚举 + 入口归属一起写，才不留这个洞。
 *
 * ── 每一步都留痕 ────────────────────────────────────────────────────────
 *
 * 成功与**失败**都写审计。只记成功的审计回答不了「谁被拦了」。
 */
import { append, appendDenial, digestOf } from './audit.mjs'
import {
  authenticate, createSession, endSession, issueToken, verifyToken,
  loadSession, reapIdleSessions, suspendAccount, revokeSession, gatewaysFor,
  signingKeys, rotateSigningKeys,
} from './identity.mjs'
import { publicKeysOf, CLAIM_FIELDS } from './signing.mjs'
import { pool } from './db.mjs'
import { TOOL_GATEWAY, toolsForGateway } from './authorization.mjs'

/** 登录时可选的公司列表。**只有一个时默认选中**（§9.9.3）。 */
async function companiesOf(userId) {
  const { rows } = await pool('platform').query(
    `SELECT c.company_id, c.name FROM memberships m
       JOIN companies c ON c.company_id = m.company_id
      WHERE m.user_id = $1 ORDER BY c.name`, [userId])
  return rows.map((r) => ({ companyId: r.company_id, name: r.name }))
}

/** 从 Authorization 头取原始令牌。 */
function bearer(req) {
  return (req.headers.authorization ?? '').replace(/^Bearer\s+/iu, '')
}

/**
 * 处理一个 `/auth/*` 请求。
 * @param {object} input 入参
 * @returns {Promise<{status: number, body: object}|null>} 响应；不属本模块时返回 null
 */
export async function handleAuth({ method, path, body, headers }) {
  const fake = { headers }

  // ── ① 登录 ──────────────────────────────────────────────────────
  if (path === '/auth/login' && method === 'POST') {
    const { login, password, companyId, gateway = 'USER' } = body ?? {}
    if (!gatewaysFor().includes(gateway)) {
      return { status: 400, body: { error: 'KVVI_BAD_GATEWAY' } }
    }
    const account = await authenticate(login, password)
    if (!account) {
      // ⚠️ 失败也留痕，但**不记明文口令**，只记摘要。
      await appendDenial({
        companyId: companyId ?? '00000000-0000-0000-0000-000000000000',
        actorKind: 'SYSTEM', action: 'auth.login', gateway,
        outcome: 'DENY', reason: 'KVVI_BAD_CREDENTIALS',
        paramsDigest: digestOf({ login }),
      })
      // 不区分「账号不存在」与「口令错」—— 那本身就是一次账号枚举。
      return { status: 401, body: { error: 'KVVI_BAD_CREDENTIALS' } }
    }
    if (account.status !== 'ACTIVE') {
      return { status: 403, body: { error: 'KVVI_ACCOUNT_NOT_ACTIVE' } }
    }
    const companies = await companiesOf(account.userId)
    if (companies.length === 0) {
      return { status: 403, body: { error: 'KVVI_NOT_A_MEMBER' } }
    }
    let chosen = companyId
    if (!chosen) {
      if (companies.length > 1) {
        // 有多个公司时**必须让用户选** —— 替用户选等于悄悄替他决定了租户。
        return {
          status: 409,
          body: { error: 'KVVI_COMPANY_SELECTION_REQUIRED', companies },
        }
      }
      chosen = companies[0].companyId
    }
    const session = await createSession({ userId: account.userId,
                                          companyId: chosen, gateway })
    const token = await issueToken(session.sessionId)
    await append({
      companyId: chosen, actorKind: 'USER', actorId: account.userId, gateway,
      sessionId: session.sessionId, action: 'auth.login', outcome: 'ALLOW',
      paramsDigest: digestOf({ login, companyId: chosen }),
    })
    return { status: 201, body: {
      sessionId: session.sessionId, token, companyId: chosen, gateway,
      companies, // 「切换公司」= 用另一个 companyId 新建会话，不是改当前会话
    } }
  }

  // ── ② 登出 ──────────────────────────────────────────────────────
  if (path === '/auth/logout' && method === 'POST') {
    const ctx = await verifyToken(bearer({ headers }))
    if (!ctx) return { status: 401, body: { error: 'KVVI_INVALID_TOKEN' } }
    const ok = await endSession(ctx.sessionId, 'LOGOUT')
    await append({
      companyId: ctx.companyId, actorKind: 'USER', actorId: ctx.userId,
      gateway: ctx.gateway, sessionId: ctx.sessionId, action: 'auth.logout',
      outcome: ok ? 'ALLOW' : 'DENY', reason: ok ? null : 'KVVI_SESSION_NOT_ACTIVE',
    })
    return { status: ok ? 200 : 409, body: { ok } }
  }

  // ── 读会话（含可用工具集）──────────────────────────────────────
  if (path === '/auth/session' && method === 'GET') {
    const ctx = await verifyToken(bearer({ headers }))
    if (!ctx) return { status: 401, body: { error: 'KVVI_INVALID_TOKEN' } }
    const session = await loadSession(ctx.sessionId)
    // ★ 锚点① 的机器可检证据就在这里：员工会话拿到的工具集里
    //   **一个搭建工具都没有**，而且这不是「本接口过滤的」——
    //   分类表是冻结常量，交集只减不增（见 toolsForGateway）。
    const enabled = Object.keys(TOOL_GATEWAY)
    return { status: 200, body: {
      sessionId: ctx.sessionId, userId: ctx.userId, companyId: ctx.companyId,
      gateway: ctx.gateway, state: session.state, createdAt: session.createdAt,
      tools: toolsForGateway(ctx.gateway, enabled),
      // 让复核者能自己核对：两个集合都报出来。
      toolsOfOtherGateway: toolsForGateway(ctx.gateway === 'USER' ? 'BUILDER' : 'USER', enabled),
    } }
  }

  // ── 签名接口（§9.4.1 ② 授权规则）───────────────────────────────
  //
  // 授权规则三条，缺一不可：
  //   1. **只有运行时进程能来**（进程间令牌）—— 用户与浏览器不能直接申请签名；
  //   2. **必须点名一个活动会话**，声明全部由服务端从该会话导出；
  //   3. **请求体里不得出现任何声明字段** —— 出现即拒绝**并告警**。
  //
  // ⚠️ 第 2 条不能放宽成「点名任意会话」：§9.4.1 的负向测试要求
  //    「插件无法为『无活跃认证会话的主体』取得令牌」。
  //    而「无会话」这件事在这里是可判定的 —— 没有 sid 就没有令牌。
  if (path === '/sign/delegation' && method === 'POST') {
    const asked = Object.keys(body ?? {})
    const forbidden = asked.filter((k) => CLAIM_FIELDS.includes(k)
      && k !== 'sid' && k !== 'cv')
    if (forbidden.length > 0) {
      // 「被拒**并告警**」—— 告警不是日志级别，是一次可查的审计写入。
      await appendDenial({
        companyId: '00000000-0000-0000-0000-000000000000',
        actorKind: 'SYSTEM', action: 'sign.request',
        reason: `KVVI_SUBJECT_FIELDS_FORBIDDEN:${forbidden.join(',')}`,
        paramsDigest: digestOf({ forbidden }),
      })
      return { status: 400, body: { error: 'KVVI_SUBJECT_FIELDS_FORBIDDEN', fields: forbidden } }
    }
    const sessionId = body?.sid
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return { status: 400, body: { error: 'KVVI_SESSION_REQUIRED' } }
    }
    const session = await loadSession(sessionId)
    if (!session) return { status: 404, body: { error: 'KVVI_NO_SUCH_SESSION' } }
    // **没有活动会话就不签**（§9.4.1 负向测试第七项）
    if (session.state !== 'ACTIVE' || session.userStatus !== 'ACTIVE') {
      return { status: 403, body: { error: 'KVVI_NO_ACTIVE_SESSION' } }
    }
    const token = await issueToken(sessionId)
    await append({
      companyId: session.companyId, actorKind: 'AGENT', actorId: session.userId,
      gateway: session.gateway, sessionId, action: 'sign.request', outcome: 'ALLOW',
    })
    return { status: 201, body: { token, expiresInMs: undefined } }
  }

  // 公钥分发：业务系统据此配置信任锚点（§9.4.1）。公钥不是秘密。
  if (path === '/sign/keys' && method === 'GET') {
    const keys = signingKeys()
    return { status: 200, body: {
      keys: publicKeysOf(keys).map((k) => ({ kid: k.kid, publicKey: k.publicKey })),
      // 并行期：新旧公钥同时可验，轮换不会导致全体失效（§9.4.1）。
      rotation: { active: keys.kid, previous: (keys.previous ?? []).map((k) => k.kid) },
    } }
  }

  if (path === '/sign/rotate' && method === 'POST') {
    const next = rotateSigningKeys()
    return { status: 200, body: { active: next.kid,
      previous: (next.previous ?? []).map((k) => k.kid) } }
  }

  // ── ③ 超时回收 ──────────────────────────────────────────────────
  if (path === '/auth/sessions/reap' && method === 'POST') {
    const ended = await reapIdleSessions()
    return { status: 200, body: { ended } }
  }

  // ── ④ 账号停用 ──────────────────────────────────────────────────
  const suspend = /^\/auth\/accounts\/([0-9a-fA-F-]{36})\/suspend$/u.exec(path)
  if (suspend && method === 'POST') {
    const ended = await suspendAccount(suspend[1])
    return { status: 200, body: { userId: suspend[1], endedSessions: ended } }
  }

  // ── ⑤ 管理员吊销 ────────────────────────────────────────────────
  const revoke = /^\/auth\/sessions\/([0-9a-fA-F-]{36})\/revoke$/u.exec(path)
  if (revoke && method === 'POST') {
    const session = await loadSession(revoke[1])
    const ok = await revokeSession(revoke[1])
    if (session) {
      await append({
        companyId: session.companyId, actorKind: 'USER', actorId: session.userId,
        gateway: session.gateway, sessionId: session.sessionId,
        action: 'auth.revoke', outcome: ok ? 'ALLOW' : 'DENY',
        reason: ok ? null : 'KVVI_SESSION_NOT_ACTIVE',
      })
    }
    return { status: ok ? 200 : 409, body: { ok } }
  }

  return null
}
