/**
 * 契约存储 —— 已发布契约的**内容**的落点。
 *
 * ── 它解的是一件事，不是四件 ──────────────────────────────────────────────
 *
 * 本服务此前只记「发布了」这个动作（草案、审批、发布记录、已发布系统名），
 * 而**契约内容本身没有被任何服务持有**。于是四件事同时做不成：
 * 工作台打不开系统界面、待办说不清谁该批、聚合口径列不出来、
 * 员工客户端同步不到系统定义。**不是四个问题，是同一个。**
 *
 * ── 边界（这条比功能更重要）──────────────────────────────────────────────
 *
 * | 做 | 不做 |
 * |---|---|
 * | 原样存 + 存内容指纹 | **不校验契约是否合法** —— 那是官方验证器的事，在这里再判一遍就是第二份判据 |
 * | 按版本读、取最新版 | **不合并版本** —— §4.1.1 五要求版本单调递增，覆盖写入会让回滚与「版本不符即拒绝」都失去依据 |
 * | 按公司隔离 | **不跨公司读** —— 公司来自会话，不是请求参数 |
 * | 内容指纹对不上就**拒绝** | 不「以库里为准」也不「以传入为准」，两者不符时没有正确答案 |
 */

import { createHash } from 'node:crypto'
import { pool } from './db.mjs'

/**
 * 内容指纹。
 *
 * ⚠️ 键排序后再序列化：`{a:1,b:2}` 与 `{b:2,a:1}` 是同一份契约，
 * 而 `JSON.stringify` 会给出两个不同摘要 —— 那会让「内容没变」被误判成「变了」。
 * @param value 任意 JSON 值
 * @returns `sha256:…`
 */
function digestOf(value) {
  const canonical = (v) => {
    if (Array.isArray(v)) return v.map(canonical)
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]))
    }
    return v
  }
  return 'sha256:' + createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')
}

/**
 * 登记一批已发布契约。
 *
 * 由发布流程在**同一个事务里**调用 —— 与 `publish_records` 和 `systems` 同生共死。
 * 分开写会留下「发布了但没有内容」或反过来的窗口。
 *
 * @param {object} client 已开启事务的 pg 客户端（由调用方提供，本函数不自己开事务）
 * @param {object} input
 * @param {string} input.companyId 公司
 * @param {Array<{contractType: string, assetId: string|null, content: unknown}>} input.contracts
 *   要登记的契约。版本号由本函数按 (公司, 类型, 代号) 取当前最大值 +1 得出 ——
 *   **由库里算，不由调用方给**：让调用方报版本号，两个人同时发就会撞。
 * @param {number} input.publishedRecord 来源发布记录
 * @returns {Promise<Array<{contractType: string, assetId: string|null, version: number, digest: string}>>}
 *   登记结果（含分配到的版本）
 */
export async function recordContracts(client, { companyId, contracts, publishedRecord }) {
  const out = []
  for (const c of contracts) {
    const { rows } = await client.query(
      `SELECT coalesce(max(version), 0) AS v FROM published_contracts
        WHERE company_id = $1 AND contract_type = $2 AND asset_id IS NOT DISTINCT FROM $3`,
      [companyId, c.contractType, c.assetId ?? null])
    const version = Number(rows[0].v) + 1
    const digest = digestOf(c.content)
    await client.query(
      `INSERT INTO published_contracts (company_id, contract_type, asset_id,
         version, digest, content, published_record)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [companyId, c.contractType, c.assetId ?? null, version, digest,
       JSON.stringify(c.content), publishedRecord])
    out.push({ contractType: c.contractType, assetId: c.assetId ?? null, version, digest })
  }
  return out
}

/**
 * 读本公司某类契约的**最新已发布版本**。
 *
 * @param {string} companyId 会话绑定的公司
 * @param {string} contractType 契约类型
 * @param {string|null} assetId 系统代号；`null` 表示该类型下不分系统的契约
 * @returns {Promise<{version: number, digest: string, content: unknown, publishedAt: string}|null>}
 */
export async function latestContract(companyId, contractType, assetId = null) {
  const { rows } = await pool('platform').query(
    `SELECT version, digest, content, published_at FROM published_contracts
      WHERE company_id = $1 AND contract_type = $2 AND asset_id IS NOT DISTINCT FROM $3
      ORDER BY version DESC LIMIT 1`,
    [companyId, contractType, assetId ?? null])
  if (rows.length !== 1) return null
  const r = rows[0]
  // ★ 读取时**重算指纹**并与库里比对。
  //
  // 库里被改过、或写入时算错，都会在这里现形。返回内容而不是拒绝，
  // 会让「内容被改过」这件事静默通过 —— 而契约内容是权限判定的输入。
  const actual = digestOf(r.content)
  if (actual !== r.digest) {
    const error = new Error('KVVI_CONTRACT_CONTENT_TAMPERED')
    error.detail = { expected: r.digest, actual, version: r.version }
    throw error
  }
  return { version: r.version, digest: r.digest, content: r.content,
           publishedAt: r.published_at }
}

/**
 * 列本公司某类契约的**全部已发布版本**（倒序）。
 * @param {string} companyId 公司
 * @param {string} contractType 契约类型
 * @param {string|null} assetId 系统代号
 * @returns {Promise<Array<object>>} 版本列表，不含内容（内容按需单独读）
 */
export async function contractVersions(companyId, contractType, assetId = null) {
  const { rows } = await pool('platform').query(
    `SELECT version, digest, published_at FROM published_contracts
      WHERE company_id = $1 AND contract_type = $2 AND asset_id IS NOT DISTINCT FROM $3
      ORDER BY version DESC`,
    [companyId, contractType, assetId ?? null])
  return rows.map((r) => ({ version: r.version, digest: r.digest,
                            publishedAt: r.published_at }))
}

/**
 * 读本公司某类契约的**指定版本**。
 *
 * 「发布只对新数据生效」要成立，就必须**读得回历史版本** ——
 * 一条在途记录钉住的是它进入流程那一刻的流程契约（`business_records.workflow_version`），
 * 而不是「当前最新版」。历史版本一直留着（契约只追加、不覆盖），所以读得回来。
 *
 * 指纹照 `latestContract` 一样重算核对：**内容被改过**要在产出任何东西之前检出，
 * 而不是让一条被改过的流程静默参与判定。
 *
 * @param {string} companyId 公司
 * @param {string} contractType 契约类型
 * @param {string} assetId 系统代号
 * @param {number} version 版本号
 * @returns {Promise<{version: number, digest: string, content: unknown}|null>}
 */
export async function contractAt(companyId, contractType, assetId, version) {
  const { rows } = await pool('platform').query(
    `SELECT version, digest, content FROM published_contracts
      WHERE company_id = $1 AND contract_type = $2 AND asset_id = $3 AND version = $4`,
    [companyId, contractType, assetId, version])
  if (rows.length !== 1) return null
  const r = rows[0]
  const actual = digestOf(r.content)
  if (actual !== r.digest) {
    const error = new Error('KVVI_CONTRACT_CONTENT_TAMPERED')
    error.detail = { contractType, expected: r.digest, actual, version: r.version }
    throw error
  }
  return { version: r.version, digest: r.digest, content: r.content }
}

/** 计算契约内容的指纹。导出是给测试与调用方核对用的，不是第二套算法。 */
export function digestOfContract(content) {
  return digestOf(content)
}

/**
 * 一个系统当前生效的**全部契约**。
 *
 * 工作台打开一个系统时用它：界面要 view-schema，动作要 workflow-spec，
 * 字段要 business-schema —— 一次取齐，避免客户端拼多次请求。
 * @param {string} companyId 公司
 * @param {string} assetId 系统代号
 * @returns {Promise<Record<string, {version: number, digest: string, content: unknown}>>}
 *   按契约类型索引；缺哪类就不出现（**不补空对象**：那会让「没有」与「空」混起来）
 */
export async function contractsOfSystem(companyId, assetId) {
  const { rows } = await pool('platform').query(
    `SELECT DISTINCT ON (contract_type) contract_type, version, digest, content
       FROM published_contracts
      WHERE company_id = $1 AND asset_id = $2
      ORDER BY contract_type, version DESC`, [companyId, assetId])
  const out = {}
  for (const r of rows) {
    const actual = digestOf(r.content)
    if (actual !== r.digest) {
      const error = new Error('KVVI_CONTRACT_CONTENT_TAMPERED')
      error.detail = { contractType: r.contract_type, expected: r.digest, actual }
      throw error
    }
    out[r.contract_type] = { version: r.version, digest: r.digest, content: r.content }
  }
  return out
}
