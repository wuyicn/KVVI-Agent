/**
 * 阶段四锚点③：审计防篡改（PRD §9.11.2）。
 *
 * ⚠️ 本文件的核心不是「链算得对」，而是**改了会被发现**。
 * 一个永远返回 `ok: true` 的校验同样是校验，所以「篡改必须检出」这条
 * 是拿超级用户权限真的去改一条记录来验的 —— 不是模拟，不是假设。
 */
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { pool, closeAll, dsns } from '../src/db.mjs'
import { A, B, resetDatabase } from './harness.mjs'
import { append, appendDenial, verifyChain, digestOf, peek, tamperForTest } from '../src/audit.mjs'

before(async () => {
  await resetDatabase()
  process.env.KVVI_ALLOW_TAMPER = '1'
})
after(closeAll)

const base = {
  companyId: A.company, actorKind: 'USER', actorId: A.alice, gateway: 'USER',
  sessionId: 'a0000000-0000-4000-8000-00000000ff01',
  resourceKind: 'record', resourceId: 'c0000000-0000-4000-8000-000000000001',
}

describe('锚点③ 审计：追加写 + 哈希链', () => {
  test('写入若干条后整条链自洽', async () => {
    await append({ ...base, action: 'data.readView', outcome: 'ALLOW',
                   paramsDigest: digestOf({ id: 1 }) })
    await appendDenial({ ...base, action: 'flow.approve', reason: 'KVVI_TRANSITION_NOT_DEFINED' })
    await append({ ...base, companyId: B.company, action: 'data.readView', outcome: 'ALLOW' })
    const result = await verifyChain()
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.ok(result.entries >= 3, '链里条目太少，校验是空转的')
  })

  test('**拒绝也留痕**：DENY 与 ALLOW 同样记录，且带理由', async () => {
    const before1 = await verifyChain()
    await appendDenial({ ...base, action: 'schema.designModel',
                         reason: 'KVVI_WRONG_GATEWAY' })
    const after1 = await verifyChain()
    assert.equal(after1.entries, before1.entries + 1)
    const row = await peek(await lastSeq())
    assert.equal(row.outcome, 'DENY')
    assert.equal(row.reason, 'KVVI_WRONG_GATEWAY')
  })

  test('敏感值不入日志：只记摘要，不记明文', async () => {
    const secret = '身份证号 110101199001011234'
    await append({ ...base, action: 'data.readView', outcome: 'ALLOW',
                   paramsDigest: digestOf({ secret }) })
    const { rows } = await pool('auditRead').query(
      `SELECT params_digest FROM audit_entries ORDER BY seq DESC LIMIT 1`)
    assert.ok(!rows[0].params_digest.includes('110101'), '参数摘要里出现了明文')
    assert.equal(rows[0].params_digest, digestOf({ secret }))
  })
})

describe('锚点③ 防篡改：**改了必须被发现**', () => {
  test('改一条记录的内容 → 链在校验时报断点（KVVI_AUDIT_ENTRY_TAMPERED）', async () => {
    const target = await lastSeq()
    await tamperForTest(target, 'tampered.action')
    const result = await verifyChain()
    assert.equal(result.ok, false, '篡改未被检出 —— 这个校验是恒真的')
    assert.equal(result.reason, 'KVVI_AUDIT_ENTRY_TAMPERED')
    assert.equal(result.brokenAt, target, '断点位置不对，事后取证没有用')
  })

  test('删掉中间一条 → 后一条的 prev_hash 对不上', async () => {
    const target = await lastSeq() - 1
    const { Client } = await import('pg')
    const admin = new Client({ connectionString: dsns().admin.replace(/\/[^/]*$/, '/kvvi_audit') })
    await admin.connect()
    try {
      await admin.query('ALTER TABLE audit_entries DISABLE RULE audit_no_delete')
      await admin.query('DELETE FROM audit_entries WHERE seq = $1', [target])
      await admin.query('ALTER TABLE audit_entries ENABLE RULE audit_no_delete')
    } finally {
      await admin.end()
    }
    const result = await verifyChain()
    assert.equal(result.ok, false, '删掉一条不被发现 —— 链没有接上')
    assert.equal(result.reason, 'KVVI_AUDIT_CHAIN_LINK_BROKEN')
  })
})

describe('锚点③ 访问控制：写者读不到，读者写不了', () => {
  test('审计写者角色**读不到**审计', async () => {
    await assert.rejects(
      () => pool('audit').query('SELECT count(*) FROM audit_entries'),
      (err) => err.code === '42501',
      '写者能读审计 —— §9.11.2「读权限独立」落空')
  })

  test('审计写者角色**不能直接 INSERT**（只能经 audit_append）', async () => {
    await assert.rejects(
      () => pool('audit').query(
        `INSERT INTO audit_entries (company_id, actor_kind, action, outcome,
           prev_hash, entry_hash)
         VALUES ($1,'USER','x','ALLOW','0','0')`, [A.company]),
      (err) => err.code === '42501',
      '写者能绕过 audit_append 直接写 —— 链可以被绕过')
  })

  test('UPDATE / DELETE **改不动任何一行**，且链仍然自洽', async () => {
    // ⚠️ 这一条不能断言「抛权限错误」——实测 `DO INSTEAD NOTHING` 规则
    // 在权限检查**之前**重写语句，所以即使是没有任何表权限的角色，
    // `DELETE` 也会返回 `DELETE 0` 而不是报错。
    //
    // 断言「报错」会把一个**正确的实现**判成失败；真正要验的性质是
    // **一行都没变**。所以这里直接验结果：
    //   ① 影响行数为 0；  ② 表里的内容没变；  ③ 链仍然校验通过。
    const before = await verifyChain()
    const deleted = await pool('audit').query('DELETE FROM audit_entries')
    const updated = await pool('audit').query(`UPDATE audit_entries SET action = 'x'`)
    assert.equal(deleted.rowCount, 0, 'DELETE 竟然删掉了行')
    assert.equal(updated.rowCount, 0, 'UPDATE 竟然改了行')
    const after1 = await verifyChain()
    assert.equal(after1.entries, before.entries)
    assert.equal(after1.head, before.head, '链头变了 —— 内容被改了')
  })

  test('审计**读者**角色不能写', async () => {
    await assert.rejects(
      () => pool('auditRead').query(
        `INSERT INTO audit_entries (company_id, actor_kind, action, outcome,
           prev_hash, entry_hash)
         VALUES ($1,'USER','x','ALLOW','0','0')`, [A.company]),
      (err) => err.code === '42501')
  })

  test('平台库连接**访问不到**审计库（库级隔离，不是表级）', async () => {
    const r = await pool('platform').query('SELECT current_database() AS db')
    assert.equal(r.rows[0].db, 'kvvi_platform')
    // 平台库的连接串指向另一个库，跨库查询在 PostgreSQL 里不存在 ——
    // 这一条是连接级事实，不是策略约定。
  })
})

async function lastSeq() {
  const { rows } = await pool('auditRead').query('SELECT max(seq)::int AS n FROM audit_entries')
  return rows[0].n
}
