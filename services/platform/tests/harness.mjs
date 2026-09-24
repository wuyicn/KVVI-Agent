/**
 * 阶段四测试的公共装置：建库、灌入两家公司的人与数据。
 *
 * ── 为什么两家公司都灌真实数据 ──────────────────────────────────────────
 *
 * 跨公司越权测试的常见失败方式是「B 公司根本没有数据」——
 * 那样每个查询都返回空，测试全绿，但什么也没证明。
 * 所以固定装置里两家公司都有结构相似、可互相识别的数据，
 * 且**记录 id 是固定常量**：负向测试要能指名道姓地去读「B 的那一条」。
 */
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { dsns, pool, closeAll } from '../src/db.mjs'
import { hashPassword } from '../src/identity.mjs'

const { Client } = pg
const HERE = dirname(fileURLToPath(import.meta.url))

export const A = {
  company: 'a0000000-0000-4000-8000-000000000001',
  dept: 'a0000000-0000-4000-8000-0000000000d1',
  subDept: 'a0000000-0000-4000-8000-0000000000d2',
  otherDept: 'a0000000-0000-4000-8000-0000000000d3',
  shop1: 'a0000000-0000-4000-8000-0000000000e1',
  shop2: 'a0000000-0000-4000-8000-0000000000e2',
  alice: 'a0000000-0000-4000-8000-0000000000a1',
  bob: 'a0000000-0000-4000-8000-0000000000a2',
  carol: 'a0000000-0000-4000-8000-0000000000a3',
}

export const B = {
  company: 'b0000000-0000-4000-8000-000000000001',
  dept: 'b0000000-0000-4000-8000-0000000000d1',
  shop1: 'b0000000-0000-4000-8000-0000000000e1',
  dave: 'b0000000-0000-4000-8000-0000000000b2',
}

/** 记录 id 固定，负向测试要能指名跨公司去读。 */
export const RECORDS = {
  aliceOwn: 'c0000000-0000-4000-8000-000000000001',
  bobOwn: 'c0000000-0000-4000-8000-000000000002',
  otherInSubDept: 'c0000000-0000-4000-8000-000000000003',
  store1Foreign: 'c0000000-0000-4000-8000-000000000004',
  companyB: 'c0000000-0000-4000-8000-0000000000b1',
}

export const PASSWORD = 'kvvi-test-password'

/** 重建三个库并灌入固定装置。**每次测试运行都重建**：残留数据会让负向测试失去意义。 */
export async function resetDatabase() {
  await closeAll()
  execFileSync('node', [resolve(HERE, '..', 'src', 'migrate.mjs')],
    { env: { ...process.env, KVVI_RESET: '1' }, stdio: 'pipe' })
  await seed()
}

async function adminClient(db) {
  const c = new Client({ connectionString: dsns().admin.replace(/\/[^/]*$/, `/${db}`) })
  await c.connect()
  return c
}

/** 灌入可识别的最小数据集。 */
export async function seed() {
  const passwordHash = hashPassword(PASSWORD)
  const platform = await adminClient('kvvi_platform')
  try {
    await platform.query(`INSERT INTO companies (company_id, name) VALUES ($1,$2),($3,$4)`,
      [A.company, 'A 公司', B.company, 'B 公司'])

    await platform.query(
      `INSERT INTO departments (dept_id, company_id, parent_dept_id, name)
       VALUES ($1,$2,NULL,'销售部'),($3,$2,$1,'销售一组'),($4,$2,NULL,'财务部'),
              ($5,$6,NULL,'B 销售部')`,
      [A.dept, A.company, A.subDept, A.otherDept, B.dept, B.company])

    await platform.query(
      `INSERT INTO shops (shop_id, company_id, name) VALUES ($1,$2,'门店一'),($3,$2,'门店二'),($4,$5,'B 门店')`,
      [A.shop1, A.company, A.shop2, B.shop1, B.company])

    await platform.query(
      `INSERT INTO users (user_id, login, password_hash, status, authz_version)
       VALUES ($1,'alice',$5,'ACTIVE',1),($2,'bob',$5,'ACTIVE',1),
              ($3,'carol',$5,'ACTIVE',1),($4,'dave',$5,'ACTIVE',1)`,
      [A.alice, A.bob, A.carol, B.dave, passwordHash])

    await platform.query(
      `INSERT INTO memberships (company_id, user_id, dept_id, shop_id)
       VALUES ($1,$2,$3,$4),($1,$5,$6,$7),($1,$8,$3,NULL),($9,$10,$11,$12)`,
      [A.company, A.alice, A.subDept, A.shop1,
       A.bob, A.otherDept, A.shop2,
       A.carol,
       B.company, B.dave, B.dept, B.shop1])

    // 角色与五档策略：**刻意的交叉**
    //   alice = SELF + 部门及下级      （店铺与部门可能交叉：她的两家店不在档位里）
    //   carol = STORE                  （只有店铺档位，与部门无关）
    //   bob   = COMPANY
    const roles = {
      alice: [A.company, 'role_alice', A.alice, ['SELF', 'DEPARTMENT_AND_CHILDREN']],
      carol: [A.company, 'role_carol', A.carol, ['STORE']],
      bob: [A.company, 'role_bob', A.bob, ['COMPANY']],
    }
    for (const [key, [company, code, user, scopes]] of Object.entries(roles)) {
      const roleId = randomUUID()
      await platform.query(
        `INSERT INTO roles (role_id, company_id, role_code, name) VALUES ($1,$2,$3,$4)`,
        [roleId, company, code, key])
      await platform.query(
        `INSERT INTO role_members (company_id, role_id, user_id) VALUES ($1,$2,$3)`,
        [company, roleId, user])
      await platform.query(
        `INSERT INTO policies (policy_id, company_id, role_id, dimension, resource_code,
           actions, data_scopes, field_visibility)
         VALUES ($1,$2,$3,'DATA','*','{}',$4,NULL)`,
        [randomUUID(), company, roleId, scopes])
    }
  } finally {
    await platform.end()
  }

  const business = await adminClient('kvvi_business')
  try {
    // 固定装置**绕过 RLS 直接灌数据**：它要造的是「库里已经有的数据」，
    // 而 RLS 管的是「谁读得到」。用超级用户灌，才不会让装置本身受策略影响。
    await business.query(`ALTER TABLE business_records DISABLE ROW LEVEL SECURITY`)
    try {
      await business.query(
        `INSERT INTO business_records (record_id, company_id, schema_code, dept_id,
           shop_id, owner_id, state, record_no, data)
         VALUES ($1,$2,'general_item',$3,$4,$5,'draft','GI2026000001','{"title":"alice 自己的单"}'),
                ($6,$2,'general_item',$7,$8,$9,'draft','GI2026000002','{"title":"bob 自己的单"}'),
                ($10,$2,'general_item',$3,$4,$11,'draft','GI2026000003','{"title":"同组别人的单"}'),
                ($12,$2,'general_item',$13,$14,$11,'draft','GI2026000004','{"title":"门店一别人的单"}'),
                ($15,$16,'general_item',$17,$18,$19,'draft','GI2026000005','{"title":"B 公司的单"}')`,
        [RECORDS.aliceOwn, A.company, A.subDept, A.shop1, A.alice,
         RECORDS.bobOwn, A.otherDept, A.shop2, A.bob,
         RECORDS.otherInSubDept, A.bob,
         RECORDS.store1Foreign, A.otherDept, A.shop1,
         RECORDS.companyB, B.company, B.dept, B.shop1, B.dave])
    } finally {
      await business.query(`ALTER TABLE business_records ENABLE ROW LEVEL SECURITY`)
    }
  } finally {
    await business.end()
  }
}

/** 直接建一个会话（跳过 HTTP），返回身份上下文。 */
export async function makeSession(userId, companyId, gateway = 'USER') {
  const { createSession, issueToken, verifyToken } = await import('../src/identity.mjs')
  const session = await createSession({ userId, companyId, gateway })
  const raw = await issueToken(session.sessionId)
  const ctx = await verifyToken(raw)
  return { session, raw, ctx }
}

export { pool, closeAll }
