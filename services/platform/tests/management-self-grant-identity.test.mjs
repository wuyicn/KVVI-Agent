import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { pool, closeAll } from '../src/db.mjs'
import { A, resetDatabase, grantPlatformRole, makeSession } from './harness.mjs'
import { adminRoutes } from '../src/admin-api.mjs'
import { handleAuth } from '../src/auth.mjs'

let owner, roleId
beforeEach(async () => {
  await resetDatabase()
  await grantPlatformRole(A.alice, 'owner')
  owner = await makeSession(A.alice, A.company)
  const role = await pool('platform').query(
    `INSERT INTO roles (role_id,company_id,role_code,name) VALUES (gen_random_uuid(),$1,'target','fixture') RETURNING role_id`, [A.company])
  roleId = role.rows[0].role_id
})
after(closeAll)
for (const entry of ['admin', 'legacy']) {
  test(`${entry} role grant cannot treat an uppercase UUID as a different person`, async () => {
    const payload = { roleCode: 'target', userIds: [A.alice.toUpperCase()] }
    const response = entry === 'admin'
      ? await adminRoutes({ method: 'POST', path: '/roles/target/members', payload, session: owner.ctx })
      : await handleAuth({ method: 'POST', path: '/auth/roles/grant', body: payload,
        headers: { 'x-kvvi-actor-token': owner.raw } })
    const membership = await pool('platform').query('SELECT 1 FROM role_members WHERE role_id=$1 AND user_id=$2', [roleId, A.alice])
    assert.deepEqual({ status: response.status, memberships: membership.rowCount }, { status: 403, memberships: 0 })
    assert.equal(response.body.error, 'KVVI_SELF_GRANT_FORBIDDEN')
  })
}
