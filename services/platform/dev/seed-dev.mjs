/**
 * 开发与演示用的**最小可用账号集** —— 只在开发/演示环境跑。
 *
 * ── 它解决的具体问题 ──────────────────────────────────────────────────────
 *
 * 全新库里 `users` / `companies` / `memberships` 都是空的，
 * 于是 `/auth/login` 无论传什么都回 `KVVI_BAD_CREDENTIALS` ——
 * 看起来像「登录坏了」，实际是**没有账号**。而这个仓库此前没有任何一条
 * 「怎么造一个账号」的路径：测试用例在测试内部现造，开发栈没有。
 *
 * ── 为什么放在 services/ 而不是工具/ ──────────────────────────────────────
 *
 * 它要用 `pg`（`工具/*.py` 是 Python，连不上）与 `identity.mjs` 的
 * `hashPassword`（口令散列只有一份实现，不能在别处再抄一份 —— 抄一份就会漂移）。
 *
 * ── 为什么只创建、不更新 ─────────────────────────────────────────────────
 *
 * 口令用 `ON CONFLICT DO NOTHING` 而不是 `DO UPDATE`：
 * 重复跑种子不该**悄悄重置**一个已被改过口令的账号 ——
 * 那会让「我改了密码」在下一次 seed 时无声消失。
 * 需要重置就 `--reset-passwords`，明确说出你要做什么。
 *
 * ── 为什么不在 src/ ───────────────────────────────────────────────────
 *
 * `工具/check_publish_channel.py` 静态核查「`src/` 里只有发布通道能写 `policies`」
 * —— 那是 §9.6.3「业务权限策略不得被旁路」的机器判据。
 * 本脚本确实往 `policies` 里插入**固定装置**（员工的读范围），
 * 于是它一放进 `src/` 就会被正确地报成旁路。
 *
 * 修法**不是**给检查器加白名单 —— 那会同时放过一个真的旁路。
 * 修法是让「它是开发工具、不在产品代码路径上」变成一个**结构性事实**：
 * 它不在 `src/` 里，客户部署路径也拿不到它。
 *
 * 用法（在 platform 容器内跑）：
 *   node dev/seed-dev.mjs
 *   node dev/seed-dev.mjs --reset-passwords
 *
 * 由 `scripts/kvvi-up.sh --seed-dev` 调用，不暴露给生产部署路径。
 */
import pg from 'pg'
import { randomUUID } from 'node:crypto'
// ⚠️ 本文件在 `dev/`，不在 `src/` —— 见文件头对「为什么」的说明。
import { hashPassword } from '../src/identity.mjs'

const { Client } = pg

/** ⚠️ 开发口令。**故意写成一眼能认出是开发用的形状**，避免被误当生产凭据。 */
const DEV_PASSWORD = process.env.KVVI_DEV_PASSWORD ?? 'kvvi-dev-pass'

/**
 * 连到平台库。
 *
 * ⚠️ **两条环境变量都要认**，因为调用它的两个场景给的不是同一个名字：
 * 平台进程自己有 `KVVI_PLATFORM_DSN`；而迁移服务（同一个镜像）带的是
 * `KVVI_ADMIN_DSN_PLATFORM`（连到 `postgres` 库、由脚本自己切库）。
 * 只认第一个的话，走 `scripts/kvvi-up.sh --seed-dev` 会回退到硬编码的
 * `127.0.0.1:55432`，报 ECONNREFUSED —— 看着像「数据库没起」，其实是读错了变量。
 */
const PLATFORM_DSN = process.env.KVVI_PLATFORM_DSN
  ?? process.env.KVVI_ADMIN_DSN_PLATFORM?.replace(/\/[^/]*$/, '/kvvi_platform')
  ?? 'postgres://kvvi_platform:kvvi-test@127.0.0.1:55432/kvvi_platform'

/**
 * 两家公司、四个账号。
 *
 * 两家公司不是装饰：**单公司无法验出跨租户拒绝**（§9.9.2）。
 * 只有一个租户时，「租户隔离」这条永远看不到反例。
 */
const COMPANIES = [
  { companyId: '11111111-1111-4111-8111-111111111111', name: '示例公司甲' },
  { companyId: '22222222-2222-4222-8222-222222222222', name: '示例公司乙' },
]

const USERS = [
  // 甲公司的业务员工：走工作模式，是工作台要服务的那种人。
  { login: 'dev-employee', name: '员工·甲', company: 0, role: 'employee' },
  // 甲公司的内部搭建者：走搭建引擎模式。
  { login: 'dev-builder', name: '搭建者·甲', company: 0, role: 'builder' },
  // 甲公司的所有者：唯一能授予搭建权限的角色。
  { login: 'dev-owner', name: '所有者·甲', company: 0, role: 'owner' },
  // 乙公司的员工：用来验「同一登录名在两个租户下是两套数据」。
  { login: 'dev-employee-b', name: '员工·乙', company: 1, role: 'employee' },
]

const ROLES = [
  { code: 'owner', name: '所有者' },
  { code: 'builder', name: '搭建者' },
  { code: 'employee', name: '业务员工' },
]

/** 员工能做什么。**只给最小集**：员工不该有搭建权限（§2.3 能力隔离）。 */
const EMPLOYEE_POLICIES = [
  { dimension: 'DATA', resource_code: 'business_records', actions: ['READ', 'WRITE'], scopes: ['SELF'] },
]

async function main() {
  const resetPasswords = process.argv.includes('--reset-passwords')
  const client = new Client({ connectionString: PLATFORM_DSN })
  await client.connect()
  const created = { companies: 0, users: 0, memberships: 0, roles: 0, policies: 0 }
  try {
    for (const c of COMPANIES) {
      const r = await client.query(
        `INSERT INTO companies (company_id, name) VALUES ($1, $2)
         ON CONFLICT (company_id) DO NOTHING`, [c.companyId, c.name])
      created.companies += r.rowCount
    }

    for (const u of USERS) {
      const userId = randomUUID()
      const hash = hashPassword(DEV_PASSWORD)
      const r = await client.query(
        `INSERT INTO users (user_id, login, password_hash, status)
         VALUES ($1, $2, $3, 'ACTIVE')
         ON CONFLICT (login) DO ${resetPasswords
          ? 'UPDATE SET password_hash = EXCLUDED.password_hash'
          : 'NOTHING'}
         RETURNING user_id`, [userId, u.login, hash])
      if (r.rowCount > 0) created.users += 1

      // 已存在的账号：沿用库里那一条，不要拿刚生成的随机 uuid 去建 membership
      // —— 那会插一个指向不存在 user_id 的成员关系，直接撞外键。
      const idRow = await client.query('SELECT user_id FROM users WHERE login = $1', [u.login])
      const effectiveUserId = idRow.rows[0].user_id
      const companyId = COMPANIES[u.company].companyId

      const m = await client.query(
        `INSERT INTO memberships (company_id, user_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`, [companyId, effectiveUserId])
      created.memberships += m.rowCount

      const roleId = randomUUID()
      const roleRow = await client.query(
        `INSERT INTO roles (role_id, company_id, role_code, name) VALUES ($1, $2, $3, $4)
         ON CONFLICT (company_id, role_code) DO NOTHING
         RETURNING role_id`, [roleId, companyId, u.role,
          (ROLES.find((x) => x.code === u.role) ?? { name: u.role }).name])
      if (roleRow.rowCount > 0) created.roles += 1
      const effectiveRoleId = roleRow.rowCount > 0
        ? roleRow.rows[0].role_id
        : (await client.query(
          'SELECT role_id FROM roles WHERE company_id = $1 AND role_code = $2',
          [companyId, u.role])).rows[0].role_id

      await client.query(
        `INSERT INTO role_members (company_id, role_id, user_id) VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`, [companyId, effectiveRoleId, effectiveUserId])

      if (u.role === 'employee') {
        for (const p of EMPLOYEE_POLICIES) {
          const pr = await client.query(
            `INSERT INTO policies (policy_id, company_id, role_id, dimension,
               resource_code, actions, data_scopes)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (company_id, role_id, dimension, resource_code) DO NOTHING`,
            [randomUUID(), companyId, effectiveRoleId, p.dimension,
             p.resource_code, p.actions, p.scopes])
          created.policies += pr.rowCount
        }
      }
    }

    console.log(JSON.stringify({
      event: 'kvvi-seed-dev-done',
      created,
      logins: USERS.map((u) => u.login),
      password: DEV_PASSWORD,
      warning: '开发演示账号 —— 生产环境不得执行本脚本',
    }))
  } finally {
    await client.end()
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ event: 'kvvi-seed-dev-failed', error: String(error) }))
  process.exit(1)
})
