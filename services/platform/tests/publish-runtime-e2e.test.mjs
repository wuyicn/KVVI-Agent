/**
 * 阶段九 · 任务 5：**G7 端到端** —— 一个新系统从契约走到员工的第一条真实记录。
 *
 * ── 这一条与任务 3 的 API 测试有什么不同 ──────────────────────────────────
 *
 * `system-api.test.mjs` 测的是**适配器**（状态码映射、身份剥离、逐字段不变）。
 * 本文件测的是**门禁判据本身**：
 *
 *   「一个新系统可从自然语言需求走到发布，并由员工打开和提交第一条真实记录」
 *
 * 所以这里刻意**重新建一个系统**（不是复用夹具），并把两端都走一遍：
 *
 *   ① 契约不全 → 投影拒跑（员工看到的是「这个系统不能运行」，不是空表单）
 *   ② 补齐六份 → 投影成，且**每一份都能对上源契约**
 *   ③ 员工按投影里的视图提交 → 201，拿到记录号
 *   ④ 员工从列表端点读回 → 同一条记录，字段可见性与创建时一致
 *
 * ⚠️ ③④ 之间**必须重新读**，不能拿创建响应当真：
 * 「写进去了」和「读得到」是两件事，中间隔着 RLS 与字段可见性。
 */
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { pool, closeAll } from '../src/db.mjs'
import { A, resetDatabase, grantBaseline, grantPlatformRole, makeSession } from './harness.mjs'
import { submitDraft, approveDraft, publishDraft, DIFF_FACES } from '../src/publish.mjs'
import { handleApi } from '../src/api-router.mjs'

/** 本文件专用的系统代号，与别的测试互不干扰。 */
const ASSET = 'e2e_request'
/** 先发一个**缺流程契约**的版本，验证「不能跑」是一种可观察的状态。 */
const INCOMPLETE = 'e2e_request_partial'

const CHANGE = { kind: 'permission-policy', roleCode: 'staff', addScopes: ['COMPANY'] }
const DIFF = { faces: DIFF_FACES, added: [{ dim: 'DATA', scope: 'COMPANY' }],
               removed: [], changed: [], counts: { added: 1, removed: 0, changed: 0 } }

let owner = null
let builder = null
let employee = null
/** 会话表：`api()` 用它把令牌换成会话事实。 */
const KNOWN_SESSIONS = []

/** 通用事项登记的模型：够多字段，好验字段可见性。 */
function model(assetId) {
  return {
    schema_code: assetId,
    name: '通用事项登记',
    description: '登记一件需要流转的事项',
    fields: [
      { field_code: 'title', label: '标题', type: 'short_text', required: true, nullable: false },
      { field_code: 'detail', label: '说明', type: 'long_text', required: false, nullable: true },
      { field_code: 'amount', label: '金额', type: 'money', required: false, nullable: true },
      { field_code: 'due_date', label: '期限', type: 'date', required: false, nullable: true },
    ],
  }
}

function view(assetId) {
  return {
    view_code: `${assetId}_form`,
    name: '通用事项登记表单',
    view_type: 'FORM',
    businessSchemaRef: { asset_type: 'BUSINESS_SCHEMA', asset_id: assetId },
    componentRegistryRef: { asset_type: 'COMPONENT_REGISTRY', asset_id: 'fixture' },
    componentsTree: [{
      id: 'page_root', componentName: 'FormPage', children: [{
        id: 'basic_section', componentName: 'Section', props: { title: '事项信息' }, children: [
          { id: 'f_title', componentName: 'ShortTextField',
            props: { fieldBinding: { type: 'FieldRef', fieldRef: 'title' } } },
          { id: 'f_detail', componentName: 'LongTextField',
            props: { fieldBinding: { type: 'FieldRef', fieldRef: 'detail' } } },
          { id: 'f_amount', componentName: 'MoneyField',
            props: { fieldBinding: { type: 'FieldRef', fieldRef: 'amount' } } },
          { id: 'f_due', componentName: 'DateField',
            props: { fieldBinding: { type: 'FieldRef', fieldRef: 'due_date' } } },
        ],
      }],
    }],
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

/**
 * 六份契约里，`include` 挑出要发的那几份 —— 用来制造「缺契约」的版本。
 * @param assetId 业务对象代号
 * @param include 要发的契约类型
 * @param overrides 按契约类型覆盖正文（用来发「初始状态不叫 draft」的流程）
 */
function contractsOf(assetId, include, overrides = {}) {
  const all = {
    'business-schema': model(assetId),
    'view-schema': view(assetId),
    'workflow-spec': overrides['workflow-spec'] ?? workflow(assetId),
    'permission-spec': { roles: [], policies: [] },
    'tool-spec': { tools: [] },
    'app-model-command': { commands: [] },
  }
  return include.map((t) => ({ contractType: t, assetId, content: all[t] }))
}

/**
 * 走完 提交 → 审批 → 发布。
 * @param assetId 系统代号
 * @param include 要发的契约类型
 * @param name 系统名
 */
async function publish(assetId, include, name, overrides = {}) {
  const d = await submitDraft({
    ctx: builder.ctx,
    change: { ...CHANGE, assetId, n: randomUUID() },
    diffReport: DIFF,
    invariant: { ok: true },
  })
  await approveDraft({ ctx: owner.ctx, draftId: d.draftId, decision: 'APPROVE' })
  await publishDraft({
    ctx: owner.ctx, draftId: d.draftId,
    apply: async ({ diffDigest }) => ({ diffDigest }),
    system: { assetId, name, schemaCode: assetId },
    contracts: contractsOf(assetId, include, overrides),
  })
}

/** 直接调路由器（不经 HTTP 服务器）—— 本组测的是回路，不是传输。 */
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
 * 给某账号授本系统的动作与数据范围。
 *
 * ⚠️ `grantBaseline` 授的资源码是 `general_item`，不是本文件的系统 ——
 * 夹具必须给出对应的策略，否则「有权的人被判无权」会被误读成代码缺陷。
 * @param userId 账号
 * @param actions 要授的动作
 */
async function grantOnSystem(userId, actions) {
  const roleId = randomUUID()
  await pool('platform').query(
    `INSERT INTO roles (role_id, company_id, role_code, name) VALUES ($1,$2,$3,'e2e')`,
    [roleId, A.company, `e2e_${roleId.slice(0, 8)}`])
  await pool('platform').query(
    `INSERT INTO role_members (company_id, role_id, user_id) VALUES ($1,$2,$3)`,
    [A.company, roleId, userId])
  await pool('platform').query(
    `INSERT INTO policies (policy_id, company_id, role_id, dimension, resource_code,
       actions, data_scopes, field_visibility)
     VALUES ($1,$2,$3,'FORM','*',$4,'{}',NULL)`,
    [randomUUID(), A.company, roleId, actions])
  await pool('platform').query(
    `INSERT INTO policies (policy_id, company_id, role_id, dimension, resource_code,
       actions, data_scopes, field_visibility)
     VALUES ($1,$2,$3,'DATA','*','{}',$4,'VISIBLE')`,
    [randomUUID(), A.company, roleId, ['SELF', 'COMPANY']])
  // 流程维度**必须单独授**：`nextActions` 会按 FLOW 权限过滤，
  // 漏了它的表现是「契约里明明有 submit，可执行清单却是空的」。
  //
  // ⚠️ 但这条策略**同时把真问题盖住了**：它写的是 `resource_code='*'` 与
  //    **业务名** `['submit','approve','reject']`，而真实契约写的是
  //    **业务对象**与**类别**（`['SUBMIT','APPROVE','REJECT']`）。
  //    夹具用通配 + 业务名，于是「运行时的两个参数都取错了」在测试里永远看不出来 ——
  //    到了真试点上，契约自己那两条策略一条也匹配不上（问题 28）。
  //    夹具现在按契约的词表写，与真实数据同形。
  await pool('platform').query(
    `INSERT INTO policies (policy_id, company_id, role_id, dimension, resource_code,
       actions, data_scopes, field_visibility)
     VALUES ($1,$2,$3,'FLOW',$5,$4,'{}',NULL)`,
    [randomUUID(), A.company, roleId, ['SUBMIT', 'APPROVE', 'REJECT'], ASSET])
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

  // ① 缺 workflow-spec 的版本先发出去。
  await publish(INCOMPLETE, ['business-schema', 'view-schema'], '缺契约的系统')
  // ② 完整的版本。
  await publish(ASSET, ['business-schema', 'view-schema', 'workflow-spec',
                        'permission-spec', 'tool-spec', 'app-model-command'], '通用事项登记')
})
after(closeAll)

describe('阶段九 · G7 端到端', () => {
  test('① 契约不全的系统跑不起来，而且说得出缺哪一份', async () => {
    const r = await api('GET', `/api/v1/systems/${INCOMPLETE}/runtime`, employee)
    assert.equal(r.status, 404)
    assert.equal(r.body.error, 'KVVI_RUNTIME_CONTRACT_INCOMPLETE')
    // 只说「不完整」补的人不知道补哪一份；逐份报出是这条判据可用的前提。
    assert.deepEqual([...r.body.missing].sort(),
      ['app-model-command', 'permission-spec', 'tool-spec', 'workflow-spec'])
    assert.equal(r.body.views, undefined, '拒跑却返回了视图')
  })

  test('② 发布的系统出现在本公司的系统列表里', async () => {
    const r = await api('GET', '/api/v1/systems', employee)
    assert.equal(r.status, 200)
    const row = (r.body.items ?? []).find((x) => x.assetId === ASSET)
    assert.ok(row !== undefined, '刚发布的系统没出现在列表里')
    assert.equal(row.name, '通用事项登记')
    assert.equal(r.body.companyId, A.company)
  })

  test('③ 员工拿到的投影能对上源契约', async () => {
    const r = await api('GET', `/api/v1/systems/${ASSET}/runtime`, employee)
    assert.equal(r.status, 200)
    const body = r.body
    assert.equal(body.system.assetId, ASSET)
    assert.equal(body.models[ASSET].schema_code, ASSET)
    assert.equal(body.models[ASSET].fields.length, 4, '投影里的模型字段数与源契约不符')
    assert.equal(body.views[ASSET].view_type, 'FORM')
    assert.equal(body.workflows[ASSET].stateLabels.draft.initial, true)
    // 投影自证：同一个系统两次调用给同一枚指纹。
    const again = await api('GET', `/api/v1/systems/${ASSET}/runtime`, employee)
    assert.equal(again.body.digest, body.digest, '同一份契约两次投影指纹不同')
  })

  test('④ 员工按投影里的视图提交第一条记录 → 201 且有记录号', async () => {
    const runtime = await api('GET', `/api/v1/systems/${ASSET}/runtime`, employee)
    const fields = runtime.body.models[ASSET].fields.map((f) => f.field_code)
    const data = { title: '会议室投影仪坏了', detail: '三号会议室', amount: '0', due_date: '2026-10-01' }
    // 提交的字段必须都是模型声明过的 —— 视图绑不到模型外的字段。
    for (const key of Object.keys(data)) assert.ok(fields.includes(key), `模型没声明 ${key}`)

    const created = await api('POST', `/api/v1/systems/${ASSET}/records`, employee, { data })
    assert.equal(created.status, 201)
    assert.ok(typeof created.body.recordId === 'string' && created.body.recordId !== '')
    assert.equal(created.body.rowVersion, 1)
    assert.ok(typeof created.body.recordNo === 'string' && created.body.recordNo !== '',
      '记录号没生成 —— 列表里就无法指认这条记录')
  })

  test('⑤ 员工从列表端点读得回同一条记录，字段与可见性一致', async () => {
    const list = await api('GET', `/api/v1/systems/${ASSET}/records`, employee)
    assert.equal(list.status, 200)
    const row = (list.body.items ?? []).find((x) => x.data?.title === '会议室投影仪坏了')
    // ⚠️ 必须重新读：写成功与读得到是两件事，中间隔着 RLS 与字段可见性。
    assert.ok(row !== undefined, '刚提交的记录在列表里读不到')
    assert.equal(row.data.detail, '三号会议室')
    assert.equal(row.data.amount, '0')
    assert.ok(row.recordNo !== undefined && row.recordNo !== '')
    // 渲染器只按平台给的可见性画，所以它必须在响应里。
    assert.equal(list.body.fieldVisibility.title, 'VISIBLE')

    const one = await api('GET', `/api/v1/systems/${ASSET}/records/${row.recordId}`, employee)
    assert.equal(one.status, 200)
    assert.equal(one.body.recordId, row.recordId)
    assert.equal(one.body.data.title, '会议室投影仪坏了')
    assert.equal(one.body.fieldVisibility.title, 'VISIBLE')
  })

  test('⑥ 写回一条记录后版本递增，列表里读到的是新值', async () => {
    const list = await api('GET', `/api/v1/systems/${ASSET}/records`, employee)
    const row = (list.body.items ?? []).find((x) => x.data?.title === '会议室投影仪坏了')
    const updated = await api('PATCH',
      `/api/v1/systems/${ASSET}/records/${row.recordId}`, employee,
      { data: { detail: '三号会议室（已修）' }, rowVersion: row.rowVersion })
    assert.equal(updated.status, 200)
    assert.equal(updated.body.rowVersion, row.rowVersion + 1)

    const after = await api('GET', `/api/v1/systems/${ASSET}/records/${row.recordId}`, employee)
    assert.equal(after.body.data.detail, '三号会议室（已修）')
    // 未改的字段必须还在：补丁是合并，不是替换。
    assert.equal(after.body.data.title, '会议室投影仪坏了')
    assert.equal(after.body.data.amount, '0')
  })

  test('⑦ 流程动作：可执行清单与执行一步', async () => {
    const created = await api('POST', `/api/v1/systems/${ASSET}/records`, employee,
      { data: { title: '走流程的单子' } })
    assert.equal(created.status, 201)
    const recordId = created.body.recordId

    // 契约里 draft 上只有 submit 一条迁移（见 `workflow()` 夹具）。
    const actions = await api('GET',
      `/api/v1/systems/${ASSET}/records/${recordId}/actions`, employee)
    assert.equal(actions.status, 200)
    assert.equal(actions.body.state, 'draft')
    assert.deepEqual(actions.body.actions.map((a) => a.action), ['submit'])

    // 不带 rowVersion → 400。流程改的是 state，而「最后写入者获胜」
    // 在流程上比在字段上更坏：批过的单子会被推回待审批。
    const noVersion = await api('POST',
      `/api/v1/systems/${ASSET}/records/${recordId}/transitions`, employee, { action: 'submit' })
    assert.equal(noVersion.status, 400)
    assert.equal(noVersion.body.error, 'KVVI_BAD_REQUEST')

    const moved = await api('POST',
      `/api/v1/systems/${ASSET}/records/${recordId}/transitions`, employee,
      { action: 'submit', rowVersion: created.body.rowVersion })
    assert.equal(moved.status, 200)
    assert.equal(moved.body.from, 'draft')
    assert.equal(moved.body.state, 'submitted')

    // 终态不可写：契约里 submitted 是 terminal，没有任何迁移。
    const terminal = await api('GET',
      `/api/v1/systems/${ASSET}/records/${recordId}/actions`, employee)
    assert.deepEqual(terminal.body.actions, [], '终态还列出了可执行动作')

    // 落库了才算数 —— 从记录端点重新读。
    const after = await api('GET', `/api/v1/systems/${ASSET}/records/${recordId}`, employee)
    assert.equal(after.body.state, 'submitted')
  })

  test('⑦b 流程动作不在契约里 → 稳定拒绝，且**状态不变**', async () => {
    const created = await api('POST', `/api/v1/systems/${ASSET}/records`, employee,
      { data: { title: '乱来一步' } })
    const r = await api('POST',
      `/api/v1/systems/${ASSET}/records/${created.body.recordId}/transitions`, employee,
      { action: 'approve', rowVersion: created.body.rowVersion })
    assert.equal(r.status, 409)
    assert.equal(r.body.error, 'KVVI_UNKNOWN_ACTION')
    const after = await api('GET',
      `/api/v1/systems/${ASSET}/records/${created.body.recordId}`, employee)
    assert.equal(after.body.state, 'draft', '被拒的迁移改了状态')
  })

  test('⑨ ★ 新记录的出生状态来自**契约**，不是代码里的字面量', async () => {
    // 建表时写死了 `state text NOT NULL DEFAULT 'draft'`，而搭建者的流程契约里
    // 初始状态可以叫任何名字。这里把它改成 `not_followed` 再发一版 ——
    // 如果运行时用的是写死的 `'draft'`，下面第一条断言就会读到 `draft`，
    // 而**后果**是 `nextActions(spec, 'draft')` 找不到出边、可执行清单为空：
    // 界面上一个流程按钮都没有（问题 28）。
    await publish(ASSET, ['business-schema', 'view-schema', 'workflow-spec',
                          'permission-spec', 'tool-spec', 'app-model-command'],
                  '通用事项登记（初始状态改了名）', {
      'workflow-spec': {
        businessSchemaRef: { asset_type: 'BUSINESS_SCHEMA', asset_id: ASSET },
        states: [
          { state_code: 'not_followed', name: '未跟进', initial: true, terminal: false },
          { state_code: 'following', name: '跟进中', initial: false, terminal: false },
        ],
        actions: [{ action_code: 'start_follow', kind: 'SUBMIT', capability_ref: {} }],
        transitions: [{ transition_code: 'start_following', from_state: 'not_followed',
                        to_state: 'following', action_code: 'start_follow' }],
        approverRef: { kind: 'SINGLE', role_ref: {
          permission_ref: { asset_type: 'PERMISSION', asset_id: 'role_directory' },
          subresource: { type: 'ROLE', code: 'supervisor' } } },
      },
    })

    const created = await api('POST', `/api/v1/systems/${ASSET}/records`, employee,
      { data: { title: '看它出生在哪个状态' } })
    assert.equal(created.status, 201)
    const read = await api('GET', `/api/v1/systems/${ASSET}/records/${created.body.recordId}`,
                           employee)
    assert.equal(read.body.state, 'not_followed',
                 '新记录出生在写死的状态里，而不是契约的 initial')

    // 而且动作是从**它**出发的 —— 这条才是有用的那一半：
    // 状态对了但动作清单空着，界面上还是一片按钮都没有。
    const actions = await api('GET',
      `/api/v1/systems/${ASSET}/records/${created.body.recordId}/actions`, employee)
    assert.equal(actions.body.state, 'not_followed')
    assert.deepEqual(actions.body.actions.map((a) => a.action), ['start_follow'])
  })

  test('⑧ 没有会话就没有任何业务数据', async () => {
    const r = await api('GET', `/api/v1/systems/${ASSET}/records`, null)
    assert.equal(r.status, 401)
    assert.equal(r.body.error, 'KVVI_TOKEN_REQUIRED')
    assert.equal(r.body.items, undefined, '未鉴权却返回了记录')
  })
})
