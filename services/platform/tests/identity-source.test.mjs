/**
 * N16 残 · 身份源适配器路口（PRD §3.4）。
 *
 * 首版只实现内置账号。本文件测的是**路口本身**：
 * 接口存在、形状被约束、且**授权拿不到它这条路**。
 */
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { pool, closeAll } from '../src/db.mjs'
import { A, PASSWORD, resetDatabase, grantBaseline } from './harness.mjs'
import { authenticateVia, registerSource, sources, assertIdentityShape,
         builtinAdapter } from '../src/identity-sources.mjs'
import { createSession } from '../src/identity.mjs'

before(async () => {
  await resetDatabase()
  await grantBaseline(A.alice)
})
after(closeAll)

describe('N16 §3.4 身份源适配器：路口', () => {
  test('首版注册了内置账号这一个源', () => {
    assert.deepEqual(sources(), ['builtin'])
  })

  test('内置账号：凭据对 → 返回归一化身份', async () => {
    const id = await authenticateVia('builtin', { login: 'alice', password: PASSWORD })
    assert.equal(id.userId, A.alice)
    assert.equal(id.source, 'builtin')
    assert.equal(id.externalId, 'alice')
    assert.ok(id.companyIds.includes(A.company))
  })

  test('内置账号：凭据错 → null（不是抛出）', async () => {
    assert.equal(await authenticateVia('builtin', { login: 'alice', password: 'x' }), null)
    assert.equal(await authenticateVia('builtin', { login: 'nobody', password: 'x' }), null)
  })

  test('★ 未注册的身份源 → 拒（不注册即不可达）', async () => {
    await assert.rejects(
      () => authenticateVia('dingtalk', {}),
      (e) => e.message.includes('KVVI_UNKNOWN_IDENTITY_SOURCE'))
  })

  test('★ 归一化后的身份**不含任何权限字段**（§3.4.1）', async () => {
    const id = await authenticateVia('builtin', { login: 'alice', password: PASSWORD })
    const forbidden = ['roles', 'roleIds', 'scopes', 'dataScopes', 'gateway',
                       'permissions', 'isOwner', 'canBuild']
    for (const key of forbidden) {
      assert.equal(key in id, false, `身份里出现了权限字段 ${key} —— 授权正在外移`)
    }
    assert.deepEqual(Object.keys(id).sort(),
      ['companyIds', 'externalId', 'source', 'status', 'userId'])
  })

  test('★ 适配器若「顺手返回角色」→ 直接被拒（形状校验）', () => {
    assert.throws(
      () => assertIdentityShape({ userId: 'u', source: 'x', externalId: 'e',
                                  status: 'ACTIVE', companyIds: [], roles: ['owner'] }),
      (e) => e.message.includes('KVVI_ADAPTER_RETURNED_FORBIDDEN_FIELDS:roles'))
  })

  test('形状校验：缺字段也拒', () => {
    assert.throws(
      () => assertIdentityShape({ userId: 'u', source: 'x' }),
      (e) => e.message.includes('KVVI_ADAPTER_IDENTITY_INCOMPLETE'))
  })

  test('★ 第三个适配器可以注册进来，且**不动地基**', async () => {
    // 一个假的外部 IdP：只回答「你是谁」。
    registerSource({
      code: 'fake-idp',
      async authenticate({ assertion }) {
        if (assertion !== 'valid') return null
        return { userId: A.alice, source: 'fake-idp', externalId: 'alice@corp',
                 status: 'ACTIVE', companyIds: await companiesOfFake(A.alice) }
      },
    })
    const id = await authenticateVia('fake-idp', { assertion: 'valid' })
    assert.equal(id.source, 'fake-idp')
    assert.equal(id.externalId, 'alice@corp')
    assert.ok(sources().includes('fake-idp'))
  })

  test('★ 适配器**拿不到会话**：建会话仍是 KVVI 的决定（§9.9.3）', async () => {
    // 适配器只产出身份；「会话绑定哪家公司」由 KVVI 决定，不由 IdP 指定。
    const id = await authenticateVia('builtin', { login: 'alice', password: PASSWORD })
    const session = await createSession({ userId: id.userId, companyId: A.company,
                                          gateway: 'USER' })
    assert.equal(session.companyId, A.company)
    // 身份里没有公司选择权 —— 它只列出归属，不表达「用哪家」
    assert.equal('activeCompanyId' in id, false)
  })

  test('注册非法适配器 → 拒', () => {
    assert.throws(() => registerSource({ code: 'x' }), /KVVI_BAD_SOURCE_ADAPTER/)
    assert.throws(() => registerSource(null), /KVVI_BAD_SOURCE_ADAPTER/)
  })

  test('内置适配器可独立构造（便于将来替换）', () => {
    const a = builtinAdapter()
    assert.equal(a.code, 'builtin')
    assert.equal(typeof a.authenticate, 'function')
  })
})

async function companiesOfFake(userId) {
  const { rows } = await pool('platform').query(
    'SELECT company_id FROM memberships WHERE user_id = $1', [userId])
  return rows.map((r) => r.company_id)
}
