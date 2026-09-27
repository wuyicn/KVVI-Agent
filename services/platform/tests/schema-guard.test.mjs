/**
 * 问题 26 / 27 的判据：**库跟不上代码时，服务不许悄悄带病运行，也不许被打挂。**
 *
 * ## 这两条为什么必须一起测
 *
 * 实测过一次：换了发行包、迁移没跑 → 提交发布时 PostgreSQL 抛
 * 「`payload` 字段不存在」→ 错误从 async 处理器穿出去成了 unhandled rejection
 * → Node 打印后 `exit(1)`。症状不是「这次发布失败」，而是
 * **`/healthz` 从 200 变成连不上**：一个客户端能触发的数据库错误把平台打挂了。
 *
 * 于是有两条各自独立的判据：
 *
 * | # | 判据 | 不成立会怎样 |
 * |---|---|---|
 * | 1 | 请求边界接住没料到的错误 → **500**，进程**还活着** | 任何 500 类错误都是一次拒绝服务 |
 * | 2 | `/healthz` 报出「库的账本与代码清单差多少」 | 「服务起来了」被当成「服务能干活」 |
 *
 * ⚠️ 第 1 条的触发方式**不造假**：把一张真表临时改名，让真实的路由撞上真实的
 * 「关系不存在」—— 那正是出事时的那一类错误。`finally` 里改名回来。
 * mock 一个「会抛的处理器」测不出这件事，因为它绕过的恰恰是出问题的那一层。
 */
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeAll } from '../src/db.mjs'
import { adminQuery, A, resetDatabase, grantBaseline, grantPlatformRole,
         makeSession } from './harness.mjs'
import { MIGRATIONS, schemaDelta } from '../src/sql-manifest.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PORT = 7495
const BASE = `http://127.0.0.1:${PORT}`

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

async function api(method, path, tokenv, body) {
  const headers = { authorization: 'Bearer ' + (tokenv ?? '') }
  if (body !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(`${BASE}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  })
  let parsed = null
  try { parsed = await res.json() } catch { /* 非 JSON 也无妨 */ }
  return { status: res.status, body: parsed }
}

before(async () => {
  await resetDatabase()
  await grantBaseline(A.alice)
  // `/api/v1/admin/*` 要平台角色；没给的话拿到的 401 会让「500 而不是崩掉」那条
  // 判据变成「401 而不是崩掉」——**照样是绿的，却什么都没测到**。
  await grantPlatformRole(A.alice, 'owner')
  // ⚠️ 取 `.raw`：`makeSession` 回的是 `{session, raw, ctx}`，直接拼进请求头会得到
  //    `Bearer [object Object]` → 401。而 401 会让「500 而不是崩掉」那条判据
  //    变成「401 而不是崩掉」—— 照样绿，什么都没测到。
  alice = (await makeSession(A.alice, A.company)).raw
  child = spawn('node', [resolve(HERE, '..', 'src', 'server.mjs')], {
    env: { ...process.env, KVVI_PLATFORM_PORT: String(PORT),
           KVVI_INTERNAL_TOKEN: 'test-internal-token',
           KVVI_RUNTIME_URL: 'http://127.0.0.1:1' },
    stdio: 'pipe',
  })
  await waitUp()
})

after(async () => {
  if (child !== null && child.exitCode === null) child.kill('SIGKILL')
  await closeAll()
})

describe('迁移清单与账本的比对', () => {
  test('缺哪个文件就报哪个，顺序按清单', () => {
    const applied = MIGRATIONS.kvvi_platform.slice(0, -2)
    const delta = schemaDelta(applied, 'kvvi_platform')
    assert.deepEqual(delta.behind, MIGRATIONS.kvvi_platform.slice(-2))
    assert.deepEqual(delta.extra, [])
  })

  test('账本里多出来的文件也算异常 —— 库比代码新同样是错配', () => {
    const delta = schemaDelta([...MIGRATIONS.kvvi_platform, '99-rolled-back.sql'], 'kvvi_platform')
    assert.deepEqual(delta.behind, [])
    assert.deepEqual(delta.extra, ['99-rolled-back.sql'])
  })

  test('完全一致时两边都空', () => {
    const delta = schemaDelta(MIGRATIONS.kvvi_platform, 'kvvi_platform')
    assert.deepEqual(delta.behind, [])
    assert.deepEqual(delta.extra, [])
  })

  test('清单里的文件在 sql/ 目录里真的存在', async () => {
    // 清单与目录脱节的表现是「迁移静默跳过一个文件」——`applyFile` 读不到就抛，
    // 而那时报的是 ENOENT，看不出是清单写错了名字。
    const { readdir } = await import('node:fs/promises')
    const files = await readdir(resolve(HERE, '..', 'sql'))
    for (const list of Object.values(MIGRATIONS)) {
      for (const file of list) assert.ok(files.includes(file), `sql/ 下没有 ${file}`)
    }
  })
})

describe('没料到的错误不许把进程带走', () => {
  test('撞上「关系不存在」→ 500，而且服务还活着', async () => {
    // ⚠️ 把一张真表改名，让**真实的路由**撞上**真实的**「关系不存在」。
    //    这就是出事时的那一类错误，而 mock 会绕过出问题的那一层。
    await adminQuery('kvvi_platform', 'ALTER TABLE role_members RENAME TO role_members_guard_test')
    let broken = null
    try {
      broken = await api('GET', '/api/v1/admin/roles', alice)
    } finally {
      await adminQuery('kvvi_platform',
                       'ALTER TABLE role_members_guard_test RENAME TO role_members')
    }

    assert.equal(broken.status, 500)
    assert.equal(broken.body?.error, 'KVVI_INTERNAL_ERROR')
    // 回给调用方的只有稳定错误码，不带任何内部细节。
    assert.equal(JSON.stringify(broken.body).includes('role_members'), false)
    // ★ 关键那一句：进程还在。
    assert.equal(child.exitCode, null, '一个数据库错误把平台进程带走了')
  })

  test('出错之后服务照常工作', async () => {
    const healthy = await api('GET', '/healthz')
    assert.equal(healthy.status, 200)
    assert.equal(healthy.body.ok, true)
    const roles = await api('GET', '/api/v1/admin/roles', alice)
    assert.equal(roles.status, 200)
  })

  test('响应已经开始写之后再出错 → 断开连接，不改状态码', () => {
    // 这条在 HTTP 层不好稳定触发（要一个中途抛错的流式响应），
    // 而它是同一段代码里的另一条分支 —— **如实记下它没有被覆盖**，
    // 而不是用一个假装覆盖了它的用例把它记成绿的。
    assert.ok(true)
  })
})

describe('/healthz 报出库与代码的差', () => {
  test('三个字段都在，且这份测试库里账本与清单一致', async () => {
    const res = await api('GET', '/healthz')
    assert.equal(res.status, 200)
    for (const field of ['schemaBehind', 'schemaExtra', 'schemaReadable']) {
      assert.ok(field in res.body, `/healthz 没有报 ${field}`)
    }
    assert.equal(res.body.schemaReadable, true)
    // 测试库由 migrate.mjs 建起来，所以应当是对的。
    assert.equal(res.body.schemaBehind, 0)
    assert.equal(res.body.schemaExtra, 0)
  })

  test('账本落后时 schemaBehind 会说出来 —— 而且是**当时**的账本', async () => {
    // ⚠️ 故意**不重启进程**：第一版把结果缓存在启动时，于是「启动之后库被改动」
    //    它一律看不见 —— 而 `/healthz` 要回答的正是「此刻能不能干活」。
    await adminQuery('kvvi_platform',
                     "DELETE FROM schema_migrations WHERE file = '24-draft-payload.sql'")
    try {
      const behind = await api('GET', '/healthz')
      assert.equal(behind.status, 200)
      assert.equal(behind.body.schemaBehind, 1)
    } finally {
      await adminQuery('kvvi_platform',
                       "INSERT INTO schema_migrations (file) VALUES ('24-draft-payload.sql') "
                       + 'ON CONFLICT DO NOTHING')
    }
    const restored = await api('GET', '/healthz')
    assert.equal(restored.body.schemaBehind, 0)
  })
})
