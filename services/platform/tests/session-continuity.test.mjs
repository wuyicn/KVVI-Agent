/**
 * 浏览器会话凭据与业务令牌的**分离**，以及会话的**受控续发**。
 *
 * ── 这一组为什么必须存在 ────────────────────────────────────────────────
 *
 * 第一版把两件东西合成了一个值：Cookie 里放的就是那张 ≤5 分钟的业务令牌，
 * 而 Cookie 的 `Max-Age` 写的是 1 小时。于是**每一个浏览器会话都在 5 分钟后静默失效**，
 * 而界面在中间那 55 分钟里一句话都不说：
 *
 * | 位置 | 客户看到的东西 |
 * |---|---|
 * | 运行时界面 | 「重新连接中…」，输入框不可用 |
 * | 业务面板 | `KVVI_INVALID_TOKEN`（一个原始错误码） |
 * | 添加工作区 | `Unexpected token '<', "<!DOCTYPE "…`（拿到了登录页 HTML） |
 * | 刚敲完的提示词 | 还留在输入框里，点发送什么都不发生 |
 *
 * 实测里最贵的一次：一次 30 分钟的构建跑到一半，页面死了，
 * 而服务端在**等一个提问的回答** —— 问题从没显示出来。
 *
 * | # | 性质 | 不成立会怎样 |
 * |---|---|---|
 * | 1 | 两张凭据**互换必须失败** | 「分离」只是文档里的一句话，代码上仍是同一个东西 |
 * | 2 | 过期的会话凭据在宽限期内**可以换一张新的** | 睡一觉回来就得重新登录 |
 * | 3 | 宽限期**只对续发端点**开 | 任何过期凭据都能继续用，「过期」就不再是判据 |
 * | 4 | 撤权 / 停用 / 会话结束时**续发当场被拒** | 管理员撤了权，人还能一直用下去 |
 * | 5 | 续发**有限速**，但限速不改判据 | 要么被循环调用打爆，要么把「问得太勤」误报成「会话没了」 |
 */
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  issueBrowserCredential, issueToken, verifyBrowserCredential, verifyToken,
  createSession, endSession, bumpAuthzVersion, loadSession, suspendAccount, signingKeys,
} from '../src/identity.mjs'
import { handleAuth, resetRenewalThrottle } from '../src/auth.mjs'
import { signToken, verifyExpiry, TOKEN_TYPES } from '../src/signing.mjs'
import { pool } from '../src/db.mjs'
import { A, resetDatabase, grantPlatformRole, closeAll } from './harness.mjs'

before(async () => {
  await resetDatabase()
  await grantPlatformRole(A.alice, 'owner')
  resetRenewalThrottle()
})

after(async () => { await closeAll() })

/** 发一张**已经过期**的会话凭据：拿最短的有效期签，再等过它。 */
async function expiredCredential(sessionId) {
  const session = await loadSession(sessionId)
  const raw = signToken({
    sub: session.userId, sid: session.sessionId, ten: session.companyId,
    gw: session.gateway, av: session.authzVersion, cv: 'kvvi-contract/v1',
  }, signingKeys(), { typ: TOKEN_TYPES.BROWSER, ttlMs: 1000 })
  await new Promise((r) => { setTimeout(r, 1200) })
  // 先证明它真的过期了 —— 免得下面的断言其实是在一个没过期的凭据上跑通的。
  assert.equal(verifyExpiry(JSON.parse(Buffer.from(raw.split('.')[1], 'base64url'))).ok, false)
  return raw
}

describe('会话凭据与业务令牌：分离', () => {
  test('★ 会话凭据换不出业务能力，业务令牌也当不了会话凭据', async () => {
    const session = await createSession({ userId: A.alice, companyId: A.company, gateway: 'USER' })
    const { credential } = await issueBrowserCredential(session.sessionId)
    const token = await issueToken(session.sessionId)

    assert.equal(await verifyToken(credential), null,
      '会话凭据被当成了业务令牌 —— 「分离」在代码里不成立')
    assert.equal((await verifyBrowserCredential(token)).ctx, null,
      '业务令牌被当成了会话凭据 —— 5 分钟到期会再次杀死界面')
  })

  test('两张凭据的寿命是两个值，不是一个', async () => {
    const session = await createSession({ userId: A.alice, companyId: A.company, gateway: 'USER' })
    const { credential, expiresAt } = await issueBrowserCredential(session.sessionId)
    const token = await issueToken(session.sessionId)
    const claimOf = (raw) => JSON.parse(Buffer.from(raw.split('.')[1], 'base64url'))
    const sessionLife = expiresAt - claimOf(credential).iat
    const tokenLife = claimOf(token).exp - claimOf(token).iat
    assert.ok(tokenLife <= 5 * 60, `业务令牌必须 ≤5 分钟，实际 ${tokenLife} 秒`)
    assert.ok(sessionLife > tokenLife,
      '两张凭据寿命一样 —— 那它们就还是同一个东西')
  })

  test('签发时不能绕过各自的上限', () => {
    const keys = signingKeys()
    const base = { sub: A.alice, sid: 'session', ten: A.company, gw: 'USER', av: 1, cv: 'v1' }
    assert.throws(() => signToken(base, keys, { typ: TOKEN_TYPES.DELEGATED, ttlMs: 6 * 60 * 1000 }),
      /KVVI_TOKEN_TTL_INVALID/, '业务令牌允许了超过 5 分钟的有效期（§9.4.2）')
    assert.throws(() => signToken(base, keys, { typ: TOKEN_TYPES.BROWSER, ttlMs: 999 * 60 * 60 * 1000 }),
      /KVVI_TOKEN_TTL_INVALID/, '会话凭据允许了无限长的有效期')
    assert.throws(() => signToken(base, keys, { typ: 'whatever' }),
      /KVVI_UNKNOWN_TOKEN_TYPE/)
  })
})

describe('会话续发：受控', () => {
  test('★ 过期的会话凭据在宽限期内仍然有效，并且说得出自己过期了', async () => {
    const session = await createSession({ userId: A.alice, companyId: A.company, gateway: 'USER' })
    const raw = await expiredCredential(session.sessionId)

    const strict = await verifyBrowserCredential(raw)
    assert.equal(strict.ctx, null)
    assert.equal(strict.code, 'KVVI_SESSION_EXPIRED',
      '不给宽限期时，过期凭据必须被拒')

    const lenient = await verifyBrowserCredential(raw, { graceMs: 60_000 })
    assert.notEqual(lenient.ctx, null, '宽限期内应当可以拿它去问会话')
    assert.equal(lenient.expired, true, '必须知道它是过期的 —— 否则无从决定要不要换一张')
  })

  test('★ 睡一觉回来：过期凭据能换到一张新的（这就是「休眠后恢复」）', async () => {
    const session = await createSession({ userId: A.alice, companyId: A.company, gateway: 'USER' })
    const raw = await expiredCredential(session.sessionId)
    resetRenewalThrottle()

    const renewed = await handleAuth({ method: 'POST', path: '/auth/renew',
      headers: { cookie: `kvvi-session=${raw}` }, body: null })
    assert.equal(renewed.status, 200)
    assert.equal(renewed.body.renewedFrom, 'EXPIRED')
    const fresh = await verifyBrowserCredential(renewed.body.credential)
    assert.equal(fresh.expired, false)
    assert.equal(fresh.ctx.userId, A.alice)
  })

  test('★ 管理员撤权之后，续发当场被拒（撤权后停止访问）', async () => {
    const session = await createSession({ userId: A.alice, companyId: A.company, gateway: 'USER' })
    const { credential } = await issueBrowserCredential(session.sessionId)
    resetRenewalThrottle()

    const before = await handleAuth({ method: 'POST', path: '/auth/renew',
      headers: { cookie: `kvvi-session=${credential}` }, body: null })
    assert.equal(before.status, 200)

    await bumpAuthzVersion(A.alice)

    const after = await handleAuth({ method: 'POST', path: '/auth/renew',
      headers: { cookie: `kvvi-session=${credential}` }, body: null })
    assert.equal(after.status, 401)
    assert.equal(after.body.error, 'KVVI_AUTHORIZATION_CHANGED')
    assert.equal(after.body.relogin, true)
    // 撤权之后连「直接用它」也不行 —— 两条路都要断。
    assert.equal((await verifyBrowserCredential(credential)).code, 'KVVI_AUTHORIZATION_CHANGED')
  })

  test('★ 会话被管理员吊销之后，续发当场被拒', async () => {
    const session = await createSession({ userId: A.alice, companyId: A.company, gateway: 'USER' })
    const { credential } = await issueBrowserCredential(session.sessionId)
    resetRenewalThrottle()
    await endSession(session.sessionId, 'ADMIN_REVOKED')

    const out = await handleAuth({ method: 'POST', path: '/auth/renew',
      headers: { cookie: `kvvi-session=${credential}` }, body: null })
    assert.equal(out.status, 401)
    assert.equal(out.body.error, 'KVVI_SESSION_ENDED')
  })

  test('停用账号之后续发同样被拒，且原因与「会话结束」分得开', async () => {
    const session = await createSession({ userId: A.alice, companyId: A.company, gateway: 'USER' })
    const { credential } = await issueBrowserCredential(session.sessionId)
    resetRenewalThrottle()
    await suspendAccount(A.alice)
    const out = await handleAuth({ method: 'POST', path: '/auth/renew',
      headers: { cookie: `kvvi-session=${credential}` }, body: null })
    assert.equal(out.status, 401)
    // 停用会顺带结束会话，所以这里先撞上的是「会话结束」。
    // **要的是它有确切的原因**，不是 500，也不是「未知错误」。
    assert.ok(['KVVI_SESSION_ENDED', 'KVVI_ACCOUNT_NOT_ACTIVE'].includes(out.body.error),
      `停用账号后的拒绝原因不可辨认：${out.body.error}`)
    // 复原，免得影响后面的用例。
    await pool('platform').query("UPDATE users SET status='ACTIVE', authz_version=1 WHERE user_id=$1",
      [A.alice])
  })

  test('没有凭据、伪造凭据、别的种类 —— 一律 401 且原因稳定', async () => {
    resetRenewalThrottle()
    const none = await handleAuth({ method: 'POST', path: '/auth/renew', headers: {}, body: null })
    assert.equal(none.status, 401)
    assert.equal(none.body.error, 'KVVI_SESSION_REQUIRED')

    const bogus = await handleAuth({ method: 'POST', path: '/auth/renew',
      headers: { cookie: 'kvvi-session=not-a-token' }, body: null })
    assert.equal(bogus.status, 401)
    assert.equal(bogus.body.error, 'KVVI_SESSION_UNKNOWN')

    const session = await createSession({ userId: A.alice, companyId: A.company, gateway: 'USER' })
    const token = await issueToken(session.sessionId)
    const wrongKind = await handleAuth({ method: 'POST', path: '/auth/renew',
      headers: { cookie: `kvvi-session=${token}` }, body: null })
    assert.equal(wrongKind.status, 401)
    // 码是 `UNKNOWN` 而不是 `REQUIRED`：调用方**递了**东西，只是递错了种类。
    // 两者都 401，但分开报才有意义 —— 前者是「去登录」，后者是「你拿错凭据了」。
    assert.equal(wrongKind.body.error, 'KVVI_SESSION_UNKNOWN',
      '业务令牌不该能换到一张会话凭据')
  })

  test('★ 续发有限速，而限速**不是**「会话没了」', async () => {
    const session = await createSession({ userId: A.alice, companyId: A.company, gateway: 'USER' })
    const { credential } = await issueBrowserCredential(session.sessionId)
    resetRenewalThrottle()
    const first = await handleAuth({ method: 'POST', path: '/auth/renew',
      headers: { cookie: `kvvi-session=${credential}` }, body: null })
    assert.equal(first.status, 200)
    const second = await handleAuth({ method: 'POST', path: '/auth/renew',
      headers: { cookie: `kvvi-session=${credential}` }, body: null })
    assert.equal(second.status, 429)
    assert.equal(second.body.error, 'KVVI_RENEW_TOO_SOON')
    // ⚠️ 关键：这是「别问这么勤」，不是「你得重新登录」。
    //    回 401 会让前端把人踢到登录页 —— 而会话明明是好的。
    assert.equal(second.body.relogin, false)
    // 新凭据照样发出去：限速拦的是「再签一次」，不是「这一张不作数」。
    assert.equal((await verifyBrowserCredential(second.body.credential)).ctx.userId, A.alice)
  })
})

describe('会话续发：不加宽就是不加宽', () => {
  test('其它路径拿到过期凭据一律拒 —— 宽限期只对续发端点开', async () => {
    const session = await createSession({ userId: A.alice, companyId: A.company, gateway: 'USER' })
    const raw = await expiredCredential(session.sessionId)
    // `/auth/session` 走的是严格校验（`touch:false`，无宽限）。
    const out = await handleAuth({ method: 'GET', path: '/auth/session',
      headers: { cookie: `kvvi-session=${raw}` }, body: null })
    assert.equal(out.status, 401,
      '过期凭据在续发端点之外也被接受了 —— 「过期」于是不再是判据')
  })
})

/**
 * 路由：端点写好了不等于**到得了**。
 *
 * ── 这一条为什么必须补 ──────────────────────────────────────────────────
 *
 * 上面那一组全部直接调 `handleAuth`，**绕过了 `server.mjs` 的路由**。
 * 于是 `/auth/renew` 端点写得再对，只要没进 `USER_AUTH_PATHS`，
 * 真实请求就会被转发给运行时，而运行时的回答是一句小写的 `unauthorized` ——
 * 看起来像「凭据不对」，实际是「这条路径根本没人处理」。
 *
 * 实测就是这么撞的：单元测试全绿，装在试点实例上一调才发现。
 * 手搭的 ctx 测不出路由，这条静态断言补的就是那一段。
 */
describe('路由：新端点必须在「本进程自己应答」的名单里', () => {
  test('★ `/auth/renew` 不会被转发给运行时', async () => {
    const source = await (await import('node:fs/promises'))
      .readFile('src/server.mjs', 'utf8')
    const match = /const USER_AUTH_PATHS = new Set\(\[([\s\S]*?)\]\)/.exec(source)
    assert.notEqual(match, null, '找不到 USER_AUTH_PATHS —— 这段断言的锚点没了')
    for (const path of ['/auth/login', '/auth/logout', '/auth/session', '/auth/renew']) {
      assert.ok(match[1].includes(`'${path}'`),
        `${path} 不在 USER_AUTH_PATHS 里 —— 它会被转发给运行时并得到一句 unauthorized`)
    }
  })
})
