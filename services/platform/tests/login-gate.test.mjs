import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { handleAuth } from '../src/auth.mjs'
import { BOOTSTRAP_PATH, handleGate, isGatePath, tokenFromCookie } from '../src/gate.mjs'
import { verifyBrowserCredential, verifyToken } from '../src/identity.mjs'
import { A, PASSWORD, resetDatabase, grantPlatformRole, closeAll } from './harness.mjs'

before(async () => {
  await resetDatabase()
  await grantPlatformRole(A.alice, 'owner')
})

after(async () => { await closeAll() })

const login = (credentials) => handleAuth({
  method: 'POST', path: '/auth/login', body: credentials, headers: {},
})

const submit = (path, loginName = 'alice') => handleGate({
  method: 'POST', path, query: path,
  body: new URLSearchParams({ login: loginName, password: PASSWORD,
    companyId: A.company }).toString(),
  headers: {}, login, verify: async () => false,
})

describe('Stage 8：工作台与搭建台使用独立登录入口', () => {
  test('两个入口显示不同标题且不暴露对方功能清单', async () => {
    const worker = await handleGate({
      method: 'GET', path: '/kvvi/login', query: '/kvvi/login', body: '', headers: {},
      login, verify: async () => false,
    })
    const builder = await handleGate({
      method: 'GET', path: '/kvvi/builder/login', query: '/kvvi/builder/login', body: '', headers: {},
      login, verify: async () => false,
    })
    assert.match(worker.html, /KVVI 工作台/)
    assert.doesNotMatch(worker.html, /搭建工具|插件安装|发布契约/)
    assert.match(builder.html, /KVVI 搭建台/)
  })

  test('搭建者入口创建服务端绑定的 BUILDER 会话', async () => {
    const out = await submit('/kvvi/builder/login')
    assert.equal(out.status, 303)
    assert.equal(out.headers.location, '/')
    // ⚠️ Cookie 里装的是**会话凭据**，不是业务令牌 —— 见下面那条「两张凭据互换必须失败」。
    const credential = tokenFromCookie(out.headers['set-cookie'])
    const { ctx } = await verifyBrowserCredential(credential)
    assert.equal(ctx.gateway, 'BUILDER')
    assert.equal(ctx.companyId, A.company)
  })

  test('★ 两张凭据互换必须失败（这就是「分离」的可检判据）', async () => {
    const out = await submit('/kvvi/builder/login')
    const credential = tokenFromCookie(out.headers['set-cookie'])
    // ① 会话凭据 **换不出业务能力** —— 拿它当业务令牌用，一律拒。
    assert.equal(await verifyToken(credential), null,
      '会话凭据被当成了业务令牌 —— 「分离」在代码里不成立')
    // ② 业务令牌 **不能** 当会话凭据用（同一张 Cookie 里塞 5 分钟令牌，
    //    正是第一版那个让界面每 5 分钟死一次的做法）。
    const login = await handleAuth({ method: 'POST', path: '/auth/login',
      body: { login: 'alice', password: PASSWORD, requestedGateway: 'USER' }, headers: {} })
    const { ctx } = await verifyBrowserCredential(login.body.token)
    assert.equal(ctx, null, '业务令牌被当成了会话凭据 —— 5 分钟到期会再次杀死界面')
  })

  test('普通员工从搭建者入口登录会被拒绝', async () => {
    const out = await submit('/kvvi/builder/login', 'bob')
    assert.equal(out.status, 303)
    assert.equal(out.headers.location,
      '/kvvi/builder/login?error=KVVI_BUILDER_ACCESS_REQUIRED')
  })

  test('员工入口始终创建 USER 会话', async () => {
    const out = await submit('/kvvi/login', 'bob')
    const { ctx } = await verifyBrowserCredential(tokenFromCookie(out.headers['set-cookie']))
    assert.equal(ctx.gateway, 'USER')
  })
})

/**
 * 首次初始化的**界面**。
 *
 * ── 这一组为什么必须存在 ────────────────────────────────────────────────
 *
 * 第一版只有 `POST /bootstrap/owner`，**没有任何页面用它**。于是
 * `安装手册.md` §4 写的「界面会要一次性初始化令牌」是一句空话：客户打开界面
 * 只看到「账号 / 口令 / 登录」，而这两个框他一个都没有 —— 唯一走法是自己拼 `curl`。
 *
 * G9 的验收看不出来：那条旅程**直接调 API**，走的正是客户走不到的那条路。
 *
 * | # | 性质 | 不成立会怎样 |
 * |---|---|---|
 * | 1 | 未初始化时，界面把人送到初始化页 | 客户对着登录页，注册不了任何账号 |
 * | 2 | 已初始化后，那个页面不能再进 | 它变成一个可反复到达的入口 |
 * | 3 | 页面不自己判断令牌/口令是否合格 | 服务端改判据，页面说「可以了」，然后失败 |
 * | 4 | 不传 `bootstrapPending` 时按「已初始化」处理 | 一个忘了接线的调用方会放出这个入口 |
 */
describe('Stage 11：首次初始化界面', () => {
  const boot = (path, method = 'GET', pending = true) => handleGate({
    method, path, query: path, body: '', headers: {},
    login, verify: async () => false,
    bootstrapPending: async () => pending,
  })

  test('★ 未初始化时，打开界面进的是初始化页（客户真的有这一步）', async () => {
    const out = await boot('/kvvi/login')
    assert.equal(out.status, 303)
    assert.equal(out.headers.location, '/kvvi/bootstrap',
      '未初始化的实例上没有任何账号，把客户丢到登录页就是丢进死胡同')
  })

  test('未初始化时，未登录访问根路径也进初始化页', async () => {
    const out = await boot('/')
    assert.equal(out.status, 303)
    assert.equal(out.headers.location, '/kvvi/bootstrap')
  })

  test('初始化页要令牌、企业名、所有者账号与口令四样', async () => {
    const out = await boot('/kvvi/bootstrap')
    assert.equal(out.status, 200)
    for (const field of ['token', 'companyName', 'login', 'password']) {
      assert.match(out.html, new RegExp(`name="${field}"`), `页面少了 ${field}`)
    }
    // 提交到的是**已有的那个端点**，页面不另开一条通道。
    assert.match(out.html, /\/bootstrap\/owner/)
  })

  test('初始化页**不回显**令牌，也不含任何外部资源（未登录也要能完整加载）', async () => {
    const out = await boot('/kvvi/bootstrap')
    assert.doesNotMatch(out.html, /<script[^>]+src=/)
    assert.doesNotMatch(out.html, /<link[^>]+href=/)
    // 页面上那个 `token` 是空输入框，不是任何真实令牌。
    assert.doesNotMatch(out.html, /value="[A-Za-z0-9_-]{20,}"/)
  })

  test('★ 已初始化后，那个页面不能再进', async () => {
    const out = await boot('/kvvi/bootstrap', 'GET', false)
    assert.equal(out.status, 303)
    assert.equal(out.headers.location, '/kvvi/login')
  })

  test('★ 不传 `bootstrapPending` 时按「已初始化」处理（忘接线不会放出入口）', async () => {
    const out = await handleGate({
      method: 'GET', path: '/kvvi/bootstrap', query: '', body: '', headers: {},
      login, verify: async () => false,
    })
    assert.equal(out.status, 303)
    assert.equal(out.headers.location, '/kvvi/login')
  })

  test('已初始化时，登录页照常显示（没有被初始化页挡住）', async () => {
    const out = await boot('/kvvi/login', 'GET', false)
    assert.equal(out.status, 200)
    assert.match(out.html, /用你的账号登录/)
  })

  test('★ `/kvvi/bootstrap` 归登录门，不被业务面板截走', () => {
    // 面板对 `/kvvi/*` 里除 `/kvvi/panel` 之外的路径一律回 `KVVI_PANEL_NOT_FOUND`。
    // 不把初始化页排出去，客户打开它看到的是一句 404 JSON —— 而不是那个表单。
    assert.equal(isGatePath(BOOTSTRAP_PATH), true,
      '登录门认不出初始化页，它会在面板那一段被回 404')
  })

  test('初始化页的文案表覆盖 `bootstrap.mjs` 的全部对外错误码', async () => {
    // 服务端只给码，话在页面这张表里。少一条，客户看到的就是 `KVVI_BOOTSTRAP_XXX`。
    const out = await boot(BOOTSTRAP_PATH)
    const codes = ['KVVI_BOOTSTRAP_CLOSED', 'KVVI_BOOTSTRAP_TOKEN_REQUIRED',
      'KVVI_BOOTSTRAP_TOKEN_INVALID', 'KVVI_BOOTSTRAP_BAD_REQUEST',
      'KVVI_BOOTSTRAP_WEAK_PASSWORD', 'KVVI_LOGIN_EXISTS']
    for (const code of codes) {
      assert.match(out.html, new RegExp(code), `页面缺 ${code} 的文案`)
    }
  })

  test('页面里不出现 markdown 记号（写 HTML 时的手滑）', async () => {
    // 实测出现过：页脚写成 `这一步**只会成功一次**`，而这是一段 HTML ——
    // 客户看到的是两个星号。写文档写惯了，写 HTML 就会带上。
    for (const [path, pending] of [[BOOTSTRAP_PATH, true],
                                   ['/kvvi/login', false], ['/kvvi/builder/login', false]]) {
      const out = await boot(path, 'GET', pending)
      assert.doesNotMatch(out.html, /\*\*/, `${path} 的页面上出现了 markdown 的 **`)
    }
  })
})
