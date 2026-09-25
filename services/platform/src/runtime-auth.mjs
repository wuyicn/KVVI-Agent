/**
 * 运行时进程的**会话凭据桥** —— 平台替浏览器带上运行时的 Cookie。
 *
 * ── 为什么需要这一步 ──────────────────────────────────────────────────────
 *
 * 换掉运行时的入口令牌之后，请求会先过 KVVI 登录门；门放行后由平台转发给运行时。
 * 但运行时还有**它自己**的一道栅栏：`browser-auth.ts` 校验一张
 * `dsh-auth-<authority>` Cookie，而 authority 是转发目标（`runtime:7401`）。
 *
 * 浏览器**不可能**持有那张 Cookie：它的 authority 是 `runtime:7401`，
 * 而浏览器只跟 `127.0.0.1:7400` 说话 —— Cookie 名与作用域都对不上。
 * 所以那张 Cookie 只能由**平台**在转发时注入。
 *
 * ── 为什么这不是「绕过一道安全检查」──────────────────────────────────────
 *
 * 那道栅栏要解决的问题是「谁能打开这个 Web 界面」。在 KVVI 的拓扑里，
 * 这个问题的答案已经由 §4.6.5 的架构决定了：**只有平台进程能到达运行时**
 * （运行时不在宿主网络上有端口，只在容器网络内）。平台同时是唯一知道
 * 「你是谁、属于哪个公司、能不能用这个 Agent」的进程。
 *
 * 所以顺序是：
 *   浏览器 → 平台（KVVI 登录门：验账号、公司、会话有效性）
 *          → 运行时（本模块注入的凭据：证明请求来自平台）
 * 前一道门管**人**，后一道管**通道**。这不是把安全检查关掉，
 * 是把它换到本来就在做这件事的那一层。
 *
 * ── 这个模块不做什么 ─────────────────────────────────────────────────────
 *
 * 它**不签**任何东西，也**不持有**运行时的私钥材料之外的东西：
 * 它只是把运行时自己写下的那张凭据读出来、按运行时的格式带上去。
 * 运行时的私钥仍然是运行时生成的、只用于运行时自己的栅栏。
 */

import { createHash, createHmac } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'

/** 运行时写凭据的位置（容器内路径）。 */
const CREDENTIALS_PATH = '/run/kvvi-runtime-credentials/.credentials.yaml'

/**
 * Cookie 载荷版本。与 `browser-auth.ts` 的 `COOKIE_PAYLOAD_VERSION` 一致 ——
 * 不一致时运行时会把 Cookie 判为无效，表现为「界面打不开」。
 */
const COOKIE_PAYLOAD_VERSION = 1

/** 签出的 Cookie 有效期。取一天：它证明的是**通道**，不是人的身份。 */
const COOKIE_TTL_MS = 24 * 60 * 60 * 1000

const b64url = (buf) => Buffer.from(buf).toString('base64')
  .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')

/**
 * 从运行时的凭据文件里读出浏览器会话密钥。
 *
 * 只做**一次最小解析**：找 `secret:` 那一行。用 YAML 库会引入一个只为读一个字段
 * 的依赖，而这个文件的形状由运行时自己保证。
 *
 * @returns 密钥的原始字符串；读不到时 undefined。
 */
function readSessionSecret() {
  if (!existsSync(CREDENTIALS_PATH)) return undefined
  try {
    const text = readFileSync(CREDENTIALS_PATH, 'utf8')
    const match = /client-connection\/browser-session:[\s\S]*?secret:\s*([A-Za-z0-9_-]+)/u.exec(text)
    return match?.[1]
  } catch {
    // 读失败与「文件不存在」在调用方看来是同一件事：没有凭据可用。
    return undefined
  }
}

/**
 * 造一个能过运行时栅栏的 Cookie。
 *
 * 格式与 `browser-auth.ts` 的 `encodeCookie` 一致：
 * `v1.<base64url(JSON 载荷)>.<base64url(HMAC-SHA256(载荷))>`，
 * 且 **Cookie 名是 authority 的 sha256**（不是 authority 原文）——
 * 这一条最容易写错，写错的表现是「凭据存在但运行时仍回 401」。
 *
 * @param authority - 转发目标的 authority（例如 `runtime:7401`）。
 * @returns Cookie 头值；没有可用凭据时 undefined。
 */
export function runtimeCookie(authority) {
  const secret = readSessionSecret()
  if (secret === undefined) return undefined

  const now = Date.now()
  const payload = {
    version: COOKIE_PAYLOAD_VERSION,
    authority,
    issuedAt: now,
    expiresAt: now + COOKIE_TTL_MS,
  }
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'))
  const signature = createHmac('sha256', Buffer.from(secret, 'base64url')).update(body).digest()
  const name = 'dsh-auth-' + b64url(createHash('sha256').update(authority).digest())
  return `${name}=v1.${body}.${b64url(signature)}`
}

/**
 * 本进程是否具备注入能力。
 *
 * 用于启动时如实记录：没有凭据时界面打不开，而那条报错来自运行时
 * （「dsh web authentication required」），看不出缺的是这里的挂载。
 * @returns 能读出密钥时为 true。
 */
export function runtimeCredentialAvailable() {
  return readSessionSecret() !== undefined
}
