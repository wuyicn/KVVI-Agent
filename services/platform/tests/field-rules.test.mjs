/**
 * 字段级写入约束 —— **契约里声明了、而运行时此前没有执行的那两条**。
 *
 * `business-schema` 的每个字段必填 `required` / `nullable` / `write_policy`，
 * 搭建者真的填了（试点里四个字段全是 `required: true`），而运行时一个都没执行：
 * `createRecord` 把 `data` 原样写进 jsonb，`updateRecord` 把补丁原样合并。
 *
 * 于是「必填」只活在契约与表单的星号里、「只在新增时可写」只活在注释里 ——
 * 与问题 28（流程四处取错）同一个形状：**声明了，没生效**。
 *
 * 这一组盯的是纯函数那一层；「真的接上了没有」由
 * `publish-runtime-e2e.test.mjs` 的 ⑪ 从 HTTP 外面验。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { checkFieldValues, assertFieldValues, FieldRuleError } from '../src/field-rules.mjs'

const MODEL = {
  schema_code: 'customer',
  fields: [
    { field_code: 'customer_name', type: 'short_text', required: true, nullable: false,
      write_policy: 'MUTABLE' },
    { field_code: 'owner_id', type: 'person', required: false, nullable: false,
      write_policy: 'CREATE_ONLY' },
    { field_code: 'created_by', type: 'person', required: false, nullable: false,
      write_policy: 'SYSTEM' },
    { field_code: 'note', type: 'long_text', required: false, nullable: true,
      write_policy: 'MUTABLE' },
  ],
}

const reasons = (problems) => problems.map((p) => `${p.field}:${p.reason}`).sort()

describe('字段写入约束：纯判定', () => {
  test('合规的一次新增 → 没有违规项', () => {
    assert.deepEqual(checkFieldValues({
      model: MODEL, operation: 'create', data: { customer_name: '星河科技' },
    }), [])
  })

  test('★ 必填字段没带 → 拒（这是 `required` 第一次真的被执行）', () => {
    assert.deepEqual(reasons(checkFieldValues({
      model: MODEL, operation: 'create', data: { note: '备注' },
    })), ['customer_name:KVVI_FIELD_REQUIRED'])
  })

  test('★ 必填字段带成空串 / null → 同样算没填', () => {
    for (const blank of ['', null, undefined]) {
      assert.deepEqual(reasons(checkFieldValues({
        model: MODEL, operation: 'create', data: { customer_name: blank },
      })), ['customer_name:KVVI_FIELD_REQUIRED'], `空值 ${String(blank)} 竟然放过了`)
    }
  })

  test('★ 更新是**补丁**语义：不带必填字段不算错', () => {
    // 「这次没带」不等于「把它清空」。在更新时要求必填字段出现，
    // 会把每一次「只改一个字段」都变成必须回传整条记录 —— 那不是必填，那是替换。
    assert.deepEqual(checkFieldValues({
      model: MODEL, operation: 'update', data: { note: '改了备注' },
    }), [])
  })

  test('更新时把必填字段**显式写成空** → 拒', () => {
    assert.deepEqual(reasons(checkFieldValues({
      model: MODEL, operation: 'update', data: { customer_name: '' },
    })), ['customer_name:KVVI_FIELD_REQUIRED'])
  })

  test('★ `CREATE_ONLY`：新增可写、更新不可写', () => {
    assert.deepEqual(checkFieldValues({
      model: MODEL, operation: 'create', data: { customer_name: 'x', owner_id: 'u-1' },
    }), [])
    assert.deepEqual(reasons(checkFieldValues({
      model: MODEL, operation: 'update', data: { owner_id: 'u-2' },
    })), ['owner_id:KVVI_FIELD_CREATE_ONLY'])
  })

  test('★ `SYSTEM`：人不可写，新增与更新都拒', () => {
    for (const operation of ['create', 'update']) {
      assert.deepEqual(reasons(checkFieldValues({
        model: MODEL, operation,
        data: { customer_name: 'x', created_by: 'u-1' },
      })), ['created_by:KVVI_FIELD_SYSTEM_ONLY'])
    }
  })

  test('★ 契约里没有的字段 → 拒，不是收下', () => {
    // 写进去的东西没有任何地方能读：界面不渲染、投影不出现、Schema 不声明，
    // 而它确实躺在库里。那种记录看起来「少了一个字段」，
    // 真因是当初多写了一个没人认的键。
    assert.deepEqual(reasons(checkFieldValues({
      model: MODEL, operation: 'create',
      data: { customer_name: 'x', 随便一个键: 'y' },
    })), ['随便一个键:KVVI_FIELD_NOT_DECLARED'])
  })

  test('一次列出**全部**违规项，不只第一条', () => {
    // 只报第一条会让调用方补一个、被打回一次，来回好几轮。
    const problems = checkFieldValues({
      model: MODEL, operation: 'update',
      data: { owner_id: 'u-2', created_by: 'u-1', 未知: 1 },
    })
    assert.equal(problems.length, 3)
  })

  test('`write_policy` 缺省按 `MUTABLE`（契约必填，但缺省不炸）', () => {
    const model = { fields: [{ field_code: 'a', required: false }] }
    assert.deepEqual(checkFieldValues({ model, operation: 'update', data: { a: 'x' } }), [])
  })

  test('未知操作是编程错误 → 直接抛，不当成数据问题', () => {
    assert.throws(() => checkFieldValues({ model: MODEL, operation: '删除', data: {} }),
                  TypeError)
  })

  test('`assertFieldValues` 抛出带状态码的错误，且把清单带出来', () => {
    try {
      assertFieldValues({ model: MODEL, operation: 'create', data: {} })
      assert.fail('应当抛出')
    } catch (error) {
      assert.ok(error instanceof FieldRuleError)
      // ⚠️ 400 而不是 500：调用方交上来的字段有问题，是**请求**的问题。
      //    报成 500 会让调用方去重试一个永远不会成功的请求。
      assert.equal(error.status, 400)
      assert.equal(error.code, 'KVVI_FIELD_REQUIRED')
      assert.equal(error.problems.length, 1)
    }
  })

  test('合规时 `assertFieldValues` 不抛', () => {
    assert.doesNotThrow(() => assertFieldValues({
      model: MODEL, operation: 'create', data: { customer_name: '星河科技' },
    }))
  })
})
