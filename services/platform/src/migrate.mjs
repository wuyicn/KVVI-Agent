/**
 * 迁移：建库、建角色、建表、建策略、分权。
 *
 * 用法：
 *   node src/migrate.mjs
 *
 * ⚠️ 需要超级用户连接（建库建角色）。平台服务进程本身**不用**超级用户。
 *
 * 分权是本脚本的重点，不是附赠：
 * 写审计的角色**读不到**审计，读审计的角色**写不了**审计。
 * 少了这一步，「审计读权限独立」与「防篡改」都只是文档里的句子。
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { provision } from './provision.mjs'

const { Client } = pg
const HERE = dirname(fileURLToPath(import.meta.url))
const SQL_DIR = resolve(HERE, '..', 'sql')
const PASSWORD = process.env.KVVI_DB_PASSWORD ?? 'kvvi-test'
const ADMIN = process.env.KVVI_ADMIN_DSN
  ?? `postgres://kvvi:${PASSWORD}@127.0.0.1:55432/postgres`

const adminFor = (db) => new Client({ connectionString: ADMIN.replace(/\/[^/]*$/, `/${db}`) })

/** 逐库执行一段 SQL。pg 的 simple query 支持多语句，但整段是一个事务单位。 */
async function applyFile(db, file) {
  const client = adminFor(db)
  await client.connect()
  try {
    await client.query(readFileSync(resolve(SQL_DIR, file), 'utf8'))
  } finally {
    await client.end()
  }
}

/** 授权：审计库的读写分离在这里落地。 */
async function grantAudit() {
  const client = adminFor('kvvi_audit')
  await client.connect()
  try {
    // 写者：**只有 EXECUTE**。既没有 SELECT（读不到审计），
    // 也没有 INSERT（绕不过 audit_append 自己写链）——
    // 因此「追加写」不只是一句约定，它是写者唯一的入口。
    await client.query(`REVOKE ALL ON FUNCTION audit_append(uuid,text,uuid,text,uuid,
      text,text,text,text,text,text,text) FROM PUBLIC`)
    await client.query(`GRANT USAGE ON SCHEMA public TO kvvi_audit_writer`)
    await client.query(`GRANT EXECUTE ON FUNCTION audit_append(uuid,text,uuid,text,uuid,
      text,text,text,text,text,text,text) TO kvvi_audit_writer`)
    // 读者：只能读，连 INSERT 都没有。
    await client.query(`GRANT USAGE ON SCHEMA public TO kvvi_audit_reader`)
    await client.query(`GRANT SELECT ON audit_entries TO kvvi_audit_reader`)
    await client.query(`GRANT EXECUTE ON FUNCTION audit_entry_hash(text,uuid,timestamptz,
      text,uuid,text,uuid,text,text,text,text,text,text,text) TO kvvi_audit_reader`)
  } finally {
    await client.end()
  }
}

/** 授权：业务库受 RLS 约束，角色拿到的是表权限、不是行权限。 */
async function grantBusiness() {
  const client = adminFor('kvvi_business')
  await client.connect()
  try {
    await client.query(`GRANT USAGE ON SCHEMA public TO kvvi_business`)
    await client.query(`GRANT SELECT, INSERT, UPDATE ON business_records TO kvvi_business`)
    await client.query(`GRANT SELECT, INSERT, UPDATE ON sequences TO kvvi_business`)
    // 函数默认对 PUBLIC 可执行，但 SECURITY INVOKER 意味着仍受 RLS 与表权限约束。
    await client.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO kvvi_business`)
  } finally {
    await client.end()
  }
}

async function grantPlatform() {
  const client = adminFor('kvvi_platform')
  await client.connect()
  try {
    await client.query(`GRANT USAGE ON SCHEMA public TO kvvi_platform`)
    await client.query(`GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO kvvi_platform`)
    await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO kvvi_platform`)
  } finally {
    await client.end()
  }
}

async function main() {
  const steps = await provision()
  await applyFile('kvvi_platform', '10-platform.sql')
  await applyFile('kvvi_platform', '15-visitor.sql')
  await applyFile('kvvi_business', '20-business.sql')
  await applyFile('kvvi_audit', '30-audit.sql')
  await grantPlatform()
  await grantBusiness()
  await grantAudit()
  console.log(JSON.stringify({
    event: 'kvvi-migrate-done',
    provision: steps,
    databases: ['kvvi_platform', 'kvvi_business', 'kvvi_audit'],
  }))
}

main().catch((error) => {
  console.error(JSON.stringify({ event: 'kvvi-migrate-failed', error: String(error) }))
  process.exit(1)
})
