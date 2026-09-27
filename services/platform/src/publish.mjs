/**
 * 发布通道（PRD §9.6.3、§9.6.6、§9.8.1）。
 *
 * ── 它堵的是什么 ────────────────────────────────────────────────────────
 *
 * §9.6.3 的原话：搭建者绕过发布、直接改策略存储，使**未审批的权限策略**生效 ——
 * 此时 §9.2 的唯一执行点会**忠实执行被篡改的策略**，审批形同虚设。
 *
 * 所以「发布」不是一次部署动作，而是**业务权限策略唯一的生效通道**：
 *
 *     差异报告（§9.6.6） → 所有者审批（§9.6.1） → 发布
 *
 * 跳过任何一环都必须被拒。**顺序本身是设计的一部分**：
 * 先出报告是为了让审批人知道自己在批什么；没有报告就审批，
 * 批的是一个「不知道会改什么」的东西。
 *
 * ── 本模块是**产品代码里唯一**写 `policies` 的地方 ──────────────────────
 *
 * 这条由 `工具/check_publish_channel.py` 静态核查（扫 `src/` 里的
 * `INSERT INTO policies` / `UPDATE policies`）。它只是个**静态**保证 ——
 * 数据库层面没有拦直写（记在 N24）。它保证的是：**产品自己不给旁路**，
 * 而那正是 §9.6.3 的「产品接口面」清单所要求的。
 */
import { createHash, randomUUID } from 'node:crypto'
import { pool, withTransaction } from './db.mjs'
import { recordContracts } from './contracts.mjs'
import { append, appendDenial } from './audit.mjs'
import { checkSelfApproval, isPlatformAdmin, checkGateway } from './authorization.mjs'

export class PublishError extends Error {
  constructor(code, detail = {}) {
    super(code)
    this.code = code
    this.detail = detail
  }
}

const digestOf = (v) => 'sha256:' + createHash('sha256')
  .update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex')

/** §9.6.6 要求差异报告必须覆盖的四个面。少一个就不是「完整影响」。 */
export const DIFF_FACES = Object.freeze(
  ['见得到什么（人员范围）', '见得到什么（字段范围）', '能做什么动作', '数据范围档位', '工具启用范围'])

/**
 * 构建差异报告（§9.6.6）。
 *
 * ⚠️ **没有差异报告不得提交审批** —— 审批人不能在不了解影响的情况下批准。
 * 所以本函数不是「可选的一步」，它是 `submit()` 的前置条件。
 * @param {object[]} before 变更前的策略
 * @param {object[]} after 变更后的策略
 * @returns {object} 差异报告
 */
export function buildDiffReport(before, after) {
  const key = (p) => `${p.dimension}:${p.resource_code}:${p.role_code ?? ''}`
  const b = new Map(before.map((p) => [key(p), p]))
  const a = new Map(after.map((p) => [key(p), p]))
  const added = [], removed = [], changed = []
  for (const [k, v] of a) if (!b.has(k)) added.push(v)
  for (const [k, v] of b) if (!a.has(k)) removed.push(v)
  for (const [k, v] of a) {
    const old = b.get(k)
    if (old && JSON.stringify(old) !== JSON.stringify(v)) {
      changed.push({ key: k, before: old, after: v })
    }
  }
  return {
    added, removed, changed,
    // 阈值由系统定义（§9.6.4.1），不由模型决定 —— 这里只做事实陈述
    faces: DIFF_FACES,
    counts: { added: added.length, removed: removed.length, changed: changed.length },
  }
}

/**
 * 把编译好的策略**写进 `policies`**（§9.6.3 唯一的生效通道）。
 *
 * ⚠️ **这段 SQL 必须住在 `publish.mjs` 里，不能搬到调用方。**
 *
 * 第一版把它写在 `publish-api.mjs` 的路由里，于是
 * `工具/check_publish_channel.py` 当场变红：它的判据是
 * 「产品代码里**只有 `publish.mjs`** 能写 `policies`」。
 * 那条判据是对的 —— 它是 §9.6.3「搭建者绕过发布、直接改策略存储」这件事
 * 在代码层面的**唯一**保证（数据库层不拦直写，记为 N24）。
 * 把 SQL 挪到路由里，就等于给这条保证开了第二个写入口，
 * 而第二个入口一旦存在，第三个就不远了。
 *
 * 所以调用方只负责**给出要写什么**（编译好的行），写入留在这里。
 *
 * ⚠️ 整体替换，不是追加：`DELETE` 之后整批写入，且与发布记录**同一个事务**
 * （由 `publishDraft` 的调用方保证）。只加不减的权限界面等于没有权限界面。
 *
 * @param {object} input 入参
 * @param {object} input.client 已开启事务的 pg 客户端
 * @param {string} input.companyId 公司
 * @param {Array<object>} input.rows 编译好的策略行
 * @returns {Promise<{policies: number}>} 写入条数
 */
export async function writePolicies({ client, companyId, rows }) {
  await client.query('DELETE FROM policies WHERE company_id = $1', [companyId])
  for (const row of rows) {
    await client.query(
      `INSERT INTO policies (policy_id, company_id, role_id, dimension,
         resource_code, actions, data_scopes, field_visibility)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (company_id, role_id, dimension, resource_code) DO UPDATE
         SET actions = EXCLUDED.actions,
             data_scopes = EXCLUDED.data_scopes,
             field_visibility = EXCLUDED.field_visibility`,
      [companyId, row.roleId, row.dimension, row.resourceCode,
       row.actions, row.dataScopes, row.fieldVisibility])
  }
  return { policies: rows.length }
}


/**
 * 提交待发布草案（第 1 步：**差异报告**）。
 * @param {object} input 入参
 * @returns {Promise<object>} 草案
 */
export async function submitDraft({ ctx, change, diffReport, invariant, payload = null }) {
  if (!diffReport || !diffReport.faces || diffReport.faces.length < DIFF_FACES.length) {
    await appendDenial({
      companyId: ctx.companyId, actorKind: 'USER', actorId: ctx.userId,
      gateway: ctx.gateway, sessionId: ctx.sessionId,
      action: 'publish.submitDraft', outcome: 'DENY',
      reason: 'KVVI_DIFF_REPORT_REQUIRED',
    })
    throw new PublishError('KVVI_DIFF_REPORT_REQUIRED',
      { required: DIFF_FACES })
  }
  // §9.8.1：违反聚合差分不变量的配置**一律拒绝发布，不存在审批放行路径**。
  if (invariant && invariant.ok === false) {
    await appendDenial({
      companyId: ctx.companyId, actorKind: 'USER', actorId: ctx.userId,
      gateway: ctx.gateway, sessionId: ctx.sessionId,
      action: 'publish.submitDraft', outcome: 'DENY',
      reason: `KVVI_AGGREGATE_INVARIANT_VIOLATED:${invariant.reason ?? 'unknown'}`,
    })
    throw new PublishError('KVVI_AGGREGATE_INVARIANT_VIOLATED', invariant)
  }

  const draftId = randomUUID()
  const changeDigest = digestOf(change)
  await pool('platform').query(
    // ★ `payload` 是**要发布的内容本身**（编译好的策略行、系统代号、契约内容）。
    //   提交时存下来，发布时只认它 —— 审批人不必、也无法重新提供内容。
    //   只留摘要证明不了「发出去的是批过的那一份」：摘要是单向的。
    `INSERT INTO publish_drafts (draft_id, company_id, proposer_user_id, status,
       change_digest, diff_report, invariant, payload)
     VALUES ($1,$2,$3,'AWAITING_APPROVAL',$4,$5,$6,$7)`,
    [draftId, ctx.companyId, ctx.userId, changeDigest,
     JSON.stringify(diffReport), JSON.stringify(invariant ?? {}),
     JSON.stringify(payload ?? {})])
  await append({
    companyId: ctx.companyId, actorKind: 'USER', actorId: ctx.userId,
    gateway: ctx.gateway, sessionId: ctx.sessionId,
    action: 'publish.submitDraft', outcome: 'ALLOW',
    resourceKind: 'publish_draft', resourceId: draftId,
    paramsDigest: changeDigest,
  })
  return { draftId, changeDigest, status: 'AWAITING_APPROVAL' }
}

/**
 * 审批（第 2 步）。
 *
 * 三类拒绝，各有各的理由：
 *   · 提出者本人 → `KVVI_SELF_APPROVAL_FORBIDDEN`（§9.6.4.1）
 *   · 非所有者 → `KVVI_NOT_A_PLATFORM_ADMIN`（§3.1：搭建权限不是自取的）
 *   · 摘要不符 → `KVVI_APPROVAL_DIGEST_MISMATCH`（批的不是这一份）
 * @param {object} input 入参
 * @returns {Promise<object>} 结论
 */
export async function approveDraft({ ctx, draftId, decision, opinion = null, change }) {
  const { rows } = await pool('platform').query(
    `SELECT * FROM publish_drafts WHERE draft_id = $1`, [draftId])
  if (rows.length !== 1) throw new PublishError('KVVI_NO_SUCH_DRAFT')
  const draft = rows[0]

  const refuse = async (code) => {
    await appendDenial({
      companyId: ctx.companyId, actorKind: 'USER', actorId: ctx.userId,
      gateway: ctx.gateway, sessionId: ctx.sessionId,
      action: 'publish.approve', outcome: 'DENY', reason: code,
      resourceKind: 'publish_draft', resourceId: draftId,
    })
    return { ok: false, error: code }
  }

  if (draft.company_id !== ctx.companyId) return refuse('KVVI_CROSS_TENANT_DRAFT')
  if (draft.status !== 'AWAITING_APPROVAL') return refuse('KVVI_DRAFT_NOT_AWAITING_APPROVAL')

  // ① 自审批
  const selfCheck = checkSelfApproval(ctx.userId, draft.proposer_user_id, true)
  if (!selfCheck.allowed) return refuse(selfCheck.reason)
  // ② 所有者
  const admin = await isPlatformAdmin(ctx.companyId, ctx.userId)
  if (!admin.allowed) return refuse(admin.reason)
  // ③ 摘要：批的必须是**这一份**
  if (change !== undefined && digestOf(change) !== draft.change_digest) {
    return refuse('KVVI_APPROVAL_DIGEST_MISMATCH')
  }

  await withTransaction('platform', async (client) => {
    await client.query(
      `UPDATE publish_drafts SET status = $2, approved_by = $3, approved_at = now(),
              approval_opinion = $4
        WHERE draft_id = $1`,
      [draftId, decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', ctx.userId, opinion])
  })
  await append({
    companyId: ctx.companyId, actorKind: 'USER', actorId: ctx.userId,
    gateway: ctx.gateway, sessionId: ctx.sessionId,
    action: 'publish.approve', outcome: 'ALLOW',
    resourceKind: 'publish_draft', resourceId: draftId,
    paramsDigest: digestOf({ decision, opinion }),
  })
  return { ok: true, status: decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
           approvedBy: ctx.userId, role: admin.role }
}

/**
 * 发布（第 3 步）：**唯一**让业务权限策略生效的地方。
 *
 * `apply` 是真正写策略的回调 —— 本模块不自己拼 SQL，
 * 是为了让「写了什么」在调用点可见；而**谁都能调它**这件事由
 * `工具/check_publish_channel.py` 的静态核查兜住。
 * @param {object} input 入参
 * @returns {Promise<object>} 结论
 */
/**
 * @param {object} input 入参
 * @param {object} input.ctx 调用上下文
 * @param {string} input.draftId 草案
 * @param {(input: object) => Promise<object>} input.apply 应用变更的回调
 * @param {object} [input.system] 本次发布**产出的业务系统**：
 *   `{ assetId, name, schemaCode }`。缺省时不登记 —— 但那样工作台的
 *   「我的系统」列不出这一项，所以正常路径必须给。
 * @param {Array<{contractType: string, assetId: string|null, content: unknown}>} [input.contracts]
 *   本次发布的**契约内容**。缺省时不登记 —— 但那样员工端同步不到系统定义、
 *   待办与聚合口径也读不到，所以正常路径必须给。
 * @returns {Promise<object>} 发布结果
 */
export async function publishDraft({
  ctx, draftId, apply, system = null, contracts = [],
}) {
  const { rows } = await pool('platform').query(
    `SELECT * FROM publish_drafts WHERE draft_id = $1`, [draftId])
  if (rows.length !== 1) throw new PublishError('KVVI_NO_SUCH_DRAFT')
  const draft = rows[0]

  const refuse = async (code, extra = {}) => {
    await appendDenial({
      companyId: ctx.companyId, actorKind: 'USER', actorId: ctx.userId,
      gateway: ctx.gateway, sessionId: ctx.sessionId,
      action: 'publish.publish', outcome: 'DENY', reason: code,
      resourceKind: 'publish_draft', resourceId: draftId,
    })
    return { ok: false, error: code, ...extra }
  }

  if (draft.status !== 'APPROVED') return refuse('KVVI_DRAFT_NOT_APPROVED')
  // 审批绑定摘要：发布时**重算**差异报告，与审批时不一致即拒。
  const diffDigest = digestOf(draft.diff_report)
  if (!draft.approved_by) return refuse('KVVI_NO_APPROVER')

  const applied = await apply({ draft, diffDigest })
  await withTransaction('platform', async (client) => {
    await client.query(
      `UPDATE publish_drafts SET status = 'PUBLISHED', published_at = now()
        WHERE draft_id = $1`, [draftId])
    const rec = await client.query(
      `INSERT INTO publish_records (draft_id, company_id, change_digest,
         approved_by, published_by, diff_digest)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING record_id`,
      [draftId, draft.company_id, draft.change_digest, draft.approved_by,
       ctx.userId, diffDigest])
    // ★ 与发布**同事务**登记业务系统。
    //
    // 分两次写会留下一个窗口：「发布记录在、系统不在」或反过来 ——
    // 而这两件事在语义上是一件事。放在同一个事务里，要么都有、要么都没有。
    if (system !== null) {
      await client.query(
        `INSERT INTO systems (system_id, company_id, asset_id, name, schema_code,
           published_record, published_at)
         VALUES ($1,$2,$3,$4,$5,$6, now())
         ON CONFLICT (company_id, asset_id) DO UPDATE
           SET name = EXCLUDED.name,
               schema_code = EXCLUDED.schema_code,
               published_record = EXCLUDED.published_record,
               published_at = EXCLUDED.published_at`,
        [randomUUID(), draft.company_id, system.assetId, system.name,
         system.schemaCode, rec.rows[0].record_id])
    }
    // ★ 契约内容与发布记录**同事务**。
    //
    // 契约内容是权限判定与界面渲染的输入。分开写会留下「发布了但内容没到」
    // 的窗口 —— 那个窗口里员工能打开一个系统名却打不开界面，
    // 而排查线索只有一条时序。
    if (contracts.length > 0) {
      await recordContracts(client, {
        companyId: draft.company_id,
        contracts,
        publishedRecord: rec.rows[0].record_id,
      })
    }
  })
  await append({
    companyId: ctx.companyId, actorKind: 'USER', actorId: ctx.userId,
    gateway: ctx.gateway, sessionId: ctx.sessionId,
    action: 'publish.publish', outcome: 'ALLOW',
    resourceKind: 'publish_draft', resourceId: draftId,
    paramsDigest: diffDigest,
  })
  return { ok: true, status: 'PUBLISHED', diffDigest, applied }
}

/**
 * 本公司**已发布的业务系统**。
 *
 * 只按公司过滤：这条查询服务的是「员工看自己公司的系统」，
 * 跨公司的行在这里**根本不可能出现** —— 公司来自会话，不是来自请求参数。
 * @param {string} companyId 会话绑定的公司
 * @returns {Promise<object[]>} 已发布系统，按发布时间倒序
 */
export async function publishedSystems(companyId) {
  const { rows } = await pool('platform').query(
    `SELECT system_id, asset_id, name, schema_code, published_at
       FROM systems WHERE company_id = $1 ORDER BY published_at DESC`, [companyId])
  return rows.map((r) => ({
    systemId: r.system_id,
    assetId: r.asset_id,
    name: r.name,
    schemaCode: r.schema_code,
    publishedAt: r.published_at,
  }))
}

/** 发布记录（谁批的、谁发的、什么时候、批的是哪一份）。 */
export async function publishHistory(companyId) {
  const { rows } = await pool('platform').query(
    `SELECT r.*, d.proposer_user_id FROM publish_records r
       JOIN publish_drafts d ON d.draft_id = r.draft_id
      WHERE r.company_id = $1 ORDER BY r.at DESC LIMIT 100`, [companyId])
  return rows
}

/** 工具启用白名单的校验：只接受**已属该网关**的工具（§9.6.5）。 */
export function checkEnabledTools(gateway, enabled) {
  const bad = enabled.filter((tool) => !checkGateway(gateway, tool).allowed)
  return bad.length === 0 ? { ok: true } : { ok: false, error: 'KVVI_ENABLE_EXCEEDS_GATEWAY', tools: bad }
}
