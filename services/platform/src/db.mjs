/**
 * 三个数据库的连接（PRD §4.6.1）。
 *
 * ── 为什么是三个，而不是一个库三张表 ────────────────────────────────────
 *
 * §4.6.1 要求审计库**独立于平台库，也独立于业务系统库**。这条要求不是
 * 「分类好看」——它要买到的是：**一把钥匙开不了两扇门**。
 *
 * 同库同角色时，能写业务数据的连接自然也能 `DELETE FROM audit_entries`，
 * 于是「审计不可篡改」（§9.11.2）只剩下一句纪律。分成三个库之后，
 * 「平台库连接读不到审计」成了 PostgreSQL 的**连接级事实**，不是约定。
 *
 * ── 边界（必须与结论一起说明）──────────────────────────────────────────
 *
 * 本模块实现的是**逻辑隔离**（三个库、三个角色）。§4.6.1 还要求
 * 「不共享主机管理域、DBA、备份通道」—— 那是**部署面**的事：
 * 同一实例上的三个库在开发环境够用，**生产环境仍是同一台主机**，
 * 所以本阶段**不主张**已满足 §4.6.1 的部署面要求。该条列入交付前待办。
 */
import pg from 'pg'

const { Pool } = pg

/** 开发环境默认值。生产由环境注入，且**不得**是超级用户。 */
const DEFAULTS = {
  platform: 'postgres://kvvi_platform:kvvi-test@127.0.0.1:55432/kvvi_platform',
  business: 'postgres://kvvi_business:kvvi-test@127.0.0.1:55432/kvvi_business',
  audit: 'postgres://kvvi_audit_writer:kvvi-test@127.0.0.1:55432/kvvi_audit',
  auditRead: 'postgres://kvvi_audit_reader:kvvi-test@127.0.0.1:55432/kvvi_audit',
  // 超级用户连接：**只给迁移与测试**。平台服务进程本身不用它 ——
  // 用超级用户连接会让 RLS 与分权全部失效（超级用户绕过 RLS）。
  admin: 'postgres://kvvi:kvvi-test@127.0.0.1:55432/postgres',
}

const pools = new Map()

/**
 * 取一个连接池。
 * @param {'platform'|'business'|'audit'|'auditRead'|'admin'} name 库名
 * @returns {import('pg').Pool} 连接池
 */
export function pool(name) {
  if (pools.has(name)) return pools.get(name)
  const dsn = process.env[`KVVI_${name.toUpperCase()}_DSN`] ?? DEFAULTS[name]
  if (!dsn) throw new Error(`缺少 ${name} 的连接串`)
  const p = new Pool({ connectionString: dsn, max: 8 })
  pools.set(name, p)
  return p
}

/** 所有库的连接串（迁移与诊断用）。 */
export function dsns() {
  return Object.fromEntries(
    Object.keys(DEFAULTS).map((k) => [k, process.env[`KVVI_${k.toUpperCase()}_DSN`] ?? DEFAULTS[k]]),
  )
}

/** 关闭全部连接池。 */
export async function closeAll() {
  await Promise.all([...pools.values()].map((p) => p.end()))
  pools.clear()
}

/**
 * 在一个事务里执行。
 *
 * 单号分配与落库必须在同一事务（见 `ledger.mjs`），
 * 而**跨库事务不存在** —— 这正是序列被放在业务库的原因。
 * @param {string} name 库名
 * @param {(client: import('pg').PoolClient) => Promise<any>} fn 事务体
 */
export async function withTransaction(name, fn) {
  const client = await pool(name).connect()
  try {
    await client.query('BEGIN')
    const out = await fn(client)
    await client.query('COMMIT')
    return out
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
