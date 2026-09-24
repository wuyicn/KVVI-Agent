/**
 * 资源引用与记录读写（PRD §9.9.2、§9.3）。
 *
 * ── 这一层的形状来自一条不变式 ──────────────────────────────────────────
 *
 * §9.9.2 把引用分成两层：
 *
 *   模型可见的逻辑引用   模型在工具参数里生成、传递 —— **不含租户字段**
 *   服务端资源句柄       服务端据令牌封装 —— **含租户，仅由服务端注入**
 *
 * 所以本模块对外只收「逻辑引用」，**由服务端补上租户**。
 * 模型若在参数里塞了自己的租户，那个值**只用于比对，不作定位依据**（§9.3.1）——
 * 不相等就拒绝，不相等也不代表「他想去另一个公司」，就是无效引用。
 *
 * ── 跨租户拒绝与其他拒绝的区别 ──────────────────────────────────────────
 *
 * **跨租户不是「无权」，是「无效」** —— 在执行点之前就被拒，
 * 而且**不区分「是否有权」**。把它做成权限判定会引入一个危险的口子：
 * 「有权就能跨」在权限配置出错时会真的生效。
 */
import { pool, withTransaction } from './db.mjs'
import { applyScopeGucs } from './authorization.mjs'

export class KvviRefError extends Error {
  constructor(code, detail = '') {
    super(code)
    this.code = code
    this.detail = detail
  }
}

/**
 * 把逻辑引用封成**服务端句柄**：租户由服务端注入。
 *
 * 模型传来的租户信息**只用于比对**：不相等即拒绝，且拒绝理由不透露对方的任何信息。
 * @param {object} ctx 身份上下文
 * @param {object} logical 逻辑引用 `{id, kind, companyId?}`
 * @returns {{kind: string, id: string, companyId: string}} 服务端句柄
 */
export function buildHandle(ctx, logical) {
  if (!logical || typeof logical.id !== 'string' || logical.id.length === 0) {
    throw new KvviRefError('KVVI_REF_MALFORMED')
  }
  if (logical.companyId !== undefined && logical.companyId !== ctx.companyId) {
    // 不写成「你在 A，这条属于 B」—— 那本身就是一次跨租户信息泄漏。
    throw new KvviRefError('KVVI_CROSS_TENANT_REF')
  }
  return { kind: logical.kind ?? 'record', id: logical.id, companyId: ctx.companyId }
}

/**
 * 读一条记录。
 *
 * 三重约束叠加，任意一条不满足都读不到：
 *   1. 句柄租户 = 令牌租户（`buildHandle` 已保证）；
 *   2. SQL 显式再带一次 `company_id` —— 不依赖 RLS 单独兜底；
 *   3. RLS 按五档数据范围过滤（缺省 fail-closed）。
 * @param {object} ctx 身份上下文
 * @param {object} scope 授权上下文
 * @param {object} logical 逻辑引用
 * @returns {Promise<object|null>} 记录，或 null
 */
export async function readRecord(ctx, scope, logical) {
  const handle = buildHandle(ctx, logical)
  const client = await pool('business').connect()
  try {
    await client.query('BEGIN')
    await applyScopeGucs(client, scope)
    const { rows } = await client.query(
      `SELECT record_id, company_id, schema_code, dept_id, shop_id, owner_id,
              state, record_no, data, row_version
         FROM business_records
        WHERE record_id = $1 AND company_id = $2`, [handle.id, handle.companyId])
    await client.query('COMMIT')
    if (rows.length !== 1) return null
    const r = rows[0]
    return {
      recordId: r.record_id, companyId: r.company_id, schemaCode: r.schema_code,
      deptId: r.dept_id, shopId: r.shop_id, ownerId: r.owner_id,
      state: r.state, recordNo: r.record_no, data: r.data, rowVersion: Number(r.row_version),
    }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

/**
 * 列表读取：返回的行**由 RLS 决定**，本函数不做行过滤。
 * @param {object} scope 授权上下文
 * @param {string} schemaCode 模型 code
 * @param {object} options 选项
 * @returns {Promise<object[]>} 记录
 */
export async function listRecords(scope, schemaCode, options = {}) {
  const limit = Math.min(Number(options.limit ?? 50), 200)
  const client = await pool('business').connect()
  try {
    await client.query('BEGIN')
    await applyScopeGucs(client, scope)
    const { rows } = await client.query(
      `SELECT record_id, company_id, schema_code, dept_id, shop_id, owner_id,
              state, record_no, data, row_version
         FROM business_records
        WHERE schema_code = $1
        ORDER BY created_at DESC LIMIT $2`, [schemaCode, limit])
    await client.query('COMMIT')
    return rows.map((r) => ({
      recordId: r.record_id, companyId: r.company_id, schemaCode: r.schema_code,
      deptId: r.dept_id, shopId: r.shop_id, ownerId: r.owner_id,
      state: r.state, recordNo: r.record_no, data: r.data, rowVersion: Number(r.row_version),
    }))
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

/**
 * 写一条记录。**归属字段由服务端从上下文取，不接受调用方传入**。
 *
 * 这不是防君子：§9.3 要求写命令以「目标 ID + 当前租户 + 当前数据范围」为
 * **原子谓词**定位。让调用方传 `companyId` 就等于把谓词的一部分交给它。
 * @param {object} ctx 身份上下文
 * @param {object} scope 授权上下文
 * @param {object} input 写入内容
 * @returns {Promise<object>} 新记录
 */
export async function createRecord(ctx, scope, input) {
  return withTransaction('business', async (client) => {
    await applyScopeGucs(client, scope)
    const { rows } = await client.query(
      `INSERT INTO business_records (record_id, company_id, schema_code, dept_id,
         shop_id, owner_id, state, record_no, data)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING record_id, record_no`,
      [ctx.companyId, input.schemaCode, scope.deptId, scope.shopId,
       ctx.userId, input.state ?? 'draft', input.recordNo, input.data ?? {}])
    return { recordId: rows[0].record_id, recordNo: rows[0].record_no }
  })
}

/**
 * 更新一条记录：谓词里**同时**含目标、租户与归属。
 *
 * `row_version` 参与谓词 —— 并发更新的后到者影响 0 行而不是静默覆盖。
 * 返回 `null` 表示「没更新到」，调用方**不得**把它当成成功。
 * @param {object} ctx 身份上下文
 * @param {object} scope 授权上下文
 * @param {object} logical 逻辑引用
 * @param {object} patch 补丁
 * @returns {Promise<{recordId: string, rowVersion: number}|null>} 结果
 */
export async function updateRecord(ctx, scope, logical, patch) {
  const handle = buildHandle(ctx, logical)
  return withTransaction('business', async (client) => {
    await applyScopeGucs(client, scope)
    const { rows } = await client.query(
      `UPDATE business_records
          SET data = data || $3::jsonb,
              state = coalesce($4, state),
              row_version = row_version + 1,
              updated_at = now()
        WHERE record_id = $1 AND company_id = $2
          AND ($5::bigint IS NULL OR row_version = $5::bigint)
        RETURNING record_id, row_version`,
      [handle.id, handle.companyId, JSON.stringify(patch.data ?? {}),
       patch.state ?? null, patch.rowVersion ?? null])
    if (rows.length !== 1) return null
    return { recordId: rows[0].record_id, rowVersion: Number(rows[0].row_version) }
  })
}
