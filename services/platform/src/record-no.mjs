/**
 * 单号生成。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────────
 *
 * `business_records.record_no` 是 **NOT NULL**，且带 `(company_id, schema_code,
 * record_no)` 唯一约束。而在此之前**没有任何地方生成它** ——
 * `sequences` 表建了、也授权了（`GRANT SELECT, INSERT, UPDATE ON sequences`），
 * 但全仓库没有一处用它；测试都是**直接 INSERT** 绕过去的。
 *
 * 后果：通过产品 API 建记录会在 NOT NULL 上失败。报错是
 * `null value in column "record_no"` —— 指向表约束，看不出「缺一个生成器」。
 *
 * ── 唯一性为什么不能靠「先查再插」 ────────────────────────────────────────
 *
 * 并发下两个请求会查到同一个 `next_value`，然后一个插成功、一个撞唯一约束。
 * 所以取号必须**原子**：本模块用一条 `INSERT ... ON CONFLICT DO UPDATE ...
 * RETURNING` 完成「取号并前进」，由数据库保证同一行只有一个事务能更新。
 * 这与 §2.5 里「单号唯一由数据库保证，不由应用层的先查再插保证」是同一句话。
 *
 * ⚠️ 本模块**不登记新前缀**。`period_key` / `prefix` / `width` 首次使用时按
 * 默认值落库，之后不再改 —— 改它会让已有单号的位数与含义变化。
 */

/** 默认单号形态：`<前缀>-<按期递增的序号>`。 */
const DEFAULT_PREFIX = 'R'
const DEFAULT_WIDTH = 6

/**
 * 期间键。按**天**分期间，便于运维按天排查；跨期间序号重新从 1 开始。
 * @param now - 时间
 * @returns `YYYYMMDD`
 */
export function periodKeyOf(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${String(now.getFullYear())}${p(now.getMonth() + 1)}${p(now.getDate())}`
}

/**
 * 取下一个个单号。**在一个事务里完成「取号并前进」。**
 *
 * @param {object} client 已开启事务、且已设好数据范围的 pg 客户端
 * @param {object} input
 * @param {string} input.companyId 公司
 * @param {string} input.schemaCode 模型代号
 * @param {Date} [input.now] 期间基准（测试可注入）
 * @param {string} [input.prefix] 首次使用时的前缀
 * @param {number} [input.width] 首次使用时的序号宽度
 * @returns {Promise<string>} 单号
 */
export async function nextRecordNo(client, { companyId, schemaCode, now = new Date(),
                                              prefix = DEFAULT_PREFIX,
                                              width = DEFAULT_WIDTH }) {
  const period = periodKeyOf(now)
  // 一条语句同时完成「不存在则建、存在则前进」。`ON CONFLICT ... DO UPDATE`
  // 会锁住那一行，所以并发下两个调用者拿到的是**两个不同**的号。
  const { rows } = await client.query(
    `INSERT INTO sequences (company_id, schema_code, period_key, prefix, width, next_value)
     VALUES ($1, $2, $3, $4, $5, 1)
     ON CONFLICT (company_id, schema_code, period_key) DO UPDATE
       SET next_value = sequences.next_value + 1
     RETURNING next_value, prefix, width`,
    [companyId, schemaCode, period, prefix, width])
  const r = rows[0]
  // `RETURNING` 给的是**前进之后**的值；首次插入时它是 1。
  // 单号从 1 开始，所以直接用。
  const n = Number(r.next_value)
  return `${r.prefix}-${period}-${String(n).padStart(Number(r.width), '0')}`
}
