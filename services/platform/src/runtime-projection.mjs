/**
 * 已发布契约 → **闭合的运行时投影**。
 *
 * ── 它做什么 ──────────────────────────────────────────────────────────────
 *
 * 把一次发布里的多份契约（业务模型、视图、流程、权限、工具、命令）
 * 合成一个**只含已发布、指纹校验过、跨契约自洽**的投影，交给运行时渲染与执行。
 *
 * ── 它不做什么（比做什么更重要）──────────────────────────────────────────
 *
 * | 不做 | 为什么 |
 * |---|---|
 * | **不校验契约是否符合 MetaSchema** | 那是官方验证器的事（`tools/meta-schema`）。在这里再判一遍就是第二份判据，会分叉 |
 * | **不发明缺省值** | 缺 `permission-spec` 时若把 `policies` 当空数组继续，结果是「没有策略 = 不限制」，也就是**全开放** |
 * | **不做数据权限判定** | 那在唯一执行点（`commands.mjs`）。投影只给「有哪些字段、哪些状态、哪些策略」 |
 * | **不校验组件名** | 生产组件注册表还不存在（N11），只有测试 fixture。见下面的「已知未做」 |
 *
 * ── 失败方向是本模块的考点 ────────────────────────────────────────────────
 *
 * 一个「缺了就跳过」的实现在任何 happy path 上都看不出问题 ——
 * 它会一直到生产环境里某次少发一份契约才暴露。所以本模块**只失败关闭**：
 * 缺契约、指纹不符、字段未绑定、状态对不上，一律抛错，不给回退。
 *
 * ── 已知未做（不写成「已做」）────────────────────────────────────────────
 *
 * 计划的 Review Focus 还要求「每个渲染用到的组件都存在于**生产组件注册表**」。
 * 那份注册表目前是 N11 未关闭项 —— 仓库里只有测试 fixture（23 个组件，无图表）。
 * 本层因此**只做字段与状态的跨契约绑定检查**。
 * 拿 fixture 当生产注册表来「校验通过」，等于用一个测试装置给产品盖章。
 */

import { createHash } from 'node:crypto'
import { pool } from './db.mjs'
import { contractsOfSystem } from './contracts.mjs'

/**
 * 一个可运行系统**必需**的契约。
 *
 * 名单不是拍出来的：它逐条对应补充需求 §7.1 的「系统产物」清单。
 * 少一份就说明那次发布不构成一个可运行系统 —— 而**不是**「少一份就先跑着」。
 */
export const REQUIRED_CONTRACTS = Object.freeze([
  'business-schema',
  'view-schema',
  'workflow-spec',
  'permission-spec',
  'tool-spec',
  'app-model-command',
])

/** 领域错误码。带 `code` 便于 API 层映射成 HTTP 状态，不靠解析 message。 */
class ProjectionError extends Error {
  constructor(code, detail = {}) {
    super(code)
    this.name = 'ProjectionError'
    this.code = code
    this.detail = detail
  }
}

/** 键排序后的内容指纹。与 `contracts.mjs` 同算法 —— 换算法会让比对失去意义。 */
function digestOf(value) {
  const canonical = (v) => {
    if (Array.isArray(v)) return v.map(canonical)
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]))
    }
    return v
  }
  return 'sha256:' + createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}

/**
 * 递归收集视图里所有的字段引用。
 *
 * 判据是 `{type: 'FieldRef', fieldRef: '…'}` 这个形状 —— 它来自 `view-schema`
 * 的 `FieldRef` 定义，不是猜的。嵌套在 `props` 里也要收到，所以按深度遍历。
 * @param value 任意 JSON 值
 * @returns {string[]} 字段名（可能重复）
 */
function collectFieldRefs(value) {
  const out = []
  const walk = (v) => {
    if (Array.isArray(v)) { for (const x of v) walk(x); return }
    if (v === null || typeof v !== 'object') return
    if (v.type === 'FieldRef' && typeof v.fieldRef === 'string') out.push(v.fieldRef)
    for (const x of Object.values(v)) walk(x)
  }
  walk(value)
  return out
}

/**
 * 把状态数组折成「状态码 → 状态」的表。
 * @param spec 流程定义
 * @returns {Record<string, object>}
 */
function statesOf(spec) {
  const out = {}
  for (const s of (spec?.states ?? [])) {
    if (typeof s?.state_code === 'string') out[s.state_code] = s
  }
  return out
}

/**
 * 编译一个已发布系统的运行时投影。
 *
 * @param {string} companyId 会话绑定的公司
 * @param {string} assetId 系统代号
 * @returns {Promise<{system: object, models: object, views: object,
 *   workflows: object, permissions: object, tools: object, commands: object}>}
 *   其中 `workflows[assetId].states` 保持**契约的数组形状**，派生查表在 `stateLabels`。
 * @throws {Error} `code === 'KVVI_RUNTIME_CONTRACT_INCOMPLETE'` 缺契约或系统不存在；
 *   `code === 'KVVI_RUNTIME_FIELD_UNBOUND'` 视图引用了模型里没有的字段；
 *   `message === 'KVVI_CONTRACT_CONTENT_TAMPERED'` 内容指纹不符
 */
export async function runtimeProjection(companyId, assetId) {
  // ① 系统本身要在。不在就与「契约不全」同一类结果：
  //    两者对调用方的含义都是「这个系统现在不能跑」。
  const sys = await pool('platform').query(
    `SELECT system_id, asset_id, name, schema_code, published_at
       FROM systems WHERE company_id = $1 AND asset_id = $2`, [companyId, assetId])
  if (sys.rows.length !== 1) {
    throw new ProjectionError('KVVI_RUNTIME_CONTRACT_INCOMPLETE',
      { reason: 'system-not-found', assetId })
  }
  const system = {
    systemId: sys.rows[0].system_id,
    assetId: sys.rows[0].asset_id,
    name: sys.rows[0].name,
    schemaCode: sys.rows[0].schema_code,
    publishedAt: sys.rows[0].published_at,
  }

  // ② 取该系统的全部生效契约。
  //    `contractsOfSystem` 已经在读的时候**重算指纹**，不符即抛 ——
  //    所以「内容被改过」在产出任何东西之前就检出。
  const all = await contractsOfSystem(companyId, assetId)

  // ③ 必需的六份一个都不能少。**逐份报出缺了哪些**，
  //    而不是只说一句「不完整」—— 补的人需要知道补哪一份。
  const missing = REQUIRED_CONTRACTS.filter((t) => all[t] === undefined)
  if (missing.length > 0) {
    throw new ProjectionError('KVVI_RUNTIME_CONTRACT_INCOMPLETE', { assetId, missing })
  }

  // ④ 逐类取出内容。用 `all[t].content`，不传引用对象 ——
  //    投影的消费者只该看到契约内容本身。
  const model = all['business-schema'].content
  const view = all['view-schema'].content
  const workflow = all['workflow-spec'].content
  const permission = all['permission-spec'].content
  const tool = all['tool-spec'].content
  const command = all['app-model-command'].content

  // ⑤ 跨契约绑定：视图引用的字段必须在模型里存在。
  //
  //    这是本层唯一能做的跨契约检查（组件名校验等生产注册表，见模块头）。
  //    它挡掉的失效模式是真的：界面上一个永远填不上的字段，
  //    点提交时才发现 —— 而那时用户已经填完了别的。
  const declared = new Set((model?.fields ?? [])
    .map((f) => f?.field_code).filter((c) => typeof c === 'string'))
  const refs = [...new Set(collectFieldRefs(view?.componentsTree))]
  const unbound = refs.filter((f) => !declared.has(f))
  if (unbound.length > 0) {
    throw new ProjectionError('KVVI_RUNTIME_FIELD_UNBOUND', { assetId, fields: unbound })
  }

  // ⑥ 流程状态与迁移：状态引用必须自洽。
  //    这里只做**投影内部**的自洽（迁移端点都在状态表里）；
  //    「状态是否属于该模型」需要模型声明状态字段，而当前契约里没有这一层，
  //    所以不做 —— 不做一个判据未定义的检查，比做一个猜的好。
  const states = statesOf(workflow)
  const dangling = []
  for (const t of (workflow?.transitions ?? [])) {
    if (states[t?.from_state] === undefined) dangling.push(t?.from_state)
    if (states[t?.to_state] === undefined) dangling.push(t?.to_state)
  }
  if (dangling.length > 0) {
    throw new ProjectionError('KVVI_RUNTIME_TRANSITION_DANGLING',
      { assetId, states: [...new Set(dangling)] })
  }

  return {
    system,
    models: { [assetId]: model },
    views: { [assetId]: view },
    // ⚠️ **不改写契约里的 `states`。** 它是数组（契约的形状），
    //    而流程运行时 `workflow.mjs` 正是按数组读的 —— 投影把它折成对象时，
    //    「这一个系统的状态表」就有了两个形状，两条读取路径迟早分叉。
    //    真实发生过：阶段十接流程端点时 `loadSpec` 撞上 `spec.states.map is not a function`。
    //    派生出来的查表放在 `stateLabels` 里，名字说明它是**派生**的。
    workflows: { [assetId]: { ...workflow, stateLabels: states } },
    permissions: { [assetId]: permission },
    tools: { [assetId]: tool },
    commands: { [assetId]: command },
    // 投影自证：调用方可以核对自己拿到的是哪一版。
    digest: digestOf({
      model, view, workflow, permission, tool, command,
    }),
  }
}
