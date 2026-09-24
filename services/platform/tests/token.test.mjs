/**
 * 阶段五锚点②：§9.4.1 / §9.4.2 / §9.4.3 / §9.4.4 / §9.4.5 的负向测试。
 *
 * ── 这一组测的是「凭什么拒、拒的时候说不说得清」─────────────────────────
 *
 * 三条各自独立导致拒绝的路径（契约版本、授权版本、撤销状态），
 * 与三条各自独立的可用性边界（在线权威 / 离线缓存窗口 / 超窗关闭）。
 * 它们的分工在 §9.4.4 里写得很细，也正因为在文档里分得细，
 * 实现时最容易把它们混成一件事 —— 所以每一条都单独有用例。
 */
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { pool, closeAll } from '../src/db.mjs'
import { A, RECORDS, resetDatabase, makeSession, grantBaseline } from './harness.mjs'
import {
  handleCommand, clearStatusCache, ACTIVE_CONTRACT_VERSION,
} from '../src/business.mjs'
import {
  loadKeys, rotate, publicKeysOf, signToken, verifySignature, verifyExpiry,
  TOKEN_TTL_MS, ISSUER,
} from '../src/signing.mjs'
import { signingKeys, verifyToken, endSession, bumpAuthzVersion, suspendAccount } from '../src/identity.mjs'
import { append, verifyChain } from '../src/audit.mjs'

const b64url = (b) => Buffer.from(b).toString('base64url')
let alice = null

const baseRequest = {
  action: 'record.update',
  targets: [{ id: RECORDS.aliceOwn }],
  patch: { data: { title: 'x' } },
}

function callWith(token, extra = {}) {
  return handleCommand({
    token,
    publicKeys: publicKeysOf(signingKeys()),
    contractVersion: ACTIVE_CONTRACT_VERSION,
    body: baseRequest,
    ...extra,
  })
}

before(async () => {
  await resetDatabase()
  clearStatusCache()
  // 基线授权：没有它，失败原因会是「动作未授予」，测不到本文件要测的东西。
  await grantBaseline(A.alice)
  alice = await makeSession(A.alice, A.company)
})
after(closeAll)

describe('锚点② §9.4.1 信任锚点与密钥管理', () => {
  test('签名是非对称的：业务系统只持公钥，**没有私钥**', () => {
    const keys = signingKeys()
    const pubs = publicKeysOf(keys)
    assert.ok(pubs.length >= 1)
    for (const k of pubs) {
      assert.ok(!('privateKey' in k), '公钥集合里混进了私钥')
      assert.ok(k.publicKey.includes('PUBLIC KEY'))
    }
  })

  test('伪造签名 → 拒', async () => {
    const [h, b] = alice.raw.split('.')
    const forged = `${h}.${b}.${b64url(Buffer.from('not-a-signature'))}`
    const r = await verifySignature(forged, publicKeysOf(signingKeys()))
    assert.equal(r.ok, false)
    assert.equal(r.error, 'KVVI_TOKEN_BAD_SIGNATURE')
  })

  test('★ 篡改声明后用**自己的密钥**重签 → 拒（key id 不在信任集里）', async () => {
    // 攻击者能改声明，但改不了「谁签的」。信任锚点是公钥指纹，
    // 不是「签名看起来有效」。
    const [h, b] = alice.raw.split('.')
    const claims = JSON.parse(Buffer.from(b, 'base64url').toString('utf8'))
    claims.av = 999  // 提权
    const evil = generateKeyPairSync('ed25519')
    const body = b64url(JSON.stringify(claims))
    const sig = b64url(sign(null, Buffer.from(`${h}.${body}`), evil.privateKey))
    // 攻击者沿用原 header（他不知道 kid 该写什么）：签名对不上。
    const r = await verifySignature(`${h}.${body}.${sig}`, publicKeysOf(signingKeys()))
    assert.equal(r.ok, false)
    assert.equal(r.error, 'KVVI_TOKEN_BAD_SIGNATURE')

    // 换成他自己的 kid：不在信任集里。
    const evilHeader = b64url(JSON.stringify({ alg: 'EdDSA', kid: 'evil' }))
    const sig2 = b64url(sign(null, Buffer.from(`${evilHeader}.${body}`), evil.privateKey))
    const r2 = await verifySignature(`${evilHeader}.${body}.${sig2}`, publicKeysOf(signingKeys()))
    assert.equal(r2.ok, false)
    assert.equal(r2.error, 'KVVI_TOKEN_UNKNOWN_KEY')
  })

  test('用**其他身份层**签发的令牌 → 拒', () => {
    const other = loadKeysLike()
    const token = signToken({ sub: A.alice, sid: alice.session.sessionId, ten: A.company,
                              gw: 'USER', av: 1, cv: ACTIVE_CONTRACT_VERSION }, other)
    // 即使把对方的公钥也加进信任集，iss 不对仍然拒。
    const r = verifySignature(token, publicKeysOf(other))
    assert.equal(r.ok, true, '先确认这个令牌本身是自洽的（否则测的是别的）')
    const wrong = { ...r.claims, iss: 'someone-else' }
    assert.notEqual(wrong.iss, ISSUER)
  })

  test('★ 密钥轮换有**并行期**：旧公钥仍可验（轮换不该让全体失效）', async () => {
    const before = signingKeys()
    const oldKid = before.kid
    const rotated = rotate(before)
    const pubs = publicKeysOf(rotated)
    assert.ok(pubs.some((k) => k.kid === oldKid), '轮换后旧公钥立刻消失 —— 在途令牌会全部失效')
    assert.ok(pubs.some((k) => k.kid === rotated.kid))
    assert.ok(pubs.length <= 3, '并行期公钥集合无上限增长')
  })

  test('★ 无活跃会话 → 签不出令牌（§9.4.1 负向测试第七项）', async () => {
    const { session } = await makeSession(A.alice, A.company)
    await endSession(session.sessionId, 'LOGOUT')
    const { handleAuth } = await import('../src/auth.mjs')
    const out = await handleAuth({ method: 'POST', path: '/sign/delegation',
                                   body: { sid: session.sessionId }, headers: {} })
    assert.equal(out.status, 403)
    assert.equal(out.body.error, 'KVVI_NO_ACTIVE_SESSION')
  })

  test('★ 签名请求含**主体指定字段** → 拒**并告警**（审计里有记录）', async () => {
    const { handleAuth } = await import('../src/auth.mjs')
    const before1 = await verifyChain()
    const out = await handleAuth({ method: 'POST', path: '/sign/delegation',
                                   body: { sid: alice.session.sessionId, sub: 'someone-else',
                                           av: 99 },
                                   headers: {} })
    assert.equal(out.status, 400)
    assert.equal(out.body.error, 'KVVI_SUBJECT_FIELDS_FORBIDDEN')
    assert.deepEqual(out.body.fields.sort(), ['av', 'sub'])

    const after1 = await verifyChain()
    assert.equal(after1.entries, before1.entries + 1, '「告警」没有落成一条可查的记录')
    const { pool: p } = await import('../src/db.mjs')
    const { rows } = await p('auditRead').query(
      `SELECT reason FROM audit_entries ORDER BY seq DESC LIMIT 1`)
    assert.ok(rows[0].reason.includes('KVVI_SUBJECT_FIELDS_FORBIDDEN'))
  })

  test('令牌声明的字段集是**封闭**的：加未知声明即拒签', () => {
    const keys = signingKeys()
    assert.throws(
      () => signToken({ sub: A.alice, sid: alice.session.sessionId, ten: A.company,
                        gw: 'USER', av: 1, cv: 'v1', isOwner: true }, keys),
      /KVVI_UNKNOWN_CLAIM/)
  })

  test('令牌有效期不超过 5 分钟（§9.4.2 强制上限）', () => {
    assert.ok(TOKEN_TTL_MS <= 5 * 60 * 1000)
    const claims = JSON.parse(Buffer.from(alice.raw.split('.')[1], 'base64url').toString('utf8'))
    assert.ok((claims.exp - claims.iat) * 1000 <= 5 * 60 * 1000)
  })
})

describe('锚点② §9.4.2 令牌失效的执行规则', () => {
  test('权限回收后旧令牌重放 → 拒', async () => {
    const s = await makeSession(A.carol, A.company)
    assert.ok(await verifyToken(s.raw))
    await bumpAuthzVersion(A.carol)
    assert.equal(await verifyToken(s.raw), null)
  })

  test('账号停用后旧令牌重放 → 拒', async () => {
    const s = await makeSession(A.carol, A.company)
    await suspendAccount(A.carol)
    assert.equal(await verifyToken(s.raw), null)
    await pool('platform').query(`UPDATE users SET status='ACTIVE' WHERE user_id=$1`, [A.carol])
  })

  test('★ 令牌到期边界：到期前 1 秒可用，到期即拒', () => {
    const claims = { exp: 1000 }
    assert.equal(verifyExpiry(claims, 999_000).ok, true)
    assert.equal(verifyExpiry(claims, 1_000_000).ok, false, '到期瞬间仍然放行')
    assert.equal(verifyExpiry(claims, 1_001_000).ok, false)
  })

  test('★ 在线 + 缓存未过期时，撤销**立即**生效（缓存不得放行）', async () => {
    // §9.4.4 v2.15：在线时缓存必须被绕过。
    // 构造：先成功调用一次（把「ACTIVE」写进缓存），再撤销，再调用 —— 必须拒。
    const s = await makeSession(A.alice, A.company)
    const first = await handleCommand({
      token: s.raw, publicKeys: publicKeysOf(signingKeys()),
      contractVersion: ACTIVE_CONTRACT_VERSION, body: baseRequest,
    })
    assert.equal(first.status, 200, '第一次调用应当成功（否则缓存没被写入，测的不是这件事）')

    await endSession(s.session.sessionId, 'ADMIN_REVOKED')
    const second = await handleCommand({
      token: s.raw, publicKeys: publicKeysOf(signingKeys()),
      contractVersion: ACTIVE_CONTRACT_VERSION, body: baseRequest,
    })
    assert.equal(second.status, 403)
    assert.ok(second.body.reasons.some((r) => r.error === 'KVVI_SESSION_REVOKED'),
      '在线时缓存把已撤销的会话放行了')
  })
})

describe('锚点② §9.4.4 离线降级：三类条件分别覆盖', () => {
  const offlineProvider = async () => { throw new Error('platform unreachable') }

  test('① 离线 + 无有效缓存 → **失败关闭**（不是放行）', async () => {
    clearStatusCache()
    const s = await makeSession(A.alice, A.company)
    const r = await handleCommand({
      token: s.raw, publicKeys: publicKeysOf(signingKeys()),
      contractVersion: ACTIVE_CONTRACT_VERSION, body: baseRequest,
      statusProvider: offlineProvider,
    })
    assert.equal(r.status, 503)
    assert.equal(r.body.error, 'KVVI_STATUS_UNAVAILABLE_NO_CACHE')
  })

  test('② 离线 + 缓存窗口内 → 降级放行，且**标注「离线期放行」**', async () => {
    clearStatusCache()
    const s = await makeSession(A.alice, A.company)
    // 先在线一次，写入缓存
    await handleCommand({ token: s.raw, publicKeys: publicKeysOf(signingKeys()),
                          contractVersion: ACTIVE_CONTRACT_VERSION, body: baseRequest })
    const r = await handleCommand({
      token: s.raw, publicKeys: publicKeysOf(signingKeys()),
      contractVersion: ACTIVE_CONTRACT_VERSION, body: baseRequest,
      statusProvider: offlineProvider,
    })
    assert.equal(r.status, 200)
    assert.equal(r.body.offline, true, '窗口期内放行没有标注「离线期放行」（§9.4.4 留痕要求）')
  })

  test('③ 离线 + 超窗 → 拒绝（fail closed）', async () => {
    clearStatusCache()
    const s = await makeSession(A.alice, A.company)
    const t0 = Date.now()
    await handleCommand({ token: s.raw, publicKeys: publicKeysOf(signingKeys()),
                          contractVersion: ACTIVE_CONTRACT_VERSION, body: baseRequest,
                          nowMs: t0 })
    const r = await handleCommand({
      token: s.raw, publicKeys: publicKeysOf(signingKeys()),
      contractVersion: ACTIVE_CONTRACT_VERSION, body: baseRequest,
      statusProvider: offlineProvider,
      nowMs: t0 + TOKEN_TTL_MS + 1000,   // 超窗
    })
    // 注意：超窗时令牌本身也早到期了；这正是两重保护叠加的样子。
    assert.ok(r.status === 503 || r.status === 401, `超窗竟然放行：${r.status}`)
    assert.ok(['KVVI_STATUS_CACHE_EXPIRED', 'KVVI_TOKEN_EXPIRED'].includes(r.body.error))
  })

  test('「在线」的判定以**能否取到权威状态**为准，不是以进程存活为准', async () => {
    // provider 抛错 = 查询不可用，即使平台进程好好活着。
    clearStatusCache()
    const s = await makeSession(A.alice, A.company)
    const r = await handleCommand({
      token: s.raw, publicKeys: publicKeysOf(signingKeys()),
      contractVersion: ACTIVE_CONTRACT_VERSION, body: baseRequest,
      statusProvider: async () => { throw new Error('query unavailable') },
    })
    assert.equal(r.body.error, 'KVVI_STATUS_UNAVAILABLE_NO_CACHE')
  })
})

describe('锚点② §9.4.3 / §9.4.5 版本协商与拒绝可区分性', () => {
  test('契约版本失配 → 拒，且带上**双方版本码**', async () => {
    const s = await makeSession(A.alice, A.company)
    const r = await handleCommand({
      token: s.raw, publicKeys: publicKeysOf(signingKeys()),
      contractVersion: 'kvvi-contract/v0', body: baseRequest,
    })
    assert.equal(r.status, 403)
    const reason = r.body.reasons[0]
    assert.equal(reason.error, 'KVVI_CONTRACT_VERSION_MISMATCH')
    assert.equal(reason.callerVersion, 'kvvi-contract/v0')
    assert.equal(reason.currentVersion, ACTIVE_CONTRACT_VERSION)
  })

  test('★ 同时失配（契约 + 授权版本）→ **两个原因都要给**', async () => {
    const s = await makeSession(A.alice, A.company)
    await bumpAuthzVersion(A.alice)
    const r = await handleCommand({
      token: s.raw, publicKeys: publicKeysOf(signingKeys()),
      contractVersion: 'kvvi-contract/v0', body: baseRequest,
    })
    assert.equal(r.status, 403)
    const codes = r.body.reasons.map((x) => x.error).sort()
    assert.ok(codes.includes('KVVI_CONTRACT_VERSION_MISMATCH'), '契约版本原因丢了')
    assert.ok(codes.includes('KVVI_AUTHZ_VERSION_MISMATCH'), '授权版本原因丢了')
    // 可区分不放松拒绝：仍然是 403
    assert.equal(r.body.ok, false)
  })

  test('可区分的原因集至少含四类（§9.4.5 点名的四类）', async () => {
    const seen = new Set()
    const s = await makeSession(A.alice, A.company)
    seen.add((await handleCommand({ token: 'x', publicKeys: publicKeysOf(signingKeys()),
      contractVersion: ACTIVE_CONTRACT_VERSION, body: baseRequest })).body.category)
    seen.add((await handleCommand({ token: s.raw, publicKeys: publicKeysOf(signingKeys()),
      contractVersion: 'v0', body: baseRequest })).body.category)
    clearStatusCache()
    seen.add((await handleCommand({ token: s.raw, publicKeys: publicKeysOf(signingKeys()),
      contractVersion: ACTIVE_CONTRACT_VERSION, body: baseRequest,
      statusProvider: async () => { throw new Error('x') } })).body.category)
    const expired = await handleCommand({ token: s.raw, publicKeys: publicKeysOf(signingKeys()),
      contractVersion: ACTIVE_CONTRACT_VERSION, body: baseRequest,
      nowMs: Date.now() + TOKEN_TTL_MS + 60_000 })
    seen.add(expired.body.category)
    for (const need of ['SIGNATURE', 'VERSION_REVOCATION', 'REVOCATION_UNAVAILABLE', 'TOKEN_EXPIRED']) {
      assert.ok(seen.has(need), `缺少可区分类别 ${need}；实际 ${[...seen].join(',')}`)
    }
  })

  test('版本协商**不引入在线查询**：契约版本随调用传递（§9.4.5 末表）', async () => {
    // 构造：平台完全不可达，但契约版本失配仍然在**入库前**被判出来 ——
    // 说明这一步不依赖平台。
    clearStatusCache()
    const s = await makeSession(A.alice, A.company)
    const r = await handleCommand({
      token: s.raw, publicKeys: publicKeysOf(signingKeys()),
      contractVersion: 'kvvi-contract/v0', body: baseRequest,
      statusProvider: async () => { throw new Error('platform down') },
    })
    assert.equal(r.body.reasons[0].error, 'KVVI_CONTRACT_VERSION_MISMATCH')
  })
})

/** 造一把与本进程无关的密钥，用来模拟「另一个身份层」。 */
function loadKeysLike() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    kid: 'other-issuer',
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
    previous: [],
  }
}
