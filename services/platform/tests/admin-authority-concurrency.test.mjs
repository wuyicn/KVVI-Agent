import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { pool, closeAll, dsns } from '../src/db.mjs'
import { A, resetDatabase, grantPlatformRole, makeSession, adminQuery } from './harness.mjs'
import { adminRoutes } from '../src/admin-api.mjs'
import { handleAuth } from '../src/auth.mjs'
import { handleApi } from '../src/api-router.mjs'
import { grantBuilderAccess } from '../src/mode-policy.mjs'
import { verifyToken } from '../src/identity.mjs'
import { runtimeContextHeaders, RUNTIME_CONTEXT_MAX_AGE_MS } from '../src/runtime-auth.mjs'

let owner, delegate, targetRole
beforeEach(async () => {
  await resetDatabase()
  await grantPlatformRole(A.alice, 'owner')
  await grantPlatformRole(A.carol, 'admin')
  owner = await makeSession(A.alice, A.company)
  delegate = await makeSession(A.carol, A.company)
  const role = await pool('platform').query(
    `INSERT INTO roles (role_id,company_id,role_code,name) VALUES (gen_random_uuid(),$1,'target','fixture') RETURNING role_id`, [A.company])
  targetRole = role.rows[0].role_id
  await pool('platform').query(
    `INSERT INTO policies (policy_id,company_id,role_id,dimension,resource_code,actions,data_scopes)
     VALUES (gen_random_uuid(),$1,$2,'DATA','*','{}','{SELF}')`, [A.company, targetRole])
})
after(closeAll)

async function withBlocker(prepare, request, verify, expectedWaiters = 1, beforeRelease = async () => {}) {
  const url = new URL(dsns().admin); url.pathname = '/kvvi_platform'
  const blocker = new pg.Client({ connectionString: url.toString() })
  await blocker.connect()
  let pending
  try {
    await blocker.query('BEGIN')
    const { rows: [{ pid }] } = await blocker.query('SELECT pg_backend_pid() AS pid')
    await blocker.query('SELECT 1 FROM companies WHERE company_id=$1 FOR NO KEY UPDATE', [A.company])
    await prepare(blocker)
    pending = request().then(value => ({ value }), error => ({ error }))
    const deadline = Date.now() + 5000
    let blocked = false
    while (Date.now() < deadline) {
      await blocker.query('SELECT pg_stat_clear_snapshot()')
      const waiters = await blocker.query(`WITH RECURSIVE waiting(pid) AS (
        SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))
        UNION SELECT a.pid FROM pg_stat_activity a JOIN waiting w ON w.pid=ANY(pg_blocking_pids(a.pid))
      ) SELECT pid FROM waiting`, [pid])
      if (waiters.rowCount >= expectedWaiters) { blocked = true; break }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.ok(blocked, 'real request must wait on the owned PostgreSQL transaction')
    await beforeRelease()
    await blocker.query('COMMIT')
    const settled = await pending
    if (settled.error) throw settled.error
    await verify(settled.value)
  } finally {
    await blocker.query('ROLLBACK'); await blocker.end()
    if (pending) await pending
  }
}

async function revokeDelegate(client) {
  await client.query(`DELETE FROM role_members WHERE user_id=$1 AND role_id IN
    (SELECT role_id FROM roles WHERE company_id=$2 AND role_code='admin')`, [A.carol, A.company])
  await client.query('UPDATE users SET authz_version=authz_version+1 WHERE user_id=$1', [A.carol])
  await client.query("UPDATE sessions SET state='ENDED',ended_by='ADMIN_REVOKED',ended_at=now() WHERE session_id=$1", [delegate.ctx.sessionId])
}
const putPolicies = () => adminRoutes({ method: 'PUT', path: '/roles/target/policies',
  payload: { policies: [{ dimension: 'DATA', resourceCode: '*', dataScopes: ['COMPANY'] }] }, session: delegate.ctx })
async function unchangedPolicies(result) {
  const policies = await pool('platform').query('SELECT data_scopes FROM policies WHERE role_id=$1', [targetRole])
  assert.deepEqual({ status: result.status, scopes: policies.rows.map(row => row.data_scopes) },
    { status: 403, scopes: [['SELF']] })
  const audit = await pool('auditRead').query(
    "SELECT outcome FROM audit_entries WHERE actor_id=$1 AND action LIKE 'admin.%'", [delegate.ctx.userId])
  assert.deepEqual(audit.rows, [{ outcome: 'DENY' }])
}

test('queued policy update cannot use a revoked admin authority', { timeout: 15000 }, async () => {
  await withBlocker(async client => {
    await client.query('SELECT 1 FROM policies WHERE role_id=$1 FOR UPDATE', [targetRole])
    await revokeDelegate(client)
  }, putPolicies, unchangedPolicies)
})

test('queued policy update cannot grant itself through a concurrent role membership', { timeout: 15000 }, async () => {
  await withBlocker(async client => {
    await client.query('SELECT 1 FROM policies WHERE role_id=$1 FOR UPDATE', [targetRole])
    await client.query('INSERT INTO role_members (company_id,role_id,user_id) VALUES ($1,$2,$3)', [A.company, targetRole, A.carol])
    await client.query('UPDATE users SET authz_version=authz_version+1 WHERE user_id=$1', [A.carol])
  }, putPolicies, unchangedPolicies)
})

test('legacy role grant rechecks the actor after an actual foreign-key lock wait', { timeout: 15000 }, async () => {
  await withBlocker(async client => {
    await client.query('SELECT 1 FROM roles WHERE role_id=$1 FOR UPDATE', [targetRole])
    await revokeDelegate(client)
  }, () => handleAuth({ method: 'POST', path: '/auth/roles/grant',
    body: { roleCode: 'target', userIds: [A.bob] }, headers: { 'x-kvvi-actor-token': delegate.raw } }), async result => {
    const members = await pool('platform').query('SELECT 1 FROM role_members WHERE role_id=$1 AND user_id=$2', [targetRole, A.bob])
    assert.deepEqual({ status: result.status, members: members.rowCount }, { status: 403, members: 0 })
  })
})

test('queued Builder admin cannot write after Builder access is revoked', { timeout: 15000 }, async () => {
  await grantBuilderAccess(owner.ctx, A.carol)
  delegate = await makeSession(A.carol, A.company, 'BUILDER')
  await withBlocker(async client => {
    await client.query('SELECT 1 FROM policies WHERE role_id=$1 FOR UPDATE', [targetRole])
    await client.query('DELETE FROM platform_mode_grants WHERE company_id=$1 AND user_id=$2', [A.company, A.carol])
    await client.query('UPDATE users SET authz_version=authz_version+1 WHERE user_id=$1', [A.carol])
    await client.query("UPDATE sessions SET state='ENDED',ended_by='ADMIN_REVOKED',ended_at=now() WHERE session_id=$1", [delegate.ctx.sessionId])
  }, putPolicies, unchangedPolicies)
})

test('queued owner cannot write after owner authority is revoked', { timeout: 15000 }, async () => {
  await grantPlatformRole(A.bob, 'owner')
  delegate = await makeSession(A.bob, A.company)
  await withBlocker(async client => {
    await client.query('SELECT 1 FROM policies WHERE role_id=$1 FOR UPDATE', [targetRole])
    await client.query(`DELETE FROM role_members WHERE user_id=$1 AND role_id IN
      (SELECT role_id FROM roles WHERE company_id=$2 AND role_code='owner')`, [A.bob, A.company])
    await client.query('UPDATE users SET authz_version=authz_version+1 WHERE user_id=$1', [A.bob])
    await client.query("UPDATE sessions SET state='ENDED',ended_by='ADMIN_REVOKED',ended_at=now() WHERE session_id=$1", [delegate.ctx.sessionId])
  }, putPolicies, unchangedPolicies)
})

test('queued delegated-token authority is rechecked even while its session stays active', { timeout: 15000 }, async () => {
  await withBlocker(async client => {
    await client.query('SELECT 1 FROM policies WHERE role_id=$1 FOR UPDATE', [targetRole])
    await client.query('UPDATE delegation_tokens SET revoked_at=now() WHERE token_id=$1', [delegate.ctx.tokenId])
  }, putPolicies, unchangedPolicies)
})

test('two queued owners removing each other preserve one active owner without a deadlock', { timeout: 15000 }, async () => {
  await grantPlatformRole(A.bob, 'owner')
  const other = await makeSession(A.bob, A.company)
  await withBlocker(async () => {}, () => Promise.all([
    adminRoutes({ method: 'DELETE', path: `/members/${A.bob}/platform-role/owner`, payload: null, session: owner.ctx }),
    adminRoutes({ method: 'DELETE', path: `/members/${A.alice}/platform-role/owner`, payload: null, session: other.ctx }),
  ]), async results => {
    assert.equal(results.filter(value => value.status === 200).length, 1)
    assert.ok(results.every(value => [200, 403, 409].includes(value.status)))
    const owners = await pool('platform').query(`SELECT rm.user_id FROM role_members rm JOIN roles r ON r.role_id=rm.role_id
      JOIN users u ON u.user_id=rm.user_id WHERE r.company_id=$1 AND r.role_code='owner' AND u.status='ACTIVE'`, [A.company])
    assert.equal(owners.rowCount, 1)
    assert.equal(Number(Boolean(await verifyToken(owner.raw))) + Number(Boolean(await verifyToken(other.raw))), 1)
  }, 2)
})

test('legacy multi-user grant rolls back every member and authorization version after a real insert fault', async () => {
  const versions = () => pool('platform').query(
    'SELECT user_id,authz_version FROM users WHERE user_id=ANY($1::uuid[]) ORDER BY user_id', [[A.bob, A.alice]])
  const before = (await versions()).rows
  await adminQuery('kvvi_platform', `CREATE FUNCTION fail_role_grant() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.user_id='${A.alice}'::uuid THEN RAISE EXCEPTION 'TEST_ROLE_GRANT_FAILURE'; END IF; RETURN NEW; END $$`)
  await adminQuery('kvvi_platform', 'CREATE TRIGGER fail_role_grant BEFORE INSERT ON role_members FOR EACH ROW EXECUTE FUNCTION fail_role_grant()')
  try {
    await assert.rejects(() => handleAuth({ method: 'POST', path: '/auth/roles/grant',
      body: { roleCode: 'target', userIds: [A.bob, A.alice] }, headers: { 'x-kvvi-actor-token': delegate.raw } }), /TEST_ROLE_GRANT_FAILURE/)
    assert.equal((await pool('platform').query('SELECT 1 FROM role_members WHERE role_id=$1', [targetRole])).rowCount, 0)
    assert.deepEqual((await versions()).rows, before)
    const audit = await pool('auditRead').query("SELECT 1 FROM audit_entries WHERE action='auth.grantRole' AND outcome='ALLOW'")
    assert.equal(audit.rowCount, 0)
  } finally {
    await adminQuery('kvvi_platform', 'DROP TRIGGER fail_role_grant ON role_members')
    await adminQuery('kvvi_platform', 'DROP FUNCTION fail_role_grant()')
  }
})

const realApiPut = () => handleApi({ method: 'PUT', path: '/api/v1/admin/roles/target/policies', query: '',
  body: JSON.stringify({ policies: [{ dimension: 'DATA', resourceCode: '*', dataScopes: ['COMPANY'] }] }),
  headers: { authorization: `Bearer ${delegate.raw}` },
  loadSession: token => handleAuth({ method: 'GET', path: '/auth/session', body: null,
    headers: { authorization: `Bearer ${token}` } }) })
for (const change of ['revoke', 'expire']) {
  test(`actual API preserves original token ${change} information through its session adapter`, { timeout: 15000 }, async () => {
    await withBlocker(async client => {
      if (change === 'revoke') await client.query('UPDATE delegation_tokens SET revoked_at=clock_timestamp() WHERE token_id=$1', [delegate.ctx.tokenId])
      else await client.query("UPDATE delegation_tokens SET expires_at=clock_timestamp()-interval '1 second' WHERE token_id=$1", [delegate.ctx.tokenId])
    }, realApiPut, unchangedPolicies)
  })
}

test('signed runtime context must still be current after its management lock wait', { timeout: 15000 }, async () => {
  const previous = process.env.KVVI_INTERNAL_TOKEN
  process.env.KVVI_INTERNAL_TOKEN = 'test-management-runtime-context'
  const issuedAt = Date.now() - RUNTIME_CONTEXT_MAX_AGE_MS + 2000
  const headers = runtimeContextHeaders(delegate.ctx, process.env.KVVI_INTERNAL_TOKEN, issuedAt)
  try {
    await withBlocker(async () => {}, () => handleApi({ method: 'PUT',
      path: '/api/v1/admin/roles/target/policies', query: '',
      body: JSON.stringify({ policies: [{ dimension: 'DATA', resourceCode: '*', dataScopes: ['COMPANY'] }] }),
      headers, loadSession: () => { throw new Error('runtime request cannot use a browser credential') } }),
    unchangedPolicies, 1, () => new Promise(resolve => setTimeout(resolve,
      Math.max(0, issuedAt + RUNTIME_CONTEXT_MAX_AGE_MS + 25 - Date.now()))))
  } finally {
    if (previous === undefined) delete process.env.KVVI_INTERNAL_TOKEN
    else process.env.KVVI_INTERNAL_TOKEN = previous
  }
})
