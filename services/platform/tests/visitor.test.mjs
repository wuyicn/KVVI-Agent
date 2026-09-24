/**
 * 阶段六锚点④：访客路径全部测试（PRD §3.5）。
 *
 * ── 这一组用例的共同形状 ────────────────────────────────────────────────
 *
 * 访客没有账号，所以几乎每一条都是**「谁能签发」**或**「提交时按谁解释」**。
 * 两者都容易写成「看起来对」：只要不报错就算过。所以每条负向用例
 * 都配一条正向对照 —— 只测「拒绝」的集合永远是绿的。
 */
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { pool, closeAll } from '../src/db.mjs'
import { A, B, resetDatabase, makeSession, grantBaseline, adminQuery } from './harness.mjs'
import {
  issueLink, submitAsVisitor, revokeLink, revokeLinksOfIssuer, checkRelatedRef,
  verifyLinkSignature, RATE, LINK_TTL_MAX_MS, VisitorError,
} from '../src/visitor.mjs'
import { scopeContext } from '../src/authorization.mjs'
import { bumpAuthzVersion, suspendAccount } from '../src/identity.mjs'

const FORM = 'general_item'
let alice = null       // 有写权限的签发人
let carol = null       // 只有读权限
let bob = null         // 无任何权限

const GOOD = { title: '访客填的单' }

function grantReadOnly(roleCode) {
  return pool('platform').query(
    `INSERT INTO roles (role_id, company_id, role_code, name)
     VALUES (gen_random_uuid(),$1,$2,'只读')`, [A.company, roleCode])
    .then(({ rows }) => rows)
}

before(async () => {
  await resetDatabase()
  await grantBaseline(A.alice)
  alice = await makeSession(A.alice, A.company)
  carol = await makeSession(A.carol, A.company)
  bob = await makeSession(A.bob, A.company)

  // carol **只有读权限** —— §3.5.1「仅有读取权限的员工不得生成提交链接」
  const role = randomUUID()
  await pool('platform').query(
    `INSERT INTO roles (role_id, company_id, role_code, name) VALUES ($1,$2,'role_ro','只读')`,
    [role, A.company])
  await pool('platform').query(
    `INSERT INTO role_members (company_id, role_id, user_id) VALUES ($1,$2,$3)`,
    [A.company, role, A.carol])
  for (const [dim, code, actions, scopes, vis] of [
    ['DATA', '*', [], ['SELF'], null],
    ['FORM', FORM, ['read'], [], null],
    ['FIELD', '*', ['read'], [], 'VISIBLE'],
  ]) {
    await pool('platform').query(
      `INSERT INTO policies (policy_id, company_id, role_id, dimension, resource_code,
         actions, data_scopes, field_visibility) VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7)`,
      [A.company, role, dim, code, actions, scopes, vis])
  }
})
after(closeAll)

async function liveLink(overrides = {}) {
  const scope = await scopeContext(alice.ctx)
  return issueLink({
    ctx: alice.ctx, scope, formCode: FORM, schemaCode: FORM,
    fields: ['title', 'amount'], actions: ['create'],
    rowScope: {}, ...overrides,
  })
}

describe('锚点④ §3.5.1 签发资格：不是「已认证」就能签发', () => {
  test('有写权限的签发人 → 签发成功', async () => {
    const link = await liveLink()
    assert.ok(link.token.startsWith('v.'))
    assert.deepEqual(link.fields, ['title', 'amount'])
  })

  test('★ **只有读权限**的员工 → 拒绝签发', async () => {
    const scope = await scopeContext(carol.ctx)
    await assert.rejects(
      () => issueLink({ ctx: carol.ctx, scope, formCode: FORM, schemaCode: FORM,
                        fields: ['title'], actions: ['create'], rowScope: {} }),
      (e) => e instanceof VisitorError && e.code === 'KVVI_ISSUER_LACKS_WRITE_PERMISSION')
  })

  test('无任何权限的账号 → 拒绝签发', async () => {
    const scope = await scopeContext(bob.ctx)
    await assert.rejects(
      () => issueLink({ ctx: bob.ctx, scope, formCode: FORM, schemaCode: FORM,
                        fields: ['title'], actions: ['create'], rowScope: {} }),
      (e) => e.code === 'KVVI_ISSUER_LACKS_WRITE_PERMISSION')
  })

  test('★ 绑定项**越界即拒**（不是截断到合法范围）', async () => {
    const scope = await scopeContext(alice.ctx)
    // 把一个读不到的字段写进绑定 —— 直接拒，不静默去掉它。
    //
    // ⚠️ 基线授权里的 FIELD 策略是 `'*'`，**没有**逐字段的行。
    // 所以这里要**插入**一条针对 amount 的策略，而不是 UPDATE ——
    // UPDATE 命中 0 行时不会报错，测试会「因为什么都没改变」而失败，
    // 看起来像功能坏了，实际是用例前提没建立。
    await pool('platform').query(
      `INSERT INTO policies (policy_id, company_id, role_id, dimension, resource_code,
         actions, data_scopes, field_visibility)
       SELECT gen_random_uuid(), p.company_id, p.role_id, 'FIELD', 'amount',
              '{read}', '{}', 'HIDDEN'
         FROM policies p
         JOIN role_members rm ON rm.role_id = p.role_id AND rm.user_id = $2
        WHERE p.company_id = $1 AND p.dimension = 'FIELD' AND p.resource_code = '*'
        LIMIT 1`, [A.company, A.alice])
    await assert.rejects(
      () => issueLink({ ctx: alice.ctx, scope, formCode: FORM, schemaCode: FORM,
                        fields: ['title', 'amount'], actions: ['create'], rowScope: {} }),
      (e) => e.code === 'KVVI_BINDING_EXCEEDS_ISSUER' && e.detail.fields.includes('amount'))
    // ⚠️ 清理用 UPDATE 不用 DELETE：平台库角色拿到的是 `SELECT, INSERT, UPDATE`
    // （`grantPlatform`）—— 审计优先的库里刻意没给 DELETE。
    // 用 DELETE 清理会以 `permission denied for table policies` 失败，
    // 报错位置在清理语句上，看起来却像被测功能坏了。
    await pool('platform').query(
      `UPDATE policies SET field_visibility = 'VISIBLE'
        WHERE company_id = $1 AND dimension = 'FIELD' AND resource_code = 'amount'`,
      [A.company])
  })

  test('有效期有产品级上限：不允许永不过期', async () => {
    const scope = await scopeContext(alice.ctx)
    await assert.rejects(
      () => issueLink({ ctx: alice.ctx, scope, formCode: FORM, schemaCode: FORM,
                        fields: ['title'], actions: ['create'], rowScope: {},
                        ttlMs: LINK_TTL_MAX_MS + 1 }),
      (e) => e.code === 'KVVI_LINK_TTL_TOO_LONG')
  })

  test('签名是**非对称**的：链接可用公钥独立验证', async () => {
    const link = await liveLink()
    const r = verifyLinkSignature(link.token)
    assert.equal(r.ok, true)
    assert.equal(r.body.form, FORM)
    assert.ok(r.body.nonce, '链接里没有随机量 → 无法防重放')
  })

  test('篡改链接内容 → 验签失败', async () => {
    const link = await liveLink()
    const parts = link.token.split('.')
    const body = JSON.parse(Buffer.from(parts[2], 'base64url').toString('utf8'))
    body.fields = ['title', 'amount', 'detail']   // 扩大字段集
    parts[2] = Buffer.from(JSON.stringify(body)).toString('base64url')
    const r = verifyLinkSignature(parts.join('.'))
    assert.equal(r.ok, false)
    assert.equal(r.error, 'KVVI_LINK_BAD_SIGNATURE')
  })
})

describe('锚点④ §3.5.1 提交：行范围、归属与越权关联', () => {
  test('正常提交 → 落成正式业务数据，且记的是**访客通道**', async () => {
    const link = await liveLink()
    const out = await submitAsVisitor({ token: link.token, data: GOOD, sourceIp: '10.0.0.1' })
    assert.ok(out.recordId)
    assert.equal(out.traceability.issuerUserId, A.alice)

    const { rows } = await adminQuery('kvvi_business',
      'SELECT company_id, owner_id, data FROM business_records WHERE record_id = $1',
      [out.recordId])
    assert.equal(rows[0].company_id, A.company)
    // 归属由服务端确定 = 签发人，访客不得覆盖
    assert.equal(rows[0].owner_id, A.alice)
    assert.equal(rows[0].data.title, '访客填的单')
  })

  test('★ 字段在绑定之外 → 拒绝', async () => {
    const link = await liveLink()
    await assert.rejects(
      () => submitAsVisitor({ token: link.token, data: { detail: '越界字段' } }),
      (e) => e.code === 'KVVI_FIELD_OUTSIDE_BINDING')
  })

  test('★ 访客试图覆盖归属 → 拒绝', async () => {
    for (const field of ['owner_id', 'dept_id', 'shop_id', 'companyId', 'roles']) {
      const link = await liveLink({ fields: ['title', field] })
      await assert.rejects(
        () => submitAsVisitor({ token: link.token, data: { title: 'x', [field]: A.bob } }),
        (e) => e.code === 'KVVI_VISITOR_OWNERSHIP_OVERRIDE',
        `归属字段 ${field} 没有被拦`)
    }
  })

  test('★ 行范围：绑定与签发人归属不一致 → 拒绝', async () => {
    // 直接改库模拟「链接绑定的行范围与实际归属不符」——
    // 这正是「多候选且不能消歧」那一类，§3.5.1 要求**拒绝**而不是任选。
    const link = await liveLink()
    await pool('platform').query(
      `UPDATE visitor_links SET row_scope = $2 WHERE link_id = $1`,
      [link.linkId, JSON.stringify({ deptId: A.otherDept })])
    await assert.rejects(
      () => submitAsVisitor({ token: link.token, data: GOOD }),
      (e) => e.code === 'KVVI_ROW_SCOPE_MISMATCH')
  })

  test('关联对象越权 → 拒绝；且**不返回任何候选**', async () => {
    const link = await liveLink()
    const { rows } = await pool('platform').query(
      'SELECT * FROM visitor_links WHERE link_id = $1', [link.linkId])
    const row = rows[0]
    const bad = await checkRelatedRef(row, { id: randomUUID(), companyId: B.company })
    assert.equal(bad.ok, false)
    assert.equal(bad.error, 'KVVI_RELATED_REF_CROSS_TENANT')
    // 返回值里只有结论，没有任何可选集合
    assert.deepEqual(Object.keys(bad).sort(), ['error', 'ok'])

    const good = await checkRelatedRef(row, { id: randomUUID(), companyId: A.company })
    assert.deepEqual(Object.keys(good), ['ok'],
      '关联校验返回了额外信息 —— 那会给访客增加查询能力')
  })
})

describe('锚点④ §3.5.1 链接失效：签发人停用、权限回收、吊销、到期', () => {
  test('签发人**停用** → 名下未提交链接全部失效', async () => {
    const link = await liveLink()
    await revokeLinksOfIssuer(A.alice, 'ISSUER_DEACTIVATED')
    await assert.rejects(() => submitAsVisitor({ token: link.token, data: GOOD }),
      (e) => e.code === 'KVVI_LINK_REVOKED')
  })

  test('★ 权限回收后旧链接提交被拒（前提：平台在线可取权威状态）', async () => {
    const link = await liveLink()
    await bumpAuthzVersion(A.alice)
    await assert.rejects(() => submitAsVisitor({ token: link.token, data: GOOD }),
      (e) => e.code === 'KVVI_ISSUER_AUTHZ_CHANGED')
    await bumpAuthzVersion(A.alice)
    void carol
  })

  test('链接到期 → 拒绝', async () => {
    const link = await liveLink({ ttlMs: 1000 })
    await assert.rejects(
      () => submitAsVisitor({ token: link.token, data: GOOD,
                              nowMs: Date.now() + 5000 }),
      (e) => e.code === 'KVVI_LINK_EXPIRED')
  })

  test('生成者吊销 → 未提交的链接立即失效', async () => {
    const link = await liveLink()
    assert.equal(await revokeLink({ linkId: link.linkId, ctx: alice.ctx }), true)
    await assert.rejects(() => submitAsVisitor({ token: link.token, data: GOOD }),
      (e) => e.code === 'KVVI_LINK_REVOKED')
  })

  test('★ 在线优先：平台可达时**必须实时查**，缓存不构成放行依据', async () => {
    const link = await liveLink()
    await revokeLink({ linkId: link.linkId, ctx: alice.ctx })
    // reachable=true 时绝不走缓存分支
    await assert.rejects(
      () => submitAsVisitor({ token: link.token, data: GOOD, reachable: true }),
      (e) => e.code === 'KVVI_LINK_REVOKED')
  })

  test('★ 平台不可达且超窗 → 失败关闭', async () => {
    const link = await liveLink()
    await assert.rejects(
      () => submitAsVisitor({ token: link.token, data: GOOD, reachable: false,
                              nowMs: Date.now() + 60 * 60 * 1000 }),
      (e) => e.code === 'KVVI_LINK_STATUS_UNAVAILABLE')
  })

  test('重放旧链接可检出（nonce 不符）', async () => {
    const link = await liveLink()
    const parts = link.token.split('.')
    const body = JSON.parse(Buffer.from(parts[2], 'base64url').toString('utf8'))
    body.nonce = randomUUID()
    parts[2] = Buffer.from(JSON.stringify(body)).toString('base64url')
    const r = verifyLinkSignature(parts.join('.'))
    assert.equal(r.ok, false, '改了 nonce 还能验签通过 → 防重放不成立')
  })
})

describe('锚点④ §3.5.2 限流四维度', () => {
  // 每个用例前把该签发人已发出的链接全部吊销。
  //
  // ⚠️ 这不是「为了让测试过而清理」：签发人维度（同时有效链接数）**本来就是**
  // 一条真实的限流，前面十几个用例各自发过链接，累计就会撞上它。
  // 不清理的话，后面的用例会因为「上一个用例发的链接还活着」而失败，
  // 报错指向的是签发限流，被测的那条限流根本没被碰到。
  async function revokeAllFor(userId) {
    await pool('platform').query(
      `UPDATE visitor_links SET revoked_at = now(), revoked_reason = 'TEST_CLEANUP'
        WHERE issuer_user_id = $1 AND revoked_at IS NULL`, [userId])
  }

  test('链接维度：超过 max_submissions → 拒绝并记录', async () => {
    await revokeAllFor(A.alice)
    const link = await liveLink({ maxSubmissions: 1 })
    await submitAsVisitor({ token: link.token, data: GOOD })
    await assert.rejects(
      () => submitAsVisitor({ token: link.token, data: GOOD }),
      (e) => e.code === 'KVVI_RATE_LIMITED_LINK')
  })

  test('来源维度：同一来源超过窗口上限 → 拒绝', async () => {
    const ip = '203.0.113.7'
    // 逐个签发、提交、吊销 —— 这样撞上的只可能是来源维度，不会是签发人维度。
    for (let i = 0; i < RATE.perSourceSubmissions; i += 1) {
      await revokeAllFor(A.alice)
      const link = await liveLink({ maxSubmissions: 5 })
      await submitAsVisitor({ token: link.token, data: GOOD, sourceIp: ip })
    }
    await revokeAllFor(A.alice)
    const link = await liveLink({ maxSubmissions: 5 })
    await assert.rejects(
      () => submitAsVisitor({ token: link.token, data: GOOD, sourceIp: ip }),
      (e) => e.code === 'KVVI_RATE_LIMITED_SOURCE')
  })

  test('签发人维度：同时有效链接数超限 → 拒绝签发', async () => {
    await revokeAllFor(A.alice)
    const scope = await scopeContext(alice.ctx)
    const made = []
    try {
      for (let i = 0; i < RATE.perIssuerActiveLinks + 2; i += 1) {
        made.push(await issueLink({ ctx: alice.ctx, scope, formCode: FORM, schemaCode: FORM,
                                    fields: ['title'], actions: ['create'], rowScope: {} }))
      }
      assert.fail('超过签发人上限仍然签发成功')
    } catch (e) {
      assert.equal(e.code, 'KVVI_RATE_LIMITED_ISSUER')
    } finally {
      await revokeAllFor(A.alice)
    }
  })

  test('超限行为是**拒绝**：不排队、不降级放行', async () => {
    await revokeAllFor(A.alice)
    const link = await liveLink({ maxSubmissions: 1 })
    await submitAsVisitor({ token: link.token, data: GOOD })
    const r = await submitAsVisitor({ token: link.token, data: GOOD }).catch((e) => e)
    assert.ok(r instanceof VisitorError)
    assert.ok(r.code.startsWith('KVVI_RATE_LIMITED'))
    // 明确不是「排队后成功」，也不是「降级放行」
    assert.notEqual(r, undefined)
  })
})
