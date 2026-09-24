/**
 * 授权判定：五档数据范围、表单/字段/流程权限、双网关工具分类。
 * （PRD §2.5.1、§9.6.5、§9.9.2、0B-4/5/6/7）
 *
 * ── 本模块最容易做错的一条 ──────────────────────────────────────────────
 *
 * **数据范围必须按「实际可访问集合」判定，不得按档位编号比较。**
 * §2.5.1 明确：店铺与部门的包含关系**未规定**，二者**可能交叉**。
 * 因此 `['SELF','STORE']` 与 `['DEPARTMENT']` 之间不存在可比的大小关系。
 * 本模块把每个档位翻成各自的谓词，档位之间取**并集** ——
 * 与 `20-business.sql` 里 RLS 策略写的是同一套语义，
 * 两处一致不是巧合，而是「应用层与数据库层用同一把尺」。
 *
 * ── 第二层在数据库里 ────────────────────────────────────────────────────
 *
 * 本模块产出的是**GUC 值**，真正过滤行的是 RLS。这样做的理由是：
 * 应用层的检查与它自己要检的东西是同一份代码，**无法独立地证伪自己**；
 * RLS 由数据库执行，测试可以绕过本模块直接验证它。
 */
import { pool } from './db.mjs'

/** 五档。取值域固定，不是「可以用任意字符串」。 */
export const DATA_SCOPES = Object.freeze(
  ['SELF', 'STORE', 'DEPARTMENT', 'DEPARTMENT_AND_CHILDREN', 'COMPANY'])

/**
 * 产品级工具网关分类（PRD §9.6.5「产品级分类」）。
 *
 * ⚠️ **这是地基，不可改**。搭建者只能「启用」白名单内的工具，
 * **不能改归属** —— 不存在把 Builder 工具登记到 User Gateway 的操作
 * （§9.6.5、§9.1）。所以它是一张**冻结的常量表**，不是配置。
 *
 * 若把它做成可配置项（哪怕是「只有所有者能改」），
 * 「工作模式不得挂载任何可修改系统结构的工具」就退化成一个开关。
 */
export const TOOL_GATEWAY = Object.freeze({
  // ── 使用侧：只读业务数据、只办业务 ──
  'data.readView': 'USER',
  'data.aggregate': 'USER',
  'biz.createRecord': 'USER',
  'biz.updateRecord': 'USER',
  'flow.submit': 'USER',
  'flow.approve': 'USER',
  // ── 搭建侧：改结构 ──
  'schema.designModel': 'BUILDER',
  'schema.composeForm': 'BUILDER',
  'schema.composeWorkflow': 'BUILDER',
  'schema.composeDashboard': 'BUILDER',
  'schema.publishContract': 'BUILDER',
  'plugin.install': 'BUILDER',
})

/**
 * 某网关**在产品级定义上**可见的工具集。
 * @param {'USER'|'BUILDER'} gateway 网关
 * @returns {string[]} 工具名
 */
export function toolsOfGateway(gateway) {
  return Object.entries(TOOL_GATEWAY).filter(([, g]) => g === gateway).map(([name]) => name)
}

/**
 * 某网关**实际可用**的工具集 = 产品级分类 ∩ 本次启用的白名单。
 *
 * 交集是单向的：启用**不能**把 Builder 工具带进 User 侧。
 * 这一点由测试固定 —— 只写注释是拦不住实现漂移的。
 * @param {'USER'|'BUILDER'} gateway 网关
 * @param {string[]} enabled 已启用的工具
 * @returns {string[]} 可用工具名
 */
export function toolsForGateway(gateway, enabled) {
  const productLevel = new Set(toolsOfGateway(gateway))
  return enabled.filter((name) => productLevel.has(name))
}

/**
 * 判定一次工具调用是否属该网关。**服务端判定**，不看调用方声明。
 * @param {'USER'|'BUILDER'} gateway 网关
 * @param {string} tool 工具名
 * @returns {{allowed: boolean, reason?: string}} 结论
 */
export function checkGateway(gateway, tool) {
  const owner = TOOL_GATEWAY[tool]
  if (!owner) return { allowed: false, reason: 'KVVI_TOOL_NOT_REGISTERED' }
  if (owner !== gateway) return { allowed: false, reason: 'KVVI_WRONG_GATEWAY' }
  return { allowed: true }
}

/** 部门子树（含自身）。**包含关系来自组织模型**，不由档位编号推导。 */
export async function deptSubtree(client, companyId, deptId) {
  const { rows } = await client.query(
    `WITH RECURSIVE sub AS (
       SELECT dept_id FROM departments WHERE company_id = $1 AND dept_id = $2
       UNION ALL
       SELECT d.dept_id FROM departments d JOIN sub ON d.parent_dept_id = sub.dept_id
     ) SELECT dept_id FROM sub`, [companyId, deptId])
  return rows.map((r) => r.dept_id)
}

/**
 * 组装一个会话的**服务端授权上下文**。
 *
 * 档位来自该账号在该公司的全部 DATA 策略，取**并集** ——
 * 「能看什么」是多条授权的合并，不是最强的那一条。
 * @param {object} ctx 身份上下文（来自 verifyToken）
 * @returns {Promise<object>} 授权上下文
 */
export async function scopeContext(ctx) {
  const client = await pool('platform').connect()
  try {
    const { rows } = await client.query(
      `SELECT DISTINCT unnest(p.data_scopes) AS scope
         FROM policies p
         JOIN role_members rm ON rm.role_id = p.role_id
        WHERE p.company_id = $1 AND rm.user_id = $2 AND p.dimension = 'DATA'`,
      [ctx.companyId, ctx.userId])
    const scopes = rows.map((r) => r.scope).filter((s) => DATA_SCOPES.includes(s))
    const subtree = ctx.deptId
      ? await deptSubtree(client, ctx.companyId, ctx.deptId)
      : []
    return {
      companyId: ctx.companyId, userId: ctx.userId, gateway: ctx.gateway,
      deptId: ctx.deptId, deptSubtree: subtree, shopId: ctx.shopId,
      scopes,
    }
  } finally {
    client.release()
  }
}

/**
 * 把授权上下文写进连接的 GUC —— RLS 读的就是这几个值。
 *
 * 全部用 `set_config(..., true)`（事务内有效）。**不得用会话级设置**：
 * 连接池会把连接借给下一个请求，会话级 GUC 会串台，
 * 而且串台的方向是「读到上一个人的数据」，不是「读不到」。
 * @param {import('pg').PoolClient} client 连接
 * @param {object} scope 授权上下文
 */
export async function applyScopeGucs(client, scope) {
  const set = (name, value) =>
    client.query('SELECT set_config($1, $2, true)', [name, value ?? ''])
  await set('kvvi.company_id', scope.companyId)
  await set('kvvi.user_id', scope.userId)
  await set('kvvi.dept_id', scope.deptId)
  await set('kvvi.dept_subtree', (scope.deptSubtree ?? []).join(','))
  await set('kvvi.shop_id', scope.shopId)
  await set('kvvi.scopes', (scope.scopes ?? []).join(','))
}

/** 账号在某公司经角色得到的策略。 */
export async function effectivePolicies(companyId, userId, dimension) {
  const { rows } = await pool('platform').query(
    `SELECT p.dimension, p.resource_code, p.actions, p.data_scopes, p.field_visibility
       FROM policies p
       JOIN role_members rm ON rm.role_id = p.role_id
      WHERE p.company_id = $1 AND rm.user_id = $2 AND p.dimension = $3`,
    [companyId, userId, dimension])
  return rows
}

/**
 * 表单/流程维度的动作判定（0B-4、0B-7）。
 * @param {string} companyId 公司
 * @param {string} userId 账号
 * @param {'FORM'|'FLOW'} dimension 维度
 * @param {string} resourceCode 资源 code
 * @param {string} action 动作
 * @returns {Promise<boolean>} 是否允许
 */
export async function canAct(companyId, userId, dimension, resourceCode, action) {
  const rows = await effectivePolicies(companyId, userId, dimension)
  return rows.some((r) =>
    (r.resource_code === resourceCode || r.resource_code === '*') &&
    (r.actions ?? []).includes(action))
}

/**
 * 字段维度：逐字段给出可见性（0B-5）。
 *
 * 合并规则：**没有任何策略命中 → 不可见**；命中多条时取**最严**的一条。
 *
 * ⚠️ 这两件事必须分开写，不能合成「从 HIDDEN 起步、只允许变严」——
 * 那样任何显式授权都升不上来，函数会**恒返回 HIDDEN**。
 * 那种 bug 看起来是「更安全」（永远不泄漏），所以很容易一路蒙混过关；
 * 它实际是把字段权限整个废掉。本项目的用例正是在这里抓到的它。
 *
 * 取最严而不是最松的理由：多给一个角色**不应该**变成一次静默扩权。
 * @param {string} companyId 公司
 * @param {string} userId 账号
 * @param {string[]} fields 字段 code 列表
 * @returns {Promise<Record<string, string>>} 字段 → 可见性
 */
export async function fieldVisibility(companyId, userId, fields) {
  const rows = await effectivePolicies(companyId, userId, 'FIELD')
  const rank = { VISIBLE: 0, READONLY: 1, MASKED: 2, HIDDEN: 3 }
  const out = {}
  for (const field of fields) {
    const applicable = rows.filter((r) => r.field_visibility
      && (r.resource_code === field || r.resource_code === '*'))
    out[field] = applicable.length === 0
      ? 'HIDDEN'      // 没命中任何策略：不可见（fail-closed）
      : applicable.reduce(
        (acc, r) => (rank[r.field_visibility] > rank[acc] ? r.field_visibility : acc),
        'VISIBLE')
  }
  return out
}

/**
 * 按可见性过滤一条记录的字段值。
 * **脱敏输出的是掩码，不是原文** —— 这一点由调用方无法绕过：
 * 本函数是唯一的字段出口。
 * @param {Record<string, any>} record 记录
 * @param {Record<string, string>} visibility 字段可见性
 * @returns {Record<string, any>} 过滤后的记录
 */
export function projectFields(record, visibility) {
  const out = {}
  for (const [key, value] of Object.entries(record)) {
    const mode = visibility[key] ?? 'HIDDEN'
    if (mode === 'HIDDEN') continue
    out[key] = mode === 'MASKED' ? mask(value) : value
  }
  return out
}

/** 掩码：保留长度信息（便于校验），不保留内容。 */
export function mask(value) {
  if (value === null || value === undefined) return null
  const text = String(value)
  if (text.length <= 2) return '*'.repeat(text.length)
  return `${text.slice(0, 1)}${'*'.repeat(text.length - 2)}${text.slice(-1)}`
}

/**
 * 流程动作判定（0B-7）：**当前状态下**能否做这个动作。
 *
 * 状态机由契约定义（`workflow-spec`），本函数只做判定，不发明迁移。
 * 非法动作一律拒绝 —— 包括「终态的任何写操作」。
 * @param {object[]} transitions 迁移表
 * @param {string} fromState 当前状态
 * @param {string} action 动作
 * @returns {{allowed: boolean, toState?: string, reason?: string}} 结论
 */
export function resolveTransition(transitions, fromState, action) {
  const hits = transitions.filter((t) => t.from_state === fromState && t.action_code === action)
  if (hits.length === 0) {
    return { allowed: false, reason: 'KVVI_TRANSITION_NOT_DEFINED' }
  }
  if (hits.length > 1) {
    // 同一状态下同一动作有两条去向 → 契约歧义，**不能挑一条执行**。
    return { allowed: false, reason: 'KVVI_TRANSITION_AMBIGUOUS' }
  }
  return { allowed: true, toState: hits[0].to_state }
}
