/**
 * 平台双模式资格：成员天然拥有 USER；BUILDER 只能由所有者身份或显式授权产生。
 * 调用方提交的 gateway 只是意图，不能作为资格来源。
 */
import { pool, withTransaction } from './db.mjs'
import { append } from './audit.mjs'
import { holdsPlatformRole } from './authorization.mjs'

const BUILDER = 'BUILDER'

/** 返回账号在指定公司内可进入的模式，顺序固定便于 UI 与测试消费。 */
export async function allowedGateways(companyId, userId) {
  const member = await pool('platform').query(
    'SELECT 1 FROM memberships WHERE company_id = $1 AND user_id = $2',
    [companyId, userId])
  if (member.rows.length !== 1) return []

  if (await holdsPlatformRole(companyId, userId, 'owner')) {
    return ['USER', BUILDER]
  }
  const grant = await pool('platform').query(
    `SELECT 1 FROM platform_mode_grants
      WHERE company_id = $1 AND user_id = $2 AND gateway = 'BUILDER'`,
    [companyId, userId])
  return grant.rows.length === 1 ? ['USER', BUILDER] : ['USER']
}

async function requireOwner(actor) {
  if (!actor?.companyId || !actor?.userId
      || !(await holdsPlatformRole(actor.companyId, actor.userId, 'owner'))) {
    throw new Error('KVVI_OWNER_REQUIRED')
  }
}

/** 所有者向本公司成员授予搭建模式。 */
export async function grantBuilderAccess(actor, userId) {
  await requireOwner(actor)
  const changed = await withTransaction('platform', async (client) => {
    const member = await client.query(
      'SELECT 1 FROM memberships WHERE company_id = $1 AND user_id = $2',
      [actor.companyId, userId])
    if (member.rows.length !== 1) throw new Error('KVVI_NOT_A_MEMBER')
    const inserted = await client.query(
      `INSERT INTO platform_mode_grants (company_id, user_id, gateway, granted_by)
       VALUES ($1,$2,'BUILDER',$3)
       ON CONFLICT DO NOTHING RETURNING user_id`,
      [actor.companyId, userId, actor.userId])
    if (inserted.rows.length === 1) {
      await client.query(
        'UPDATE users SET authz_version = authz_version + 1 WHERE user_id = $1',
        [userId])
    }
    return inserted.rows.length === 1
  })
  if (changed) {
    await append({
      companyId: actor.companyId, actorKind: 'USER', actorId: actor.userId,
      gateway: actor.gateway ?? BUILDER, sessionId: actor.sessionId ?? null,
      action: 'mode.grantBuilder', resourceKind: 'USER', resourceId: userId,
      outcome: 'ALLOW',
    })
  }
  return changed
}

/** 所有者收回搭建模式，并立即终止该公司内该账号的 Builder 会话。 */
export async function revokeBuilderAccess(actor, userId) {
  await requireOwner(actor)
  const result = await withTransaction('platform', async (client) => {
    const removed = await client.query(
      `DELETE FROM platform_mode_grants
        WHERE company_id = $1 AND user_id = $2 AND gateway = 'BUILDER'
        RETURNING user_id`, [actor.companyId, userId])
    if (removed.rows.length === 0) return { changed: false, ended: 0 }

    await client.query(
      'UPDATE users SET authz_version = authz_version + 1 WHERE user_id = $1',
      [userId])
    const ended = await client.query(
      `UPDATE sessions
          SET state = 'ENDED', ended_by = 'ADMIN_REVOKED', ended_at = now()
        WHERE company_id = $1 AND user_id = $2 AND gateway = 'BUILDER'
          AND state = 'ACTIVE'
        RETURNING session_id`, [actor.companyId, userId])
    if (ended.rows.length > 0) {
      await client.query(
        `UPDATE delegation_tokens SET revoked_at = now()
          WHERE session_id = ANY($1::uuid[]) AND revoked_at IS NULL`,
        [ended.rows.map((row) => row.session_id)])
      await client.query(
        `INSERT INTO session_events (session_id, user_id, company_id, kind, detail)
         SELECT unnest($1::uuid[]), $2, $3, 'ADMIN_REVOKED',
                '{"reason":"BUILDER_ACCESS_REVOKED"}'::jsonb`,
        [ended.rows.map((row) => row.session_id), userId, actor.companyId])
    }
    return { changed: true, ended: ended.rows.length }
  })
  if (result.changed) {
    await append({
      companyId: actor.companyId, actorKind: 'USER', actorId: actor.userId,
      gateway: actor.gateway ?? BUILDER, sessionId: actor.sessionId ?? null,
      action: 'mode.revokeBuilder', resourceKind: 'USER', resourceId: userId,
      outcome: 'ALLOW', resultDigest: String(result.ended),
    })
  }
  return result
}
