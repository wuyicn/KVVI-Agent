/**
 * KVVI 平台服务进程。
 *
 * 归属（PRD §4.6.5）：身份层（会话状态、授权判定）、签名模块、发布通道、
 * 平台库访问、认证端点（登录 / 登出）。**不加载任何插件。**
 *
 * 为什么这样写：本进程刻意**不引入任何 DSH 包**。PRD §9.4.1 要求
 * 「平台服务进程不加载任何插件」是**可核验的启动配置**——若本进程依赖
 * DSH 的 loader，那它就具备了加载插件的能力，「不加载」就降级成了一句纪律；
 * 现在它是**能力缺失**：容器里根本没有 @deepseek-ai/* 包可供加载。
 * 取证见 topology.mjs 与 `GET /topology`。
 *
 * 本文件是阶段一骨架：端点形状已按最终归属就位，业务实现在阶段四/五。
 * 未实现的端点一律返回 501 并写明归属阶段 —— 不用空 200 冒充已实现。
 */
import { createServer } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { timingSafeEqual } from 'node:crypto'
import { topologySnapshot, SERVICE_ROOT } from './topology.mjs'
import { isOwnedPath, resolveTarget, createProxyHandler, createUpgradeHandler } from './proxy.mjs'
import { isPanelPath, handlePanel } from './panel.mjs'
import { BROWSER_CREDENTIAL_GRACE_MS } from './signing.mjs'
import { GATE_MESSAGES as MESSAGES, SESSION_COOKIE_SKEW_SECONDS, handleGate, gated, isGatePath, sessionCookie, tokenFromCookie } from './gate.mjs'
import { runtimeCookie, runtimeCredentialAvailable, runtimeContextHeaders } from './runtime-auth.mjs'
import { handleAuth } from './auth.mjs'
import { issueBrowserCredential, verifyBrowserCredential, verifyToken, signingKeys } from './identity.mjs'
import { isApiPath, handleApi } from './api-router.mjs'
import { bootstrapRoutes } from './bootstrap.mjs'

const PORT = Number(process.env.KVVI_PLATFORM_PORT ?? 7400)
const HOST = process.env.KVVI_PLATFORM_HOST ?? '0.0.0.0'

/**
 * 进程间调用鉴别所需的凭据。
 *
 * PRD §4.6.5 部署基线要求「两进程间接口**有调用方鉴别**」。此处用 bearer 令牌
 * 满足该条的形状，但**它不满足 §9.4.1 对签名的要求**——那条要求非对称签名、
 * 私钥仅存于本进程。本令牌只用于**非签名**的内部接口；签名接口在阶段五实现，
 * 且不得复用本令牌。混用会让「私钥仅存于签名进程」这条失去意义。
 */
const INTERNAL_TOKEN = process.env.KVVI_INTERNAL_TOKEN ?? ''

/** 签名私钥的存在性。私钥**不进镜像**（PRD §9.4.1）。 */
const SIGNING_KEY_PATH = process.env.KVVI_SIGNING_KEY_PATH ?? '/run/kvvi-secrets/signing.key'

/**
 * 签名密钥是否**可用**（而不只是存在）。
 *
 * ⚠️ 这条检查是被一次真实崩溃逼出来的：安装器写了一个格式不对的密钥文件，
 * `existsSync` 回 `true`，healthz 一片绿 —— 然后第一次登录让整个平台进程
 * 崩在 `JSON.parse` 上。**一个只回答「文件在不在」的健康检查，
 * 会把配置错误伪装成健康。**
 * @returns 能装载时为 true
 */
function signingKeyUsable() {
  if (!existsSync(SIGNING_KEY_PATH)) return false
  try {
    signingKeys()
    return true
  } catch {
    // 载入失败的原因（缺字段、不是 JSON、PEM 坏了）对探针是同一件事：
    // 这个实例现在签不出令牌。
    return false
  }
}

/** 每个端点的归属阶段：未实现的端点返回 501 而不是假成功。 */
const PENDING = {
  '/registry/publish': '阶段五（发布通道）',
  '/registry/plugins': '阶段五（插件批准记录查询）',
}

/**
 * **用户**认证端点：不要求进程间令牌。
 *
 * ⚠️ `KVVI_INTERNAL_TOKEN` 是**进程间**调用凭据，不是用户凭据。
 * 拿它去拦浏览器请求是语义错误 —— 浏览器当然没有这个令牌，
 * 于是登录永远 401，而看起来像是「认证坏了」。这个坑本项目已经踩过一次
 * （见 proxy 路由顺序那段注释），所以这里显式列出来。
 *
 * 这些端点各自有自己的鉴权：登录凭账号口令，登出与会话查询凭委派令牌。
 */
const USER_AUTH_PATHS = new Set(['/auth/login', '/auth/logout', '/auth/session'])

/**
 * 一次性首次初始化的令牌。安装时生成，写在配置文件（0600）里。
 * 缺省为空 —— 空令牌在 `bootstrapOwner` 里一律**拒绝**，不是放行。
 */
const BOOTSTRAP_TOKEN = process.env.KVVI_BOOTSTRAP_TOKEN ?? ''

/**
 * **公开**的签名侧端点：公钥不是秘密，业务系统要拿它配置信任锚点（§9.4.1）。
 * 需要鉴权的签名端点（签发 / 轮换）不在这里 —— 它们走下面的受控接口段。
 */
const PUBLIC_SIGN_PATHS = new Set(['/sign/keys'])

/** 管理员/平台内部端点：要求进程间令牌（真实管理员角色归阶段五授权服务）。 */
const INTERNAL_AUTH_PATHS = [
  '/auth/sessions/reap',
  '/auth/roles/grant',
  /^\/auth\/accounts\/[0-9a-fA-F-]{36}\/suspend$/u,
  /^\/auth\/sessions\/[0-9a-fA-F-]{36}\/revoke$/u,
]

function needsInternalToken(path) {
  return INTERNAL_AUTH_PATHS.some((p) => (typeof p === 'string' ? p === path : p.test(path)))
}

const startedAt = Date.now()

/**
 * 运行时进程的地址。**这是唯一的对外入口**：浏览器只与本进程对话，
 * 运行时进程只在容器网络内可达（PRD §4.6.5 的请求分流）。
 */
const RUNTIME_TARGET = resolveTarget(process.env.KVVI_RUNTIME_URL)

/** 非本进程路径一律转发给运行时进程。 */
// 运行时栅栏要的 Cookie 由本进程按运行时的格式注入 —— 见 runtime-auth.mjs
// 对「这不是绕过检查」的说明。
/**
 * 同一个请求上一次校验的结果。
 *
 * `/api/*` 在进门前已经验过一次凭据（为了在没通过时能回**带具体错误码的
 * 401 JSON**，而不是让门把它 303 到登录页 HTML）；转发那一步要用同一个结论。
 * 用 `WeakMap` 而不是往 `req` 上挂字段：请求对象是别人传进来的，
 * 往上写自己的字段会让「谁动了这个对象」变成一个查不清的问题。
 */
const VALIDATED = new WeakMap()

async function trustedRuntimeContext(req) {
  const cached = VALIDATED.get(req)
  if (cached !== undefined) {
    return cached.ctx === null ? undefined : runtimeContextHeaders(cached.ctx)
  }
  const raw = tokenFromCookie(req.headers.cookie)
  if (raw === undefined) return undefined
  // ⚠️ **这里曾经验的是业务令牌**（`verifyToken`）—— 于是整个界面
  //    在登录 5 分钟后一起失效：`/api/*` 拿不到上下文，代理回 401，
  //    浏览器显示「重新连接中…」，而面板把原始错误码当文案显示出来。
  //
  //    浏览器带来的那张 Cookie 是**会话凭据**，不是业务令牌：
  //    它证明「这是哪一次会话」，业务令牌是平台按需从会话签出来的。
  //    两者的寿命、撤销权威、能换出什么都不同 —— 见 signing.mjs 的说明。
  const outcome = await verifyBrowserCredential(raw)
  return outcome.ctx === null ? undefined : runtimeContextHeaders(outcome.ctx)
}

const proxyHandler = createProxyHandler(RUNTIME_TARGET, runtimeCookie, trustedRuntimeContext)

/** 常量时间比较，避免按字符早退泄漏令牌长度。 */
function tokenMatches(presented) {
  if (INTERNAL_TOKEN === '') return false
  const a = Buffer.from(presented ?? '')
  const b = Buffer.from(INTERNAL_TOKEN)
  return a.length === b.length && timingSafeEqual(a, b)
}

function send(res, status, body, extraHeaders = {}) {
  // ⚠️ **字符串原样送出，不做 JSON 序列化。**
  //
  // 本函数此前无条件 `JSON.stringify(body)`。对 HTML 页面来说那不是「格式化」，
  // 而是**把整份文档变成一行 JSON 字符串**：引号前多出反斜杠、换行变成字面
  // `\n`，浏览器把它当纯文本渲染 —— 页面全白，什么都点不动。
  //
  // 这个 bug 能活下来，是因为它的**表面症状全部正常**：
  // HTTP 200、`content-type: text/html`、响应体非空、
  // 连 `grep "<title>"` 都命中（标题就在那串字符串里）。
  // 只有真正解析 DOM 才看得出来 —— **「curl 说 200」不等于「页面能用」**。
  //
  // 判据：字符串 = 已经序列化好的内容（HTML）；对象 = 交给 JSON。
  const asText = typeof body === 'string'
  const payload = asText ? body : `${JSON.stringify(body, null, 2)}\n`
  res.writeHead(status, {
    'content-type': asText
      ? 'text/plain; charset=utf-8'
      : 'application/json; charset=utf-8',
    'x-kvvi-process': 'platform-service',
    'x-kvvi-plugins-loaded': String(topologySnapshot().pluginsLoaded),
    ...extraHeaders,
  })
  res.end(payload)
}

async function readBody(req, limit = 64 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) return null
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const path = url.pathname
  const method = req.method ?? 'GET'

  // 健康检查：不鉴别调用方。它必须能被编排层（compose healthcheck）无凭据探测，
  // 否则容器会因为「探针没有令牌」而被判不健康 —— 那是自锁。
  if (path === '/healthz' && method === 'GET') {
    const snap = topologySnapshot()
    return send(res, 200, {
      ok: true,
      process: snap.process,
      role: snap.role,
      pluginsLoaded: snap.pluginsLoaded,
      // 健康检查刻意只报结论与最关键的一条证据，完整证据在 /topology。
      dshPackagesPresent: snap.evidence.dshPackagesPresent,
      // ⚠️ **不能只判文件在不在。** 第一版就是 `existsSync` —— 于是一个格式错误的
      //    密钥文件让 healthz 一直回 `true`，而平台在**第一次登录时整个进程崩掉**。
      //    健全性检查必须回答「它能不能用」，不是「它在不在」。
      signingKeyMounted: signingKeyUsable(),
      // 运行时凭据是否可用。**必须暴露**：不可用时界面打不开，
      // 而那条报错来自运行时（「dsh web authentication required」），
      // 看不出缺的是本进程这里的挂载。
      runtimeCredentialInjected: runtimeCredentialAvailable(),
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    })
  }

  // 取证端点：同样不鉴别。它不含任何凭据，只是本进程的自我描述，
  // 而锚点⑥ 的取证必须能在**无凭据**的情况下由外部复核 —— 需要凭据才能取证的
  // 「可核验」是自相矛盾的。
  if (path === '/topology' && method === 'GET') {
    return send(res, 200, topologySnapshot())
  }

  // ── 首次初始化（阶段十一）──────────────────────────────────────────
  //
  // 必须排在登录门**之前**：装完之后客户还没有账号，登录门会把他挡在
  // 「登录页」上，而那时他连账号都没有 —— 会卡成一个死循环。
  //
  // 它自己带两道闸：一次性令牌，以及「只成功一次」的唯一约束。
  // 端点本身不鉴权，所以**不能**顺手把公司 id 或账号 id 回显出去。
  if (path === '/bootstrap/state' && method === 'GET') {
    const out = await bootstrapRoutes({ method, path, body: null,
      expectedToken: BOOTSTRAP_TOKEN })
    return send(res, out.status, out.body)
  }
  if (path === '/bootstrap/owner' && method === 'POST') {
    const raw = await readBody(req)
    let body = null
    try { body = raw ? JSON.parse(raw) : null } catch {
      return send(res, 400, { error: 'KVVI_BAD_JSON' })
    }
    const out = await bootstrapRoutes({ method, path, body, expectedToken: BOOTSTRAP_TOKEN })
    return send(res, out.status, out.body)
  }

  // ── KVVI 业务面板的数据端点 ────────────────────────────────────────
  //
  // 必须排在 Web UI 转发**之前**：`/kvvi/panel` 是本进程自己的接口，
  // 转发给运行时会得到 404 —— 而那条 404 在界面上的表现是
  // 「连不上平台服务」，与真正的原因（拓扑配错）差得很远。
  //
  // 也排在进程间令牌鉴别之前：它认的是**用户**令牌（会话凭据），
  // 不是进程间凭据。用后者拦它，浏览器永远读不到自己的业务上下文。
  // `/kvvi/login` 与 `/kvvi/logout` 归登录门（下面那一段），不归面板数据端点：
  // 两个模块都认 `/kvvi/` 前缀，**顺序错了就会让登录页返回「面板端点不存在」**。
  // 判据由模块自己给出，不在这里重复前缀字符串。
  if (isPanelPath(path) && !isGatePath(path)) {
    const out = await handlePanel({
      method, path, headers: req.headers,
      // ★ 复用认证模块自己的会话端点，**不另算一遍**网关与能力：
      //   两份实现的漂移方向恰好是「界面多出能力」。
      loadSession: (token) => handleAuth({
        method: 'GET', path: '/auth/session', body: null,
        headers: { ...req.headers, authorization: 'Bearer ' + token },
      }),
    })
    if (out !== null) return send(res, out.status, out.body)
  }

  // ── 产品 API（`/api/v1/*`）─────────────────────────────────────────
  //
  // 必须排在登录门**与** Web UI 转发之前：
  //   - 排在转发之前：`/api` 是运行时的 prefix 路由，晚一步就被它接走了；
  //   - 排在登录门之前：登录门对未登录请求回 **303 到登录页**，
  //     而 API 调用方要的是 **401**（它不会去跟一个重定向）。
  //     两者语义不同，不能共用一个「未鉴权」分支。
  if (isApiPath(path)) {
    const out = await handleApi({
      method, path, query: req.url ?? '', body: await readBody(req),
      headers: req.headers,
      // ★ 复用认证模块自己的会话端点，不另算一遍身份
      loadSession: (token) => handleAuth({
        method: 'GET', path: '/auth/session', body: null,
        headers: { ...req.headers, authorization: 'Bearer ' + token },
        omitOtherGateway: true,
      }),
    })
    if (out !== null) return send(res, out.status, out.body)
  }

  // ── KVVI 登录门 ────────────────────────────────────────────────────
  //
  // 排在 Web UI 转发**之前**：没登录就不该看到 Agent 界面。
  // 也排在进程间令牌鉴别之前 —— 它认的是**用户**凭据（Cookie 里的会话令牌），
  // 不是进程间凭据。
  //
  // 认证逻辑一行都不在这里：登录提交转发给身份层的 `/auth/login`，
  // 令牌校验转发给 `/auth/session`。这里只做「放行 / 打回登录页」。
  // ── `/api/*` 未通过时回 401 JSON，**不回登录页** ──────────────────────
  //
  // `gated()` 把 `/api/*` 判成要过门，而门在没会话时回 **303 到 `/kvvi/login`**。
  // 那条重定向对「人打开一个页面」是对的，对「运行时的 RPC」是灾难：
  // `fetch` 会默默跟随，客户端拿到的是**登录页的 HTML**，
  // `JSON.parse` 当场炸，报出来的是 `Unexpected token '<', "<!DOCTYPE "…` ——
  // 一句和真正原因（会话没了）毫无关系的话。
  //
  // 仓库里其实早就写下了正确的判据（`gate.mjs` 的 `ALLOW_BEFORE_LOGIN` 注释：
  // 「面板数据端点自己会判令牌，返回 **401** 而不是重定向」；
  // `server.mjs` 那句「API 调用方要的是 401，它不会去跟一个重定向」）——
  // 只是 `/api/*` 这条最主要的 RPC 通道漏在外面。
  if (path.startsWith('/api/')) {
    const outcome = await verifyBrowserCredential(tokenFromCookie(req.headers.cookie) ?? '',
      { graceMs: BROWSER_CREDENTIAL_GRACE_MS })
    if (outcome.ctx === null) {
      return send(res, 401, {
        type: 'server-response', rpcId: null,
        result: { ok: false, error: { code: outcome.code,
          message: MESSAGES[outcome.code] ?? outcome.code, relogin: true } },
      })
    }
    // ⚠️ **过期的会话凭据在宽限期内被接受时，顺手换一张新的。**
    //
    // 这就是「受控自动续发」在浏览器这条路里的实现：用户睡了两个小时回来，
    // 凭据早过期了、会话还在 —— 第一个请求就把它换新，界面**不会闪断**，
    // 也不需要客户端知道「过期」这件事。而宽限期一过、或者会话被结束、
    // 授权版本变了，上面那行 401 立刻接管。
    if (outcome.expired === true) {
      const renewed = await issueBrowserCredential(outcome.ctx.sessionId)
      res.setHeader('set-cookie', sessionCookie(renewed.credential,
        Math.max(0, renewed.expiresAt - Math.floor(Date.now() / 1000) + SESSION_COOKIE_SKEW_SECONDS),
        renewed.expiresAt))
    }
    // 一次请求只验一次：转发那一步复用这个结果，不再查一遍库。
    VALIDATED.set(req, outcome)
  }

  if (gated(path) || path.startsWith('/kvvi/')) {
    // ⚠️ **只有登录门自己要看体的那几个路径才读体。**
    //
    // `readBody(req)` 会把请求流**读干**。而这道门对绝大多数被它盯上的路径
    // 只做「有没有会话」的判定，读完就 `return null` 落回下面的转发 ——
    // 于是转发拿到的是一个**已经结束的流**，请求头里却仍带着原来的
    // `content-length`。上游等一个永远不会到来的请求体，请求就**挂住不返回**。
    //
    // 实测的表现极具误导性：
    //   - `GET /`、`GET /healthz`、`GET /assets/*` 全部正常，页面 **HTTP 200**；
    //   - `POST /api/*`（运行时的每一条 RPC，也就是整个界面的数据来源）**全部挂死**，
    //     浏览器界面显示「重新连接中…」，输入框不可用；
    //   - 绕过平台**直接打开运行时进程**（7401），界面一切正常。
    // 「一半可用」比整条不通难查得多 —— 因为它同时给出「服务是好的」这个答案。
    //
    // 判据用 `isGatePath`：只有它认的路径（登录、登出）需要请求体，其余不读。
    const rawBody = isGatePath(path) ? await readBody(req) : null
    const out = await handleGate({
      method, path, query: req.url ?? '', body: rawBody, headers: req.headers,
      login: async (credentials) => handleAuth({
        method: 'POST', path: '/auth/login', body: credentials, headers: req.headers,
      }),
      verify: async (token) => {
        const r = await handleAuth({
          method: 'GET', path: '/auth/session', body: null,
          headers: { ...req.headers, authorization: 'Bearer ' + token },
        })
        return r?.status === 200
      },
      verify: async (token) => {
        const r = await handleAuth({
          method: 'GET', path: '/auth/session', body: null,
          headers: { ...req.headers, authorization: 'Bearer ' + token },
        })
        if (r?.status === 200) return { ok: true }
        // 把**为什么**带出去：门据此在登录页地址上带 `?error=`，
        // 客户看到的是一句人话，而不是一个没有任何说明的登录页。
        return { ok: false, code: r?.body?.error ?? 'KVVI_SESSION_UNKNOWN' }
      },
      // 未初始化时，门把客户送到 `/kvvi/bootstrap` —— 那里才有他能做的那件事。
      // 判据只有一处：`bootstrapState()`（`instance_bootstrap` 那行在不在）。
      bootstrapPending: async () => !(await bootstrapRoutes({
        method: 'GET', path: '/bootstrap/state', body: null, expectedToken: BOOTSTRAP_TOKEN,
      })).body.completed,
    })
    if (out !== null) {
      if (out.html !== undefined) return send(res, out.status, out.html, out.headers ?? {})
      if (out.body !== undefined) return send(res, out.status, out.body, out.headers ?? {})
      return send(res, out.status, '', out.headers ?? {})
    }
  }

  // ── Web UI 转发必须排在鉴别之前 ────────────────────────────────────
  //
  // KVVI_INTERNAL_TOKEN 是**进程间**调用凭据，不是用户凭据。用它去拦 Web UI
  // 流量是语义错误：浏览器当然没有这个令牌，于是每个页面请求都被 401 挡住，
  // 表现为「代理不工作」，而代理本身是好的。
  //
  // 用户身份由阶段四的账号体系负责，与此令牌无关。故非本进程路径一律先转发。
  if (!isOwnedPath(path)) {
    return proxyHandler(req, res)
  }

  // ── 公开的签名端点：公钥分发（§9.4.1 信任锚点）────────────────────
  if (PUBLIC_SIGN_PATHS.has(path)) {
    const out = await handleAuth({ method, path, body: null, headers: req.headers })
    if (out === null) return send(res, 405, { ok: false, error: 'method_not_allowed', path })
    return send(res, out.status, out.body)
  }

  // ── 用户认证端点：不走进程间令牌，走自己的凭据 ────────────────────
  if (USER_AUTH_PATHS.has(path)) {
    const raw = await readBody(req)
    let body = null
    if (raw) {
      try { body = JSON.parse(raw) } catch { body = null }
      if (body === null) {
        return send(res, 400, { ok: false, error: 'KVVI_BAD_JSON' })
      }
    }
    const out = await handleAuth({ method, path, body, headers: req.headers })
    if (out === null) return send(res, 405, { ok: false, error: 'method_not_allowed', path })
    return send(res, out.status, out.body)
  }

  // 以下端点属于受控接口，需要调用方鉴别。
  if (!tokenMatches((req.headers.authorization ?? '').replace(/^Bearer\s+/iu, ''))) {
    return send(res, 401, {
      ok: false,
      error: 'unauthorized',
      detail: '受控接口需要调用方鉴别（PRD §4.6.5 部署基线）。',
    }, { 'www-authenticate': 'Bearer' })
  }

  // ── 会话生命周期事件的管理入口 + 需要鉴权的签名端点 ──────────────
  if (needsInternalToken(path) || path.startsWith('/sign/')) {
    const raw = await readBody(req)
    let body = null
    if (raw) { try { body = JSON.parse(raw) } catch { body = null } }
    const out = await handleAuth({ method, path, body, headers: req.headers })
    if (out === null) return send(res, 405, { ok: false, error: 'method_not_allowed', path })
    return send(res, out.status, out.body)
  }

  if (path in PENDING) {
    await readBody(req)
    return send(res, 501, {
      ok: false,
      error: 'not_implemented',
      endpoint: path,
      ownedBy: PENDING[path],
      detail: '阶段一骨架：端点形状已按归属就位，实现随所属阶段交付。',
    })
  }

  return send(res, 404, { ok: false, error: 'not_found', path })
})

server.on('upgrade', createUpgradeHandler(RUNTIME_TARGET, runtimeCookie, trustedRuntimeContext))

server.listen(PORT, HOST, () => {
  const snap = topologySnapshot()
  // 启动即打印机器可读的取证事实：锚点⑥ 的判据是「启动配置」，
  // 所以事实必须在**启动时**可见，而不是事后被问出来。
  console.log(JSON.stringify({
    event: 'platform-service-up',
    listen: `${HOST}:${PORT}`,
    serviceRoot: SERVICE_ROOT,
    pluginsLoaded: snap.pluginsLoaded,
    dshPackagesPresent: snap.evidence.dshPackagesPresent,
    declaredDependencies: snap.evidence.declaredDependencies,
    signingKeyMounted: existsSync(SIGNING_KEY_PATH),
    proxiesTo: RUNTIME_TARGET.host,
  }))
})

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(JSON.stringify({ event: 'platform-service-down', signal }))
    server.close(() => process.exit(0))
  })
}
