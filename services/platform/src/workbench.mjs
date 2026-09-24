/**
 * KVVI **工作台**（Workbench）—— 员工侧的入口，由平台服务进程亲自提供。
 *
 * ── 为什么它必须由平台进程提供 ────────────────────────────────────────────
 *
 * §2.6.1：**模式由入口决定，不做会话内切换**。
 * 搭建舱（Builder Console）与工作台（Workbench）是两个入口，
 * 各自进入一种模式 —— 那么「哪个入口」这件事就不能由前端商量，
 * 必须是一个**服务端事实**。
 *
 * 平台进程是唯一对外入口（§4.6.5），而它也正是**唯一知道 `gateway` 的进程**：
 * 会话在创建时绑定网关（`createSession({ gateway })`），登录响应里带 `gateway`。
 * 所以工作台挂在这里，客户端就没有机会声称自己是另一种模式。
 *
 * ── 它与 DSH 壳的关系 ────────────────────────────────────────────────────
 *
 * 这一层**不替代** DSH 的对话壳（§7.3 决定复用），它补的是 PRD §2.3 里
 * 那句「DSH 没有多用户和鉴权，界面隔离必须由 KVVI 自建」：
 *
 * | 层 | 谁提供 | 内容 |
 * |---|---|---|
 * | 工作台外壳 | **KVVI 自建（本文件）** | 登录、身份、我能做什么、我的系统 |
 * | 对话区 | DSH 运行时 | 消息流与工具调用（挂 `kvvi-worker` 预设） |
 *
 * ── 界面隔离在这里是**可机器判定的**，不是一句承诺 ──────────────────────
 *
 * `/workbench/api/session` **只返回本网关的工具**，并且**不返回**另一个网关的
 * 工具清单。搭建类工具名（`schema.*`、`plugin.install`）一个都不出现 ——
 * 页面上因此没有任何东西可以渲染成搭建入口。
 *
 * 这与「在 UI 里把搭建按钮藏起来」是两回事：后者藏起来的按钮仍然在响应里。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const UI_FILE = resolve(HERE, '..', 'ui', 'workbench.html')

/** 工作台的路径前缀。`/workbench/_static/*` 由下面的静态分支处理。 */
const PREFIX = '/workbench'

/**
 * 该路径是否属于工作台。
 * @param {string} pathname 请求路径
 * @returns {boolean} 属于工作台时为 true
 */
export function isWorkbenchPath(pathname) {
  return pathname === PREFIX || pathname.startsWith(PREFIX + '/')
}

/**
 * 处理工作台的请求。
 *
 * 分两类：
 * - `GET /workbench`         → 工作台页面（单页，凭据由页面自己去 `/auth` 取）
 * - `GET /workbench/api/session` → 当前会话的**投影**，只含本网关可见的东西
 *
 * ⚠️ 令牌从 `authorization` 头取，**不从 Cookie 取**。
 * 用 Cookie 会让这个端点变成 CSRF 面：一个第三方页面就能让浏览器
 * 带着凭据打到 `/workbench/api/session`。头必须由页面自己的 JS 显式带上，
 * 而跨站脚本无法读走另一个源的令牌。
 *
 * @param {object} input
 * @param {string} input.method 请求方法
 * @param {string} input.path 请求路径（不含查询串）
 * @param {object} input.headers 请求头
 * @param {(token: string) => Promise<{status: number, body: object}|null>} input.loadSession
 *   「用令牌换会话」——由服务器注入，**本模块不自己连库也不自己判网关**。
 *   身份与会话可见性的唯一来源留在 `auth.mjs`：在这里再算一次
 *   `toolsForGateway`，两份实现迟早对不上，而对不上的方向恰好是漏判，
 *   员工界面会多出能力。
 * @returns {Promise<{status: number, body?: object, html?: string}|null>} 不属本模块时返回 null
 */
export async function handleWorkbench({ method, path, headers, loadSession }) {
  if (!isWorkbenchPath(path)) return null

  if (path === PREFIX) {
    if (method !== 'GET' && method !== 'HEAD') {
      return { status: 405, body: { error: 'method_not_allowed' } }
    }
    if (!existsSync(UI_FILE)) {
      // 找不到页面文件时**不要给一个空白页** —— 那会被读成「白屏 bug」。
      return {
        status: 500,
        body: {
          error: 'KVVI_WORKBENCH_UI_MISSING',
          detail: '找不到工作台页面文件：' + UI_FILE,
          hint: '工作台页面与平台服务同镜像发布（services/platform/ui/）。',
        },
      }
    }
    return { status: 200, html: readFileSync(UI_FILE, 'utf8') }
  }

  if (path === PREFIX + '/api/session') {
    if (method !== 'GET') {
      return { status: 405, body: { error: 'method_not_allowed' } }
    }
    const raw = (headers?.authorization ?? '').replace(/^Bearer\s+/iu, '')
    if (!raw) return { status: 401, body: { error: 'KVVI_TOKEN_REQUIRED' } }

    let out
    try {
      out = await loadSession(raw)
    } catch (error) {
      return { status: 503, body: {
        error: 'KVVI_IDENTITY_UNAVAILABLE',
        detail: String(error && error.message ? error.message : error).slice(0, 200),
      } }
    }
    if (!out) return { status: 401, body: { error: 'KVVI_INVALID_TOKEN' } }
    if (out.status !== 200) return out

    // ⚠️ **只投影本网关可见的东西。**
    //
    // 会话端点本来就带着 `toolsOfOtherGateway`（另一个网关的工具清单）。
    // 那是给审计与复核者核对「两个集合不相交」的取证材料，
    // 而工作台的响应会直接渲染进员工浏览器 —— 让界面拿到
    // 「另一个模式有哪些能力」，正是 §2.3 界面隔离要挡的东西。
    //
    // 服务器已经用 `omitOtherGateway` 要了不含那组字段的版本；这里
    // **再显式挑选一遍**，因为「上游哪天忘了传那个开关」不该变成泄露。
    // 挑选而不是展开后删键：将来 ctx 加了新字段，默认是**不出现**。
    const p = out.body
    const capabilities = Array.isArray(p.tools) ? p.tools : []
    return {
      status: 200,
      body: {
        sessionId: p.sessionId,
        userId: p.userId,
        companyId: p.companyId,
        gateway: p.gateway,
        state: p.state,
        createdAt: p.createdAt,
        capabilities,
        // 键名如实说明它被**刻意省略**，免得后来的人以为是漏了。
        otherGatewayCapabilitiesOmitted: true,
      },
    }
  }

  return { status: 404, body: { error: 'KVVI_WORKBENCH_NOT_FOUND', path } }
}
