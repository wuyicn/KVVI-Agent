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
import {
  TOOL_GATEWAY, toolsForGateway, isPlatformAdmin, checkSelfGrant,
} from './authorization.mjs'

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
 * 取**操作人**的令牌。
 *
 * ⚠️ 管理类端点要两样东西，它们不能共用一个头：
 *   `Authorization`           —— **进程**凭据（调用方来自受控进程）
 *   `x-kvvi-actor-token`      —— **人**凭据（谁在操作）
 *
 * 共用一个头的结果是：拿到进程令牌就没法知道是谁，于是「管理员角色」判不了 ——
 * 那正是 N17 的原始形态（只有进程令牌）。
 */
function actorToken(req) {
  return String(req.headers['x-kvvi-actor-token'] ?? '')
}

/**
 * 处理一个 `/auth/*` 请求。
 * @param {object} input 入参
 * @returns {Promise<{status: number, body: object}|null>} 响应；不属本模块时返回 null
 */
/**
 * @param {object} input
 * @param {string} input.method
 * @param {string} input.path
 * @param {object|null} input.body
 * @param {object} input.headers
 * @param {boolean} [input.omitOtherGateway]
 *   省略 `toolsOfOtherGateway`。**只有工作台页面会用到**。
 *   那组字段是给复核者核对「两个集合确实不相交」的取证材料，
 *   而工作台的响应会直接渲染进员工浏览器 —— 让界面拿到
 *   「另一个模式有哪些能力」，正是 §2.3 界面隔离要挡的东西。
 *   审计与取证路径继续带它，不受影响。
 */
export async function handleAuth({ method, path, body, headers, omitOtherGateway = false }) {
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
    const payload = {
      sessionId: ctx.sessionId, userId: ctx.userId, companyId: ctx.companyId,
      gateway: ctx.gateway, state: session.state, createdAt: session.createdAt,
      tools: toolsForGateway(ctx.gateway, enabled),
    }
    if (!omitOtherGateway) {
      // 让复核者能自己核对：两个集合都报出来。
      payload.toolsOfOtherGateway =
        toolsForGateway(ctx.gateway === 'USER' ? 'BUILDER' : 'USER', enabled)
    }
    return { status: 200, body: payload }
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

  // ── 管理类动作：**人**的判定 ────────────────────────────────────
  //
  // N17：原先这三类只要求**进程间令牌**。那说明「浏览器打不到」，
  // **不等于**「只有管理员能调」。§3.1 的两级授权里，「所有者」是一个人。
  // 所以现在是**与**：进程间令牌（调用方来自受控进程）**且**调用者持有平台角色。
  const adminCtx = await verifyToken(actorToken({ headers }))

  const denyAdmin = async (action, reason, extra = {}) => {
    await appendDenial({
      companyId: adminCtx?.companyId ?? '00000000-0000-0000-0000-000000000000',
      actorKind: 'USER', actorId: adminCtx?.userId ?? null, gateway: adminCtx?.gateway ?? null,
      sessionId: adminCtx?.sessionId ?? null, action, outcome: 'DENY', reason,
      paramsDigest: digestOf(extra),
    })
    return { status: 403, body: { error: reason } }
  }

  async function requireAdmin(action, extra = {}) {
    if (!adminCtx) return denyAdmin(action, 'KVVI_ADMIN_TOKEN_REQUIRED', extra)
    const verdict = await isPlatformAdmin(adminCtx.companyId, adminCtx.userId)
    if (!verdict.allowed) return denyAdmin(action, verdict.reason, extra)
    return null
  }

  // ── ④ 账号停用 ──────────────────────────────────────────────────
  const suspend = /^\/auth\/accounts\/([0-9a-fA-F-]{36})\/suspend$/u.exec(path)
  if (suspend && method === 'POST') {
    const refused = await requireAdmin('auth.suspendAccount', { userId: suspend[1] })
    if (refused) return refused
    const ended = await suspendAccount(suspend[1])
    await append({
      companyId: adminCtx.companyId, actorKind: 'USER', actorId: adminCtx.userId,
      gateway: adminCtx.gateway, sessionId: adminCtx.sessionId,
      action: 'auth.suspendAccount', outcome: 'ALLOW',
      resourceKind: 'user', resourceId: suspend[1],
    })
    return { status: 200, body: { userId: suspend[1], endedSessions: ended } }
  }

  // ── ⑤ 管理员吊销 ────────────────────────────────────────────────
  const revoke = /^\/auth\/sessions\/([0-9a-fA-F-]{36})\/revoke$/u.exec(path)
  if (revoke && method === 'POST') {
    // 吊销**自己**的会话是允许的（那等于登出）；吊销别人的需要管理员角色。
    const self = adminCtx && adminCtx.sessionId === revoke[1]
    if (!self) {
      const refused = await requireAdmin('auth.revokeSession', { sessionId: revoke[1] })
      if (refused) return refused
    }
    const session = await loadSession(revoke[1])
    const ok = await revokeSession(revoke[1])
    if (session) {
      await append({
        companyId: session.companyId, actorKind: 'USER',
        actorId: adminCtx?.userId ?? session.userId,
        gateway: session.gateway, sessionId: session.sessionId,
        action: 'auth.revokeSession', outcome: ok ? 'ALLOW' : 'DENY',
        reason: ok ? null : 'KVVI_SESSION_NOT_ACTIVE',
      })
    }
    return { status: ok ? 200 : 409, body: { ok } }
  }

  // ── ⑥ 授权：把业务角色授予他人（§9.6.7 的接线）──────────────────
  //
  // `checkSelfGrant` 这条规则早就写好了，但**没有入口调用它** ——
  // 一条没有接线的不变量等于没有。这里把它接到端点上。
  if (path === '/auth/roles/grant' && method === 'POST') {
    const refused = await requireAdmin('auth.grantRole', { users: body?.userIds })
    if (refused) return refused

    const targetUserIds = Array.isArray(body?.userIds) ? body.userIds : []
    if (targetUserIds.length === 0) {
      return { status: 400, body: { error: 'KVVI_NO_TARGET_USERS' } }
    }
    // ★ §9.6.7：搭建者配置员工业务权限时**不得把自己或关联账号纳入**。
    // 判据是「被授权人是否就是操作者」，与「他有没有这个权限」无关 ——
    // 一个**有**配置权限的搭建者同样不能给自己配。
    const selfGrant = checkSelfGrant(adminCtx.userId, targetUserIds)
    if (!selfGrant.allowed) {
      await appendDenial({
        companyId: adminCtx.companyId, actorKind: 'USER', actorId: adminCtx.userId,
        gateway: adminCtx.gateway, sessionId: adminCtx.sessionId,
        action: 'auth.grantRole', outcome: 'DENY',
        reason: 'KVVI_SELF_GRANT_FORBIDDEN',
        paramsDigest: digestOf({ targets: targetUserIds }),
      })
      return { status: 403, body: { error: 'KVVI_SELF_GRANT_FORBIDDEN',
                                   detail: '不得把自己纳入配置范围（PRD §9.6.7）' } }
    }

    const roleCode = body?.roleCode
    if (typeof roleCode !== 'string' || roleCode.length === 0) {
      return { status: 400, body: { error: 'KVVI_ROLE_CODE_REQUIRED' } }
    }
    // 业务角色**不得占用平台保留 code** —— 否则「谁是所有者」会被业务配置改写。
    const { PLATFORM_ROLE_CODES } = await import('./authorization.mjs')
    if (PLATFORM_ROLE_CODES.includes(roleCode)) {
      return { status: 403, body: { error: 'KVVI_PLATFORM_ROLE_RESERVED', roleCode } }
    }

    const { pool: p } = await import('./db.mjs')
    const { rows } = await p('platform').query(
      `SELECT role_id FROM roles WHERE company_id = $1 AND role_code = $2`,
      [adminCtx.companyId, roleCode])
    if (rows.length !== 1) return { status: 404, body: { error: 'KVVI_NO_SUCH_ROLE' } }
    const roleId = rows[0].role_id

    const granted = []
    for (const userId of targetUserIds) {
      const member = await p('platform').query(
        `SELECT 1 FROM memberships WHERE company_id = $1 AND user_id = $2`,
        [adminCtx.companyId, userId])
      if (member.rows.length !== 1) continue          // 非本公司成员：跳过，不报错
      await p('platform').query(
        `INSERT INTO role_members (company_id, role_id, user_id)
         VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [adminCtx.companyId, roleId, userId])
      granted.push(userId)
      await append({
        companyId: adminCtx.companyId, actorKind: 'USER', actorId: adminCtx.userId,
        gateway: adminCtx.gateway, sessionId: adminCtx.sessionId,
        action: 'auth.grantRole', outcome: 'ALLOW',
        resourceKind: 'user', resourceId: userId,
        paramsDigest: digestOf({ roleCode }),
      })
    }
    return { status: 200, body: { roleCode, granted } }
  }

  return null
}
