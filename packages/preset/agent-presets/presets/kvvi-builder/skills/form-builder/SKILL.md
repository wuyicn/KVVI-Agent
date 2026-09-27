---
name: form-builder
description: 表单生成——字段控件、分组布局、条件显隐，产出 view-schema 契约。适用于「做一个员工信息登记表」「帮我做个申请单」这类需求。前置依赖 data-model。
---

# 表单生成（form-builder）

把数据模型转成一张**可通过校验的** `view-schema/lce-safe-v1` 契约。

表单是模型的可写视图，不是模型的复述：**字段的呈现顺序、分组、显隐，
都由填写人的实际动作决定，不由表结构决定。**

## 先说产出是什么

产出**不是**一份「表单草案」，而是 `view-schema` 的 **`Spec`**，且 `view_type` 为 `"FORM"`。

> **判定标准**：不能被 MetaSchema 校验的产出，不属于本产品的搭建产出。

## ⚠️ 先划清职责边界（最容易搞错的一点）

**`view-schema` 只管「怎么呈现」，不管「怎么校验」。**

| 你想做的事 | 该去哪 |
|---|---|
| 字段的必填、长度、范围、格式 | **`business-schema`**（模型的字段约束） |
| 「这个角色在这一档必须填」 | **`permission-spec`** 的 FIELD 策略（`required_field`）—— 与模型层的 `required` 是**两道叠加的闸**，见 `workflow-builder` §5.2 |
| 跨字段与跨记录的不变量 | **`business-schema`**（模型的 record_rules） |
| 唯一性 | **`business-schema`**（索引） |
| 字段出现在哪、什么顺序、什么条件显示 | **`view-schema`**（本 Skill） |

**所以**：如果模型里缺一条校验规则，**不要在本契约里想办法表达** ——
回到 `data-model` 把它加到字段约束里。**在表单层写校验是实现不了的**，
运行时校验只认模型。

> 三层校验的说法仍然成立，但**分层不在本契约内**：
> 即时校验与提交校验由模型字段约束驱动，服务端校验由模型不变量驱动。
> **本 Skill 的职责是让这些字段以正确的形态出现在填写人面前。**

## 何时用

- 用户要一张具体的录入界面：*「做一个员工信息登记表」*
- 用户描述了一次数据采集动作：*「让申请人填这些信息」*
- `data-model` 定完模型后，为每个可写实体生成表单

## 前置

模型未定时**先跑 `data-model`**。表单字段必须来自模型字段，
不要为了界面好看临时加字段 —— 临时字段会绕过约束和不变量，
而且**引用校验会直接拒绝**（绑定的字段必须真实存在于模型里）。

---

# 一、概念对照

| 你可能会说 | 契约里是 |
|---|---|
| 表单 | `view-schema` 的 `Spec`，`view_type: "FORM"` |
| 字段控件 | 一个 `ViewNode` + `props.fieldBinding` |
| 分组 | `Section` 组件 |
| 左右分栏 | `Grid` 组件 |
| 条件显隐 | `node.condition`（`SafeExpression`） |
| 明细行 / 子表 | `node.loop`（`DataBindingRef`） |
| 提交按钮 | `SubmitButton` 组件 + `actions` |
| 字段的中文名 | `label`（在模型里，不在本契约） |

**没有「表单标题」这个独立字段** —— `name` 是视图名，不是页面上印的标题。
页面上要显示的文字用 `Text` 组件。

---

# 二、Spec 骨架

**六个字段全部必填**：

```jsonc
{
  "view_code": "general_item_form",
  "name": "通用事项登记表单",
  "view_type": "FORM",
  "businessSchemaRef":    { … },   // ★ 指向 data-model 产出的 schema
  "componentRegistryRef": { … },   // ★ 指向组件注册表
  "componentsTree":       [ … ]    // ★ 恰好 1 个元素
}
```

⚠️ **`componentsTree` 恰好一个元素** —— 契约写的是 `minItems: 1, maxItems: 1`。
想放多个顶层块，**用根节点的 `children`**，不要加第二个元素。

### 两个引用都不能编

- `businessSchemaRef` → 指向**本次的模型**（`asset_type: "BUSINESS_SCHEMA"`）
- `componentRegistryRef` → 指向**组件注册表**（`asset_type: "COMPONENT_REGISTRY"`）

两者的 `digest` **必须是真实值**。写占位符结构能过、引用校验必挂。

**注册表不只是名单** —— 它决定每个组件允许的父组件、子组件、props 形状、
能绑哪些字段类型。**所以必须先取到注册表再动手**（见 §三）。

---

# 三、组件怎么选

## 3.1 字段类型 → 组件

**字段类型与组件必须匹配**，否则 `VIEW_FIELD_REF_INVALID`：

| 模型字段类型 | 组件 |
|---|---|
| `short_text` | `ShortTextField` |
| `long_text` | `LongTextField` |
| `boolean` | `BooleanField` |
| `integer` | `IntegerField` |
| `decimal` | `DecimalField` |
| `money` | `MoneyField` |
| `date` | `DateField` |
| `datetime` | `DateTimeField` |
| `single_select` | `SingleSelectField` |
| `multi_select` | `MultiSelectField` |

**组件名不能凭直觉猜** —— 名字看起来合理但未登记，一样 `VIEW_COMPONENT_UNREGISTERED`。
上游注册表里同时有 `Text`（静态文本）与 `ShortTextField`（可填字段），
**两者不可混用**。

## 3.2 根节点与容器

| 用途 | 组件 | 约束 |
|---|---|---|
| 表单根 | `FormPage` | **`allowedParents` 为空** —— 只有它能当根 |
| 分组 | `Section` | 可嵌套自身 |
| 分栏 | `Grid` | 可嵌套自身 |

**根节点必须是 `FormPage`** —— 用 `ListPage` 或 `DetailPage` 会因
`viewTypes` 不含 `FORM` 被拒。

**每 5–9 个字段分一组**，组有标题。超过 15 个字段必须分组。

## 3.3 其他可用组件

`Table`、`Description`、`StatusBadge`、`OpenRecordLink`、
`SaveDraftButton`、`SubmitButton`、`CancelButton`

---

# 四、字段绑定

```jsonc
{
  "id": "f_title",
  "componentName": "ShortTextField",
  "props": {
    "fieldBinding": { "type": "FieldRef", "fieldRef": "title" }
  }
}
```

**要过两关**：

1. `fieldRef` 必须是**模型里真实存在的 `field_code`**
2. 该字段的**类型**必须在组件的 `fieldTypes` 里

**第二关最容易忽略**：`ShortTextField` 绑不了 `money` 字段 ——
**选组件要看字段类型，不是看组件名**。

> ⚠️ 字段名不要用平台的 12 个保留字（`id` / `status` / `created_at` …）。
> 那是模型层的问题，但表单会第一个暴露它。

---

# 五、条件显隐

用 `node.condition` 表达，**不是字符串表达式**：

```jsonc
{
  "id": "f_reason",
  "componentName": "LongTextField",
  "condition": {
    "type": "SafeExpression",
    "left": { "type": "FieldRef", "fieldRef": "item_status" },
    "operator": "eq",
    "right": "rejected"
  },
  "props": { "fieldBinding": { "type": "FieldRef", "fieldRef": "reason" } }
}
```

**操作符枚举**：`eq` / `ne` / `gt` / `gte` / `lt` / `lte` /
`in` / `not_in` / `is_empty` / `not_empty`

**组合**用 `all` / `any` / `not`：

```jsonc
"condition": {
  "type": "SafeExpression",
  "all": [
    { "left": { "type": "FieldRef", "fieldRef": "amount" }, "operator": "gt", "right": 50000 },
    { "left": { "type": "FieldRef", "fieldRef": "item_status" }, "operator": "ne", "right": "approved" }
  ]
}
```

**没有任意代码** —— 想写 `a && b || !c` 这种，用 `all`/`any`/`not` 组合出来。

> **隐藏字段的旧值必须清空** —— 否则会带着用户看不见的脏数据提交。
> 这一点**契约不检查**，要靠实现保证，产出时要向用户说明。

---

# 六、明细行（子表）

用 `node.loop`：

```jsonc
{
  "id": "lines_table",
  "componentName": "Table",
  "loop": { "type": "DataBindingRef", "queryCode": "…", "itemKey": "id", "maxItems": 200 }
}
```

`DataBindingRef` 四个字段全必填：`queryCode`、`itemKey`、`maxItems`（1–200）。

**`loopArgs` 的取值固定为 `["item", "index"]`** —— 写别的会被拒。
而且 **`loopArgs` 必须与 `loop` 同时出现**。

---

# 七、一份完整的、已验证的示例

```json
{
  "view_code": "general_item_form",
  "name": "通用事项登记表单",
  "view_type": "FORM",
  "businessSchemaRef": {
    "scope_type": "TENANT",
    "scope_id": "11111111-1111-4111-8111-111111111111",
    "app_id": "22222222-2222-4222-8222-222222222222",
    "module_id": "33333333-3333-4333-8333-333333333333",
    "asset_type": "BUSINESS_SCHEMA",
    "asset_id": "general_item",
    "version": 1,
    "digest": "sha256:898c0ae169c52fbce26428e3eb90a92763e3615ab9521aa44ef120b79edeeca1"
  },
  "componentRegistryRef": {
    "scope_type": "PLATFORM_CONTROL",
    "scope_id": "kvvi-platform",
    "app_id": null,
    "module_id": null,
    "asset_type": "COMPONENT_REGISTRY",
    "asset_id": "vue_element_approved",
    "version": 1,
    "digest": "sha256:09b78fdd43ca6556a626e7b532ab05f5bf87ab8012ba4d9a018386af808c34f5"
  },
  "componentsTree": [
    {
      "id": "page_root",
      "componentName": "FormPage",
      "children": [
        {
          "id": "basic_section",
          "componentName": "Section",
          "props": {
            "title": "事项信息"
          },
          "children": [
            {
              "id": "f_title",
              "componentName": "ShortTextField",
              "props": {
                "fieldBinding": {
                  "type": "FieldRef",
                  "fieldRef": "title"
                }
              }
            },
            {
              "id": "f_detail",
              "componentName": "LongTextField",
              "props": {
                "fieldBinding": {
                  "type": "FieldRef",
                  "fieldRef": "detail"
                }
              }
            },
            {
              "id": "f_amount",
              "componentName": "MoneyField",
              "props": {
                "fieldBinding": {
                  "type": "FieldRef",
                  "fieldRef": "amount"
                }
              }
            },
            {
              "id": "f_due",
              "componentName": "DateField",
              "props": {
                "fieldBinding": {
                  "type": "FieldRef",
                  "fieldRef": "due_date"
                }
              }
            }
          ]
        },
        {
          "id": "system_section",
          "componentName": "Section",
          "props": {
            "title": "系统字段（只读）"
          },
          "children": [
            {
              "id": "f_item_no",
              "componentName": "Description",
              "props": {
                "value": {
                  "type": "FieldRef",
                  "fieldRef": "item_no"
                }
              }
            },
            {
              "id": "f_status",
              "componentName": "StatusBadge",
              "props": {
                "value": {
                  "type": "FieldRef",
                  "fieldRef": "item_status"
                }
              }
            }
          ]
        },
        {
          "id": "btn_submit",
          "componentName": "SubmitButton"
        }
      ]
    }
  ]
}
```

**这份示例是校验通过的状态** —— 从本文件提取后可直接跑（配 `样例/view-schema/context.json`）：
结构 + 语义 + 引用三层全通过。

> ⚠️ 示例里的 `businessSchemaRef` / `componentRegistryRef` 含**本部署特有的值**
> （`scope_id`、`asset_id`、`version`、`digest`）。**照抄会让引用失效** ——
> 必须从平台侧取得真实值。

---

# 八、自查

```bash
python3 工具/check_skill_output.py <你的Spec.json> \
  --contract view-schema/lce-safe-v1 --context <配套context.json>
```

**这条契约有完整校验**（结构 + 语义 + 引用），所以这条命令跑绿就是真绿。

跑之前先自己过一遍：

- [ ] 每个 `fieldRef` 都在模型里存在，且**类型与组件匹配**
- [ ] 每个 `componentName` 都在注册表里，且 `viewTypes` 含 `FORM`
- [ ] 根节点是 `FormPage`（不是 ListPage / DetailPage）
- [ ] **所有 `id` 唯一**，且没有沿用上下文里 `deleted_node_ids` 中的 id
- [ ] `loop` 与 `loopArgs` 成对出现，`loopArgs` 是 `["item","index"]`
- [ ] `props` 里没有多余的键（`additionalProperties: false`）
- [ ] 条件显隐用的是 `SafeExpression` 对象，不是字符串

---

## 常见错误

| 错误 | 后果 | 正确做法 |
|---|---|---|
| 把校验规则写进表单 | **实现不了** —— 运行时只认模型 | 回到 `business-schema` 加字段约束 |
| 把系统字段放进表单 | 用户填不该填的 | 系统生成，只读展示 |
| 隐藏字段不清值 | 脏数据静默入库 | 实现层保证，并向用户说明 |
| 临时加模型里没有的字段 | 引用校验直接拒绝 | 先改模型 |
| `Text` 当成输入框 | 用户填不进去 | 输入用 `*TextField` |
| 组件名凭直觉猜 | `VIEW_COMPONENT_UNREGISTERED` | 从注册表里选 |
| 字段类型与组件不匹配 | `VIEW_FIELD_REF_INVALID` | `money` 只能用 `MoneyField` |
| `componentsTree` 放两个根 | 结构错误 | 一个根，其余放 `children` |
| 15 个字段不分组 | 用户漏填、填错 | 用 `Section` 分组 |
| 条件写成字符串表达式 | 结构错误 | 用 `SafeExpression` 对象 |

## 交接

- 表单提交后的流转 → `workflow-builder`
- 表单数据要被统计 → `dashboard-builder`
- 表单要被外部系统调用 → `api-spec`
