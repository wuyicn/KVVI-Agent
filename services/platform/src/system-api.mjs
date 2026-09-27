/**
 * 系统与记录 API 的**适配器**：把 HTTP 输入映射到既有执行点。
 *
 * ── 本模块最大的风险是「顺手再判一次权限」────────────────────────────────
 *
 * 计划的硬性约束是 **Do not duplicate authorization in `system-api.mjs`**。
 * 那不是洁癖：授权判定只有一份（`authorization.mjs` + `policy` 表 + RLS），
 * 在这里再写一遍「这个人能不能改」会得到**第二个判据**，而两份判据迟早分叉 ——
 * 分叉的方向一定是漏判，因为漏判不报错。
 *
 * 所以本模块只做三件事：
 *   1. HTTP 输入 → 执行点的入参（含类型与形状的粗筛）；
 *   2. 执行点的稳定错误码 / 空结果 → HTTP 状态；
 *   3. 从**会话**取身份（`ctx`），绝不从请求体或 query 取。
 *
 * 数据可见性由业务库的 RLS 与 `fieldVisibility` 决定 —— 两者都在执行点里，
 * 本模块一行也不碰。
 */

import { pool } from './db.mjs'
import { scopeContext, fieldVisibility, projectFields, canAct } from './authorization.mjs'
import { createRecord, readRecord, listRecords, updateRecord } from './refs.mjs'
import { runtimeProjection } from './runtime-projection.mjs'
import { publishedSystems } from './publish.mjs'
import { idempotencyKeyOf, withIdempotency } from './idempotency.mjs'
import { step, nextActions, submitterOf, WorkflowError } from './workflow.mjs'

/**
 * 把已验证的会话折成执行点要的 `ctx`。
 *
 * ⚠️ **身份只从这里来。** 调用方传的 `companyId` / `gateway` 在入口就被剥掉了，
 * 这里也绝不从 payload 或 query 取它们。
 *
 * ⚠️ 另一个容易踩的点：执行点的**逻辑引用字段名是 `id`，不是 `recordId`**
 * （见 `refs.mjs` 的 `buildHandle`）。传错名字不会「找不到记录」，
 * 而是抛 `KVVI_REF_MALFORMED` —— 报错指向引用格式，看不出是字段名写错了。
 * 本模块最初就写错了，是测试抓到的。
 */
function ctxOf(session) {
  return {
    companyId: session.companyId,
    userId: session.userId,
    gateway: session.gateway,
    sessionId: session.sessionId ?? null,
  }
}

/** 领域错误码 → HTTP 状态。未登记的一律 400（不是 500 —— 那意味着「我们错了」）。 */
const STATUS_OF = Object.freeze({
  KVVI_NO_SUCH_SYSTEM: 404,
  KVVI_NO_SUCH_RECORD: 404,
  KVVI_RUNTIME_CONTRACT_INCOMPLETE: 404,
  KVVI_RUNTIME_FIELD_UNBOUND: 409,
  KVVI_RUNTIME_TRANSITION_DANGLING: 409,
  KVVI_CONTRACT_CONTENT_TAMPERED: 409,
  KVVI_BAD_REQUEST: 400,
  // 流程迁移的拒绝码。它们与 `workflow.mjs` 的抛出一一对应 —— 换名字等于
  // 让界面与 Agent 各认一套，而 G8 的判据正是「两条通道给同样的码」。
  KVVI_UNKNOWN_STATE: 409,
  KVVI_UNKNOWN_ACTION: 409,
  KVVI_TERMINAL_STATE: 409,
  KVVI_NO_TRANSITION: 409,
  KVVI_ACTION_NOT_PERMITTED: 403,
  KVVI_SELF_APPROVAL_FORBIDDEN: 403,
})

const fail = (code, extra = {}) => ({
  status: STATUS_OF[code] ?? 400,
  body: { error: code, ...extra },
})

/**
 * 一个系统的**运行时投影**。
 * @param ctx 会话派生的上下文
 * @param assetId 系统代号
 * @returns {Promise<{status: number, body: object}>}
 */
/**
 * 投影失败 → HTTP 答复。**三个调用点共用这一份**。
 *
 * ⚠️ 投影的 `detail` 是**结构化**的：`{assetId, missing}` / `{assetId, fields}`
 *    / `{assetId, states}`。原样塞进一个 `detail` 字段，它就变成谁也取不到的
 *    嵌套对象 —— 而「逐份报出缺了哪些」正是这条判据**可用的前提**：
 *    补的人得知道补哪一份。所以摊平到顶层。
 *
 * ⚠️ 三个调用点必须共用：阶段十接流程端点时，新写的两处各自写了一遍
 *    `catch (error) { return fail(code, { assetId }) }`，于是**理由又消失了** ——
 *    排查时只看到 `KVVI_RUNTIME_CONTRACT_INCOMPLETE`，看不到缺的是哪一份。
 *    一份实现、三个调用点，是这类「第二处悄悄比第一处差」的唯一解。
 *
 * @param error 投影抛出的错误
 * @param assetId 系统代号
 * @returns `{status, body}`
 */
function projectionFailure(error, assetId) {
  if (error?.message === 'KVVI_CONTRACT_CONTENT_TAMPERED') {
    return fail('KVVI_CONTRACT_CONTENT_TAMPERED', { assetId })
  }
  // ⚠️ **认不出的错误是 500，不是 400。** 与 `admin-api.mjs` 的兜底同一约定：
  //    把「服务端出错了」报成「你的请求不对」，调用方会去改请求（改不好），
  //    而监控里 400 通常不算错误率 —— 「投影整个坏了」于是看起来一切正常。
  //    真因只进日志。
  if (error?.code === undefined) {
    console.error(JSON.stringify({
      event: 'projection-failed', assetId, error: String(error?.message ?? error),
    }))
    return { status: 500, body: { error: 'KVVI_INTERNAL_ERROR', assetId } }
  }
  return {
    status: STATUS_OF[error.code] ?? 500,
    body: { error: error.code, assetId, ...(error?.detail ?? {}) },
  }
}

async function systemRuntime(ctx, assetId) {
  try {
    return { status: 200, body: await runtimeProjection(ctx.companyId, assetId) }
  } catch (error) {
    return projectionFailure(error, assetId)
  }
}

/**
 * 读一条记录，按字段可见性过滤。
 *
 * ⚠️ 传 `null` 给 `readRecord` 的两种情况（不存在 / 无权看）**必须分开**：
 * 执行点对前者返回 `null`，对后者抛 —— 本模块要把它们映射成 404 与 403，
 * 混成一个码等于泄露了「这条记录存在」。
 * @param ctx 上下文
 * @param assetId 系统代号
 * @param recordId 记录
 * @returns {Promise<{status: number, body: object}>}
 */
async function recordGet(ctx, assetId, recordId) {
  if (!await canAct(ctx.companyId, ctx.userId, 'FORM', assetId, 'read')) {
    return { status: 403, body: { error: 'KVVI_NOT_ALLOWED',
      detail: `没有 ${assetId} 的 read 动作权限` } }
  }
  const scope = await scopeContext(ctx)
  const record = await readRecord(ctx, scope, {
    companyId: ctx.companyId, schemaCode: assetId, id: recordId,
  })
  if (record === null) return fail('KVVI_NO_SUCH_RECORD', { recordId })
  const fields = Object.keys(record.data ?? {})
  const visibility = await fieldVisibility(ctx.companyId, ctx.userId, fields)
  return {
    status: 200,
    body: {
      recordId: record.recordId,
      state: record.state,
      recordNo: record.recordNo,
      rowVersion: record.rowVersion,
      // 唯一的字段出口：HIDDEN 不出现，MASKED 出掩码。
      data: projectFields(record.data ?? {}, visibility),
      // 附带可见性，便于界面把 READONLY 渲染成只读而不是隐藏。
      fieldVisibility: visibility,
    },
  }
}

/**
 * 改一条记录。
 *
 * `rowVersion` 是**必填**：不传就退化成「最后写入者获胜」，而那是丢更新。
 * @param ctx 上下文
 * @param assetId 系统代号
 * @param recordId 记录
 * @param payload 请求体（身份字段已在入口剥掉）
 * @returns {Promise<{status: number, body: object}>}
 */
async function recordUpdate(ctx, assetId, recordId, payload) {
  if (typeof payload?.rowVersion !== 'number') {
    return fail('KVVI_BAD_REQUEST', { detail: 'rowVersion 必填（乐观并发）' })
  }
  // ★ 动作授权：这一条是本层**必须做**的判定，不是重复实现。
  //
  // `updateRecord` 只带乐观并发（`row_version`），**不做动作授权** ——
  // 它假定调用方已经判过了。本模块最初漏了这一步，于是**只读用户改了记录
  // 还返回 200**；是测试抓到的。
  //
  // 判据用 `canAct`（唯一判据），本模块只负责在写之前调用它。
  if (!await canAct(ctx.companyId, ctx.userId, 'FORM', assetId, 'update')) {
    return { status: 403, body: { error: 'KVVI_NOT_ALLOWED',
      detail: `没有 ${assetId} 的 update 动作权限` } }
  }

  const scope = await scopeContext(ctx)

  // 先读一次：既用于判定「能不能改这个字段」，也用于把「无权改」与
  // 「记录不存在」分开。读不到就是 404，不往下走。
  const current = await readRecord(ctx, scope, {
    companyId: ctx.companyId, schemaCode: assetId, id: recordId,
  })
  if (current === null) return fail('KVVI_NO_SUCH_RECORD', { recordId })

  // 字段可见性：HIDDEN 与 READONLY **都不接受写入**。
  // 这不是第二份授权 —— 它是**字段级**的约束，`fieldVisibility` 是唯一判据，
  // 本模块只是把它应用到「你要写的这些字段」上。
  const touched = Object.keys(payload.data ?? {})
  const visibility = await fieldVisibility(ctx.companyId, ctx.userId, touched)
  const blocked = touched.filter((f) => {
    const mode = visibility[f] ?? 'HIDDEN'
    return mode === 'HIDDEN' || mode === 'READONLY'
  })
  if (blocked.length > 0) {
    return { status: 403, body: { error: 'KVVI_FIELD_NOT_WRITABLE', fields: blocked } }
  }

  const updated = await updateRecord(ctx, scope,
    { companyId: ctx.companyId, schemaCode: assetId, id: recordId },
    { data: payload.data, rowVersion: payload.rowVersion })
  // `updateRecord` 的 `WHERE` 带 `row_version = $n`；不匹配时**返回 null** ——
  // 那就是并发冲突，不是「没找到」。两者必须分开报。
  if (updated === null) {
    const now = await readRecord(ctx, scope, {
      companyId: ctx.companyId, schemaCode: assetId, id: recordId,
    })
    if (now === null) return fail('KVVI_NO_SUCH_RECORD', { recordId })
    return { status: 409, body: { error: 'KVVI_ROW_VERSION_CONFLICT',
      currentRowVersion: now.rowVersion } }
  }
  return { status: 200, body: { recordId: updated.recordId, rowVersion: updated.rowVersion } }
}

/**
 * 读一个系统的**流程契约**。
 *
 * 投影的六个必需契约里就有 `workflow-spec`，所以这里再取一次不算多花一次
 * 业务判断 —— 而把「这个记录现在能走哪一步」算在客户端意味着
 * 自审批禁令、终态不可写这些规则要在浏览器里再实现一遍。
 * @param ctx 会话派生的上下文
 * @param assetId 系统代号
 * @returns `workflow-spec` 的内容
 */
async function workflowOf(ctx, assetId) {
  const projection = await runtimeProjection(ctx.companyId, assetId)
  return projection.workflows[assetId]
}

/**
 * 一条记录当前**可执行**的流程动作。
 *
 * 只列出**该会话真的有 FLOW 权限**的那些：把没权限的动作也列出来，
 * 界面会画一个按了就 403 的按钮，而那与「这一步不被流程允许」是两件事 ——
 * 用户分不清自己是「不能」还是「不该」。
 * @param ctx 上下文
 * @param assetId 系统代号
 * @param recordId 记录
 * @returns `{status, body}`
 */
async function recordActions(ctx, assetId, recordId) {
  if (!await canAct(ctx.companyId, ctx.userId, 'FORM', assetId, 'read')) {
    return { status: 403, body: { error: 'KVVI_NOT_ALLOWED',
      detail: `没有 ${assetId} 的 read 动作权限` } }
  }
  const scope = await scopeContext(ctx)
  const record = await readRecord(ctx, scope, {
    companyId: ctx.companyId, schemaCode: assetId, id: recordId,
  })
  if (record === null) return fail('KVVI_NO_SUCH_RECORD', { recordId })

  let workflow
  try {
    workflow = await workflowOf(ctx, assetId)
  } catch (error) {
    return projectionFailure(error, assetId)
  }
  const candidates = nextActions(workflow, record.state)
  const granted = []
  for (const candidate of candidates) {
    // ⚠️ 逐条判权限（`canAct` 是唯一判据），不在本层另立规则。
    if (await canAct(ctx.companyId, ctx.userId, 'FLOW', workflow.workflow_code ?? '*',
      candidate.action)) granted.push(candidate)
  }
  return { status: 200, body: { recordId, state: record.state, actions: granted } }
}

/**
 * 执行一步流程迁移。
 *
 * `rowVersion` 与记录更新一样是**必填**：流程迁移会改 `state`，而「最后写入者
 * 获胜」在流程上比在字段上更坏 —— 一个已经批过的单子会被另一条路径重新推回待审批。
 * @param ctx 上下文
 * @param assetId 系统代号
 * @param recordId 记录
 * @param payload 请求体（身份字段已在入口剥掉）
 * @returns `{status, body}`
 */
async function recordTransition(ctx, assetId, recordId, payload) {
  const action = payload?.action
  if (typeof action !== 'string' || action === '') {
    return fail('KVVI_BAD_REQUEST', { detail: 'action 必填' })
  }
  if (typeof payload?.rowVersion !== 'number') {
    return fail('KVVI_BAD_REQUEST', { detail: 'rowVersion 必填（乐观并发）' })
  }
  if (!await canAct(ctx.companyId, ctx.userId, 'FORM', assetId, 'read')) {
    return { status: 403, body: { error: 'KVVI_NOT_ALLOWED',
      detail: `没有 ${assetId} 的 read 动作权限` } }
  }
  const scope = await scopeContext(ctx)
  const record = await readRecord(ctx, scope, {
    companyId: ctx.companyId, schemaCode: assetId, id: recordId,
  })
  if (record === null) return fail('KVVI_NO_SUCH_RECORD', { recordId })

  let workflow
  try {
    workflow = await workflowOf(ctx, assetId)
  } catch (error) {
    return projectionFailure(error, assetId)
  }

  // 自审批禁令要的提交人：执行点的 `submitterOf` 是唯一来源，本层不猜。
  const submitterUserId = await submitterOf(recordId)
  try {
    const result = await step({
      ctx, spec: workflow, recordId, from: record.state, action, submitterUserId,
      applyTransition: async ({ toState }) => {
        // 状态写回**带版本号**：迁移与并发写走同一条乐观并发，
        // 不这么做的话两条路径互相覆盖且都不报错。
        const updated = await updateRecord(ctx, scope, {
          companyId: ctx.companyId, schemaCode: assetId, id: recordId,
        }, { state: toState, rowVersion: payload.rowVersion })
        if (updated === null) throw new WorkflowError('KVVI_ROW_VERSION_CONFLICT')
        return updated
      },
    })
    return { status: 200, body: {
      recordId, from: result.from, state: result.to, rowVersion: result.applied.rowVersion,
    } }
  } catch (error) {
    if (error instanceof WorkflowError) return fail(error.code, error.detail)
    throw error
  }
}

/** 列一个系统的记录（行范围由 RLS 决定，本模块不做行过滤）。 */
async function recordList(ctx, assetId) {
  if (!await canAct(ctx.companyId, ctx.userId, 'FORM', assetId, 'read')) {
    return { status: 403, body: { error: 'KVVI_NOT_ALLOWED',
      detail: `没有 ${assetId} 的 read 动作权限` } }
  }
  const scope = await scopeContext(ctx)
  const rows = await listRecords(scope, assetId, { limit: 50 })
  const fields = [...new Set(rows.flatMap((r) => Object.keys(r.data ?? {})))]
  const visibility = await fieldVisibility(ctx.companyId, ctx.userId, fields)
  return { status: 200, body: {
    items: rows.map((r) => ({
      recordId: r.recordId, state: r.state, recordNo: r.recordNo,
      rowVersion: r.rowVersion, data: projectFields(r.data ?? {}, visibility),
    })),
    fieldVisibility: visibility,
  } }
}

/**
 * 分派 `/api/v1/*` 的产品路由。
 *
 * @param {object} input
 * @param {string} input.method 请求方法
 * @param {string} input.path 去掉 `/api/v1` 之后的路径（以 `/` 开头）
 * @param {object} input.payload 已剥掉身份字段的请求体
 * @param {object} input.session 已验证的会话
 * @returns {Promise<{status: number, body: object}>}
 */
export async function systemRoutes({ method, path, payload, session, headers = {} }) {
  const ctx = ctxOf(session)
  const parts = path.split('/').filter((p) => p !== '')

  // GET /systems
  if (method === 'GET' && parts.length === 1 && parts[0] === 'systems') {
    const items = await publishedSystems(ctx.companyId)
    return { status: 200, body: { items, companyId: ctx.companyId } }
  }

  // /systems/:assetId/...
  if (parts[0] === 'systems' && parts.length >= 2) {
    const assetId = decodeURIComponent(parts[1])

    if (method === 'GET' && parts.length === 3 && parts[2] === 'runtime') {
      return systemRuntime(ctx, assetId)
    }

    if (parts.length === 3 && parts[2] === 'records') {
      if (method === 'GET') return recordList(ctx, assetId)
      if (method === 'POST') {
        if (!await canAct(ctx.companyId, ctx.userId, 'FORM', assetId, 'create')) {
          return { status: 403, body: { error: 'KVVI_NOT_ALLOWED',
            detail: `没有 ${assetId} 的 create 动作权限` } }
        }
        // ★ **建记录带幂等键。**
        //
        // 这是最容易重复发一次的那个动作：请求出去了、响应没回来、连接断了，
        // 重连之后客户端**不知道那一次到底成没成**。在此之前，
        // 「重连不重放」靠的是客户端不自动重试 —— 一个约定，不是判据
        // （验收的第 ⑤ 条量出过：同一条请求打三次，建出三条不同的记录）。
        const key = idempotencyKeyOf(headers)
        return await withIdempotency({
          ctx, endpoint: `POST /systems/${assetId}/records`, key,
          run: async () => {
            const scope = await scopeContext(ctx)
            const created = await createRecord(ctx, scope, {
              schemaCode: assetId, data: payload?.data ?? {},
            })
            return { status: 201, body: created }
          },
        })
      }
    }

    if (parts.length === 4 && parts[2] === 'records') {
      const recordId = decodeURIComponent(parts[3])
      if (method === 'GET') return recordGet(ctx, assetId, recordId)
      if (method === 'PATCH') return recordUpdate(ctx, assetId, recordId, payload)
    }

    // 流程：可执行的动作，以及执行一步。两条都是「记录级」的，
    // 路径挂在记录下面而不是另开一段 —— 流程不属于系统，属于某一张单子。
    if (parts.length === 5 && parts[2] === 'records') {
      const recordId = decodeURIComponent(parts[3])
      if (parts[4] === 'actions' && method === 'GET') return recordActions(ctx, assetId, recordId)
      if (parts[4] === 'transitions' && method === 'POST') {
        return recordTransition(ctx, assetId, recordId, payload)
      }
    }
  }

  return {
    status: 404,
    body: { error: 'KVVI_UNKNOWN_ROUTE', route: path, method,
            session: { userId: ctx.userId, companyId: ctx.companyId, gateway: ctx.gateway } },
  }
}

export { pool }
