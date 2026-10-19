import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { pool, closeAll } from '../src/db.mjs'
import { A, resetDatabase, grantPlatformRole, makeSession } from './harness.mjs'
import { adminRoutes } from '../src/admin-api.mjs'
import { verifyToken } from '../src/identity.mjs'

let owner
beforeEach(async () => {
  await resetDatabase()
  await grantPlatformRole(A.alice, 'owner')
  await pool('platform').query(
    `INSERT INTO roles (role_id,company_id,role_code,name) VALUES (gen_random_uuid(),$1,'admin','fixture')
     ON CONFLICT (company_id,role_code) DO NOTHING`, [A.company])
  owner = await makeSession(A.alice, A.company)
})
after(closeAll)

const remove = (userId, roleCode) => adminRoutes({ method: 'DELETE',
  path: `/members/${userId}/platform-role/${roleCode}`, payload: null, session: owner.ctx })

test('owner may revoke the only delegated admin; that role is not the last owner', async () => {
  await grantPlatformRole(A.carol, 'admin')
  const delegated = await makeSession(A.carol, A.company)
  const result = await remove(A.carol, 'admin')
  const membership = await pool('platform').query(
    `SELECT 1 FROM role_members rm JOIN roles r ON r.role_id=rm.role_id
      WHERE r.company_id=$1 AND r.role_code='admin' AND rm.user_id=$2`, [A.company, A.carol])
  assert.deepEqual({ status: result.status, roleCount: membership.rowCount,
    oldTokenValid: Boolean(await verifyToken(delegated.raw)) },
  { status: 200, roleCount: 0, oldTokenValid: false })
})

test('the last owner remains protected and their session remains active', async () => {
  const result = await remove(A.alice, 'owner')
  assert.equal(result.status, 409)
  assert.equal(result.body.error, 'KVVI_LAST_OWNER')
  assert.ok(await verifyToken(owner.raw))
})

test('removing a nonexistent admin membership is harmless', async () => {
  assert.equal((await remove(A.carol, 'admin')).status, 200)
  assert.ok(await verifyToken(owner.raw))
})
