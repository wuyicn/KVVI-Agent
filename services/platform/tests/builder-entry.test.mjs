import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { handleAuth } from '../src/auth.mjs'
import { createSession, issueBrowserCredential, issueToken, loadSession, endSession, bumpAuthzVersion, signingKeys } from '../src/identity.mjs'
import { signToken, TOKEN_TYPES } from '../src/signing.mjs'
import { pool } from '../src/db.mjs'
import { A, B, resetDatabase, grantPlatformRole, closeAll } from './harness.mjs'

before(async () => { await resetDatabase(); await grantPlatformRole(A.alice, 'owner') })
after(closeAll)
async function login(userId = A.alice, gateway = 'USER') {
  const session = await createSession({ userId, companyId: A.company, gateway })
  return { ...session, ...await issueBrowserCredential(session.sessionId) }
}
const enter = (credential, body = {}) => handleAuth({ method: 'POST', path: '/auth/enter-builder',
  headers: { cookie: `kvvi-session=${credential}`, 'x-kvvi-builder-intent': '1' }, body })

test('authorized signed-in user enters Builder without a password; old USER authority stays unchanged', async () => {
  const source = await login()
  const result = await enter(source.credential)
  assert.equal(result?.status, 200)
  const identity = await handleAuth({ method: 'GET', path: '/auth/session', headers: { cookie: `kvvi-session=${result.body.credential}` } })
  assert.equal(identity.status, 200)
  assert.equal(identity.body.gateway, 'BUILDER')
  assert.equal(identity.body.companyId, A.company)
  assert.equal(identity.body.userId, A.alice)
  assert.notEqual(identity.body.sessionId, source.sessionId)
  assert.equal((await loadSession(source.sessionId)).gateway, 'USER')
  assert.ok(identity.body.tools.includes('schema.composeForm'))
})
test('already-active builder keeps the same session', async () => {
  const source = await login(A.alice, 'BUILDER')
  const result = await enter(source.credential)
  assert.equal(result?.status, 200)
  assert.equal(result.body.sessionId, source.sessionId)
})
test('builder creation uses its transaction connection even when other connections are occupied', async () => {
  const source = await login()
  const held = await Promise.all(Array.from({ length: 7 }, () => pool('platform').connect()))
  const pending = createSession({ userId: A.alice, companyId: A.company, gateway: 'BUILDER', sourceSessionId: source.sessionId })
  let timer
  try {
    const outcome = await Promise.race([pending, new Promise(resolve => { timer = setTimeout(() => resolve('blocked'), 500) })])
    assert.notEqual(outcome, 'blocked')
  } finally {
    clearTimeout(timer)
    held.forEach(client => client.release())
    await pending
  }
})
test('expired or tenant-mismatched browser credentials cannot enter Builder', async () => {
  const source = await login()
  const claims = { sub: A.alice, sid: source.sessionId, ten: A.company, gw: 'USER', av: source.authzVersion, cv: 'kvvi-contract/v1' }
  const expired = signToken(claims, signingKeys(), { typ: TOKEN_TYPES.BROWSER, ttlMs: 1 })
  assert.equal((await enter(expired))?.status, 401)
  const other = signToken({ ...claims, ten: B.company }, signingKeys(), { typ: TOKEN_TYPES.BROWSER })
  assert.equal((await enter(other))?.status, 401)
})
test('employee cannot enter Builder', async () => {
  const source = await login(A.bob)
  assert.equal((await enter(source.credential))?.status, 403)
  assert.equal((await loadSession(source.sessionId)).state, 'ACTIVE')
})
test('cannot select another company or person using the request body', async () => {
  const source = await login()
  assert.equal((await enter(source.credential, { companyId: B.company, userId: B.dave }))?.status, 400)
})
test('requires a browser credential, not an Agent token or a missing credential', async () => {
  const source = await login()
  assert.equal((await enter(await issueToken(source.sessionId)))?.status, 401)
  assert.equal((await enter(''))?.status, 401)
})
test('requires an explicit same-origin browser action', async () => {
  const source = await login()
  const out = await handleAuth({ method: 'POST', path: '/auth/enter-builder', headers: { cookie: `kvvi-session=${source.credential}` }, body: {} })
  assert.equal(out?.status, 403)
})
test('ended and authorization-changed sessions cannot enter Builder', async () => {
  const ended = await login()
  await endSession(ended.sessionId, 'LOGOUT')
  assert.equal((await enter(ended.credential))?.status, 401)
  const stale = await login()
  await bumpAuthzVersion(A.alice)
  assert.equal((await enter(stale.credential))?.status, 401)
})
