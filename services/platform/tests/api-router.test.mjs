/**
 * 阶段九 · 任务 1：受鉴权的产品 API 路由（`/api/v1/*`）。
 *
 * ── 这一组测的**不是路由能不能通**，而是三件安全性质 ──────────────────────
 *
 * 计划里写明「Company and user identity always come from the verified session」。
 * 那句话在测试里必须落成可判定的断言，否则它只是一句注释：
 *
 * | # | 性质 | 不成立会怎样 |
 * |---|---|---|
 * | 1 | 无会话 → 401 | 任何人打一下接口就能读到别家公司的系统 |
 * | 2 | **调用方传的 companyId 无效** | 传一个别的公司 id 就跨租户了 |
 * | 3 | 身份类字段被**递归**剥掉 | 嵌套在 data 里的 `companyId` 一样能钻进执行点 |
 *
 * ⚠️ 第 3 条尤其要紧：命令执行点已经有一层「剥身份字段」的保护，
 * 但它保护的是**它自己那条路**。API 是新入口，**必须在入口处再剥一次** ——
 * 两处都做不是重复，是「每条入口各自负责」。
 *
 * ── 为什么从外面打真实 HTTP ───────────────────────────────────────────────
 *
 * `/api/v1` 的归属是**服务端事实**：它现在会被转发给运行时（`/api` 是
 * 运行时的 prefix 路由），所以「平台认领了它」这件事只有从外面打才验得到。
 * 直接调模块函数会把这条性质测没。
 */
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeAll } from '../src/db.mjs'
import { A, B, PASSWORD, resetDatabase, grantBaseline, makeSession } from './harness.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PORT = 7496
const BASE = `http://127.0.0.1:${PORT}`
const INTERNAL = 'test-internal-token'

let child = null
let alice = null

async function waitUp(tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) return true
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('平台服务进程没能起来')
}

/** 用会话令牌打产品 API。令牌放头里 —— 与登录门的 Cookie 是同一份凭据。 */
async function api(method, path, tokenv, body) {
  const headers = { authorization: 'Bearer ' + (tokenv ?? '') }
  if (body !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(`${BASE}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  })
  let parsed = null
  try { parsed = await res.json() } catch { /* 非 JSON 也无妨 */ }
  return { status: res.status, body: parsed, process: res.headers.get('x-kvvi-process') }
}

before(async () => {
  await resetDatabase()
  await grantBaseline(A.alice)
  alice = await makeSession(A.alice, A.company)
  child = spawn('node', [resolve(HERE, '..', 'src', 'server.mjs')], {
    env: { ...process.env, KVVI_PLATFORM_PORT: String(PORT),
           KVVI_INTERNAL_TOKEN: INTERNAL,
           KVVI_RUNTIME_URL: 'http://127.0.0.1:1' },
    stdio: 'pipe',
  })
  await waitUp()
})

after(async () => {
  if (child) child.kill('SIGTERM')
  await closeAll()
})

describe('阶段九 · 受鉴权的产品 API 路由', () => {
  test('★ `/api/v1` 由**平台**应答，不被转发给运行时', async () => {
    // 判据是响应头里的 `x-kvvi-process` —— 那是平台进程加的标记。
    // 少了它说明请求到了运行时（`/api` 是运行时的 prefix 路由）。
    const r = await api('GET', '/api/v1/systems', alice.raw)
    assert.equal(r.process, 'platform-service',
      '`/api/v1` 没有由平台应答 —— 它被转发给运行时的 /api 了')
  })

  test('★ 无会话 → 401，且不泄露任何系统清单', async () => {
    const r = await api('GET', '/api/v1/systems', undefined)
    assert.equal(r.status, 401)
    assert.equal(r.body?.items, undefined, '未鉴权却返回了 item 列表')
  })

  test('★ 无效令牌 → 401（不降级成匿名）', async () => {
    const r = await api('GET', '/api/v1/systems', 'not-a-real-token')
    assert.equal(r.status, 401)
  })

  test('★ 调用方传的 companyId **无效** —— 公司只从会话来', async () => {
    // 传**别家公司**的 id：若它生效就是跨租户读。
    //
    // ⚠️ 这条**不依赖 `/systems` 路由存在**。第一版断言的是「200 且 items 里
    // 没有别家公司的」，那要求路由先实现 —— 而路由在任务 3。
    // 一条测「剥离」的断言不该挂在「路由已建」上：那会让它在任务 3 之前
    // 一直红着，而红的原因是**测试写错了**，不是代码错了。
    //
    // 改成直接验剥离本身：回显里的 companyId 必须**只**来自会话。
    // ⚠️ 这条断言在任务 3 之后**改了判据**：`/systems` 从「未知路由」
    //    变成了真实路由，回显里的 `session` 字段没有了。
    //    改成验**服务端实际用了哪个公司** —— 那才是这条要证的事。
    const r = await api('GET', '/api/v1/systems?companyId=' + B.company, alice.raw)
    assert.notEqual(r.status, 401, '带有效会话却判成未鉴权')
    assert.equal(r.body?.companyId, A.company,
      '生效的 companyId 不是会话里那个 —— 调用方的输入被采信了')
    assert.notEqual(r.body?.companyId, B.company)
    // 返回的每一项都必须是本公司的。
    for (const item of (r.body?.items ?? [])) {
      assert.notEqual(item.companyId, B.company, '返回了别家公司的系统')
    }
  })

  test('★ 身份类字段在**入口处**被剥掉，包括嵌套的', async () => {
    // 嵌套是重点：只在顶层删键挡不住 `{ data: { companyId: '…' } }`。
    const r = await api('POST', '/api/v1/echo', alice.raw, {
      data: { reason: 'ok', companyId: B.company },
      nested: { deep: { gateway: 'BUILDER', roles: ['owner'] } },
    })
    assert.notEqual(r.status, 401, '带有效会话却判成未鉴权')
    // 回显的键是**剥过之后**的：嵌套那两层的 companyId / gateway / roles
    // 都不该出现。端点本身还不存在（404），但剥离发生在分派之前，
    // 所以这里能验到它。
    const echoed = JSON.stringify(r.body ?? {})
    assert.ok(!echoed.includes(B.company), '别家公司的 id 穿过了入口剥离')
    assert.ok(!echoed.includes('"gateway":"BUILDER"'), '嵌套的 gateway 没被剥掉')
    assert.ok(!echoed.includes('"roles"'), '嵌套的 roles 没被剥掉')
  })
})
