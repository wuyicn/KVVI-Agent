/** Serialize management authority and membership changes through commit. */
import { withTransaction } from './db.mjs'
import { holdsPlatformRole, isPlatformAdmin } from './authorization.mjs'
import { verifyExpiry } from './signing.mjs'
import { RUNTIME_CONTEXT_MAX_AGE_MS } from './runtime-auth.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export class ManagementError extends Error {
  constructor(code) { super(code); this.code = code; this.detail = {} }
}
const changed = () => { throw new ManagementError('KVVI_MANAGEMENT_AUTHORITY_CHANGED') }

/** userIds may resolve affected role members, after the company lock is held. */
export async function withManagementTransaction(actor, { userIds = [], authority = 'admin' } = {}, apply) {
  if (!UUID.test(actor?.companyId ?? '') || !UUID.test(actor?.userId ?? '')
      || !UUID.test(actor?.sessionId ?? '')) changed()
  try {
    return await withTransaction('platform', async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
      await client.query("SET LOCAL lock_timeout = '5s'")
      await client.query("SET LOCAL statement_timeout = '15s'")
      const company = await client.query(
        'SELECT 1 FROM companies WHERE company_id=$1 FOR NO KEY UPDATE', [actor.companyId])
      if (company.rowCount !== 1) changed()
      const targets = typeof userIds === 'function' ? await userIds(client) : userIds
      if (!Array.isArray(targets) || targets.some(id => typeof id !== 'string' || !UUID.test(id))) {
        throw new ManagementError('KVVI_BAD_USER_ID')
      }
      const ids = [...new Set([actor.userId, ...targets])].sort()
      const users = await client.query(
        'SELECT user_id,status,authz_version FROM users WHERE user_id=ANY($1::uuid[]) ORDER BY user_id FOR UPDATE', [ids])
      const user = users.rows.find(row => row.user_id === actor.userId)
      if (!user || user.status !== 'ACTIVE') changed()
      const session = await client.query(
        `SELECT state,authz_version FROM sessions
          WHERE session_id=$1 AND company_id=$2 AND user_id=$3 AND gateway=$4 FOR SHARE`,
        [actor.sessionId, actor.companyId, actor.userId, actor.gateway])
      if (session.rowCount !== 1 || session.rows[0].state !== 'ACTIVE'
          || session.rows[0].authz_version !== user.authz_version) changed()
      const member = await client.query(
        'SELECT 1 FROM memberships WHERE company_id=$1 AND user_id=$2 FOR SHARE', [actor.companyId, actor.userId])
      if (member.rowCount !== 1) changed()
      if (actor.expiresAt !== undefined && !verifyExpiry({ exp: actor.expiresAt }).ok) changed()
      if (actor.runtimeIssuedAt !== undefined && (!Number.isSafeInteger(actor.runtimeIssuedAt)
          || Math.abs(Date.now() - actor.runtimeIssuedAt) > RUNTIME_CONTEXT_MAX_AGE_MS)) changed()
      if (actor.tokenId !== undefined) {
        const token = await client.query(
          `SELECT 1 FROM delegation_tokens WHERE token_id=$1 AND session_id=$2 AND company_id=$3 AND user_id=$4
            AND authz_version=$5 AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE`,
          [actor.tokenId, actor.sessionId, actor.companyId, actor.userId, user.authz_version])
        if (token.rowCount !== 1) changed()
      }
      if (actor.gateway === 'BUILDER') {
        const { allowedGateways } = await import('./mode-policy.mjs')
        if (!(await allowedGateways(actor.companyId, actor.userId, client)).includes('BUILDER')) changed()
      }
      if (authority === 'owner') {
        if (!(await holdsPlatformRole(actor.companyId, actor.userId, 'owner', client))) {
          throw new ManagementError('KVVI_OWNER_REQUIRED')
        }
      } else if (authority === 'admin') {
        if (!(await isPlatformAdmin(actor.companyId, actor.userId, client)).allowed) {
          throw new ManagementError('KVVI_NOT_A_PLATFORM_ADMIN')
        }
      } else if (authority !== 'member') {
        throw new ManagementError('KVVI_MANAGEMENT_AUTHORITY_INVALID')
      }
      return apply(client)
    })
  } catch (error) {
    if (['55P03', '40P01', '57014'].includes(error?.code)) throw new ManagementError('KVVI_MANAGEMENT_BUSY')
    throw error
  }
}
