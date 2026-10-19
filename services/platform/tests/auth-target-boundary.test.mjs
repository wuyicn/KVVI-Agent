/** Real signed actor tokens and PG rows; never connect to a pilot database. */
import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { pool, closeAll, dsns } from '../src/db.mjs'
import { A, B, resetDatabase, grantPlatformRole, makeSession, adminQuery } from './harness.mjs'
import { handleAuth } from '../src/auth.mjs'

let owner, foreign, local
beforeEach(async () => {
  await resetDatabase()
  await grantPlatformRole(A.alice, 'owner')
  owner = await makeSession(A.alice, A.company)
  foreign = await makeSession(B.dave, B.company)
  local = await makeSession(A.carol, A.company)
})
after(closeAll)
const post = (path, actor = owner) => handleAuth({ method: 'POST', path, body: {},
  headers: { 'x-kvvi-actor-token': actor.raw } })

async function snapshot(userId, sessionId) {
  const user = await pool('platform').query('SELECT status FROM users WHERE user_id=$1', [userId])
  const session = await pool('platform').query('SELECT state FROM sessions WHERE session_id=$1', [sessionId])
  const tokens = await pool('platform').query(
    'SELECT count(*)::int AS n FROM delegation_tokens WHERE session_id=$1 AND revoked_at IS NOT NULL', [sessionId])
  const events = await pool('platform').query(
    "SELECT count(*)::int AS n FROM session_events WHERE session_id=$1 AND kind!='LOGIN'", [sessionId])
  return { user: user.rows[0]?.status, session: session.rows[0]?.state,
    revoked: tokens.rows[0].n, events: events.rows[0].n }
}

for (const kind of ['account', 'session']) {
  test(`foreign ${kind} target is indistinguishable from absent and has no effect`, async () => {
    const sid = foreign.session.sessionId
    const path = kind === 'account' ? `/auth/accounts/${B.dave}/suspend` : `/auth/sessions/${sid}/revoke`
    const before = await snapshot(B.dave, sid)
    const result = await post(path)
    const unchanged = await snapshot(B.dave, sid)
    assert.deepEqual({ status: result.status, target: unchanged }, { status: 404, target: before })
    const missing = await post(kind === 'account'
      ? '/auth/accounts/ffffffff-ffff-4fff-8fff-ffffffffffff/suspend'
      : '/auth/sessions/ffffffff-ffff-4fff-8fff-ffffffffffff/revoke')
    assert.deepEqual(missing, result)
    const audit = await pool('auditRead').query(
      `SELECT outcome FROM audit_entries WHERE actor_id=$1 AND action=$2 ORDER BY seq`,
      [A.alice, kind === 'account' ? 'auth.suspendAccount' : 'auth.revokeSession'])
    assert.deepEqual(audit.rows, [{ outcome: 'DENY' }, { outcome: 'DENY' }])
  })
}

test('same-company suspension ends sessions and revokes tokens together', async () => {
  const result = await post(`/auth/accounts/${A.carol}/suspend`)
  assert.equal(result.status, 200)
  assert.deepEqual(await snapshot(A.carol, local.session.sessionId),
    { user: 'SUSPENDED', session: 'ENDED', revoked: 1, events: 1 })
})

test('same-company and self revocation remain supported; ended session returns conflict', async () => {
  const path = `/auth/sessions/${local.session.sessionId}/revoke`
  assert.equal((await post(path)).status, 200)
  assert.equal((await post(path)).status, 409)
  const self = await makeSession(A.bob, A.company)
  assert.equal((await post(`/auth/sessions/${self.session.sessionId}/revoke`, self)).status, 200)
})

test('a real session-event failure rolls account status, session and token revocation back', async () => {
  await adminQuery('kvvi_platform', `CREATE FUNCTION fail_suspend_event() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.kind='ACCOUNT_SUSPENDED' THEN RAISE EXCEPTION 'TEST_EVENT_FAILURE'; END IF; RETURN NEW; END $$`)
  await adminQuery('kvvi_platform', `CREATE TRIGGER fail_suspend_event BEFORE INSERT ON session_events
    FOR EACH ROW EXECUTE FUNCTION fail_suspend_event()`)
  const before = await snapshot(A.carol, local.session.sessionId)
  try {
    await assert.rejects(() => post(`/auth/accounts/${A.carol}/suspend`), /TEST_EVENT_FAILURE/)
    assert.deepEqual(await snapshot(A.carol, local.session.sessionId), before)
  } finally {
    await adminQuery('kvvi_platform', 'DROP TRIGGER fail_suspend_event ON session_events')
    await adminQuery('kvvi_platform', 'DROP FUNCTION fail_suspend_event()')
  }
})

test('queued suspension rechecks company membership after its account lock wait', { timeout: 10000 }, async () => {
  await pool('platform').query('INSERT INTO memberships (company_id,user_id) VALUES ($1,$2)', [A.company, B.dave])
  const before = await snapshot(B.dave, foreign.session.sessionId)
  // Membership deletion is a maintenance fixture, not a platform privilege.
  const target = new URL(dsns().admin)
  target.pathname = '/kvvi_platform'
  const blocker = new pg.Client({ connectionString: target.toString() })
  await blocker.connect()
  let pending
  try {
    await blocker.query('BEGIN')
    const { rows: [{ pid }] } = await blocker.query('SELECT pg_backend_pid() AS pid')
    await blocker.query('SELECT 1 FROM users WHERE user_id=$1 FOR UPDATE', [B.dave])
    await blocker.query('DELETE FROM memberships WHERE company_id=$1 AND user_id=$2', [A.company, B.dave])
    pending = post(`/auth/accounts/${B.dave}/suspend`).then(value => ({ value }), error => ({ error }))
    const deadline = Date.now() + 5000
    let blocked = false
    while (Date.now() < deadline) {
      const waiters = await blocker.query(
        'SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [pid])
      if (waiters.rowCount > 0) { blocked = true; break }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(blocked, true, 'request must actually wait for the owned PostgreSQL blocker')
    await blocker.query('COMMIT')
    const settled = await pending
    if (settled.error) throw settled.error
    assert.equal(settled.value.status, 404)
    assert.deepEqual(await snapshot(B.dave, foreign.session.sessionId), before)
  } finally {
    await blocker.query('ROLLBACK')
    await blocker.end()
    if (pending) await pending
  }
})
