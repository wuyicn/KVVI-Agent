/**
 * 阶段十 · 任务 1：所有者管理 API（`/api/v1/admin/*`）。
 *
 * ── 这一组测的是「门」与「原子性」，不是「界面」 ──────────────────────────
 *
 * | # | 性质 | 不成立会怎样 |
 * |---|---|---|
 * | 1 | 非管理员调管理接口 → 403 **且留痕** | 前端隐藏按钮被当成权限，改一个请求就绕过 |
 * | 2 | 建账号撞重名 → 稳定冲突，**不留孤儿成员关系** | 第二次写失败留下「认证得过但进不了公司」的账号 |
 * | 3 | 把自己纳入配置范围 → 403（**与其有无权限无关**） | 有配置权的人给自己加权，一次委托就变成永久扩权 |
 * | 4 | 被委托者（admin）**不能**授予搭建模式/平台角色 | 一次委托等于把委托权交出去 |
 * | 5 | 停用账号 → 全部会话立刻结束 | 被停用者在「停用落库、会话未结束」的窗口里继续写 |
 * | 6 | 最后一个所有者不可移除 | 这家公司再也无法管理自己 |
 * | 7 | 策略是**整体替换**且同事务 | 中途失败留下「只配了一半」的角色 = 数据范围为空 |
 *
 * ⚠️ 第 2 条的断言必须查**成员关系条数**，不能只看状态码：
 * 一个先建账号再失败于加成员的实现同样返回 409，而孤儿已经落在库里。
 */
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { pool, closeAll } from '../src/db.mjs'
import { A, resetDatabase, grantBaseline, grantPlatformRole, makeSession } from './harness.mjs'
import { handleApi } from '../src/api-router.mjs'
import { handleAuth } from '../src/auth.mjs'

let owner = null
let delegate = null
let employee = null

const STAFF = 'a0000000-0000-4000-8000-0000000000a2'

/**
 * 直接调路由器（不经 HTTP 服务器）—— 本组测的是判定与事务，不是传输。
 *
 * ⚠️ `loadSession` **复用认证模块自己的会话端点**，与 `server.mjs` 的接线一致。
 * 第一版自己写了一个桩，只判「会话行还在不在」—— 于是「停用后旧令牌还能用」
 * 这条断言量到的是**桩的行为**，不是产品的行为：`verifyToken` 里那三道
 * （令牌已撤销、会话仍是 ACTIVE、账号仍是 ACTIVE）桩里一条都没有。
 * **测试装置太窄时，绿灯证明不了任何事。**
 */
async function api(method, path, session, body) {
  return await handleApi({
    method, path, query: '', body: body === undefined ? null : JSON.stringify(body),
    headers: session === null ? {} : { authorization: 'Bearer ' + session.raw },
    loadSession: (token) => handleAuth({
      method: 'GET', path: '/auth/session', body: null,
      headers: { authorization: 'Bearer ' + token },
      omitOtherGateway: true,
    }),
  })
}

/** 一个已知名字的业务角色：`grantBaseline` 生成的是随机 code，用它当 roleCode 会 404。 */
async function makeRole(code, name) {
  const { randomUUID } = await import('node:crypto')
  await pool('platform').query(
    `INSERT INTO roles (role_id, company_id, role_code, name) VALUES ($1,$2,$3,$4)
     ON CONFLICT (company_id, role_code) DO NOTHING`, [randomUUID(), A.company, code, name])
}

/** 清空并重设一个角色的策略 —— 每个用例都从已知状态开始。 */
async function resetPolicies(roleCode) {
  await pool('platform').query(
    `DELETE FROM policies WHERE company_id = $1 AND role_id =
       (SELECT role_id FROM roles WHERE company_id = $1 AND role_code = $2)`,
    [A.company, roleCode])
}

before(async () => {
  await resetDatabase()
  await grantBaseline(A.alice)
  await grantBaseline(A.bob)
  await grantPlatformRole(A.alice, 'owner')
  owner = await makeSession(A.alice, A.company)
  employee = await makeSession(A.bob, A.company)

  await makeRole('staff', '员工')
  await makeRole('supervisor', '主管')

  // 委托：所有者把平台保留角色 `admin` 给 carol（本仓库里唯一的委托机制）。
  delegate = await makeSession(A.carol, A.company)
})
after(closeAll)

describe('阶段十 · 所有者管理 API', () => {
  test('★ 非管理员的员工调管理接口 → 403，且留痕', async () => {
    for (const [method, path] of [
      ['GET', '/api/v1/admin/members'],
      ['GET', '/api/v1/admin/roles'],
      ['POST', '/api/v1/admin/members'],
    ]) {
      const r = await api(method, path, employee, method === 'POST' ? {} : undefined)
      assert.equal(r.status, 403, `${method} ${path} 没被拒`)
      assert.equal(r.body.error, 'KVVI_NOT_A_PLATFORM_ADMIN')
    }
    const { rows } = await pool('auditRead').query(
      `SELECT count(*)::int AS n FROM audit_entries
        WHERE outcome = 'DENY' AND reason = 'KVVI_NOT_A_PLATFORM_ADMIN'`)
    assert.ok(rows[0].n >= 3, '越权调用没有留下足够痕迹')
  })

  test('★ 未登录 → 401，且不返回任何成员数据', async () => {
    const r = await api('GET', '/api/v1/admin/members', null)
    assert.equal(r.status, 401)
    assert.equal(r.body.items, undefined, '未鉴权却返回了成员')
  })

  test('所有者可以看到能力表，员工看到的是空能力', async () => {
    const asOwner = await api('GET', '/api/v1/admin/capabilities', owner)
    assert.equal(asOwner.status, 200)
    assert.equal(asOwner.body.role, 'owner')
    assert.equal(asOwner.body.canManageBuilder, true)
    assert.equal(asOwner.body.canManagePlatformRoles, true)

    const asEmployee = await api('GET', '/api/v1/admin/capabilities', employee)
    assert.equal(asEmployee.status, 200)
    assert.equal(asEmployee.body.role, null)
    assert.equal(asEmployee.body.canManageMembers, false)
  })

  test('★ 建账号撞重名 → 409，且**不留孤儿成员关系**', async () => {
    const first = await api('POST', '/api/v1/admin/members', owner,
      { login: 'staff1', password: 'kvvi-staff-pass' })
    assert.equal(first.status, 201)

    const again = await api('POST', '/api/v1/admin/members', owner,
      { login: 'staff1', password: 'kvvi-other-pass' })
    assert.equal(again.status, 409)
    assert.equal(again.body.error, 'KVVI_LOGIN_EXISTS')

    // ⚠️ 查的是**成员关系条数**，不是状态码：先建账号再失败于加成员的实现
    //    同样返回 409，而孤儿已经落在库里。
    const { rows } = await pool('platform').query(
      `SELECT count(*)::int AS n FROM users WHERE login = 'staff1'`)
    assert.equal(rows[0].n, 1, '重名请求建出了第二个账号')
    const memberships = await pool('platform').query(
      `SELECT count(*)::int AS n FROM memberships m
         JOIN users u ON u.user_id = m.user_id WHERE u.login = 'staff1'`)
    assert.equal(memberships.rows[0].n, 1, '新账号没有成员关系（孤儿）')
  })

  test('口令过短 → 400，且不建账号', async () => {
    const r = await api('POST', '/api/v1/admin/members', owner, { login: 'tiny', password: 'x' })
    assert.equal(r.status, 400)
    assert.equal(r.body.error, 'KVVI_PASSWORD_TOO_SHORT')
    const { rows } = await pool('platform').query(
      `SELECT count(*)::int AS n FROM users WHERE login = 'tiny'`)
    assert.equal(rows[0].n, 0)
  })

  test('新账号出现在成员列表里，状态与归属都读得到', async () => {
    const r = await api('GET', '/api/v1/admin/members', owner)
    assert.equal(r.status, 200)
    const row = r.body.items.find((m) => m.login === 'staff1')
    assert.ok(row !== undefined, '刚建的账号不在成员列表里')
    assert.equal(row.status, 'ACTIVE')
    assert.equal(row.builder, false)
    assert.deepEqual(row.roleCodes, [])
  })

  test('★ 委托角色不能被建业务角色时的保留 code 占用', async () => {
    const r = await api('POST', '/api/v1/admin/roles', owner,
      { roleCode: 'owner', name: '假装是所有者' })
    assert.equal(r.status, 403)
    assert.equal(r.body.error, 'KVVI_PLATFORM_ROLE_RESERVED')
  })

  test('建角色：同名冲突是 409，不是 500', async () => {
    const ok = await api('POST', '/api/v1/admin/roles', owner, { roleCode: 'warehouse', name: '仓管' })
    assert.equal(ok.status, 201)
    const dup = await api('POST', '/api/v1/admin/roles', owner, { roleCode: 'warehouse', name: '仓管2' })
    assert.equal(dup.status, 409)
    assert.equal(dup.body.error, 'KVVI_ROLE_EXISTS')
  })

  test('★ 把自己纳入配置范围 → 403，且**与他有无权限无关**', async () => {
    const r = await api('POST', `/api/v1/admin/members/${A.alice}/suspend`, owner)
    assert.equal(r.status, 403)
    assert.equal(r.body.error, 'KVVI_SELF_GRANT_FORBIDDEN')
    // 记录要还在 —— 被拒不能改数据。
    const { rows } = await pool('platform').query(
      'SELECT status FROM users WHERE user_id = $1', [A.alice])
    assert.equal(rows[0].status, 'ACTIVE')
  })

  test('★ 把自己加进业务角色 → 403 且留痕', async () => {
    const r = await api('POST', '/api/v1/admin/roles/staff/members', owner,
      { userIds: [A.bob, A.alice] })
    assert.equal(r.status, 403)
    assert.equal(r.body.error, 'KVVI_SELF_GRANT_FORBIDDEN')
    const { rows } = await pool('auditRead').query(
      `SELECT count(*)::int AS n FROM audit_entries
        WHERE action = 'admin.assignRole' AND reason = 'KVVI_SELF_GRANT_FORBIDDEN'`)
    assert.ok(rows[0].n >= 1, '自授权被拒却没留痕')
    // 同一请求里的**另一个**人也必须没被加进去（整请求拒绝，不做部分应用）。
    const staff = await pool('platform').query(
      `SELECT count(*)::int AS n FROM role_members rm
         JOIN roles r ON r.role_id = rm.role_id
        WHERE r.company_id = $1 AND r.role_code = 'staff'`, [A.company])
    assert.equal(staff.rows[0].n, 0, '被拒的请求部分生效了')
  })

  test('正向对照：把**他人**加进业务角色 → 放行', async () => {
    const r = await api('POST', '/api/v1/admin/roles/staff/members', owner, { userIds: [A.bob] })
    assert.equal(r.status, 200)
    assert.deepEqual(r.body.userIds, [A.bob])
  })

  test('★ 策略整体替换：旧策略消失，新策略就位', async () => {
    await resetPolicies('staff')
    const first = await api('PUT', '/api/v1/admin/roles/staff/policies', owner, { policies: [
      { dimension: 'FORM', resourceCode: 'general_item', actions: ['read', 'create'] },
      { dimension: 'DATA', resourceCode: '*', dataScopes: ['SELF'] },
    ] })
    assert.equal(first.status, 200)
    assert.equal(first.body.count, 2)

    const second = await api('PUT', '/api/v1/admin/roles/staff/policies', owner, { policies: [
      { dimension: 'DATA', resourceCode: '*', dataScopes: ['COMPANY'] },
    ] })
    assert.equal(second.status, 200)
    const { rows } = await pool('platform').query(
      `SELECT p.dimension, p.data_scopes FROM policies p
         JOIN roles r ON r.role_id = p.role_id
        WHERE r.company_id = $1 AND r.role_code = 'staff'`, [A.company])
    assert.equal(rows.length, 1, '旧策略没被清掉 —— 这不是替换')
    assert.deepEqual(rows[0].data_scopes, ['COMPANY'])
  })

  test('★ 非法维度 / 非法数据范围 → 400，且**不改动既有策略**', async () => {
    const before = await pool('platform').query(
      `SELECT count(*)::int AS n FROM policies p JOIN roles r ON r.role_id = p.role_id
        WHERE r.company_id = $1 AND r.role_code = 'staff'`, [A.company])
    // `DATA_SCOPES` 是五档且是**数组并集**，不比较档位编号。
    const bad = await api('PUT', '/api/v1/admin/roles/staff/policies', owner, { policies: [
      { dimension: 'DATA', resourceCode: '*', dataScopes: ['EVERYTHING'] },
    ] })
    assert.equal(bad.status, 400)
    assert.equal(bad.body.error, 'KVVI_BAD_DATA_SCOPE')
    const dim = await api('PUT', '/api/v1/admin/roles/staff/policies', owner, { policies: [
      { dimension: 'SOMETHING', resourceCode: '*' },
    ] })
    assert.equal(dim.status, 400)
    assert.equal(dim.body.error, 'KVVI_BAD_DIMENSION')

    const after = await pool('platform').query(
      `SELECT count(*)::int AS n FROM policies p JOIN roles r ON r.role_id = p.role_id
        WHERE r.company_id = $1 AND r.role_code = 'staff'`, [A.company])
    assert.equal(after.rows[0].n, before.rows[0].n, '被拒的策略写入改动了数据')
  })

  test('★ 被委托者（admin）不能授予搭建模式', async () => {
    await api('POST', `/api/v1/admin/members/${A.carol}/platform-role`, owner, { roleCode: 'admin' })
    const r = await api('POST', `/api/v1/admin/members/${STAFF}/builder`, delegate)
    assert.equal(r.status, 403)
    assert.equal(r.body.error, 'KVVI_OWNER_REQUIRED')
    const { rows } = await pool('platform').query(
      `SELECT count(*)::int AS n FROM platform_mode_grants WHERE company_id = $1`, [A.company])
    assert.equal(rows[0].n, 0, '被委托者授予了搭建模式')
  })

  test('所有者授予搭建模式 → 放行并可收回，收回时结束 Builder 会话', async () => {
    const granted = await api('POST', `/api/v1/admin/members/${A.bob}/builder`, owner)
    assert.equal(granted.status, 200)
    assert.equal(granted.body.builder, true)

    await makeSession(A.bob, A.company, 'BUILDER')

    const revoked = await api('DELETE', `/api/v1/admin/members/${A.bob}/builder`, owner)
    assert.equal(revoked.status, 200)
    assert.ok(revoked.body.ended >= 1, '收回搭建模式没有结束已有 Builder 会话')
  })

  test('★ 最后一个所有者不可移除', async () => {
    // alice 是唯一所有者；把自己移除就是这家公司无法再被管理。
    //
    // ⚠️ 拒它的**不是**自授权禁令：§9.6.7 管的是「配置员工业务权限」，
    //    而移除平台保留角色是另一条规则（不能把公司变成没人能管理的）。
    //    第一版断言写成 403，量到的是我自己想错的那条规则。
    const r = await api('DELETE', `/api/v1/admin/members/${A.alice}/platform-role/owner`, owner)
    assert.equal(r.status, 409)
    assert.equal(r.body.error, 'KVVI_LAST_OWNER')
    const still = await pool('platform').query(
      `SELECT count(*)::int AS n FROM role_members rm JOIN roles r ON r.role_id = rm.role_id
        WHERE r.company_id = $1 AND r.role_code = 'owner'`, [A.company])
    assert.equal(still.rows[0].n, 1, '唯一的所有者被移除了')
  })

  test('★ 停用账号：状态落库且**全部会话立刻结束**', async () => {
    // 被停用者先开两个会话（一个 USER、一次重登），全部必须失效。
    await makeSession(A.bob, A.company)

    const r = await api('POST', `/api/v1/admin/members/${A.bob}/suspend`, owner)
    assert.equal(r.status, 200)
    assert.ok(r.body.endedSessions >= 2, '停用没有结束全部会话')

    const { rows } = await pool('platform').query(
      'SELECT status FROM users WHERE user_id = $1', [A.bob])
    assert.equal(rows[0].status, 'SUSPENDED')

    // 已签发的令牌立刻失效 —— 「停用落库、会话随后结束」的窗口里他还能写。
    const stale = await api('GET', '/api/v1/systems', employee)
    assert.equal(stale.status, 401, '被停用者的旧令牌仍可用')

    const active = await pool('platform').query(
      `SELECT count(*)::int AS n FROM sessions
        WHERE user_id = $1 AND state = 'ACTIVE'`, [A.bob])
    assert.equal(active.rows[0].n, 0, '还有活动会话')
  })

  test('重复停用 → 409（不是静默成功）', async () => {
    const r = await api('POST', `/api/v1/admin/members/${A.bob}/suspend`, owner)
    assert.equal(r.status, 409)
    assert.equal(r.body.error, 'KVVI_MEMBER_SUSPENDED')
  })

  test('恢复账号后要重新登录才可用', async () => {
    const r = await api('POST', `/api/v1/admin/members/${A.bob}/reactivate`, owner)
    assert.equal(r.status, 200)
    const { rows } = await pool('platform').query(
      'SELECT status FROM users WHERE user_id = $1', [A.bob])
    assert.equal(rows[0].status, 'ACTIVE')
    const still = await api('GET', '/api/v1/systems', employee)
    assert.equal(still.status, 401, '恢复不该让旧令牌复活')
  })

  test('对**非本公司成员**操作 → 404（不泄露存在性）', async () => {
    const { B } = await import('./harness.mjs')
    const r = await api('POST', `/api/v1/admin/members/${B.dave}/suspend`, owner)
    assert.equal(r.status, 404)
    assert.equal(r.body.error, 'KVVI_NOT_A_MEMBER')
  })

  test('未知管理路径 → 404，且带着路由名（便于排错）', async () => {
    const r = await api('GET', '/api/v1/admin/nope', owner)
    assert.equal(r.status, 404)
    assert.equal(r.body.error, 'KVVI_UNKNOWN_ROUTE')
  })

  test('审计链在以上全部操作后仍然自洽', async () => {
    const { verifyChain } = await import('../src/audit.mjs')
    const verdict = await verifyChain()
    assert.equal(verdict.ok, true, `审计链断了：${JSON.stringify(verdict)}`)
  })
})
