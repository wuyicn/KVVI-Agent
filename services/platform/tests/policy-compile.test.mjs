/**
 * `permission-spec` → `policies` 的编译。
 *
 * ── 这一组要钉住的是什么 ────────────────────────────────────────────────
 *
 * 编译是**有损**的：契约比 `policies` 表更细。有损本身不是问题，
 * **把有损说成无损**才是。所以这里两件事都要测：
 *
 * | # | 性质 | 不成立会怎样 |
 * |---|---|---|
 * | 1 | 四个维度的 `resource_code` 各取对的字段 | 策略永远匹配不上，表现是「员工被拒绝」，看起来像权限配小了 |
 * | 2 | 两套字段词表（`READ_ONLY` / `READONLY`）映射正确 | **我第一版就错在这里**：拿真契约一跑立刻抛「未知的 field_mode」 |
 * | 3 | 有损的地方进 `notEnforced`，不静默丢掉 | 「已声明」看起来像「已生效」 |
 * | 4 | 不能表达的形状**拒**，不将就 | 一条 `DENY` 被丢掉 = 把「禁止」编译成「没规定」 |
 * | 5 | 同一份契约编译两次结果一样 | 摘要会在没有改动的情况下变来变去 |
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { compilePermissionSpec, CompileError, FIELD_MODE_TO_VISIBILITY }
  from '../src/policy-compile.mjs'

const ROLE_IDS = { sales: 'role-sales', manager: 'role-manager' }
const REF = (assetType, assetId) => ({
  scope_type: 'TENANT', scope_id: 'company-1', app_id: null, module_id: null,
  asset_type: assetType, asset_id: assetId, version: 1, digest: 'sha256:x',
})
const ROLE_REF = { permission_ref: { ...REF('PERMISSION', 'p'), asset_type: 'PERMISSION' },
  subresource: { type: 'ROLE', code: 'sales' } }
const spec = (policies) => ({ roles: [{ role_code: 'sales', name: '销售' }], policies })
const policy = (over) => ({ policy_code: 'p1', role_code: 'sales', role_ref: ROLE_REF,
  effect: 'ALLOW', ...over })

describe('编译：四个维度各取对的 resource_code', () => {
  test('FORM / DATA 取 asset_id（业务系统代号）', () => {
    const { rows } = compilePermissionSpec(spec([
      policy({ dimension: 'FORM', resource_ref: REF('BUSINESS_SCHEMA', 'customer'),
        actions: ['read', 'create'] }),
      policy({ policy_code: 'p2', dimension: 'DATA',
        resource_ref: REF('BUSINESS_SCHEMA', 'customer'), data_scopes: ['SELF'] }),
    ]), { roleIds: ROLE_IDS })
    // `canAct('FORM', assetId, …)` 里的 assetId 就是业务系统代号。
    assert.equal(rows.every((r) => r.resourceCode === 'customer'), true,
      'FORM/DATA 的资源代号不是业务系统代号 —— 策略永远匹配不上')
  })

  test('★ FIELD 取**字段 code**，不是 asset_id', () => {
    const { rows } = compilePermissionSpec(spec([
      policy({ dimension: 'FIELD', resource_ref: REF('BUSINESS_SCHEMA', 'customer'),
        subresource: { type: 'FIELD', code: 'contact_phone' }, field_mode: 'MASKED' }),
    ]), { roleIds: ROLE_IDS })
    // `authorization.fieldVisibility()` 是拿**字段 code** 去比 resource_code 的。
    // 取成 asset_id 的话，每一条字段策略都匹配不上，
    // 而 fieldVisibility 在「没命中任何策略」时返回 HIDDEN ——
    // 于是表现是「所有字段都看不见」，看起来像权限配小了。
    assert.equal(rows[0].resourceCode, 'contact_phone')
    assert.notEqual(rows[0].resourceCode, 'customer')
  })

  test('FLOW 取流程代号（运行时按工作流判，不按状态判）', () => {
    const { rows } = compilePermissionSpec(spec([
      policy({ dimension: 'FLOW', resource_ref: REF('WORKFLOW', 'customer_follow'),
        subresource: { type: 'STATE', code: 'following' }, actions: ['SUBMIT'] }),
    ]), { roleIds: ROLE_IDS })
    assert.equal(rows[0].resourceCode, 'customer_follow')
  })
})

describe('编译：两套字段词表', () => {
  test('★ 契约的五个 field_mode 都能编译，且落到运行时的四个档位', () => {
    // 契约的 enum（JSON Schema）与运行时的 CHECK（PostgreSQL）**只差一个下划线**：
    // READ_ONLY / READONLY。照着表的拼法写映射，会在真契约上立刻抛错。
    assert.deepEqual(Object.keys(FIELD_MODE_TO_VISIBILITY).sort(),
      ['DENY', 'EDITABLE', 'HIDDEN', 'MASKED', 'READ_ONLY'])
    for (const mode of Object.keys(FIELD_MODE_TO_VISIBILITY)) {
      const { rows } = compilePermissionSpec(spec([
        policy({ dimension: 'FIELD', resource_ref: REF('BUSINESS_SCHEMA', 'customer'),
          subresource: { type: 'FIELD', code: 'f' }, field_mode: mode }),
      ]), { roleIds: ROLE_IDS })
      assert.ok(['VISIBLE', 'MASKED', 'HIDDEN', 'READONLY'].includes(rows[0].fieldVisibility),
        `${mode} 编译出了表 CHECK 之外的档位 ${rows[0].fieldVisibility}`)
    }
  })

  test('表里的拼法（READONLY）**不是**契约里的拼法，不能将就', () => {
    assert.throws(() => compilePermissionSpec(spec([
      policy({ dimension: 'FIELD', resource_ref: REF('BUSINESS_SCHEMA', 'customer'),
        subresource: { type: 'FIELD', code: 'f' }, field_mode: 'READONLY' }),
    ]), { roleIds: ROLE_IDS }), (e) => e.code === 'KVVI_COMPILE_UNKNOWN_FIELD_MODE',
    '把运行时的拼法当成契约的拼法收下了 —— 两套词表就此混成一套')
  })

  test('同一个 (角色, 字段) 多条时取最严的一条', () => {
    const { rows } = compilePermissionSpec(spec([
      policy({ policy_code: 'a', dimension: 'FIELD',
        resource_ref: REF('BUSINESS_SCHEMA', 'customer'),
        subresource: { type: 'FIELD', code: 'f' }, field_mode: 'EDITABLE' }),
      policy({ policy_code: 'b', dimension: 'FIELD',
        resource_ref: REF('BUSINESS_SCHEMA', 'customer'),
        subresource: { type: 'FIELD', code: 'f' }, field_mode: 'HIDDEN' }),
    ]), { roleIds: ROLE_IDS })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].fieldVisibility, 'HIDDEN',
      '取最松的话，「多写一条」就成了一次静默扩权')
  })
})

describe('编译：有损的地方必须说出来', () => {
  test('★ 流程的状态**落进行里**，不再进 `notEnforced`', () => {
    // ⚠️ 这条判据此前断言的是**反面**：状态这一层没有执行点，所以必须记进
    // `notEnforced`（`KVVI_FLOW_STATE_NOT_ENFORCED`）。那在当时是**对的** ——
    // 落不下去就得说出来，否则「已声明」会看起来像「已生效」。
    //
    // 迁移 25 给 `policies` 加了 `state_code` 之后它落得下去了，
    // 于是那条注记**必须消失**：一条「缺执行点」的记录不是可以一直挂着的备注，
    // 它挂着的每一天都在把一条已经生效的规则说成没生效。
    const { rows, notEnforced } = compilePermissionSpec(spec([
      policy({ policy_code: 'flow1', dimension: 'FLOW',
        resource_ref: REF('WORKFLOW', 'customer_follow'),
        subresource: { type: 'STATE', code: 'following' }, actions: ['SUBMIT'] }),
    ]), { roleIds: ROLE_IDS })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].stateCode, 'following', '状态没落进行里')
    assert.equal(notEnforced.length, 0, '状态已经落得下去了，却还记着「执行不了」')
  })

  test('★ 同一角色在同一张流程的不同状态上各有一条策略，不许被合并', () => {
    // 不含状态去合并的后果：只剩最后那条的状态，
    // 于是「跟进中可成交」把「已流失可复活」吃掉，或者反过来。
    const { rows } = compilePermissionSpec(spec([
      policy({ policy_code: 'a', dimension: 'FLOW',
        resource_ref: REF('WORKFLOW', 'customer_follow'),
        subresource: { type: 'STATE', code: 'following' }, actions: ['CLOSE'] }),
      policy({ policy_code: 'b', dimension: 'FLOW',
        resource_ref: REF('WORKFLOW', 'customer_follow'),
        subresource: { type: 'STATE', code: 'lost' }, actions: ['REOPEN'] }),
    ]), { roleIds: ROLE_IDS })
    assert.deepEqual(rows.map((r) => r.stateCode).sort(), ['following', 'lost'])
    assert.deepEqual(rows.find((r) => r.stateCode === 'following').actions, ['CLOSE'])
    assert.deepEqual(rows.find((r) => r.stateCode === 'lost').actions, ['REOPEN'])
  })

  test('不带状态的 FLOW 策略 → `stateCode` 为 null（不限状态）', () => {
    const { rows } = compilePermissionSpec(spec([
      policy({ policy_code: 'flow2', dimension: 'FLOW',
        resource_ref: REF('WORKFLOW', 'customer_follow'), actions: ['SUBMIT'] }),
    ]), { roleIds: ROLE_IDS })
    assert.equal(rows[0].stateCode, null)
  })

  test('★ `required_field` 落进行里；与不可写档位冲突时**拒编译**', () => {
    // 「要求有值」与「不允许写」放在一起是自相矛盾的：那个角色永远满足不了它，
    // 而表现是「怎么填都被拒」—— 看起来像权限配小了。
    const { rows } = compilePermissionSpec(spec([
      policy({ policy_code: 'req1', dimension: 'FIELD',
        resource_ref: REF('BUSINESS_SCHEMA', 'customer'),
        subresource: { type: 'FIELD', code: 'contact_phone' },
        field_mode: 'EDITABLE', required_field: true }),
    ]), { roleIds: ROLE_IDS })
    assert.equal(rows[0].fieldRequired, true)
    assert.equal(rows[0].stateCode, null, '字段策略现在不按状态收窄（契约里没地方放状态）')

    // 不带 `required_field` 时是 false —— 「没写」不等于「要求必填」。
    const { rows: plain } = compilePermissionSpec(spec([
      policy({ policy_code: 'req2', dimension: 'FIELD',
        resource_ref: REF('BUSINESS_SCHEMA', 'customer'),
        subresource: { type: 'FIELD', code: 'note' }, field_mode: 'EDITABLE' }),
    ]), { roleIds: ROLE_IDS })
    assert.equal(plain[0].fieldRequired, false)

    for (const mode of ['READ_ONLY', 'HIDDEN', 'DENY']) {
      assert.throws(() => compilePermissionSpec(spec([
        policy({ policy_code: 'bad', dimension: 'FIELD',
          resource_ref: REF('BUSINESS_SCHEMA', 'customer'),
          subresource: { type: 'FIELD', code: 'note' },
          field_mode: mode, required_field: true }),
      ]), { roleIds: ROLE_IDS }), (e) => e.code === 'KVVI_COMPILE_REQUIRED_NOT_WRITABLE',
        `${mode} + 必填 竟然编译过了`)
    }
  })

  test('能力引用进 `notEnforced`', () => {
    const { notEnforced } = compilePermissionSpec(spec([
      policy({ dimension: 'FORM', resource_ref: REF('BUSINESS_SCHEMA', 'customer'),
        actions: ['read'], capability_refs: [{ capability_code: 'x' }] }),
    ]), { roleIds: ROLE_IDS })
    assert.equal(notEnforced.length, 1)
    assert.equal(notEnforced[0].reason, 'KVVI_CAPABILITY_NOT_ENFORCED')
  })

  test('没有状态、没有能力引用时 `notEnforced` 是空的（不是恒有一堆）', () => {
    const { notEnforced } = compilePermissionSpec(spec([
      policy({ dimension: 'FORM', resource_ref: REF('BUSINESS_SCHEMA', 'customer'),
        actions: ['read'] }),
    ]), { roleIds: ROLE_IDS })
    assert.deepEqual(notEnforced, [])
  })
})

describe('编译：不能表达的形状要拒', () => {
  test('★ `effect` 不是 ALLOW 一律拒，不做「忽略 DENY」', () => {
    // `policies` 表没有 effect 列，它只表达「允许什么」。
    // 把一条 DENY 悄悄丢掉 = 把「禁止」编译成「没规定」。
    assert.throws(() => compilePermissionSpec(spec([
      policy({ dimension: 'FORM', resource_ref: REF('BUSINESS_SCHEMA', 'customer'),
        actions: ['read'], effect: 'DENY' }),
    ]), { roleIds: ROLE_IDS }), (e) => e.code === 'KVVI_COMPILE_UNSUPPORTED_EFFECT')
  })

  test('契约里的角色必须先存在，发布不负责凭空造角色', () => {
    assert.throws(() => compilePermissionSpec(spec([
      policy({ dimension: 'FORM', resource_ref: REF('BUSINESS_SCHEMA', 'customer'),
        actions: ['read'] }),
    ]), { roleIds: {} }), (e) => e.code === 'KVVI_COMPILE_UNKNOWN_ROLE')
  })

  test('未知维度、缺资源代号：都拒，且带上 policy_code', () => {
    assert.throws(() => compilePermissionSpec(spec([
      policy({ dimension: 'WIDGET', resource_ref: REF('BUSINESS_SCHEMA', 'customer') }),
    ]), { roleIds: ROLE_IDS }),
    (e) => e.code === 'KVVI_COMPILE_UNKNOWN_DIMENSION' && e.detail.policyCode === 'p1')

    assert.throws(() => compilePermissionSpec(spec([
      policy({ dimension: 'FORM', resource_ref: {} }),
    ]), { roleIds: ROLE_IDS }), (e) => e.code === 'KVVI_COMPILE_NO_RESOURCE_CODE')
  })

  test('没给角色映射表 → 拒（不猜）', () => {
    assert.throws(() => compilePermissionSpec(spec([]), {}),
      (e) => e.code === 'KVVI_COMPILE_NO_ROLE_MAP')
  })
})

describe('编译：确定性', () => {
  test('同一份契约编译两次，行与顺序都一样', () => {
    const input = spec([
      policy({ policy_code: 'z', dimension: 'FIELD', resource_ref: REF('BUSINESS_SCHEMA', 'customer'),
        subresource: { type: 'FIELD', code: 'zz' }, field_mode: 'EDITABLE' }),
      policy({ policy_code: 'a', dimension: 'FORM', resource_ref: REF('BUSINESS_SCHEMA', 'aaa'),
        actions: ['update', 'read'] }),
      policy({ policy_code: 'm', dimension: 'DATA', resource_ref: REF('BUSINESS_SCHEMA', 'mmm'),
        data_scopes: ['COMPANY', 'SELF'] }),
    ])
    const first = compilePermissionSpec(input, { roleIds: ROLE_IDS })
    const second = compilePermissionSpec(input, { roleIds: ROLE_IDS })
    // 顺序不稳定的话，「发布内容摘要」会在没有改动的情况下变来变去 ——
    // 而那正是审批人用来判断「批的是不是同一份」的东西。
    assert.deepEqual(first.rows, second.rows)
    assert.deepEqual(first.notEnforced, second.notEnforced)
    // 动作与数据范围都要去重且排序：契约里的顺序不是内容的一部分。
    const form = first.rows.find((r) => r.dimension === 'FORM')
    assert.deepEqual(form.actions, ['read', 'update'])
    const data = first.rows.find((r) => r.dimension === 'DATA')
    assert.deepEqual(data.dataScopes, ['COMPANY', 'SELF'])
  })

  test('同一 (角色, 维度, 资源) 的多条合并：动作并集、数据范围并集', () => {
    const { rows } = compilePermissionSpec(spec([
      policy({ policy_code: 'a', dimension: 'FORM',
        resource_ref: REF('BUSINESS_SCHEMA', 'customer'), actions: ['read'] }),
      policy({ policy_code: 'b', dimension: 'FORM',
        resource_ref: REF('BUSINESS_SCHEMA', 'customer'), actions: ['update'] }),
    ]), { roleIds: ROLE_IDS })
    assert.equal(rows.length, 1, '同一格的策略应当合并成一行（表上有 UNIQUE 约束）')
    assert.deepEqual(rows[0].actions, ['read', 'update'])
  })
})
