/**
 * 公司品牌：`/api/v1/company/branding` —— 所有者配自己的牌子，员工读它。
 *
 * ── 为什么要在平台里存「牌子」，而不是让客户端写死产品名 ──────────────────
 *
 * 此前 shell 的牌子是构建期写死的产品名：员工打开界面，看到的是**我们的**
 * 名字。而这个产品是私有化交付的 —— 交付出去之后，那块牌子应当属于
 * 购买它的那家公司。所以：牌子的**值**由所有者配，运行在员工机器上的
 * 客户端只负责把它显示出来。
 *
 * 本模块是那个值的唯一存放与读写处。客户端那一半（显示）不在本仓库的
 * 这个半边里，但它读到的形状就是下面 `toBranding()` 产出的三个键。
 *
 * ── 判据（每一条都有反向测试）────────────────────────────────────────────
 *
 * | # | 判据 | 不成立会怎样 |
 * |---|---|---|
 * | 1 | **GET 只要有效会话** | 员工的 run 读不到自己公司的牌子 → 界面上还是产品名 |
 * | 2 | **PUT 仅 owner**（`admin` 也不行） | 被委托者的权限本来是「谁能管理」，却顺手改掉了公司对外的身份 |
 * | 3 | 未给的字段**不动**，给了空串/`null` → NULL | 「清空标语」这个动作没地方表达，或改一个字段就把另外两个抹掉 |
 * | 4 | 校验不过 → 400 且**一个字段都不写** | 品牌只写了一半，而调用方以为整条都失败了 |
 * | 5 | 公司**只**从会话来 | 传一个别家的 `companyId` 就改了别家的牌子 |
 *
 * ⚠️ 第 1 条与第 2 条是**故意不对称**的，这不是疏忽。
 *
 * 第 2 条的理由：品牌是公司对外的身份，而 `admin`（被委托者）拿到的是
 * 「谁能管理」这一层委托 —— 两件事不是一件事。所以这里的闸门用的是
 * `admin-api.mjs` 的 `requireOwner`（同一个 owner 判据，不是另写一份）。
 *
 * 第 1 条的理由：**读这张牌子的不是所有者，是员工**。牌子要显示在
 * 每一个员工的界面上，所以读这一侧不能要求任何角色 —— 一旦要求，
 * 员工看到的就是回落的产品名，而那条失败在服务端看起来是完全正常的
 * （没有任何错误，只是界面显示得不对）。这正是最难查的一类问题，
 * 所以它在测试里单独有一条。
 *
 * ── 「未设置」为什么是 NULL 而不是空串 ──────────────────────────────────
 *
 * 客户端的判据是「所有者配过没有」：配过就用它，没配过就回落到产品默认牌子。
 * 用空串表示没配的话，`''` 既可以读成「没配」也可以读成「配了个空的」，
 * 而客户的意图只有他自己知道。所以写入侧把空串归一化成 NULL（迁移 28 的
 * 注释里写了同一件事），读出来就是 `null` —— 客户端拿 `null` 才敢回落。
 *
 * @module kvvi-platform/branding-api
 */

import { pool, withTransaction } from './db.mjs'
import { append, appendDenial, digestOf } from './audit.mjs'
import { FieldRuleError } from './field-rules.mjs'
import { requireOwner } from './admin-api.mjs'

/**
 * 三个字段的长度上限。
 *
 * ⚠️ 与 `sql/28-company-branding.sql` 的 `COMMENT ON COLUMN` **是同一组数**，
 * 且那边写着「改这里时要同时改那里」。上限放在运行时而不是列约束上，
 * 是因为它是产品决定（一行标题放得下多少字），不是一个数据完整性约束。
 */
export const BRANDING_LIMITS = Object.freeze({ name: 60, tagline: 80, logoUrl: 2048 })

/**
 * 三个字段的定义 —— 一张表，而不是三段几乎一样的代码。
 *
 * `column` 是**常量**，不是从请求体来的：下面拼 `SET` 子句时它直接进 SQL，
 * 而这是一条不能含糊的前提 —— 列名来自这张冻结的表，永远不来自调用方。
 * `reason` 是校验失败时逐条报出去的稳定错误码（见 `checkBrandingPatch`）。
 */
const FIELDS = Object.freeze([
  { key: 'name', column: 'brand_name', limit: BRANDING_LIMITS.name,
    reason: 'KVVI_BRANDING_NAME_TOO_LONG' },
  { key: 'logoUrl', column: 'brand_logo_url', limit: BRANDING_LIMITS.logoUrl,
    reason: 'KVVI_BRANDING_LOGO_URL_TOO_LONG', urlOnly: true },
  { key: 'tagline', column: 'brand_tagline', limit: BRANDING_LIMITS.tagline,
    reason: 'KVVI_BRANDING_TAGLINE_TOO_LONG' },
])

/** 数据库行 → 接口形状。NULL 原样带出成 `null`：客户端靠它判断「没配」。 */
function toBranding(row) {
  return {
    name: row.brand_name ?? null,
    logoUrl: row.brand_logo_url ?? null,
    tagline: row.brand_tagline ?? null,
  }
}

/**
 * LOGO 只收 http/https。
 *
 * ⚠️ 这条规则**不是**「长度够了就行」的补充，它挡的是另一类东西：
 *
 *   · `javascript:` —— 会被客户端当成脚本执行，牌子成了注入点；
 *   · `data:` —— **内容就在 URL 里**，所以长度上限管不到它解码之后的体积，
 *     而且它的 MIME 可以自称是图片却不是。
 *
 * 判据用「只接受 http/https」而不是「拒绝一个黑名单」：黑名单要穷举
 * 所有危险 scheme，而接受列表只需要两个。大小写不影响判定 ——
 * 无论调不调 `.toLowerCase()`，`javAscript:` 都过不了 `http://` 这一关。
 * @param value 已 trim 的非空字符串
 * @returns 是合法的 http/https URL 时 true
 */
function isHttpUrl(value) {
  const lower = value.toLowerCase()
  return lower.startsWith('http://') || lower.startsWith('https://')
}

/**
 * 校验并归一化一个 PUT 请求体。
 *
 * 返回 `patch`（要写的字段，`null` 表示清空）与 `problems`（逐字段违规）。
 * **纯函数**：不碰数据库、不碰会话 —— 所以它可以被单独测，而它能被单独测
 * 正是「判据有反向测试」的前提（见 `tests/branding-api.test.mjs`）。
 *
 * | 请求里给了什么 | patch 里是什么 |
 * |---|---|
 * | **没有这个键** | patch 里没有这个键 → 这一列**不动** |
 * | `null` / `undefined` / 空白串 | `null` → 这一列写成 NULL（清空） |
 * | 字符串 | 去首尾空白后的字符串 |
 *
 * 「没这个键」与「给了 null」必须分开：前者是「别动它」，后者是「清掉它」。
 * 用 `hasOwnProperty` 而不是 `body[key] !== undefined` 判前者 —— 后者会把
 * 显式传来的 `undefined` 与「没传」混成一件事，而 JSON 里其实区分得出。
 * @param payload 已剥掉身份字段的请求体
 * @returns {{patch: object, problems: Array<{field: string, reason: string}>}}
 */
export function checkBrandingPatch(payload) {
  // 请求体不是对象（数组、字符串、数字）时整条请求的形状就不对。
  // 不判这一条的话，数组会走进下面「一个字段都没给」的分支 ——
  // 回 200、什么也没写，而调用方以为它设置成功了。
  if (payload !== undefined && payload !== null
      && (typeof payload !== 'object' || Array.isArray(payload))) {
    return { patch: {}, problems: [{ field: null, reason: 'KVVI_BRANDING_BODY_NOT_OBJECT' }] }
  }

  const body = payload ?? {}
  const patch = {}
  const problems = []

  for (const field of FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(body, field.key)) continue
    const raw = body[field.key]

    if (raw === null || raw === undefined) { patch[field.key] = null; continue }
    if (typeof raw !== 'string') {
      // 不 `String(raw)` 强转：`{ name: 123 }` 究竟是想写「123」还是写错了，
      // 只有调用方知道。静默强转会把它变成一条看起来正常的品牌名。
      problems.push({ field: field.key, reason: 'KVVI_BRANDING_NOT_A_STRING' })
      continue
    }

    const value = raw.trim()
    if (value === '') { patch[field.key] = null; continue }

    // 按**码点**计数，与 `String.length` 不同：一个汉字/emoji 在 UTF-16 里
    // 占两个单元，用 `.length` 会把 30 个 emoji 的标语判成超长 ——
    // 而所有者看到的只是一句短短的标语。
    if ([...value].length > field.limit) {
      problems.push({ field: field.key, reason: field.reason })
      continue
    }
    if (field.urlOnly === true && !isHttpUrl(value)) {
      problems.push({ field: field.key, reason: 'KVVI_BRANDING_LOGO_URL_NOT_HTTP' })
      continue
    }
    patch[field.key] = value
  }

  // ⚠️ 逐条只带 `field` 与 `reason` 两个键：接口契约里写的就是这两个。
  //    上限之类的细节写在 reason 与列 COMMENT 里，不额外加键 ——
  //    多出来的键会让等值比较型的前端断言莫名其妙地红。
  return { patch, problems }
}

/** 读本公司的品牌。公司行不在了返回 `null`（正常路径到不了，见路由注释）。 */
async function readBranding(companyId) {
  const { rows } = await pool('platform').query(
    `SELECT brand_name, brand_logo_url, brand_tagline
       FROM companies WHERE company_id = $1`, [companyId])
  return rows.length === 1 ? toBranding(rows[0]) : null
}

/**
 * 写入给定字段，返回**写完之后的全部三个值**。
 *
 * 调用方拿到完整值，就不用再 GET 一次 —— 少一次往返，也少一个
 * 「写成功但读回来是旧的」的窗口（两个浏览器同时改的时候，这个窗口是真的）。
 *
 * @param actor 操作人（公司只从这里来）
 * @param patch 见 `checkBrandingPatch`
 * @returns {{name: string|null, logoUrl: string|null, tagline: string|null}|null}
 *   公司行不存在时为 `null`
 */
async function writeBranding(actor, patch) {
  const written = await withTransaction('platform', async (client) => {
    // `FOR UPDATE`：先把这一行锁住再读旧值。两个所有者同时改时，
    // 后到的那次会等前一次提交完再读 —— 否则「读到的旧值」与
    // 「实际被覆盖的旧值」不是同一个，审计里留的痕就是错的。
    const before = await client.query(
      `SELECT brand_name, brand_logo_url, brand_tagline
         FROM companies WHERE company_id = $1 FOR UPDATE`, [actor.companyId])
    if (before.rows.length !== 1) return null

    // ★ **只写给出来的字段** —— 「没给的字段不动」落在 SQL 本身，
    //   而不是「读出来、合并、整行写回去」。后者在并发下会丢掉另一个人的改动，
    //   而且整行写回意味着「没给」与「给了空」必须在代码里先合并好，
    //   合并错一次就是一次静默的数据丢失。
    const assignments = []
    const values = [actor.companyId]
    for (const field of FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(patch, field.key)) continue
      values.push(patch[field.key])
      assignments.push(`${field.column} = $${values.length}`)
    }

    const after = await client.query(
      `UPDATE companies SET ${assignments.join(', ')}
        WHERE company_id = $1
        RETURNING brand_name, brand_logo_url, brand_tagline`, values)
    return { before: toBranding(before.rows[0]), after: toBranding(after.rows[0]) }
  })
  if (written === null) return null

  // ── 审计 ──────────────────────────────────────────────────────────
  //
  // ★ **旧值也在摘要里**（`before` 与 `after` 一起进 `digestOf`）。
  //
  // 明文旧值不落审计：§9.11.2 要求「敏感值不入日志」，而审计表里只有
  // `params_digest` 一个位置。但只要摘要**覆盖**了旧值，事后就能验：
  // 拿着「改之前是什么」重算一遍摘要，对得上就证明这条记录说的正是那次改动。
  // 反过来，只摘要新值的实现会让「同一句标语、从两个不同的旧值改过去」
  // 产生相同的摘要 —— 那样旧值有没有被记下来，审计里看不出来。
  await append({
    companyId: actor.companyId, actorKind: 'USER', actorId: actor.userId,
    gateway: actor.gateway, sessionId: actor.sessionId,
    action: 'company.updateBranding', resourceKind: 'COMPANY',
    resourceId: actor.companyId, outcome: 'ALLOW',
    paramsDigest: digestOf({ before: written.before, after: written.after }),
  })
  return written.after
}

/**
 * 分派 `/api/v1/company/*`。
 *
 * `path` 是**去掉 `/api/v1` 之后**的完整相对路径（与 `systemRoutes` 同一约定：
 * 本模块自己认首段 `company`，调用方不再切前缀 —— 切两次的表现是每个分支
 * 都落进 404，而 404 看起来像「端点没写」）。
 * @param {object} input `{method, path, payload, session}`
 * @returns {Promise<{status: number, body: object}>}
 */
export async function brandingRoutes({ method, path, payload, session }) {
  const parts = path.split('/').filter((p) => p !== '')
  const isBranding = parts.length === 2 && parts[0] === 'company' && parts[1] === 'branding'
  if (!isBranding) {
    return { status: 404, body: { error: 'KVVI_UNKNOWN_ROUTE', route: path, method } }
  }

  // 身份只从会话折出来。请求体里的 `companyId` 之类早在 `api-router.mjs`
  // 的入口被递归剥掉了 —— 这里再读一次就是把那层保护绕过去。
  const actor = {
    companyId: session.companyId, userId: session.userId,
    gateway: session.gateway, sessionId: session.sessionId ?? null,
  }

  // ★ **读：任何有效会话**。走到这里就说明会话已经验过（`api-router.mjs`
  //   的 ① 三种凭据都汇到同一个会话事实上），所以这里不再判任何角色。
  //   加了角色判定，员工那边静默地读不到牌子 —— 界面回落到产品名，
  //   而服务端一条错误都没有。
  if (method === 'GET') {
    const branding = await readBranding(actor.companyId)
    if (branding === null) return { status: 404, body: { error: 'KVVI_NO_SUCH_COMPANY' } }
    return { status: 200, body: branding }
  }

  if (method === 'PUT') {
    // ★ 写：**仅所有者**。`admin` 也不行 —— 见文件头第 2 条。
    const refused = await requireOwner(actor, 'company.updateBranding')
    if (refused !== null) return refused

    const { patch, problems } = checkBrandingPatch(payload)
    if (problems.length > 0) {
      // 拒绝也留痕（§9.11：「只记成功动作的审计，回答不了『谁被拦了什么』」）。
      // 摘要里放的是**违规清单**而不是提交的值：与允许路径同一条纪律 ——
      // 明文值不进审计。留痕失败不掩盖真正的拒绝：调用方要看到的是 400。
      await appendDenial({
        companyId: actor.companyId, actorKind: 'USER', actorId: actor.userId,
        gateway: actor.gateway, sessionId: actor.sessionId,
        action: 'company.updateBranding', resourceKind: 'COMPANY',
        resourceId: actor.companyId, reason: 'KVVI_BRANDING_INVALID',
        paramsDigest: digestOf(problems),
      }).catch(() => {})

      // ⚠️ 一处不合规 → 整条请求不写。半写会留下「品牌设了一半」的状态，
      //    而调用方拿到 400，会以为什么都没发生。
      //
      // 用 `FieldRuleError` 而不是本模块自己的错误类：它是**请求里字段有问题**
      // 这件事的既有形状（400 + `{error, problems}`），而 `api-router.mjs`
      // 已经把它映射成那个响应体了。另立一个类会让同一个形状有两处实现。
      throw new FieldRuleError('KVVI_BRANDING_INVALID', problems)
    }

    // 一个字段都没给：这是一次空改，不写、也不留痕。
    // 留一条「改了什么也没改」的审计只会让「谁改过牌子」这个问题变模糊。
    if (Object.keys(patch).length === 0) {
      const current = await readBranding(actor.companyId)
      if (current === null) return { status: 404, body: { error: 'KVVI_NO_SUCH_COMPANY' } }
      return { status: 200, body: current }
    }

    const after = await writeBranding(actor, patch)
    if (after === null) return { status: 404, body: { error: 'KVVI_NO_SUCH_COMPANY' } }
    return { status: 200, body: after }
  }

  return { status: 404, body: { error: 'KVVI_UNKNOWN_ROUTE', route: path, method } }
}
