# `business-schema/v1` 产出约束

> **来源**：从**官方验证器源码**与 **222 个官方测试用例**反推，不是从文档抄的。
> 每一条都标注了它的强制位置。
>
> **为什么需要这份文档**：`SKILL.md` 要教模型产出**能过校验**的契约。
> 而下面的约束**大半在 JSON Schema 里看不出来** —— 它们是语义层（`business.mjs`）
> 与引用层（`references.mjs`）强制的。只看 schema 会产出一份「结构合法但被拒绝」的东西。
>
> **本文档每条约束都在 `样例/business-schema/通用事项.spec.json` 上验证过**
> （结构 + 语义 + 引用三层全通过）。

---

## 〇、Spec 的骨架

`business-schema/v1` 的 `Spec` 根对象，**四个必填字段**：

```jsonc
{
  "schema_code": "…",                    // MachineCode 格式
  "name": "…",
  "field_type_registry_ref": { … },      // 完整 AssetRef，见 §1
  "fields": [ … ]                        // 至少 1 个，至多 100 个
}
```

可选：`description`、`record_number`、`indexes`、`record_rules`、`layout`

> **注意**：`--entry spec` 的输入就是**这个对象本身**，
> **不要**包一层 `{contract_version, base_version, spec}`（那是 `compiled-draft` 的形状）。

---

## 一、`field_type_registry_ref` —— 必须引用真实资产

| 项 | 约束 |
|---|---|
| 形状 | `AssetRef`，`asset_type` 固定 `"FIELD_TYPE_REGISTRY"` |
| `scope_type` | `"PLATFORM_CONTROL"`（平台级） |
| **`digest`** | **必须与平台侧注册表的真实摘要一致**，否则 `REFERENCE_DIGEST_MISMATCH` |
| `version` | 必须与所引用版本一致 |

**它声明「本契约启用哪些字段类型」** —— `fields[].type` 必须落在该注册表声明的类型集内，
否则 `FIELD_TYPE_UNREGISTERED`。

> **⚠️ 最常见的失败**：写一个形如 `"digest": "sha256:aaaa…"` 的占位摘要。
> 结构校验能过，**引用校验必挂**。digest 必须从平台侧取得，不能编。

---

## 二、字段名：12 个保留字不可用

`field_code` 命中下列任一条即 `FIELD_CODE_INVALID`：

| 类别 | 取值 |
|---|---|
| **平台保留** | `id`、`tenant_id`、`form_code`、`schema_version`、`status`、`owner_id`、`created_by`、`updated_by`、`created_at`、`updated_at` |
| **额外保留** | `data`、`record_no` |
| **前缀保留** | 任何以 `_platform_` 开头的 |
| **冲突** | 与 `record_number.field_code` 相同的 |

> **最容易踩的**：`status`。它是业务上最自然的状态字段名，但**已被平台占用**。
> 用 `item_status` 或更贴业务的名称。
>
> `field_code` 本身的格式是 `^[a-z][a-z0-9_]{2,63}$`（小写字母开头，3–64 位）。
> **格式合法不等于可用** —— 保留字校验在语义层，格式校验在结构层。

---

## 三、字段级语义约束

| # | 约束 | 违反时的诊断 |
|---|---|---|
| 1 | `required: true` 与 `nullable: true` **不可同时成立** | `CONSTRAINT_INCOMPATIBLE` |
| 2 | `write_policy: "SYSTEM"` 时，该字段**必须在 `context.business.generators` 里声明** `{schema_code, field_code, type}` 三项且完全匹配 | `CONSTRAINT_INCOMPATIBLE` |
| 3 | `query.searchable: true` **仅** `short_text` / `long_text` / `single_select` / `multi_select` 可用 | `CONSTRAINT_INCOMPATIBLE` |
| 4 | `query.sortable: true` **不可**用于 `long_text` / `multi_select` | `CONSTRAINT_INCOMPATIBLE` |
| 5 | `short_text`：`min_length ≤ max_length`（默认上限 255） | `CONSTRAINT_INCOMPATIBLE` |
| 6 | `short_text.pattern` 必须是 **safe pattern**（不接受任意正则） | `CONSTRAINT_INCOMPATIBLE` |
| 7 | `decimal`：`scale ≤ precision` | `CONSTRAINT_INCOMPATIBLE` |
| 8 | `money`：`type_config.currency` **必须出现在 `context.business.money_rules` 中** | `DEPENDENCY_VALIDATOR_UNAVAILABLE` |
| 9 | `single_select` / `multi_select`：`type_config.options[].code` **不可重复** | `CONSTRAINT_INCOMPATIBLE` |
| 10 | `date`：`constraints.minimum` / `maximum` 必须是**有效日期** | `CONSTRAINT_INCOMPATIBLE` |
| 11 | `minimum ≤ maximum`（`decimal`/`money` 按十进制比较，其余按数值） | `CONSTRAINT_INCOMPATIBLE` |
| 12 | `default` 必须是**类型匹配的有效值** | `CONSTRAINT_INCOMPATIBLE` |
| 13 | `field_code` 在同 schema 内**不可重复** | `FIELD_CODE_DUPLICATE` |

### 哪些类型需要 `type_config`

**只有这四类**（其余类型带 `type_config` 反而可能被拒）：

| 类型 | `type_config` |
|---|---|
| `money` | `{"currency_mode": "FIXED", "currency": "CNY"}` |
| `decimal` | `{"precision": N, "scale": N}` |
| `single_select` | `{"options": [{"code": …, "label": …, "order": N, "enabled": true}]}` |
| `multi_select` | 同上 |

> **这是「结构校验会告诉你」的一类** —— 缺了它报 `CONTRACT_SHAPE_INVALID`。
> 列在这里是为了**一次写对**，而不是靠试错。

---

## 四、`indexes` 的约束

| # | 约束 |
|---|---|
| 1 | `index_code` 不可重复 |
| 2 | `index.fields` 内的 `field_code` 不可重复，且**必须存在于 `fields`**（或等于 `record_number.field_code`） |
| 3 | `long_text` **不可**建 `UNIQUE` 索引 |
| 4 | 每个类型的可用索引种类由 `context.business.index_capabilities` 决定；不在表内的类型报 `DEPENDENCY_VALIDATOR_UNAVAILABLE` |

### 运行时“不允许重复”

已发布的 `kind: "UNIQUE"` 规则在平台统一写入入口执行，适用于新增、修改和 AI 写入。同一公司、同一表单的所有记录参与判断，包括当前员工无权查看的记录；拒绝时不返回冲突记录、账号或隐藏字段。组合规则要求所有参与字段的值同时相同才算重复；修改时使用合并后的完整记录，并排除自身。

可选字段缺失、`null` 或空字符串时不参与查重；组合规则中任一字段为空也不参与。其余值按 JSON 值相等判断，不自动去空格、折叠大小写或转换类型。新增规则前会检查历史数据，存在重复就拒绝发布，不删除或修改原记录。

查重与写入在同一业务事务内串行执行。跨库发布先保存持久化保护，期间写入暂停；只有对应草案确已发布且模型一致时才解除保护。发布中断后，所有者应重试同一已审批草案，不手工删除保护。平台权限、发布记录和模型通过同一平台事务提交，重复发布请求不能先应用旧权限再拒绝模型。

这不是任意管理员 SQL 的数据库唯一索引保证：直接修改数据库不受产品入口约束。目前每张表单的写入会串行，查重可能扫描该公司表单的数据，大数据量、高写入量需另做性能验收。规则校验、并发和故障恢复用例见 `services/platform/tests/unique-fields.test.mjs`，浏览器与签名 AI 入口用例见 `services/platform/tests/publish-runtime-e2e.test.mjs`。

---

## 五、`layout` 的约束

| # | 约束 |
|---|---|
| 1 | `section_code` 不可重复 |
| 2 | `title` / `description` / `items[].text` 受文本检查（见 `validateSecrets`） |

---

## 六、「新建」与「修改」是两种场景，结论不同

**同一份 Spec，配不同的 context，判定不同**：

| context | 判定 |
|---|---|
| `snapshots: []`、`histories: []`（**新建**） | 只查「产出物本身合法吗」 |
| 含已注册版本与历史（**修改**） | 额外查「与已注册版本的变化是否被允许」 |

**修改场景下会多出的诊断**：

| 诊断 | 含义 |
|---|---|
| `MIGRATION_REQUIRED` | 该变化需要迁移方案 |
| `BREAKING_CHANGE_FORBIDDEN` | 该变化被禁止（如已发布字段改类型） |
| 其他依赖历史比较的诊断 | |

> **`SKILL.md` 必须让模型知道自己处在哪个场景**。
> 否则模型看到 `MIGRATION_REQUIRED` 会以为是自己把 Spec 写错了，
> 而真正的问题是**它正在改一个已发布的模型**。

---

## 七、本文档已知的不足

| # | 不足 | 影响 |
|---|---|---|
| 1 | **约束从实现反推，非规范声明** | 实现变更时本文档会静默过期。应有一个从 `business.mjs` 生成本文档的检查，未做 |
| 2 | **`record_rules` 的约束未整理** | 本文只覆盖 `fields` / `indexes` / `layout` / 引用 |
| 3 | **`validateSecrets` 的文本规则未展开** | 只知道它会检查 `description` / `title` 等，具体规则未整理 |
| 4 | **`default` 的类型匹配规则未逐类型列出** | 只知「必须匹配」，不知各类型的确切形状（`money` 是 `{amount, currency}`） |
| 5 | **未经第二人复核** | 全部由我一人从源码读出，有误读可能 |
