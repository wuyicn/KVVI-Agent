/**
 * KVVI 登录门 —— 员工进不去就别想看到 Agent 界面。
 *
 * ── 这道门解决什么 ────────────────────────────────────────────────────────
 *
 * 原状：浏览器打 `/?token=…`，运行时用**它自己**的 launch token 换一张 cookie，
 * 之后所有请求靠那张 cookie。`DSH` 的这套机制是给「本机开发者」设计的
 * （token 打在启动日志里），它没有账号、没有公司、没有可撤销的会话。
 *
 * 而 KVVI 有：账号密码、会话绑定公司（§9.9.3）、令牌可撤销、
 * 授权版本变了就失效（§9.4.2）。
 *
 * 所以门换到这上面来：**没登录就没有界面**。
 *
 * ── 为什么门在平台进程，而不是改运行时的鉴权模块 ──────────────────────────
 *
 * 平台是唯一对外入口（§4.6.5），也是唯一知道「你是谁」的进程。
 * 门放在这里有两个好处：
 *   - 一次做完，覆盖**所有**转发的路径 —— 界面、模块、`/api` 全都过同一道；
 *   - 不动 DSH 的 `browser-auth.ts`：那是上游文件，改它会在升级时冲突。
 *
 * 代价写在下面的 `ALLOW_BEFORE_LOGIN`：登录页自己的资源必须放行，
 * 否则连登录表单都加载不出来（鸡生蛋）。
 */

/** 令牌放在这个 Cookie 名里。 */
export const SESSION_COOKIE = 'kvvi-session'

/**
 * 登录前后端就要拿到的东西。
 *
 * ⚠️ **这份名单要尽量短。** 每多放行一条，就是多一条不经验证的通道。
 * 只放登录页自己；界面、模块表、`/api` 一律在门后。
 */
const ALLOW_BEFORE_LOGIN = new Set([
  '/kvvi/login',      // 登录页与登录提交
  '/kvvi/builder/login', // 搭建者登录页与登录提交
  '/kvvi/panel',      // 面板数据端点自己会判令牌，返回 401 而不是重定向
  '/healthz',         // 健康检查：部署与监控要用，且不含任何用户数据
  '/topology',        // 运行期取证：§4.6.5 要求无凭据可复核
])

/**
 * 该路径是否要过 KVVI 登录门。
 *
 * `/kvvi/*` 是平台自己的端点，各自判令牌；其余路径都是运行时的界面与接口。
 * @param pathname 请求路径
 * @returns 需要登录门时为 true
 */
export function gated(pathname) {
  if (ALLOW_BEFORE_LOGIN.has(pathname)) return false
  if (pathname.startsWith('/kvvi/')) return false
  // 平台**自己的**端点各自判凭据，不由这道门管。
  //
  // ⚠️ 这一条不能省。省掉的后果在本仓库真实发生过：门把 `/auth/login`
  // 一起拦向登录页，于是「登录」这个动作永远到不了身份层 ——
  // 表现是登录页反复重定向回自己。**门拦的是界面，不是端点。**
  if (pathname.startsWith('/auth/')) return false
  if (pathname.startsWith('/registry/')) return false
  // 公钥分发：不是秘密，业务系统要拿去配信任锚点（§9.4.1）。
  if (pathname.startsWith('/sign/')) return false
  return true
}

/** 从 `Cookie` 头里取出会话令牌。**只认这一个名字**，不做通用 Cookie 解析。 */
export function tokenFromCookie(headerValue) {
  if (typeof headerValue !== 'string') return undefined
  for (const segment of headerValue.split(';')) {
    const at = segment.indexOf('=')
    if (at === -1 || segment.slice(0, at).trim() !== SESSION_COOKIE) continue
    const value = segment.slice(at + 1).trim()
    return value === '' ? undefined : value
  }
  return undefined
}

/** 组装会话 Cookie。`HttpOnly` 让脚本读不到它，`SameSite=Strict` 挡住跨站发起的请求。 */
export function sessionCookie(value, maxAgeSeconds) {
  return `${SESSION_COOKIE}=${value}; Max-Age=${String(maxAgeSeconds)}; Path=/; HttpOnly; SameSite=Strict`
}

/** 清空会话 Cookie。登出与失效时用同一个形状，避免留半截状态。 */
export function clearedCookie() {
  return `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict`
}

/* ── 登录页 ──────────────────────────────────────────────────────────── */

const esc = (v) => String(v).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

/** 后端错误码 → 人话。判据在服务端，这里只做呈现。 */
const MESSAGES = {
  KVVI_BAD_CREDENTIALS: '账号或口令不对。',
  KVVI_ACCOUNT_NOT_ACTIVE: '账号已停用，请联系管理员。',
  KVVI_NOT_A_MEMBER: '该账号不属于任何公司。',
  KVVI_BAD_GATEWAY: '入口类型不对。',
  KVVI_BUILDER_ACCESS_REQUIRED: '该账号没有此公司的搭建模式权限。',
  KVVI_COMPANY_SELECTION_REQUIRED: '这个账号属于多家公司，请选择本次要进入的公司。',
}

const PAGE_CSS = `
:root{--fg:#111827;--muted:#6b7280;--line:#e5e7eb;--bg:#f5f6f8;--accent:#2f6bff;}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:var(--bg);color:var(--fg);display:flex;
  align-items:center;justify-content:center;padding:24px;
  font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;}
form{width:100%;max-width:380px;background:#fff;border:1px solid var(--line);border-radius:16px;
  padding:32px 30px;box-shadow:0 1px 3px rgba(16,24,40,.06)}
.mark{width:44px;height:44px;border-radius:12px;background:#eef3ff;color:var(--accent);
  display:flex;align-items:center;justify-content:center;font-weight:800;margin-bottom:16px}
h1{margin:0 0 6px;font-size:20px}
.lead{color:var(--muted);font-size:13px;margin-bottom:24px}
label{display:block;font-size:12.5px;color:var(--muted);margin:0 0 6px}
input{width:100%;padding:10px 13px;border:1px solid var(--line);border-radius:10px;
  font:inherit;outline:none;margin-bottom:14px}
input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(47,107,255,.13)}
button{width:100%;padding:11px;border:0;border-radius:10px;background:var(--accent);
  color:#fff;font:inherit;font-weight:600;cursor:pointer}
button:disabled{opacity:.6}
.msg{margin-top:14px;font-size:12.5px;color:#991b1b;min-height:18px}
.pick button{display:block;width:100%;margin-top:8px;text-align:left;background:#fff;color:var(--fg);
  border:1px solid var(--line);font-weight:500}
.foot{margin-top:20px;padding-top:14px;border-top:1px solid #f1f2f4;font-size:11.5px;color:#9ca3af;line-height:1.7}
`

/**
 * 渲染登录页。
 *
 * 页面**自包含**（样式内联、无外部资源）：它必须在**未登录**时就能完整加载，
 * 否则就是鸡生蛋 —— 放行界面资源就等于开了后门，不放行就连表单都看不到。
 * 这一点决定了它不能复用运行时的前端。
 *
 * @param input - `{ message }`：要显示的错误，或空。
 * @returns 完整 HTML。
 */
function loginPage({ message = '', companies = null, gateway = 'USER' } = {}) {
  const builder = gateway === 'BUILDER'
  const action = builder ? '/kvvi/builder/login' : '/kvvi/login'
  const title = builder ? 'KVVI 搭建台' : 'KVVI 工作台'
  const pick = companies === null ? '' : `
    <div class="pick">${companies.map((c) =>
      `<button type="submit" name="companyId" value="${esc(c.companyId)}">${esc(c.name ?? c.companyId)}</button>`).join('')}</div>`
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · 登录</title>
<style>${PAGE_CSS}</style>
</head>
<body>
<form method="post" action="${action}" autocomplete="on">
  <input type="hidden" name="requestedGateway" value="${gateway}">
  <div class="mark">KV</div>
  <h1>${title}</h1>
  <div class="lead">用你的账号登录</div>
  <label for="login">账号</label>
  <input id="login" name="login" type="text" autocomplete="username" required autofocus>
  <label for="password">口令</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required>
  <button type="submit">登录</button>
  ${pick}
  <div class="msg">${esc(message)}</div>
  <div class="foot">KVVI 智能生成式应用搭建平台 V1.0<br>登录后才能使用 Agent。账号由管理员开通。</div>
</form>
</body>
</html>`
}

/* ── 处理 ────────────────────────────────────────────────────────────── */

const OK = (html, headers = {}) => ({
  status: 200,
  html,
  headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers },
})

/**
 * 处理登录门的请求。
 *
 * ⚠️ 返回 `null` 表示**这不是本模块的路径**，调用方继续往下走（转发给运行时）。
 * 返回 `{ redirect }` 表示要人先去登录。
 *
 * @param {object} input
 * @param {string} input.method 请求方法
 * @param {string} input.path 请求路径（不含查询串，除了登录页要读 query）
 * @param {string} input.query 原始查询串（含 `?`）
 * @param {string} input.body 原始请求体（表单提交时用）
 * @param {object} input.headers 请求头
 * @param {(request: object) => Promise<{status: number, body: object}|null>} input.login
 *   转发给身份层的登录端点 —— **不在这里再写一份认证逻辑**。
 * @param {(token: string) => Promise<boolean>} input.verify
 *   令牌是否属于一个有效会话（验签 + 撤销 + 授权版本，都在身份层做）。
 * @returns {Promise<object|null>} 要自己应答时给出 `{status, html?/body?, headers?}`；
 *   否则 `null`。
 */
export async function handleGate({ method, path, query, body, headers, login, verify }) {
  const loginEntry = path === '/kvvi/login' || path === '/kvvi/builder/login'
  const requestedGateway = path === '/kvvi/builder/login' ? 'BUILDER' : 'USER'

  // ① 登录页
  if (loginEntry && method === 'GET') {
    const params = new URLSearchParams(query ?? '')
    const message = params.get('error') ? (MESSAGES[params.get('error')] ?? params.get('error')) : ''
    return OK(loginPage({ message, gateway: requestedGateway }))
  }

  // ② 登录提交
  if (loginEntry && method === 'POST') {
    const form = new URLSearchParams(body ?? '')
    const loginName = form.get('login') ?? ''
    const password = form.get('password') ?? ''
    const companyId = form.get('companyId') ?? undefined
    if (loginName === '' || password === '') {
      return { status: 303, headers: { location: '/kvvi/login?error=KVVI_BAD_CREDENTIALS' } }
    }
    let out
    try {
      out = await login({ login: loginName, password, companyId, requestedGateway })
    } catch (error) {
      return { status: 503, body: {
        error: 'KVVI_IDENTITY_UNAVAILABLE',
        detail: String(error && error.message ? error.message : error).slice(0, 200),
      } }
    }
    if (out?.status === 201 && typeof out.body?.token === 'string') {
      // ⚠️ 令牌**只进 Cookie**，不回显进 body 也不进 URL。
      //    进 URL 会留在浏览器历史、日志与 Referer 里。
      return {
        status: 303,
        headers: {
          location: '/',
          // 一小时的会话窗口。到期后下一次请求会被门拦回登录页 ——
          // 界面上表现为「跳回登录」，而不是「点了没反应」。
          'set-cookie': sessionCookie(out.body.token, 60 * 60),
          'cache-control': 'no-store',
        },
      }
    }
    if (out?.status === 409 && out.body?.error === 'KVVI_COMPANY_SELECTION_REQUIRED') {
      // 多公司账号**必须显式选**：替用户选等于悄悄替他决定了租户（§9.9.3）。
      return OK(loginPage({ message: MESSAGES.KVVI_COMPANY_SELECTION_REQUIRED,
        companies: out.body.companies ?? [], gateway: requestedGateway }))
    }
    const code = out?.body?.error ?? `HTTP ${String(out?.status ?? 0)}`
    return {
      status: 303,
      headers: { location: (requestedGateway === 'BUILDER'
        ? '/kvvi/builder/login' : '/kvvi/login') + '?error=' + encodeURIComponent(code),
      'cache-control': 'no-store' },
    }
  }

  // ③ 登出
  if (path === '/kvvi/logout') {
    return {
      status: 303,
      headers: { location: '/kvvi/login', 'set-cookie': clearedCookie(), 'cache-control': 'no-store' },
    }
  }

  // ④ 门：不在放行名单里的路径都要先证明有有效会话
  if (!gated(path)) return null
  const token = tokenFromCookie(headers?.cookie)
  if (token !== undefined && await verify(token)) return null
  // 没有有效会话 —— 带 Cookie 的先清掉，免得留一个坏 cookie 反复失败。
  return {
    status: 303,
    headers: {
      location: '/kvvi/login',
      'cache-control': 'no-store',
      ...(token === undefined ? {} : { 'set-cookie': clearedCookie() }),
    },
  }
}

/** 供测试直接取错误文案表。 */
export { MESSAGES as GATE_MESSAGES }

/** 平台登录门自己处理的 `/kvvi/*` 路径；其余仍交给业务面板。 */
export function isGatePath(pathname) {
  return pathname === '/kvvi/login' || pathname === '/kvvi/builder/login'
    || pathname === '/kvvi/logout'
}
