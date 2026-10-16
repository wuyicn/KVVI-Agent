/**
 * 发布通道的**入口**。
 *
 * ── 为什么需要这个文件 ──────────────────────────────────────────────────
 *
 * `publish.mjs` 从第一天起就实现了完整的发布通道 —— 差异报告、审批、发布、
 * 与发布记录同事务地登记系统与契约。它有 4 个测试文件、跑了整条回路。
 *
 * **然后没有任何东西调用它。** 全仓搜 `submitDraft` / `approveDraft` / `publishDraft`，
 * 非测试命中：零。没有 HTTP 路由、没有界面、没有 Agent 工具 ——
 * 一个实现完整、测试全绿、**不可达**的功能。
 *
 * 症状是：搭建者把系统搭出来了、契约校验通过了，而「发布」这一步
 * 在界面和接口上都找不到。搭建者自己也知道自己不该发布，它在交付说明里写
 * 「发布要你在工作台里做」—— 而工作台里那个按钮不存在。
 *
 * 本模块补的就是这一段：三个动作各一条路由，加上把契约编译成策略的那一步
 * （见 `policy-compile.mjs`，那一步此前也不存在）。
 *
 * ── 提交人与审批人的分离在这里落地 ──────────────────────────────────────
 *
 * §9.6.1「不能自审批」由 `approveDraft` 自己判（`checkSelfApproval`），
 * 本模块**不重复判**，但两件准入必须在这里做：
 *
 *   - 提交：**必须是搭建者会话**。搭建是搭建者的动作，员工会话提交发布，
 *     等于把「搭建」这件事从别的入口放进来。
 *   - 审批与发布：**必须是所有者**。发布把未审批的权限策略变成生效的策略，
 *     它只能是所有者的动作。
 */
import { createHash } from 'node:crypto'
import { pool, withTransaction } from './db.mjs'
import { latestContract } from './contracts.mjs'
import { compilePermissionSpec, CompileError } from './policy-compile.mjs'
import { PublishError, buildDiffReport, submitDraft, approveDraft, publishDraft, writePolicies }
  from './publish.mjs'
import { holdsPlatformRole, isPlatformAdmin } from './authorization.mjs'
import { bindBuildIntent } from './business-build-intents.mjs'
import { requireDirectoryBuilder } from './business-directory.mjs'

/** 发布要的六份契约。与 `runtime-projection.REQUIRED_CONTRACTS` 同源。 */
export const PUBLISH_CONTRACTS = Object.freeze([
  'business-schema', 'view-schema', 'workflow-spec', 'permission-spec',
  'tool-spec', 'app-model-command',
])

const fail = (status, error, detail = {}) => ({ status, body: { error, ...detail } })

/**
 * 与 `contracts.mjs`、`publish.mjs` 同一算法的内容摘要。
 * **必须同算法** —— 换算法会让这里的查重与那边的记录比对失去意义。
 * @param {unknown} value 要摘要的值
 * @returns {string} `sha256:…`
 */
function digestOf(value) {
  return 'sha256:' + createHash('sha256')
    .update(JSON.stringify(value)).digest('hex')
}

/**
 * 读本公司最新已发布的策略，作为差异报告的「变更前」。
 * @param {string} companyId 公司
 * @returns {Promise<object[]>} 策略行
 */
async function currentPolicies(companyId) {
  const { rows } = await pool('platform').query(
    `SELECT p.dimension, p.resource_code, r.role_code, p.actions,
            p.data_scopes, p.field_visibility
       FROM policies p JOIN roles r ON r.role_id = p.role_id
      WHERE p.company_id = $1`, [companyId])
  return rows
}

/**
 * 解析一份提交：把契约里的策略编译成行，并算出差异报告。
 *
 * @param {object} input 入参
 * @param {object} input.session 会话
 * @param {string} input.assetId 系统代号
 * @param {object} input.contracts 契约内容 `{contractType: content}`
 * @returns {Promise<object>} `{rows, diffReport, notEnforced, missing}`
 */
export async function prepareDraft({ session, assetId, contracts }) {
  const missing = PUBLISH_CONTRACTS.filter((t) => contracts?.[t] === undefined)
  if (missing.length > 0) {
    // ⚠️ 少一份就拒，不「先发着」。`runtime-projection` 的 REQUIRED_CONTRACTS
    //    对同一个问题是同一句话：少一份说明这次发布不构成一个可运行系统。
    throw new CompileError('KVVI_PUBLISH_CONTRACTS_INCOMPLETE',
      { assetId, missing })
  }

  const { rows: roleRows } = await pool('platform').query(
    'SELECT role_id, role_code FROM roles WHERE company_id = $1', [session.companyId])
  const roleIds = Object.fromEntries(roleRows.map((r) => [r.role_code, r.role_id]))

  const compiled = compilePermissionSpec(contracts['permission-spec'], { roleIds })
  const before = await currentPolicies(session.companyId)
  const after = compiled.rows.map((r) => ({
    dimension: r.dimension,
    resource_code: r.resourceCode,
    role_code: roleRows.find((x) => x.role_id === r.roleId)?.role_code ?? null,
    actions: r.actions, data_scopes: r.dataScopes, field_visibility: r.fieldVisibility,
  }))
  return {
    rows: compiled.rows,
    notEnforced: compiled.notEnforced,
    diffReport: buildDiffReport(before, after),
    missing: [],
  }
}

/**
 * 提交一份发布草案（第 1 步）。
 * @param {object} input 入参
 * @returns {Promise<object>} `{status, body}`
 */
export async function publishSubmit({ session, payload }) {
  // 只有搭建者会话能提交。**这是模式绑定的用处**：网关在会话创建时就定了，
  // 调用方改不了，所以「谁在提交」不是一句口头约定。
  if (session.gateway !== 'BUILDER') {
    return fail(403, 'KVVI_BUILDER_SESSION_REQUIRED',
      { gateway: session.gateway })
  }
  const assetId = payload?.assetId
  if(payload?.buildIntentId!==undefined) await requireDirectoryBuilder(session)
  if (typeof assetId !== 'string' || assetId === '') {
    return fail(400, 'KVVI_ASSET_ID_REQUIRED')
  }

  let prepared
  try {
    prepared = await prepareDraft({ session, assetId, contracts: payload?.contracts })
  } catch (error) {
    if (error instanceof CompileError) {
      return fail(400, error.code, error.detail)
    }
    throw error
  }

  const ctx = { ...session }
  const change = { assetId, contracts: Object.keys(payload.contracts).sort(),
    policyDigest: JSON.stringify(prepared.rows) }
  let draft
  try {
    draft = await submitDraft({
      ctx,
      afterInsert: payload?.buildIntentId===undefined?undefined:(client,draftId)=>bindBuildIntent(client,session,{intentId:payload.buildIntentId,draftId}),
      change,
      diffReport: prepared.diffReport,
      // §9.8.1 的聚合差分不变量：本版没有独立求值器（`goal` 那一侧同样记着
      // 「No independent evaluator」）。**不假装它通过了** —— 传 `null`
      // 让 `submitDraft` 明白「这次没有求值」，而不是传 `{ok:true}` 让它以为有。
      invariant: null,
      // ★ **要发布的内容，提交时就存下来。**
      //   发布那一步只认草案里的这一份，审批人不必、也无法重新提供内容 ——
      //   否则「批的」与「发的」中间那道缝只能靠 `change_digest` 一个人守，
      //   而摘要是单向的：它证明两样东西相同，不提供那两样东西。
      payload: {
        assetId,
        name: payload?.name ?? assetId,
        schemaCode: payload?.schemaCode ?? assetId,
        rows: prepared.rows,
        notEnforced: prepared.notEnforced,
        // 契约内容也存下来 —— 发布时按它登记，不再向调用方要一次。
        contracts: payload.contracts,
      },
    })
  } catch (error) {
    // ⚠️ **判据是「这是不是一个领域错误」，不是「它有没有 `code`」。**
    //
    // 我第一版写的是 `if (error?.code !== undefined)` —— 而 **PostgreSQL 的错误
    // 也有 `code`**（唯一冲突是 `23505`），而且 `error.detail` 是**中文字符串**
    // （`键值 "(company_id, change_digest)=(…)" 重复`）。
    // 于是它被当成领域错误，`{ error, ...detail }` 把一个字符串展开成
    // `{"0":"键","1":"值",…}` —— 客户拿到的是一份逐字符的响应。
    if (error instanceof PublishError) {
      return fail(400, error.code, error.detail ?? {})
    }
    // 唯一冲突：**同一份变更已经有一张开着的草案**。
    // 这是那条唯一索引（`publish_drafts_one_open`）在说话，不是故障 ——
    // 「同一份变更别提两次」是对的，而重跑一次脚手架**不该失败**。
    // 所以把已有的那张交回去，由调用方决定是继续用它还是先撤掉。
    if (error?.code === '23505') {
      const { rows } = await pool('platform').query(
        `SELECT draft_id, status FROM publish_drafts
          WHERE company_id = $1 AND change_digest = $2
            AND status IN ('DRAFT', 'AWAITING_APPROVAL') LIMIT 1`,
        [session.companyId, digestOf(change)])
      if (rows.length === 1) {
        if(payload?.buildIntentId!==undefined) await withTransaction('platform',c=>bindBuildIntent(c,session,{intentId:payload.buildIntentId,draftId:rows[0].draft_id}))
        return { status: 200, body: {
          draftId: rows[0].draft_id, status: rows[0].status,
          reused: true, error: 'KVVI_DRAFT_ALREADY_OPEN',
          changeDigest: digestOf(change), assetId,
          notEnforced: prepared.notEnforced,
          diffReport: { counts: prepared.diffReport.counts, faces: prepared.diffReport.faces },
        } }
      }
    }
    throw error
  }
  return { status: 201, body: {
    draftId: draft.draftId, status: draft.status,
    // ★ 把变更摘要交回给提交人：审批与发布那两步要带着它，
    //   否则「批的必须是这一份」就没有可核对的凭据。
    changeDigest: draft.changeDigest,
    assetId,
    // ★ 把「契约里有、而运行时执行不了」的那些**当场交回给提交人**。
    //   不问就不说，等于把「已声明 ≠ 已生效」留给下一次发布去发现。
    notEnforced: prepared.notEnforced,
    diffReport: {
      counts: prepared.diffReport.counts,
      faces: prepared.diffReport.faces,
    },
  } }
}

/**
 * 审批（第 2 步）。**必须是所有者**，且不能是提交人本人。
 * @param {object} input 入参
 * @returns {Promise<object>} `{status, body}`
 */
export async function publishApprove({ session, draftId, payload }) {
  // ⚠️ **所有者**，不是「管理员」。管理员能管成员与角色；
  //    而发布是把未审批的权限策略变成生效的策略 —— 那是所有者的动作。
  //    用 `isPlatformAdmin` 一个判据会让被委托的管理员也能发布，
  //    而「谁能管理」与「谁能发布」在 §3.1 里是两件事。
  if (!await holdsPlatformRole(session.companyId, session.userId, 'owner')) {
    return fail(403, 'KVVI_NOT_OWNER')
  }
  const decision = payload?.decision ?? 'APPROVE'

  // ⚠️ **审批人必须说出自己在批哪一份。**
  //
  // `approveDraft` 的这条判据是 `digestOf(change) !== draft.change_digest` ——
  // 它要的是一个**完整变更对象**。而审批人手上没有那个对象：他看的是
  // 差异报告，不是构造差异报告的输入。所以那一头传 `change: undefined`
  // （`publish.mjs` 有意容忍），而**在这里用提交时就存下的摘要补上这一问**。
  //
  // 少了这一问，「批的必须是这一份」就只剩一句注释：审批人可以拿 A 的草案号
  // 去批 B 的内容，而两边的差异报告看起来都像模像样。
  const stored = await pool('platform').query(
    'SELECT change_digest FROM publish_drafts WHERE draft_id = $1 AND company_id = $2',
    [draftId, session.companyId])
  if (stored.rows.length !== 1) return fail(404, 'KVVI_NO_SUCH_DRAFT')
  const claimed = payload?.changeDigest
  if (typeof claimed !== 'string' || claimed === '') {
    return fail(400, 'KVVI_APPROVAL_DIGEST_REQUIRED', {
      changeDigest: stored.rows[0].change_digest,
      detail: '审批要带上 changeDigest：审批人必须说出自己在批哪一份。',
    })
  }
  if (claimed !== stored.rows[0].change_digest) {
    return fail(409, 'KVVI_APPROVAL_DIGEST_MISMATCH', {
      expected: stored.rows[0].change_digest,
    })
  }

  const result = await approveDraft({
    ctx: { ...session }, draftId, decision,
    opinion: payload?.opinion ?? null, change: undefined,
  })
  if (result?.ok === false) return fail(409, result.error)
  return { status: 200, body: result }
}

/**
 * 发布（第 3 步）。**必须是所有者。**
 *
 * `apply` 就是那条一直没接上的线：把编译好的策略写进 `policies`。
 * 它与发布记录、系统登记、契约内容**同一个事务**（由 `publishDraft` 保证）。
 * @param {object} input 入参
 * @returns {Promise<object>} `{status, body}`
 */
export async function publishCommit({ session, draftId, payload }) {
  if (!await holdsPlatformRole(session.companyId, session.userId, 'owner')) {
    return fail(403, 'KVVI_NOT_OWNER')
  }

  // ★ **内容来自草案，不来自这一次请求。**
  //   发布用的一定是提交时存下的那一份 —— 请求体里带什么都不能改变它。
  const { rows: draftRows } = await pool('platform').query(
    `SELECT payload FROM publish_drafts WHERE draft_id = $1 AND company_id = $2`,
    [draftId, session.companyId])
  if (draftRows.length !== 1) return fail(404, 'KVVI_NO_SUCH_DRAFT')
  const stored = draftRows[0].payload ?? {}
  if (stored.assetId === undefined || !Array.isArray(stored.rows)) {
    return fail(409, 'KVVI_DRAFT_PAYLOAD_MISSING',
      { detail: '这张草案里没有要发布的内容（它可能是改造之前提交的）。重新提交一次。' })
  }
  const assetId = stored.assetId
  const contracts = stored.contracts ?? {}
  const prepared = { rows: stored.rows, notEnforced: stored.notEnforced ?? [] }

  const result = await publishDraft({
    ctx: { ...session },
    draftId,
    // ★ 写策略的 SQL **不在这里**（见 `publish.mjs` 的 `writePolicies`）。
    //   这条路径上写库只发生在那个函数里，而它住在发布模块内部 ——
    //   `工具/check_publish_channel.py` 静态盯着「产品代码里只有发布模块写得动
    //   策略存储」这件事（§9.6.3）。把 SQL 搬到路由里等于给这条保证开第二个口子。
    // ★ **策略的写入不在这里** —— 见 `publish.mjs` 的 `writePolicies`。
    //   写策略的 SQL 只能有一处，而那一处是 `publish.mjs`；
    //   `工具/check_publish_channel.py` 静态盯着这件事（§9.6.3）。
    apply: async ({ client }) => {
      const written = await writePolicies({
        client, companyId: session.companyId, assetId, rows: prepared.rows,
      })
      return { ...written, notEnforced: prepared.notEnforced.length }
    },
    system: {
      assetId,
      name: stored.name ?? assetId,
      schemaCode: stored.schemaCode ?? assetId,
    },
    contracts: PUBLISH_CONTRACTS.map((contractType) => ({
      contractType, assetId, content: contracts[contractType],
    })),
  })
  if (result?.ok === false) return fail(409, result.error)
  return { status: 201, body: { ...result, notEnforced: prepared.notEnforced } }
}

/**
 * 列出本公司最近的草案。**没有界面的时候，这一条就是「发布到哪一步了」的全部答案。**
 * @param {object} input 入参
 * @returns {Promise<object>} `{status, body}`
 */
export async function publishList({ session }) {
  const { rows } = await pool('platform').query(
    `SELECT d.draft_id, d.status, d.change_digest, d.created_at, d.approved_by,
            d.published_at, u.login AS proposer
       FROM publish_drafts d JOIN users u ON u.user_id = d.proposer_user_id
      WHERE d.company_id = $1 ORDER BY d.created_at DESC LIMIT 50`,
    [session.companyId])
  return { status: 200, body: { items: rows } }
}

/**
 * 读一条草稿的差异报告 —— **审批人必须能看到自己在批什么**（§9.6.6）。
 * @param {object} input 入参
 * @returns {Promise<object>} `{status, body}`
 */
export async function publishDetail({ session, draftId }) {
  const { rows } = await pool('platform').query(
    // ⚠️ 列名是 `approval_opinion`，不是 `opinion`。
    //    这条路由此前**一条测试都没有**，于是「选了一个不存在的列」这件事
    //    一直躺在那里 —— 直到补上入口测试才当场变红。
    `SELECT draft_id, status, change_digest, diff_report, invariant, created_at,
            approved_by, approved_at, approval_opinion, published_at
       FROM publish_drafts WHERE draft_id = $1 AND company_id = $2`,
    [draftId, session.companyId])
  if (rows.length !== 1) return fail(404, 'KVVI_NO_SUCH_DRAFT')
  return { status: 200, body: rows[0] }
}

/**
 * 分派 `/api/v1/publish/*`。
 * @param {object} input `{method, path, payload, session}`，`path` 已去掉 `/publish`
 * @returns {Promise<object|null>} 应答，或 `null` 表示不是本模块的路径
 */
export async function publishRoutes({ method, path, payload, session }) {
  const parts = path.split('/').filter((p) => p !== '')
  const head = parts[0]
  if (head === 'drafts' && parts.length === 1) {
    if (method === 'GET') return await publishList({ session })
    if (method === 'POST') return await publishSubmit({ session, payload })
  }
  if (head === 'drafts' && parts.length >= 2) {
    const draftId = decodeURIComponent(parts[1])
    if (parts.length === 2 && method === 'GET') return await publishDetail({ session, draftId })
    if (parts.length === 3 && parts[2] === 'approve' && method === 'POST') {
      return await publishApprove({ session, draftId, payload })
    }
    if (parts.length === 3 && parts[2] === 'publish' && method === 'POST') {
      return await publishCommit({ session, draftId, payload })
    }
  }
  if (head === 'contracts' && method === 'GET' && parts.length === 2) {
    // 让 CLI 能确认「平台上这一版系统有哪些契约」，而不是只看工作区的文件。
    const assetId = decodeURIComponent(parts[1])
    const items = []
    for (const contractType of PUBLISH_CONTRACTS) {
      const latest = await latestContract(session.companyId, contractType, assetId)
      items.push({ contractType, version: latest?.version ?? null, digest: latest?.digest ?? null })
    }
    return { status: 200, body: { assetId, items } }
  }
  return null
}
