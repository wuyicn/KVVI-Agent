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
    seen.push(req.headers)
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('upstream ok')
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
    assert.equal(upstream.seen[0].cookie, undefined,
      '没有凭据时不该带 cookie 头')

    // ② 运行时起来了，凭据文件出现。
    credential = 'dsh-auth-XXX=v1.body.sig'
    await hit(handler, port)
    assert.equal(upstream.seen[1].cookie, credential,
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

    const cookie = upstream.seen[0].cookie
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
    assert.equal(upstream.seen.at(-1)?.cookie, 'injected=ws',
      '升级握手没带上注入凭据 —— 实时通道会静默失败，而 REST 一切正常')
  })
})
