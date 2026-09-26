/**
 * 阶段十一 · 任务二：**一次性首次初始化**。
 *
 * 判据是「一台从未安装过 KVVI 的机器，装完之后只能有一个所有者，而且之后再也建不出第二个」。
 *
 * | # | 性质 | 不成立会怎样 |
 * |---|---|---|
 * | 1 | 第二次调用 → **410**，且公司数、账号数都不变 | 「一次性」只是一句话，任何到得了端口的人都能再建一个所有者 |
 * | 2 | 中断不留半成品：公司/账号/成员/角色/标记同事务 | 留下「一家没有人的公司」或「能登录但不是所有者的人」 |
 * | 3 | 没有配置令牌 → **拒绝**，不是放行 | 「没配等于不校验」在生产里就是没有门 |
 * | 4 | 令牌不对 → 401 且留痕（**进程日志**，不是审计链 —— 那时还没有公司） | 猜令牌变成一件不留痕迹的事 |
 * | 5 | 登录名撞了 → 409，且**公司也一起回滚** | 半成品公司 |
 *
 * ⚠️ 第 2 条的断言必须查**每一张表**，不能只看状态码：
 * 一个「先建公司、再建账号、失败后不清理」的实现同样返回 409，
 * 而库里已经躺着一家没有人的公司。
 */
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { pool, closeAll } from '../src/db.mjs'
import { resetDatabase } from './harness.mjs'
import { bootstrapOwner, bootstrapState, bootstrapRoutes, MIN_PASSWORD_LENGTH }
  from '../src/bootstrap.mjs'

const TOKEN = 'stage11-one-time-bootstrap-token'
const STRONG = 'kvvi-owner-pass'

/**
 * 各表的当前计数。断言「什么都没变」时逐张查。
 *
 * ⚠️ **一律用相对量，不用绝对值。** `resetDatabase()` 会灌固定装置 ——
 * 里面有 **两家公司、两个账号**（§4 的跨公司测试要用它们）。所以
 * 「reset 之后应该是 0 家」是错的：第一版就是这么写的，于是
 * 「没有令牌却建出了公司 2 !== 0」红了，而代码根本没建任何公司。
 * **夹具的初始状态属于夹具，测试只能断言自己的增量。**
 */
async function counts() {
  const out = {}
  for (const [name, sql] of [
    ['companies', 'SELECT count(*)::int AS n FROM companies'],
    ['users', 'SELECT count(*)::int AS n FROM users'],
    ['memberships', 'SELECT count(*)::int AS n FROM memberships'],
    ['roles', 'SELECT count(*)::int AS n FROM roles'],
    ['roleMembers', 'SELECT count(*)::int AS n FROM role_members'],
  ]) {
    out[name] = (await pool('platform').query(sql)).rows[0].n
  }
  return out
}

before(async () => {
  await resetDatabase()
})
after(closeAll)

describe('阶段十一 · 一次性首次初始化', () => {
  test('★ 首次调用建出公司、所有者、成员关系与所有者角色', async () => {
    const before_ = await counts()
    const result = await bootstrapOwner({
      token: TOKEN, expectedToken: TOKEN,
      companyName: '示例公司', login: 'owner', password: STRONG,
    })
    assert.equal(result.status, 201, JSON.stringify(result.body))

    const after_ = await counts()
    assert.equal(after_.companies, before_.companies + 1)
    assert.equal(after_.users, before_.users + 1)
    assert.equal(after_.memberships, before_.memberships + 1)
    assert.equal(after_.roles, before_.roles + 1)
    assert.equal(after_.roleMembers, before_.roleMembers + 1)

    // 这一条才是「所有者」：他必须真的持有平台保留角色 `owner` ——
    // 否则能登录却什么都管不了，而界面不会解释为什么。
    const role = await pool('platform').query(
      `SELECT r.role_code FROM role_members rm
         JOIN roles r ON r.role_id = rm.role_id
        WHERE rm.user_id = $1`, [result.body.userId])
    assert.deepEqual(role.rows.map((r) => r.role_code), ['owner'])

    const state = await bootstrapState()
    assert.equal(state.completed, true)
  })

  test('★ 第二次调用 → 410，且**每张表的计数都不变**', async () => {
    const before_ = await counts()
    const result = await bootstrapOwner({
      token: TOKEN, expectedToken: TOKEN,
      companyName: '第二家公司', login: 'owner2', password: STRONG,
    })
    assert.equal(result.status, 410)
    assert.equal(result.body.error, 'KVVI_BOOTSTRAP_CLOSED')

    const after_ = await counts()
    assert.deepEqual(after_, before_,
      '第二次调用改了数据 —— 那就不是「一次性」')
  })

  test('★ 并发调用只有一个能成 —— 判据是唯一约束，不是先查后写', async () => {
    // 换一个全新的库来测并发：上面已经用掉了这个实例的那一次。
    await resetDatabase()
    const before_ = await counts()
    const results = await Promise.all([
      bootstrapOwner({ token: TOKEN, expectedToken: TOKEN,
        companyName: 'A 公司', login: 'ownerA', password: STRONG }),
      bootstrapOwner({ token: TOKEN, expectedToken: TOKEN,
        companyName: 'B 公司', login: 'ownerB', password: STRONG }),
    ])
    const created = results.filter((r) => r.status === 201)
    const closed = results.filter((r) => r.status === 410)
    assert.equal(created.length, 1, `并发下建了 ${created.length} 个所有者`)
    assert.equal(closed.length, 1)

    const after_ = await counts()
    assert.equal(after_.companies, before_.companies + 1,
      '并发下建出了不止一家公司')
    // 输的那一次不能留下半成品。
    assert.equal(after_.memberships, before_.memberships + 1)
    assert.equal(after_.users, before_.users + 1)
    assert.equal(after_.roles, before_.roles + 1)
  })

  test('★ 没有配置令牌 → 拒，不是放行', async () => {
    await resetDatabase()
    const before_ = await counts()
    const result = await bootstrapOwner({
      token: TOKEN, expectedToken: '',
      companyName: 'X', login: 'owner', password: STRONG,
    })
    assert.equal(result.status, 401)
    assert.equal(result.body.error, 'KVVI_BOOTSTRAP_TOKEN_REQUIRED')
    assert.deepEqual(await counts(), before_, '没有令牌却建出了公司')
  })

  test('★ 令牌不对 → 401，且什么都没建', async () => {
    const before_ = await counts()
    const result = await bootstrapOwner({
      token: 'wrong', expectedToken: TOKEN,
      companyName: 'X', login: 'owner', password: STRONG,
    })
    assert.equal(result.status, 401)
    assert.equal(result.body.error, 'KVVI_BOOTSTRAP_TOKEN_INVALID')
    assert.deepEqual(await counts(), before_, '令牌不对却改动了数据')
  })

  test('★ 不含公司的拒绝写**进程日志**，不写审计链', async () => {
    // ⚠️ 判据变了。审计链按公司串起来，`audit_entries.company_id` 是 NOT NULL，
    //    而 bootstrap 被拒时**还没有公司** —— 那正是这件事的含义。
    //    硬塞空值撞 NOT NULL；造一个「系统公司」当哨兵会让「谁是这家公司的成员」
    //    多出一个假成员。两者都比一行 stderr 更坏。
    //    所以这条测的是「拒绝**确实留了痕**」，只是痕在不同地方。
    // ⚠️ 用 `spawnSync` 而不是 `execFileSync`：后者**丢掉 stderr**，
    //    而「进程日志」正是写去 stderr 的。第一版因此断言不到任何东西 ——
    //    一条永远失败的用例，而它看起来像「留痕没实现」。
    const { spawnSync } = await import('node:child_process')
    const script = `
      import { bootstrapOwner } from '${new URL('../src/bootstrap.mjs', import.meta.url).href}'
      const r = await bootstrapOwner({ token: 'wrong', expectedToken: '${TOKEN}',
        companyName: 'X', login: 'owner', password: '${STRONG}' })
      process.stdout.write('STATUS=' + r.status)
    `
    const run = spawnSync('node', ['--input-type=module', '--eval', script],
      { encoding: 'utf8', env: { ...process.env } })
    assert.match(run.stdout, /STATUS=401/)
    assert.match(run.stderr, /kvvi-bootstrap-denied/, '拒绝没有留下任何痕迹')
    assert.match(run.stderr, /KVVI_BOOTSTRAP_TOKEN_INVALID/)
  })

  test('口令太短 → 400，且不建公司', async () => {
    const before_ = await counts()
    const result = await bootstrapOwner({
      token: TOKEN, expectedToken: TOKEN,
      companyName: 'X', login: 'owner', password: 'x'.repeat(MIN_PASSWORD_LENGTH - 1),
    })
    assert.equal(result.status, 400)
    assert.equal(result.body.error, 'KVVI_BOOTSTRAP_WEAK_PASSWORD')
    assert.deepEqual(await counts(), before_)
  })

  test('★ 登录名撞了 → 409，且**公司也一起回滚**', async () => {
    // ⚠️ 不去删标记来「重开入口」：那需要 `instance_bootstrap` 的 DELETE 权限，
    //    而生产角色不该有它（装完之后没人该删这一行）。
    //    改成造出「登录名已被占用」的局面 —— 那才是这条要测的条件。
    await resetDatabase()
    const { A } = await import('./harness.mjs')
    await pool('platform').query(
      `INSERT INTO users (user_id, login, password_hash, status)
       VALUES (gen_random_uuid(), 'taken', 'x', 'ACTIVE')`)

    const before_ = await counts()
    const result = await bootstrapOwner({
      token: TOKEN, expectedToken: TOKEN,
      companyName: '第一家公司', login: 'taken', password: STRONG,
    })
    assert.equal(result.status, 409)
    assert.equal(result.body.error, 'KVVI_LOGIN_EXISTS')
    // ⚠️ 逐张表查：先建公司再失败于建账号的实现同样返回 409，而公司已经落库。
    assert.deepEqual(await counts(), before_,
      '失败的 bootstrap 留下了半成品 —— 多半是一家没有人的公司')
    void A
  })

  test('GET /bootstrap/state 只回「做过没有」，不回显身份', async () => {
    const state = await bootstrapRoutes({ method: 'GET', path: '/bootstrap/state',
      body: null, expectedToken: TOKEN })
    assert.equal(state.status, 200)
    assert.deepEqual(Object.keys(state.body), ['completed'])
    // 未鉴权端点回显公司 id 就是一个枚举入口。
    assert.equal(state.body.companyId, undefined)
  })

  test('不是本模块的路径 → null（交给别的分派）', async () => {
    const routed = await bootstrapRoutes({ method: 'GET', path: '/auth/session',
      body: null, expectedToken: TOKEN })
    assert.equal(routed, null)
  })

  test('★ 无论调多少次，所有者角色始终只有一个人持有', async () => {
    // 自成一体：reset 之后自己 bootstrap，不依赖前面用例留下的状态。
    await resetDatabase()
    const owners = async () => (await pool('platform').query(
      `SELECT count(*)::int AS n FROM role_members rm
         JOIN roles r ON r.role_id = rm.role_id
        WHERE r.role_code = 'owner'`)).rows[0].n
    const seeded = await owners()
    await bootstrapOwner({ token: TOKEN, expectedToken: TOKEN,
      companyName: '示例公司', login: 'owner', password: STRONG })
    assert.equal(await owners(), seeded + 1)
    // 再调两次，独占性不能被破坏。
    for (const login of ('owner2', 'owner3')) {
      await bootstrapOwner({ token: TOKEN, expectedToken: TOKEN,
        companyName: '另一家', login, password: STRONG })
    }
    assert.equal(await owners(), seeded + 1, '第二次调用也建出了所有者')
  })
})
