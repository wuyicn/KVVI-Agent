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
 * **会话凭据的到期时刻**，放在一张**脚本读得到**的同行 Cookie 里（epoch 秒）。
 *
 * ⚠️ 它不是秘密，也不能是秘密：`kvvi-session` 是 `HttpOnly` 的，
 * 页面脚本读不到它，于是一旦它过期，前端**无从知道**——
 * 只能等某个请求莫名失败，再猜。第一版就是这个形态：5 分钟一到，
 * 界面显示「重新连接中」，面板显示 `KVVI_INVALID_TOKEN`，
 * 而没有任何一处说得出「会话该续了」。
 *
 * 拆出这一张只写到期时刻的 Cookie，前端就能在到期**之前**续，
 * 也能在续不上时**说清楚是哪一种失败**（会话结束？权限变了？）。
 */
export const SESSION_EXPIRES_COOKIE = 'kvvi-session-exp'

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

/**
 * 从 `Cookie` 头里取出会话凭据。**只认这一个名字**，不做通用 Cookie 解析。
 *
 * ⚠️ 收**字符串或字符串数组**：`Set-Cookie` 天生可以有多个值，
 * 而本模块现在一次发两张（凭据 + 到期时刻），`res` 那一侧就是数组。
 * 只按字符串处理的话，读回来的会是 `undefined` ——
 * 而 `undefined` 与「没有 Cookie」在这条路上是同一件事，于是失败表现为
 * 「登录成功了但立刻又是未登录」，看不出是**解析**错了。
 * @param {string|string[]|undefined} headerValue `Cookie` 头的值
 * @returns {string|undefined} 会话凭据
 */
export function tokenFromCookie(headerValue) {
  const raw = Array.isArray(headerValue) ? headerValue.join(';') : headerValue
  if (typeof raw !== 'string') return undefined
  for (const segment of raw.split(';')) {
    const at = segment.indexOf('=')
    if (at === -1 || segment.slice(0, at).trim() !== SESSION_COOKIE) continue
    const value = segment.slice(at + 1).trim()
    return value === '' ? undefined : value
  }
  return undefined
}

/** 组装会话 Cookie。`HttpOnly` 让脚本读不到它，`SameSite=Strict` 挡住跨站发起的请求。 */
export function sessionCookie(value, maxAgeSeconds, expiresAt) {
  const pairs = [`${SESSION_COOKIE}=${value}; Max-Age=${String(maxAgeSeconds)}; Path=/; HttpOnly; SameSite=Strict`]
  // 到期时刻另发一张**非 HttpOnly** 的 —— 理由见 `SESSION_EXPIRES_COOKIE`。
  // 值只是 epoch 秒，抄走它换不出任何东西。
  if (typeof expiresAt === 'number') {
    pairs.push(`${SESSION_EXPIRES_COOKIE}=${String(expiresAt)}; Max-Age=${String(maxAgeSeconds)}`
      + '; Path=/; SameSite=Strict')
  }
  return pairs
}

/** 清空会话 Cookie（两张一起清，免得留一张过期的到期时刻骗前端）。 */
export function clearedCookie() {
  return [
    `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict`,
    `${SESSION_EXPIRES_COOKIE}=; Max-Age=0; Path=/; SameSite=Strict`,
  ]
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
  // 首次初始化。文案与 `bootstrap.mjs` 的错误码一一对应 —— 那边只给码，这边给话。
  KVVI_BOOTSTRAP_CLOSED: '这个实例已经初始化过了。请直接登录。',
  KVVI_BOOTSTRAP_TOKEN_REQUIRED: '需要初始化令牌。它由安装过程生成。',
  KVVI_BOOTSTRAP_TOKEN_INVALID: '初始化令牌不对。',
  KVVI_BOOTSTRAP_BAD_REQUEST: '企业名称与所有者账号都不能为空。',
  KVVI_BOOTSTRAP_WEAK_PASSWORD: '口令至少 8 位。',
  KVVI_LOGIN_EXISTS: '这个账号名已经有人用了，换一个。',
  // 会话类的码。**每一个都要有人话**：它们会带着 `?error=` 出现在登录页上，
  // 而第一版这些情形一律表现为「界面莫名不工作」。
  KVVI_SESSION_REQUIRED: '请先登录。',
  KVVI_SESSION_EXPIRED: '登录状态已过期，请重新登录。',
  KVVI_SESSION_ENDED: '这次会话已经结束了（登出、超时，或被管理员吊销），请重新登录。',
  KVVI_SESSION_UNKNOWN: '登录状态不认识，请重新登录。',
  KVVI_AUTHORIZATION_CHANGED: '你的权限刚刚被改动过，为了安全请重新登录。',
  KVVI_ACCOUNT_NOT_ACTIVE: '账号已停用，请联系管理员。',
}

/** Cookie 相对凭据到期时刻多给的几秒，避免边界上「刚拿到就过期」。 */
export const SESSION_COOKIE_SKEW_SECONDS = 5

/* ── 首次初始化页面 ──────────────────────────────────────────────────── */

/**
 * 首次初始化页面。**自包含**（样式与脚本内联、无外部资源），理由与登录页相同。
 *
 * ── 为什么它必须存在 ────────────────────────────────────────────────────
 *
 * 第一版只有 `POST /bootstrap/owner` 这个端点，**没有任何页面用它**。
 * 于是 `安装手册.md` §4 写的「界面会要一次性初始化令牌」是一句空话：
 * 客户打开界面只能看到「账号 / 口令 / 登录」，而这两个框他一个都没有。
 * 唯一的走法是自己拼 `curl` —— 那是我们能走的、不是客户能走的。
 *
 * 这件事在 G9 里看不出来，因为 G9 的验收旅程**直接调 API**：
 * 它走的正是客户走不到的那条路。
 *
 * 提交走 `fetch` + JSON，端点是**已有的那个** `/bootstrap/owner` ——
 * 判断「能不能初始化」「令牌对不对」「口令够不够长」的判据全在 `bootstrap.mjs` 里，
 * 这里一行都不重复。页面只负责把话说明白。
 *
 * @param input - `{message}`：要显示的错误，或空。
 * @returns 完整 HTML。
 */
function bootstrapPage({ message = '' } = {}) {
  const messages = JSON.stringify(MESSAGES).replace(/</g, '\\u003c')
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>KVVI 工作台 · 首次初始化</title>
<style>${PAGE_CSS}</style>
</head>
<body>
<form id="boot" autocomplete="off">
  <div class="mark">KV</div>
  <h1>KVVI 工作台</h1>
  <div class="lead">第一次使用：建企业与所有者账号</div>
  <label for="token">初始化令牌</label>
  <input id="token" name="token" type="text" required autofocus>
  <label for="companyName">企业名称</label>
  <input id="companyName" name="companyName" type="text" required>
  <label for="login">所有者账号</label>
  <input id="login" name="login" type="text" required>
  <label for="password">所有者口令</label>
  <input id="password" name="password" type="password" required minlength="8">
  <button type="submit" id="submit">创建并继续</button>
  <div class="msg" id="msg">${esc(message)}</div>
  <div class="foot">令牌由安装过程生成：安装输出里打印过它，
    也在 <code>$KVVI_HOME/secrets/bootstrap.token</code> 里。<br>
    这一步<strong>只会成功一次</strong>；之后再打开这个页面会跳回登录页。</div>
</form>
<script>
(function () {
  var MESSAGES = ${messages};
  var form = document.getElementById('boot');
  var msg = document.getElementById('msg');
  var button = document.getElementById('submit');
  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var body = {
      token: document.getElementById('token').value,
      companyName: document.getElementById('companyName').value,
      login: document.getElementById('login').value,
      password: document.getElementById('password').value
    };
    button.disabled = true;
    msg.textContent = '正在创建…';
    fetch('/bootstrap/owner', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (response) {
      return response.json().then(function (data) {
        return { status: response.status, data: data };
      });
    }).then(function (out) {
      if (out.status === 201) {
        msg.textContent = '创建完成，正在跳到登录…';
        window.location.replace('/kvvi/login');
        return;
      }
      button.disabled = false;
      // 服务端只给码，话在这张表里 —— 不在这里另写一份判断。
      msg.textContent = MESSAGES[out.data && out.data.error]
        || ('创建失败：' + (out.data && out.data.error ? out.data.error : out.status));
    }).catch(function (error) {
      button.disabled = false;
      msg.textContent = '创建失败：' + String(error && error.message ? error.message : error);
    });
  });
}());
</script>
</body>
</html>`
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
 * @param {() => Promise<boolean>} [input.bootstrapPending]
 *   这个实例是否**还没**初始化过。未提供时按「已初始化」处理 ——
 *   那种情况下 `/kvvi/bootstrap` 一律跳登录页，不会变成一个可反复调用的入口。
 * @returns {Promise<object|null>} 要自己应答时给出 `{status, html?/body?, headers?}`；
 *   否则 `null`。
 */
export async function handleGate({ method, path, query, body, headers, login, verify,
                                   bootstrapPending }) {
  const loginEntry = path === '/kvvi/login' || path === '/kvvi/builder/login'
  const requestedGateway = path === '/kvvi/builder/login' ? 'BUILDER' : 'USER'
  // 只在**要显示初始化页**时才去问一次库：其余路径一次查询都不多发。
  const pending = async () => (bootstrapPending === undefined ? false : await bootstrapPending())

  // ⓪ 首次初始化
  //
  // 排在登录页之前：一个还没初始化的实例上，客户**没有任何账号可以登录**，
  // 把他丢到登录页等于把他丢进死胡同 —— 而手册承诺的是「界面会要一次性初始化令牌」。
  if (path === BOOTSTRAP_PATH && method === 'GET') {
    if (!await pending()) {
      return { status: 303, headers: { location: '/kvvi/login', 'cache-control': 'no-store' } }
    }
    return OK(bootstrapPage())
  }

  // ① 登录页
  if (loginEntry && method === 'GET') {
    if (await pending()) {
      return { status: 303, headers: { location: BOOTSTRAP_PATH, 'cache-control': 'no-store' } }
    }
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
    if (out?.status === 201 && typeof out.body?.credential === 'string') {
      // ⚠️ 凭据**只进 Cookie**，不回显进 body 也不进 URL。
      //    进 URL 会留在浏览器历史、日志与 Referer 里。
      //
      // ⚠️ **Cookie 的存活期跟着凭据走，不另设一个数字。**
      //    第一版写的是 `sessionCookie(token, 60 * 60)`，而 `token` 只有 5 分钟寿命 ——
      //    两个数字各自都「有理由」，合起来是一个最坏的状态：
      //    浏览器以为还有 55 分钟、服务端已经全部拒收，
      //    而界面在中间这 55 分钟里一句话都不说。
      const expiresAt = Number(out.body.expiresAt)
      const maxAge = Number.isFinite(expiresAt)
        ? Math.max(0, expiresAt - Math.floor(Date.now() / 1000) + SESSION_COOKIE_SKEW_SECONDS)
        : 60 * 60
      return {
        status: 303,
        headers: {
          location: '/',
          'set-cookie': sessionCookie(out.body.credential, maxAge, expiresAt),
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
  // `verify` 可以只回一个布尔（既有调用方都是这样），也可以回
  // `{ok:false, code}` —— 后者让**为什么被拦**能一路带到登录页，
  // 而不是让客户对着一个没有任何说明的登录页自己猜。
  let denial = null
  if (token !== undefined) {
    const verdict = await verify(token)
    if (verdict === true || verdict?.ok === true) return null
    denial = typeof verdict === 'object' ? verdict?.code ?? null : null
  }
  // 没有有效会话 —— 带 Cookie 的先清掉，免得留一个坏 cookie 反复失败。
  // ⚠️ 未初始化时**跳初始化页**，不跳登录页：这个实例上还没有任何账号，
  //    跳到登录页就是死胡同，而界面上看不出「其实该先初始化」。
  const loginTarget = await pending() ? BOOTSTRAP_PATH : '/kvvi/login'
  const location = denial === null ? loginTarget
    : `${loginTarget}?error=${encodeURIComponent(denial)}`
  return {
    status: 303,
    headers: {
      location,
      'cache-control': 'no-store',
      ...(token === undefined ? {} : { 'set-cookie': clearedCookie() }),
    },
  }
}

/** 供测试直接取错误文案表。 */
export { MESSAGES as GATE_MESSAGES }

/** 首次初始化页面的路径。它由登录门自己提供，不属于业务面板。 */
export const BOOTSTRAP_PATH = '/kvvi/bootstrap'

/** 平台登录门自己处理的 `/kvvi/*` 路径；其余仍交给业务面板。 */
export function isGatePath(pathname) {
  return pathname === '/kvvi/login' || pathname === '/kvvi/builder/login'
    || pathname === '/kvvi/logout' || pathname === BOOTSTRAP_PATH
}
