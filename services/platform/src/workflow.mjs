/**
 * 审批流的**运行时**执行器（N20，PRD §5.2「流程操作」、0B-7、`0C-4`）。
 *
 * ── 契约层已经有了，缺的是执行 ──────────────────────────────────────────
 *
 * `workflow-spec` 的 Spec 早已通过校验（状态、动作、迁移）。但「发起 → 通过/驳回」
 * 真正跑起来，需要有人按契约执行迁移。本模块就是那个人。
 *
 * ── 三条不能让步的规则 ──────────────────────────────────────────────────
 *
 * 1. **终态不可写**：`approved` / `rejected`（terminal）上没有任何迁移 ——
 *    不是「没定义所以拒绝」，是**定义里就不该有**。
 * 2. **当前状态下未定义的动作即拒**：契约里没写的事不做，包括「顺理成章的下一步」。
 * 3. **审批人不能是提交人**：§9.6.1 的自审批禁令在流程层同样成立 ——
 *    一个人发起、一个人批准，这是审批流存在的全部理由。
 *
 * ── 它不做的事 ──────────────────────────────────────────────────────────
 *
 * 不发明迁移、不做审批人解析（那是 `approverRef` 的事）、不碰数据范围
 * （那在唯一执行点里，`commands.mjs`）。本模块只做「这一步合不合法」。
 */
import { pool } from './db.mjs'
import { append, appendDenial } from './audit.mjs'
import { resolveTransition, canAct } from './authorization.mjs'

export class WorkflowError extends Error {
  constructor(code, detail = {}) {
    super(code)
    this.code = code
    this.detail = detail
  }
}

/** 从契约的 Spec 里取状态与迁移。**契约是唯一来源**，不另存一份。 */
export function loadSpec(spec) {
  const states = new Map((spec.states ?? []).map((s) => [s.state_code, s]))
  const actions = new Map((spec.actions ?? []).map((a) => [a.action_code, a]))
  return { states, actions, transitions: spec.transitions ?? [] }
}

/**
 * 一个业务动作的**类别**（`kind`）。
 *
 * 判权限用的是它，不是 `action_code` —— 见 `authorization.canAct()` 的注释：
 * `permission-spec` 的 FLOW `actions` 是闭枚举的**类别**，而 `action_code`
 * 是搭建者起的业务名。两者混用过的后果是「策略里写 SUBMIT、运行时拿
 * start_follow 去比」→ 永远不匹配 → 员工被拒。
 *
 * @param {object} spec `workflow-spec` 的 Spec
 * @param {string} actionCode 业务动作名
 * @returns {string|null} 类别；契约里没这个动作时为 null
 */
export function kindOf(spec, actionCode) {
  return loadSpec(spec).actions.get(actionCode)?.kind ?? null
}

/**
 * 判定一步迁移是否合法（**纯函数**，不碰数据库）。
 * @param {object} spec `workflow-spec` 的 Spec
 * @param {object} input `{from, action, actorUserId, submitterUserId, hasFlowPermission}`
 * @returns {{allowed: boolean, toState?: string, reason?: string}}
 */
export function judgeTransition(spec, input) {
  const { states, actions, transitions } = loadSpec(spec)
  const state = states.get(input.from)
  if (!state) return { allowed: false, reason: 'KVVI_UNKNOWN_STATE' }
  if (!actions.has(input.action)) return { allowed: false, reason: 'KVVI_UNKNOWN_ACTION' }

  // ① 终态不可写
  if (state.terminal) return { allowed: false, reason: 'KVVI_TERMINAL_STATE' }

  // ② 当前状态下未定义的动作
  const verdict = resolveTransition(transitions, input.from, input.action)
  if (!verdict.allowed) return { allowed: false, reason: verdict.reason }

  // ③ 流程动作权限（0B-7）
  if (input.hasFlowPermission === false) {
    return { allowed: false, reason: 'KVVI_ACTION_NOT_PERMITTED' }
  }

  // ④ 自审批：**审批类动作**的批准人不能是提交人
  const kind = actions.get(input.action).kind
  if (kind === 'APPROVE' || kind === 'REJECT') {
    if (input.submitterUserId && input.actorUserId === input.submitterUserId) {
      return { allowed: false, reason: 'KVVI_SELF_APPROVAL_FORBIDDEN' }
    }
  }
  return { allowed: true, toState: verdict.toState, kind }
}

/**
 * 执行一步迁移：判定 → 写状态 → 留痕。
 *
 * 状态写在哪由 `applyTransition` 决定（记录在业务库、会话在平台库）。
 * 本模块不猜存储位置 —— 猜错的代价是「迁移报告成功但没落库」。
 * @param {object} input 入参
 * @returns {Promise<object>} 结论
 */
export async function step({ ctx, spec, assetId, recordId, from, action,
                             submitterUserId = null, applyTransition }) {
  // ⚠️ **资源是业务对象，动作是类别，外加当前状态。** 三者此前都取错过：
  //    资源取 `spec.workflow_code ?? '*'`（契约里根本没有 `workflow_code`，
  //    于是恒为 `'*'`，而策略的 resource_code 是业务对象）、动作取 action_code、
  //    状态则根本没有这一维。三个一起错，结果是**任何流程动作都被拒**。
  //    流程没有独立身份 —— 它就是业务对象的一个开关（这一点见
  //    `sql-manifest` 之外的设计说明与氚云的同一约定）。
  const kind = kindOf(spec, action)
  const perm = kind === null
    // 契约里没有这个动作：让 `judgeTransition` 按 UNKNOWN_ACTION 拒，
    // 而不是在这里先报成「没权限」—— 那两种情况的处置完全不同。
    ? undefined
    : await canAct(ctx.companyId, ctx.userId, 'FLOW', assetId, kind, { state: from })
  const verdict = judgeTransition(spec, {
    from, action, actorUserId: ctx.userId, submitterUserId,
    hasFlowPermission: perm,
  })

  const auditBase = {
    companyId: ctx.companyId, actorKind: 'AGENT', actorId: ctx.userId,
    gateway: ctx.gateway, sessionId: ctx.sessionId,
    action: `flow.${action}`, resourceKind: 'record', resourceId: recordId,
  }

  if (!verdict.allowed) {
    await appendDenial({ ...auditBase, reason: verdict.reason })
    throw new WorkflowError(verdict.reason, { from, action })
  }

  const applied = await applyTransition({ toState: verdict.toState, action })
  await append({ ...auditBase, outcome: 'ALLOW',
                 paramsDigest: `${from}->${verdict.toState}` })
  return { ok: true, from, to: verdict.toState, applied }
}

/** 可执行的下一步（给界面用）：当前状态下**合法**的动作清单。 */
export function nextActions(spec, from) {
  const { states, actions, transitions } = loadSpec(spec)
  const state = states.get(from)
  if (!state || state.terminal) return []
  return transitions.filter((t) => t.from_state === from).map((t) => ({
    // `action` 是**给调用方回传**的业务名（`POST /transitions` 收的就是它）；
    // `kind` 是**判权限用**的类别。两个都给出，调用方不必自己去翻契约。
    action: t.action_code,
    kind: actions.get(t.action_code)?.kind ?? null,
    to: t.to_state, transition: t.transition_code,
  }))
}

/** 提交人查询（自审批判定要用）。 */
export async function submitterOf(recordId) {
  const { rows } = await pool('business').query(
    'SELECT owner_id FROM business_records WHERE record_id = $1', [recordId])
  return rows[0]?.owner_id ?? null
}
