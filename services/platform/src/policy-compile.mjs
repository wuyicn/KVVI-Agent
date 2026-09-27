/**
 * 把 `permission-spec` 契约**编译**成平台 `policies` 表里的行。
 *
 * ── 为什么这个模块此前不存在 ────────────────────────────────────────────
 *
 * 发布通道（`publish.mjs`）从第一天起就留了一个 `apply({draft, diffDigest})` 回调，
 * 注释写着「唯一的策略写入点」—— 而**从来没有任何生产代码传过它**：
 * 四种测试里传的都是 `apply: async ({diffDigest}) => ({diffDigest})`，
 * 契约内容是 `permission-spec: { roles: [], policies: [] }`。
 *
 * 于是「搭建者写出的权限规则真的让员工用上」这条链，中间那一环一直是空的。
 * 试点里搭建者自己也发现了，它在交付说明里写：
 *
 *     「我把规则写成了契约，但这一版还没有一条线把它接到运行时。
 *       这是『已声明』，不是『已生效』。」
 *
 * 这个模块就是那条线。
 *
 * ── 编译是**有损**的，而有损的部分必须说出来 ────────────────────────────
 *
 * 契约比运行时的 `policies` 表**更细**。差的那几处不是可以顺手抹平的细节：
 * 抹平之后，「已声明」会看起来像「已生效」。所以本模块把两件事分开返回：
 *
 *   - `rows`        —— 运行时**确实会执行**的那些；
 *   - `notEnforced` —— 契约里有、而运行时**没有执行点**的那些，
 *                      逐条记下来，由发布记录带出去。
 *
 * 这不是「先发着，以后再补」。这是「把差异写在能查到的地方」——
 * 搭建者说过的「已声明 ≠ 已生效」，在这里变成一条机器可读的记录。
 */

/** `policies.dimension` 的取值域。与 `10-platform.sql` 的 CHECK 一致。 */
export const DIMENSIONS = Object.freeze(['FORM', 'FIELD', 'FLOW', 'DATA'])

/** `policies.field_visibility` 的取值域。与表 CHECK、与 `authorization.fieldVisibility` 的档位一致。 */
export const FIELD_VISIBILITIES = Object.freeze(['VISIBLE', 'MASKED', 'HIDDEN', 'READONLY'])

/**
 * 契约的 `field_mode` → 运行时的 `field_visibility`。
 *
 * ⚠️ **这是两套词表，不是同一套拼错了一次。**
 *
 * | 契约（`permission-spec.v1alpha1.schema.json` 的 `FieldPolicy.field_mode`） | 运行时（`policies.field_visibility` 的 CHECK） |
 * |---|---|
 * | `DENY` · `HIDDEN` · `MASKED` · `READ_ONLY` · `EDITABLE` | `VISIBLE` · `MASKED` · `HIDDEN` · `READONLY` |
 *
 * 两处**只差一个下划线**（`READ_ONLY` / `READONLY`），而它们分属两个文件、
 * 由两套东西强制（JSON Schema 的 enum、PostgreSQL 的 CHECK）。
 * 我第一版就是照着**表**的拼法写这张映射，于是拿真契约一跑，
 * 立刻在 `READ_ONLY` 上抛了「未知的 field_mode」—— **契约是对的，我的表是错的**。
 * 这类「两套词表差一个字符」的映射，写的时候必须两边都指出来源。
 *
 * 映射里唯一需要判断的是 `EDITABLE`：
 * 它说的是「能不能改」，而 `VISIBLE` 说的是「看不看得到」。
 * 映射成立的理由是 —— **能不能改由 FORM 维度的 `update` 动作决定**，
 * FIELD 维度只管可见性。所以 `EDITABLE` 落到 `VISIBLE`，
 * 改不改得动由 FORM 那一行说了算。这是**推断**，契约里没写。
 */
export const FIELD_MODE_TO_VISIBILITY = Object.freeze({
  // 契约的 `DENY` = 这个字段整个不可用 → 运行时最接近的是「看不见」。
  DENY: 'HIDDEN',
  HIDDEN: 'HIDDEN',
  MASKED: 'MASKED',
  READ_ONLY: 'READONLY',
  EDITABLE: 'VISIBLE',
})

/** 编译失败。`code` 稳定，`detail` 结构化 —— 与平台其它错误同一约定。 */
export class CompileError extends Error {
  constructor(code, detail = {}) {
    super(code)
    this.code = code
    this.detail = detail
  }
}

const asArray = (v) => (Array.isArray(v) ? v : [])
const sortedUnique = (xs) => [...new Set(xs.filter((x) => typeof x === 'string' && x !== ''))].sort()

/**
 * 一条契约策略的 `resource_code` 该取哪个字段。
 *
 * ⚠️ 四个维度**不是同一个规则**，而理由是运行时各自的判据：
 *
 * | 维度 | 运行时的判据（读代码得到） | 所以 `resource_code` 取 |
 * |---|---|---|
 * | FORM | `canAct('FORM', assetId, action)`，`assetId` 是业务系统代号 | `resource_ref.asset_id` |
 * | DATA | 同上（数据范围挂在业务对象上） | `resource_ref.asset_id` |
 * | FIELD | `fieldVisibility()` 按**字段 code** 匹配 `resource_code` | `subresource.code` |
 * | FLOW | `canAct('FLOW', 业务对象, 动作类别, {state})` | `resource_ref.asset_id` |
 *
 * 取错不会有报错 —— 只会有一条**永远匹配不上**的策略，
 * 而它的表现是「员工被拒绝」，看起来像权限配小了。
 *
 * ⚠️ FLOW 那一行**曾经也是错的，但在运行时那一侧**：契约写 `asset_id`，
 * 运行时却拿 `workflow.workflow_code ?? '*'` —— 而契约里根本没有
 * `workflow_code` 这个字段，于是恒为 `'*'`，与任何策略都对不上。
 * 另有两处同源：动作要用**类别**（`kind`）而不是 `action_code`；
 * 状态要带上（`policies.state_code`，迁移 25）。三处一起错的结果是
 * **任何流程动作都被拒**，而报的是 `KVVI_ACTION_NOT_PERMITTED`。
 * @param {object} policy 契约里的一条策略
 * @returns {string} 资源代号
 */
function resourceCodeOf(policy) {
  if (policy.dimension === 'FIELD') {
    // 字段维度用**字段 code** 做 resource_code（`authorization.fieldVisibility`）。
    return policy.subresource?.code ?? policy.resource_ref?.asset_id
  }
  return policy.resource_ref?.asset_id
}

/**
 * 编译一份 `permission-spec`。
 *
 * @param {object} spec 契约内容（`{roles, policies}`）
 * @param {object} options 入参
 * @param {Record<string,string>} options.roleIds `role_code` → `role_id`
 * @returns {{rows: object[], notEnforced: object[]}} 可执行的行，与**声明了但执行不了**的清单
 * @throws {CompileError} 遇到「不能静默处理」的形状时
 */
export function compilePermissionSpec(spec, { roleIds } = {}) {
  const roles = asArray(spec?.roles)
  const policies = asArray(spec?.policies)
  if (roleIds === undefined || typeof roleIds !== 'object') {
    throw new CompileError('KVVI_COMPILE_NO_ROLE_MAP')
  }

  // ① 契约里的角色必须**已经存在**。
  //    发布通道不负责建角色：角色是「人」的组织方式，它在企业管理里建，
  //    带着自己的成员。发布时凭空造一个角色，会出现一个没有任何成员、
  //    也没人知道从哪来的角色 —— 而它在角色列表里和其他角色长得一样。
  const missingRoles = sortedUnique(roles.map((r) => r?.role_code))
    .filter((code) => roleIds[code] === undefined)
  if (missingRoles.length > 0) {
    throw new CompileError('KVVI_COMPILE_UNKNOWN_ROLE', { roles: missingRoles })
  }

  const notEnforced = []
  const byKey = new Map()

  for (const policy of policies) {
    const code = policy?.policy_code ?? '(无 policy_code)'
    if (!DIMENSIONS.includes(policy?.dimension)) {
      throw new CompileError('KVVI_COMPILE_UNKNOWN_DIMENSION',
        { policyCode: code, dimension: policy?.dimension ?? null })
    }
    if (roleIds[policy?.role_code] === undefined) {
      throw new CompileError('KVVI_COMPILE_UNKNOWN_ROLE',
        { policyCode: code, roleCode: policy?.role_code ?? null })
    }
    // ⚠️ `effect` 不是 `ALLOW` 一律**拒**，不做「忽略 DENY」这种事。
    //    `policies` 表没有 effect 列 —— 它只表达「允许什么」。
    //    把一条 DENY 悄悄丢掉，等于把「禁止」编译成「没规定」，
    //    而没规定在运行时是 fail-closed 的 —— 结果碰巧对，理由完全错，
    //    而且下一个 fail-open 的判据出现时会静默变成漏洞。
    if (policy.effect !== undefined && policy.effect !== 'ALLOW') {
      throw new CompileError('KVVI_COMPILE_UNSUPPORTED_EFFECT',
        { policyCode: code, effect: policy.effect })
    }
    const resourceCode = resourceCodeOf(policy)
    if (typeof resourceCode !== 'string' || resourceCode === '') {
      throw new CompileError('KVVI_COMPILE_NO_RESOURCE_CODE',
        { policyCode: code, dimension: policy.dimension })
    }

    if (policy.dimension === 'FIELD') {
      const mode = policy.field_mode
      const visibility = FIELD_MODE_TO_VISIBILITY[mode]
      if (visibility === undefined) {
        throw new CompileError('KVVI_COMPILE_UNKNOWN_FIELD_MODE',
          { policyCode: code, fieldMode: mode ?? null,
            allowed: Object.keys(FIELD_MODE_TO_VISIBILITY) })
      }
      const key = `${policy.role_code}|FIELD|${resourceCode}`
      // 同一 (角色, 字段) 出现多条时取**最严**的一条 ——
      // 与 `authorization.fieldVisibility` 的合成规则一致（那里也是取最严）。
      // 取最松会让「多写一条」变成一次静默扩权。
      const rank = { VISIBLE: 0, READONLY: 1, MASKED: 2, HIDDEN: 3 }
      const existing = byKey.get(key)
      if (existing === undefined || rank[visibility] > rank[existing.fieldVisibility]) {
        byKey.set(key, { roleCode: policy.role_code, dimension: 'FIELD',
          resourceCode, stateCode: null, actions: [], dataScopes: [], fieldVisibility: visibility })
      }
      continue
    }

    if (policy.dimension === 'FLOW') {
      // ── 状态这一层**曾经被丢掉**，现在被执行 ──────────────────────────────
      //
      // 契约写的是「**在 following 这个状态下**可以做 SUBMIT 与 CLOSE」。
      // 运行时的判据一度只有「哪张流程 + 哪个动作」—— 于是一条状态限定的策略
      // 被编译成**更宽**的授权：同一个动作在别的状态下也可用了。
      // 那时它被如实记进 `notEnforced`（`KVVI_FLOW_STATE_NOT_ENFORCED`）。
      //
      // 现在 `policies.state_code` 有了这一列，规则落得下去，那条注记随之消失 ——
      // **它是「缺一个执行点」的记录，不是一条可以一直挂着的备注。**
      const state = policy.subresource?.type === 'STATE' ? policy.subresource.code : null
      // ⚠️ 键里**必须**含状态：同一个角色在同一张流程的不同状态上各有一条策略
      //    是正常的（「跟进中可成交」「已流失可复活」），不含状态就会被合并成一条，
      //    而合并的结果是**只剩最后那条的状态**。
      const key = `${policy.role_code}|FLOW|${resourceCode}|${state ?? ''}`
      const existing = byKey.get(key) ?? { roleCode: policy.role_code, dimension: 'FLOW',
        resourceCode, stateCode: state, actions: [], dataScopes: [], fieldVisibility: null }
      existing.actions = sortedUnique([...existing.actions, ...asArray(policy.actions)])
      byKey.set(key, existing)
      continue
    }

    const key = `${policy.role_code}|${policy.dimension}|${resourceCode}`
    const existing = byKey.get(key) ?? { roleCode: policy.role_code, dimension: policy.dimension,
      resourceCode, stateCode: null, actions: [], dataScopes: [], fieldVisibility: null }
    existing.actions = sortedUnique([...existing.actions, ...asArray(policy.actions)])
    // 数据范围是**并集**（§2.5.1：档位取并集，不比较编号）。
    // 同一个角色对同一个对象写了两条 DATA，合起来才是「能看什么」。
    existing.dataScopes = sortedUnique([...existing.dataScopes, ...asArray(policy.data_scopes)])
    byKey.set(key, existing)

    // 能力引用（`capability_refs`）指向业务系统声明的能力。
    // 运行时没有对应的执行点 —— 记下来，不假装它生效了。
    const capabilityRefs = asArray(policy.capability_refs)
    if (capabilityRefs.length > 0) {
      notEnforced.push({
        policyCode: code, dimension: policy.dimension,
        reason: 'KVVI_CAPABILITY_NOT_ENFORCED',
        detail: `这条策略声明了 ${String(capabilityRefs.length)} 个能力引用，`
                + '而运行时按「维度 + 资源 + 动作」判权限，没有能力这一层。',
      })
    }
  }

  const rows = [...byKey.values()].map((row) => ({
    companyId: undefined, // 由调用方按草稿的公司填 —— 这里不猜租户
    roleId: roleIds[row.roleCode],
    dimension: row.dimension,
    resourceCode: row.resourceCode,
    stateCode: row.stateCode ?? null,
    actions: row.actions,
    dataScopes: row.dataScopes,
    fieldVisibility: row.fieldVisibility,
  }))
  // 稳定排序：同一份契约编译两次必须得到同一顺序的行 ——
  // 否则「发布内容摘要」会在没有改动的情况下变来变去。
  rows.sort((a, b) => (a.dimension + a.resourceCode + String(a.roleId) + String(a.stateCode ?? ''))
    .localeCompare(b.dimension + b.resourceCode + String(b.roleId) + String(b.stateCode ?? '')))
  notEnforced.sort((a, b) => String(a.policyCode).localeCompare(String(b.policyCode)))
  return { rows, notEnforced }
}
