/**
 * 路径里的标识符：**进任何查询之前的统一一道闸**。
 *
 * ── 为什么要有这一层，而不是在每个路由里补一句 ────────────────────────────
 *
 * 路径段里的 id 原本直接喂给 uuid 类型的列（`business_records.record_id`、
 * `publish_drafts.draft_id`、`users.user_id`）。非 uuid 的值会让 PostgreSQL 抛
 * `22P02`，而那个错误是**服务端没接住**的：一路穿到请求边界 → 500
 * `KVVI_INTERNAL_ERROR`。
 *
 * 后果不是「报错不好看」。模型收到的信号是「系统内部错误」，于是把「这条记录
 * 对我不可读」当成结论 —— 它据一个假前提写出「请你选一条路走」。
 * 真实原因是调用方给的标识符根本不是这个接口要的那种 id。
 *
 * 所以闸装在**路由器里**（`api-router.mjs` 的 `dispatch` 里，一处），
 * 而不逐接口补：
 *   · 逐接口补要补的地方是**端点数量级**的，漏一处就是又一个 500；
 *   · 而「哪些段是标识符、是哪一种」是路由表本身的知识，写一遍就够。
 * 处理点因此**拿不到**非法标识符 —— 它不需要再防一次。
 *
 * ── 两种 id 都要认，是因为模型手上只有记录号 ──────────────────────────────
 *
 * 建单返回的是**记录号**（`R-20261006-000003`），而按 id 读写的接口要 uuid。
 * 模型天然只有记录号，只能拿它来试 —— 拒掉它就等于让模型自己去猜 uuid。
 * 所以记录段先按记录号解析一遍，再走原路径。
 *
 * ⚠️ 记录号的判据**只有一处**：拿值去比对 `business_records.record_no`，
 *    而那个列的格式由 `record-no.mjs` 生成。本模块不另写一套
 *    `R-YYYYMMDD-…` 的正则 —— 两份判据会漂移，漂移的方向是
 *    「模型给了一个真记录号，却被判非法」。
 *
 * ⚠️ 解析在**会话公司 + 路径里那个系统**的范围内做（两个条件都在 SQL 里），
 *    所以跨公司、跨系统的记录号命中不了；命中多条一律拒（不取第一条）。
 */
import { pool } from './db.mjs'
import { applyScopeGucs, scopeContext } from './authorization.mjs'

/** 稳定错误码：标识符不是这个接口认的那种 id。404 —— 它是「没这条记录」，不是故障。 */
export const INVALID_IDENTIFIER = 'KVVI_RECORD_NOT_FOUND'

/** 路由表里标识符段的两种形状。其余段是字面量或业务代号，不在此列。 */
export const IDENTIFIER = Object.freeze({
  /** uuid，没有别的解释（草稿、账号）。 */
  UUID: 'uuid',
  /** uuid 或**记录号**，按会话公司 + 该系统解析（记录）。 */
  RECORD: 'record',
})

/** 段名 → 角色。段名在这里是**角色**，不是位置。 */
const SEGMENT_ROLE = Object.freeze({
  id: 'id',           // 由所属那一行的 `kind` 决定是哪一种标识符
  system: 'system',   // 业务代号：文本，不是 uuid
  role: 'role',       // 角色码：同上
})

/**
 * 产品 API 里**所有**把路径段当标识符用的地方。`kind` 是那一段的 id 种类。
 *
 * 段名小写者为角色，其余按字面量逐字匹配 —— 所以 `GET /publish/drafts`
 * 不会匹配到三段的行。
 */
const ROUTES = Object.freeze([
  { segments: ['systems', 'system', 'records', 'id'], kind: IDENTIFIER.RECORD },
  { segments: ['systems', 'system', 'records', 'id', 'write-intent'], kind: IDENTIFIER.RECORD },
  { segments: ['systems', 'system', 'records', 'id', 'write-intent', 'cancel'], kind: IDENTIFIER.RECORD },
  { segments: ['systems', 'system', 'records', 'id', 'write-intent', 'acknowledge'], kind: IDENTIFIER.RECORD },
  { segments: ['systems', 'system', 'records', 'id', 'write-receipt'], kind: IDENTIFIER.RECORD },
  { segments: ['systems', 'system', 'records', 'id', 'actions'], kind: IDENTIFIER.RECORD },
  { segments: ['systems', 'system', 'records', 'id', 'transitions'], kind: IDENTIFIER.RECORD },
  { segments: ['publish', 'drafts', 'id'], kind: IDENTIFIER.UUID },
  { segments: ['publish', 'drafts', 'id', 'approve'], kind: IDENTIFIER.UUID },
  { segments: ['publish', 'drafts', 'id', 'publish'], kind: IDENTIFIER.UUID },
  { segments: ['admin', 'members', 'id', 'suspend'], kind: IDENTIFIER.UUID },
  { segments: ['admin', 'members', 'id', 'reactivate'], kind: IDENTIFIER.UUID },
  { segments: ['admin', 'members', 'id', 'profile'], kind: IDENTIFIER.UUID },
  { segments: ['admin', 'members', 'id', 'builder'], kind: IDENTIFIER.UUID },
  { segments: ['admin', 'members', 'id', 'platform-role'], kind: IDENTIFIER.UUID },
  { segments: ['admin', 'roles', 'role', 'members', 'id'], kind: IDENTIFIER.UUID },
])

/** 路径 → 段数组。空段丢掉，与各路由模块自己的切法一致。 */
const partsOf = (path) => path.split('/').filter((p) => p !== '')

/**
 * 一条路径上每个标识符段的角色：`[{index, kind, assetId}]`。
 *
 * `assetId` 是路径里那个系统 —— 记录号解析**必须在目标系统的范围内**做，
 * 而「哪个系统」这件事只有路由表知道。
 *
 * @param path 去掉 `/api/v1` 之后的路径
 * @returns 标识符段；一条都没有时空数组（未知路径也走这里，由末尾的 404 回答）
 */
export function identifierSlots(path) {
  const parts = partsOf(path)
  for (const route of ROUTES) {
    if (route.segments.length !== parts.length) continue
    const out = []
    let assetId = null
    let matched = true
    for (let i = 0; i < parts.length; i += 1) {
      const role = SEGMENT_ROLE[route.segments[i]]
      if (role === undefined) { if (route.segments[i] !== parts[i]) { matched = false; break } continue }
      if (role === 'system') assetId = decodeURIComponent(parts[i])
      else if (role === 'id') out.push({ index: i, kind: route.kind, assetId })
    }
    if (matched) return out
  }
  return []
}

/** uuid 形状。**只判形状**，是不是某一条真记录由查询回答。 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

/**
 * 记录号 → 记录 id。
 *
 * ⚠️ **不走「一条 SQL 同时比 id 与记录号」。** 那样写必然出现
 *    `record_id::text = $1` 或 `record_id = $1::uuid` 这类比较，而两者都会让
 *    一个**非 uuid 的值**在 SQL 里被强制转型 —— 正是这条闸要消灭的 `22P02`，
 *    只不过这次换成了从闸内部抛出来。
 *
 * ⚠️ 「什么算 uuid」只有一处判据（上面的 `UUID_RE`）。这里不必再判一次形态：
 *    能走到本函数的值已经确定不是 uuid 形状的，而 uuid 形状的值在
 *    `checkIdentifierSegments` 里已经直接放行 —— 不查也能确定它比不出记录号。
 * @param input 查询入参
 * @returns 唯一匹配的记录 id；没有、或有多个时为 `null`
 */
async function lookupRecordId({ companyId, userId, schemaCode, identifier }) {
  const scope = await scopeContext({ companyId, userId })
  const client = await pool('business').connect()
  try {
    await client.query('BEGIN')
    // ⚠️ 解析必须先过作用域 GUC：没过的话 RLS 是 fail-closed，
    //    连本公司有权读的记录也解析不出来 —— 表现是「记录号永远 404」。
    await applyScopeGucs(client, scope)
    // 记录号在 (company_id, schema_code) 内唯一（表上有唯一约束）。这里仍取两行，
    // 是为了让「命中多条」在约束之外也有一条**可执行**的判据。
    const { rows } = await client.query(
      `SELECT record_id FROM business_records
        WHERE company_id = $1 AND schema_code = $2 AND record_no = $3
        LIMIT 2`, [companyId, schemaCode, identifier])
    await client.query('COMMIT')
    return rows.length === 1 ? rows[0].record_id : null
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

/**
 * 闸：标识符段里的每个值，要么本来就是个 id，要么被解析成 uuid。
 *
 * @param {object} input 入参
 * @param {string} input.path `/api/v1` 之后的路径
 * @param {string} input.companyId **会话**里的公司（不是调用方给的）
 * @param {string} input.userId **会话**里的账号：解析要过 RLS，而作用域是从这个账号
 *   查出来的 —— 拿一个空账号去查，「有权读」会变成「读不到」
 * @returns `{ok: true, path}`（路径已把记录号换成 id），或
 *   `{ok: false, slot, value}`：这个段既不是 uuid、也解析不到
 */
export async function checkIdentifierSegments({ path, companyId, userId }) {
  const slots = identifierSlots(path)
  if (slots.length === 0) return { ok: true, path }

  const parts = partsOf(path)
  for (const slot of slots) {
    const value = decodeURIComponent(parts[slot.index])
    if (UUID_RE.test(value)) continue
    if (slot.kind === IDENTIFIER.UUID) return { ok: false, slot, value }
    const recordId = await lookupRecordId({
      companyId, userId, schemaCode: slot.assetId, identifier: value,
    })
    if (recordId === null) return { ok: false, slot, value }
    // ★ 换成 id 之后**原路径继续走**：权限、数据范围、字段可见性都不在闸里，
    //   它们由执行点判 —— 在这一层顺手判一次就是第二份判据。
    parts[slot.index] = recordId
  }
  return { ok: true, path: '/' + parts.join('/') }
}
