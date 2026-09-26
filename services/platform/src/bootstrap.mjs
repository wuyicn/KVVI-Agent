/**
 * 首次初始化：建一家公司、一个所有者账号，然后**永久关闭**这条入口。
 *
 * ── 为什么这件事必须在一个事务里 ──────────────────────────────────────────
 *
 * 一次 bootstrap 要写四样东西：公司、账号、成员关系、所有者角色，
 * 外加一个「已用掉」的标记。分开提交的话，中断会留下四种半成品，每一种都很难收拾：
 *
 * | 中断在哪 | 留下的东西 | 后果 |
 * |---|---|---|
 * | 建了公司，没建账号 | 一家没有人的公司 | 谁也进不去，只能删库 |
 * | 建了账号，没加角色 | 一个能登录但不是所有者的人 | 登录成功却什么都管不了，界面不解释 |
 * | 加了角色，没写标记 | 入口仍然开着 | **任何能到达端口的人都能再建一个所有者** |
 *
 * 所以：全部写在同一个事务里，标记也写在里面。要么全成，要么什么都不留。
 *
 * ── 为什么入口是一次性的 ────────────────────────────────────────────────
 *
 * 安装完成到客户打开浏览器之间有一个窗口，这期间端口是活的。
 * 一个可以反复调用的 bootstrap 端点，在窗口期就是一个「谁先到谁当所有者」的抢注入口。
 * 所以标记一旦写入，后续调用一律 `410 Gone` —— 不是 403（那是权限问题），
 * 也不是 404（那会让人以为端点不存在而去找别的地方）。
 *
 * ── 令牌为什么必须要有 ──────────────────────────────────────────────────
 *
 * 仅有「一次性」还不够：从进程起来到客户打开浏览器之间，先到的仍可能是别人。
 * 所以安装时生成一枚一次性令牌，它**只写到安装输出与本地文件**，不在任何接口回显。
 * 这与 §9.4.2 的令牌撤销是同一套思路：入口的凭据只在需要它的那一刻存在。
 */

import { randomUUID } from 'node:crypto'
import { withTransaction, pool } from './db.mjs'
import { hashPassword } from './identity.mjs'
import { append, digestOf } from './audit.mjs'

/** 稳定错误码 → HTTP 状态。与项目其它入口同一约定。 */
const STATUS_OF = Object.freeze({
  KVVI_BOOTSTRAP_CLOSED: 410,
  KVVI_BOOTSTRAP_TOKEN_REQUIRED: 401,
  KVVI_BOOTSTRAP_TOKEN_INVALID: 401,
  KVVI_BOOTSTRAP_BAD_REQUEST: 400,
  KVVI_BOOTSTRAP_WEAK_PASSWORD: 400,
})

/** 口令下限。与 `admin-api.mjs` 的建账号同一门槛 —— 两处不一致会让「哪条更严」无从判断。 */
const MIN_PASSWORD_LENGTH = 8

/** 一次性标记写在平台库里，键固定。 */
const MARKER_KEY = 'bootstrap.completed'

/**
 * 该实例是否已经初始化过。
 *
 * ⚠️ **不在这里建表。** 标记表由迁移 `19-instance-bootstrap.sql` 建好 ——
 * 第一版在请求路径里 `CREATE TABLE IF NOT EXISTS`，两个并发调用会同时建表，
 * PostgreSQL 在并发 DDL 上会报唯一冲突或死锁，于是**两个都失败**。
 * 而「一次性初始化」恰恰是最可能被并发调用的端点（安装脚本重试、浏览器双击）。
 * **模式属于迁移，不属于请求路径。**
 * @returns {Promise<{completed: boolean, companyId?: string, userId?: string}>}
 */
export async function bootstrapState() {
  const { rows } = await pool('platform').query(
    'SELECT company_id, user_id FROM instance_bootstrap WHERE marker = $1', [MARKER_KEY])
  if (rows.length === 0) return { completed: false }
  return { completed: true, companyId: rows[0].company_id, userId: rows[0].user_id }
}

/**
 * 记一次**不含公司**的拒绝。
 *
 * ⚠️ 审计链是**按公司**串起来的，`audit_entries.company_id` 是 NOT NULL，
 * 而 bootstrap 被拒时还没有公司 —— 那正是这件事的含义。
 * 硬塞一个空值会撞 NOT NULL；造一个「系统公司」当哨兵则会让
 * 「谁是这家公司的成员」多出一个假成员。两者都比一行 stderr 更坏。
 * 所以这里只写进程日志：**运维看得到，审计链不被污染。**
 * @param reason 拒绝原因
 * @param detail 附加信息
 */
function logDenial(reason, detail) {
  process.stderr.write(JSON.stringify({
    event: 'kvvi-bootstrap-denied', reason, detail,
  }) + '\n')
}

/**
 * 一次性的首次初始化。
 *
 * @param input 公司与所有者
 * @param input.token 安装时生成的一次性令牌
 * @param input.expectedToken 服务端持有的同一枚令牌
 * @param input.companyName 公司名
 * @param input.login 所有者登录名
 * @param input.password 所有者口令
 * @returns `{status, body}`
 */
export async function bootstrapOwner({ token, expectedToken, companyName, login, password }) {
  if (typeof expectedToken !== 'string' || expectedToken === '') {
    // 没有配置令牌时**拒绝服务**，而不是放行。
    // 一个「没配令牌就等于不校验」的实现，在生产里就是没有门。
    return { status: 401, body: { error: 'KVVI_BOOTSTRAP_TOKEN_REQUIRED' } }
  }
  if (typeof token !== 'string' || token === '') {
    return { status: 401, body: { error: 'KVVI_BOOTSTRAP_TOKEN_REQUIRED' } }
  }
  if (token !== expectedToken) {
    logDenial('KVVI_BOOTSTRAP_TOKEN_INVALID', { login: login ?? null })
    return { status: 401, body: { error: 'KVVI_BOOTSTRAP_TOKEN_INVALID' } }
  }

  const name = typeof companyName === 'string' ? companyName.trim() : ''
  const ownerLogin = typeof login === 'string' ? login.trim() : ''
  if (name === '' || ownerLogin === '') {
    return { status: 400, body: { error: 'KVVI_BOOTSTRAP_BAD_REQUEST',
      detail: '公司名与登录名都不能为空' } }
  }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return { status: 400, body: { error: 'KVVI_BOOTSTRAP_WEAK_PASSWORD',
      detail: `口令至少 ${MIN_PASSWORD_LENGTH} 位` } }
  }

  try {
    const created = await withTransaction('platform', async (client) => {
      // ★ 唯一约束 + `ON CONFLICT DO NOTHING` 是**判据本身**，不是优化：
      //   两个并发的 bootstrap 只有一个能写进标记，另一个拿到 0 行。
      //   先查后写的实现有窗口，窗口里的两次调用会各建一家公司。
      const taken = await client.query(
        `INSERT INTO instance_bootstrap (marker) VALUES ($1)
         ON CONFLICT (marker) DO NOTHING RETURNING marker`, [MARKER_KEY])
      if (taken.rows.length === 0) throw new Error('KVVI_BOOTSTRAP_CLOSED')

      const companyId = randomUUID()
      const userId = randomUUID()
      await client.query(
        'INSERT INTO companies (company_id, name) VALUES ($1, $2)', [companyId, name])
      await client.query(
        `INSERT INTO users (user_id, login, password_hash, status)
         VALUES ($1, $2, $3, 'ACTIVE')`, [userId, ownerLogin, hashPassword(password)])
      await client.query(
        'INSERT INTO memberships (company_id, user_id) VALUES ($1, $2)', [companyId, userId])

      // 所有者角色：`owner` 是**平台保留 code**（`PLATFORM_ROLE_CODES`）。
      // 它不能被业务角色占用，所以这里用固定的 code 建，而不是随机生成。
      const role = await client.query(
        `INSERT INTO roles (role_id, company_id, role_code, name)
         VALUES (gen_random_uuid(), $1, 'owner', '所有者')
         RETURNING role_id`, [companyId])
      await client.query(
        'INSERT INTO role_members (company_id, role_id, user_id) VALUES ($1, $2, $3)',
        [companyId, role.rows[0].role_id, userId])

      await client.query(
        `UPDATE instance_bootstrap SET company_id = $1, user_id = $2
          WHERE marker = $3`, [companyId, userId, MARKER_KEY])
      return { companyId, userId }
    })

    await append({
      companyId: created.companyId, actorKind: 'SYSTEM', actorId: created.userId,
      gateway: null, sessionId: null, action: 'bootstrap.owner', outcome: 'ALLOW',
      resourceKind: 'USER', resourceId: created.userId,
      paramsDigest: digestOf({ login: ownerLogin, company: name }),
    })
    return { status: 201, body: { companyId: created.companyId, userId: created.userId,
                                  login: ownerLogin, companyName: name } }
  } catch (error) {
    if (error?.message === 'KVVI_BOOTSTRAP_CLOSED') {
      const state = await bootstrapState()
      return { status: 410, body: { error: 'KVVI_BOOTSTRAP_CLOSED',
        companyId: state.companyId, userId: state.userId } }
    }
    if (error?.code === '23505') {
      // 登录名撞了。**整个事务已回滚**，所以没有半成品公司。
      return { status: 409, body: { error: 'KVVI_LOGIN_EXISTS', login: ownerLogin } }
    }
    throw error
  }
}

/**
 * 分派 bootstrap 端点。
 * @param input `{method, path, body, expectedToken}`
 * @returns `{status, body}`，或 `null` 表示不是本模块的路径
 */
export async function bootstrapRoutes({ method, path, body, expectedToken }) {
  if (path === '/bootstrap/state' && method === 'GET') {
    const state = await bootstrapState()
    // 只回「做过没有」。公司 id 与账号 id **不在这里回显** ——
    // 那是一个未鉴权端点，回显身份等于给出一个枚举入口。
    return { status: 200, body: { completed: state.completed } }
  }
  if (path === '/bootstrap/owner' && method === 'POST') {
    return await bootstrapOwner({
      token: body?.token, expectedToken,
      companyName: body?.companyName, login: body?.login, password: body?.password,
    })
  }
  return null
}

export { MIN_PASSWORD_LENGTH }
