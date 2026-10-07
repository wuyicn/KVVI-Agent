/**
 * 字段级写入约束 —— **契约里已经声明、而运行时此前没有执行的那两条**。
 *
 * ── 为什么需要这个模块 ──────────────────────────────────────────────────
 *
 * `business-schema` 的每个字段都必填 `required`、`nullable`、`write_policy`，
 * 搭建者**真的填了**（试点里四个字段全是 `required: true`），而运行时
 * **一个都没执行**：`createRecord` 把 `data` 原样写进 jsonb，
 * `updateRecord` 把补丁原样合并。
 *
 * 于是「必填」只活在契约与表单的星号里、「只在新增时可写」只活在注释里。
 * 这与问题 28 是同一形状：**声明了，没生效**。
 *
 * ── 三条约束，各自说的是什么 ────────────────────────────────────────────
 *
 * | 契约字段 | 取值 | 含义 | 在这里怎么执行 |
 * |---|---|---|---|
 * | `required` | `true` | **新增**时必须有值 | 创建时逐字段查；`undefined` / `null` / 空串都算没填 |
 * | `write_policy` | `MUTABLE` | 新增与修改都可写 | 放行 |
 * | | `CREATE_ONLY` | **只在新增时可写**，之后不可改 | 更新时出现该字段即拒 |
 * | | `SYSTEM` | 人不可写（系统或流程写） | 新增与更新都拒 |
 *
 * ⚠️ **为什么 `required` 只在创建时查**：更新是**补丁**语义（`data || patch`），
 * 「这次没带这个字段」不等于「把它清空」。在更新时要求必填字段出现，
 * 会把每一次「只改一个字段」都变成必须回传整条记录 —— 那不是必填，那是替换。
 *
 * ⚠️ **`required` 与权限是两件事，这里是模型层的那一件。** 权限回答
 * 「这个角色能不能写这个字段」，`required` 回答「这个字段在业务上必须有没有值」。
 * 两者相乘：能写 + 必填 → 你提交时必须给；不能写 + 必填 → 由系统或前一步保证。
 * 把必填塞进权限层会让「这个角色永远存不了草稿」变成一条正常配置。
 *
 * ── 它在哪一层被调用 ────────────────────────────────────────────────────
 *
 * `refs.mjs` 的写入点，**不是在 API 适配器里**。记录有四个调用方
 * （产品 API、命令执行器 `commands.mjs`、访客链路 `visitor.mjs`、流程迁移），
 * 只在一个适配器里检查，另外三个就是绕过口 —— 「换个调用方就能跳过」
 * 的东西不叫约束。
 *
 * @module kvvi-platform/field-rules
 */

/**
 * 字段约束不满足。
 *
 * ⚠️ `status` 是 **400**，不是 500：调用方交上来的字段有问题，是**请求**的问题。
 * 这个区分刚被另一处教训过 —— `admin-api` 的兜底原把没料到的错误报成 400
 * （反了），而这里反过来会把「你没填必填项」报成「服务端坏了」，
 * 调用方会去重试一个永远不会成功的请求。
 */
export class FieldRuleError extends Error {
  /**
   * @param {string} code 稳定的错误码（取第一条违规的原因）
   * @param {Array<object>} problems 逐字段的违规清单
   */
  constructor(code, problems) {
    super(code)
    this.code = code
    this.status = 400
    this.problems = problems
  }
}

/** 字段写入策略。与 `business-schema.v1` 的 `Field.write_policy` 同一套取值。 */
export const WRITE_POLICIES = Object.freeze(['MUTABLE', 'CREATE_ONLY', 'SYSTEM'])

/** 写入操作。 */
export const OPERATIONS = Object.freeze(['create', 'update'])

/** 值是否算「没填」。空串算没填 —— 表单交上来的空输入就是空串。 */
function blank(value) {
  return value === undefined || value === null || value === ''
}

/** 字段是否允许写。 */
function writable(field, operation) {
  const policy = field?.write_policy ?? 'MUTABLE'
  if (policy === 'SYSTEM') return false
  if (policy === 'CREATE_ONLY' && operation === 'update') return false
  return true
}

/**
 * 检查一组字段值能否写入。
 *
 * @param {object} input 入参
 * @param {object} input.model `business-schema` 的 Spec（`{fields: [...]}`）
 * @param {'create'|'update'} input.operation 这是新增还是修改
 * @param {object} input.data 这次要写的字段值
 * @param {Set<string>} [input.requiredFields] **权限层**要求的必填字段（按角色）
 * @param {string[]} [input.declaredFields] 已声明字段的编码清单，
 *   **由调用方按可见性过滤后传入**。写进 `KVVI_FIELD_NOT_DECLARED` 的 `detail`。
 *   过滤之所以是调用方的事：本模块是模型层那一件（见模块头），不认识字段权限。
 * @returns {Array<{field: string, reason: string, detail: object}>} 违规项，空数组表示可以写
 * @throws {TypeError} 入参形状不对（这是编程错误，不是数据错误）
 */
export function checkFieldValues({ model, operation, data, requiredFields, declaredFields }) {
  if (!OPERATIONS.includes(operation)) {
    throw new TypeError(`未知的写入操作：${operation}`)
  }
  const fields = Array.isArray(model?.fields) ? model.fields : []
  const byCode = new Map(fields.map((f) => [f?.field_code, f]))
  const problems = []
  // ★ 猜错一个字段名时，**把答案一起给回去**。
  //
  // 平台手里就有这张表，此前却说一句「这个字段没声明」：调用方（尤其是不带
  // 系统结构知识的模型）只能一个编码一个编码地重猜，猜到放弃为止 ——
  // 实测发生的就是这件事。清单只放编码：字段可能上百个，而 detail 会随
  // 每一条错误响应出去。调用方没给清单时**不放空数组** —— `[]` 读起来像
  // 「这个系统一个字段都没有」，那是另一句话。
  const declaredCodes = Array.isArray(declaredFields)
    ? declaredFields.filter((code) => typeof code === 'string')
    : []

  for (const [code, value] of Object.entries(data ?? {})) {
    const field = byCode.get(code)
    // 契约里没有这个字段：**拒**。写进去的东西没有任何地方能读 ——
    // 界面上不渲染、投影里不出现、Schema 里不声明，而它确实躺在库里。
    // 那种记录看起来「少了一个字段」，而真因是当初多写了一个没人认的键。
    if (field === undefined) {
      problems.push({
        field: code, reason: 'KVVI_FIELD_NOT_DECLARED',
        detail: declaredCodes.length === 0 ? {} : { declaredFields: declaredCodes },
      })
      continue
    }
    if (field.write_policy === 'SYSTEM') {
      problems.push({ field: code, reason: 'KVVI_FIELD_SYSTEM_ONLY',
                      detail: { writePolicy: 'SYSTEM' } })
      continue
    }
    if (!writable(field, operation)) {
      problems.push({ field: code, reason: 'KVVI_FIELD_CREATE_ONLY',
                      detail: { writePolicy: field.write_policy, operation } })
      continue
    }
    if (blank(value) && field.required === true && field.nullable === false) {
      // 必填字段被显式写成空：这是**填错**，不是「没带」。没带由下面那一轮管。
      problems.push({ field: code, reason: 'KVVI_FIELD_REQUIRED', detail: {} })
    }
  }

  if (operation === 'create') {
    for (const field of fields) {
      // 两道闸叠加：模型层（对所有人成立的**下限**）与权限层（按角色再收窄）。
      const requiredByModel = field?.required === true
      const requiredByRole = requiredFields instanceof Set
        && requiredFields.has(field?.field_code)
      if (!requiredByModel && !requiredByRole) continue
      if (blank((data ?? {})[field.field_code])) {
        // 来源分开报：调用方要能分清「模型说必填」与「你这一档必须填」——
        // 前者谁都改不了，后者是配出来的。
        problems.push({
          field: field.field_code, reason: 'KVVI_FIELD_REQUIRED',
          detail: requiredByModel && requiredByRole ? { by: 'both' }
            : { by: requiredByModel ? 'model' : 'role' },
        })
      }
    }
  }
  // ⚠️ 去重：同一个字段可能被上面两个循环各判一次（显式写成空 + 必填没带），
  //    而调用方拿到的是**给最终用户看的清单** —— 同一个字段列两遍，
  //    看起来像两个不同的问题。
  const seen = new Set()
  return problems.filter((p) => {
    const key = `${p.field}\u0000${p.reason}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * 检查并抛出。写入点用这个，调用方不必自己判空。
 *
 * @param {object} input 与 `checkFieldValues` 同
 * @throws {FieldRuleError} 有任何一条违规时
 */
export function assertFieldValues(input) {
  const problems = checkFieldValues(input)
  if (problems.length > 0) {
    throw new FieldRuleError(problems[0].reason, problems)
  }
}
