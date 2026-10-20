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

import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'

/**
 * 运行时写凭据的位置。
 *
 * 容器部署里由 compose 把运行时的数据卷**只读**挂到这里；本机（macOS 试点）
 * 部署没有那个卷，运行时的凭据就在 `$DSH_HOME/.credentials.yaml`。
 *
 * ⚠️ 写成常量会让本机部署**永远注入不了那张 Cookie**，而表现是
 * 「登录成功了，界面却回 401」—— 看起来像会话坏了，其实是找不到凭据文件。
 * 所以位置由环境给出，缺省仍是容器路径（那一边的行为一字不变）。
 */
const CREDENTIALS_PATH = process.env.KVVI_RUNTIME_CREDENTIALS
  ?? '/run/kvvi-runtime-credentials/.credentials.yaml'

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
 * @throws 无（缺凭据时返回 undefined —— 调用方据此如实报告「未注入」）
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

const RUNTIME_CONTEXT_VERSION = 'v1'
export const RUNTIME_CONTEXT_MAX_AGE_MS = 60_000

function contextPayload({ sessionId, userId, companyId, gateway, issuedAt }) {
  return [RUNTIME_CONTEXT_VERSION, sessionId, userId, companyId, gateway,
    String(issuedAt)].join('\n')
}

function singleHeader(headers, name) {
  const value = headers?.[name]
  return typeof value === 'string' ? value : undefined
}

/**
 * 签出平台到运行时的短期身份上下文。浏览器提供的同名头不会参与这里的值。
 */
export function runtimeContextHeaders(ctx, secret = process.env.KVVI_INTERNAL_TOKEN,
  now = Date.now()) {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error('KVVI_RUNTIME_CONTEXT_SECRET_REQUIRED')
  }
  if (!['USER', 'BUILDER'].includes(ctx?.gateway)) {
    throw new Error('KVVI_GATEWAY_INVALID')
  }
  const issuedAt = Number(now)
  const fields = {
    sessionId: String(ctx.sessionId), userId: String(ctx.userId),
    companyId: String(ctx.companyId),
    gateway: ctx.gateway, issuedAt,
  }
  const signature = createHmac('sha256', secret).update(contextPayload(fields)).digest('hex')
  return {
    'x-kvvi-session': fields.sessionId,
    'x-kvvi-user': fields.userId,
    'x-kvvi-company': fields.companyId,
    'x-kvvi-gateway': fields.gateway,
    'x-kvvi-issued-at': String(issuedAt),
    'x-kvvi-signature': signature,
  }
}

/** 测试与诊断用的同格式验签；运行时 fork 使用完全相同的协议。 */
export function verifyRuntimeContextHeaders(headers, secret = process.env.KVVI_INTERNAL_TOKEN,
  now = Date.now()) {
  const sessionId = singleHeader(headers, 'x-kvvi-session')
  const userId = singleHeader(headers, 'x-kvvi-user')
  const companyId = singleHeader(headers, 'x-kvvi-company')
  const gateway = singleHeader(headers, 'x-kvvi-gateway')
  const rawIssuedAt = singleHeader(headers, 'x-kvvi-issued-at')
  const signature = singleHeader(headers, 'x-kvvi-signature')
  if (!sessionId || !userId || !companyId || !gateway || !rawIssuedAt || !signature) {
    throw new Error('KVVI_RUNTIME_CONTEXT_REQUIRED')
  }
  const issuedAt = Number(rawIssuedAt)
  if (!Number.isSafeInteger(issuedAt)
      || Math.abs(Number(now) - issuedAt) > RUNTIME_CONTEXT_MAX_AGE_MS) {
    throw new Error('KVVI_RUNTIME_CONTEXT_EXPIRED')
  }
  if (!['USER', 'BUILDER'].includes(gateway)) throw new Error('KVVI_GATEWAY_INVALID')
  const expected = createHmac('sha256', secret)
    .update(contextPayload({ sessionId, userId, companyId, gateway, issuedAt })).digest()
  const actual = Buffer.from(signature, 'hex')
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error('KVVI_RUNTIME_CONTEXT_INVALID')
  }
  return { sessionId, userId, companyId, gateway, issuedAt }
}
