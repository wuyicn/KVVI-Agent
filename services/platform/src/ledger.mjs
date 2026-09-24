/**
 * 金额精度与单号唯一（0B-8、0B-9）。
 *
 * ── 为什么金额不能用 `number` ───────────────────────────────────────────
 *
 * `0.1 + 0.2 !== 0.3` 在 IEEE-754 下是**必然**，不是偶然。
 * 金额一旦用双精度，"不差一分" 就只能是祈祷。所以本模块用
 * **BigInt + 标度**：金额是「整数个最小单位」，币种决定标度。
 *
 * ⚠️ 本模块刻意**不提供**从 `number` 构造金额的入口 ——
 * 提供了就一定会有人用，而 `0.1` 这个字面量在进入本模块之前就已经失真了。
 * 唯一入口是**十进制字符串**。
 */

/** 币种标度。与 `business-schema` 的 `money` 类型规则一致（CNY 2 位，JPY 0 位）。 */
export const CURRENCY_SCALE = Object.freeze({ CNY: 2, JPY: 0, USD: 2, EUR: 2 })

const DECIMAL = /^-?\d+(?:\.\d+)?$/

export class KvviMoneyError extends Error {}

/**
 * 解析一个十进制金额。
 * @param {string} value 十进制字符串，如 `"0.30"`
 * @param {string} currency 币种
 * @returns {{units: bigint, currency: string, scale: number}} 金额
 */
export function money(value, currency = 'CNY') {
  const scale = CURRENCY_SCALE[currency]
  if (scale === undefined) throw new KvviMoneyError(`KVVI_UNKNOWN_CURRENCY: ${currency}`)
  if (typeof value !== 'string' || !DECIMAL.test(value)) {
    // 明确拒绝 number：它到这一步之前可能已经失真，收下它等于收下一个错误答案。
    throw new KvviMoneyError(`KVVI_MONEY_MUST_BE_DECIMAL_STRING: ${typeof value}`)
  }
  const negative = value.startsWith('-')
  const [intPart, fracPart = ''] = value.replace('-', '').split('.')
  if (fracPart.length > scale) {
    // 静默四舍五入会让「账对不上」变成一笔查不出来的差额。
    throw new KvviMoneyError(`KVVI_MONEY_TOO_MANY_DECIMALS: ${value} > ${scale}`)
  }
  const padded = fracPart.padEnd(scale, '0')
  const units = BigInt(`${intPart}${padded}`) * (negative ? -1n : 1n)
  return { units, currency, scale }
}

/** 加法：同币种相加，标度由币种决定。 */
export function addMoney(a, b) {
  assertSameCurrency(a, b)
  return { units: a.units + b.units, currency: a.currency, scale: a.scale }
}

/** 减法。 */
export function subMoney(a, b) {
  assertSameCurrency(a, b)
  return { units: a.units - b.units, currency: a.currency, scale: a.scale }
}

/**
 * 乘法：数量 × 单价 → 金额。
 * 用四舍五入到最近的最小单位（`HALF_UP`），**并显式返回是否有舍入**，
 * 让调用方能决定是否接受 —— 静默舍入是审计里查不出来的。
 * @param {{units: bigint, currency: string, scale: number}} amount 金额
 * @param {bigint} factor 整数倍数
 * @returns {{value: object, rounded: boolean}} 结果
 */
export function mulMoney(amount, factor) {
  const product = amount.units * factor
  return { value: { ...amount, units: product }, rounded: false }
}

/** 比较：返回 -1 / 0 / 1。 */
export function compareMoney(a, b) {
  assertSameCurrency(a, b)
  return a.units === b.units ? 0 : a.units < b.units ? -1 : 1
}

/** 相等判定：**按最小单位比较**，不做浮点近似。 */
export function equalMoney(a, b) {
  return a.currency === b.currency && a.units === b.units
}

/** 格式化回十进制字符串（补足标度位数）。 */
export function formatMoney(amount) {
  const negative = amount.units < 0n
  const digits = (negative ? -amount.units : amount.units).toString()
  const padded = digits.padStart(amount.scale + 1, '0')
  const head = padded.slice(0, padded.length - amount.scale)
  const tail = amount.scale > 0 ? `.${padded.slice(padded.length - amount.scale)}` : ''
  return `${negative ? '-' : ''}${head}${tail}`
}

function assertSameCurrency(a, b) {
  if (a.currency !== b.currency) {
    throw new KvviMoneyError(`KVVI_CURRENCY_MISMATCH: ${a.currency} vs ${b.currency}`)
  }
}

/**
 * 取单号：**唯一性由数据库保证**，不由应用层保证。
 *
 * 用 `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` 一条语句完成
 * 「没有就建、有就 +1」——`UPDATE` 持有的行锁把同一
 * (公司, 模型, 周期) 的并发调用串行化。
 *
 * ⚠️ 刻意**没有**「先 SELECT 看有没有、再 INSERT」的写法：
 * 那种写法在并发下必然重号，而且重号是**静默**的 ——
 * 两条记录各自都认为自己成功了。
 * @param {import('pg').PoolClient} client 业务库连接
 * @param {object} input 入参
 * @returns {Promise<string>} 单号
 */
export async function nextRecordNo(client, input) {
  const { companyId, schemaCode, periodKey, prefix, width = 6 } = input
  const { rows } = await client.query(
    `INSERT INTO sequences (company_id, schema_code, period_key, prefix, width, next_value)
     VALUES ($1, $2, $3, $4, $5, 2)
     ON CONFLICT (company_id, schema_code, period_key)
     DO UPDATE SET next_value = sequences.next_value + 1
     RETURNING next_value - 1 AS allocated, prefix, width`,
    [companyId, schemaCode, periodKey, prefix, width])
  const { allocated, prefix: p, width: w } = rows[0]
  return `${p}${periodKey.replace('-', '')}${String(allocated).padStart(w, '0')}`
}
