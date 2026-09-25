/**
 * KVVI 工作台（Workbench）—— 平台服务进程提供的**员工侧入口**。
 *
 * ── 这一组测的是 PRD §2.3 的**界面隔离**，不是「页面好不好看」 ──────────
 *
 * §2.3 原文：隔离必须是三层的，缺一层就等于没隔离 ——
 * **能力隔离**（不挂载搭建 Skill 与工具）、**界面隔离**（工作台不渲染搭建
 * 入口、不渲染模式切换器）、**数据隔离**（搭建产物对员工不可见）。
 *
 * 这三层里，前两层的**服务端事实**就是本文件要钉的东西：
 * `/workbench/api/session` 返回的能力表里**一个搭建类能力都不许有**。
 *
 * 为什么必须从**外面打真实 HTTP**：这些是「入口」的性质。
 * 直接调模块函数会把「谁应答的」测没 —— 而「由平台进程应答」正是
 * §2.6.1「模式由入口决定」成立的前提。
 *
 * ── 这条测试与「把按钮藏起来」的区别 ────────────────────────────────────
 *
 * 在页面里少画一个按钮，是一种**渲染层**的省略：数据仍在响应里，
 * 改一行 JS 就能把它显示出来。本文件断言的是**数据不在响应里** ——
 * 界面拿不到的东西，渲染不出来。两者不是同一件事，而只有后者能防住
 * 「下一次改前端的人顺手把它渲染出来」。
 */
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeAll } from '../src/db.mjs'
import { A, PASSWORD, resetDatabase, grantBaseline } from './harness.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PORT = 7497
const BASE = `http://127.0.0.1:${PORT}`
const INTERNAL = 'test-internal-token'

/** 搭建类能力的前缀。工作台**一个都不该看到**。 */
const BUILDER_MARKERS = ['schema.', 'plugin.', 'contract.', 'publish.', 'dashboard.']

let child = null

async function waitUp(tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const r = await fetch(`${BASE}/healthz`)
      if (r.ok) return true
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('平台服务进程没能起来')
}

async function login() {
  const r = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: 'alice', password: PASSWORD, gateway: 'USER' }),
  })
  assert.equal(r.status, 201, '登录应当成功')
  return (await r.json()).token
}

before(async () => {
  await resetDatabase()
  await grantBaseline(A.alice)
  child = spawn('node', [resolve(HERE, '..', 'src', 'server.mjs')], {
    env: { ...process.env, KVVI_PLATFORM_PORT: String(PORT),
           KVVI_INTERNAL_TOKEN: INTERNAL,
           // 同样刻意指向不存在的运行时：工作台页面必须由平台进程自己应答。
           KVVI_RUNTIME_URL: 'http://127.0.0.1:1' },
    stdio: 'pipe',
  })
  await waitUp()
})

after(async () => {
  if (child) child.kill('SIGTERM')
  await closeAll()
})

describe('工作台：页面由平台进程自己提供（§2.6.1 入口决定模式）', () => {
  test('GET /workbench → 200 HTML，且不经运行时进程', async () => {
    const r = await fetch(`${BASE}/workbench`)
    assert.equal(r.status, 200)
    assert.match(r.headers.get('content-type') ?? '', /text\/html/)
    const html = await r.text()
    assert.match(html, /KVVI 工作台/, '页面应当有工作台标题')
    // 标识来自平台进程，不是被转发后的运行时应答。
    assert.equal(r.headers.get('x-kvvi-process'), 'platform-service')
  })

  test('★ 响应体是**真正的 HTML**，不是被 JSON 序列化过的字符串', async () => {
    // 这条是回归测试，起因是一个真实故障：`send()` 此前无条件
    // `JSON.stringify(body)`，于是 HTML 被送成**一行带反斜杠转义的 JSON 字符串**，
    // 浏览器当纯文本渲染 —— 页面全白。
    //
    // ⚠️ 它为什么能溜过前面那些断言：**表面症状全部正常**。
    // HTTP 200、`content-type: text/html`、响应体非空、
    // 连 `assert.match(html, /KVVI 工作台/)` 都通过（标题就在那串字符串里）。
    //
    // 所以这条断言不能只查「包含某个字串」，必须查**它是以什么开头的**：
    // 序列化过的响应第一个字符是引号，真正的 HTML 第一个字符是 `<`。
    const r = await fetch(`${BASE}/workbench`)
    const html = await r.text()
    assert.ok(html.startsWith('<!DOCTYPE html>'),
      '响应体不是以 <!DOCTYPE html> 开头 —— 大概率被 JSON 序列化了：' + html.slice(0, 60))
    assert.ok(!html.startsWith('"'), '响应体以引号开头 —— HTML 被当成 JSON 字符串送出了')
    assert.ok(html.includes('\n'), '响应体里没有换行 —— 整份文档被压成了一行，说明被序列化过')
    // 反向：不能出现 JSON 转义残留。
    assert.ok(!html.includes('\\"'), '响应体里出现了 \\" —— 引号被转义了，这是 JSON 序列化的痕迹')
    assert.ok(!html.includes('\\n'), '响应体里出现了字面 \\n —— 换行被转义了')
  })

  test('页面是自包含的：不允许被别的站点嵌进 iframe', async () => {
    const r = await fetch(`${BASE}/workbench`)
    assert.equal(r.headers.get('x-frame-options'), 'DENY')
  })

  test('POST /workbench → 405（页面只读）', async () => {
    const r = await fetch(`${BASE}/workbench`, { method: 'POST' })
    assert.equal(r.status, 405)
  })

  test('未知子路径 → 404，而不是掉进运行时转发', async () => {
    // 退回转发会让 `/workbench/typo` 静默变成搭建舱的壳 ——
    // 员工点错一个字母就进了另一个模式，而 §2.6.1 说这是不允许的。
    const r = await fetch(`${BASE}/workbench/typo`)
    assert.equal(r.status, 404)
    const body = await r.json()
    assert.equal(body.error, 'KVVI_WORKBENCH_NOT_FOUND')
  })
})

describe('工作台会话投影：界面隔离是数据层事实（§2.3）', () => {
  test('不带令牌 → 401，且不回落到任何默认身份', async () => {
    const r = await fetch(`${BASE}/workbench/api/session`)
    assert.equal(r.status, 401)
    assert.deepEqual(await r.json(), { error: 'KVVI_TOKEN_REQUIRED' })
  })

  test('伪造令牌 → 401 KVVI_INVALID_TOKEN', async () => {
    const r = await fetch(`${BASE}/workbench/api/session`, {
      headers: { authorization: 'Bearer not-a-real-token' },
    })
    assert.equal(r.status, 401)
    assert.equal((await r.json()).error, 'KVVI_INVALID_TOKEN')
  })

  test('POST → 405（会话投影只读）', async () => {
    const token = await login()
    const r = await fetch(`${BASE}/workbench/api/session`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(r.status, 405)
  })

  test('★ 响应里**一个搭建类能力都没有**（界面隔离的数据层判据）', async () => {
    const token = await login()
    const r = await fetch(`${BASE}/workbench/api/session`, {
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(r.status, 200)
    const body = await r.json()

    // 整个响应的序列化文本里都不该出现搭建类能力名。
    // 逐个字段检查而不是只查 capabilities —— 换个字段名带走它们同样是泄露。
    const serialized = JSON.stringify(body)
    for (const marker of BUILDER_MARKERS) {
      assert.ok(!serialized.includes(marker),
        `工作台响应里出现了搭建类能力（${marker}）：${serialized}`)
    }

    assert.ok(Array.isArray(body.capabilities) && body.capabilities.length > 0,
      '员工侧应当至少有读能力 —— 空集合会让这条测试形同虚设')
  })

  test('★ 另一网关的能力清单被**显式省略**，而不是碰巧没带上', async () => {
    const token = await login()
    const r = await fetch(`${BASE}/workbench/api/session`, {
      headers: { authorization: `Bearer ${token}` },
    })
    const body = await r.json()
    assert.equal(body.otherGatewayCapabilitiesOmitted, true,
      '省略必须是**声明过的**：否则「没带」与「漏带」无法区分')
    assert.equal(body.toolsOfOtherGateway, undefined)
  })

  test('带上了展示用的名字（否则界面只能显示 uuid）', async () => {
    // 这条测的是「界面有没有东西可渲染」。只给 uuid 的话，
    // 员工没法确认「我现在在哪个公司的身份下」—— 而公司是会话创建时
    // 绑定、不可切换的（§9.9.3），那正是最该被看到的一件事。
    const token = await login()
    const r = await fetch(`${BASE}/workbench/api/session`, {
      headers: { authorization: `Bearer ${token}` },
    })
    const body = await r.json()
    assert.equal(body.login, 'alice')
    assert.ok(typeof body.companyName === 'string' && body.companyName.length > 0,
      'companyName 应当有值，实际：' + JSON.stringify(body.companyName))
    // 展示名不能把搭建类信息顺带带出来。
    for (const marker of BUILDER_MARKERS) {
      assert.ok(!JSON.stringify(body).includes(marker),
        '加了展示名之后响应里出现了搭建类字样：' + marker)
    }
  })

  test('对照：取证端点 /auth/session 仍然报出两个集合（省略只对工作台生效）', async () => {
    // 这条是防止「为了堵住界面，把取证材料也一起删了」。
    // 复核者需要能自己核对两个集合确实不相交 —— 那是 §9.6.5 的取证要求。
    const token = await login()
    const r = await fetch(`${BASE}/auth/session`, {
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(r.status, 200)
    const body = await r.json()
    assert.ok(Array.isArray(body.tools), '/auth/session 应带本网关工具')
    assert.ok(Array.isArray(body.toolsOfOtherGateway),
      '/auth/session 必须保留另一网关清单 —— 工作台不需要它，复核者需要')
    // 两个集合不相交：这才是「隔离」而不是「过滤」。
    const overlap = body.tools.filter((t) => body.toolsOfOtherGateway.includes(t))
    assert.deepEqual(overlap, [], '两个网关的工具集出现了交集')
  })
})
