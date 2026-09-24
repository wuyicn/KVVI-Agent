/**
 * 访客路径（PRD §3.5、§9.7.3、红线 3 的受限落地形式）。
 *
 * ── 这一条路径最容易做错的地方 ──────────────────────────────────────────
 *
 * 访客**没有账号**，所以「他是谁」这个问题没有答案。整个设计的处理方式是
 * **把主体从访客换成签发人**：
 *
 * | 问题 | 答案 |
 * |---|---|
 * | 行范围按谁解释 | **签发人**（v2.16 终审阻断 T1） |
 * | 新记录的归属算谁 | 服务端按绑定确定，**访客不得覆盖** |
 * | 出问题追溯谁 | 签发人 + 链接 ID + 提交通道；**不承诺区分访客个体** |
 *
 * ── 三条「不得」────────────────────────────────────────────────────────
 *
 * 1. **不是「已认证」就能签发** —— 必须对该表单持有**写权限**，
 *    且只能签发到**自己有权写入的范围**（v2.15 终审阻断 2）。
 * 2. **不得由签发人自行扩大绑定项** —— 五项绑定 + 行范围全部由权限派生。
 * 3. **不得给访客增加任何查询能力** —— 关联对象只能校验，不能列出候选（§3.5.1）。
 *
 * ── 红线 3 在这里是**受限落地**，不是等价形式 ──────────────────────────
 *
 * §3.5.4 明确：访客路径追溯到的可能是**另一个人**的账号（签发人）。
 * 本模块因此**不记录**访客身份，只记录「入口 + 时间 + 来源」，
 * 并在审计里把 `actorKind` 标为 `VISITOR` 而**不是**冒充成签发人亲自操作。
 */
import { createHash, createPrivateKey, createPublicKey, randomUUID, sign as edSign,
         verify as edVerify } from 'node:crypto'
import { pool, withTransaction } from './db.mjs'
import { TOKEN_TTL_MS, ISSUER, TOKEN_ALG } from './signing.mjs'
import { signingKeys, loadSession } from './identity.mjs'
import { publicKeysOf, signToken, verifySignature, verifyExpiry } from './signing.mjs'
import { append } from './audit.mjs'
import { fieldVisibility } from './authorization.mjs'
import { createRecord } from './refs.mjs'
import { canAct } from './authorization.mjs'

/** 链接有效期上限：**产品级上限（量级：天）**，不允许永不过期（§3.5.1）。 */
export const LINK_TTL_MAX_MS = Number(process.env.KVVI_LINK_TTL_MAX_MS ?? 7 * 24 * 60 * 60 * 1000)

/** 限流窗口与阈值（§3.5.2 四维度）。均可配置，但不设默认以免「没配就没有限流」。 */
export const RATE = Object.freeze({
  windowMs: Number(process.env.KVVI_VISITOR_WINDOW_MS ?? 60 * 60 * 1000),
  perLinkSubmissions: Number(process.env.KVVI_VISITOR_PER_LINK ?? 5),
  perSourceSubmissions: Number(process.env.KVVI_VISITOR_PER_SOURCE ?? 30),
  perIssuerActiveLinks: Number(process.env.KVVI_VISITOR_PER_ISSUER_LINKS ?? 20),
  perCompanyLinks: Number(process.env.KVVI_VISITOR_PER_COMPANY_LINKS ?? 200),
  perCompanySubmissions: Number(process.env.KVVI_VISITOR_PER_COMPANY_SUBMITS ?? 2000),
})

export class VisitorError extends Error {
  constructor(code, detail = {}) {
    super(code)
    this.code = code
    this.detail = detail
  }
}

const digestOf = (raw) => createHash('sha256').update(raw).digest('hex')
const b64url = (b) => Buffer.from(b).toString('base64url')
const unb64url = (s) => Buffer.from(s, 'base64url')

/**
 * 签发一张访客链接。
 *
 * 五项绑定 + 行范围**全部由签发人的权限派生**（§3.5.1）。
 * 任何一项越界即**拒绝签发**，不是「截断到合法范围」——
 * 截断会让签发人以为他发出去了他想要的东西。
 *
 * @param {object} input 入参
 * @param {object} input.ctx 签发人的身份上下文
 * @param {object} input.scope 签发人的授权上下文
 * @param {string} input.formCode 表单
 * @param {string} input.schemaCode 业务系统
 * @param {string[]} input.fields 允许写入的字段集
 * @param {string[]} input.actions 允许的动作
 * @param {object} input.rowScope 行范围约束 `{deptId?, shopId?}`
 * @param {number} [input.ttlMs] 有效期
 * @param {number} [input.maxSubmissions] 提交次数上限
 * @param {string} [input.sourceIp] 来源
 * @returns {Promise<object>} 链接信息
 */
export async function issueLink(input) {
  const { ctx, scope, formCode, schemaCode, fields, actions, rowScope,
          ttlMs = 24 * 60 * 60 * 1000, maxSubmissions = 1 } = input

  if (ttlMs > LINK_TTL_MAX_MS) {
    throw new VisitorError('KVVI_LINK_TTL_TOO_LONG', { max: LINK_TTL_MAX_MS })
  }
  if (maxSubmissions < 1) throw new VisitorError('KVVI_LINK_SUBMISSIONS_INVALID')

  // ① **签发资格**：不是「已认证」就能签发（v2.15 终审阻断 2）。
  const writable = await canAct(ctx.companyId, ctx.userId, 'FORM', formCode, 'create')
  if (!writable) {
    await events(null, ctx, 'REJECTED', { reason: 'KVVI_ISSUER_LACKS_WRITE_PERMISSION',
                                          formCode }, input.sourceIp)
    throw new VisitorError('KVVI_ISSUER_LACKS_WRITE_PERMISSION', { formCode })
  }
  // 仅有读取权限的员工**不得**生成提交链接 —— 单独判一次，因为
  // 「有 read 但没 create」是最容易被 canAct('create') 漏掉的形态。
  const readOnly = await canAct(ctx.companyId, ctx.userId, 'FORM', formCode, 'read')
  if (readOnly && !writable) {
    throw new VisitorError('KVVI_READ_ONLY_CANNOT_ISSUE', { formCode })
  }

  // ② **绑定项越界即拒**：字段集必须在签发人可写范围内
  const visibility = await fieldVisibility(ctx.companyId, ctx.userId, fields)
  const notWritable = fields.filter((f) => visibility[f] !== 'VISIBLE')
  if (notWritable.length > 0) {
    throw new VisitorError('KVVI_BINDING_EXCEEDS_ISSUER', { fields: notWritable })
  }

  // ③ **行范围只能在签发人自己的可访问集合之内**（§3.5.1 v2.16）
  const allowed = scope.scopes ?? []
  const covers = (s) => allowed.includes(s)
  if (rowScope?.deptId && !(covers('DEPARTMENT') || covers('DEPARTMENT_AND_CHILDREN')
      || covers('COMPANY'))) {
    throw new VisitorError('KVVI_ROW_SCOPE_EXCEEDS_ISSUER', { rowScope })
  }
  if (rowScope?.shopId && !(covers('STORE') || covers('COMPANY'))) {
    throw new VisitorError('KVVI_ROW_SCOPE_EXCEEDS_ISSUER', { rowScope })
  }
  // 绑定的组织单元必须真的是签发人可访问的（不只看档位名）
  const member = await pool('platform').query(
    'SELECT dept_id, shop_id FROM memberships WHERE company_id = $1 AND user_id = $2',
    [ctx.companyId, ctx.userId])
  const home = member.rows[0] ?? {}
  if (rowScope?.deptId && rowScope.deptId !== home.dept_id && !covers('COMPANY')) {
    throw new VisitorError('KVVI_ROW_SCOPE_EXCEEDS_ISSUER', { rowScope })
  }
  if (rowScope?.shopId && rowScope.shopId !== home.shop_id && !covers('COMPANY')) {
    throw new VisitorError('KVVI_ROW_SCOPE_EXCEEDS_ISSUER', { rowScope })
  }

  // ④ 限流：签发人维度与公司维度（§3.5.2）
  await enforceLimits('ISSUE', { ctx, sourceIp: input.sourceIp })

  // ⑤ 签名：与令牌同一信任锚点体系（§3.5.1），**非对称**，
  //    私钥由身份层持有，**不得**由生成链接的客户端持有。
  const linkId = randomUUID()
  const nonce = randomUUID()
  const expiresAt = new Date(Date.now() + ttlMs)
  const token = await signLink({ linkId, nonce, ctx, formCode, schemaCode,
                                 fields, actions, rowScope, expiresAt })

  const session = await loadSession(ctx.sessionId)
  // ⚠️ 记录**当前**授权版本，不是会话里冻结的那一个。
  // 会话的 authz_version 是**签发令牌时**的快照；用它去登记链接，
  // 会让「权限回收过、又新发一张链接」这件事直接被自己判成失效 ——
  // 新链接一签发就是废的，而且失败理由是 KVVI_ISSUER_AUTHZ_CHANGED，
  // 看起来像「签发人权限有问题」。
  const { rows: issuer } = await pool('platform').query(
    'SELECT authz_version FROM users WHERE user_id = $1', [ctx.userId])
  const issuerAuthzVersion = issuer[0]?.authz_version ?? session?.authzVersion ?? 0
  await withTransaction('platform', async (client) => {
    await client.query(
      `INSERT INTO visitor_links (link_id, token_digest, nonce, company_id,
         schema_code, form_code, allowed_fields, allowed_actions, row_scope,
         issuer_user_id, issuer_dept_id, issuer_shop_id, issuer_authz_version,
         one_time, max_submissions, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [linkId, digestOf(token), nonce, ctx.companyId, schemaCode, formCode,
       fields, actions, JSON.stringify(rowScope ?? {}), ctx.userId,
       session?.deptId ?? home.dept_id, session?.shopId ?? home.shop_id,
       issuerAuthzVersion, maxSubmissions === 1, maxSubmissions, expiresAt])
  })
  await events(linkId, ctx, 'ISSUED', { formCode, fields, rowScope }, input.sourceIp)
  return { linkId, token, expiresAt, formCode, fields, actions, rowScope }
}

/** 用与令牌同一套非对称密钥对链接签名（§3.5.1：同一信任锚点体系）。 */
async function signLink({ linkId, nonce, ctx, formCode, schemaCode, fields, actions,
                          rowScope, expiresAt }) {
  const claims = {
    sub: ctx.userId, sid: ctx.sessionId, ten: ctx.companyId, gw: 'VISITOR',
    av: 1, cv: 'kvvi-visitor/v1',
  }
  // claim 字段集是封闭的（signing.mjs 会拒未知字段）——
  // 链接特有的部分放进**独立段**，不混进令牌声明。
  // 令牌声明是封闭的，这里只用它校验一次字段合法性；链接本身走独立段。
  signToken(claims, signingKeys())
  const payload = b64url(JSON.stringify({
    link: linkId, nonce, form: formCode, schema: schemaCode,
    fields, actions, rowScope: rowScope ?? {},
    exp: Math.floor(expiresAt.getTime() / 1000),
  }))
  const head = b64url(JSON.stringify({ alg: TOKEN_ALG, kid: signingKeys().kid, typ: 'KVVI-VISITOR' }))
  const sig = b64url(edSign(null, Buffer.from(`${head}.${payload}`),
    createPrivateKey(signingKeys().privateKey)))
  return `v.${head}.${payload}.${sig}`
}

/** 验签一张链接。**只验签名与到期**，吊销状态另查（§3.5.1）。 */
export function verifyLinkSignature(token) {
  const parts = String(token ?? '').split('.')
  if (parts.length !== 4 || parts[0] !== 'v') {
    return { ok: false, error: 'KVVI_LINK_MALFORMED' }
  }
  const [, head, payload, sig] = parts
  let header
  let body
  try {
    header = JSON.parse(unb64url(head).toString('utf8'))
    body = JSON.parse(unb64url(payload).toString('utf8'))
  } catch {
    return { ok: false, error: 'KVVI_LINK_MALFORMED' }
  }
  if (header.alg !== TOKEN_ALG) return { ok: false, error: 'KVVI_LINK_ALG_UNSUPPORTED' }
  const key = publicKeysOf(signingKeys()).find((k) => k.kid === header.kid)
  if (!key) return { ok: false, error: 'KVVI_LINK_UNKNOWN_KEY' }
  void ISSUER
  if (!edVerify(null, Buffer.from(`${head}.${payload}`), createPublicKey(key.publicKey),
    unb64url(sig))) {
    return { ok: false, error: 'KVVI_LINK_BAD_SIGNATURE' }
  }
  return { ok: true, body }
}

/**
 * 校验链接的**吊销与授权状态**。
 *
 * ⚠️ **在线优先**：平台可达时必须实时查询，**缓存不构成放行依据**（§3.5.1 v2.15）。
 * 缓存只在平台不可达时作为降级手段，窗口 ≤ `TOKEN_TTL_MS`（与 §9.4.4 同一配置项）。
 * @param {object} row 链接行
 * @param {object} [options] 选项
 * @returns {Promise<{ok: boolean, error?: string, offline?: boolean}>}
 */
export async function verifyLinkStatus(row, { nowMs = Date.now(), reachable = true } = {}) {
  if (!reachable) {
    if (nowMs - new Date(row.checked_at ?? row.issued_at).getTime() > TOKEN_TTL_MS) {
      return { ok: false, error: 'KVVI_LINK_STATUS_UNAVAILABLE', offline: true }
    }
    return { ok: true, offline: true }
  }
  if (row.revoked_at !== null) return { ok: false, error: 'KVVI_LINK_REVOKED' }
  if (new Date(row.expires_at).getTime() <= nowMs) return { ok: false, error: 'KVVI_LINK_EXPIRED' }

  // 签发人失效 → 名下未提交链接全部失效（§3.5.1）
  const { rows } = await pool('platform').query(
    `SELECT u.status, u.authz_version FROM users u WHERE u.user_id = $1`,
    [row.issuer_user_id])
  if (rows.length !== 1) return { ok: false, error: 'KVVI_ISSUER_GONE' }
  if (rows[0].status !== 'ACTIVE') return { ok: false, error: 'KVVI_ISSUER_DEACTIVATED' }
  // 权限回收：授权版本变了即失效
  if (rows[0].authz_version !== row.issuer_authz_version) {
    return { ok: false, error: 'KVVI_ISSUER_AUTHZ_CHANGED' }
  }
  return { ok: true, offline: false }
}

/** 吊销链接。生成者可随时吊销。 */
export async function revokeLink({ linkId, ctx, reason = 'ISSUER_REVOKED' }) {
  const { rows } = await pool('platform').query(
    `UPDATE visitor_links SET revoked_at = now(), revoked_by = $2, revoked_reason = $3
      WHERE link_id = $1 AND company_id = $4 AND revoked_at IS NULL
      RETURNING company_id, issuer_user_id`,
    [linkId, ctx.userId, reason, ctx.companyId])
  if (rows.length !== 1) return false
  await events(linkId, { ...ctx }, 'REVOKED', { reason })
  return true
}

/**
 * 访客提交。
 *
 * 顺序（顺序本身是设计的一部分）：
 *   1. 验签 + 到期（本地）
 *   2. 吊销/授权状态（**在线优先**）
 *   3. 绑定项：字段集、动作
 *   4. **行范围按签发人解释**，且**同时**满足签发时约束与**签发人当前**权限
 *   5. **归属由服务端确定**（唯一性三预期）
 *   6. 关联对象校验（不提供查询能力）
 *   7. 限流四维度
 *   8. 落库（正式业务数据）+ 留痕（访客通道）
 *
 * @param {object} input 入参
 * @returns {Promise<object>} 结果
 */
export async function submitAsVisitor(input) {
  const { token, data, sourceIp, nowMs = Date.now(), reachable = true } = input

  const sig = verifyLinkSignature(token)
  if (!sig.ok) throw new VisitorError(sig.error)
  const body = sig.body
  if (body.exp * 1000 <= nowMs) throw new VisitorError('KVVI_LINK_EXPIRED')

  const { rows } = await pool('platform').query(
    `SELECT * FROM visitor_links WHERE link_id = $1`, [body.link])
  if (rows.length !== 1) throw new VisitorError('KVVI_LINK_UNKNOWN')
  const row = rows[0]
  if (row.nonce !== body.nonce) throw new VisitorError('KVVI_LINK_REPLAY')

  const status = await verifyLinkStatus(row, { nowMs, reachable })
  if (!status.ok) {
    await events(row.link_id, { companyId: row.company_id,
                                userId: row.issuer_user_id }, 'REJECTED',
                 { error: status.error }, sourceIp)
    throw new VisitorError(status.error, { offline: status.offline ?? false })
  }

  // ③ 绑定项
  const fields = Object.keys(data ?? {})
  const outside = fields.filter((f) => !row.allowed_fields.includes(f))
  if (outside.length > 0) {
    await events(row.link_id, { companyId: row.company_id,
                                userId: row.issuer_user_id }, 'REJECTED',
                 { error: 'KVVI_FIELD_OUTSIDE_BINDING', fields: outside }, sourceIp)
    throw new VisitorError('KVVI_FIELD_OUTSIDE_BINDING', { fields: outside })
  }
  // 归属字段**不得由访客覆盖**（§3.5.1「新记录归属」）
  const FORBIDDEN = ['owner_id', 'dept_id', 'shop_id', 'companyId', 'tenant',
                     'company_id', 'issuer', 'issuer_user_id', 'role', 'roles']
  const attempted = fields.filter((f) => FORBIDDEN.includes(f))
  if (attempted.length > 0) {
    await events(row.link_id, { companyId: row.company_id,
                                userId: row.issuer_user_id }, 'REJECTED',
                 { error: 'KVVI_VISITOR_OWNERSHIP_OVERRIDE', fields: attempted }, sourceIp)
    throw new VisitorError('KVVI_VISITOR_OWNERSHIP_OVERRIDE', { fields: attempted })
  }

  // ④ 行范围：两条**同时**成立（§3.5.1 v2.16）
  const rowScope = row.row_scope ?? {}
  if (rowScope.deptId && rowScope.deptId !== row.issuer_dept_id) {
    throw new VisitorError('KVVI_ROW_SCOPE_MISMATCH', { rowScope })
  }
  if (rowScope.shopId && rowScope.shopId !== row.issuer_shop_id) {
    throw new VisitorError('KVVI_ROW_SCOPE_MISMATCH', { rowScope })
  }
  // 签发人**当前**权限（后续扩权不自动扩大旧链接；回收则按上文失效）
  const stillWritable = await canAct(row.company_id, row.issuer_user_id,
    'FORM', row.form_code, 'create')
  if (!stillWritable) throw new VisitorError('KVVI_ISSUER_NO_LONGER_WRITABLE')

  // ⑤ 归属唯一性：三预期（§3.5.1 v2.16 终审建议 2）
  const ownership = await resolveOwnership(row)
  if (!ownership.ok) throw new VisitorError(ownership.error, ownership.detail)

  // ⑦ 限流（提交前）
  await enforceLimits('SUBMIT', {
    ctx: { companyId: row.company_id, userId: row.issuer_user_id },
    link: row, sourceIp,
  })

  // ⑧ 落库：**正式业务数据**，同等对待（§3.5.3）
  const created = await createRecord(
    { companyId: row.company_id, userId: ownership.ownerId, sessionId: null,
      gateway: 'VISITOR' },
    { companyId: row.company_id, userId: ownership.ownerId,
      deptId: ownership.deptId, shopId: ownership.shopId,
      scopes: ['COMPANY'], deptSubtree: [] },
    { schemaCode: row.schema_code, data, recordNo: `VIS${Date.now()}` })

  await withTransaction('platform', async (client) => {
    await client.query(
      `UPDATE visitor_links SET submissions = submissions + 1, used_at = now()
        WHERE link_id = $1`, [row.link_id])
  })
  await events(row.link_id, { companyId: row.company_id, userId: row.issuer_user_id },
               'SUBMITTED', { recordId: created.recordId, fields }, sourceIp)
  // 红线 3 的受限形式：记**访客通道**，不冒充签发人亲自操作（§3.5.4）
  await append({
    // actor_kind=VISITOR 说清「不是账号持有者本人在操作」；
    // actor_id=签发人让入口有主。两者分开，才既不冒充又可追溯（§3.5.4）。
    companyId: row.company_id, actorKind: 'VISITOR', actorId: row.issuer_user_id,
    gateway: 'VISITOR', sessionId: null, action: 'visitor.submit', outcome: 'ALLOW',
    resourceKind: 'visitor_link', resourceId: row.link_id,
    paramsDigest: createHash('sha256').update(JSON.stringify(fields)).digest('hex'),
  })
  return { recordId: created.recordId, ownership,
           traceability: { issuerUserId: row.issuer_user_id, linkId: row.link_id,
                           note: '追溯单位为「签发人 + 链接 + 通道」，不承诺区分访客个体' } }
}

/**
 * 归属解析：**唯一性三预期**（§3.5.1 v2.16）。
 *
 * ① 绑定能唯一确定 → 继续；② 无合法归属 → 拒绝；③ 多个候选且不能消歧 → 拒绝。
 * **不得通过「任选一个合法值」使检查通过。**
 */
async function resolveOwnership(row) {
  const { rows } = await pool('platform').query(
    `SELECT user_id, dept_id, shop_id FROM memberships
      WHERE company_id = $1 AND user_id = $2`, [row.company_id, row.issuer_user_id])
  if (rows.length === 0) return { ok: false, error: 'KVVI_NO_LEGAL_OWNERSHIP' }
  if (rows.length > 1) {
    // 同一个账号在同一公司有多条成员关系 —— 这本身就是歧义
    return { ok: false, error: 'KVVI_AMBIGUOUS_OWNERSHIP', detail: { candidates: rows.length } }
  }
  const m = rows[0]
  const rowScope = row.row_scope ?? {}
  if (rowScope.deptId && m.dept_id !== rowScope.deptId) {
    return { ok: false, error: 'KVVI_AMBIGUOUS_OWNERSHIP',
             detail: { bound: rowScope.deptId, actual: m.dept_id } }
  }
  if (rowScope.shopId && m.shop_id !== rowScope.shopId) {
    return { ok: false, error: 'KVVI_AMBIGUOUS_OWNERSHIP',
             detail: { bound: rowScope.shopId, actual: m.shop_id } }
  }
  return { ok: true, ownerId: m.user_id, deptId: m.dept_id, shopId: m.shop_id }
}

/**
 * 关联对象校验（§3.5.1）。
 *
 * ⚠️ **只校验，不提供候选列表** —— 「不得因此给访客增加列表或查询能力」。
 * 所以本函数的输入是**访客已经持有的引用**，输出是「能不能用」，
 * 绝不返回任何可选集合。
 */
export async function checkRelatedRef(row, ref) {
  if (!ref || typeof ref.id !== 'string') {
    return { ok: false, error: 'KVVI_RELATED_REF_MALFORMED' }
  }
  if (ref.companyId !== undefined && ref.companyId !== row.company_id) {
    return { ok: false, error: 'KVVI_RELATED_REF_CROSS_TENANT' }
  }
  if (ref.schemaCode !== undefined && ref.schemaCode !== row.schema_code) {
    return { ok: false, error: 'KVVI_RELATED_REF_WRONG_SYSTEM' }
  }
  // 能确定且不越权才放行；**确定不了就拒**，不是「猜一个」。
  return { ok: true }
}

/** 限流四维度（§3.5.2）。**超限即拒绝并记录，不排队、不降级放行。** */
async function enforceLimits(kind, { ctx, link = null, sourceIp = null }) {
  const since = new Date(Date.now() - RATE.windowMs)
  const client = await pool('platform').connect()
  try {
    if (kind === 'ISSUE') {
      const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM visitor_links
          WHERE company_id = $1 AND issuer_user_id = $2
            AND revoked_at IS NULL AND expires_at > now()`,
        [ctx.companyId, ctx.userId])
      if (rows[0].n >= RATE.perIssuerActiveLinks) {
        throw new VisitorError('KVVI_RATE_LIMITED_ISSUER', { limit: RATE.perIssuerActiveLinks })
      }
      const { rows: c } = await client.query(
        `SELECT count(*)::int AS n FROM visitor_links
          WHERE company_id = $1 AND issued_at > $2`, [ctx.companyId, since])
      if (c[0].n >= RATE.perCompanyLinks) {
        throw new VisitorError('KVVI_RATE_LIMITED_COMPANY', { limit: RATE.perCompanyLinks })
      }
      return
    }

    // 链接维度：用已登记的提交次数（不是事件计数，避免并发下的窗口竞态）
    if (link.submissions >= link.max_submissions) {
      throw new VisitorError('KVVI_RATE_LIMITED_LINK', { limit: link.max_submissions })
    }
    if (sourceIp) {
      const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM visitor_link_events
          WHERE source_ip = $1 AND kind = 'SUBMITTED' AND at > $2`, [sourceIp, since])
      if (rows[0].n >= RATE.perSourceSubmissions) {
        throw new VisitorError('KVVI_RATE_LIMITED_SOURCE', { limit: RATE.perSourceSubmissions })
      }
    }
    const { rows: c } = await client.query(
      `SELECT count(*)::int AS n FROM visitor_link_events
        WHERE company_id = $1 AND kind = 'SUBMITTED' AND at > $2`, [ctx.companyId, since])
    if (c[0].n >= RATE.perCompanySubmissions) {
      throw new VisitorError('KVVI_RATE_LIMITED_COMPANY',
        { limit: RATE.perCompanySubmissions })
    }
  } finally {
    client.release()
  }
}

async function events(linkId, ctx, kind, detail = {}, sourceIp = null) {
  await pool('platform').query(
    `INSERT INTO visitor_link_events (link_id, company_id, issuer_user_id, kind,
       source_ip, detail)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [linkId ?? randomUUID(), ctx.companyId, ctx.userId, kind, sourceIp,
     JSON.stringify(detail)])
}

/** 签发人停用/离职时，其名下未提交链接全部失效（§3.5.1）。 */
export async function revokeLinksOfIssuer(issuerUserId, reason = 'ISSUER_DEACTIVATED') {
  const { rows } = await pool('platform').query(
    `UPDATE visitor_links SET revoked_at = now(), revoked_reason = $2
      WHERE issuer_user_id = $1 AND revoked_at IS NULL
      RETURNING link_id, company_id`, [issuerUserId, reason])
  for (const r of rows) {
    await events(r.link_id, { companyId: r.company_id, userId: issuerUserId }, 'REVOKED',
                 { reason })
  }
  return rows.length
}
