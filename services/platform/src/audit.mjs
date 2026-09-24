/**
 * 审计：追加写 + 哈希链 + 完整性校验（PRD §9.11.2）。
 *
 * ── 三条不可退让的性质 ──────────────────────────────────────────────────
 *
 * 1. **追加写**：`UPDATE` / `DELETE` 由数据库 RULE 拦掉（见 `30-audit.sql`）。
 *    普通表 + 应用层「不要删」不是防篡改，是君子协定。
 * 2. **拒绝也留痕**：`outcome: 'DENY'` 与 `ALLOW` 同等对待。
 *    只记成功动作的审计只能回答「谁做了什么」，
 *    不能回答「谁被拦了什么」—— 而 §9.10 的负向测试要的正是后者。
 * 3. **敏感值不入日志**：只记摘要（`params_digest` / `result_digest`）。
 *
 * ── 诚实边界（§9.11.2 自己写明的）───────────────────────────────────────
 *
 * 本模块的「完整性可验证」**以「写入者不拦截审计」为前提**。
 * 已批准的插件与身份层同进程时**可以拦截审计写入** ——
 * 那是 §10.1 承认的边界，不是本模块能解决的。
 * 本模块保证的是：**写进去的东西事后改不了**。
 */
import { createHash } from 'node:crypto'
import pg from 'pg'
import { pool, dsns } from './db.mjs'

/**
 * 审计库的**超级用户**连接，仅供篡改模拟使用。
 *
 * `pool('admin')` 连的是 `postgres` 库 —— 那里没有审计表。
 * 模拟攻击者必须连在**审计库**上，否则测的是「连不上」而不是「改了被发现」。
 */
async function adminOnAudit() {
  const client = new pg.Client({
    connectionString: dsns().admin.replace(/\/[^/]*$/, '/kvvi_audit'),
  })
  await client.connect()
  return client
}

/** 链的起点。显式常量比「空值」更难被悄悄替换成任意值。 */
const GENESIS = '0'.repeat(64)

/** 参数/结果的摘要。**不记明文**，所以这里只收已经序列化好的值。 */
export function digestOf(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex')
}

/**
 * 追加一条审计记录。
 *
 * 写者角色**读不到**审计（见 `migrate.mjs` 的分权），
 * 所以本函数不返回已写入的内容，也不提供「读回来确认」的路径 ——
 * 那会逼着写者拿到读权限，把分权设计的意图抵消掉。
 * @param {object} entry 审计条目
 * @returns {Promise<string>} 本条记录的 hash
 */
export async function append(entry) {
  const { rows } = await pool('audit').query(
    `SELECT audit_append($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) AS hash`,
    [entry.companyId, entry.actorKind, entry.actorId ?? null, entry.gateway ?? null,
     entry.sessionId ?? null, entry.action, entry.resourceKind ?? null,
     entry.resourceId ?? null, entry.outcome, entry.reason ?? null,
     entry.paramsDigest ?? null, entry.resultDigest ?? null])
  return rows[0].hash
}

/**
 * 记录一次**被拒绝**的动作。
 *
 * 单独一个入口，是为了让「只记成功」这种退化在代码层面就别扭 ——
 * 拒绝路径本来就不该比成功路径难写。
 * @param {object} entry 审计条目（不含 outcome）
 * @returns {Promise<string>} 本条记录的 hash
 */
export function appendDenial(entry) {
  return append({ ...entry, outcome: 'DENY' })
}

/**
 * 校验整条哈希链。
 *
 * 返回**第一个断点**，而不是一个布尔值：只说「坏了」而不说「从哪坏的」，
 * 在事后取证里没有用。
 *
 * 三种破坏都能被检出：
 *   · 改了某条记录的内容 → 该条 `entry_hash` 对不上；
 *   · 删了中间一条        → 后一条的 `prev_hash` 对不上；
 *   · 在尾部插一条        → 需要同时伪造其后所有 hash，链路越长越难。
 * @returns {Promise<object>} 校验结论
 */
export async function verifyChain() {
  // 校验必须用**只读角色**。用写者角色校验等于让同一把钥匙
  // 既能写又能查自己写得对不对。
  const { rows } = await pool('auditRead').query(
    `SELECT seq, company_id, occurred_at, actor_kind, actor_id, gateway,
            session_id, action, resource_kind, resource_id, outcome, reason,
            params_digest, result_digest, prev_hash, entry_hash
       FROM audit_entries ORDER BY seq`)
  let prev = GENESIS
  for (const row of rows) {
    if (row.prev_hash !== prev) {
      return { ok: false, brokenAt: Number(row.seq),
               reason: 'KVVI_AUDIT_CHAIN_LINK_BROKEN' }
    }
    const { rows: calc } = await pool('auditRead').query(
      `SELECT audit_entry_hash($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) AS hash`,
      [row.prev_hash, row.company_id, row.occurred_at, row.actor_kind, row.actor_id,
       row.gateway, row.session_id, row.action, row.resource_kind, row.resource_id,
       row.outcome, row.reason, row.params_digest, row.result_digest])
    if (calc[0].hash !== row.entry_hash) {
      return { ok: false, brokenAt: Number(row.seq),
               reason: 'KVVI_AUDIT_ENTRY_TAMPERED' }
    }
    prev = row.entry_hash
  }
  return { ok: true, entries: rows.length, head: prev }
}

/**
 * **测试专用**：直接改一条已有记录，用于证明篡改会被检出。
 *
 * 之所以要有这个函数：一个「永远返回 ok」的校验同样是校验。
 * 但普通路径必须走 RULE 拦掉的 UPDATE —— 所以这里用 `ALTER TABLE ... DISABLE RULE`
 * 显式模拟一个有超级用户权限的攻击者。
 * @param {number} seq 目标序号
 * @param {string} newAction 新的 action 值
 */
export async function tamperForTest(seq, newAction) {
  if (process.env.KVVI_ALLOW_TAMPER !== '1') {
    throw new Error('KVVI_TAMPER_REFUSED：需要 KVVI_ALLOW_TAMPER=1（仅测试）')
  }
  // 用超级用户连接模拟「有权限的攻击者」：这正是 §9.11.2 假设的对手 ——
  // 用写者角色改不了才不算证据，那只证明了权限没给够。
  const admin = await adminOnAudit()
  try {
    await admin.query('ALTER TABLE audit_entries DISABLE RULE audit_no_update')
    try {
      await admin.query('UPDATE audit_entries SET action = $2 WHERE seq = $1', [seq, newAction])
    } finally {
      await admin.query('ALTER TABLE audit_entries ENABLE RULE audit_no_update')
    }
  } finally {
    await admin.end()
  }
}

/** **测试专用**：读一条记录（需要读角色连接）。 */
export async function peek(seq) {
  const { rows } = await pool('auditRead').query(
    'SELECT * FROM audit_entries WHERE seq = $1', [seq])
  return rows[0] ?? null
}
