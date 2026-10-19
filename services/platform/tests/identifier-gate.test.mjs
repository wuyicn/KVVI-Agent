/**
 * 缺陷 33 / 34：路径里的标识符 —— **非法 id 是 404，记录号能当 id 用**。
 *
 * ── 这一组测的是一条**推理前提**，不是状态码好不好看 ─────────────────────
 *
 * 在此之前，非 uuid 的路径段直接进 uuid 查询，PostgreSQL 抛 `22P02`，
 * 没人接住 → **500 `KVVI_INTERNAL_ERROR`**。模型收到的信号是「系统内部错误」，
 * 于是把它读成「这条记录对我不可读 / 我缺权限」，并据这个假前提写出三段
 * 「请你选一条路走」。
 *
 * 而真身是：建单返回的是**记录号**（`R-20261006-000003`），`record_get` /
 * `record_update` / `/actions` / `/transitions` 要的是 **uuid**。
 * 模型手上只有记录号，只能拿它去试。所以两件事一起修才有意义：
 * 非法值一律 404（不是 500），而**记录号由服务端解析成 id**。
 *
 * ── 判据（每条都能单独变红）──────────────────────────────────────────────
 *
 * | # | 判据 | 拆掉哪一处会变红 |
 * |---|---|---|
 * | ① | 非法 id → 404 `KVVI_RECORD_NOT_FOUND`，不是 500 | 拆掉 `api-router` 的闸 |
 * | ② | 记录号能解析到 id，读回同一条 | 拆掉解析（`lookupRecordId`） |
 * | ③ | 不存在的记录号 → 404 | 同上 |
 * | ④ | 别家公司**同号**的记录不会被读成本会话那条 | 解析里去掉 `company_id` 条件 |
 * | ⑤ | 别个系统的记录号 → 404 | 解析里去掉 `schema_code` 条件 |
 * | ⑥ | 命中多条 → 拒 | 解析里加 `LIMIT 1` 并取第一行 |
 * | ⑦ | 合法 uuid 照旧走通（闸不许误伤） | 闸里把非记录段的 uuid 也拒掉 |
 * | ⑧ | 拒绝进审计，且标成调用方的问题 | 去掉 `appendDenial` |
 *
 * ⑦ 与 ① 是一对：只测「非 uuid 被拒」的闸可以靠「全拒」通过，那是恒真的判据。
 * ④ 的夹具里别家公司有一条**号完全一样**的记录，也是同一个道理：若别家只有
 * 一个编出来的号，去掉公司条件照样 404 —— 那条判据就永远不会变红。
 */
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { pool, closeAll } from '../src/db.mjs'
import { A, B, resetDatabase, grantBaseline, grantPlatformRole, makeSession,
         adminQuery } from './harness.mjs'
import { submitDraft, approveDraft, publishDraft, DIFF_FACES } from '../src/publish.mjs'
import { handleApi } from '../src/api-router.mjs'
import { identifierSlots, IDENTIFIER } from '../src/request-refs.mjs'
import { peek, verifyChain } from '../src/audit.mjs'

const ASSET = 'gate_target'
const OTHER = 'gate_other'

const CHANGE = { kind: 'permission-policy', roleCode: 'staff', addScopes: ['COMPANY'] }
const DIFF = { faces: DIFF_FACES, added: [{ dim: 'DATA', scope: 'COMPANY' }],
               removed: [], changed: [], counts: { added: 1, removed: 0, changed: 0 } }

let owner = null
let builder = null
let employee = null
let target = null       // ASSET 里的一条记录 `{recordId, recordNo, rowVersion}`
let otherNo = null      // 另一个系统的记录号
let foreignNo = null    // 另一家公司的记录号
const KNOWN_SESSIONS = []

function model(assetId) {
  return {
    schema_code: assetId, name: '闸门夹具', description: '夹具',
    fields: [{ field_code: 'title', label: '标题', type: 'short_text', required: true, nullable: false }],
  }
}

function workflow(assetId) {
  return {
    businessSchemaRef: { asset_type: 'BUSINESS_SCHEMA', asset_id: assetId },
    states: [
      { state_code: 'draft', name: '草稿', initial: true, terminal: false },
      { state_code: 'submitted', name: '待审批', initial: false, terminal: true },
    ],
    actions: [{ action_code: 'submit', kind: 'SUBMIT', capability_ref: {} }],
    transitions: [{ transition_code: 'submit_flow', from_state: 'draft',
                    to_state: 'submitted', action_code: 'submit' }],
    approverRef: { kind: 'SINGLE', role_ref: {
      permission_ref: { asset_type: 'PERMISSION', asset_id: 'role_directory' },
      subresource: { type: 'ROLE', code: 'supervisor' } } },
  }
}

function contractsOf(assetId) {
  return [
    { contractType: 'business-schema', assetId, content: model(assetId) },
    { contractType: 'view-schema', assetId, content: { view_code: `${assetId}_form`, name: '表单',
      view_type: 'FORM',
      businessSchemaRef: { asset_type: 'BUSINESS_SCHEMA', asset_id: assetId },
      componentRegistryRef: { asset_type: 'COMPONENT_REGISTRY', asset_id: 'fixture' },
      componentsTree: [{ id: 'root', componentName: 'FormPage', children: [] }] } },
    { contractType: 'workflow-spec', assetId, content: workflow(assetId) },
    { contractType: 'permission-spec', assetId, content: { roles: [], policies: [] } },
    { contractType: 'tool-spec', assetId, content: { tools: [] } },
    { contractType: 'app-model-command', assetId, content: { commands: [] } },
  ]
}

async function publishSystem(assetId, name) {
  const d = await submitDraft({
    ctx: builder.ctx, change: { ...CHANGE, assetId, n: randomUUID() },
    diffReport: DIFF, invariant: { ok: true },
  })
  await approveDraft({ ctx: owner.ctx, draftId: d.draftId, decision: 'APPROVE' })
  await publishDraft({
    ctx: owner.ctx, draftId: d.draftId,
    apply: async ({ diffDigest }) => ({ diffDigest }),
    system: { assetId, name, schemaCode: assetId },
    contracts: contractsOf(assetId),
  })
}

/** 直接调路由器（不经 HTTP 服务器）—— 本组测的是闸，不是传输。 */
async function api(method, path, session, body) {
  return await handleApi({
    method, path, query: '', body: body === undefined ? null : JSON.stringify(body),
    headers: session === null ? {} : { authorization: 'Bearer ' + session.raw },
    loadSession: async (token) => {
      const hit = KNOWN_SESSIONS.find((s) => s.raw === token)
      return hit === undefined
        ? { status: 401, body: { error: 'KVVI_INVALID_TOKEN' } }
        : { status: 200, body: { userId: hit.ctx.userId, companyId: hit.ctx.companyId,
                                 gateway: hit.ctx.gateway, sessionId: hit.ctx.sessionId,
                                 tools: ['data.readView'], state: 'ACTIVE' } }
    },
  })
}

async function grantOnSystem(userId, actions) {
  const roleId = randomUUID()
  await pool('platform').query(
    `INSERT INTO roles (role_id, company_id, role_code, name) VALUES ($1,$2,$3,'闸门')`,
    [roleId, A.company, `gate_${roleId.slice(0, 8)}`])
  await pool('platform').query(
    'INSERT INTO role_members (company_id, role_id, user_id) VALUES ($1,$2,$3)',
    [A.company, roleId, userId])
  for (const dimension of ['FORM', 'FLOW']) {
    await pool('platform').query(
      `INSERT INTO policies (policy_id, company_id, role_id, dimension, resource_code,
         actions, data_scopes, field_visibility)
       VALUES ($1,$2,$3,$4,'*',$5,'{}',NULL)`,
      [randomUUID(), A.company, roleId, dimension,
       dimension === 'FORM' ? actions : ['SUBMIT']])
  }
  await pool('platform').query(
    `INSERT INTO policies (policy_id, company_id, role_id, dimension, resource_code,
       actions, data_scopes, field_visibility)
     VALUES ($1,$2,$3,'DATA','*','{}',$4,'VISIBLE')`,
    [randomUUID(), A.company, roleId, ['SELF', 'COMPANY']])
}

before(async () => {
  await resetDatabase()
  await grantBaseline(A.alice)
  await grantBaseline(A.bob)
  await grantPlatformRole(A.alice, 'owner')
  owner = await makeSession(A.alice, A.company)
  builder = await makeSession(A.bob, A.company)
  employee = await makeSession(A.alice, A.company)
  await grantOnSystem(A.alice, ['read', 'create', 'update'])
  KNOWN_SESSIONS.push(owner, builder, employee)

  await publishSystem(ASSET, '闸门目标系统')
  await publishSystem(OTHER, '闸门另一个系统')

  const created = await api('POST', `/api/v1/systems/${ASSET}/records`, employee,
    { data: { title: '目标记录' } })
  assert.equal(created.status, 201, '夹具没建出记录：' + JSON.stringify(created.body))
  target = created.body

  // 另一个系统里的一条记录 —— 它的记录号在**本系统**里必须解析不到。
  // ⚠️ 两个系统各自有独立的取号序列，第一条记录的号**可能相同**（都是 `…-000001`）。
  //    所以这里显式做第二条，让两个号确实不同 —— 否则测的是「同号」而不是「跨系统」。
  const other = await api('POST', `/api/v1/systems/${OTHER}/records`, employee,
    { data: { title: '别个系统的记录' } })
  assert.equal(other.status, 201)
  const otherSecond = await api('POST', `/api/v1/systems/${OTHER}/records`, employee,
    { data: { title: '别个系统的第二条' } })
  assert.equal(otherSecond.status, 201)
  otherNo = otherSecond.body.recordNo
  assert.notEqual(otherNo, target.recordNo, '两个系统的记录号撞了，这条判据就不成立')

  // 别家公司的一条记录。**直接 INSERT**：本组要验的不是「别家怎么建单」，
  // 而是「别家的记录号在本会话里解析不到」。用超级用户连接写 —— 业务库连接
  // 被 FORCE RLS 挡着，写不进另一家公司的行（`42501`）。
  //
  // ⚠️ 两条，各是 ④ 与 ⑤ 的**隔离夹具**：
  //   · 与本公司目标记录**同号**的那一条 —— 没有它，④ 只否证「别家的号不存在」，
  //     拆掉公司条件照样 404，判据永远不会变红。
  //   · 与另一个系统那条记录**同号**的那一条 —— ⑤ 同理，需要它才能在
  //     「拆掉系统条件」时变红（否则只会变成 404，看不出是系统条件在起作用）。
  for (const [label, no] of [['别家公司同号记录', target.recordNo],
                             ['别家公司别系统同号', otherNo]]) {
    await adminQuery('kvvi_business',
      `INSERT INTO business_records (record_id, company_id, schema_code, owner_id, state,
         record_no, data)
       VALUES (gen_random_uuid(), $1, $2, $3, 'draft', $4, jsonb_build_object('title', $5::text))`,
      [B.company, ASSET, randomUUID(), no, label])
  }
  const foreign = await adminQuery('kvvi_business',
    `INSERT INTO business_records (record_id, company_id, schema_code, owner_id, state,
       record_no, data)
     VALUES (gen_random_uuid(), $1, $2, $3, 'draft', 'R-19990101-000042', '{}'::jsonb)
     RETURNING record_no`, [B.company, ASSET, randomUUID()])
  foreignNo = foreign.rows[0].record_no
})
after(closeAll)

describe('缺陷 33 · 非 uuid 的路径段不许变成 500', () => {
  test('① 非法 id → 404 KVVI_RECORD_NOT_FOUND，且**不是** 500', async () => {
    for (const path of [
      `/api/v1/systems/${ASSET}/records/not-a-uuid`,
      `/api/v1/systems/${ASSET}/records/undefined`,
      `/api/v1/systems/${ASSET}/records/rec-R-20261006-000003/actions`,
      `/api/v1/publish/drafts/undefined`,
    ]) {
      const r = await api('GET', path, employee)
      assert.equal(r.status, 404, `${path} 回了 ${String(r.status)}：${JSON.stringify(r.body)}`)
      assert.equal(r.body.error, 'KVVI_RECORD_NOT_FOUND', path)
      assert.notEqual(r.body.error, 'KVVI_INTERNAL_ERROR', path)
    }
  })

  test('①b 同一条值的写路径（PATCH / POST transitions）也不是 500', async () => {
    const patched = await api('PATCH', `/api/v1/systems/${ASSET}/records/not-a-uuid`, employee,
      { data: { title: 'x' }, rowVersion: 1 })
    assert.equal(patched.status, 404)
    assert.equal(patched.body.error, 'KVVI_RECORD_NOT_FOUND')

    const moved = await api('POST', `/api/v1/systems/${ASSET}/records/not-a-uuid/transitions`,
      employee, { action: 'submit', rowVersion: 1 })
    assert.equal(moved.status, 404)
    assert.equal(moved.body.error, 'KVVI_RECORD_NOT_FOUND')
  })

  test('⑦ 合法 uuid 照旧走通 —— 闸没有误伤', async () => {
    const r = await api('GET', `/api/v1/systems/${ASSET}/records/${target.recordId}`, employee)
    assert.equal(r.status, 200)
    assert.equal(r.body.recordId, target.recordId)
    assert.equal(r.body.data.title, '目标记录')
  })

  test('未知路径仍是 KVVI_UNKNOWN_ROUTE（闸不改写既有的 404 语义）', async () => {
    const r = await api('GET', `/api/v1/systems/${ASSET}/nothing-here`, employee)
    assert.equal(r.status, 404)
    assert.equal(r.body.error, 'KVVI_UNKNOWN_ROUTE')
  })
})

describe('缺陷 34 · 记录号由服务端解析成记录 id', () => {
  test('② 拿记录号能读到同一条记录（模型手上只有的就是它）', async () => {
    assert.ok(/^R-\d{8}-\d+$/u.test(target.recordNo), '记录号形状变了：' + target.recordNo)
    const r = await api('GET', `/api/v1/systems/${ASSET}/records/${target.recordNo}`, employee)
    assert.equal(r.status, 200, JSON.stringify(r.body))
    // 解析的结果必须是**同一个** id，不是一个「碰巧也能读」的别的记录。
    assert.equal(r.body.recordId, target.recordId)
    assert.equal(r.body.recordNo, target.recordNo)
  })

  test('②b 记录号在 actions / transitions / PATCH 三条路径上都认', async () => {
    const actions = await api('GET',
      `/api/v1/systems/${ASSET}/records/${target.recordNo}/actions`, employee)
    assert.equal(actions.status, 200, JSON.stringify(actions.body))
    assert.equal(actions.body.recordId, target.recordId)

    const patched = await api('PATCH', `/api/v1/systems/${ASSET}/records/${target.recordNo}`,
      employee, { data: { title: '按记录号改的' }, rowVersion: target.rowVersion })
    assert.equal(patched.status, 200, JSON.stringify(patched.body))
    assert.equal(patched.body.recordId, target.recordId)
    // 写路径的乐观并发照旧：解析只换 id，不放宽版本判据。
    const stale = await api('PATCH', `/api/v1/systems/${ASSET}/records/${target.recordNo}`,
      employee, { data: { title: '再来一次' }, rowVersion: target.rowVersion })
    assert.equal(stale.status, 409)
    assert.equal(stale.body.error, 'KVVI_ROW_VERSION_CONFLICT')

    const moved = await api('POST',
      `/api/v1/systems/${ASSET}/records/${target.recordNo}/transitions`, employee,
      { action: 'submit', rowVersion: patched.body.rowVersion })
    assert.equal(moved.status, 200, JSON.stringify(moved.body))
    assert.equal(moved.body.recordId, target.recordId)
  })

  test('③ 不存在的记录号 → 404（是本系统内没这条，不是 500）', async () => {
    const r = await api('GET',
      `/api/v1/systems/${ASSET}/records/R-20261006-999999`, employee)
    assert.equal(r.status, 404)
    assert.equal(r.body.error, 'KVVI_RECORD_NOT_FOUND')
  })

  test('④ 跨公司**同号**的记录不会被当成这一条读回来', async () => {
    // ⚠️ 这一条判的是**读回来的是谁**，不是状态码。
    //
    // 「解析不跨公司」在本实现里有两道：SQL 的 `company_id` 条件，以及 RLS
    // （`applyScopeGucs` 之后 `company_id = A`）。只拆掉前者，别家那条会被解析出来、
    // 再被 `readRecord` 挡掉 —— 仍然是 404，症状不出现，判据看不见。
    //
    // 所以这里真的在别家公司放一条**号完全一样**的记录（夹具里那条带
    // `别家公司` 前缀的），并且断言读回来的是本公司这一条。
    // 解析一旦取错人，这里读到的就是别家那条记录的内容或干脆读不到。
    const r = await api('GET', `/api/v1/systems/${ASSET}/records/${target.recordNo}`, employee)
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.recordId, target.recordId, '解析命中了别家公司的同号记录')
    assert.notEqual(r.body.data.title, '别家公司同号记录')
  })

  test('④b 别家公司独有的记录号 → 404', async () => {
    const r = await api('GET', `/api/v1/systems/${ASSET}/records/${foreignNo}`, employee)
    assert.equal(r.status, 404, '别家公司的记录号被解析出来了：' + JSON.stringify(r.body))
    assert.equal(r.body.error, 'KVVI_RECORD_NOT_FOUND')
  })

  test('⑤ 别个系统的记录号 → 拒（解析不跨系统）', async () => {
    const r = await api('GET', `/api/v1/systems/${ASSET}/records/${otherNo}`, employee)
    assert.equal(r.status, 404, '跨系统的记录号被解析出来了：' + JSON.stringify(r.body))
    assert.equal(r.body.error, 'KVVI_RECORD_NOT_FOUND')
    // 对照：同一个号在**它自己那个系统**里读得到 —— 否则上一条可能只是因为号是假的。
    const own = await api('GET', `/api/v1/systems/${OTHER}/records/${otherNo}`, employee)
    assert.equal(own.status, 200, JSON.stringify(own.body))
  })

  test('⑥ 命中多条 → 拒，不是随便取一条', async () => {
    // 表上有 `UNIQUE (company_id, schema_code, record_no)`，所以真库造不出重复。
    // 判据仍在解析那一层：把唯一约束拆掉，让本会话的公司 + 本系统里留下**两条**
    // 同号记录，解析必须一条都不给 —— 取第一条就是「读到一条不相干的记录」。
    const dup = 'R-20261006-000777'
    await adminQuery('kvvi_business',
      'ALTER TABLE business_records DROP CONSTRAINT business_records_company_id_schema_code_record_no_key')
    try {
      for (const title of ['重复甲', '重复乙']) {
        await adminQuery('kvvi_business',
          `INSERT INTO business_records (record_id, company_id, schema_code, owner_id, state,
             record_no, data)
           VALUES (gen_random_uuid(), $1, $2, $3, 'draft', $4, jsonb_build_object('title', $5::text))`,
          [A.company, ASSET, A.alice, dup, title])
      }
      const r = await api('GET', `/api/v1/systems/${ASSET}/records/${dup}`, employee)
      assert.equal(r.status, 404, '同号两条被解析成了一条：' + JSON.stringify(r.body))
      assert.equal(r.body.error, 'KVVI_RECORD_NOT_FOUND')
    } finally {
      await adminQuery('kvvi_business',
        'DELETE FROM business_records WHERE record_no = $1', [dup])
      await adminQuery('kvvi_business',
        `ALTER TABLE business_records
           ADD CONSTRAINT business_records_company_id_schema_code_record_no_key
           UNIQUE (company_id, schema_code, record_no)`)
    }
  })

  test('⑥b 恢复唯一约束后，正常解析仍然成立（上面那条不是把表弄坏了）', async () => {
    const r = await api('GET', `/api/v1/systems/${ASSET}/records/${target.recordNo}`, employee)
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.recordId, target.recordId)
  })
})

describe('缺陷 33 · 拒绝进审计，且标明是调用方的问题', () => {
  test('⑧ 非法标识符留下 DENY 痕，`reason` 是记录不存在而不是内部错误', async () => {
    const before = (await verifyChain()).entries
    const r = await api('GET', '/api/v1/systems/' + ASSET + '/records/not-a-uuid-at-all', employee)
    assert.equal(r.status, 404)
    const after = await verifyChain()
    assert.equal(after.ok, true, '审计链被这次写入弄断了')
    assert.ok(after.entries > before, '这次拒绝没有留痕')

    // 从链尾往回找这一条。**整链校验也要过**：只查一行查得到，但链断了等于没留痕。
    let found = null
    for (let seq = after.entries; seq > 0 && found === null; seq -= 1) {
      const row = await peek(seq)
      if (row?.action === 'api.invalid-identifier') found = row
    }
    assert.ok(found !== null, '审计里找不到 api.invalid-identifier')
    assert.equal(found.outcome, 'DENY')
    assert.equal(found.reason, 'KVVI_RECORD_NOT_FOUND')
    assert.notEqual(found.reason, 'KVVI_INTERNAL_ERROR')
    assert.equal(found.company_id, A.company)
    assert.equal(found.actor_id, A.alice)
  })
})

describe('缺陷 33 · 闸覆盖的路径由一份清单决定', () => {
  test('产品 API 的标识符段逐条认得出来（含管理面）', () => {
    const slots = (p) => identifierSlots(p)
    assert.deepEqual(slots('/systems/s1/records/r1'),
      [{ index: 3, kind: IDENTIFIER.RECORD, assetId: 's1' }])
    assert.deepEqual(slots('/systems/s1/records/r1/write-receipt'),
      [{ index: 3, kind: IDENTIFIER.RECORD, assetId: 's1' }])
    assert.deepEqual(slots('/systems/s1/write-receipt'), [])
    assert.deepEqual(slots('/systems/s1/records/r1/actions'),
      [{ index: 3, kind: IDENTIFIER.RECORD, assetId: 's1' }])
    assert.deepEqual(slots('/systems/s1/records/r1/transitions'),
      [{ index: 3, kind: IDENTIFIER.RECORD, assetId: 's1' }])
    assert.deepEqual(slots('/publish/drafts/d1'),
      [{ index: 2, kind: IDENTIFIER.UUID, assetId: null }])
    assert.deepEqual(slots('/admin/members/u1/suspend'),
      [{ index: 2, kind: IDENTIFIER.UUID, assetId: null }])
    assert.deepEqual(slots('/admin/roles/r1/members/u1'),
      [{ index: 4, kind: IDENTIFIER.UUID, assetId: null }])
    // 没有标识符的路径一个都不认 —— 认多了会把业务代号当 id 去查。
    assert.deepEqual(slots('/systems'), [])
    assert.deepEqual(slots('/systems/s1/records'), [])
    assert.deepEqual(slots('/publish/drafts'), [])
    assert.deepEqual(slots('/systems/s1/fields'), [])
  })
})
