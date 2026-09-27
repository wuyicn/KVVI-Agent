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
import { latestContract } from './contracts.mjs'
import { assertFieldValues } from './field-rules.mjs'
import { applyScopeGucs, requiredFields } from './authorization.mjs'
import { nextRecordNo } from './record-no.mjs'

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
              state, record_no, data, row_version, workflow_version
         FROM business_records
        WHERE record_id = $1 AND company_id = $2`, [handle.id, handle.companyId])
    await client.query('COMMIT')
    if (rows.length !== 1) return null
    const r = rows[0]
    return {
      recordId: r.record_id, companyId: r.company_id, schemaCode: r.schema_code,
      deptId: r.dept_id, shopId: r.shop_id, ownerId: r.owner_id,
      state: r.state, recordNo: r.record_no, data: r.data, rowVersion: Number(r.row_version),
      // 这条记录进入流程时钉住的那一版流程契约；NULL = 钉住机制之前创建的记录。
      // **只在这条读取路径上给** —— 列表那条不返回它：列表是给界面用的，
      // 而「走哪一版流程」是运行时内部的事，没有理由出现在列表投影里。
      workflowVersion: r.workflow_version === null ? null : Number(r.workflow_version),
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
/**
 * 这个业务对象的字段声明 —— **写入约束的唯一来源**。
 *
 * 读的是**已发布的** `business-schema`（当前版）：字段的 `required` /
 * `write_policy` 是模型层的事，与「走哪一版流程」无关，所以不钉版本。
 *
 * ── ⚠️ 读不到时为什么**不拒绝写入** ────────────────────────────────────
 *
 * 「没有已发布模型」不等于「这次写入不合法」，它是**另一件事**：
 * 这个业务对象根本还没成为一套可运行的系统。而那一件事**已经有判据**，
 * 且在更早的地方 —— `runtimeProjection` 对缺契约的系统直接拒绝出投影，
 * 发布通道也要求六份契约齐全。在这里再拒一次是同一个判据的第二份实现。
 *
 * 哪条路会走到这里：**只有直接调数据层的测试**。产品路径上四个写入点
 * （产品 API、命令执行器、访客链路、流程迁移）背后都必须是已发布的系统，
 * 所以模型一定在。
 *
 * 反过来说也成立：**有判据而不执行才是漏**（问题 28 就是那个形状）；
 * 无判据时假装有判据，只会把一批与被测性质无关的用例全染红 ——
 * 那是在用噪声换「看起来严格」。所以这里返回 `null`，由调用方跳过。
 *
 * @param {string} companyId 公司
 * @param {string} schemaCode 业务对象代号
 * @returns {Promise<object|null>} 模型 Spec；没有已发布模型时为 null
 */
async function modelOrNull(companyId, schemaCode) {
  const contract = await latestContract(companyId, 'business-schema', schemaCode)
  return contract === null ? null : contract.content
}

export async function createRecord(ctx, scope, input) {
  // ★ **契约声明的字段约束在这里执行。**
  //
  // 为什么在这一层而不是 API 适配器里：记录有四个写入点
  // （产品 API、命令执行器、访客链路、流程迁移）。只在一个适配器里检查，
  // 另外三个就是绕过口 —— 「换个调用方就能跳过」的东西不叫约束。
  const model = await modelOrNull(ctx.companyId, input.schemaCode)
  if (model !== null) {
    assertFieldValues({
      model, operation: 'create', data: input.data ?? {},
      // 权限层的必填**只用在同一件事上**：建这条记录时你得把它填上。
      // 取并集交给 `checkFieldValues`，这里不替模型层下结论。
      requiredFields: await requiredFields(ctx.companyId, ctx.userId),
    })
  }
  return withTransaction('business', async (client) => {
    await applyScopeGucs(client, scope)
    // ★ 单号缺省时**由本函数生成**，不留给调用方。
    //
    // `record_no` 是 NOT NULL 且有唯一约束；此前没有任何地方生成它，
    // 于是通过产品 API 建记录会在 NOT NULL 上失败 —— 而报错指向表约束，
    // 看不出「缺一个生成器」。生成与取号必须在**同一个事务**里，
    // 否则回滚会漏掉一次取号（号被消耗但不落库）。
    const recordNo = input.recordNo ?? await nextRecordNo(client, {
      companyId: ctx.companyId, schemaCode: input.schemaCode,
    })
    const { rows } = await client.query(
      `INSERT INTO business_records (record_id, company_id, schema_code, dept_id,
         shop_id, owner_id, state, record_no, data, workflow_version)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING record_id, record_no, row_version`,
      [ctx.companyId, input.schemaCode, scope.deptId, scope.shopId,
       ctx.userId, input.state ?? 'draft', recordNo, input.data ?? {},
       // ★ **出生时钉住流程版本。** 它决定这条记录之后走哪一版流程；
       //    不钉的话，一次发布会把在途记录也带走（见迁移 26 的注释）。
       input.workflowVersion ?? null])
    // `rowVersion` 一并返回：创建者立刻就能改自己刚建的记录，
    // 不必「再读一次拿版本」—— 读与写之间正是丢更新的窗口。
    return {
      recordId: rows[0].record_id,
      recordNo: rows[0].record_no,
      rowVersion: Number(rows[0].row_version),
    }
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
  // 补丁里带的**字段值**要过同一套约束（`CREATE_ONLY` / `SYSTEM` 的字段不能改）。
  // `patch.state` 不走这里 —— 它不是模型字段，是流程迁移写的那一列。
  if (patch?.data !== undefined && Object.keys(patch.data).length > 0) {
    const model = await modelOrNull(ctx.companyId, logical.schemaCode)
    if (model !== null) {
      assertFieldValues({ model, operation: 'update', data: patch.data })
    }
  }
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
