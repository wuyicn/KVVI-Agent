/**
 * 受鉴权的**产品 API**：`/api/v1/*`。
 *
 * ── 为什么是 `/api/v1` 而不是现成的 `/kvvi/` ──────────────────────────────
 *
 * 阶段九的计划选定 `/api/v1`。它有一个必须**先解决**的前置：
 * DSH 运行时的 RPC 通道注册为 `prefix /api`，所以 `/api/v1/*` 默认会被
 * 转发给运行时并回 404（实测：那个 404 的响应头里没有 `x-kvvi-process`）。
 *
 * 因此本模块的前提是**平台先认领 `/api/v1/` 前缀**。
 * 认领判据在 `proxy.mjs` 的 `isOwnedPath` —— 那里排在转发之前，
 * 所以运行时永远看不到这些路径。这不是「抢路径」：`/api/v1/` 比 `/api/`
 * 更具体，而运行时对它的响应一直是 404，没有行为被改变。
 *
 * ── 三条不变量（每一条都有对应的负向测试）────────────────────────────────
 *
 * | # | 不变量 | 不成立会怎样 |
 * |---|---|---|
 * | 1 | 公司**只**从验证过的会话来 | 传一个别的 companyId 就跨租户 |
 * | 2 | 身份类字段在**入口处递归剥掉** | 嵌套在 data 里的 `companyId` 钻进执行点 |
 * | 3 | 未鉴权时不返回任何业务数据 | 接口一开就是全公司的数据出口 |
 *
 * ⚠️ 第 2 条不是「与命令执行点重复」。命令执行点剥的是**它自己那条路**；
 * API 是新入口，**每条入口各自负责**。少一处，那处就是旁路。
 */

import { tokenFromCookie } from './gate.mjs'
import { systemRoutes } from './system-api.mjs'
import { adminRoutes } from './admin-api.mjs'
import { loadSession } from './identity.mjs'
import { verifyRuntimeContextHeaders } from './runtime-auth.mjs'

/** 产品 API 的前缀。与运行时 RPC 的 `/api` 区分靠**更具体**的路径。 */
const PREFIX = '/api/v1'

/**
 * 身份类字段：这些键**永远**不从请求体里采信。
 *
 * 与命令执行点的禁列同源 —— 身份只从会话导出（§9.9.2：
 * 模型可见的逻辑引用不得带租户；这里同理：**调用方不得声明租户**）。
 */
const IDENTITY_KEYS = Object.freeze(['companyId', 'tenant', 'actor', 'roles', 'gateway'])

/**
 * 用签名的运行时会话上下文换一个会话事实。
 *
 * ── 公司、用户、网关**从会话行读**，不从请求头读 ────────────────────────
 *
 * 头里也带着这三样，它们是签名的一部分。但签名只证明「平台签过这些字段」，
 * 不证明「它们此刻仍然成立」：会话可能已被停用、账号可能已被挂起。
 * 所以本函数用头里的 `sessionId` **定位**会话，再用**会话行**作为唯一事实 ——
 * 并逐字段核对头与会话是否一致，不一致一律拒绝（重放或伪造）。
 *
 * @param headers 请求头
 * @returns 会话事实；没有可用上下文或核对不过时为 `null`
 */
async function sessionFromRuntimeContext(headers) {
  let context
  try {
    context = verifyRuntimeContextHeaders(headers)
  } catch {
    // 三种失败（缺失、过期、签名不符）对调用方是同一件事：没有可用凭据。
    // 分开报会把「签名不符」变成一个可探测的信号。
    return null
  }
  try {
    const live = await loadSession(context.sessionId)
    if (live === null) return null
    if (live.state !== 'ACTIVE' || live.userStatus !== 'ACTIVE') return null
    if (live.userId !== context.userId
      || live.companyId !== context.companyId
      || live.gateway !== context.gateway) return null
    return {
      sessionId: live.sessionId, userId: live.userId, companyId: live.companyId,
      gateway: live.gateway, state: live.state,
    }
  } catch {
    return null
  }
}

/**
 * 该路径是否属于产品 API。
 * @param pathname 请求路径
 * @returns 属于时为 true
 */
export function isApiPath(pathname) {
  return pathname === PREFIX || pathname.startsWith(PREFIX + '/')
}

/**
 * **递归**剥掉身份类字段。
 *
 * 只在顶层删键挡不住 `{ data: { companyId: '…' } }` —— 而业务写入的载荷
 * 天然是嵌套的（`data` 里放字段值）。所以按深度遍历，
 * 数组元素也走一遍（批量写入会用到）。
 *
 * @param value 任意 JSON 值
 * @returns 剥掉身份字段后的**新**值（不改原对象 —— 调用方可能还要用）
 */
export function stripIdentity(value) {
  if (Array.isArray(value)) return value.map(stripIdentity)
  if (value === null || typeof value !== 'object') return value
  const out = {}
  for (const [k, v] of Object.entries(value)) {
    if (IDENTITY_KEYS.includes(k)) continue
    out[k] = stripIdentity(v)
  }
  return out
}

/** 稳定错误码 → HTTP 状态。判据在此集中一处，各路由不各写一份。 */
const STATUS_OF = Object.freeze({
  KVVI_INVALID_TOKEN: 401,
  KVVI_TOKEN_REQUIRED: 401,
  KVVI_NOT_A_MEMBER: 403,
  KVVI_WRONG_GATEWAY: 403,
  KVVI_SELF_GRANT_FORBIDDEN: 403,
  KVVI_SELF_APPROVAL_FORBIDDEN: 403,
  KVVI_NO_SUCH_DRAFT: 404,
  KVVI_NO_SUCH_RECORD: 404,
  KVVI_NO_SUCH_SYSTEM: 404,
  KVVI_RUNTIME_CONTRACT_INCOMPLETE: 409,
  KVVI_CONTRACT_CONTENT_TAMPERED: 409,
  KVVI_ROW_VERSION_CONFLICT: 409,
  KVVI_TRANSITION_NOT_DEFINED: 409,
  KVVI_BAD_JSON: 400,
  KVVI_UNKNOWN_ROUTE: 404,
})

/**
 * 稳定错误码 → HTTP 状态。
 * @param code 领域错误码
 * @returns HTTP 状态码；未登记的一律 400（**不默认 500**：那是「我们错了」，
 *   而一个未登记的错误码更可能是「调用方请求不合法」）
 */
export function statusOf(code) {
  return STATUS_OF[code] ?? 400
}

/**
 * 处理产品 API 请求。
 *
 * ⚠️ 返回 `null` 表示**这不是本模块的路径**，调用方继续往下走。
 *
 * @param {object} input
 * @param {string} input.method 请求方法
 * @param {string} input.path 请求路径（不含查询串）
 * @param {string} input.query 原始查询串（含 `?`）
 * @param {string} input.body 原始请求体
 * @param {object} input.headers 请求头
 * @param {(token: string) => Promise<{status: number, body: object}|null>} input.loadSession
 *   「用令牌换会话」——由服务器注入，指向 `auth.mjs` 的会话端点。
 *   **不在这里再判一次身份**：两份实现迟早分叉，而分叉方向是漏判。
 * @returns {Promise<{status: number, body: object}|null>}
 */
export async function handleApi({ method, path, query, body, headers, loadSession }) {
  if (!isApiPath(path)) return null

  // ── ① 鉴权：三种凭据 ────────────────────────────────────────────────
  //   - `Authorization: Bearer …` —— 显式调用方（脚本、另一个前端）
  //   - 同源 Cookie —— 登录门设的 HttpOnly Cookie，浏览器自动带上
  //   - **签名的运行时会话上下文** —— 运行时进程里的工具（Worker Agent）用它
  //
  // ⚠️ 第三条不是「多开一道门」。运行时进程**不可能**持有用户的 Cookie 或
  //    委派令牌：那是浏览器的东西，而工具执行时没有浏览器。它有的是平台在
  //    转发请求时签下的身份上下文（`runtime-auth.mjs`，双方共用同一份协议）。
  //    所以它证明的是「这个调用来自运行时的某次已验证会话」，凭据强度与
  //    会话令牌同级 —— 都是**平台自己签的**。
  const fromHeader = (headers?.authorization ?? '').replace(/^Bearer\s+/iu, '')
  const token = fromHeader !== '' ? fromHeader : tokenFromCookie(headers?.cookie)

  let session
  if (token === undefined || token === '') {
    session = await sessionFromRuntimeContext(headers)
    if (session === null) return { status: 401, body: { error: 'KVVI_TOKEN_REQUIRED' } }
  } else {
    try {
      const out = await loadSession(token)
      if (out === null) return { status: 401, body: { error: 'KVVI_INVALID_TOKEN' } }
      if (out.status !== 200) {
        // 会话端点自己的拒绝原样带出（401 / 403 / 503 各有含义）
        return out
      }
      session = out.body
    } catch (error) {
      return { status: 503, body: {
        error: 'KVVI_IDENTITY_UNAVAILABLE',
        detail: String(error && error.message ? error.message : error).slice(0, 200),
      } }
    }
  }

  // ── ② 解析请求体，剥掉身份类字段 ───────────────────────────────────
  let payload = null
  if (body !== undefined && body !== null && body !== '') {
    try {
      payload = stripIdentity(JSON.parse(body))
    } catch {
      return { status: 400, body: { error: 'KVVI_BAD_JSON' } }
    }
  }

  // ── ③ 分派 ──────────────────────────────────────────────────────────
  //
  // ⚠️ **会话里的公司/用户是唯一来源**。调用方传的 `companyId` 已在 ② 被剥掉，
  // 这里再不从 query 里读它 —— 读一次就是把 ② 绕过去了。
  // ★ 交给产品路由。**注意传的是 `session`，不是 `payload` 里的任何身份字段** ——
  //   调用方传的 `companyId` 已在 ② 被剥掉，路由只认会话。
  //
  //   管理路由单列，不是「多一个前缀」：`/admin/*` 的闸门与 `/systems/*` 不同
  //   （前者要求所有者/管理员角色，后者只要求一个有效会话），
  //   而且它的**每一个分支各自过闸** —— 一处粗判会让新增的子路径默认放行。
  const rest = path.slice(PREFIX.length) || '/'
  const routes = { method, path: rest, payload, session }
  // ⚠️ 交给 `adminRoutes` 的是**去掉 `/admin` 之后**的路径。传整条路径的话，
  //    它的 `parts[0]` 是 `'admin'`，于是每一个分支都落到兜底 404 ——
  //    而 404 看起来像「端点没写」，不像「前缀剥错了」。
  return rest === '/admin' || rest.startsWith('/admin/')
    ? adminRoutes({ ...routes, path: rest.slice('/admin'.length) || '/' })
    : systemRoutes(routes)
}
