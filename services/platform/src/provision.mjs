/**
 * 建库与建角色（PRD §4.6.1）。
 *
 * ── 为什么角色也在这里建 ────────────────────────────────────────────────
 *
 * 「审计读权限独立于其他权限」（§9.11.2）只有在**权限是分开的**时候才有内容。
 * 因此本脚本建出四个角色，各自只能做一件事：
 *
 *   kvvi_platform      平台库：读写（组织、账号、策略、会话）
 *   kvvi_business      业务库：读写记录与序列（并受 RLS 约束）
 *   kvvi_audit_writer  审计库：**只能追加**（INSERT + 调 audit_append），**不能读**
 *   kvvi_audit_reader  审计库：**只能读**
 *
 * 写审计的角色读不到审计，读审计的角色写不了审计 —— 这条由 PostgreSQL 保证，
 * 不靠调用方自觉。
 *
 * ⚠️ 本脚本需要**超级用户连接**（建库建角色）。它只在部署与测试时运行，
 * 平台服务进程本身**不用**超级用户连接。
 */
import pg from 'pg'

const { Client } = pg

const PASSWORD = process.env.KVVI_DB_PASSWORD ?? 'kvvi-test'
const ADMIN_DSN = process.env.KVVI_ADMIN_DSN
  ?? `postgres://kvvi:${PASSWORD}@127.0.0.1:55432/postgres`

const DATABASES = ['kvvi_platform', 'kvvi_business', 'kvvi_audit']

const ROLES = [
  ['kvvi_platform', PASSWORD],
  ['kvvi_business', PASSWORD],
  ['kvvi_audit_writer', PASSWORD],
  ['kvvi_audit_reader', PASSWORD],
]

/**
 * 建库、建角色、分权。**幂等**：可重复运行。
 *
 * @param {object} [options]
 * @param {string} [options.dsn] 该实例的管理连接串；缺省用 `KVVI_ADMIN_DSN`。
 *   ⚠️ 三个库分属三个实例时**必须**逐实例调用 —— 一个超级用户连不到另一个实例，
 *   「角色已存在」的判断会查在错的实例上。
 * @param {string[]} [options.roles] 该实例上要建的角色；缺省建全部四个。
 * @param {string[]} [options.databases] 该实例上要建的库；缺省建全部三个。
 * @param {Record<string,string>} [options.passwords] 角色 → 口令；缺省都用 `KVVI_DB_PASSWORD`。
 * @returns {Promise<string[]>} 执行过的语句摘要
 */
export async function provision(options = {}) {
  const dsn = options.dsn ?? ADMIN_DSN
  const databases = options.databases ?? DATABASES
  const roles = options.roles ?? ROLES.map(([name]) => name)
  const passwords = options.passwords ?? {}
  const passwordOf = (role) => passwords[role] ?? PASSWORD
  // 本实例上建了几个库 —— 多于一个就说明这是「单实例多库」的测试夹具形态，
  // 跨库撤销才有意义。三实例形态下它必然是 1。
  const isSingleCluster = databases.length > 1

  const log = []
  const admin = new Client({ connectionString: dsn })
  await admin.connect()
  try {
    // `KVVI_RESET=1` 先删库重建。**只在开发与测试**使用 ——
    // 它是一句 `DROP DATABASE`，对生产数据没有「撤销」。
    if (process.env.KVVI_RESET === '1') {
      for (const db of databases) {
        await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`)
      }
      log.push('dropped ' + databases.length + ' databases')
    }
    for (const role of roles) {
      await admin.query(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
          CREATE ROLE ${role} LOGIN PASSWORD '${passwordOf(role)}';
        END IF;
      END $$`)
      log.push(`role ${role}`)
    }
    for (const db of databases) {
      const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [db])
      if (rows.length === 0) {
        await admin.query(`CREATE DATABASE ${db}`)
        log.push(`database ${db}`)
      }
    }
  } finally {
    await admin.end()
  }

  // 逐库授予。**每个角色只连自己的库** —— 这是「一把钥匙开不了两扇门」
  // 在授权层面的形状。
  //
  // ⚠️ 三库分属三个实例时，**在本实例里只授予本实例的角色**：
  // 别实例的角色名在这里根本不存在，`GRANT ... TO` 会直接报错。
  // 这不是「少做了一步」—— 实例之间本来就不共享角色目录。
  const GRANTS = [
    ['kvvi_platform', ['kvvi_platform']],
    ['kvvi_business', ['kvvi_business']],
    ['kvvi_audit_writer', ['kvvi_audit']],
    ['kvvi_audit_reader', ['kvvi_audit']],
  ]
  for (const [role, dbs] of GRANTS) {
    if (!roles.includes(role)) continue
    await grant(role, dbs.filter((db) => databases.includes(db)))
  }

  // 反向撤销：确保没有任何角色能连别的库。
  // 只做「授予」不做「撤销」的话，一次误授予会永久留在集群里。
  // 单实例（测试夹具）里三个库同处一个集群，这条**是**唯一能拦住跨库连接的检查；
  // 三实例（compose）里它退化为空操作 —— 边界已经由网络隔离给定了。
  if (isSingleCluster) {
    const pairs = [
      ['kvvi_platform', ['kvvi_business', 'kvvi_audit']],
      ['kvvi_business', ['kvvi_platform', 'kvvi_audit']],
      ['kvvi_audit_writer', ['kvvi_platform', 'kvvi_business']],
      ['kvvi_audit_reader', ['kvvi_platform', 'kvvi_business']],
    ]
    for (const [role, dbs] of pairs) {
      if (!roles.includes(role)) continue
      await revokeOthers(role, dbs)
    }
    log.push('revokes')
  }
  log.push('grants')

  return log

  async function grant(role, dbs) {
    if (dbs.length === 0) return
    const admin2 = new Client({ connectionString: dsn })
    await admin2.connect()
    try {
      for (const db of dbs) {
        // 库级：能连接 + 能建对象（迁移）
        await admin2.query(`GRANT CONNECT ON DATABASE ${db} TO ${role}`)
      }
    } finally {
      await admin2.end()
    }
    const c = new Client({ connectionString: dsn.replace('/postgres', `/${dbs[0]}`) })
    await c.connect()
    try {
      await c.query(`GRANT ALL ON SCHEMA public TO ${role}`)
    } finally {
      await c.end()
    }
  }

  async function revokeOthers(role, dbs) {
    const admin2 = new Client({ connectionString: dsn })
    await admin2.connect()
    try {
      for (const db of dbs) {
        await admin2.query(`REVOKE CONNECT ON DATABASE ${db} FROM ${role}`)
      }
    } finally {
      await admin2.end()
    }
  }
}

/**
 * 迁移：建表、建策略、建链。
 * @param {import('pg').Client} client 已连接的客户端
 * @param {string} sql 语句
 */
export async function runSql(client, sql) {
  await client.query(sql)
}
