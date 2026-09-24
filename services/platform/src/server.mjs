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
import { handleAuth } from './auth.mjs'

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
 * **公开**的签名侧端点：公钥不是秘密，业务系统要拿它配置信任锚点（§9.4.1）。
 * 需要鉴权的签名端点（签发 / 轮换）不在这里 —— 它们走下面的受控接口段。
 */
const PUBLIC_SIGN_PATHS = new Set(['/sign/keys'])

/** 管理员/平台内部端点：要求进程间令牌（真实管理员角色归阶段五授权服务）。 */
const INTERNAL_AUTH_PATHS = [
  '/auth/sessions/reap',
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
const proxyHandler = createProxyHandler(RUNTIME_TARGET)

/** 常量时间比较，避免按字符早退泄漏令牌长度。 */
function tokenMatches(presented) {
  if (INTERNAL_TOKEN === '') return false
  const a = Buffer.from(presented ?? '')
  const b = Buffer.from(INTERNAL_TOKEN)
  return a.length === b.length && timingSafeEqual(a, b)
}

function send(res, status, body, extraHeaders = {}) {
  const payload = `${JSON.stringify(body, null, 2)}\n`
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
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
      signingKeyMounted: existsSync(SIGNING_KEY_PATH),
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    })
  }

  // 取证端点：同样不鉴别。它不含任何凭据，只是本进程的自我描述，
  // 而锚点⑥ 的取证必须能在**无凭据**的情况下由外部复核 —— 需要凭据才能取证的
  // 「可核验」是自相矛盾的。
  if (path === '/topology' && method === 'GET') {
    return send(res, 200, topologySnapshot())
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

server.on('upgrade', createUpgradeHandler(RUNTIME_TARGET))

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
