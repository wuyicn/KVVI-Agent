import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { A, B, resetDatabase, grantPlatformRole, makeSession, pool, closeAll } from './harness.mjs'
import {
  allowedGateways, grantBuilderAccess, revokeBuilderAccess,
} from '../src/mode-policy.mjs'

let ownerCtx

before(async () => {
  await resetDatabase()
  await grantPlatformRole(A.alice, 'owner')
  ownerCtx = (await makeSession(A.alice, A.company, 'BUILDER')).ctx
})

after(async () => { await closeAll() })

describe('Stage 8：搭建模式资格由服务端按公司判定', () => {
  test('普通员工不能进入 BUILDER', async () => {
    assert.deepEqual(await allowedGateways(A.company, A.bob), ['USER'])
  })

  test('所有者与被所有者明确授权的成员可以进入 BUILDER', async () => {
    assert.deepEqual(await allowedGateways(A.company, A.alice), ['USER', 'BUILDER'])
    await grantBuilderAccess(ownerCtx, A.bob)
    assert.deepEqual(await allowedGateways(A.company, A.bob), ['USER', 'BUILDER'])
  })

  test('搭建权限严格按公司隔离', async () => {
    assert.deepEqual(await allowedGateways(B.company, B.dave), ['USER'])
    assert.deepEqual(await allowedGateways(A.company, A.bob), ['USER', 'BUILDER'])
  })

  test('非所有者不能授予或收回搭建权限', async () => {
    const employeeCtx = { ...ownerCtx, userId: A.bob, gateway: 'USER' }
    await assert.rejects(() => grantBuilderAccess(employeeCtx, A.carol),
      /KVVI_OWNER_REQUIRED/)
    await assert.rejects(() => revokeBuilderAccess(employeeCtx, A.bob),
      /KVVI_OWNER_REQUIRED/)
  })

  test('收回权限会终止已有 Builder 会话并提高授权版本', async () => {
    const beforeVersion = await pool('platform').query(
      'SELECT authz_version FROM users WHERE user_id = $1', [A.bob])
    const builder = await makeSession(A.bob, A.company, 'BUILDER')

    await revokeBuilderAccess(ownerCtx, A.bob)

    assert.deepEqual(await allowedGateways(A.company, A.bob), ['USER'])
    const session = await pool('platform').query(
      'SELECT state, ended_by FROM sessions WHERE session_id = $1',
      [builder.session.sessionId])
    assert.deepEqual(session.rows[0], { state: 'ENDED', ended_by: 'ADMIN_REVOKED' })
    const afterVersion = await pool('platform').query(
      'SELECT authz_version FROM users WHERE user_id = $1', [A.bob])
    assert.equal(afterVersion.rows[0].authz_version,
      beforeVersion.rows[0].authz_version + 1)
  })
})
