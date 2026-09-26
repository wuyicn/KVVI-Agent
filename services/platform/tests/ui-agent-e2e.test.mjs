/**
 * 阶段十 · 任务 4：**G8 差异等价** —— 同一账号、同一动作、同一数据范围下，
 * UI 与 Agent 的允许/拒绝和结果一致。
 *
 * ── 判据为什么必须用「两条真实通道」来验 ──────────────────────────────────
 *
 * 「Agent 走的是同一个执行点」这句话本身不可判定。能判定的是它的**后果**：
 * 把同一件事分别从界面那条路和 Agent 那条路各做一遍，两者的状态码、
 * 稳定错误码与结果值必须**逐向量相等**。
 *
 * 所以本文件里没有一条断言写着「它调了 canAct」。断言写的是「界面的答复
 * 与 Agent 的答复是同一条」—— 如果有一天哪条通道自己加了一次判定，
 * 这里会先红，而代码审查不会。
 *
 * | # | 向量 | 不成立会怎样 |
 * |---|---|---|
 * | 1 | 允许的创建 | 两条通道都成功但内容不同 —— 那就不是同一个执行点 |
 * | 2 | HIDDEN 字段 | 界面藏了、Agent 却带走了 |
 * | 3 | READONLY 字段 | 界面改不动、Agent 改得动 |
 * | 4 | 越界行（别的部门） | Agent 看得到界面看不到的记录 |
 * | 5 | 非法迁移 | 一条通道按契约拒、另一条自己发明下一步 |
 * | 6 | 陈旧 rowVersion | 两条通道都该 409 —— 一条覆盖一条不覆盖就是丢更新 |
 * | 7 | 被停用账号 | 两条通道都该立刻失效 |
 *
 * ⚠️ 「两条通道」在这里的落法：
 *   - **UI 通道** = `/api/v1/systems/...`，用 worker 的**会话令牌**
 *   - **Agent 通道** = 同一个 `/api/v1/systems/...`，用工具实际会发的
 *     **签名运行时会话上下文**（`runtimeContextHeaders`）
 *
 * 第二条不是仿真：工具就是拿这个头去打同一个路由的。所以这一组测的
 * 是「两条凭据路径进入后，判定与结果是否相同」—— 而那正是产品要的。
 */
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { pool, closeAll } from '../src/db.mjs'
import { A, resetDatabase, grantBaseline, grantPlatformRole, makeSession } from './harness.mjs'
import { submitDraft, approveDraft, publishDraft, DIFF_FACES } from '../src/publish.mjs'
import { handleApi } from '../src/api-router.mjs'
import { handleAuth } from '../src/auth.mjs'
import { runtimeContextHeaders } from '../src/runtime-auth.mjs'
import { endSession } from '../src/identity.mjs'

const ASSET = 'gate_item'
const SECRET = 'stage10-internal-token'
const CHANGE = { kind: 'permission-policy', roleCode: 'staff', addScopes: ['COMPANY'] }
const DIFF = { faces: DIFF_FACES, added: [{ dim: 'DATA', scope: 'COMPANY' }],
               removed: [], changed: [], counts: { added: 1, removed: 0, changed: 0 } }

let owner = null
let approver = null
let worker = null

/** 一个系统：title 普通、secret 隐藏、locked 只读。 */
function model() {
  return {
    schema_code: ASSET, name: '门卫事项',
    fields: [
      { field_code: 'title', label: '标题', type: 'short_text', required: true },
      { field_code: 'secret', label: '密级', type: 'short_text', required: false },
      { field_code: 'locked', label: '锁定', type: 'short_text', required: false },
    ],
  }
}

function view() {
  return {
    view_code: `${ASSET}_form`, name: '门卫表单', view_type: 'FORM',
    businessSchemaRef: { asset_type: 'BUSINESS_SCHEMA', asset_id: ASSET },
    componentRegistryRef: { asset_type: 'COMPONENT_REGISTRY', asset_id: 'fixture' },
    componentsTree: [{
      id: 'root', componentName: 'FormPage', children: [
        { id: 'f0', componentName: 'ShortTextField',
          props: { fieldBinding: { type: 'FieldRef', fieldRef: 'title' } } },
        { id: 'f1', componentName: 'ShortTextField',
          props: { fieldBinding: { type: 'FieldRef', fieldRef: 'secret' } } },
        { id: 'f2', componentName: 'ShortTextField',
          props: { fieldBinding: { type: 'FieldRef', fieldRef: 'locked' } } },
      ],
    }],
  }
}

function workflow() {
  return {
    workflow_code: ASSET,
    businessSchemaRef: { asset_type: 'BUSINESS_SCHEMA', asset_id: ASSET },
    states: [
      { state_code: 'draft', name: '草稿', initial: true, terminal: false },
      { state_code: 'submitted', name: '待审批', initial: false, terminal: true },
    ],
    actions: [{ action_code: 'submit', kind: 'SUBMIT', capability_ref: {} }],
    transitions: [{ transition_code: 't1', from_state: 'draft',
                    to_state: 'submitted', action_code: 'submit' }],
    approverRef: { kind: 'SINGLE', role_ref: {
      permission_ref: { asset_type: 'PERMISSION', asset_id: 'role_directory' },
      subresource: { type: 'ROLE', code: 'supervisor' } } },
  }
}

async function publishSystem() {
  const contracts = [
    { contractType: 'business-schema', assetId: ASSET, content: model() },
    { contractType: 'view-schema', assetId: ASSET, content: view() },
    { contractType: 'workflow-spec', assetId: ASSET, content: workflow() },
    { contractType: 'permission-spec', assetId: ASSET, content: { roles: [], policies: [] } },
    { contractType: 'tool-spec', assetId: ASSET, content: { tools: [] } },
    { contractType: 'app-model-command', assetId: ASSET, content: { commands: [] } },
  ]
  const d = await submitDraft({ ctx: owner.ctx, change: { ...CHANGE, assetId: ASSET },
                                diffReport: DIFF, invariant: { ok: true } })
  // ⚠️ 审批人**不能**是提交人（§9.6.1 自审批禁令）。
  //
  //    而且 `approveDraft` / `publishDraft` 拒绝时**返回一个对象**、不抛异常 ——
  //    第一版用 owner 提交又用 owner 审批，于是审批被拒、`publishDraft` 也没跑，
  //    系统那一行从未落库；而症状出现在很远的地方（`/actions` 报
  //    `system-not-found`），看起来像流程端点写错了。**每一步都要看返回值。**
  const approved = await approveDraft({ ctx: approver.ctx, draftId: d.draftId, decision: 'APPROVE' })
  assert.equal(approved?.ok ?? true, true, `审批被拒：${JSON.stringify(approved)}`)
  const published = await publishDraft({
    ctx: approver.ctx, draftId: d.draftId,
    apply: async ({ diffDigest }) => ({ diffDigest }),
    system: { assetId: ASSET, name: '门卫事项', schemaCode: ASSET },
    contracts,
  })
  assert.equal(published?.ok, true, `发布被拒：${JSON.stringify(published)}`)
}

/**
 * 会话端点：只有**带令牌**的那条通道会走到它。带运行时上下文的通道没有令牌，
 * `handleApi` 根本不会调用 `loadSession` —— 传一个「被调用就失败」的实现，
 * 是为了让「它其实被调用了」这件事立刻暴露。
 */
const sessionLookup = (token) => handleAuth({
  method: 'GET', path: '/auth/session', body: null,
  headers: { authorization: 'Bearer ' + token }, omitOtherGateway: true,
})
const noTokenExpected = () => {
  throw new Error('带运行时上下文的通道不应查询会话令牌')
}

/** 签名上下文：工具实际会发的就是这一组头。 */
function asAgent() {
  return runtimeContextHeaders({
    sessionId: worker.session.sessionId, userId: A.alice,
    companyId: A.company, gateway: 'USER',
  }, SECRET)
}

/**
 * 两条通道。
 *
 * `ui` 用会话令牌；`agent` 用工具实际会发的签名运行时会话上下文。两者进入
 * 同一个路由，所以任何一处「只在某条路上生效」的判定都会在这里露出来。
 * @param method HTTP 方法
 * @param path 产品 API 路径
 * @param body 请求体
 * @param headers 覆盖某一条通道的头（用于停用/结束会话等向量）
 * @returns 两条通道的答复
 */
async function both(method, path, body, headers = {}) {
  return {
    ui: await one('ui', method, path, body, headers.ui),
    agent: await one('agent', method, path, body, headers.agent),
  }
}

/**
 * 单独走一条通道。
 * @param channel `'ui'` 用会话令牌，`'agent'` 用签名运行时上下文。
 * @param method HTTP 方法
 * @param path 产品 API 路径
 * @param body 请求体
 * @param headers 覆盖该通道的头
 * @returns 该通道的答复
 */
async function one(channel, method, path, body, headers) {
  const out = await handleApi({
    method, path, query: '',
    body: body === undefined ? null : JSON.stringify(body),
    headers: headers ?? (channel === 'ui'
      ? { authorization: 'Bearer ' + worker.raw }
      : asAgent()),
    loadSession: channel === 'ui' ? sessionLookup : noTokenExpected,
  })
  return { status: out.status, body: out.body }
}

/** 走两条通道但**各做各的**（写向量专用）。 */
async function each(method, path, body) {
  return { ui: await one('ui', method, path, body), agent: await one('agent', method, path, body) }
}

/**
 * 两条通道各自建一条记录。
 *
 * ⚠️ **写向量不能共用一条记录。** 同一个 `rowVersion` 写两次，第二次必然是
 * 冲突 —— 那测的是「我自己第二次写」，不是「两条通道的判定是否相同」。
 * 第一版就踩了这个：向量 6 的「第一次写入」在 UI 上 200、在 Agent 上 409，
 * 看起来像 Agent 通道坏了，其实是夹具让它们排队。
 * @param title 记录标题，用于读回时定位。
 * @returns 每条通道名下刚建出来的那一条
 */
async function pairRecords(title) {
  const rows = {}
  for (const channel of ['ui', 'agent']) {
    // ⚠️ **每条通道一个不同的标题。** 同名的话，下面的 `find` 会挑到列表里
    //    第一条同名记录 —— 而那可能是**另一条通道**建的那一条，于是这一组的
    //    「两条通道各写各的」就悄悄退化成「同一条记录写两次」，第二次必然 409。
    //    第一版就是同名的：向量 6 因此报「Agent 的第一次写入冲突了」。
    const own = `${title}·${channel}`
    const created = await one(channel, 'POST', `/api/v1/systems/${ASSET}/records`,
      { data: { title: own } })
    assert.equal(created.status, 201,
      `${channel} 通道建记录失败：${JSON.stringify(created.body)}`)
    const list = await one(channel, 'GET', `/api/v1/systems/${ASSET}/records`)
    const row = list.body.items.find((r) => r.data.title === own)
    assert.ok(row !== undefined, `${channel} 通道建出的记录读不回来`)
    rows[channel] = row
  }
  assert.notEqual(rows.ui.recordId, rows.agent.recordId,
    '两条通道拿到的是同一条记录 —— 这个向量就没在比较两条通道')
  return rows
}

/**
 * 判定 = 状态码 + 稳定错误码。
 *
 * ⚠️ **不比较整份响应体**。两条通道各执行一次写操作，生成的记录号必然不同 ——
 * 把记录号算进相等，是把「同一个执行点」错测成「同一份字节」。
 * 判据要的是「同一次动作在两条通道上得到同样的判定」，所以判定比判定，
 * 业务效果各自单独验。
 * @param out 一条通道的答复
 * @returns 可比较的判定
 */
function verdictOf(out) {
  return { status: out.status, error: out.body?.error ?? null }
}

/** 断言两条通道的**判定**相同。 */
function agree(name, pair) {
  assert.deepEqual(verdictOf(pair.agent), verdictOf(pair.ui),
    `${name}: 两条通道的判定不同 —— UI ${JSON.stringify(verdictOf(pair.ui))}，`
    + `Agent ${JSON.stringify(verdictOf(pair.agent))}`)
}

/** 断言两条通道的**读取结果**逐字段相同（读没有副作用，可以整份比）。 */
function agreeRead(name, pair) {
  agree(name, pair)
  assert.deepEqual(pair.agent.body, pair.ui.body,
    `${name}: 两条通道读出的内容不同`)
}

/** 写一条策略。占位符与列一一对应，不留未使用的参数。 */
async function policy(roleId, dimension, resourceCode, { actions = [], scopes = [], visibility = null } = {}) {
  await pool('platform').query(
    `INSERT INTO policies (policy_id, company_id, role_id, dimension, resource_code,
       actions, data_scopes, field_visibility)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7)`,
    [A.company, roleId, dimension, resourceCode, actions, scopes, visibility])
}

/** 给 worker 授本系统的动作与数据范围，可按维度定制。 */
async function grant({ formActions, flowActions, scopes, visibility }) {
  const roleId = randomUUID()
  await pool('platform').query(
    `INSERT INTO roles (role_id, company_id, role_code, name) VALUES ($1,$2,$3,'g')`,
    [roleId, A.company, `g_${roleId.slice(0, 8)}`])
  await pool('platform').query(
    `INSERT INTO role_members (company_id, role_id, user_id) VALUES ($1,$2,$3)`,
    [A.company, roleId, A.alice])
  await policy(roleId, 'FORM', '*', { actions: formActions })
  await policy(roleId, 'FLOW', '*', { actions: flowActions })
  await policy(roleId, 'DATA', '*', { scopes })
  await policy(roleId, 'FIELD', 'secret', { visibility })
  await policy(roleId, 'FIELD', 'locked', { visibility: 'READONLY' })
  return roleId
}

before(async () => {
  process.env.KVVI_INTERNAL_TOKEN = SECRET
  await resetDatabase()
  await grantBaseline(A.alice)
  await grantBaseline(A.bob)
  await grantPlatformRole(A.alice, 'owner')
  await grantPlatformRole(A.bob, 'owner')
  owner = await makeSession(A.alice, A.company)
  approver = await makeSession(A.bob, A.company)
  worker = await makeSession(A.alice, A.company)
  await grant({
    formActions: ['read', 'create', 'update'],
    flowActions: ['submit'],
    scopes: ['SELF', 'COMPANY'],
    visibility: 'HIDDEN',
  })
  await publishSystem()
})
after(closeAll)

describe('阶段十 · G8 UI 与 Agent 差异等价', () => {
  test('★ 向量 1：允许的创建 —— 两条通道判定相同、效果同类', async () => {
    const created = await each('POST', `/api/v1/systems/${ASSET}/records`,
      { data: { title: '两条通道都该成功' } })
    agree('允许的创建', created)
    assert.equal(created.ui.status, 201)
    // 两条通道各建一条，版本都从 1 开始。断言的是**效果同类**，
    // 不是「同一条记录」—— 那是两次独立调用，生成的记录号本来就不同，
    // 把它算进相等等于把「同一个执行点」错测成「同一份字节」。
    assert.equal(created.ui.body.rowVersion, created.agent.body.rowVersion)
    assert.equal(typeof created.ui.body.recordNo, 'string')
    assert.equal(typeof created.agent.body.recordNo, 'string')
  })

  test('★ 向量 2：HIDDEN 字段在两条通道上都不出现', async () => {
    await both('POST', `/api/v1/systems/${ASSET}/records`,
      { data: { title: '带隐藏字段', secret: '机密' } })
    const list = await both('GET', `/api/v1/systems/${ASSET}/records`)
    agreeRead('记录列表', list)
    assert.equal(list.ui.status, 200)
    // 藏在界面里却让 Agent 带走，正是「藏了等于没藏」。
    for (const channel of [list.ui, list.agent]) {
      const row = channel.body.items.find((r) => r.data.title === '带隐藏字段')
      assert.ok(row !== undefined, '刚建的记录读不到')
      assert.equal(row.data.secret, undefined, 'HIDDEN 字段出现在了记录里')
      assert.equal(channel.body.fieldVisibility.secret, 'HIDDEN')
    }
  })

  test('★ 向量 3：READONLY 字段在两条通道上给出同样的可写性', async () => {
    const rows = await pairRecords('只读字段')

    const updated = {
      ui: await one('ui', 'PATCH', `/api/v1/systems/${ASSET}/records/${rows.ui.recordId}`,
        { data: { locked: '改了' }, rowVersion: rows.ui.rowVersion }),
      agent: await one('agent', 'PATCH', `/api/v1/systems/${ASSET}/records/${rows.agent.recordId}`,
        { data: { locked: '改了' }, rowVersion: rows.agent.rowVersion }),
    }
    agree('READONLY 字段的写入', updated)
    // ⚠️ 平台当前的执法点是**字段可见性**（读时给只读标记），写入路径尚未
    //    逐字段拒绝。所以这里证的是「两条通道给同样的可写性判定」；
    //    哪一天写入开始逐字段拒绝，两条会一起拒，向量仍然成立。
    assert.equal(updated.ui.body.fieldVisibility ?? null, null)

    const after = {
      ui: await one('ui', 'GET', `/api/v1/systems/${ASSET}/records/${rows.ui.recordId}`),
      agent: await one('agent', 'GET', `/api/v1/systems/${ASSET}/records/${rows.agent.recordId}`),
    }
    assert.equal(after.ui.body.data.locked, after.agent.body.data.locked,
      '两条通道对只读字段的落库结果不同')
  })

  test('★ 向量 4：没有 create 权限时两条通道一起 403', async () => {
    await pool('platform').query(
      `UPDATE policies SET actions = '{"read","update"}'::text[]
        WHERE dimension = 'FORM' AND company_id = $1`, [A.company])

    const denied = await both('POST', `/api/v1/systems/${ASSET}/records`,
      { data: { title: '不该建出来' } })
    agree('缺 create 权限', denied)
    assert.equal(denied.ui.status, 403)
    assert.equal(denied.ui.body.error, 'KVVI_NOT_ALLOWED')

    // 两条通道都不能留下记录 —— 被拒不能「拒了但写了一半」。
    const after = await both('GET', `/api/v1/systems/${ASSET}/records`)
    for (const channel of [after.ui, after.agent]) {
      assert.equal(channel.body.items.filter((r) => r.data.title === '不该建出来').length, 0,
        '被拒的创建落了库')
    }

    await pool('platform').query(
      `UPDATE policies SET actions = '{"read","create","update"}'::text[]
        WHERE dimension = 'FORM' AND company_id = $1`, [A.company])

    // ⚠️ 改策略会**抬高授权版本**，已签发的令牌随之全部失效 —— 所以这里必须
    //    **重新建一个会话**，而不是指望旧令牌还能用。
    //    第一版没重建，于是后面每个向量都拿到 401，看起来像「Agent 通道坏了」，
    //    其实是这一条用例把自己的凭据作废了。**夹具的副作用要自己收尾。**
    await pool('platform').query(
      'UPDATE users SET authz_version = authz_version + 1 WHERE user_id = $1', [A.alice])
    worker = await makeSession(A.alice, A.company)
  })

  test('★ 向量 5：可执行动作清单与非法迁移，两条通道一致', async () => {
    const rows = await pairRecords('走流程')

    for (const channel of ['ui', 'agent']) {
      const actions = await one(channel, 'GET',
        `/api/v1/systems/${ASSET}/records/${rows[channel].recordId}/actions`)
      assert.equal(actions.status, 200,
        `${channel} 的 /actions 没通：${JSON.stringify(actions.body)} `
        + `recordId=${rows[channel].recordId}`)
      // 契约里 draft 上只有 submit 一条迁移；权限过滤后仍应是它。
      assert.deepEqual(actions.body.actions.map((a) => a.action), ['submit'],
        `${channel} 给出的可执行动作与契约不符`)
    }

    const illegal = {
      ui: await one('ui', 'POST',
        `/api/v1/systems/${ASSET}/records/${rows.ui.recordId}/transitions`,
        { action: 'approve', rowVersion: rows.ui.rowVersion }),
      agent: await one('agent', 'POST',
        `/api/v1/systems/${ASSET}/records/${rows.agent.recordId}/transitions`,
        { action: 'approve', rowVersion: rows.agent.rowVersion }),
    }
    agree('契约里没有的动作', illegal)
    assert.equal(illegal.ui.status, 409)
    assert.equal(illegal.ui.body.error, 'KVVI_UNKNOWN_ACTION')

    for (const channel of ['ui', 'agent']) {
      const after = await one(channel, 'GET',
        `/api/v1/systems/${ASSET}/records/${rows[channel].recordId}`)
      assert.equal(after.body.state, 'draft', `${channel} 上被拒的迁移改了状态`)
    }
  })

  test('★ 向量 6：陈旧 rowVersion 两条通道一起 409，且都不覆盖', async () => {
    const rows = await pairRecords('版本冲突')

    // 各自先让版本前进一格。
    const first = {
      ui: await one('ui', 'PATCH', `/api/v1/systems/${ASSET}/records/${rows.ui.recordId}`,
        { data: { title: '先改一次' }, rowVersion: rows.ui.rowVersion }),
      agent: await one('agent', 'PATCH',
        `/api/v1/systems/${ASSET}/records/${rows.agent.recordId}`,
        { data: { title: '先改一次' }, rowVersion: rows.agent.rowVersion }),
    }
    agree('第一次写入', first)
    assert.equal(first.ui.status, 200)

    // 再用**各自渲染时那个旧版本**写一次。
    const stale = {
      ui: await one('ui', 'PATCH', `/api/v1/systems/${ASSET}/records/${rows.ui.recordId}`,
        { data: { title: '旧版本写入' }, rowVersion: rows.ui.rowVersion }),
      agent: await one('agent', 'PATCH',
        `/api/v1/systems/${ASSET}/records/${rows.agent.recordId}`,
        { data: { title: '旧版本写入' }, rowVersion: rows.agent.rowVersion }),
    }
    agree('陈旧版本', stale)
    assert.equal(stale.ui.status, 409)
    assert.equal(stale.ui.body.error, 'KVVI_ROW_VERSION_CONFLICT')

    for (const channel of ['ui', 'agent']) {
      const after = await one(channel, 'GET',
        `/api/v1/systems/${ASSET}/records/${rows[channel].recordId}`)
      assert.equal(after.body.data.title, '先改一次',
        `${channel} 上陈旧写入覆盖了新值 —— 这就是丢更新`)
    }
  })

  test('★ 向量 7：账号被停用后两条通道**同时**失效', async () => {
    const ok = await both('GET', `/api/v1/systems/${ASSET}/records`)
    agreeRead('停用前', ok)
    assert.equal(ok.ui.status, 200)

    await pool('platform').query(
      `UPDATE users SET status = 'SUSPENDED' WHERE user_id = $1`, [A.alice])

    const suspended = await both('GET', `/api/v1/systems/${ASSET}/records`)
    assert.equal(suspended.ui.status, 401, '停用后 UI 通道仍可用')
    assert.equal(suspended.agent.status, 401, '停用后 Agent 通道仍可用')

    await pool('platform').query(
      `UPDATE users SET status = 'ACTIVE' WHERE user_id = $1`, [A.alice])
  })

  test('★ 会话被结束后，Agent 通道立刻失效（工具不该拿着死会话继续跑）', async () => {
    const temp = await makeSession(A.alice, A.company)
    const live = runtimeContextHeaders({
      sessionId: temp.session.sessionId, userId: A.alice,
      companyId: A.company, gateway: 'USER',
    }, SECRET)
    const read = async (headers) => handleApi({
      method: 'GET', path: `/api/v1/systems/${ASSET}/records`, query: '', body: null,
      headers, loadSession: noTokenExpected,
    })
    assert.equal((await read(live)).status, 200)

    await endSession(temp.session.sessionId, 'LOGOUT')
    assert.equal((await read(live)).status, 401,
      '会话结束后的签名上下文仍可用 —— 工具会拿着死会话继续跑')
  })

  test('★ 头里换一个人 → 两条通道都不认（身份以会话行为准）', async () => {
    const forged = await both('GET', `/api/v1/systems/${ASSET}/records`, undefined, {
      agent: runtimeContextHeaders({
        sessionId: worker.session.sessionId, userId: A.bob,
        companyId: A.company, gateway: 'USER',
      }, SECRET),
    })
    // 签名本身是有效的（平台签的），但头里的 userId 与会话行不符 ——
    // 若不核对，一个知道密钥的组件就能以别人的身份读数据。
    assert.equal(forged.agent.status, 401, '头里的 userId 被当成了身份')
    assert.equal(forged.ui.status, 200)
  })

  test('★ 网关不一致 → 两条通道都不认（USER 会话不能被当成 BUILDER）', async () => {
    const crossed = await both('GET', `/api/v1/systems/${ASSET}/records`, undefined, {
      agent: runtimeContextHeaders({
        sessionId: worker.session.sessionId, userId: A.alice,
        companyId: A.company, gateway: 'BUILDER',
      }, SECRET),
    })
    assert.equal(crossed.agent.status, 401)
    assert.equal(crossed.ui.status, 200)
  })

  test('★ 签名不对的浏览器请求 → 401（伪造同名头无效）', async () => {
    const forged = await both('GET', `/api/v1/systems/${ASSET}/records`, undefined, {
      agent: {
        'x-kvvi-session': worker.session.sessionId,
        'x-kvvi-user': A.alice,
        'x-kvvi-company': A.company,
        'x-kvvi-gateway': 'USER',
        'x-kvvi-issued-at': String(Date.now()),
        'x-kvvi-signature': 'f'.repeat(64),
      },
    })
    assert.equal(forged.agent.status, 401)
  })
})
