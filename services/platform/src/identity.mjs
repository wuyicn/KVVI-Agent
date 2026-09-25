/**
 * 身份层：账号、会话、委派令牌（PRD §4.6.5、§9.4、§9.9）。
 *
 * ── 本模块承载的核心决策 ────────────────────────────────────────────────
 *
 * **§9.9.3：公司在会话创建时选定并绑定，会话内不可变更。**
 * 因此这里**没有** `switchCompany()` —— 不是没实现，是**按设计不存在**。
 * 「切换公司」被实现为「新建会话」。这一条的价值在于：它是**结构性免疫**，
 * 而不是「切换后记得清理令牌/会话/引用」——后者只要漏一处就泄漏。
 *
 * **§9.9.5：租户上下文按会话隔离，不得是账号级共享状态。**
 * 所以本模块所有取上下文的函数都以 `sessionId` 为参数，
 * **不提供**任何以 `userId` 为键的租户缓存 —— 那种缓存正是并发多公司会话
 * 互相串台的来源。
 *
 * **§9.4.2：令牌绑定授权版本**，权限一改（`users.authz_version` +1）
 * 已签发的令牌全部失效 —— 权限回收不需要「记得去清缓存」。
 */
import { createHash, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import { pool, withTransaction } from './db.mjs'
import { ACTIVE_CONTRACT_VERSION } from './business.mjs'
import { allowedGateways } from './mode-policy.mjs'
import {
  loadKeys, rotate, publicKeysOf, signToken, verifyExpiry, verifySignature,
} from './signing.mjs'

/**
 * 签名密钥。**懒加载**：进程启动时若无密钥，只有在真正要签发/验签时才报错 ——
 * 这样「没有私钥的平台进程」仍然能提供 /healthz 与 /topology 取证
 * （阶段一锚点⑥ 的取证必须能在缺私钥时也能复核）。
 */
let keysCache = null
export function signingKeys() {
  if (keysCache === null) keysCache = loadKeys()
  return keysCache
}

/** 测试/运维用：轮换密钥（新旧公钥并行可验，§9.4.1）。 */
export function rotateSigningKeys() {
  keysCache = rotate(signingKeys())
  return keysCache
}

/** 会话工具有效期。超时是五类生命周期事件之一（§4.6.5）。 */
const SESSION_TTL_MS = Number(process.env.KVVI_SESSION_TTL_MS ?? 8 * 60 * 60 * 1000)
const TOKEN_TTL_MS = Number(process.env.KVVI_TOKEN_TTL_MS ?? 15 * 60 * 1000)

/** 口令散列：scrypt + 每账号独立盐。**只存散列**，不存可逆值。 */
export function hashPassword(password, salt = randomUUID()) {
  const derived = scryptSync(password, salt, 32)
  return `scrypt$${salt}$${derived.toString('hex')}`
}

/** 常量时间校验，避免按字符早退泄漏。 */
export function verifyPassword(password, stored) {
  const [scheme, salt, hex] = String(stored).split('$')
  if (scheme !== 'scrypt' || !salt || !hex) return false
  const expected = Buffer.from(hex, 'hex')
  const actual = scryptSync(password, salt, expected.length)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

const digestOf = (raw) => createHash('sha256').update(raw).digest('hex')

/**
 * 登录：校验口令，把账号状态一并读出。
 *
 * ⚠️ 本函数**不创建会话**。登录与「选定公司」是两步：
 * 一个账号可以在多家公司，会话必须绑定其中一家（§9.9.3）。
 * 把它们并成一步会悄悄替用户选公司。
 * @param {string} login 登录名
 * @param {string} password 口令
 * @returns {Promise<{userId: string, status: string, authzVersion: number}|null>} 账号，或 null
 */
export async function authenticate(login, password) {
  const { rows } = await pool('platform').query(
    'SELECT user_id, password_hash, status, authz_version FROM users WHERE login = $1', [login])
  if (rows.length !== 1) return null
  const row = rows[0]
  if (!verifyPassword(password, row.password_hash)) return null
  return { userId: row.user_id, status: row.status, authzVersion: row.authz_version }
}

/**
 * 列出该账号可选的会话网关（双网关，§2.6）。模式在会话创建时绑定。
 * @param {string} userId 账号
 * @returns {Promise<string[]>} 可选的网关
 */
export function gatewaysFor(companyId, userId) {
  return allowedGateways(companyId, userId)
}

/**
 * 新建会话：**公司在这里选定并绑定**（§9.9.3）。
 * @param {object} input 入参
 * @param {string} input.userId 账号
 * @param {string} input.companyId 选定公司
 * @param {'USER'|'BUILDER'} input.gateway 模式
 * @returns {Promise<object>} 会话
 */
export async function createSession({ userId, companyId, gateway }) {
  return withTransaction('platform', async (client) => {
    const user = await client.query(
      'SELECT status, authz_version FROM users WHERE user_id = $1', [userId])
    if (user.rows.length !== 1) throw new Error('KVVI_NO_SUCH_USER')
    if (user.rows[0].status !== 'ACTIVE') throw new Error('KVVI_ACCOUNT_NOT_ACTIVE')

    const member = await client.query(
      `SELECT m.dept_id, m.shop_id FROM memberships m
        WHERE m.company_id = $1 AND m.user_id = $2`, [companyId, userId])
    if (member.rows.length !== 1) throw new Error('KVVI_NOT_A_MEMBER')

    const sessionId = randomUUID()
    await client.query(
      `INSERT INTO sessions (session_id, user_id, company_id, gateway, state,
                             authz_version, ended_at)
       VALUES ($1, $2, $3, $4, 'ACTIVE', $5, NULL)`,
      [sessionId, userId, companyId, gateway, user.rows[0].authz_version])

    await client.query(
      `INSERT INTO session_events (session_id, user_id, company_id, kind, detail)
       VALUES ($1, $2, $3, 'LOGIN', $4)`,
      [sessionId, userId, companyId, JSON.stringify({ gateway })])

    return { sessionId, userId, companyId, gateway, deptId: member.rows[0].dept_id,
             shopId: member.rows[0].shop_id,
             authzVersion: user.rows[0].authz_version }
  })
}

/**
 * 读会话。**租户上下文从会话里读**，不从参数里传 —— 这是 §9.9.5 的实现约束。
 * @param {string} sessionId 会话
 * @returns {Promise<object|null>} 会话上下文
 */
export async function loadSession(sessionId) {
  const { rows } = await pool('platform').query(
    `SELECT s.session_id, s.user_id, s.company_id, s.gateway, s.state, s.authz_version,
            s.created_at, s.last_seen_at, u.status AS user_status, u.authz_version AS current_authz,
            m.dept_id, m.shop_id
       FROM sessions s
       JOIN users u ON u.user_id = s.user_id
       JOIN memberships m ON m.company_id = s.company_id AND m.user_id = s.user_id
      WHERE s.session_id = $1`, [sessionId])
  if (rows.length !== 1) return null
  const r = rows[0]
  return {
    sessionId: r.session_id, userId: r.user_id, companyId: r.company_id,
    gateway: r.gateway, state: r.state, createdAt: r.created_at,
    lastSeenAt: r.last_seen_at, userStatus: r.user_status,
    authzVersion: r.authz_version, currentAuthzVersion: r.current_authz,
    deptId: r.dept_id, shopId: r.shop_id,
  }
}

/**
 * 结束会话，并记录**是哪一类事件**结束的（§4.6.5 五类）。
 * @param {string} sessionId 会话
 * @param {'LOGOUT'|'TIMEOUT'|'ACCOUNT_SUSPENDED'|'ADMIN_REVOKED'} kind 事件类型
 * @returns {Promise<boolean>} 是否确实结束了一个活动会话
 */
export async function endSession(sessionId, kind) {
  const allowed = ['LOGOUT', 'TIMEOUT', 'ACCOUNT_SUSPENDED', 'ADMIN_REVOKED']
  if (!allowed.includes(kind)) throw new Error(`KVVI_BAD_EVENT_KIND: ${kind}`)
  return withTransaction('platform', async (client) => {
    const { rows } = await client.query(
      `UPDATE sessions SET state = 'ENDED', ended_by = $2, ended_at = now()
        WHERE session_id = $1 AND state = 'ACTIVE'
        RETURNING user_id, company_id`, [sessionId, kind])
    if (rows.length !== 1) return false
    // 实质机制是令牌撤销（§4.6.5「平台→运行时的终止通知」）：
    // 通道失去可用令牌即失效，不依赖运行时进程的配合。
    await client.query(
      `UPDATE delegation_tokens SET revoked_at = now()
        WHERE session_id = $1 AND revoked_at IS NULL`, [sessionId])
    await client.query(
      `INSERT INTO session_events (session_id, user_id, company_id, kind, detail)
       VALUES ($1, $2, $3, $4, '{}'::jsonb)`,
      [sessionId, rows[0].user_id, rows[0].company_id, kind])
    return true
  })
}

/**
 * 超时扫描：把 idle 超时的会话按 `TIMEOUT` 结束。
 * @param {Date} now 当前时间
 * @returns {Promise<string[]>} 被结束的会话
 */
export async function reapIdleSessions(now = new Date()) {
  const cutoff = new Date(now.getTime() - SESSION_TTL_MS)
  const { rows } = await pool('platform').query(
    `SELECT session_id FROM sessions
      WHERE state = 'ACTIVE' AND last_seen_at < $1`, [cutoff])
  const ended = []
  for (const row of rows) {
    if (await endSession(row.session_id, 'TIMEOUT')) ended.push(row.session_id)
  }
  return ended
}

/**
 * 停用账号：**该账号的全部活动会话一并结束**（§4.6.5 第四类事件）。
 * @param {string} userId 账号
 * @returns {Promise<number>} 被结束的会话数
 */
export async function suspendAccount(userId) {
  await pool('platform').query('UPDATE users SET status = $2 WHERE user_id = $1',
    [userId, 'SUSPENDED'])
  const { rows } = await pool('platform').query(
    `SELECT session_id FROM sessions WHERE user_id = $1 AND state = 'ACTIVE'`, [userId])
  let n = 0
  for (const row of rows) if (await endSession(row.session_id, 'ACCOUNT_SUSPENDED')) n += 1
  return n
}

/**
 * 管理员吊销：结束指定会话（§4.6.5 第五类事件）。
 * @param {string} sessionId 会话
 * @returns {Promise<boolean>} 是否结束成功
 */
export async function revokeSession(sessionId) {
  return endSession(sessionId, 'ADMIN_REVOKED')
}

/**
 * 提权：授权版本 +1。**已签发的令牌随之全部失效**（§9.4.2）。
 * @param {string} userId 账号
 * @returns {Promise<number>} 新的授权版本
 */
export async function bumpAuthzVersion(userId) {
  const { rows } = await pool('platform').query(
    `UPDATE users SET authz_version = authz_version + 1
      WHERE user_id = $1 RETURNING authz_version`, [userId])
  return rows[0].authz_version
}

/**
 * 签发委派令牌。
 *
 * ⚠️ 令牌**绑定会话所属公司**（§9.9.4）。因为会话内的公司不可变更，
 * 这里不需要「切换时废止」的逻辑 —— 不可能发生的事不必防守。
 * @param {string} sessionId 会话
 * @returns {Promise<string>} 原始令牌（**只此一次**，服务端只留摘要）
 */
export async function issueToken(sessionId) {
  const session = await loadSession(sessionId)
  if (!session) throw new Error('KVVI_NO_SUCH_SESSION')
  if (session.state !== 'ACTIVE') throw new Error('KVVI_SESSION_ENDED')
  const keys = signingKeys()
  // 声明**全部由服务端从会话状态导出**，调用方无权提供（§9.4.1）。
  const token = signToken({
    sub: session.userId, sid: session.sessionId, ten: session.companyId,
    gw: session.gateway, av: session.authzVersion, cv: ACTIVE_CONTRACT_VERSION,
  }, keys)
  const header = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'))
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
  await pool('platform').query(
    `INSERT INTO delegation_tokens (token_id, token_digest, session_id, user_id,
       company_id, authz_version, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7))`,
    [payload.jti, digestOf(token), sessionId, session.userId, session.companyId,
     session.authzVersion, payload.exp])
  void header
  return token
}

/**
 * 校验令牌并取回**服务端决定的**上下文。
 *
 * 四次判定缺一不可，且**都不看调用方传了什么**：
 *   1. 摘要匹配且未撤销、未过期；
 *   2. 会话仍为 ACTIVE（登出/超时/停用/吊销后立即失效）；
 *   3. **公司一致**：令牌的公司 = 会话的公司（§9.9.4）；
 *   4. **授权版本一致**：与账号当前版本相同（§9.4.2）。
 * @param {string} raw 原始令牌
 * @returns {Promise<object|null>} 上下文，或 null
 */
export async function verifyToken(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null

  // ① 本地：验签 + 到期。**不依赖平台**（§9.4.4）——
  //    但本进程就是平台，所以这里的"本地"是同一进程内。
  const sig = verifySignature(raw, publicKeysOf(signingKeys()))
  if (!sig.ok) return null
  if (!verifyExpiry(sig.claims).ok) return null
  const claims = sig.claims

  // ② 权威：撤销状态与授权版本。
  const { rows } = await pool('platform').query(
    `SELECT t.revoked_at,
            s.state AS session_state, s.company_id AS session_company,
            s.authz_version AS session_av, s.gateway,
            u.status, u.authz_version AS current_authz,
            m.dept_id, m.shop_id
       FROM delegation_tokens t
       JOIN sessions s ON s.session_id = t.session_id
       JOIN users u ON u.user_id = t.user_id
       JOIN memberships m ON m.company_id = s.company_id AND m.user_id = s.user_id
      WHERE t.token_id = $1`, [claims.jti])
  if (rows.length !== 1) return null
  const r = rows[0]
  if (r.revoked_at !== null) return null
  if (r.session_state !== 'ACTIVE') return null
  // 令牌里的租户必须与**会话的租户**一致（§9.9.4）。
  if (claims.ten !== r.session_company) return null
  // 授权版本（§9.4.2）：令牌里的版本 = 签发时的版本；任一环节变了都拒。
  if (claims.av !== r.session_av || claims.av !== r.current_authz) return null
  if (r.status !== 'ACTIVE') return null
  return {
    tokenId: claims.jti, sessionId: claims.sid, userId: claims.sub,
    companyId: claims.ten, gateway: claims.gw,
    deptId: r.dept_id, shopId: r.shop_id,
  }
}

/** 会话与令牌的计数（诊断用）。 */
export async function stats() {
  const { rows } = await pool('platform').query(
    `SELECT (SELECT count(*) FROM sessions WHERE state = 'ACTIVE') AS active_sessions,
            (SELECT count(*) FROM delegation_tokens WHERE revoked_at IS NULL
               AND expires_at > now()) AS live_tokens`)
  return rows[0]
}
