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
import { lockFormLifecycle, assertFormActive } from './business-lifecycle.mjs'
import { latestContract } from './contracts.mjs'
import {assertRecordEditable,recordData} from './record-state.mjs'
import { assertFieldValues } from './field-rules.mjs'
import { applyScopeGucs, fieldVisibility, requiredFields } from './authorization.mjs'
import { nextRecordNo } from './record-no.mjs'
import { lockUniqueFields, assertUniqueFields, assertUniquePublicationReady } from './unique-fields.mjs'

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
  return {
    kind: logical.kind ?? 'record',
    id: logical.id,
    companyId: ctx.companyId,
    // ★ S1 修复：schema 也是资源身份的一部分。HTTP 路径会带（URL 里的系统
    // 代号），读/写时据此把「属于别的系统的记录」挡在外面；命令路径不带
    // （它按 id 读，授权用读回来的真实 schema 判），此时为 undefined。
    schemaCode: typeof logical.schemaCode === 'string' ? logical.schemaCode : undefined,
  }
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
export async function readRecord(ctx, scope, logical, {client: transactionClient} = {}) {
  const handle = buildHandle(ctx, logical)
  const client = transactionClient ?? await pool('business').connect()
  try {
    if (!transactionClient) await client.query('BEGIN')
    await applyScopeGucs(client, scope)
    const { rows } = await client.query(
      `SELECT record_id, company_id, schema_code, dept_id, shop_id, owner_id,
              state, record_no, data, row_version, workflow_version
         FROM business_records
        WHERE record_id = $1 AND company_id = $2
          AND ($3::text IS NULL OR schema_code = $3)`, [handle.id, handle.companyId, handle.schemaCode ?? null])
    if(rows.length===1) {
      await lockFormLifecycle(client,handle.companyId,rows[0].schema_code,'read')
      await assertFormActive(client,handle.companyId,rows[0].schema_code)
    }
    if (!transactionClient) await client.query('COMMIT')
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
    if (!transactionClient) await client.query('ROLLBACK')
    throw error
  } finally {
    if (!transactionClient) client.release()
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
    await lockFormLifecycle(client,scope.companyId,schemaCode,'read')
    await assertFormActive(client,scope.companyId,schemaCode)
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
 * 这个业务对象的字段声明 —— **写入约束与字段清单的唯一来源**。
 *
 * 读的是**已发布的** `business-schema`（当前版）：字段的 `required` /
 * `write_policy` 是模型层的事，与「走哪一版流程」无关，所以不钉版本。
 *
 * ★ **两个消费者共用它**：写入点（`createRecord` / `updateRecord`）与
 *   字段清单端点（`system-api.mjs` 的 `GET /systems/:id/fields`）。
 *   各读一次就会让「清单里列出的字段」与「写进去不报错的字段」变成两份判据，
 *   而它们分叉时的症状正是这次要修的那个：模型照着清单写，却被判未声明。
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
export async function publishedBusinessModel(companyId, schemaCode) {
  const contract = await latestContract(companyId, 'business-schema', schemaCode)
  return contract === null ? null : contract.content
}

/**
 * 这个会话**看得见**的字段编码，保持契约里的声明顺序。
 *
 * ⚠️ 过滤放在这里而不是 `field-rules.mjs`：那是模型层，不认识字段权限
 *    ——`field-rules.mjs` 模块头那句「`required` 与权限是两件事」在这里兑现。
 *    `fieldVisibility` 是唯一判据，本函数只把它应用到字段清单上 ——
 *    没命中任何策略时它给 `HIDDEN`，照它的结论走。
 *
 * 为什么必须滤：`KVVI_FIELD_NOT_DECLARED` 的 `detail` 会带着这份清单回到调用方，
 * 而记录读取正是靠同一条判据不让 `HIDDEN` 的字段出现（那里是值不出现）。
 * 不过滤的话，一条写错的字段名就把该角色看不见的字段名念了出来。
 *
 * @param {object} ctx 身份上下文（公司、账号来自会话）
 * @param {object} model 已发布的模型 Spec
 * @returns {Promise<string[]>} 字段 code；一个都看不见时是空数组
 */
async function visibleFieldCodes(ctx, model) {
  const codes = (model?.fields ?? [])
    .map((field) => field?.field_code)
    .filter((code) => typeof code === 'string')
  if (codes.length === 0) return []
  const visibility = await fieldVisibility(ctx.companyId, ctx.userId, codes)
  return codes.filter((code) => (visibility[code] ?? 'HIDDEN') !== 'HIDDEN')
}

const writeTransaction = (client, fn) => client ? fn(client) : withTransaction('business', fn)

export async function createRecord(ctx, scope, input, {client: transactionClient} = {}) {
  recordData(input.data)
  return writeTransaction(transactionClient, async (client) => {
    await applyScopeGucs(client, scope)
    await lockFormLifecycle(client,ctx.companyId,input.schemaCode,'write')
    await assertFormActive(client,ctx.companyId,input.schemaCode)
    await lockUniqueFields(client, ctx.companyId, input.schemaCode)
    // All product and agent writes validate the model read under the form lock.
    const model = await publishedBusinessModel(ctx.companyId, input.schemaCode)
    await assertUniquePublicationReady(client, ctx.companyId, input.schemaCode, model)
    if (model !== null) {
      assertFieldValues({
        model, operation: 'create', data: input.data ?? {},
        requiredFields: await requiredFields(ctx.companyId, ctx.userId),
        declaredFields: await visibleFieldCodes(ctx, model),
      })
    }
    await assertUniqueFields(client, ctx.companyId, input.schemaCode, model, input.data ?? {})
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
export async function updateRecord(ctx, scope, logical, patch, {client: transactionClient,transitionAction} = {}) {
  recordData(patch?.data)
  const handle = buildHandle(ctx, logical)
  return writeTransaction(transactionClient, async (client) => {
    await applyScopeGucs(client, scope)
    const existing=(await client.query('SELECT schema_code FROM business_records WHERE company_id=$1 AND record_id=$2 AND ($3::text IS NULL OR schema_code = $3)',[handle.companyId,handle.id,handle.schemaCode ?? null])).rows[0]
    if(!existing) return null
    await lockFormLifecycle(client,handle.companyId,existing.schema_code,'write')
    await assertFormActive(client,handle.companyId,existing.schema_code)
    await lockUniqueFields(client, handle.companyId, existing.schema_code)
    const current = (await client.query('SELECT data,row_version,state,workflow_version,owner_id FROM business_records WHERE company_id=$1 AND record_id=$2 AND ($3::text IS NULL OR schema_code = $3) FOR UPDATE', [handle.companyId, handle.id, handle.schemaCode ?? null])).rows[0]
    if (!current || (patch.rowVersion != null && Number(current.row_version) !== patch.rowVersion)) return null
    await assertRecordEditable(ctx,{schemaCode:existing.schema_code,state:current.state,workflowVersion:current.workflow_version,ownerId:current.owner_id},
      {data:patch?.data,toState:patch?.state,transitionAction})
    const model = await publishedBusinessModel(ctx.companyId, existing.schema_code)
    await assertUniquePublicationReady(client, ctx.companyId, existing.schema_code, model)
    // Field mutability applies to the patch; uniqueness applies to the merged record.
    if (patch?.data !== undefined && Object.keys(patch.data).length > 0) {
      if (model !== null) {
        assertFieldValues({
          model, operation: 'update', data: patch.data,
          declaredFields: await visibleFieldCodes(ctx, model),
        })
      }
    }
    await assertUniqueFields(client, handle.companyId, existing.schema_code, model,
      { ...current.data, ...(patch.data ?? {}) }, handle.id)
    const { rows } = await client.query(
      `UPDATE business_records
          SET data = data || $3::jsonb,
              state = coalesce($4, state),
              row_version = row_version + 1,
              updated_at = now()
        WHERE record_id = $1 AND company_id = $2
          AND ($6::text IS NULL OR schema_code = $6)
          AND ($5::bigint IS NULL OR row_version = $5::bigint)
        RETURNING record_id, row_version`,
      [handle.id, handle.companyId, JSON.stringify(patch.data ?? {}),
       patch.state ?? null, patch.rowVersion ?? null, handle.schemaCode ?? null])
    if (rows.length !== 1) return null
    return { recordId: rows[0].record_id, rowVersion: Number(rows[0].row_version) }
  })
}
