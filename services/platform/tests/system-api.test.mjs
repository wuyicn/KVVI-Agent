/**
 * 阶段九 · 任务 3：把系统、视图、记录、流程暴露成 HTTP API（`/api/v1/*`）。
 *
 * ── 这一层是**适配器**，不是第二个授权点 ──────────────────────────────────
 *
 * 计划的硬性约束：「Do not duplicate authorization in `system-api.mjs`」。
 * 所以本文件测的不是「权限判定对不对」（那在 `permissions.test.mjs` 与
 * `authorization.mjs` 里），而是**三件只有从 HTTP 外部才验得到的事**：
 *
 * | # | 性质 | 不成立会怎样 |
 * |---|---|---|
 * | 1 | 只读员工改记录 → **403**，且记录**逐字段不变** | 「拒了但改了半行」比不拒更坏 |
 * | 2 | 陈旧 `rowVersion` → **409**，且**不覆盖**更新的记录 | 后到的请求覆盖先到的修改，是典型丢更新 |
 * | 3 | 404 与 403 语义不同 | 把「无权看」和「不存在」混成一个码，等于泄露了存在性 |
 *
 * ⚠️ 第 1 条的断言必须查**记录本身**，不能只查状态码：
 * 一个先写后拒的实现会返回 403，而数据已经变了。
 */
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { pool, closeAll } from '../src/db.mjs'
import { A, B, PASSWORD, resetDatabase, grantBaseline, grantPlatformRole,
         makeSession } from './harness.mjs'
import { submitDraft, approveDraft, publishDraft, DIFF_FACES } from '../src/publish.mjs'
import { handleApi } from '../src/api-router.mjs'
import { createRecord, readRecord } from '../src/refs.mjs'
import { scopeContext } from '../src/authorization.mjs'
import { runtimeProjection } from '../src/runtime-projection.mjs'

let owner = null
let builder = null
let editor = null
let readonlyUser = null
/** 会话表：`api()` 用它把令牌换成会话事实。临时建的会话也登记进来。 */
const KNOWN_SESSIONS = []

const CHANGE = { kind: 'permission-policy', roleCode: 'staff', addScopes: ['COMPANY'] }
const DIFF = { faces: DIFF_FACES, added: [{ dim: 'DATA', scope: 'COMPANY' }],
               removed: [], changed: [], counts: { added: 1, removed: 0, changed: 0 } }

const ASSET = 'leave_api'

/** 发一个最小可运行系统。字段只有 reason 一个，便于断言逐字段不变。 */
async function publishSystem() {
  const model = {
    schema_code: ASSET, name: '请假申请',
    fields: [{ field_code: 'reason', label: '事由', type: 'short_text', required: true }],
  }
  const view = {
    view_code: ASSET + '_form', name: '请假表单', view_type: 'FORM',
    businessSchemaRef: { asset_type: 'BUSINESS_SCHEMA', asset_id: ASSET },
    componentRegistryRef: { asset_type: 'COMPONENT_REGISTRY', asset_id: 'fixture' },
    componentsTree: [{ id: 'page_root', componentName: 'FormPage', children: [
      { id: 'f0', componentName: 'ShortTextField',
        props: { fieldBinding: { type: 'FieldRef', fieldRef: 'reason' } } }] }],
  }
  const workflow = {
    businessSchemaRef: { asset_type: 'BUSINESS_SCHEMA', asset_id: ASSET },
    states: [{ state_code: 'draft', name: '草稿', initial: true, terminal: false },
             { state_code: 'submitted', name: '待审批', initial: false, terminal: true }],
    actions: [{ action_code: 'submit', kind: 'SUBMIT', capability_ref: {} }],
    transitions: [{ transition_code: 'submit_flow', from_state: 'draft',
                    to_state: 'submitted', action_code: 'submit' }],
    approverRef: { kind: 'SINGLE', role_ref: {
      permission_ref: { asset_type: 'PERMISSION', asset_id: 'role_directory' },
      subresource: { type: 'ROLE', code: 'supervisor' } } },
  }
  const contracts = [
    { contractType: 'business-schema', assetId: ASSET, content: model },
    { contractType: 'view-schema', assetId: ASSET, content: view },
    { contractType: 'workflow-spec', assetId: ASSET, content: workflow },
    { contractType: 'permission-spec', assetId: ASSET, content: { roles: [], policies: [] } },
    { contractType: 'tool-spec', assetId: ASSET, content: { tools: [] } },
    { contractType: 'app-model-command', assetId: ASSET, content: { commands: [] } },
  ]
  const d = await submitDraft({ ctx: builder.ctx, change: { ...CHANGE, n: Math.random() },
                                diffReport: DIFF, invariant: { ok: true } })
  await approveDraft({ ctx: owner.ctx, draftId: d.draftId, decision: 'APPROVE' })
  await publishDraft({
    ctx: owner.ctx, draftId: d.draftId,
    apply: async ({ diffDigest }) => ({ diffDigest }),
    system: { assetId: ASSET, name: '请假申请', schemaCode: ASSET },
    contracts,
  })
}

/** 直接调路由器（不经 HTTP 服务器）—— 本组测的是适配与映射，不是传输。 */
async function api(method, path, session, body) {
  const out = await handleApi({
    method, path, query: '', body: body === undefined ? null : JSON.stringify(body),
    headers: session === null ? {} : { authorization: 'Bearer ' + session.raw },
    // ⚠️ 会话表**由调用方在参数里给**，不写死那四个预置会话。
    //    第一版写死了四个，于是「临时建一个别公司的会话」的用例拿到 401 ——
    //    那不是被测代码的问题，是**测试装置太窄**。
    loadSession: async (token) => {
      const hit = KNOWN_SESSIONS.find((s) => s.raw === token)
      return hit === undefined
        ? { status: 401, body: { error: 'KVVI_INVALID_TOKEN' } }
        : { status: 200, body: { userId: hit.ctx.userId, companyId: hit.ctx.companyId,
                                 gateway: hit.ctx.gateway, tools: ['data.readView'],
                                 state: 'ACTIVE' } }
    },
  })
  return out
}

/**
 * 给某账号在本系统上授 `FORM` 动作与 `COMPANY` 数据范围。
 *
 * ⚠️ `grantBaseline` 授的是 **`general_item`**，不是本测试的系统代号 ——
 * 所以补上动作授权之后，owner 会话对 `leave_api` 也没有 `update` 权限，
 * 两条本该通过的用例变红。**这不是代码错，是测试夹具没跟上**：
 * 授权判定的输入是「策略 × 资源码」，夹具必须给出对应的策略。
 * @param userId 账号
 * @param actions 要授的动作
 */
async function grantOnSystem(userId, actions) {
  const { randomUUID } = await import('node:crypto')
  const roleId = randomUUID()
  await pool('platform').query(
    `INSERT INTO roles (role_id, company_id, role_code, name) VALUES ($1,$2,$3,'sys')`,
    [roleId, A.company, `sys_${roleId.slice(0, 8)}`])
  await pool('platform').query(
    `INSERT INTO role_members (company_id, role_id, user_id) VALUES ($1,$2,$3)`,
    [A.company, roleId, userId])
  await pool('platform').query(
    `INSERT INTO policies (policy_id, company_id, role_id, dimension, resource_code,
       actions, data_scopes, field_visibility)
     VALUES ($1,$2,$3,'FORM',$4,$5,'{}',NULL)`,
    [randomUUID(), A.company, roleId, ASSET, actions])
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
  editor = await makeSession(A.alice, A.company)
  readonlyUser = await makeSession(A.bob, A.company)
  // 只读账号（bob）**刻意不授本系统的动作权限** —— 它就靠这个才是只读的。
  await grantOnSystem(A.alice, ['read', 'create', 'update', 'submit'])
  KNOWN_SESSIONS.push(owner, builder, editor, readonlyUser)
  await publishSystem()
})
after(closeAll)

describe('阶段九 · 系统与记录 API', () => {
  test('GET /api/v1/systems 列出本公司已发布系统', async () => {
    const r = await api('GET', '/api/v1/systems', editor)
    assert.equal(r.status, 200)
    assert.ok((r.body.items ?? []).some((x) => x.assetId === ASSET))
  })

  test('GET /api/v1/systems/:assetId/runtime 返回投影', async () => {
    const r = await api('GET', `/api/v1/systems/${ASSET}/runtime`, editor)
    assert.equal(r.status, 200)
    assert.equal(r.body.system.assetId, ASSET)
    assert.ok(r.body.views[ASSET], '投影里没有视图')
  })

  test('★ 别家公司的系统 → 404（不是 403，避免泄露存在性）', async () => {
    // ⚠️ 第一版用 `makeSession(A.alice, B.company)` 建「B 公司的会话」——
    // 那是错的：alice 不是 B 公司的成员，建会话本来就该失败（KVVI_NOT_A_MEMBER）。
    // **测试前提错了，不是代码错。** 正确的做法是让 B 公司有一个真实成员。
    await pool('platform').query(
      `INSERT INTO memberships (company_id, user_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`, [B.company, A.bob])
    const b = await makeSession(A.bob, B.company)
    KNOWN_SESSIONS.push(b)
    const r = await api('GET', `/api/v1/systems/${ASSET}/runtime`, b)
    assert.equal(r.status, 404, '跨公司读没有给出「不存在」')
    assert.equal(r.body?.system, undefined, '跨公司读返回了系统内容')
  })

  test('★ 只读员工的修改被拒（403），且记录**逐字段不变**', async () => {
    // 先由有权限的一方建一条记录。
    const scope = await scopeContext(owner.ctx)
    const created = await createRecord(owner.ctx, scope, {
      schemaCode: ASSET, data: { reason: '原始事由' },
    })
    const before = await readRecord(owner.ctx, scope,
      { companyId: A.company, schemaCode: ASSET, id: created.recordId })
    assert.ok(before !== null, '记录没建出来 —— 后面的断言无意义')

    // 没有 FIELD/DATA 策略的会话去改它。
    const r = await api('PATCH', `/api/v1/systems/${ASSET}/records/${created.recordId}`,
      readonlyUser, { rowVersion: before.rowVersion, data: { reason: '改过的' } })
    assert.equal(r.status, 403)

    // ★ 关键：查**记录本身**，不只看状态码。
    //   一个「先写后拒」的实现会返回 403，而数据已经变了。
    const after = await readRecord(owner.ctx, scope,
      { companyId: A.company, schemaCode: ASSET, id: created.recordId })
    assert.deepEqual(after.data, before.data, '被拒了但记录还是变了')
    assert.equal(after.rowVersion, before.rowVersion, '被拒了但版本号变了')
  })

  test('★ 陈旧 rowVersion → 409，且不覆盖更新的记录', async () => {
    const scope = await scopeContext(owner.ctx)
    const created = await createRecord(owner.ctx, scope, {
      schemaCode: ASSET, data: { reason: '第一次' },
    })
    const v1 = (await readRecord(owner.ctx, scope,
      { companyId: A.company, schemaCode: ASSET, id: created.recordId })).rowVersion

    // 先做一次合法更新，版本前进。
    const ok = await api('PATCH', `/api/v1/systems/${ASSET}/records/${created.recordId}`,
      owner, { rowVersion: v1, data: { reason: '更新过' } })
    assert.equal(ok.status, 200)

    // 再用**旧的** rowVersion 打一次 —— 必须拒绝，且不能覆盖上面那次。
    const stale = await api('PATCH', `/api/v1/systems/${ASSET}/records/${created.recordId}`,
      owner, { rowVersion: v1, data: { reason: '迟到的' } })
    assert.equal(stale.status, 409, '陈旧的 rowVersion 没有被判成冲突')

    const now = await readRecord(owner.ctx, scope,
      { companyId: A.company, schemaCode: ASSET, id: created.recordId })
    assert.equal(now.data.reason, '更新过', '迟到的写入覆盖了更新的记录')
  })

  test('★ 记录不存在 → 404，与「无权看」区分开', async () => {
    const r = await api('GET',
      `/api/v1/systems/${ASSET}/records/00000000-0000-4000-8000-000000000000`, owner)
    assert.equal(r.status, 404)
  })

  test('未鉴权 → 401（不返回任何记录）', async () => {
    const r = await api('GET', `/api/v1/systems/${ASSET}/runtime`, null)
    assert.equal(r.status, 401)
    assert.equal(r.body?.system, undefined)
  })

  test('未知路由 → 404 且带回显（便于调用方排错）', async () => {
    const r = await api('GET', '/api/v1/nosuchthing', owner)
    assert.equal(r.status, 404)
    assert.equal(r.body.error, 'KVVI_UNKNOWN_ROUTE')
    assert.equal(r.body.session.companyId, A.company)
  })
})
