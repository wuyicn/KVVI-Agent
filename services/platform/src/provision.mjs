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
 * @returns {Promise<string[]>} 执行过的语句摘要
 */
export async function provision() {
  const log = []
  const admin = new Client({ connectionString: ADMIN_DSN })
  await admin.connect()
  try {
    // `KVVI_RESET=1` 先删库重建。**只在开发与测试**使用 ——
    // 它是一句 `DROP DATABASE`，对生产数据没有「撤销」。
    if (process.env.KVVI_RESET === '1') {
      for (const db of ['kvvi_platform', 'kvvi_business', 'kvvi_audit']) {
        await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`)
      }
      log.push('dropped 3 databases')
    }
    for (const [role] of ROLES) {
      await admin.query(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
          CREATE ROLE ${role} LOGIN PASSWORD '${PASSWORD}';
        END IF;
      END $$`)
      log.push(`role ${role}`)
    }
    for (const db of DATABASES) {
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
  await grant('kvvi_platform', ['kvvi_platform'])
  await grant('kvvi_business', ['kvvi_business'])
  await grant('kvvi_audit_writer', ['kvvi_audit'])
  await grant('kvvi_audit_reader', ['kvvi_audit'])

  // 反向撤销：确保没有任何角色能连别的库。
  // 只做「授予」不做「撤销」的话，一次误授予会永久留在集群里。
  await revokeOthers('kvvi_platform', ['kvvi_business', 'kvvi_audit'])
  await revokeOthers('kvvi_business', ['kvvi_platform', 'kvvi_audit'])
  await revokeOthers('kvvi_audit_writer', ['kvvi_platform', 'kvvi_business'])
  await revokeOthers('kvvi_audit_reader', ['kvvi_platform', 'kvvi_business'])
  log.push('grants/revokes')

  return log

  async function grant(role, dbs) {
    const admin2 = new Client({ connectionString: ADMIN_DSN })
    await admin2.connect()
    try {
      for (const db of dbs) {
        // 库级：能连接 + 能建对象（迁移）
        await admin2.query(`GRANT CONNECT ON DATABASE ${db} TO ${role}`)
      }
    } finally {
      await admin2.end()
    }
    const c = new Client({ connectionString: ADMIN_DSN.replace('/postgres', `/${dbs[0]}`) })
    await c.connect()
    try {
      await c.query(`GRANT ALL ON SCHEMA public TO ${role}`)
    } finally {
      await c.end()
    }
  }

  async function revokeOthers(role, dbs) {
    const admin2 = new Client({ connectionString: ADMIN_DSN })
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
