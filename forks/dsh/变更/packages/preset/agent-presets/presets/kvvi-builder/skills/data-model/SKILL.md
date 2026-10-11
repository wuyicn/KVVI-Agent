---
name: data-model
description: 从业务描述推导数据模型——实体、字段、关系、约束、状态，并产出 business-schema 契约。适用于「这个系统的数据表怎么设计」「数据怎么存」这类需求，也是 form-builder / workflow-builder / dashboard-builder 的前置步骤。
---

# 数据模型推导（data-model）

把一段业务描述变成**可通过校验的** `business-schema/v1` 契约。这是所有其他搭建
Skill 的地基：表单是模型的可写视图，审批流是模型的状态迁移，看板是模型的聚合读视图。
**模型错了，后面三样全错。**

## 先说产出是什么

产出**不是**一份「模型草案」，而是 `business-schema/v1` 的 **`Spec`**。

> **判定标准**：不能被 MetaSchema 校验的产出，不属于本产品的搭建产出。

所以「写完了」的定义是**通过校验**，不是「看起来对」。没跑过校验就等于没做完。

## 何时用

- 用户描述了业务但没说数据结构：*「我们公司报销要走审批」*
- 用户直接问模型设计：*「这个系统的数据表怎么设计」*
- **在写任何表单、流程、看板之前**——先推导模型，不要边写界面边补字段

## 先分清你在哪个场景

**这决定了校验会怎么判你**，先问清楚再动手：

| 场景 | 含义 | 校验重点 |
|---|---|---|
| **新建** | 这些实体此前不存在 | 产出物本身是否合法 |
| **修改** | 已有一版模型在运行 | 还要看**与已发布版本的变化是否被允许** |

修改场景下，改字段类型、删字段会触发 `BREAKING_CHANGE_FORBIDDEN`；
结构变化可能要求 `MIGRATION_REQUIRED`。

**看到这两个诊断不要以为是自己写错了** —— 那是「你在动一个已发布的模型」，
需要的是迁移方案或与用户确认，不是改语法。

## 不预设行业词汇

本引擎不带行业组件库。不要因为听到「报销」就套一张既有费用表模板，
也不要引入「工单」「报货单」「病历」这类行业家具当作原语。
**从用户实际说出的名词和动词里推导实体**，用户没说的不要编。

---

# 第一步：推导（不碰契约）

## 1. 抽名词 → 候选实体

| 判据 | 结论 |
|---|---|
| 有生命周期（会经历状态变化） | **实体** |
| 需要被多次创建、每条有独立身份 | **实体** |
| 只是描述另一个东西的属性 | **字段** |
| 是固定的少数几个选项 | **枚举值**，不是实体 |

复数的、可数的、需要「查某一条」的 → 实体。单数且从属于某实体的 → 字段。

## 2. 抽动词 → 关系与状态迁移

- **关系**：*「员工提交申请」* → 员工与申请之间有一条 `提交者` 关系
- **状态迁移**：*「提交后进入待审批」* → 申请有状态字段

动词里凡出现「审批 / 通过 / 驳回 / 撤销 / 关闭」的，都要收敛成**状态枚举**，
**不要**做成布尔字段 —— 布尔无法表达「驳回后重新提交」。

## 3. 定字段

每个字段必须能回答四个问题：

| 问题 | 说明 |
|---|---|
| 类型 | 见下方「类型清单」 |
| 必填 | 业务上真的必须有，还是只是常见？**别把常见当必须** |
| 约束 | 长度、范围、格式、精度。金额用 `money` 类型，**绝不用浮点** |
| 来源 | 用户填的 / 系统生成的 / 从别处引用来的 |

**必填与可空互斥**：`required: true` 的字段不能同时 `nullable: true`。

## 4. 定关系

| 关系 | 建模方式 |
|---|---|
| 一对多 | 子表持 `父id` |
| 多对多 | 中间实体，或数组字段 |
| 引用 | 存对方 id，**不复制字段** |

关系**必须显式声明**：`部门名称` 是复制了字段，`部门id` 才是引用。
复制字段会在源头改名时静默漂移。

## 5. 定状态机

```
状态: 草稿 → 待审批 → 已通过
              ↓
            已驳回 → 草稿（可重新提交）
```

每个迁移标注：谁能触发、触发后哪些字段变、是否需要审批记录。

## 6. 定不变量

业务规则里「必须/不能/至少」这类句子是不变量，要落成**约束**而不是注释。

---

# 第二步：落到契约

推导完，把它写成 `business-schema/v1` 的 `Spec`。

## Spec 骨架

```jsonc
{
  "schema_code": "general_item",          // 小写字母开头，3-64 位 [a-z0-9_]
  "name": "通用事项",
  "description": "…",                     // 可选
  "field_type_registry_ref": { … },       // 必填，见下
  "fields": [ … ]                         // 至少 1 个，至多 100 个
}
```

支持的其他键：`record_number`、`indexes`、`record_rules`、`layout`

## `field_type_registry_ref` 不能编

它声明**本契约启用哪些字段类型**，`fields[].type` 必须落在其中。

```jsonc
"field_type_registry_ref": {
  "scope_type": "PLATFORM_CONTROL",
  "scope_id": "kvvi-platform",
  "app_id": null,
  "module_id": null,
  "asset_type": "FIELD_TYPE_REGISTRY",
  "asset_id": "…",          // 平台侧的实际值
  "version": 1,             // 平台侧的实际值
  "digest": "sha256:…"      // ★ 必须是**真实摘要**
}
```

**最常见的一种失败**：写个 `sha256:aaaa…` 占位。结构校验能过，**引用校验必挂**。
`asset_id` / `version` / `digest` 必须从平台侧取得。

## 字段编码：这 12 个名字不可用

```
id  tenant_id  form_code  schema_version  status  owner_id
created_by  updated_by  created_at  updated_at  data  record_no
```

也不要用以 `_platform_` 开头的名字，不要与 `record_number.field_code` 相同。

> ⚠️ **`status` 是最容易踩的一个**：它是业务上最自然的状态字段名，
> 但**已被平台占用**。改用 `item_status` 或更贴业务的称呼。
>
> `field_code` 的格式是 `^[a-z][a-z0-9_]{2,63}$`（小写字母开头，3-64 位）。
> **格式合法不等于可用** —— 保留字是另一层检查。

## 一个字段长什么样

```jsonc
{
  "field_code": "amount",
  "label": "金额",
  "type": "money",
  "required": true,
  "nullable": false,
  "write_policy": "MUTABLE",        // MUTABLE | CREATE_ONLY | SYSTEM
  "query": { "searchable": false, "filterable": true, "sortable": true },
  "type_config": { "currency_mode": "FIXED", "currency": "CNY" }
}
```

## 只有这四类需要 `type_config`

| 类型 | `type_config` |
|---|---|
| `money` | `{"currency_mode": "FIXED", "currency": "CNY"}` |
| `decimal` | `{"precision": 18, "scale": 2}` |
| `single_select` | `{"options": [{"code": "draft", "label": "草稿", "order": 0, "enabled": true}, …]}` |
| `multi_select` | 同上 |

**其余类型不要带 `type_config`。** 缺了它报结构错误，多了也可能被拒。

## 会被校验器拒绝的写法

### ⚠️ 这三个字段**运行时真的会执行**（选错就有人用不了）

| 字段 | 运行时怎么执行 | 选错的后果 |
|---|---|---|
| `required: true` | **新增**时必须有值（空串也算没填） | 少填一个就 400 `KVVI_FIELD_REQUIRED`，员工存不下这条记录 |
| `write_policy: CREATE_ONLY` | 新增可写、**修改一律拒** | 挑错了这个值，员工以后**永远改不了**这个字段 |
| `write_policy: SYSTEM` | 人不可写（新增与修改都拒） | 挑错了，员工建记录时就被 400 挡住 |

更新是**补丁**语义：改一个字段不必回传其它必填字段。

这些约束**在 JSON Schema 里看不出来**，只有语义校验才报：

| 写法 | 为什么不行 |
|---|---|
| `required: true` + `nullable: true` | 互斥 |
| `write_policy: "SYSTEM"` | 该字段必须同时在上下文的 generators 里声明；否则用 `MUTABLE` 或 `CREATE_ONLY` |
| `query.searchable: true` 用在非文本类型上 | 只有 `short_text`/`long_text`/`single_select`/`multi_select` 可搜索 |
| `query.sortable: true` 用在 `long_text`/`multi_select` 上 | 这两类不可排序 |
| `money` 的 `currency` 不在平台的货币规则里 | 先确认支持哪些币种 |
| `decimal` 的 `scale > precision` | 小数位不能多于总位数 |
| `short_text` 的 `pattern` | 必须是平台允许的安全模式，不是任意正则 |
| 两个字段用同一个 `field_code` | 重复 |
| `single_select` 的 options 里有重复 `code` | 重复 |

## 索引

用户说“不能重复登记”时，先确认是单项不重复，还是多个项目的组合不重复。把确认后的规则写进 `indexes`，例如 `{"index_code":"unique_account","kind":"UNIQUE","fields":["account"]}`；不要只在说明里承诺，也不要自行增加未定义的字段属性。组合规则用同一个 `fields` 数组，最多四项。对用户只说“不允许重复”，不讲底层索引名称。

规则经所有者批准并发布后，新增、编辑和 AI 写入都检查同公司、同表单的记录，包含当前员工看不到的记录，但不能展示冲突记录的内容。可选项目未填、空值或空字符串不参与查重；组合里任一项未填也不参与。大小写和前后空格目前按原值区分，需要别的口径应明确告知尚未支持，不能承诺自动处理。发布前已有重复数据会拒绝启用规则，应请用户修正，不自动删除数据。未收到发布成功结果，不声称已启用。

- `index_code` 不可重复
- 索引里的字段必须**已存在**于 `fields`
- `long_text` **不能**建唯一索引

---

## 一份完整的、已验证的示例

下面这份是**最小可通过**的 Spec（三个字段：文本 / 金额 / 单选）。
照着它的结构写，替换成你自己的实体与字段：

```json
{
  "schema_code": "general_item",
  "name": "通用事项",
  "description": "一类需要登记、跟踪状态、可被审批的业务事项",
  "field_type_registry_ref": {
    "scope_type": "PLATFORM_CONTROL",
    "scope_id": "kvvi-platform",
    "app_id": null,
    "module_id": null,
    "asset_type": "FIELD_TYPE_REGISTRY",
    "asset_id": "fake-business-types",
    "version": 1,
    "digest": "sha256:a36716610e06b202ea165484cd58fef645905408aac7534ebdb47791c17649d2"
  },
  "fields": [
    {
      "field_code": "title",
      "label": "标题",
      "type": "short_text",
      "required": true,
      "nullable": false,
      "write_policy": "MUTABLE",
      "query": {
        "searchable": true,
        "filterable": false,
        "sortable": false
      }
    },
    {
      "field_code": "amount",
      "label": "金额",
      "type": "money",
      "required": true,
      "nullable": false,
      "write_policy": "MUTABLE",
      "query": {
        "searchable": false,
        "filterable": true,
        "sortable": true
      },
      "type_config": {
        "currency_mode": "FIXED",
        "currency": "CNY"
      }
    },
    {
      "field_code": "item_status",
      "label": "状态",
      "type": "single_select",
      "required": true,
      "nullable": false,
      "write_policy": "MUTABLE",
      "query": {
        "searchable": false,
        "filterable": true,
        "sortable": false
      },
      "type_config": {
        "options": [
          {
            "code": "draft",
            "label": "草稿",
            "order": 0,
            "enabled": true
          },
          {
            "code": "submitted",
            "label": "待审批",
            "order": 1,
            "enabled": true
          },
          {
            "code": "approved",
            "label": "已通过",
            "order": 2,
            "enabled": true
          }
        ]
      }
    }
  ]
}
```

> **这份示例的每一行都是校验通过的状态**（结构 + 语义 + 引用三层）。
> 若你写出的东西被拒，先与它逐项对照 —— 差异处通常就是问题所在。
>
> ⚠️ **但 `field_type_registry_ref` 里的三个值不能照抄**：
> `asset_id`、`version`、`digest` 是**本部署特有的**，上面那组只是让示例能跑起来。
> 照抄会让引用校验失败（`REFERENCE_DIGEST_MISMATCH`）。
> **必须从平台侧取得真实值** —— 拿不到就先问，不要用占位符蒙。

# 第三步：自查

**产出前必须跑校验**。这是「写完了」的定义。

```bash
node tools/meta-schema/node/cli.mjs \
  --contract business-schema/v1 --entry spec --checks complete \
  --context <上下文.json> < 你的Spec.json
```

退出码：**0 = 通过**，2 = 有校验错误，1 = 执行失败。

**拿到非 0 不要重试同样的写法** —— 看诊断里的 `path` 定位到具体字段，
对照上表修。若诊断是 `MIGRATION_REQUIRED` 或 `BREAKING_CHANGE_FORBIDDEN`，
说明你在**修改已有模型**，需要的是迁移方案而非改语法。

---

## 常见错误

| 错误 | 后果 | 正确做法 |
|---|---|---|
| 把属性当实体 | 表爆炸，或该拆的没拆 | 有独立身份和生命周期的才是实体 |
| 把实体压成字段 | 无法记录多条 | 「多条明细」必须建子实体 |
| 用布尔代替状态 | 驳回后无法回退 | 用状态枚举 |
| 金额用浮点 | 累加误差，对不平账 | `money` 类型 |
| 复制字段代替引用 | 源改名后静默不一致 | 存 id 做引用 |
| 业务规则写进注释 | 无人执行，形同不存在 | 落成约束 |
| 编造用户没说的规则 | 原型与业务不符 | 标为待确认，不要猜 |
| **产出没跑校验** | 交付物过不了发布通道 | 三步自查必须跑 |
| 用 `status` 作字段名 | 与平台保留字冲突 | 换名 |

## 交接

模型定完后交给下游 Skill：

- 每个可写实体 → `form-builder`
- 每条状态机 → `workflow-builder`
- 每个聚合读视图 → `dashboard-builder`
- 每个跨系统边界 → `api-spec`

## 边界

**不要**编写任意语言的业务代码、执行脚本、安装依赖、修改运行时地基。
搭建的产出是**声明式契约**，不是可执行代码。
