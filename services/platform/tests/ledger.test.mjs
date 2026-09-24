/**
 * 阶段四锚点④：金额精度与单号唯一（0B-8、0B-9）。
 */
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { pool, closeAll } from '../src/db.mjs'
import { A, resetDatabase } from './harness.mjs'
import {
  money, addMoney, subMoney, mulMoney, compareMoney, equalMoney, formatMoney,
  nextRecordNo, KvviMoneyError,
} from '../src/ledger.mjs'

before(resetDatabase)
after(closeAll)

describe('锚点④ 金额精确（0B-8）', () => {
  test('0.1 + 0.2 = 0.3，不差一分', () => {
    const sum = addMoney(money('0.1'), money('0.2'))
    // `formatMoney` 总是补足币种标度位数：0.30 而不是 0.3。
    // 「格式」与「值」是两件事 —— 相等判定看的是最小单位，不看字符串写法。
    assert.equal(formatMoney(sum), '0.30')
    assert.ok(equalMoney(sum, money('0.30')), '0.3 与 0.30 应当相等')
  })

  test('★ 反证：同样的加法用双精度会错 —— 这就是不能用 number 的理由', () => {
    assert.equal(0.1 + 0.2 === 0.3, false)
    assert.equal((0.1 + 0.2).toFixed(2), '0.30')  // 显示上一样，值不一样
  })

  test('累加一千次一分钱，结果精确', () => {
    let total = money('0.00')
    for (let i = 0; i < 1000; i += 1) total = addMoney(total, money('0.01'))
    assert.equal(formatMoney(total), '10.00')
    assert.equal(formatMoney(subMoney(total, money('10.00'))), '0.00')
  })

  test('**拒绝 number 入参**：它到这一步之前可能已经失真', () => {
    assert.throws(() => money(0.1), (e) => e instanceof KvviMoneyError)
    assert.throws(() => money(1), (e) => e instanceof KvviMoneyError)
  })

  test('**拒绝超精度**，而不是静默四舍五入', () => {
    assert.throws(() => money('1.005'), (e) => e.code === undefined
      && e.message.includes('KVVI_MONEY_TOO_MANY_DECIMALS'))
    // JPY 标度为 0 —— 小数位直接拒
    assert.throws(() => money('100.5', 'JPY'))
    assert.equal(formatMoney(money('100', 'JPY')), '100')
  })

  test('跨币种相加被拒，不静默换算', () => {
    assert.throws(() => addMoney(money('1.00', 'CNY'), money('100', 'JPY')),
      (e) => e.message.includes('KVVI_CURRENCY_MISMATCH'))
  })

  test('负数与比较', () => {
    assert.equal(formatMoney(addMoney(money('-1.50'), money('0.50'))), '-1.00')
    assert.equal(compareMoney(money('1.00'), money('2.00')), -1)
    assert.equal(compareMoney(money('2.00'), money('2.00')), 0)
    assert.equal(compareMoney(money('3.00'), money('2.00')), 1)
  })

  test('乘法保持最小单位，不引入误差', () => {
    const unit = money('19.99')
    const { value, rounded } = mulMoney(unit, 3n)
    assert.equal(formatMoney(value), '59.97')
    assert.equal(rounded, false)
  })
})

describe('锚点④ 单号唯一（0B-9）', () => {
  test('串行取号连续且不重复', async () => {
    const client = await pool('business').connect()
    try {
      const nos = []
      for (let i = 0; i < 5; i += 1) {
        nos.push(await nextRecordNo(client, {
          companyId: A.company, schemaCode: 'general_item', periodKey: '2026-09',
          prefix: 'GI', width: 6,
        }))
      }
      assert.deepEqual(nos, [...new Set(nos)], '串行取号出现重复')
      assert.equal(nos[0], 'GI202609000001')
    } finally {
      client.release()
    }
  })

  test('★ 并发取号：200 个并发请求，单号零重复', async () => {
    // 这是真正要证的那条。串行取号不重复是平凡的；
    // 并发下不重复才说明唯一性真的落在数据库上。
    const N = 200
    const tasks = Array.from({ length: N }, () => (async () => {
      const client = await pool('business').connect()
      try {
        return await nextRecordNo(client, {
          companyId: A.company, schemaCode: 'concurrent_probe', periodKey: '2026-09',
          prefix: 'CP', width: 6,
        })
      } finally {
        client.release()
      }
    })())
    const nos = await Promise.all(tasks)
    assert.equal(nos.length, N)
    assert.equal(new Set(nos).size, N, `并发取号出现重复：${N - new Set(nos).size} 个`)
  })

  test('不同公司各自独立编号（不共享序列）', async () => {
    const client = await pool('business').connect()
    try {
      const a = await nextRecordNo(client, {
        companyId: A.company, schemaCode: 'scoped_probe', periodKey: '2026-09',
        prefix: 'S', width: 4,
      })
      const b = await nextRecordNo(client, {
        companyId: 'b0000000-0000-4000-8000-000000000001', schemaCode: 'scoped_probe',
        periodKey: '2026-09', prefix: 'S', width: 4,
      })
      assert.equal(a, b, '两家公司的序列没有各自独立 —— 序号会互相泄漏业务量')
    } finally {
      client.release()
    }
  })

  test('周期切换后从头开始（按周期重置）', async () => {
    const client = await pool('business').connect()
    try {
      const sep = await nextRecordNo(client, {
        companyId: A.company, schemaCode: 'period_probe', periodKey: '2026-09',
        prefix: 'P', width: 4,
      })
      const oct = await nextRecordNo(client, {
        companyId: A.company, schemaCode: 'period_probe', periodKey: '2026-10',
        prefix: 'P', width: 4,
      })
      assert.equal(sep, 'P2026090001')
      assert.equal(oct, 'P2026100001')
    } finally {
      client.release()
    }
  })
})
