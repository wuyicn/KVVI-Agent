/**
 * 所有者/管理员管理 API：`/api/v1/admin/*`。
 *
 * ── 与 `/auth/*` 的管理端点是什么关系 ────────────────────────────────────
 *
 * 两者**判定同一件事，凭据不同**，不是两条授权路径：
 *
 * | 入口 | 谁在用 | 凭什么 |
 * |---|---|---|
 * | `/auth/accounts/:id/suspend` 等 | 受控进程（运维脚本、平台自身） | 进程令牌 **且** 人的令牌 |
 * | `/api/v1/admin/*` | 浏览器里的所有者/管理员 | **会话本身** |
 *
 * 浏览器**不能**持有进程令牌 —— 能持有的那一刻，任何能到达端口的人都成了管理员。
 * 所以产品 API 的门是会话：身份从已验证的会话导出，路由**不接受**调用方
 * 声明的公司、角色或操作人（那些字段在 `api-router.mjs` 的入口就被递归剥掉了）。
 *
 * ── 「委托范围」在这份代码里指什么 ──────────────────────────────────────
 *
 * 需求写的是「搭建者只能**在其被委托的范围内**配置员工业务权限」。本仓库里
 * 存在的委托机制只有一种：所有者把平台保留角色 `admin` 授予某人
 * （`PLATFORM_ROLE_CODES = ['owner','admin']`，`roles.role_code` 上的保留 code）。
 * 所以本模块的实现是：
 *
 * | 动作 | owner | admin（被委托者） |
 * |---|---|---|
 * | 看成员/角色/策略 | ✓ | ✓ |
 * | 建账号、停用、建角色、配策略 | ✓ | ✓ |
 * | **授予/收回搭建模式** | ✓ | ✗ `KVVI_OWNER_REQUIRED` |
 * | **授予/收回平台保留角色** | ✓ | ✗ `KVVI_OWNER_REQUIRED` |
 * | 把自己纳入配置范围 | ✗ | ✗ `KVVI_SELF_GRANT_FORBIDDEN` |
 *
 * ⚠️ **更细的委托范围（例如「只能管某个部门」）没有实现**，因为策略模型里
 * 没有承载它的字段；凭空加一层会让「谁管谁」出现第二份判据。
 * 这是一条**已知缺口**，不是「以后再说」。
 *
 * ── 每一处写操作都在一个事务里 ──────────────────────────────────────────
 *
 * 「建账号 + 加成员关系」花两步。分两次提交的话，第二次失败会留下一个
 * **没有成员关系的孤儿账号**：登录得进认证，却进不了任何公司 ——
 * 而报错指向的是下一步（加成员）而不是「账号已存在」。所以两步同事务。
 */

import { withTransaction, pool } from './db.mjs'
import { append, appendDenial, digestOf } from './audit.mjs'
import { hashPassword } from './identity.mjs'
import { suspendAccount } from './identity.mjs'
import { isPlatformAdmin, holdsPlatformRole, checkSelfGrant,
         PLATFORM_ROLE_CODES, DATA_SCOPES } from './authorization.mjs'
import { grantBuilderAccess, revokeBuilderAccess } from './mode-policy.mjs'

const DIMENSIONS = Object.freeze(['FORM', 'FIELD', 'FLOW', 'DATA'])
const FIELD_VISIBILITY = Object.freeze(['VISIBLE', 'MASKED', 'HIDDEN', 'READONLY'])

/** 领域错误码 → HTTP 状态。未登记的一律 400（不是 500 —— 那意味着「我们错了」）。 */
const STATUS_OF = Object.freeze({
  KVVI_SELF_GRANT_FORBIDDEN: 403,
  KVVI_OWNER_REQUIRED: 403,
  KVVI_NOT_A_PLATFORM_ADMIN: 403,
  KVVI_PLATFORM_ROLE_RESERVED: 403,
  KVVI_NO_SUCH_ROLE: 404,
  KVVI_NO_SUCH_MEMBER: 404,
  KVVI_NOT_A_MEMBER: 404,
  KVVI_LOGIN_EXISTS: 409,
  KVVI_ROLE_EXISTS: 409,
  KVVI_NOT_A_PLATFORM_ROLE: 403,
  KVVI_LAST_OWNER: 409,
  KVVI_MEMBER_SUSPENDED: 409,
})

/**
 * 一个带稳定错误码的领域错误。
 *
 * 码是**唯一**的东西 —— 界面与 Agent 两条通道都靠它分支，
 * 所以「同样的拒绝给同样的码」是 G8 的判据，不是风格问题。
 */
export class AdminError extends Error {
  /**
   * @param code 稳定错误码
   * @param detail 附加信息（可选）；不进用户可见文案
   */
  constructor(code, detail = {}) {
    super(code)
    this.name = 'AdminError'
    this.code = code
    this.detail = detail
  }
}

/** 归一化成 `{status, body}`。 */
function failure(code, extra = {}) {
  return { status: STATUS_OF[code] ?? 400, body: { error: code, ...extra } }
}

/** 从会话折出操作人上下文。**身份只从这里来**。 */
function actorOf(session) {
  return {
    companyId: session.companyId,
    userId: session.userId,
    gateway: session.gateway,
    sessionId: session.sessionId ?? null,
  }
}

/**
 * 门：所有者或管理员。
 * @param actor 操作人
 * @param action 审计动作名
 * @returns 被拒时为 `{status, body}`，放行时为 `null`
 */
async function requireAdmin(actor, action, params = {}) {
  const verdict = await isPlatformAdmin(actor.companyId, actor.userId)
  if (verdict.allowed) return null
  await appendDenial({
    companyId: actor.companyId, actorKind: 'USER', actorId: actor.userId,
    gateway: actor.gateway, sessionId: actor.sessionId, action, outcome: 'DENY',
    reason: verdict.reason, paramsDigest: digestOf(params),
  })
  return failure(verdict.reason)
}

/**
 * 门：**仅**所有者。
 *
 * 授予搭建模式与平台角色都是「谁能管理」这件事本身，被委托者不能自己扩大
 * 委托面 —— 否则一次委托就等于把委托权交出去了。
 *
 * ⚠️ 导出是给 `branding-api.mjs` 用的（公司品牌同样「仅所有者」，理由不同：
 * 对外身份不是管理权）。判据函数只有 `holdsPlatformRole` 一份，两处共用 ——
 * 复制一个 owner 闸门出来，两处迟早会在「谁能改所有者」上分叉。
 * @param actor 操作人
 * @param action 审计动作名
 * @returns 被拒时为 `{status, body}`，放行时为 `null`
 */
export async function requireOwner(actor, action, params = {}) {
  if (await holdsPlatformRole(actor.companyId, actor.userId, 'owner')) return null
  await appendDenial({
    companyId: actor.companyId, actorKind: 'USER', actorId: actor.userId,
    gateway: actor.gateway, sessionId: actor.sessionId, action, outcome: 'DENY',
    reason: 'KVVI_OWNER_REQUIRED', paramsDigest: digestOf(params),
  })
  return failure('KVVI_OWNER_REQUIRED')
}

/** 写一条成功审计。 */
async function record(actor, action, resourceKind, resourceId, params) {
  await append({
    companyId: actor.companyId, actorKind: 'USER', actorId: actor.userId,
    gateway: actor.gateway, sessionId: actor.sessionId, action,
    resourceKind, resourceId, outcome: 'ALLOW',
    ...(params === undefined ? {} : { paramsDigest: digestOf(params) }),
  })
}

// ── 读 ────────────────────────────────────────────────────────────────────

/** 本公司成员，连同部门/店铺与持有的角色。 */
async function listMembers(companyId) {
  const { rows } = await pool('platform').query(
    `SELECT m.user_id, u.login, u.status, u.created_at,
            m.dept_id, d.name AS dept_name, m.shop_id,
            COALESCE(array_agg(r.role_code ORDER BY r.role_code)
                     FILTER (WHERE r.role_code IS NOT NULL), '{}') AS role_codes
       FROM memberships m
       JOIN users u ON u.user_id = m.user_id
       LEFT JOIN departments d ON d.dept_id = m.dept_id
       LEFT JOIN role_members rm ON rm.company_id = m.company_id AND rm.user_id = m.user_id
       LEFT JOIN roles r ON r.role_id = rm.role_id
      WHERE m.company_id = $1
      GROUP BY m.user_id, u.login, u.status, u.created_at, m.dept_id, d.name, m.shop_id
      ORDER BY u.created_at, u.login`, [companyId])
  const grants = await pool('platform').query(
    `SELECT user_id FROM platform_mode_grants
      WHERE company_id = $1 AND gateway = 'BUILDER'`, [companyId])
  const builder = new Set(grants.rows.map((r) => r.user_id))
  return rows.map((r) => ({
    userId: r.user_id,
    login: r.login,
    status: r.status,
    deptId: r.dept_id,
    deptName: r.dept_name,
    shopId: r.shop_id,
    roleCodes: r.role_codes,
    builder: builder.has(r.user_id),
    platformRole: PLATFORM_ROLE_CODES.find((c) => r.role_codes.includes(c)) ?? null,
  }))
}

/** 本公司角色，连同策略。策略按维度排序，界面的编辑顺序才稳定。 */
async function listRoles(companyId) {
  const { rows } = await pool('platform').query(
    `SELECT r.role_id, r.role_code, r.name,
            COALESCE(json_agg(json_build_object(
              'dimension', p.dimension, 'resourceCode', p.resource_code,
              'actions', p.actions, 'dataScopes', p.data_scopes,
              'fieldVisibility', p.field_visibility)
              ORDER BY p.dimension, p.resource_code)
              FILTER (WHERE p.policy_id IS NOT NULL), '[]') AS policies,
            (SELECT count(*)::int FROM role_members rm WHERE rm.role_id = r.role_id) AS members
       FROM roles r
       LEFT JOIN policies p ON p.role_id = r.role_id
      WHERE r.company_id = $1
      GROUP BY r.role_id, r.role_code, r.name
      ORDER BY r.role_code`, [companyId])
  return rows.map((r) => ({
    roleCode: r.role_code,
    name: r.name,
    memberCount: r.members,
    reserved: PLATFORM_ROLE_CODES.includes(r.role_code),
    policies: r.policies,
  }))
}

/** 本公司的部门树（配置成员归属时要用）。 */
async function listDepartments(companyId) {
  const { rows } = await pool('platform').query(
    `SELECT dept_id, parent_id, name FROM departments
      WHERE company_id = $1 ORDER BY name`, [companyId])
  return rows.map((r) => ({ deptId: r.dept_id, parentId: r.parent_id, name: r.name }))
}

// ── 写 ────────────────────────────────────────────────────────────────────

/**
 * 建账号并加入本公司 —— **一个事务**。
 *
 * 分两次提交会留下「认证过但进不了任何公司」的孤儿账号，而报错指向的是
 * 第二次写（加成员）而不是「登录名已存在」。
 * @param actor 操作人
 * @param input 登录名、口令与可选归属
 * @returns 新账号
 */
async function createMember(actor, input) {
  const login = typeof input?.login === 'string' ? input.login.trim() : ''
  const password = typeof input?.password === 'string' ? input.password : ''
  if (login === '') throw new AdminError('KVVI_LOGIN_REQUIRED')
  if (password.length < 8) throw new AdminError('KVVI_PASSWORD_TOO_SHORT')

  const created = await withTransaction('platform', async (client) => {
    // 唯一约束兜底：并发建同名账号时先到者成功，后到者在这里拿到 23505 而不是
    // 插出一个孤儿。**不先 SELECT 再 INSERT** —— 那中间有一个竞态窗口。
    let userId
    try {
      const { rows } = await client.query(
        `INSERT INTO users (user_id, login, password_hash, status)
         VALUES (gen_random_uuid(), $1, $2, 'ACTIVE') RETURNING user_id`,
        [login, hashPassword(password)])
      userId = rows[0].user_id
    } catch (error) {
      if (error?.code === '23505') throw new AdminError('KVVI_LOGIN_EXISTS', { login })
      throw error
    }
    await client.query(
      `INSERT INTO memberships (company_id, user_id, dept_id, shop_id)
       VALUES ($1, $2, $3, $4)`,
      [actor.companyId, userId, input?.deptId ?? null, input?.shopId ?? null])
    return userId
  })
  await record(actor, 'admin.createMember', 'USER', created, { login })
  return { userId: created, login }
}

/** 改一个成员的归属部门/店铺。 */
async function updateMember(actor, userId, input) {
  const changed = await withTransaction('platform', async (client) => {
    const { rows } = await client.query(
      `UPDATE memberships SET dept_id = $3, shop_id = $4
        WHERE company_id = $1 AND user_id = $2
        RETURNING user_id`,
      [actor.companyId, userId, input?.deptId ?? null, input?.shopId ?? null])
    return rows.length === 1
  })
  if (!changed) throw new AdminError('KVVI_NOT_A_MEMBER', { userId })
  await record(actor, 'admin.updateMember', 'USER', userId)
  return { userId }
}

/**
 * 停用账号。
 *
 * `suspendAccount` 会结束该账号**全部**活动会话 —— 这是顺序要求而不是附带效果：
 * 停用先落库、会话后结束的话，被停用者在那段窗口里还能继续写。
 * @param actor 操作人
 * @param userId 目标账号
 * @returns 结束的会话数
 */
async function suspendMember(actor, userId) {
  await assertManageable(actor, userId)
  const { rows } = await pool('platform').query(
    'SELECT status FROM users WHERE user_id = $1', [userId])
  if (rows.length !== 1) throw new AdminError('KVVI_NO_SUCH_MEMBER', { userId })
  if (rows[0].status === 'SUSPENDED') throw new AdminError('KVVI_MEMBER_SUSPENDED', { userId })
  const ended = await suspendAccount(userId, { companyId: actor.companyId })
  if (ended === null) throw new AdminError('KVVI_NO_SUCH_MEMBER', { userId })
  await record(actor, 'admin.suspendMember', 'USER', userId, { ended })
  return { userId, endedSessions: ended }
}

/** 恢复账号。会话不恢复 —— 恢复后要重新登录，这是有意的。 */
async function reactivateMember(actor, userId) {
  const changed = await withTransaction('platform', async (client) => {
    const member = await client.query(
      'SELECT 1 FROM memberships WHERE company_id = $1 AND user_id = $2',
      [actor.companyId, userId])
    if (member.rows.length !== 1) return false
    await client.query(
      `UPDATE users SET status = 'ACTIVE' WHERE user_id = $1`, [userId])
    return true
  })
  if (!changed) throw new AdminError('KVVI_NOT_A_MEMBER', { userId })
  await record(actor, 'admin.reactivateMember', 'USER', userId)
  return { userId }
}

/**
 * 目标是本公司成员，且**不是操作者自己**。
 *
 * §9.6.7 的自授权禁令在这里执行：一个**有**配置权限的操作者同样不能
 * 把自己纳入范围 —— 判据是「目标是不是他自己」，与「他有没有权限」无关。
 * @param actor 操作人
 * @param userId 目标账号
 */
async function assertManageable(actor, userId) {
  const self = checkSelfGrant(actor.userId, [userId])
  if (!self.allowed) {
    await appendDenial({
      companyId: actor.companyId, actorKind: 'USER', actorId: actor.userId,
      gateway: actor.gateway, sessionId: actor.sessionId,
      action: 'admin.selfTarget', outcome: 'DENY',
      reason: 'KVVI_SELF_GRANT_FORBIDDEN', paramsDigest: digestOf({ userId }),
    })
    throw new AdminError('KVVI_SELF_GRANT_FORBIDDEN')
  }
  const { rows } = await pool('platform').query(
    'SELECT 1 FROM memberships WHERE company_id = $1 AND user_id = $2',
    [actor.companyId, userId])
  if (rows.length !== 1) throw new AdminError('KVVI_NOT_A_MEMBER', { userId })
}

/** 建业务角色。保留 code 不可占用 —— 否则「谁是所有者」会被业务配置改写。 */
async function createRole(actor, input) {
  const roleCode = typeof input?.roleCode === 'string' ? input.roleCode.trim() : ''
  const name = typeof input?.name === 'string' ? input.name.trim() : ''
  if (roleCode === '') throw new AdminError('KVVI_ROLE_CODE_REQUIRED')
  if (name === '') throw new AdminError('KVVI_ROLE_NAME_REQUIRED')
  if (PLATFORM_ROLE_CODES.includes(roleCode)) {
    throw new AdminError('KVVI_PLATFORM_ROLE_RESERVED', { roleCode })
  }
  const created = await withTransaction('platform', async (client) => {
    const { rows } = await client.query(
      `INSERT INTO roles (role_id, company_id, role_code, name)
       VALUES (gen_random_uuid(), $1, $2, $3)
       ON CONFLICT (company_id, role_code) DO NOTHING
       RETURNING role_id`, [actor.companyId, roleCode, name])
    if (rows.length === 0) throw new AdminError('KVVI_ROLE_EXISTS', { roleCode })
    return rows[0].role_id
  })
  await record(actor, 'admin.createRole', 'ROLE', roleCode)
  return { roleCode, roleId: created }
}

/**
 * **整体替换**一个角色的策略。
 *
 * 「整体替换」而不是「逐条增删」：一次授权动作的四个维度是一个整体，
 * 逐条改会让界面中途失败时留下一个**只配了一半**的角色 ——
 * 而只配了一半的角色在数据范围维度上往往意味着「没有范围」。
 * @param actor 操作人
 * @param roleCode 角色
 * @param policies 新的策略列表
 * @returns 写入条数
 */
async function replacePolicies(actor, roleCode, policies) {
  const list = Array.isArray(policies) ? policies : null
  if (list === null) throw new AdminError('KVVI_POLICIES_REQUIRED')
  for (const p of list) {
    if (!DIMENSIONS.includes(p?.dimension)) {
      throw new AdminError('KVVI_BAD_DIMENSION', { dimension: p?.dimension })
    }
    if (typeof p?.resourceCode !== 'string' || p.resourceCode === '') {
      throw new AdminError('KVVI_BAD_RESOURCE_CODE')
    }
    const scopes = Array.isArray(p?.dataScopes) ? p.dataScopes : []
    const unknown = scopes.filter((s) => !DATA_SCOPES.includes(s))
    if (unknown.length > 0) throw new AdminError('KVVI_BAD_DATA_SCOPE', { scopes: unknown })
    if (p.dimension === 'FIELD'
        && p.fieldVisibility != null
        && !FIELD_VISIBILITY.includes(p.fieldVisibility)) {
      throw new AdminError('KVVI_BAD_FIELD_VISIBILITY', { value: p.fieldVisibility })
    }
  }

  const role = await pool('platform').query(
    `SELECT role_id FROM roles WHERE company_id = $1 AND role_code = $2`,
    [actor.companyId, roleCode])
  if (role.rows.length !== 1) throw new AdminError('KVVI_NO_SUCH_ROLE', { roleCode })
  const roleId = role.rows[0].role_id

  // ★ S5 修复：改自己**所在角色**的策略 = 自授权（§9.6.7）。
  //
  // 此前 `assignRoleMembers` 有 `checkSelfGrant` 这道闸（自加角色 → 403），
  // 但「改自己已经加入的角色的策略」没有 —— 一个有配置权的被委托者可以把
  // 自己所在角色的 DATA 档位改宽，立即获得别人记录的读权，且不经发布草案。
  // 判据是「操作者是不是这个角色的成员」，与「他有没有配置权」无关 ——
  // 这与 `checkSelfGrant` 对 `assignRoleMembers` 的口径一致。
  const selfMember = await pool('platform').query(
    'SELECT 1 FROM role_members WHERE role_id = $1 AND user_id = $2',
    [roleId, actor.userId])
  if (selfMember.rows.length === 1) {
    await appendDenial({
      companyId: actor.companyId, actorKind: 'USER', actorId: actor.userId,
      gateway: actor.gateway, sessionId: actor.sessionId,
      action: 'admin.replacePolicies', outcome: 'DENY',
      reason: 'KVVI_SELF_GRANT_FORBIDDEN', paramsDigest: digestOf({ roleCode }),
    })
    throw new AdminError('KVVI_SELF_GRANT_FORBIDDEN', { roleCode })
  }

  // 替换与成员清点同事务：清点用于「不能把最后一个所有者降级」。
  const applied = await withTransaction('platform', async (client) => {
    await client.query(
      'DELETE FROM policies WHERE company_id = $1 AND role_id = $2',
      [actor.companyId, roleId])
    for (const p of list) {
      await client.query(
        `INSERT INTO policies (policy_id, company_id, role_id, dimension, resource_code,
           actions, data_scopes, field_visibility)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7)`,
        [actor.companyId, roleId, p.dimension, p.resourceCode,
         Array.isArray(p.actions) ? p.actions : [],
         Array.isArray(p.dataScopes) ? p.dataScopes : [],
         p.fieldVisibility ?? null])
    }
    await client.query(
      'UPDATE users SET authz_version = authz_version + 1 WHERE user_id IN '
      + '(SELECT user_id FROM role_members WHERE role_id = $1)', [roleId])
    return list.length
  })
  await record(actor, 'admin.replacePolicies', 'ROLE', roleCode, { count: applied })
  return { roleCode, count: applied }
}

/** 把若干人加入/移出一个业务角色。保留角色不走这里（见平台角色端点）。 */
async function assignRoleMembers(actor, roleCode, userIds, mode) {
  if (PLATFORM_ROLE_CODES.includes(roleCode)) {
    throw new AdminError('KVVI_PLATFORM_ROLE_RESERVED', { roleCode })
  }
  const targets = Array.isArray(userIds) ? userIds : []
  if (targets.length === 0) throw new AdminError('KVVI_NO_TARGET_USERS')
  const self = checkSelfGrant(actor.userId, targets)
  if (!self.allowed) {
    await appendDenial({
      companyId: actor.companyId, actorKind: 'USER', actorId: actor.userId,
      gateway: actor.gateway, sessionId: actor.sessionId,
      action: 'admin.assignRole', outcome: 'DENY',
      reason: 'KVVI_SELF_GRANT_FORBIDDEN', paramsDigest: digestOf({ targets }),
    })
    throw new AdminError('KVVI_SELF_GRANT_FORBIDDEN')
  }
  const role = await pool('platform').query(
    `SELECT role_id FROM roles WHERE company_id = $1 AND role_code = $2`,
    [actor.companyId, roleCode])
  if (role.rows.length !== 1) throw new AdminError('KVVI_NO_SUCH_ROLE', { roleCode })
  const roleId = role.rows[0].role_id

  const done = await withTransaction('platform', async (client) => {
    const out = []
    for (const userId of targets) {
      const member = await client.query(
        'SELECT 1 FROM memberships WHERE company_id = $1 AND user_id = $2',
        [actor.companyId, userId])
      if (member.rows.length !== 1) continue      // 非本公司成员：跳过，不报错
      if (mode === 'add') {
        await client.query(
          `INSERT INTO role_members (company_id, role_id, user_id)
           VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [actor.companyId, roleId, userId])
      } else {
        await client.query(
          'DELETE FROM role_members WHERE role_id = $1 AND user_id = $2', [roleId, userId])
      }
      await client.query(
        'UPDATE users SET authz_version = authz_version + 1 WHERE user_id = $1', [userId])
      out.push(userId)
    }
    return out
  })
  await record(actor, mode === 'add' ? 'admin.assignRole' : 'admin.unassignRole',
    'ROLE', roleCode, { users: done })
  return { roleCode, userIds: done }
}

/**
 * 授予/收回平台保留角色 `admin`。
 *
 * 这是本仓库里**唯一**的委托机制（见文件头）。所有者不能把自己降级 ——
 * 一家公司没有所有者的那一刻，就没有人能把它改回来了。
 * @param actor 操作人
 * @param userId 目标
 * @param roleCode `owner` 或 `admin`
 * @param grant 授予为真，收回为假
 * @returns 结果
 */
async function setPlatformRole(actor, userId, roleCode, grant) {
  if (!PLATFORM_ROLE_CODES.includes(roleCode)) {
    throw new AdminError('KVVI_NOT_A_PLATFORM_ROLE', { roleCode })
  }
  const role = await pool('platform').query(
    `SELECT role_id FROM roles WHERE company_id = $1 AND role_code = $2`,
    [actor.companyId, roleCode])
  if (role.rows.length !== 1) throw new AdminError('KVVI_NO_SUCH_ROLE', { roleCode })
  const roleId = role.rows[0].role_id

  const done = await withTransaction('platform', async (client) => {
    const member = await client.query(
      'SELECT 1 FROM memberships WHERE company_id = $1 AND user_id = $2',
      [actor.companyId, userId])
    if (member.rows.length !== 1) throw new AdminError('KVVI_NOT_A_MEMBER', { userId })

    if (!grant) {
      // ★ 最后一个所有者不可移除。移除之后没人能再把角色配回来 ——
      //   这不是「权限不足」，是这家公司已经无法管理自己。
      const owners = await client.query(
        `SELECT rm.user_id FROM role_members rm
          WHERE rm.role_id = $1 FOR UPDATE`, [roleId])
      if (roleCode === 'owner' && owners.rows.length <= 1 && owners.rows.some((r) => r.user_id === userId)) {
        throw new AdminError('KVVI_LAST_OWNER', { userId })
      }
      await client.query(
        'DELETE FROM role_members WHERE role_id = $1 AND user_id = $2', [roleId, userId])
    } else {
      await client.query(
        `INSERT INTO role_members (company_id, role_id, user_id)
         VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [actor.companyId, roleId, userId])
    }
    await client.query(
      'UPDATE users SET authz_version = authz_version + 1 WHERE user_id = $1', [userId])
    // 提权与降权都要让**已签发的令牌**失效：否则降权之后那个人手里的令牌
    // 在过期前仍是管理员。
    const { rows } = await client.query(
      `UPDATE sessions SET state = 'ENDED', ended_by = 'ADMIN_REVOKED', ended_at = now()
        WHERE company_id = $1 AND user_id = $2 AND state = 'ACTIVE'
        RETURNING session_id`, [actor.companyId, userId])
    for (const row of rows) await client.query(
      `INSERT INTO session_events (session_id, user_id, company_id, kind, detail)
       VALUES ($1,$2,$3,'ADMIN_REVOKED','{"reason":"PLATFORM_ROLE_CHANGED"}'::jsonb)`,
      [row.session_id, userId, actor.companyId])
    return rows.length
  })
  await record(actor, grant ? 'admin.grantPlatformRole' : 'admin.revokePlatformRole',
    'USER', userId, { roleCode })
  return { userId, roleCode, endedSessions: done }
}

// ── 路由 ──────────────────────────────────────────────────────────────────

/**
 * 分派 `/api/v1/admin/*`。
 *
 * @param input 路由输入（`path` 已去掉 `/api/v1`，`payload` 已剥掉身份字段）
 * @returns `{status, body}`
 */
export async function adminRoutes({ method, path, payload, session }) {
  const actor = actorOf(session)
  const parts = path.split('/').filter((p) => p !== '')
  const head = parts[0]

  try {
    // GET /admin/capabilities —— 界面据此决定显示什么。
    // ⚠️ 它**不是**权限判定：每个接口各自再判一次，前端隐藏按钮只是清晰度。
    if (method === 'GET' && parts.length === 1 && head === 'capabilities') {
      const verdict = await isPlatformAdmin(actor.companyId, actor.userId)
      const isOwner = await holdsPlatformRole(actor.companyId, actor.userId, 'owner')
      return { status: 200, body: {
        role: verdict.allowed ? (isOwner ? 'owner' : 'admin') : null,
        canManageMembers: verdict.allowed,
        canManageRoles: verdict.allowed,
        canManagePlatformRoles: isOwner,
        canManageBuilder: isOwner,
        dimensions: [...DIMENSIONS],
        dataScopes: [...DATA_SCOPES],
        fieldVisibilities: [...FIELD_VISIBILITY],
      } }
    }

    /** 每个分支用自己的动作名过闸 —— 审计里才看得出被拒的是哪件事。 */
    const gate = (action, params) => requireAdmin(actor, action, params)
    /** 所有者专属：被委托者不能扩大委托面本身。 */
    const ownerGate = (action, params) => requireOwner(actor, action, params)

    // ── 成员 ──────────────────────────────────────────────────────────────
    if (head === 'members' && parts.length === 1) {
      const refused = await gate('admin.members')
      if (refused) return refused
      if (method === 'GET') return { status: 200, body: { items: await listMembers(actor.companyId) } }
      if (method === 'POST') return { status: 201, body: await createMember(actor, payload) }
    }

    if (head === 'members' && parts.length >= 3) {
      const userId = decodeURIComponent(parts[1])
      const action = parts[2]

      if (action === 'suspend' && method === 'POST') {
        const refused = await gate('admin.suspendMember', { userId })
        if (refused) return refused
        return { status: 200, body: await suspendMember(actor, userId) }
      }
      if (action === 'reactivate' && method === 'POST') {
        const refused = await gate('admin.reactivateMember', { userId })
        if (refused) return refused
        return { status: 200, body: await reactivateMember(actor, userId) }
      }
      if (action === 'profile' && method === 'PATCH') {
        const refused = await gate('admin.updateMember', { userId })
        if (refused) return refused
        return { status: 200, body: await updateMember(actor, userId, payload) }
      }

      // 搭建模式与平台角色都是「谁能管理」这件事本身：**仅所有者**。
      if (action === 'builder' && (method === 'POST' || method === 'DELETE')) {
        const refused = await ownerGate('admin.builderAccess', { userId })
        if (refused) return refused
        if (method === 'POST') {
          const changed = await grantBuilderAccess(actor, userId)
          return { status: 200, body: { userId, builder: true, changed } }
        }
        return { status: 200, body: { userId, builder: false, ...await revokeBuilderAccess(actor, userId) } }
      }
      if (action === 'platform-role' && (method === 'POST' || method === 'DELETE')) {
        const refused = await ownerGate('admin.platformRole', { userId })
        if (refused) return refused
        const roleCode = parts[3] === undefined
          ? payload?.roleCode
          : decodeURIComponent(parts[3])
        return {
          status: 200,
          body: await setPlatformRole(actor, userId, roleCode, method === 'POST'),
        }
      }
    }

    // ── 角色与策略 ────────────────────────────────────────────────────────
    if (head === 'roles' && parts.length === 1) {
      const refused = await gate('admin.roles')
      if (refused) return refused
      if (method === 'GET') return { status: 200, body: { items: await listRoles(actor.companyId) } }
      if (method === 'POST') return { status: 201, body: await createRole(actor, payload) }
    }

    if (head === 'roles' && parts.length >= 3) {
      const roleCode = decodeURIComponent(parts[1])
      if (parts[2] === 'policies' && method === 'PUT') {
        const refused = await gate('admin.replacePolicies', { roleCode })
        if (refused) return refused
        return { status: 200, body: await replacePolicies(actor, roleCode, payload?.policies) }
      }
      if (parts[2] === 'members' && parts.length === 3 && method === 'POST') {
        const refused = await gate('admin.assignRole', { roleCode })
        if (refused) return refused
        return { status: 200, body: await assignRoleMembers(actor, roleCode, payload?.userIds, 'add') }
      }
      if (parts[2] === 'members' && parts.length === 4 && method === 'DELETE') {
        const refused = await gate('admin.unassignRole', { roleCode })
        if (refused) return refused
        return { status: 200, body: await assignRoleMembers(actor, roleCode, [decodeURIComponent(parts[3])], 'remove') }
      }
    }

    // ── 部门（配置成员归属时要用）─────────────────────────────────────────
    if (head === 'departments' && parts.length === 1 && method === 'GET') {
      const refused = await gate('admin.departments')
      if (refused) return refused
      return { status: 200, body: { items: await listDepartments(actor.companyId) } }
    }

    return { status: 404, body: { error: 'KVVI_UNKNOWN_ROUTE', route: path, method } }
  } catch (error) {
    if (error instanceof AdminError) {
      await appendDenial({
        companyId: actor.companyId, actorKind: 'USER', actorId: actor.userId,
        gateway: actor.gateway, sessionId: actor.sessionId,
        action: `admin.${head ?? 'unknown'}`, outcome: 'DENY',
        reason: error.code, paramsDigest: digestOf({ path, method, ...error.detail }),
      }).catch(() => {})
      return failure(error.code, error.detail)
    }
    // 既有模块抛的是 `Error('KVVI_CODE')` 或 `Error('KVVI_CODE: detail')`。
    if (typeof error?.message === 'string' && error.message.startsWith('KVVI_')) {
      return failure(error.message.split(':')[0].trim())
    }
    // ⚠️ **没料到的错误不是 400。**
    //
    // 这里原来是 `status: 400, error: 'KVVI_BAD_REQUEST'` —— 也就是把
    // 「服务端出错了」报成「你的请求不对」。两件事的后果完全不同：
    //   · 调用方会去改请求，而改请求解决不了服务端的问题；
    //   · **监控里 400 通常不算错误率**，于是「管理 API 全挂了」看起来一切正常。
    // 实测路径：把一张真表改名，管理路由撞上「关系不存在」，
    // 回的正是 400（这条由 `tests/schema-guard.test.mjs` 抓出来）。
    //
    // 真因只进日志，不进响应体 —— 与 `server.mjs` 的请求边界同一约定。
    console.error(JSON.stringify({
      event: 'admin-request-failed',
      path, method,
      error: String(error?.message ?? error),
      code: error?.code ?? null,
    }))
    return { status: 500, body: { error: 'KVVI_INTERNAL_ERROR' } }
  }
}
