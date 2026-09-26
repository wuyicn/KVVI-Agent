/**
 * 平台服务进程的反向代理：把它作为 Web UI 的唯一对外入口。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────────
 *
 * PRD §4.6.5 要求 Web 端请求**按类型分流**：认证请求直达平台服务进程，
 * Agent 对话与 Skill 执行到运行时进程，且「不经运行时进程」这条在架构上
 * 靠该分流实现。若运行时进程直接对外，插件就与认证流量同处一个可嗅探面。
 *
 * 所以对外只有一个门（本进程），运行时进程只在容器网络内可达。
 *
 * ── Host 头必须改写 ──────────────────────────────────────────────────────
 *
 * 运行时进程的 `/api` 有一道 browser-trust fence，按 Host 判定请求是否可信
 * （`packages/client/connection/src/api-request-trust.ts`）。若原样透传浏览器
 * 的 Host（例如 `localhost:7400`），fence 会拒绝每一个请求 —— 表现为接口
 * 全 401/403，而服务其实是好的。故转发时把 Host 改写为**目标地址**，
 * 该地址由运行时进程在绑定时计入自己的 trustedHosts（见其 `resolveLanTrust`）。
 *
 * ── 本代理不做什么 ──────────────────────────────────────────────────────
 *
 * **它不是认证层**。TLS、身份、授权都在别处：前者归部署，后者归阶段四与阶段五。
 * 本文件的职责只有转发与失败处理。
 */
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

/** 转发目标的默认值：compose 网络里的服务名，不是宿主机地址。 */
const DEFAULT_TARGET = 'http://runtime:7401'

/** 连接与响应超时。上限取一个明确值，不用无限等待掩盖对端失联。 */
const UPSTREAM_TIMEOUT_MS = 30_000

/**
 * 由本进程自己处理的路径前缀；其余全部转发。
 *
 * ⚠️ `/kvvi/` **必须在这里**。它是业务面板的数据端点，而面板界面由运行时
 * 提供 —— 浏览器从「加载界面的那个 origin」发相对路径请求，那个 origin 就是
 * 本进程。少了这一条，`/kvvi/panel` 会被转发给运行时并回 404，
 * 而症状看起来像「面板连不上平台服务」。
 */
const OWNED_PREFIXES = ['/healthz', '/topology', '/auth/', '/sign/', '/registry/', '/kvvi/',
                        // 产品 API（阶段九）。**必须比运行时的 `/api` 更具体** ——
                        // 运行时的 RPC 通道注册为 `prefix /api`，若不在这里认领，
                        // `/api/v1/*` 会被转发给它并回 404（实测如此）。
                        // 运行时对 `/api/v1` 的响应一直是 404，所以认领不改变它的行为。
                        '/api/v1/']

/**
 * 该路径是否属于本进程。
 * @param pathname - 请求路径。
 * @returns 属于本进程时为 true。
 */
export function isOwnedPath(pathname) {
  return OWNED_PREFIXES.some((p) => pathname === p || pathname.startsWith(p))
}

/**
 * 解析转发目标。
 * @param raw - `KVVI_RUNTIME_URL` 的值。
 * @returns 解析后的 URL；非法时回退到默认值并记录原因。
 */
export function resolveTarget(raw) {
  if (!raw) return new URL(DEFAULT_TARGET)
  try {
    return new URL(raw)
  } catch {
    // 静默回退会让「配了个错地址」表现为「代理到别处」，比直接失败难查。
    console.error(JSON.stringify({
      event: 'proxy-target-invalid', raw, fallback: DEFAULT_TARGET,
    }))
    return new URL(DEFAULT_TARGET)
  }
}

/**
 * 把 Host 头改写为目标地址。
 *
 * 必须改写，理由见文件头。同时删掉 `content-length` 让 node 重新计算 ——
 * 保留原值会在转发体长度不同时挂起连接。
 * @param headers - 原始请求头。
 * @param target - 转发目标。
 * @returns 转发用请求头。
 */
export function forwardHeaders(headers, target, extraCookie, trustedContext = {}) {
  const out = Object.fromEntries(Object.entries(headers)
    .filter(([name]) => !name.toLowerCase().startsWith('x-kvvi-')))
  out.host = target.host
  out['x-forwarded-host'] = headers.host ?? ''
  out['x-forwarded-proto'] = 'http'
  // ⚠️ **换掉浏览器的 Cookie，不是叠加**。
  //
  // 浏览器那份是 KVVI 自己的会话 Cookie，运行时既不认识它、也不该看到它；
  // 而运行时要的那张（authority = 转发目标）浏览器根本不可能有。
  // 两份混在一起发，运行时会看到一个既陌生又不完整的 Cookie 集合。
  if (extraCookie !== undefined) out.cookie = extraCookie
  else delete out.cookie
  Object.assign(out, trustedContext)
  return out
}

/**
 * 创建 HTTP 转发处理器。
 * @param target - 转发目标 URL。
 * @returns node:http 的请求处理器。
 */
export function createProxyHandler(target, credential, contextProvider) {
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest

  // ⚠️ **每个请求取一次，不在启动时取一次。**
  //
  // 第一版写的是 `const upstreamCookie = credential?.(target.host)`，注释说
  // 「它是通道凭据，不随人变化」—— 那句是对的，但它答的不是这里的问题。
  // 真正的问题是**凭据文件什么时候出现**：运行时在**它自己第一次启动**时才写下
  // `.credentials.yaml`，而平台**先于运行时启动**。于是全新安装上：
  //
  //   启动平台（此刻没有凭据文件）→ 缓存 undefined → 启动运行时（写出凭据）
  //   → 平台此后每一个请求都**不带那张 Cookie** → 界面回
  //     `dsh web authentication required`
  //
  // 而 healthz 每次请求都重读文件，所以它一直说 `runtimeCredentialInjected: true`——
  // **同一个问题，两个答案。** 那个不一致让这个缺陷在开发机上看不出来
  // （运行时跑过一次，文件就在了），却在每一台新机器上必现。
  //
  // 重新签一次的开销是一次读文件加一次 HMAC，与「界面上不去」不成比例。
  const credentialFor = () => credential?.(target.host)

  return async (req, res) => {
    const trustedContext = contextProvider === undefined
      ? {} : await contextProvider(req)
    if (trustedContext === undefined) {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
      res.end('{"ok":false,"error":"KVVI_INVALID_SESSION"}\n')
      return
    }
    const upstream = send({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: req.url,
      method: req.method,
      headers: forwardHeaders(req.headers, target, credentialFor(), trustedContext),
    }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers)
      // pipe 同时覆盖普通响应与 SSE 长连接：两者都是同一个流。
      up.pipe(res)
    })

    upstream.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
      upstream.destroy(new Error('upstream timeout'))
    })
    upstream.on('error', (err) => {
      // 目标不可达时给出可诊断的响应，而不是静默断开 —— 静默断开会被
      // 浏览器读成「网络错误」，与「后端没起来」混为一谈。
      if (res.headersSent) {
        res.destroy()
        return
      }
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({
        ok: false,
        error: 'upstream_unreachable',
        target: target.host,
        detail: String(err?.message ?? err),
      }, null, 2) + '\n')
    })

    req.pipe(upstream)
  }
}

/**
 * 把 WebSocket 升级转发到目标。
 *
 * 单独处理是因为 upgrade 不走普通请求处理器：socket 在握手阶段就交给目的地，
 * 之后是双向裸流，没有 HTTP 语义可用。不处理它会让 WebSocket 静默失败，
 * 而 REST 一切正常 —— 这种「一半可用」最难定位。
 * @param target - 转发目标 URL。
 * @returns node:http 的 upgrade 处理器。
 */
export function createUpgradeHandler(target, credential, contextProvider) {
  const port = target.port || (target.protocol === 'https:' ? 443 : 80)
  // WebSocket 也要带同一张凭据：升级握手同样过运行时的栅栏，
  // 少了它 REST 一切正常而实时通道静默失败 —— 那种「一半可用」最难定位。
  //
  // 与 HTTP 那条路一样**按需取**，理由见 `createProxyHandler` ——
  // 「启动时取一次」在全新安装上会拿到 undefined，而这个进程再也不会有第二次机会。

  return async (req, clientSocket, head) => {
    const trustedContext = contextProvider === undefined
      ? {} : await contextProvider(req)
    if (trustedContext === undefined) {
      clientSocket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      return
    }
    const upstream = httpRequest({
      hostname: target.hostname,
      port,
      path: req.url,
      method: req.method,
      headers: forwardHeaders(req.headers, target, credential?.(target.host), trustedContext),
    })

    upstream.on('upgrade', (upRes, upSocket, upHead) => {
      const lines = [`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage ?? ''}`]
      for (let i = 0; i < upRes.rawHeaders.length; i += 2) {
        lines.push(`${upRes.rawHeaders[i]}: ${upRes.rawHeaders[i + 1]}`)
      }
      clientSocket.write(lines.join('\r\n') + '\r\n\r\n')
      if (upHead?.length) upSocket.unshift(upHead)
      if (head?.length) upSocket.write(head)
      upSocket.pipe(clientSocket).pipe(upSocket)
    })

    upstream.on('error', () => clientSocket.destroy())
    upstream.end()
  }
}
