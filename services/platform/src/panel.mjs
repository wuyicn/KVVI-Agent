/**
 * KVVI 业务面板的**数据端点** —— 由平台服务进程亲自提供。
 *
 * ── 为什么在这里，而不是在 DSH 运行时里 ──────────────────────────────────
 *
 * §2.6.1：模式由入口决定。而平台进程是**唯一知道「这个会话是谁、属于哪个
 * 公司、能做什么」的进程** —— DSH 运行时不知道租户，也不该知道。
 *
 * 更要紧的是一个**同源事实**：面板界面由运行时提供，但那界面是从
 * 「加载它的那个 origin」发请求的，而那个 origin 就是平台服务
 * （平台是唯一对外入口，其余路径转发给运行时）。
 * 所以面板的相对路径 `/kvvi/panel` 一定打到本端点 ——
 * **不需要 CORS，也不存在第二个 origin。**
 *
 * 早先把面板的数据地址写死成另一个端口，于是浏览器跨源、平台不发 CORS 头、
 * 读取直接失败。那不是实现细节问题，是**拓扑搞错了**：
 * 一个产品只有一个入口。
 *
 * ── 这个端点返回什么，以及它刻意不返回什么 ──────────────────────────────
 *
 * 返回**本会话可见的业务上下文**：公司名、账号、本网关能力表。
 * 不返回另一个网关的能力（那组字段是取证材料，见 `auth.mjs` 的
 * `omitOtherGateway`），不返回会话令牌，不返回任何公司的业务数据行。
 *
 * ⚠️ 它**不自己判权限**：能力表来自 `auth.mjs` 的会话端点 ——
 * 网关分类是那里的冻结常量，在这里再算一遍迟早会分叉，
 * 而分叉的方向恰好是「界面多出能力」。
 */

/** 面板数据的路径前缀，与浏览器半的相对路径一致。 */
const PREFIX = '/kvvi'

/**
 * 该路径是否属于业务面板。
 * @param pathname 请求路径
 * @returns 属于面板时为 true
 */
export function isPanelPath(pathname) {
  return pathname === PREFIX || pathname.startsWith(PREFIX + '/')
}

/**
 * 处理面板的数据请求。
 *
 * @param {object} input
 * @param {string} input.method 请求方法
 * @param {string} input.path 请求路径（不含查询串）
 * @param {object} input.headers 请求头
 * @param {(token: string) => Promise<{status: number, body: object}|null>} input.loadSession
 *   「用令牌换会话」——由服务器注入，指向 `auth.mjs` 的会话端点。
 *   令牌从这里走 `authorization` 头，**不走 URL 也不走 Cookie**：
 *   放进 URL 会进日志与 Referer，放进 Cookie 会让本端点变成 CSRF 面。
 * @returns {Promise<{status: number, body: object}|null>} 不属本模块时返回 null
 */
export async function handlePanel({ method, path, headers, loadSession }) {
  if (!isPanelPath(path)) return null

  if (path !== PREFIX + '/panel') {
    return { status: 404, body: { error: 'KVVI_PANEL_NOT_FOUND', path } }
  }
  if (method !== 'GET') {
    return { status: 405, body: { error: 'method_not_allowed' } }
  }

  const token = (headers?.authorization ?? '').replace(/^Bearer\s+/iu, '')
  if (!token) return { status: 401, body: { error: 'KVVI_TOKEN_REQUIRED' } }

  let out
  try {
    out = await loadSession(token)
  } catch (error) {
    return { status: 503, body: {
      error: 'KVVI_IDENTITY_UNAVAILABLE',
      detail: String(error && error.message ? error.message : error).slice(0, 200),
    } }
  }
  if (!out) return { status: 401, body: { error: 'KVVI_INVALID_TOKEN' } }
  if (out.status !== 200) return out

  // ⚠️ **显式挑选字段**，不展开后删键：将来会话上下文加了新字段，
  // 默认是**不出现**，而不是默认泄露到浏览器。
  const p = out.body
  return {
    status: 200,
    body: {
      ok: true,
      login: p.login ?? null,
      companyName: p.companyName ?? null,
      companyId: p.companyId ?? null,
      gateway: p.gateway ?? null,
      capabilities: Array.isArray(p.tools) ? p.tools : [],
      // 四个业务块的数据源状态。**如实标出哪个还没接通** ——
      // 让界面把「没有这一步」渲染成「暂无」，等于告诉员工「你没有待办」。
      sources: {
        pending: { wired: false, reason: '待办口径还没做成端点' },
        systems: { wired: false, reason: '发布通道还没有列出已发布版本的接口' },
        capabilities: { wired: true },
        aggregates: { wired: false, reason: '聚合口径还没有列表接口' },
      },
    },
  }
}
