/**
 * 一个系统的**字段声明**：读得到、猜错时拒绝里带着答案、跨公司读不到。
 *
 * ── 这一组盯的是现场那次失败 ────────────────────────────────────────────
 *
 * 员工让 Agent 建一条客户记录，Agent 拿不到「这个系统有哪些字段」，
 * 于是猜了三轮编码（`name/phone/status`、`customer_name/...`、中文标签），
 * 每次都只拿到一句 `KVVI_FIELD_NOT_DECLARED`，最后**主动放弃**这次写入。
 *
 * 修的是两件事，各对应一条判据：
 *
 * | # | 判据 | 不成立会怎样 |
 * |---|---|---|
 * | 1 | `GET /systems/:id/fields` 给出已发布契约里的字段声明 | 模型只能猜，猜不到就不写 —— 这正是现场的结局 |
 * | 2 | 拒绝未声明字段时，`problems[].detail.declaredFields` 带上清单 | 一次猜错换不来下一轮改对，等于白错 |
 * | 3 | 跨公司读不到 | 字段名与枚举取值是**结构**，但那是别家公司的结构 |
 * | 4 | `HIDDEN` 的字段连名字都不出现 | 该角色看不见的字段名会从「拒绝的补充说明」里漏出去 |
 *
 * ⚠️ 夹具里的四个字段取自现场那个系统的真实契约，不是编的：Agent 当时猜对了
 *    `customer_name`、把电话猜成 `phone`（真名 `contact_phone`）、漏掉必填的
 *    `contact_name`。用例就该照着这次的错法写。
 */
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { pool, closeAll } from '../src/db.mjs'
import { A, B, resetDatabase, grantBaseline, grantPlatformRole,
         makeSession } from './harness.mjs'
import { submitDraft, approveDraft, publishDraft, DIFF_FACES } from '../src/publish.mjs'
import { handleApi } from '../src/api-router.mjs'

const ASSET = 'customer'
/** 现场真名：`contact_phone` —— 被猜成 `phone` 的就是它。 */
const PHONE = 'contact_phone'

/** A 公司那个系统的字段（取自现场契约）。 */
const A_FIELDS = [
  { field_code: 'customer_name', label: '客户名称', type: 'short_text',
    required: true, nullable: false, write_policy: 'MUTABLE' },
  { field_code: 'contact_name', label: '联系人', type: 'short_text',
    required: true, nullable: false, write_policy: 'MUTABLE' },
  { field_code: PHONE, label: '电话', type: 'short_text',
    required: false, nullable: true, write_policy: 'MUTABLE' },
  { field_code: 'follow_status', label: '跟进状态', type: 'single_select',
    required: true, nullable: false, write_policy: 'MUTABLE', type_config: { options: [
      { code: 'pending', label: '待跟进', order: 1, enabled: true },
      { code: 'done', label: '已跟进', order: 2, enabled: true },
      { code: 'retired', label: '已停用', order: 3, enabled: false },
    ] } },
]

/** B 公司**同名系统**，字段故意是 Agent 当时猜的那三个。 */
const B_FIELDS = [
  { field_code: 'name', label: '名称', type: 'short_text',
    required: true, nullable: false, write_policy: 'MUTABLE' },
  { field_code: 'phone', label: '电话', type: 'short_text',
    required: false, nullable: true, write_policy: 'MUTABLE' },
  { field_code: 'status', label: '状态', type: 'short_text',
    required: false, nullable: true, write_policy: 'MUTABLE' },
]

const CHANGE = { kind: 'permission-policy', roleCode: 'staff', addScopes: ['COMPANY'] }
const DIFF = { faces: DIFF_FACES, added: [{ dim: 'DATA', scope: 'COMPANY' }],
               removed: [], changed: [], counts: { added: 1, removed: 0, changed: 0 } }

let owner = null
let builder = null
let worker = null
let blind = null
let outsider = null
let ownerB = null
/** 会话表：`api()` 用它把令牌换成会话事实。 */
const KNOWN_SESSIONS = []

/** 发一个只带 `business-schema` 即可满足本组的系统（本端点只读那一份契约）。 */
async function publishSystem(proposerCtx, approverCtx, assetId, fields, name) {
  const model = { schema_code: assetId, name, fields }
  const d = await submitDraft({ ctx: proposerCtx, change: { ...CHANGE, assetId, n: Math.random() },
                                diffReport: DIFF, invariant: { ok: true } })
  const approved = await approveDraft({ ctx: approverCtx, draftId: d.draftId, decision: 'APPROVE' })
  assert.equal(approved.ok !== false, true, `审批没通过：${JSON.stringify(approved)}`)
  await publishDraft({
    ctx: approverCtx, draftId: d.draftId,
    apply: async ({ diffDigest }) => ({ diffDigest }),
    system: { assetId, name, schemaCode: assetId },
    contracts: [{ contractType: 'business-schema', assetId, content: model }],
  })
}

/** 直接调路由器（不经 HTTP 服务器）—— 本组测的是适配与映射，不是传输。 */
async function api(method, path, session, body) {
  return await handleApi({
    method, path, query: '', body: body === undefined ? null : JSON.stringify(body),
    headers: session === null ? {} : { authorization: 'Bearer ' + session.raw },
    loadSession: async (token) => {
      const hit = KNOWN_SESSIONS.find((s) => s.raw === token)
      return hit === undefined
        ? { status: 401, body: { error: 'KVVI_INVALID_TOKEN' } }
        : { status: 200, body: { userId: hit.ctx.userId, companyId: hit.ctx.companyId,
                                 gateway: hit.ctx.gateway, tools: ['data.readView'],
                                 state: 'ACTIVE' } }
    },
  })
}

/**
 * 授「本系统的 FORM 动作 + 数据范围 + 字段可见性」。
 * @param userId 账号
 * @param companyId 公司
 * @param actions 本系统的 FORM 动作
 * @param hidden 对该角色**隐藏**的字段（其余字段可见）
 * @param assetCode 动作落在哪个业务对象上
 */
async function grantOnSystem(userId, companyId, actions, hidden = [], assetCode = ASSET) {
  const { randomUUID } = await import('node:crypto')
  const roleId = randomUUID()
  await pool('platform').query(
    `INSERT INTO roles (role_id, company_id, role_code, name) VALUES ($1,$2,$3,'fields')`,
    [roleId, companyId, `fields_${roleId.slice(0, 8)}`])
  await pool('platform').query(
    `INSERT INTO role_members (company_id, role_id, user_id) VALUES ($1,$2,$3)`,
    [companyId, roleId, userId])
  const rows = [
    ['FORM', assetCode, actions, [], null],
    ['DATA', '*', [], ['SELF', 'COMPANY'], null],
    ['FIELD', '*', [], [], 'VISIBLE'],
    ...hidden.map((field) => ['FIELD', field, [], [], 'HIDDEN']),
  ]
  for (const [dimension, code, acts, scopes, visibility] of rows) {
    await pool('platform').query(
      `INSERT INTO policies (policy_id, company_id, role_id, dimension, resource_code,
         actions, data_scopes, field_visibility)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [randomUUID(), companyId, roleId, dimension, code, acts, scopes, visibility])
  }
}

before(async () => {
  await resetDatabase()
  await grantBaseline(A.alice)
  await grantBaseline(A.bob)
  await grantPlatformRole(A.alice, 'owner')
  owner = await makeSession(A.alice, A.company)
  builder = await makeSession(A.bob, A.company)
  worker = await makeSession(A.alice, A.company)
  blind = await makeSession(A.carol, A.company)
  // 只拿基线授权（落在 `general_item` 上）：对 `customer` 一个动作都没有。
  outsider = await makeSession(A.bob, A.company)
  KNOWN_SESSIONS.push(owner, builder, worker, blind, outsider)

  await grantOnSystem(A.alice, A.company, ['read', 'create', 'update'])
  // carol 看不见电话这一列 —— 记录读取里它不会出现，字段清单里也不该出现。
  await grantOnSystem(A.carol, A.company, ['read', 'create'], [PHONE])
  // ⚠️ 「未发布的系统 → 404」要走到那一分支，得**先过授权那一关**：
  //    `canAct` 先判、系统在不在后判，否则任何未知代号都被 403 挡住，
  //    而那条 403 看起来像「没权限」，不像「没有这份契约」。
  await grantOnSystem(A.carol, A.company, ['read'], [], '*')

  await publishSystem(builder.ctx, owner.ctx, ASSET, A_FIELDS, '客户')

  // B 公司：**同名系统**，字段是 Agent 当时猜的那三个。跨公司那条判据要有
  // 一份「看起来像答案、其实不是这一家的」真实数据，否则它什么都不证明。
  await pool('platform').query(
    `INSERT INTO memberships (company_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [B.company, A.bob])
  await grantPlatformRole(A.bob, 'owner', B.company)
  await grantPlatformRole(B.dave, 'owner', B.company)
  ownerB = await makeSession(B.dave, B.company)
  const builderB = await makeSession(A.bob, B.company)
  KNOWN_SESSIONS.push(ownerB, builderB)
  await grantOnSystem(B.dave, B.company, ['read', 'create'])
  await publishSystem(builderB.ctx, ownerB.ctx, ASSET, B_FIELDS, '客户（乙）')
})

after(closeAll)

describe('系统字段声明：读得到', () => {
  test('★ 返回契约里那几个真实编码（`contact_phone` 在里面）', async () => {
    const r = await api('GET', `/api/v1/systems/${ASSET}/fields`, worker)
    assert.equal(r.status, 200)
    const codes = r.body.fields.map((f) => f.field_code)
    assert.deepEqual(codes, ['customer_name', 'contact_name', PHONE, 'follow_status'])
    // 现场把电话猜成 `phone`；真名是 `contact_phone`。清单里必须有它，
    // 否则这次修的就不是那件事。
    assert.ok(codes.includes(PHONE), '真名不在清单里')
    assert.ok(!codes.includes('phone'), '混进了猜的那个编码')
  })

  test('每个字段带上必填、类型、写入策略与枚举取值', async () => {
    const r = await api('GET', `/api/v1/systems/${ASSET}/fields`, worker)
    const byCode = Object.fromEntries(r.body.fields.map((f) => [f.field_code, f]))
    assert.equal(byCode.customer_name.required, true)
    assert.equal(byCode[PHONE].required, false)
    assert.equal(byCode.contact_name.label, '联系人')
    assert.equal(byCode.follow_status.type, 'single_select')
    assert.equal(byCode.customer_name.write_policy, 'MUTABLE')
    assert.deepEqual(byCode.follow_status.options.map((o) => o.code), ['pending', 'done'],
      '停用的选项不是可取值，不该列出来')
    assert.equal(byCode.customer_name.options, undefined, '非枚举字段不该有选项')
    assert.equal(r.body.hiddenFieldCount, 0)
  })

  test('未发布的系统 → 404，不是「没有字段」', async () => {
    const r = await api('GET', '/api/v1/systems/nosuchsystem/fields', blind)
    assert.equal(r.status, 404)
    assert.equal(r.body.fields, undefined)
  })

  test('没有该系统 read 动作 → 403', async () => {
    const r = await api('GET', `/api/v1/systems/${ASSET}/fields`, outsider)
    assert.equal(r.status, 403)
    assert.equal(r.body.fields, undefined)
  })
})

describe('系统字段声明：看不见的字段连名字都不出现', () => {
  test('★ `HIDDEN` 的字段不在清单里，但**数量**报出来', async () => {
    const r = await api('GET', `/api/v1/systems/${ASSET}/fields`, blind)
    assert.equal(r.status, 200)
    const codes = r.body.fields.map((f) => f.field_code)
    assert.ok(!codes.includes(PHONE), '看不见的字段名漏出去了')
    assert.deepEqual(codes, ['customer_name', 'contact_name', 'follow_status'])
    // 「这个角色没有字段权限」与「这个系统没有字段」必须分得开。
    assert.equal(r.body.hiddenFieldCount, 1)
  })

  test('★ 拒绝里的补充清单同样按可见性过滤', async () => {
    // 这条是「漏名字」的第二条出口：写错一个字段名时，
    // detail 会带着整份清单回到调用方。
    const r = await api('POST', `/api/v1/systems/${ASSET}/records`,
      blind, { data: { customer_name: '星河科技', phone: '13800000000' } })
    assert.equal(r.status, 400)
    const declared = r.body.problems.find((p) => p.field === 'phone').detail.declaredFields
    assert.ok(!declared.includes(PHONE), '拒绝的补充说明里漏出了该角色看不见的字段名')
    assert.deepEqual(declared, ['customer_name', 'contact_name', 'follow_status'])
  })
})

describe('系统字段声明：拒绝带上答案', () => {
  test('★ 写未声明字段 → 400，且已声明清单随拒绝一起回来', async () => {
    const r = await api('POST', `/api/v1/systems/${ASSET}/records`,
      worker, { data: { customer_name: '星河科技', phone: '13800000000' } })
    assert.equal(r.status, 400)
    assert.equal(r.body.error, 'KVVI_FIELD_NOT_DECLARED')
    const problem = r.body.problems.find((p) => p.field === 'phone')
    assert.ok(problem !== undefined, '没有针对 `phone` 的违规项')
    // 这一条就是这次修的东西：**猜错一次就能在下一轮改对**。
    assert.deepEqual(problem.detail.declaredFields,
      ['customer_name', 'contact_name', PHONE, 'follow_status'])
    // 漏掉的必填也逐条报出来（现场那次连 `contact_name` 都没意识到）。
    const missing = r.body.problems.filter((p) => p.reason === 'KVVI_FIELD_REQUIRED')
      .map((p) => p.field).sort()
    assert.deepEqual(missing, ['contact_name', 'follow_status'])
  })

  test('照着清单写就建得成（清单与写入判据是同一份契约）', async () => {
    const r = await api('POST', `/api/v1/systems/${ASSET}/records`, worker, { data: {
      customer_name: '星河科技', contact_name: '李四', [PHONE]: '13800000000',
      follow_status: 'pending',
    } })
    assert.equal(r.status, 201)
    assert.ok(r.body.recordNo)
  })
})

describe('系统字段声明：跨公司读不到', () => {
  test('★ B 公司有同名系统，A 的会话看不见它的字段', async () => {
    const r = await api('GET', `/api/v1/systems/${ASSET}/fields`, worker)
    assert.equal(r.status, 200)
    const codes = r.body.fields.map((f) => f.field_code)
    for (const guessed of B_FIELDS.map((f) => f.field_code)) {
      assert.ok(!codes.includes(guessed), `读到了 B 公司的字段 ${guessed}`)
    }
  })

  test('★ B 公司的会话读到的是 B 自己的那一份', async () => {
    const r = await api('GET', `/api/v1/systems/${ASSET}/fields`, ownerB)
    assert.equal(r.status, 200)
    assert.deepEqual(r.body.fields.map((f) => f.field_code), ['name', 'phone', 'status'])
    assert.ok(!r.body.fields.some((f) => f.field_code === PHONE))
  })
})
