# `view-schema` 结构约定（B2：提前冻结）

> **为什么提前冻结**：卡 2（`form-builder`）与卡 4（`dashboard-builder`）**共用**
> `view-schema`。若不先约定，两者并行时会各自发明一套用法，合并时必然返工。
> 按任务卡的 **B2 方案**，本约定与卡 1 同阶段冻结，使 B 阶段四个面真正独立。
>
> **来源**：从 `view-schema.lce-safe-v1.schema.json` 与 **`view.mjs` 的校验逻辑**反推，
> 并用 172 个官方用例（32 正例 / 140 负例）与一份实测样例交叉验证。
>
> **本文档的每条约定都在 `样例/view-schema/通用事项登记表单.spec.json` 上验证过**
> （结构 + 语义 + 引用三层通过）。

---

## 一、Spec 的骨架

**六个必填字段**：

```jsonc
{
  "view_code": "general_item_form",          // Code 格式
  "name": "通用事项登记表单",                  // 1–80 字符
  "view_type": "FORM",                       // FORM | LIST | DETAIL
  "businessSchemaRef":   { … },              // AssetRef，asset_type = BUSINESS_SCHEMA
  "componentRegistryRef": { … },             // AssetRef，asset_type = COMPONENT_REGISTRY
  "componentsTree": [ … ]                    // ★ 恰好 1 个元素
}
```

可选：`queries`、`i18n`、`meta`

### ⚠️ `componentsTree` 恰好一个元素

契约写的是 `minItems: 1, maxItems: 1` —— **单根树**。
想放多个顶层块，用根节点的 `children`，**不要**加第二个元素。

### ⚠️ `view_type` 只有三类

`FORM` / `LIST` / `DETAIL`。**没有看板或图表类型** —— 见 §5。

---

## 二、两个引用都必须能解析

| 引用 | `asset_type` | 校验要求 |
|---|---|---|
| `businessSchemaRef` | `BUSINESS_SCHEMA` | 能在上下文中解析，否则 `VIEW_REFERENCE_VERSION_CONFLICT` |
| `componentRegistryRef` | `COMPONENT_REGISTRY` | 不仅要能解析，还必须 **`state === "PUBLISHED"`**，且 **`version` 与引用一致**，否则 `VIEW_COMPONENT_UNREGISTERED` |

**`digest` 必须是真实值**（与 business-schema 那条同理），占位符会让引用校验失败。

---

## 三、`ViewNode`：节点长什么样

```jsonc
{
  "id": "f_title",                    // ^[a-z][a-z0-9_-]{2,127}
  "componentName": "ShortTextField",  // ★ 必须**大写开头**：^[A-Z][A-Za-z0-9]{1,63}
  "props": { … },                     // 可选
  "children": [ … ],                  // 可选
  "condition": { … },                 // 可选，SafeExpression
  "loop": { … },                      // 可选，DataBindingRef
  "loopArgs": ["item", "index"],      // 可选，**取值固定为这两个**
  "actions": { … }                    // 可选，ActionRef 映射
}
```

**必填只有 `id` 与 `componentName`。**
**`additionalProperties: false`** —— 多写一个键就报错。

### 节点 id 全局唯一

同一份视图内**不可重复**。注意：判定时还会带上上下文里
`view.deleted_node_ids` —— **已被删除的 id 也不能复用**。

---

## 四、组件注册表决定一切 ⚠️

**这是本节最重要的一条**：`ViewNode` 的合法性**完全由组件注册表决定**，
契约本身只规定形状。每个组件定义里带着：

| 字段 | 作用 |
|---|---|
| `state` | 必须 `PUBLISHED`，否则 `VIEW_COMPONENT_UNREGISTERED` |
| `viewTypes` | **必须包含当前 `spec.view_type`** —— 同一个组件在不同页型下可用性不同 |
| `allowedParents` | 允许的父组件。**根节点的组件必须 `allowedParents` 为空** |
| `allowedChildren` | 允许的子组件。不在表内即 `VIEW_CHILD_NOT_ALLOWED` |
| `maxChildren` | 子节点数量上限 |
| `propsSchema` | `props` 必须匹配，否则 `VIEW_PROP_INVALID` |
| `bindingPositions` | 某个 prop 允许出现哪些绑定类型的 `{type: …}` |
| `fieldTypes` | **该组件能绑定哪些字段类型**，不符即 `VIEW_FIELD_REF_INVALID` |
| `loopSupported` | 不支持时写了 `loop` 直接报错 |
| `events` | 该组件允许的事件名，及每个事件允许的 `capability_code` |

> **实务含义**：**必须先取到注册表，才知道能用哪些组件、怎么组合。**
> 不要凭组件名猜测 —— 名字看起来合理但未登记，一样 `VIEW_COMPONENT_UNREGISTERED`。

### 当前注册表的内容（`asset_id: vue_element_approved`，23 个）

| 类别 | 组件 |
|---|---|
| **页面级（根）** | `FormPage`（FORM）、`ListPage`（LIST）、`DetailPage`（DETAIL）—— `allowedParents` 均为空 |
| **容器** | `Section`、`Grid` —— 可嵌套自身 |
| **字段类** | `ShortTextField`、`LongTextField`、`BooleanField`、`IntegerField`、`DecimalField`、`MoneyField`、`DateField`、`DateTimeField`、`SingleSelectField`、`MultiSelectField` |
| **展示类** | `Table`、`Text`、`Description`、`StatusBadge`、`OpenRecordLink` |
| **按钮类** | `SaveDraftButton`、`SubmitButton`、`CancelButton` |

---

## 五、⚠️ 当前注册表里**没有图表组件**（对卡 4 的直接影响）

23 个组件**全部不含**任何图表（线图、柱图、饼图等）。

而 `view_type` 只有 `FORM` / `LIST` / `DETAIL` —— **没有看板类型**。

**这意味着**：按当前契约与注册表，**PRD §5.1 给 dashboard-builder 指定的目标契约
（`view-schema` + 聚合口径配置）无法表达一个看板。**

三种可能，**必须在卡 4 开工前澄清**：

| 可能 | 含义 |
|---|---|
| A | 生产环境的注册表**另有图表组件**，`vue_element_approved` 只是测试 fixture |
| B | 看板由**新的 `view_type`** 承载，契约需要扩展 |
| C | 看板用 `DETAIL` 承载，图表作为组件加进注册表 |

**这是任务卡待办 3 的答案**：不是「聚合口径配置落在哪个 schema」的问题，
而是**更前面的一步 —— 看板在当前契约下根本没有载体**。

> **本文档不下结论**，只把事实摆出来：以上判断基于唯一的可用注册表
> （`vue_element_approved`，来自测试 fixture）。**卡 4 开工前须向产品侧确认。**

---

## 六、字段绑定

```jsonc
"props": {
  "fieldBinding": { "type": "FieldRef", "fieldRef": "title" }
}
```

- `fieldRef` 必须是 **`businessSchemaRef` 所指 schema 里真实存在的 `field_code`**
- 还要满足**两个附加条件**：
  1. `FieldRef` 必须出现在该 prop 的 `bindingPositions` 里
  2. 该字段的**类型**必须在组件的 `fieldTypes` 里

> **第二条最容易忽略**：`ShortTextField` 绑不了 `money` 字段。
> 选组件时要看字段类型，不是看组件名。

---

## 七、其他会被拒绝的写法

| 写法 | 诊断 |
|---|---|
| `loopArgs` 存在但无 `loop` | `VIEW_PROP_INVALID` |
| 写了 `loop` 但组件 `loopSupported` 为假 | `VIEW_PROP_INVALID` |
| `actions` 里的事件名不在组件 `events` 里 | `VIEW_ACTION_FORBIDDEN` |
| action 的 `capability_code` 不在该事件允许列表里 | `VIEW_ACTION_FORBIDDEN` |
| 子节点数超过 `maxChildren` | `VIEW_CHILD_NOT_ALLOWED` |
| 子节点组件不在 `allowedChildren` 里 | `VIEW_CHILD_NOT_ALLOWED` |
| `props` 里的 `{type: …}` 不出现在该 prop 的 `bindingPositions` 里 | `VIEW_PROP_INVALID` |
| `i18n` 的 locale 名无效 | `VIEW_PROP_INVALID` |
| 表达式中含不安全构造 | `VIEW_EXPRESSION_UNSAFE` |
| 出现原始代码 | `VIEW_RAW_CODE_FORBIDDEN` |
| 数据源越界 | `VIEW_DATA_SOURCE_FORBIDDEN` |

---

## 八、自查

```bash
node tools/meta-schema/node/cli.mjs \
  --contract view-schema/lce-safe-v1 --entry spec --checks complete \
  --context 样例/view-schema/context.json \
  < 你的Spec.json
```

或：

```bash
python3 工具/check_skill_output.py <你的Spec.json> \
  --contract view-schema/lce-safe-v1 --context 样例/view-schema/context.json
```

退出码 `0` = 通过。

---

## 九、本约定已知的不足

| # | 不足 | 影响 |
|---|---|---|
| 1 | **基于测试 fixture 的注册表** | 「没有图表组件」这一结论可能不适用于生产注册表，见 §5 |
| 2 | **`queries` 与 `meta` 未整理** | 本文只覆盖 `componentsTree` 主路径 |
| 3 | **`SafeExpression` 与 `DataBindingRef` 的可用构造未展开** | 只知道不安全会被拒，不知确切白名单 |
| 4 | **action 的 `capability_code` 清单未列出** | 依赖 `CAPABILITY_REGISTRY`，本文未整理 |
| 5 | **未经第二人复核** | 全部由我一人从源码与用例读出 |
