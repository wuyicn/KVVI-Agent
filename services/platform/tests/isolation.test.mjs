/**
 * 阶段四锚点② 与 ④：跨公司越权与数据范围（§9.9.x、0B-3、0B-6）。
 *
 * ⚠️ 本文件里的每一条都必须是**能红的**。同公司内看到自己该看的、看不到
 * 自己不该看的，两个方向都有用例 —— 只测「看不到」的集合永远是绿的。
 */
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { pool, closeAll } from '../src/db.mjs'
import { A, B, RECORDS, resetDatabase, makeSession } from './harness.mjs'
import { scopeContext, applyScopeGucs } from '../src/authorization.mjs'
import { readRecord, listRecords, updateRecord, buildHandle, KvviRefError } from '../src/refs.mjs'
import { endSession, bumpAuthzVersion, suspendAccount, verifyToken } from '../src/identity.mjs'

before(resetDatabase)
after(closeAll)

describe('锚点② 跨公司越权（§9.9.x 全部负向项）', () => {
  test('§9.9.1/§9.9.3 会话内绑定的公司决定可见范围：读不到 B 的记录', async () => {
    const { ctx } = await makeSession(A.alice, A.company)
    const scope = await scopeContext(ctx)
    const hit = await readRecord(ctx, scope, { kind: 'record', id: RECORDS.companyB })
    assert.equal(hit, null, 'A 公司的会话读到了 B 公司的记录')
  })

  test('§9.9.1 同一账号在两家公司的会话各自只看得到自己那家（并发会话）', async () => {
    // 同一个 user_id 在两个公司各开一个会话 —— §9.9.5 要求的并发场景。
    // 为此把 alice 也加进 B 公司（成员关系是账号级的，公司绑定是会话级的）。
    await pool('platform').query(
      `INSERT INTO memberships (company_id, user_id, dept_id, shop_id)
       VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [B.company, A.alice, B.dept, B.shop1])

    // ⚠️ 在 B 公司也要给她一个策略。不然 B 的会话看不到任何东西，
    //   测出来的就是「没有授权」，而不是「会话把租户隔开了」——
    //   两者都会让断言变绿，但只有后者是 §9.9 要求的性质。
    const roleId = 'b0000000-0000-4000-8000-0000000000c1'
    await pool('platform').query(
      `INSERT INTO roles (role_id, company_id, role_code, name)
       VALUES ($1,$2,'role_alice_b','alice@B') ON CONFLICT DO NOTHING`,
      [roleId, B.company])
    await pool('platform').query(
      `INSERT INTO role_members (company_id, role_id, user_id)
       VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [B.company, roleId, A.alice])
    await pool('platform').query(
      `INSERT INTO policies (policy_id, company_id, role_id, dimension, resource_code,
         actions, data_scopes, field_visibility)
       VALUES (gen_random_uuid(),$1,$2,'DATA','*','{}',ARRAY['COMPANY'],NULL)
       ON CONFLICT DO NOTHING`, [B.company, roleId])

    const inA = await makeSession(A.alice, A.company)
    const inB = await makeSession(A.alice, B.company)
    const scopeA = await scopeContext(inA.ctx)
    const scopeB = await scopeContext(inB.ctx)

    assert.equal(scopeA.companyId, A.company)
    assert.equal(scopeB.companyId, B.company)

    // 各自的可见集合**互不包含对方的记录**
    const aSees = await listRecords(scopeA, 'general_item', { limit: 200 })
    const bSees = await listRecords(scopeB, 'general_item', { limit: 200 })
    assert.ok(aSees.every((r) => r.companyId === A.company), 'A 的会话读到别家记录')
    assert.ok(bSees.every((r) => r.companyId === B.company), 'B 的会话读到别家记录')
    assert.ok(bSees.some((r) => r.recordId === RECORDS.companyB), 'B 的会话看不到自家的记录')
    assert.ok(!aSees.some((r) => r.recordId === RECORDS.companyB), 'A 的会话看到了 B 的记录')
  })

  test('§9.9.2 引用自带租户且与令牌不符 → 在执行点之前拒绝', async () => {
    const { ctx } = await makeSession(A.alice, A.company)
    assert.throws(
      () => buildHandle(ctx, { kind: 'record', id: RECORDS.companyB, companyId: B.company }),
      (err) => err instanceof KvviRefError && err.code === 'KVVI_CROSS_TENANT_REF',
      '模型传入的租户与令牌不符时必须直接拒，而不是去查权限')
  })

  test('§9.9.2 拒绝理由不透露对方信息（不区分「是否有权」）', async () => {
    const { ctx } = await makeSession(A.alice, A.company)
    try {
      buildHandle(ctx, { kind: 'record', id: RECORDS.companyB, companyId: B.company })
      assert.fail('应当抛出')
    } catch (error) {
      assert.equal(error.detail, '', '拒绝理由里带了对方的任何信息')
      assert.ok(!String(error.message).includes(B.company), '错误信息泄漏了对方租户 id')
    }
  })

  test('§9.9.1 旧令牌在登出后立即失效（重放被拒）', async () => {
    const { session, raw } = await makeSession(A.alice, A.company)
    assert.ok(await verifyToken(raw), '登出前令牌应当有效')
    await endSession(session.sessionId, 'LOGOUT')
    assert.equal(await verifyToken(raw), null, '登出后旧令牌仍然有效 —— §9.4.2 落空')
  })

  test('§9.9.1 授权版本变化使旧令牌失效（权限回收不靠清缓存）', async () => {
    const { raw } = await makeSession(A.carol, A.company)
    assert.ok(await verifyToken(raw))
    await bumpAuthzVersion(A.carol)
    assert.equal(await verifyToken(raw), null, '授权版本变了，旧令牌仍然有效')
  })

  test('§9.9.1 账号停用后全部活动会话一并结束', async () => {
    const { session, raw } = await makeSession(A.carol, A.company)
    const n = await suspendAccount(A.carol)
    assert.ok(n >= 1, '停用账号没有结束任何会话')
    assert.equal(await verifyToken(raw), null)
    const { rows } = await pool('platform').query(
      `SELECT kind FROM session_events WHERE session_id = $1 ORDER BY event_id`,
      [session.sessionId])
    assert.deepEqual(rows.map((r) => r.kind), ['LOGIN', 'ACCOUNT_SUSPENDED'])
    await pool('platform').query(`UPDATE users SET status='ACTIVE' WHERE user_id=$1`, [A.carol])
  })
})

describe('锚点② 的第二层：RLS 独立于应用代码', () => {
  test('绕过应用层直接查（只设 GUC）仍然读不到别家', async () => {
    // 这条是**独立观测**：它不使用 refs.mjs 或 authorization.mjs 的任何判定，
    // 只把 GUC 设成 alice 的上下文，然后自己发 SQL。
    const client = await pool('business').connect()
    try {
      await client.query('BEGIN')
      await applyScopeGucs(client, {
        companyId: A.company, userId: A.alice, deptId: A.subDept,
        deptSubtree: [A.dept, A.subDept], shopId: A.shop1, scopes: ['COMPANY'],
      })
      const all = await client.query(
        'SELECT company_id FROM business_records')
      await client.query('COMMIT')
      assert.ok(all.rows.length > 0, '没读到任何数据，这条检查是空转的')
      assert.ok(all.rows.every((r) => r.company_id === A.company),
        'RLS 没拦住跨公司行')
      await client.query('BEGIN')
      await applyScopeGucs(client, {
        companyId: B.company, userId: B.dave, deptId: B.dept,
        deptSubtree: [B.dept], shopId: B.shop1, scopes: ['COMPANY'],
      })
      const bRows = await client.query('SELECT company_id FROM business_records')
      await client.query('COMMIT')
      assert.ok(bRows.rows.every((r) => r.company_id === B.company))
    } finally {
      client.release()
    }
  })

  test('★ 这条检查本身是有载荷的：关掉 RLS 就必须读到别家数据', async () => {
    // 「读不到」有两种原因：策略真的生效了，或者数据根本不在那儿。
    // 只测前者会把后者也判成通过。本用例把策略临时关掉 ——
    // 如果这时仍然读不到，说明上面那些负向测试是空转的。
    const { Client } = await import('pg')
    const { dsns } = await import('../src/db.mjs')
    const admin = new Client({
      connectionString: dsns().admin.replace(/\/[^/]*$/, '/kvvi_business') })
    await admin.connect()
    try {
      await admin.query('ALTER TABLE business_records DISABLE ROW LEVEL SECURITY')
      const client = await pool('business').connect()
      try {
        await client.query('BEGIN')
        await applyScopeGucs(client, {
          companyId: A.company, userId: A.alice, deptId: A.subDept,
          deptSubtree: [A.dept, A.subDept], shopId: A.shop1, scopes: ['COMPANY'],
        })
        const { rows } = await client.query('SELECT company_id FROM business_records')
        await client.query('COMMIT')
        assert.ok(rows.some((r) => r.company_id === B.company),
          '关掉 RLS 也读不到 B 的数据 —— 上面的跨公司测试是空转的')
      } finally {
        client.release()
      }
    } finally {
      await admin.query('ALTER TABLE business_records ENABLE ROW LEVEL SECURITY')
      await admin.end()
    }
  })

  test('未设置任何上下文 → 一行都读不到（fail-closed）', async () => {
    const client = await pool('business').connect()
    try {
      const { rows } = await client.query('SELECT count(*)::int AS n FROM business_records')
      assert.equal(rows[0].n, 0, '没设上下文却读到了数据 —— 这是 fail-open')
    } finally {
      client.release()
    }
  })

  test('档位数组为空 → 一行都读不到', async () => {
    const client = await pool('business').connect()
    try {
      await client.query('BEGIN')
      await applyScopeGucs(client, {
        companyId: A.company, userId: A.bob, deptId: A.otherDept,
        deptSubtree: [A.otherDept], shopId: A.shop2, scopes: [],
      })
      const { rows } = await client.query('SELECT count(*)::int AS n FROM business_records')
      await client.query('COMMIT')
      assert.equal(rows[0].n, 0, '档位为空却读到了数据')
    } finally {
      client.release()
    }
  })
})

describe('锚点②/0B-6 五档数据范围（按实际可访问集合，不按编号）', () => {
  test('SELF：只看得到自己名下的记录', async () => {
    const client = await pool('business').connect()
    try {
      await client.query('BEGIN')
      await applyScopeGucs(client, {
        companyId: A.company, userId: A.alice, deptId: A.subDept,
        deptSubtree: [A.dept, A.subDept], shopId: A.shop1, scopes: ['SELF'],
      })
      const { rows } = await client.query('SELECT record_id, owner_id FROM business_records')
      await client.query('COMMIT')
      assert.deepEqual(rows.map((r) => r.record_id), [RECORDS.aliceOwn])
    } finally {
      client.release()
    }
  })

  test('DEPARTMENT_AND_CHILDREN：看得到子树，看不到子树外的部门', async () => {
    const client = await pool('business').connect()
    try {
      await client.query('BEGIN')
      await applyScopeGucs(client, {
        companyId: A.company, userId: A.alice, deptId: A.subDept,
        deptSubtree: [A.dept, A.subDept], shopId: A.shop1,
        scopes: ['DEPARTMENT_AND_CHILDREN'],
      })
      const { rows } = await client.query('SELECT record_id FROM business_records ORDER BY record_no')
      await client.query('COMMIT')
      const ids = rows.map((r) => r.record_id)
      assert.ok(ids.includes(RECORDS.otherInSubDept), '子树内的记录没读到')
      assert.ok(!ids.includes(RECORDS.bobOwn), '子树外（财务部）的记录读到了')
      // 门店一那条属于「财务部」，部门档位覆盖不到 → 必须读不到
      assert.ok(!ids.includes(RECORDS.store1Foreign),
        '部门档位读到了部门对不上的记录 —— 档位被当成了编号比较')
    } finally {
      client.release()
    }
  })

  test('STORE：只按店铺匹配，不因部门相同而放行', async () => {
    const client = await pool('business').connect()
    try {
      await client.query('BEGIN')
      await applyScopeGucs(client, {
        companyId: A.company, userId: A.carol, deptId: A.dept,
        deptSubtree: [A.dept, A.subDept], shopId: A.shop1, scopes: ['STORE'],
      })
      const { rows } = await client.query('SELECT record_id FROM business_records')
      await client.query('COMMIT')
      const ids = rows.map((r) => r.record_id)
      assert.ok(ids.includes(RECORDS.store1Foreign), '门店一（他人名下）的记录没读到')
      // aliceOwn 也在门店一 —— 店铺档位与「是不是自己的」无关，应当读到。
      // 这条同时证伪了「STORE 被实现成 SELF」这种退化。
      assert.ok(ids.includes(RECORDS.aliceOwn), 'STORE 档位把自己的记录漏掉了')
      assert.ok(!ids.includes(RECORDS.bobOwn), '门店二的记录被读到了')
    } finally {
      client.release()
    }
  })

  test('并集语义：SELF + STORE 是两档的合并，不是更强的那一档', async () => {
    const client = await pool('business').connect()
    try {
      await client.query('BEGIN')
      await applyScopeGucs(client, {
        companyId: A.company, userId: A.alice, deptId: A.subDept,
        deptSubtree: [A.dept, A.subDept], shopId: A.shop1, scopes: ['SELF', 'STORE'],
      })
      const { rows } = await client.query('SELECT record_id FROM business_records')
      await client.query('COMMIT')
      const ids = new Set(rows.map((r) => r.record_id))
      assert.ok(ids.has(RECORDS.aliceOwn), 'SELF 那一档的并集部分丢了')
      assert.ok(ids.has(RECORDS.store1Foreign), 'STORE 那一档的并集部分丢了')
      assert.ok(!ids.has(RECORDS.bobOwn))
    } finally {
      client.release()
    }
  })

  test('COMPANY 仍受租户约束：它是「本公司的全部」，不是「全部」', async () => {
    const client = await pool('business').connect()
    try {
      await client.query('BEGIN')
      await applyScopeGucs(client, {
        companyId: A.company, userId: A.bob, deptId: A.otherDept,
        deptSubtree: [A.otherDept], shopId: A.shop2, scopes: ['COMPANY'],
      })
      const { rows } = await client.query('SELECT company_id FROM business_records')
      await client.query('COMMIT')
      assert.equal(rows.length, 4, '公司档位应看到本公司 4 条')
      assert.ok(rows.every((r) => r.company_id === A.company), 'COMPANY 档位越过了租户')
    } finally {
      client.release()
    }
  })
})

describe('锚点② 写路径：越权写影响 0 行，而不是报错成功', () => {
  test('跨公司更新返回 null（既没改到，也不假装成功）', async () => {
    const { ctx } = await makeSession(A.bob, A.company)
    const scope = await scopeContext(ctx)
    const result = await updateRecord(ctx, scope,
      { kind: 'record', id: RECORDS.companyB }, { data: { title: '被改了' } })
    assert.equal(result, null)
    // 用**业务库的超级用户连接**回查：pool('admin') 连的是 postgres 库，
    // 那里没有业务表。回查必须绕过 RLS，否则「没改到」与「读不到」分不清。
    const { Client } = await import('pg')
    const { dsns } = await import('../src/db.mjs')
    const adminDb = new Client({
      connectionString: dsns().admin.replace(/\/[^/]*$/, '/kvvi_business') })
    await adminDb.connect()
    const check = await adminDb.query(
      'SELECT data FROM business_records WHERE record_id = $1', [RECORDS.companyB])
    await adminDb.end()
    assert.notEqual(check.rows[0].data.title, '被改了', '跨公司写入竟然生效了')
  })

  test('带旧 row_version 的更新影响 0 行（并发不静默覆盖）', async () => {
    const { ctx } = await makeSession(A.alice, A.company)
    const scope = await scopeContext(ctx)
    const first = await updateRecord(ctx, scope,
      { kind: 'record', id: RECORDS.aliceOwn }, { data: { a: 1 }, rowVersion: 1 })
    assert.ok(first)
    const stale = await updateRecord(ctx, scope,
      { kind: 'record', id: RECORDS.aliceOwn },
      { data: { b: 2 }, rowVersion: 1 })
    assert.equal(stale, null, '旧版本号的更新竟然成功了')
  })
})
