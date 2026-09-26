/**
 * 转发处理器**注入运行时凭据**的行为。
 *
 * ── 这一组为什么必须存在 ────────────────────────────────────────────────
 *
 * 这一层在此之前**一个直接测试都没有**。它只被「起整套 docker、打开界面」间接走过，
 * 而在那条路径上运行时**已经跑过一次**、凭据文件早就写好了 —— 缺陷因此看不见。
 *
 * 具体是哪个缺陷：`createProxyHandler` 在**创建时**取一次凭据并缓存，
 * 而运行时是在**它自己第一次启动**时才写下 `.credentials.yaml`，
 * 平台**先于运行时启动**。于是全新安装上：
 *
 *     启动平台（没有凭据文件）→ 缓存 undefined → 启动运行时（写出凭据）
 *     → 平台此后每一个请求都不带那张 Cookie → 界面回
 *       `dsh web authentication required`
 *
 * 开发机上永远复现不了（文件早就在了），**每一台新机器上必现**。
 *
 * | # | 性质 | 不成立会怎样 |
 * |---|---|---|
 * | 1 | 凭据**后来才出现**，之后的请求要用上它 | 首次安装的界面永远打不开 |
 * | 2 | 浏览器那份 Cookie 被**换掉**，不是叠加 | 运行时会看到一个既陌生又不完整的 Cookie 集合 |
 * | 3 | 没有凭据时不带 `cookie` 头（而不是带一个空的） | 空 Cookie 头与「没有 Cookie」在运行时侧不是同一件事 |
 * | 4 | WebSocket 升级走同一条判据 | REST 一切正常而实时通道静默失败 |
 */
import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'

import { createProxyHandler, createUpgradeHandler, forwardHeaders } from '../src/proxy.mjs'

const servers = []

/**
 * 起一个假的上游，记录它收到的每一个请求头。
 * @returns `{url, seen}`
 */
async function fakeUpstream() {
  const seen = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => { chunks.push(chunk) })
    req.on('end', () => {
      seen.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') })
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('upstream ok')
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  servers.push(server)
  const { port } = server.address()
  return { url: new URL(`http://127.0.0.1:${port}`), seen }
}

after(async () => {
  await Promise.all(servers.map((server) => new Promise((done) => {
    server.close(() => { done() })
  })))
})

/**
 * 打一次代理。
 * @param handler 处理器
 * @param port 监听端口
 * @returns 响应体
 */
async function hit(handler, port) {
  const res = await fetch(`http://127.0.0.1:${port}/`, { headers: { cookie: 'kvvi-session=browser-token' } })
  return res.text()
}

describe('转发处理器 · 运行时凭据注入', () => {
  test('★ 凭据**后来才出现**时，之后的请求要用上它（全新安装的形态）', async () => {
    const upstream = await fakeUpstream()
    // 模拟平台先启动、运行时后写出凭据：一开始读不到，之后读得到。
    let credential
    const handler = createProxyHandler(upstream.url, () => credential)

    const server = createServer(handler)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    servers.push(server)
    const { port } = server.address()

    // ① 运行时还没写出凭据。
    await hit(handler, port)
    assert.equal(upstream.seen[0].headers.cookie, undefined,
      '没有凭据时不该带 cookie 头')

    // ② 运行时起来了，凭据文件出现。
    credential = 'dsh-auth-XXX=v1.body.sig'
    await hit(handler, port)
    assert.equal(upstream.seen[1].headers.cookie, credential,
      '凭据后来才出现，平台却没有用上它 —— 全新安装的界面会永远打不开')
  })

  test('★ 浏览器那份 Cookie 被换掉，不是叠加', async () => {
    const upstream = await fakeUpstream()
    const handler = createProxyHandler(upstream.url, () => 'injected=1')
    const server = createServer(handler)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    servers.push(server)
    await hit(handler, server.address().port)

    const cookie = upstream.seen[0].headers.cookie
    assert.equal(cookie, 'injected=1')
    // 浏览器那份是 KVVI 自己的会话 Cookie，运行时既不认识它、也不该看到它。
    assert.ok(!cookie.includes('kvvi-session'),
      '浏览器凭据与注入凭据混在一起发过去了')
  })

  test('没有凭据时**不带** cookie 头，而不是带一个空的', async () => {
    const headers = forwardHeaders({ cookie: 'kvvi-session=x' },
      new URL('http://127.0.0.1:1'), undefined)
    assert.equal('cookie' in headers, false,
      '空 Cookie 头与「没有 Cookie」在运行时侧不是同一件事')
  })

  test('x-kvvi-* 头一律剥掉（浏览器不能自带模式上下文）', () => {
    const headers = forwardHeaders(
      { 'x-kvvi-gateway': 'BUILDER', 'x-kvvi-company': 'other' },
      new URL('http://127.0.0.1:1'), 'c=1')
    assert.equal(headers['x-kvvi-gateway'], undefined)
    assert.equal(headers['x-kvvi-company'], undefined)
  })

  test('Host 换成转发目标，原 Host 进 x-forwarded-host', () => {
    const headers = forwardHeaders({ host: '127.0.0.1:7400' },
      new URL('http://127.0.0.1:7401'), 'c=1')
    assert.equal(headers.host, '127.0.0.1:7401')
    assert.equal(headers['x-forwarded-host'], '127.0.0.1:7400')
  })

  test('★ WebSocket 升级走同一条判据（REST 正常而实时通道静默失败最难查）', async () => {
    const upstream = await fakeUpstream()
    let credential
    const handler = createUpgradeHandler(upstream.url, () => credential)
    // 升级处理器不会走完整个 HTTP 生命周期（假上游不是 WebSocket 服务器），
    // 所以这里**只看它有没有把凭据带上去** —— 那正是要验的那一步。
    const socket = { end() {}, once() {}, emit() {}, destroy() {} }
    const request = { headers: { cookie: 'kvvi-session=x' }, method: 'GET', url: '/' }

    credential = 'injected=ws'
    await handler(request, socket, Buffer.alloc(0)).catch(() => {})
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(upstream.seen.at(-1)?.headers.cookie, 'injected=ws',
      '升级握手没带上注入凭据 —— 实时通道会静默失败，而 REST 一切正常')
  })
})

/**
 * 转发**带请求体**的请求。
 *
 * ── 这一组为什么必须存在 ────────────────────────────────────────────────
 *
 * 平台第一版在登录门那一段无条件 `await readBody(req)`：**把请求流读干**，
 * 然后对绝大多数路径 `return null` 落回转发。转发拿到的是一段已经结束的流，
 * 而请求头里仍带着原来的 `content-length` —— 上游一直在等一个永远不来的体。
 *
 * 症状的误导性在于它**同时给出「服务是好的」这个答案**：
 *
 * | 请求 | 结果 |
 * |---|---|
 * | `GET /`、`GET /healthz`、`GET /assets/*` | 正常，页面 **HTTP 200** |
 * | `POST /api/*`（运行时的每一条 RPC，界面的全部数据来源） | **挂死，永不返回** |
 * | 绕过平台直接打开运行时进程 | 界面一切正常 |
 *
 * 于是界面表现为「重新连接中…」、输入框不可用，而代理与运行时各自都「没问题」。
 */
describe('转发 · 请求体', () => {
  test('★ 请求体已经被读过，转发也必须返回（而不是挂死）', async () => {
    const upstream = await fakeUpstream()
    const handler = createProxyHandler(upstream.url, () => 'injected=1')
    // 模拟第一版平台的行为：先在请求处理器里把体读完，再交给转发。
    const server = createServer(async (req, res) => {
      for await (const _chunk of req) { /* 读干，什么都不留 */ }
      await handler(req, res)
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    servers.push(server)
    const { port } = server.address()

    const controller = new AbortController()
    const guard = setTimeout(() => { controller.abort() }, 4_000)
    let status
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/session/list`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'r1' }),
        signal: controller.signal,
      })
      status = res.status
    } catch (error) {
      assert.fail('转发挂死了：' + String(error?.message ?? error))
    } finally {
      clearTimeout(guard)
    }
    assert.equal(status, 200, '转发没有把上游的响应送回来')
    // ⚠️ 判据是**「声明的长度」必须等于「实际发出的字节」**，不是「必须没有 content-length」。
    //    保留一个写着 75 却一个字节都不发的头，正是挂死的原因；
    //    删掉之后由 node 按实际发出的流决定（这里是 `content-length: 0`），
    //    两者一致就一定会返回。断言「没有这个头」会把正确实现也判红。
    const declared = upstream.seen[0].headers['content-length']
    assert.equal(Number(declared ?? upstream.seen[0].body.length), upstream.seen[0].body.length,
      `声明了 ${String(declared)} 字节却只发出 ${String(upstream.seen[0].body.length)} 字节：`
      + '上游会一直等下去，请求永不返回')
  })

  test('体还在时，转发把它原样送到上游', async () => {
    const upstream = await fakeUpstream()
    const handler = createProxyHandler(upstream.url, () => 'injected=1')
    const server = createServer(handler)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    servers.push(server)
    const body = JSON.stringify({ type: 'client-request', rpcId: 'r2', method: 'session.list' })

    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/session/list`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    assert.equal(res.status, 200)
    assert.equal(upstream.seen[0].body, body, '请求体没有原样到达上游')
  })

  test('`forwardHeaders` 一律剥掉 `content-length`（大小写不敏感）', () => {
    const headers = forwardHeaders(
      { 'content-length': '75', 'Content-Type': 'application/json' },
      new URL('http://127.0.0.1:7401'), 'c=1')
    const names = Object.keys(headers).map((name) => name.toLowerCase())
    assert.equal(names.includes('content-length'), false)
    assert.equal(headers['Content-Type'], 'application/json',
      '只该删 content-length，别的头要原样留着')
  })

  test('★ `Origin` 跟着 Host 一起改写（只改一个会让每条 POST 都 403）', () => {
    const headers = forwardHeaders(
      { host: '127.0.0.1:7500', origin: 'http://127.0.0.1:7500' },
      new URL('http://127.0.0.1:7401'), 'c=1')
    // 运行时的栅栏要求 Origin 与 Host 是同一个 authority。
    // 只改 Host 会得到 `127.0.0.1:7401` 配 `127.0.0.1:7500` 这一对不自洽的值 → 403。
    assert.equal(headers.host, '127.0.0.1:7401')
    assert.equal(headers.origin, 'http://127.0.0.1:7401')
    // `Referer` 留着就会与 Origin 不一致。
    assert.equal('referer' in headers, false)
  })

  test('浏览器没带 `Origin` 时也不凭空造一个', () => {
    const headers = forwardHeaders({ host: '127.0.0.1:7500' },
      new URL('http://127.0.0.1:7401'), 'c=1')
    // 栅栏对「没有 Origin」是放行的（Host 那一关已经绑住了请求）。
    // 无端加一个 Origin，等于替调用方声明了它没声明的东西。
    assert.equal('origin' in headers, false)
  })
})
