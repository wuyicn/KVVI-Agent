/**
 * 以**超级用户**连接某个库（诊断与完整性检查用）。
 *
 * ⚠️ 只给**检查**用，不给业务路径用。业务路径必须走带作用域上下文的连接，
 * 否则 RLS 会被绕过 —— 而绕过 RLS 的那些写法**不会报错**，
 * 只会读到/改到更多东西。
 */
import pg from 'pg'
import { dsns } from './db.mjs'

const { Client } = pg

/**
 * @param {string} db 库名（`kvvi_business` / `kvvi_platform` / `kvvi_audit`）
 * @param {string} sql 语句
 * @param {any[]} params 参数
 * @returns {Promise<import('pg').QueryResult>} 结果
 */
export async function adminQueryFor(db, sql, params = []) {
  const client = new Client({ connectionString: dsns().admin.replace(/\/[^/]*$/, `/${db}`) })
  await client.connect()
  try {
    return await client.query(sql, params)
  } finally {
    await client.end()
  }
}
