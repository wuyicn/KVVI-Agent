/**
 * 唯一服务端策略执行点（PRD §9.2、§9.3、§9.6.4.1、§9.7.2/§9.7.3）。
 *
 * ── 本模块存在的理由 ────────────────────────────────────────────────────
 *
 * §9.2 的缺陷原述是：「UI 与 Agent 依据同一份契约」**不等于**「运行时走同一段授权代码」。
 * 所以 UI 与 Agent 必须**调用同一个业务命令端点**，由服务端统一执行全部校验。
 *
 * 本模块就是那一段代码。UI 路径与 Agent 路径**没有第二个入口** ——
 * 差分测试（锚点①）构造「UI 会拒绝的请求」，经 Agent 路径重放，
 * 之所以能保证同码拒绝，是因为两条路径**根本没有分叉**。
 *
 * ── 校验顺序是设计的一部分 ──────────────────────────────────────────────
 *
 * ```
 *   0. 调用方不得提供身份字段（§9.3.1）
 *   1. 基础授权：动词权限 → 状态机 → 字段策略 → 数据范围   ← 不可被审批替代
 *   2. 风险分级（§9.6.4.1 封闭清单）→ R3 需要所有者审批
 *   3. 执行前确认（§9.7.2）→ 未确认只产生草稿
 *   4. 执行 + 留痕
 * ```
 *
 * **第 1 步在第 2 步之前**，这不是排版：
 * §9.6.4.1 明确「审批是基础校验**之上**的额外防护，**不能替代**基础授权」。
 * 反过来的顺序会让「员工访问范围外记录 + 所有者已批准」变成成功。
 */
import { createHash } from 'node:crypto'
import { append } from './audit.mjs'
import { fieldVisibility, projectFields, resolveTransition, canAct } from './authorization.mjs'
import { readRecord, updateRecord, createRecord, buildHandle } from './refs.mjs'
import {assertRecordEditable,RecordStateError,recordData} from './record-state.mjs'

/**
 * 风险分级：**封闭清单**（§9.6.4.1）。
 *
 * ⚠️ 封闭是刻意的：「开放清单会让『哪些动作要审批』变成实现者的自由裁量，
 * 既无法测试，也无法审计。」所以这里是一张表，不是一个可扩展的注册表。
 *
 * 三条 R3 是**请求的属性**而不是动作名 —— 批量、跨业务分组、超阈值，
 * 同一个 `record.update` 既可能是 R1 也可能是 R3。
 */
export const R1 = 'R1'
export const R2 = 'R2'
export const R3 = 'R3'

/** R3 的阈值**由系统定义**（§9.6.4.1），不由模型决定，也不由请求携带。 */
export const AMOUNT_THRESHOLD = process.env.KVVI_R3_AMOUNT_THRESHOLD ?? '50000.00'

/** 需要执行前确认的动作（§9.7.2）。R2/R3 与终态动作都在里面。 */
const IRREVERSIBLE = new Set(['record.finalize', 'record.delete', 'record.batch'])

export class CommandError extends Error {
  /**
   * @param {string} code 机器可读的错误码
   * @param {string} category §9.4.5 的错误类别（可诊断）
   * @param {object} extra 附加上下文（如双方版本码）
   */
  constructor(code, category = 'POLICY', extra = {}) {
    super(code)
    this.code = code
    this.category = category
    this.extra = extra
  }
}

/**
 * 第 0 步：调用方**不得**提供身份字段（§9.3.1、§9.2 硬性要求 2）。
 *
 * 模型与工具参数无权提供 actor/role/tenant —— 它们只能由服务端从令牌导出。
 * 出现即拒绝，**并告警**（§9.4.1 负向测试里点名了这一条）。
 * @param {object} body 请求体
 * @returns {string[]} 出现的禁止字段
 */
export function detectCallerIdentityFields(body) {
  const found = new Set()
  const walk = (node, path) => {
    if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${path}[${i}]`))
    if (node === null || typeof node !== 'object') return
    for (const [key, value] of Object.entries(node)) {
      if (['sub', 'sid', 'ten', 'tenant', 'tenantId', 'companyId', 'company_id',
           'actor', 'actorId', 'role', 'roles', 'av', 'authzVersion',
           'iss', 'jti'].includes(key)) {
        found.add(path === '' ? key : `${path}.${key}`)
      }
      walk(value, path === '' ? key : `${path}.${key}`)
    }
  }
  walk(body, '')
  return [...found].sort()
}

/**
 * 风险分级（§9.6.4.1）。返回级别与**命中的理由**。
 *
 * 「跨数据范围」的准确含义（v2.15 终审重要 3）：
 * **不是**超出执行账号的授权范围（那属基础授权，必须直接拒绝），
 * 而是**在授权范围之内、跨多个业务分组**的操作。
 * 所以判定看的是「本次请求是否跨了多个分组」，不是「是否越权」。
 * @param {object} input 入参
 * @returns {{level: string, reasons: string[]}}
 */
export function classifyRisk({ action, targets = [], amount = null, terminal = false }) {
  const reasons = []

  if (targets.length > 1) reasons.push('BATCH')

  const groups = new Set(targets.map((t) => `${t.deptId ?? ''}|${t.shopId ?? ''}`))
  if (groups.size > 1) reasons.push('CROSS_BUSINESS_GROUP')

  if (amount !== null && compareDecimal(amount, AMOUNT_THRESHOLD) > 0) {
    reasons.push('OVER_AMOUNT_THRESHOLD')
  }

  if (reasons.length > 0) return { level: R3, reasons }

  if (action === 'record.delete' || terminal) return { level: R2, reasons: ['TERMINAL_OR_DELETE'] }
  return { level: R1, reasons: [] }
}

/** 十进制字符串比较（不引入浮点 —— 与 0B-8 同一纪律）。 */
function compareDecimal(a, b) {
  const toUnits = (s) => {
    const [i, f = ''] = String(s).split('.')
    return BigInt(`${i}${f.padEnd(2, '0').slice(0, 2)}`)
  }
  const x = toUnits(a)
  const y = toUnits(b)
  return x === y ? 0 : x < y ? -1 : 1
}

/** 请求摘要：审批要绑定到「被出示的那一份」。 */
export function requestDigest(request) {
  return createHash('sha256')
    .update(JSON.stringify({ action: request.action, targets: request.targets,
                             patch: request.patch ?? null, amount: request.amount ?? null }))
    .digest('hex')
}

/**
 * 唯一执行点。
 *
 * @param {object} input 入参
 * @param {object} input.ctx 身份上下文（**只能来自令牌**）
 * @param {object} input.scope 授权上下文
 * @param {object} input.request 业务请求 `{action, targets, patch, confirmed, amount}`
 * @param {object|null} input.approval R3 的所有者审批 `{digest, approverId}`
 * @param {object[]} input.transitions 状态机迁移表
 * @returns {Promise<object>} 执行结果
 */
export async function execute({ ctx, scope, request, approval = null, transitions = [] }) {
  const auditBase = {
    companyId: ctx.companyId, actorKind: 'USER', actorId: ctx.userId,
    gateway: ctx.gateway, sessionId: ctx.sessionId,
    action: request.action, resourceKind: 'record',
    resourceId: request.targets?.[0]?.id ?? null,
  }

  // ── 第 0 步：调用方不得提供身份字段（§9.3.1）────────────────────
  // 由端点负责在解析请求体时调用 detectCallerIdentityFields；
  // 到这里的 request 已经过它。此处再断言一次，防止绕过端点直接调本函数。
  const forbidden = detectCallerIdentityFields(request)
  if (forbidden.length > 0) {
    await append({ ...auditBase, outcome: 'DENY',
                   reason: `KVVI_CALLER_SUPPLIED_IDENTITY:${forbidden.join(',')}` })
    throw new CommandError('KVVI_CALLER_SUPPLIED_IDENTITY', 'POLICY', { fields: forbidden })
  }

  recordData(request.patch?.data)

  // ── 第 1 步：基础授权（**不可被审批替代**）──────────────────────
  const loaded = []
  for (const target of request.targets ?? []) {
    const record = await readRecord(ctx, scope, { kind: 'record', id: target.id })
    if (record === null) {
      // §9.3「零行命中统一返回 404」：不区分「不存在」与「无权限」，
      // 否则可以被用来枚举记录是否存在。
      await append({ ...auditBase, outcome: 'DENY', reason: 'KVVI_RECORD_NOT_FOUND' })
      throw new CommandError('KVVI_RECORD_NOT_FOUND', 'NOT_FOUND')
    }
    loaded.push(record)
  }

  // 字段策略：**服务端**过滤，不看请求里写了什么（§9.2 硬性要求 1）
  if (request.patch && loaded.length > 0) {
    const fields = Object.keys(request.patch.data ?? {})
    const visibility = await fieldVisibility(ctx.companyId, ctx.userId, fields)
    // 可写 ⟺ `VISIBLE`。**HIDDEN / MASKED / READONLY 都不可写**：
    //   · HIDDEN   —— 用户根本看不见这个字段；
    //   · MASKED   —— patch 是**部分合并**，写一个看不见的字段等于盲写覆盖；
    //   · READONLY —— 名字就写着只读。
    // 这是 fail-closed 的读法：宁可少让人写，不可让人写了自己看不见的东西。
    const denied = fields.filter((f) => visibility[f] !== 'VISIBLE')
    if (denied.length > 0) {
      await append({ ...auditBase, outcome: 'DENY',
                     reason: `KVVI_FIELD_NOT_WRITABLE:${denied.join(',')}` })
      throw new CommandError('KVVI_FIELD_NOT_WRITABLE', 'POLICY', { fields: denied })
    }
  }

  // 动作权限 + 状态机
  for (const record of loaded) {
    const permitted = await canAct(ctx.companyId, ctx.userId, 'FORM',
      record.schemaCode, request.action.replace(/^record\./u, ''))
    if (!permitted) {
      await append({ ...auditBase, outcome: 'DENY', reason: 'KVVI_ACTION_NOT_PERMITTED' })
      throw new CommandError('KVVI_ACTION_NOT_PERMITTED', 'POLICY')
    }
    if (request.action === 'record.finalize' || request.toState) {
      const verdict = resolveTransition(transitions, record.state,
        request.patch?.state ?? request.action)
      if (!verdict.allowed) {
        await append({ ...auditBase, outcome: 'DENY', reason: verdict.reason })
        throw new CommandError(verdict.reason, 'POLICY', { from: record.state })
      }
    }
    try {await assertRecordEditable(ctx,record,{data:request.patch?.data,toState:request.patch?.state})}
    catch(error){
      if(!(error instanceof RecordStateError))throw error
      await append({...auditBase,outcome:'DENY',reason:error.code,resourceId:record.recordId})
      throw error
    }
  }

  // ── 第 2 步：风险分级（§9.6.4.1）───────────────────────────────
  const risk = classifyRisk({
    action: request.action,
    targets: loaded.map((r) => ({ deptId: r.deptId, shopId: r.shopId })),
    amount: request.amount ?? null,
    terminal: loaded.some((r) => r.state === 'approved' || r.state === 'rejected'),
  })

  if (risk.level === R3) {
    const digest = requestDigest(request)
    if (!approval || approval.digest !== digest) {
      await append({ ...auditBase, outcome: 'DENY',
                     reason: `KVVI_OWNER_APPROVAL_REQUIRED:${risk.reasons.join(',')}` })
      throw new CommandError('KVVI_OWNER_APPROVAL_REQUIRED', 'RISK',
        { reasons: risk.reasons, digest })
    }
    // ⚠️ 审批**只解除 R3 的额外要求**。基础授权已经在上面执行过 ——
    // 走到这里就说明基础授权是通过的。
  }

  // ── 第 3 步：执行前确认（§9.7.2 / §9.7.3）─────────────────────
  // 不可逆动作必须有确认；未确认时**只落草稿**，不做任何不可逆改变。
  if (IRREVERSIBLE.has(request.action) && request.confirmed !== true) {
    for (const record of loaded) {
      await append({ ...auditBase, action: request.action, outcome: 'ALLOW',
                     reason: 'KVVI_UNCONFIRMED_DRAFT_ONLY', resourceId: record.recordId })
    }
    return { status: 'DRAFT_ONLY', risk: risk.level, reasons: risk.reasons,
             requiresConfirmation: true, changed: false }
  }

  // ── 第 4 步：执行 ──────────────────────────────────────────────
  const results = []
  for (const record of loaded) {
    const updated = await updateRecord(ctx, scope,
      { kind: 'record', id: record.recordId },
      { data: request.patch?.data ?? {}, state: request.patch?.state ?? null,
        rowVersion: record.rowVersion })
    results.push({ recordId: record.recordId, updated })
    await append({ ...auditBase, outcome: 'ALLOW', resourceId: record.recordId,
                   paramsDigest: createHash('sha256')
                     .update(JSON.stringify(request.patch ?? {})).digest('hex') })
  }
  return { status: 'OK', risk: risk.level, reasons: risk.reasons, results }
}

/** 只读投影：**字段策略在这里生效**，隐藏字段根本不出现在返回里。 */
export async function project(record, visibility) {
  return { ...record, data: projectFields(record.data ?? {}, visibility) }
}

export { buildHandle, createRecord }
