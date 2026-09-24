/**
 * 身份源适配器（N16 残，PRD §3.4「保留设计路口」）。
 *
 * ── 首版只实现内置账号，但把**接口形状**定下来 ──────────────────────────
 *
 * ```
 * 身份源适配器（首版：仅实现内置账号）
 *    ├── 内置账号        ← 首版实现
 *    ├── （预留）AD / LDAP
 *    └── （预留）钉钉 / 企微 / OAuth2
 * ```
 *
 * ── 唯一的技术前提：**认证与授权分离**（§3.4.1）────────────────────────
 *
 * | 能力 | 含义 | 谁负责 |
 * |---|---|---|
 * | **认证** | 你是谁 | **可由外部 IdP 提供** |
 * | **授权** | 你能看什么、做什么 | **始终由 KVVI 掌握，不可外移** |
 *
 * 所以本模块的返回值**只有一个能力**：说出「这个人是谁」。
 * 适配器**拿不到** `policies`、`role_members`、数据档位 ——
 * 那由 §3.1 的两级授权在别处决定。
 *
 * ⚠️ **接口本身会约束实现**：只要 `authenticate()` 的返回类型里没有权限字段，
 * 「把授权交给外部系统」在这条路上就没有表达方式 ——
 * 这比在文档里写一句「不得外移授权」更硬。
 *
 * ── 三条归一化要求（§3.4.2）────────────────────────────────────────────
 *
 * 1. **认证结果归一**：无论来自内置账号还是外部 IdP，都归一到同一个账号对象；
 * 2. **账号映射可配置**：外部标识 ↔ KVVI 账号的映射不硬编码；
 * 3. **授权不经过适配器**：适配器只产出「已认证的身份」，不产出任何权限。
 */
import { pool } from './db.mjs'
import { authenticate } from './identity.mjs'

/**
 * 归一化后的**认证结果**。
 *
 * ⚠️ **注意这里没有的东西**：没有角色、没有数据档位、没有网关资格。
 * 那不是遗漏 —— 那是本模块存在的理由（§3.4.1）。
 * @typedef {object} AuthenticatedIdentity
 * @property {string} userId KVVI 账号
 * @property {string} source 身份源标识
 * @property {string} externalId 外部标识（内置账号即登录名）
 * @property {string} status 账号状态
 * @property {string[]} companyIds 该账号所属公司（**不含任何权限语义**）
 */

/** 适配器注册表。**只有注册过的源能被使用** —— 不注册即不可达。 */
const registry = new Map()

/**
 * 注册一个身份源适配器。
 *
 * 适配器是一个对象 `{ code, authenticate(credentials) }`，
 * 其中 `authenticate` **必须**返回 `AuthenticatedIdentity | null`。
 * 返回值由 `assertIdentityShape` 校验 —— 多带一个权限字段会被拒。
 * @param {{code: string, authenticate: Function}} adapter 适配器
 */
export function registerSource(adapter) {
  if (!adapter || typeof adapter.code !== 'string' || typeof adapter.authenticate !== 'function') {
    throw new Error('KVVI_BAD_SOURCE_ADAPTER')
  }
  registry.set(adapter.code, adapter)
}

/** 已注册的身份源（诊断用）。 */
export function sources() {
  return [...registry.keys()].sort()
}

/**
 * 校验认证结果的形状。**多带字段即拒** ——
 * 一个「顺手也返回角色」的适配器会把授权悄悄外移，而那正是 §3.4.1 禁的。
 * @param {object} identity 认证结果
 */
export function assertIdentityShape(identity) {
  const ALLOWED = ['userId', 'source', 'externalId', 'status', 'companyIds']
  const extra = Object.keys(identity).filter((k) => !ALLOWED.includes(k))
  if (extra.length > 0) {
    throw new Error(`KVVI_ADAPTER_RETURNED_FORBIDDEN_FIELDS:${extra.join(',')}`)
  }
  for (const key of ['userId', 'source', 'externalId', 'status']) {
    if (typeof identity[key] !== 'string' || identity[key] === '') {
      throw new Error(`KVVI_ADAPTER_IDENTITY_INCOMPLETE:${key}`)
    }
  }
  if (!Array.isArray(identity.companyIds)) {
    throw new Error('KVVI_ADAPTER_IDENTITY_INCOMPLETE:companyIds')
  }
  return identity
}

/**
 * 用某个身份源认证。
 *
 * 返回的是**身份**，不是会话。建会话要另走 `createSession()` ——
 * 因为「会话绑定哪家公司」是 KVVI 的决定（§9.9.3），不是 IdP 的。
 * @param {string} sourceCode 身份源标识
 * @param {object} credentials 凭据
 * @returns {Promise<object|null>} 认证结果，或 null
 */
export async function authenticateVia(sourceCode, credentials) {
  const adapter = registry.get(sourceCode)
  if (!adapter) throw new Error(`KVVI_UNKNOWN_IDENTITY_SOURCE:${sourceCode}`)
  const identity = await adapter.authenticate(credentials)
  if (identity === null) return null
  return assertIdentityShape(identity)
}

/** 该账号所属公司（**只是归属关系，不含任何权限语义**）。 */
async function companiesOf(userId) {
  const { rows } = await pool('platform').query(
    'SELECT company_id FROM memberships WHERE user_id = $1', [userId])
  return rows.map((r) => r.company_id)
}

/**
 * 内置账号适配器（**首版唯一实现**）。
 * @returns {{code: string, authenticate: Function}} 适配器
 */
export function builtinAdapter() {
  return {
    code: 'builtin',
    async authenticate({ login, password }) {
      const account = await authenticate(login, password)
      if (!account) return null
      return {
        userId: account.userId,
        source: 'builtin',
        externalId: login,
        status: account.status,
        companyIds: await companiesOf(account.userId),
      }
    },
  }
}

// 首版注册内置账号。外部身份源由部署方按需注册 ——
// **注册需要改代码或安装插件**，所以它天然是「所有者级」的动作。
registerSource(builtinAdapter())
