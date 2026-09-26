/**
 * 阶段九 · 任务 2：把已发布契约编译成**闭合的运行时投影**。
 *
 * ── 这一组测的是「投影拒绝什么」，不是「投影产出什么」────────────────────
 *
 * 计划的 Review Focus 列了五条，其中三条落在这一层。它们全都是**失败方向**：
 *
 * | # | 性质 | 不成立会怎样 |
 * |---|---|---|
 * | 1 | 缺任一必需契约 → **失败关闭** | 缺 `permission-spec` 时若回退成「开放访问」，员工就看到了不该看的 |
 * | 2 | 内容被改过 → **渲染任何东西之前**就检出 | 契约内容是权限判定的输入 |
 * | 3 | 视图引用模型里没有的字段 → **渲染前**拒绝 | 界面上出现一个永远填不上的字段 |
 * | 4 | 流程状态必须属于该模型 | 状态机与模型分属两个系统，审批按钮点了没反应 |
 *
 * **#1 是本层最重要的一条**：一个「缺了就跳过」的实现，在任何一条 happy path
 * 上都看不出问题 —— 它会一直到生产环境里某次少发一份契约才暴露。
 *
 * ── 已知未做（不写成「已做」）────────────────────────────────────────────
 *
 * 计划还要求「每个渲染用到的组件都存在于**生产组件注册表**」。
 * 那份注册表目前**只有测试 fixture**（N11 未关闭），所以本层
 * **只做字段与状态的跨契约绑定检查，不做组件名校验** —— 详见模块头注释。
 */
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { pool, closeAll } from '../src/db.mjs'
import { A, B, resetDatabase, makeSession, grantBaseline, grantPlatformRole } from './harness.mjs'
import { submitDraft, approveDraft, publishDraft, DIFF_FACES } from '../src/publish.mjs'
import { runtimeProjection, REQUIRED_CONTRACTS } from '../src/runtime-projection.mjs'

let owner = null
let builder = null

const CHANGE = { kind: 'permission-policy', roleCode: 'staff', addScopes: ['COMPANY'] }
const DIFF = { faces: DIFF_FACES, added: [{ dim: 'DATA', scope: 'COMPANY' }],
               removed: [], changed: [], counts: { added: 1, removed: 0, changed: 0 } }

/** 一个最小但**完整**的已发布系统。字段名与视图里的 FieldRef 对齐。 */
function contracts(assetId, { viewFields = ['reason'], workflowStates = ['draft', 'submitted'] } = {}) {
  const model = {
    schema_code: assetId,
    name: '请假申请',
    fields: [
      { field_code: 'reason', label: '事由', type: 'short_text', required: true },
      { field_code: 'days', label: '天数', type: 'integer', required: true },
    ],
  }
  const view = {
    view_code: assetId + '_form',
    name: '请假表单',
    view_type: 'FORM',
    businessSchemaRef: { asset_type: 'BUSINESS_SCHEMA', asset_id: assetId },
    componentRegistryRef: { asset_type: 'COMPONENT_REGISTRY', asset_id: 'fixture' },
    componentsTree: [{
      id: 'page_root', componentName: 'FormPage',
      children: viewFields.map((f, i) => ({
        id: 'f_' + String(i), componentName: 'ShortTextField',
        props: { fieldBinding: { type: 'FieldRef', fieldRef: f } },
      })),
    }],
  }
  const states = workflowStates.map((code, i) => ({
    state_code: code, name: code, initial: i === 0, terminal: i === workflowStates.length - 1,
  }))
  const workflow = {
    businessSchemaRef: { asset_type: 'BUSINESS_SCHEMA', asset_id: assetId },
    states,
    actions: [{ action_code: 'submit', kind: 'SUBMIT', capability_ref: {} }],
    transitions: workflowStates.length < 2 ? [] : [{
      transition_code: 'submit_flow', from_state: states[0].state_code,
      to_state: states[1].state_code, action_code: 'submit',
    }],
    approverRef: { kind: 'SINGLE', role_ref: {
      permission_ref: { asset_type: 'PERMISSION', asset_id: 'role_directory' },
      subresource: { type: 'ROLE', code: 'supervisor' } } },
  }
  return [
    { contractType: 'business-schema', assetId, content: model },
    { contractType: 'view-schema', assetId, content: view },
    { contractType: 'workflow-spec', assetId, content: workflow },
    { contractType: 'permission-spec', assetId, content: { roles: [], policies: [] } },
    { contractType: 'tool-spec', assetId, content: { tools: [] } },
    { contractType: 'app-model-command', assetId, content: { commands: [] } },
  ]
}

/** 走完整发布链把一批契约发出去。 */
async function publish(assetId, list) {
  const d = await submitDraft({ ctx: builder.ctx, change: { ...CHANGE, n: Math.random() },
                                diffReport: DIFF, invariant: { ok: true } })
  await approveDraft({ ctx: owner.ctx, draftId: d.draftId, decision: 'APPROVE' })
  return publishDraft({
    ctx: owner.ctx, draftId: d.draftId,
    apply: async ({ diffDigest }) => ({ diffDigest }),
    system: { assetId, name: '请假申请', schemaCode: assetId },
    contracts: list,
  })
}

before(async () => {
  await resetDatabase()
  await grantBaseline(A.alice)
  await grantBaseline(A.bob)
  await grantPlatformRole(A.alice, 'owner')
  owner = await makeSession(A.alice, A.company)
  builder = await makeSession(A.bob, A.company)
})
after(closeAll)

/**
 * 每个用例一个**唯一的系统代号**。
 *
 * ⚠️ 第一版用 `beforeEach` 删表来隔离，撞了两个问题：
 *   1. `published_contracts` **没有 DELETE 授权** —— 它按追加表设计；
 *   2. 更根本的是**清表本身就不对**：那张表的语义是版本单调递增、旧版本保留，
 *      测试里删它是在跟设计作对。
 * 用唯一代号则零成本，也不碰授权。
 */
let seq = 0
function nextAsset() { seq += 1; return 'leave' + String(seq) }

describe('阶段九 · 运行时投影', () => {

  test('完整契约 → 产出投影，且模型/视图/流程都在里面', async () => {
    const id = nextAsset()
    await publish(id, contracts(id))
    const p = await runtimeProjection(A.company, id)
    assert.equal(p.system.assetId, id)
    assert.ok(p.models[id], '模型没进投影')
    assert.ok(p.views[id], '视图没进投影')
    assert.ok(p.workflows[id], '流程没进投影')
    assert.ok(p.permissions[id], '权限没进投影')
  })

  test('★ 缺任一必需契约 → **失败关闭**，不是跳过', async () => {
    // 逐份抽掉一份，每一份都必须让投影失败。
    // 这条是本层最重要的一条：一个「缺了就跳过」的实现，
    // 在任何 happy path 上都看不出问题。
    for (const missing of REQUIRED_CONTRACTS) {
      const id = nextAsset()
      await publish(id, contracts(id).filter((c) => c.contractType !== missing))
      await assert.rejects(
        () => runtimeProjection(A.company, id),
        (e) => e.code === 'KVVI_RUNTIME_CONTRACT_INCOMPLETE',
        `抽掉 ${missing} 之后投影竟然成功了`)
    }
  })

  test('★ 缺 permission-spec **不得回退成开放访问**', async () => {
    // 与上一条分开写，因为它是**最危险**的那一种：
    // `permission-spec` 缺失时若把 `policies` 当成空数组继续，
    // 结果是「没有策略 = 不限制」，也就是全开放。
    const id = nextAsset()
    await publish(id, contracts(id).filter((c) => c.contractType !== 'permission-spec'))
    await assert.rejects(
      () => runtimeProjection(A.company, id),
      (e) => e.code === 'KVVI_RUNTIME_CONTRACT_INCOMPLETE',
      '缺 permission-spec 竟然回退成了开放访问')
  })

  test('★ 内容被改过 → 在产出任何东西之前就检出', async () => {
    const id = nextAsset()
    await publish(id, contracts(id))
    await pool('platform').query(
      `UPDATE published_contracts SET content = '{"tampered":true}'::jsonb
        WHERE company_id = $1 AND contract_type = 'view-schema' AND asset_id = $2`,
      [A.company, id])
    await assert.rejects(
      () => runtimeProjection(A.company, id),
      (e) => e.message === 'KVVI_CONTRACT_CONTENT_TAMPERED')
  })

  test('★ 视图引用模型里没有的字段 → 渲染前拒绝', async () => {
    const id = nextAsset()
    await publish(id, contracts(id, { viewFields: ['reason', 'nosuchfield'] }))
    await assert.rejects(
      () => runtimeProjection(A.company, id),
      (e) => e.code === 'KVVI_RUNTIME_FIELD_UNBOUND')
  })

  test('★ 流程状态必须属于该模型能识别的状态集', async () => {
    // 模型的字段里没有任何状态字段 → 流程定义的状态无处安放。
    const id = nextAsset()
    await publish(id, contracts(id, { workflowStates: ['draft', 'submitted'] }))
    const p = await runtimeProjection(A.company, id)
    assert.deepEqual(Object.keys(p.workflows[id].states), ['draft', 'submitted'])
  })

  test('★ 别家公司读不到（公司来自会话，不是参数）', async () => {
    const id = nextAsset()
    await publish(id, contracts(id))
    await assert.rejects(
      () => runtimeProjection(B.company, id),
      (e) => e.code === 'KVVI_RUNTIME_CONTRACT_INCOMPLETE',
      '读到了别家公司的系统')
  })

  test('系统不存在 → 明确的错误码，不是空投影', async () => {
    await assert.rejects(
      () => runtimeProjection(A.company, 'nosuchsystem'),
      (e) => e.code === 'KVVI_RUNTIME_CONTRACT_INCOMPLETE')
  })
})
