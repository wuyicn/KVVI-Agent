---
name: dashboard-builder
description: 看板生成——指标口径、图表选择、权限与不变量的产出 view-schema 契约与口径登记单。适用于「做一个月度销售趋势看板」「我想看各部门的完成情况」这类需求。前置依赖 data-model。
---

# 看板生成（dashboard-builder）

把数据模型转成**两个可通过校验的产出**：一份 `view-schema/lce-safe-v1` 契约，
和一份口径登记单。

看板回答的是**「业务现在怎么样」**。它不是一个把数据画成图的地方，
是一个让人**做出决定**的地方。每放一个图表都要能回答：看到它之后，人会做什么？

答不上来的图表，删掉。

## 先说产出是什么

| 产出 | 契约 / 判据 | 谁校验 |
|---|---|---|
| 看板的**结构** | `view-schema` 的 `Spec`，`view_type` 为 `"LIST"` | MetaSchema 验证器（**完整校验**） |
| 看板的**每条口径** | 口径登记单（`aggregate` / `scopes` / `resource` / `inject`） | `工具/check_invariant.py --input`（§9.8.1 不变量） |

**两份都要交。** 只交结构，口径就没有过 §9.8.1 的机器判定；
只交口径，看板就没有过契约校验。

> **判定标准**：不能被校验的产出，不属于本产品的搭建产出。

## ⚠️ 先划清职责边界（最容易搞错的一点）

**`view-schema` 只管「看板长什么样」，不管「数字怎么算」。**

| 你想做的事 | 该去哪 |
|---|---|
| 指标的算式、分母、去重、时间口径 | **聚合口径**（`CAPABILITY` 资产，本 Skill 的产出之一） |
| 谁有资格看这个口径 | **`permission-spec`** 的 `data_scopes`（**不是**本 Skill 决定的） |
| 字段的必填、长度、范围 | **`business-schema`**（模型字段约束） |
| 图表摆在哪、绑哪个口径 | **`view-schema`**（本 Skill） |

**所以**：口径没定清楚的指标**不要放进看板** —— 看板层无法表达算式，
硬塞进去只会得到一个「看起来有数字、但没人知道怎么算出来的」图。

> **口径必须写死在配置里（冻结决策 Q8）**：只有持有构建系统权限的人能改，
> 员工侧改不了，所以天然可审计。
> **推论**：v1 的看板**不提供「让用户改口径」的筛选器** —— 见 §五。

## 何时用

- 用户要看汇总：*「做一个月度销售趋势看板」*
- 用户要看分布或对比：*「各个部门的完成情况」*
- `data-model` 定完模型后，为业务关心的读场景生成看板

## 前置

模型未定**先跑 `data-model`**。看板字段必须来自模型字段 ——
按界面需要临时造指标，会和约束、不变量对不上，而且**引用校验会直接拒绝**。

---

# 一、概念对照

| 你可能会说 | 契约里是 |
|---|---|
| 看板 | `view-schema` 的 `Spec`，`view_type: "LIST"` |
| 指标口径 / 聚合口径 | 一个 `category: "QUERY"` 的 `CAPABILITY`，被 `queries[]` 引用 |
| 图表 | 一个 `ViewNode`（组件名从**注册表**取），数据经 `props.data` 绑定 |
| 该口径能喂给谁看 | `permission-spec` 的 `data_scopes`（**本契约不表达**） |
| 这个图的数据 | `props.data` = `DataBindingRef` → 指向 `queries[]` 里的 `query_code` |
| 看板标题 | `ListPage` 的 `title` 属性 |
| 分块 | `Section` 组件（`props.columns` 可设 1–4 栏） |
| 明细表 | `Table` 组件，`props.data` 绑一个记录查询 |

**没有「图表类型」这个字段** —— 图表的类型就是**组件名**，
而组件名只能从注册表里取（见 §五）。

---

# 二、Spec 骨架

**六个字段全部必填**，看板通常还要第七个 `queries`：

```jsonc
{
  "view_code": "monthly_sales_dashboard",
  "name": "月度销售趋势看板",
  "view_type": "LIST",                // ★ 看板用 LIST
  "businessSchemaRef":    { … },      // ★ 指向 data-model 产出的 schema
  "componentRegistryRef": { … },      // ★ 指向组件注册表
  "queries":              [ … ],      // 口径引用（可选但看板必用）
  "componentsTree":       [ … ]       // ★ 恰好 1 个元素
}
```

⚠️ **`componentsTree` 恰好一个元素** —— 契约写的是 `minItems: 1, maxItems: 1`。
多个顶层块**用根节点的 `children`**，不要加第二个元素。

### 三个引用都不能编

- `businessSchemaRef` → 指向**本次的模型**（`asset_type: "BUSINESS_SCHEMA"`）
- `componentRegistryRef` → 指向**组件注册表**（`asset_type: "COMPONENT_REGISTRY"`）
- `queries[].query.queryRef` → 指向**口径 capability**（`asset_type: "CAPABILITY"`）

三者的 `digest` **都必须是真实值**。写占位符结构能过、引用校验必挂。

---

# 三、看板的载体：`view_type` 用 `LIST`

`view_type` 只有三个取值：`FORM` / `LIST` / `DETAIL`。

**看板用 `LIST`，根节点是 `ListPage`。**

| `view_type` | 根组件 | 适合 |
|---|---|---|
| `FORM` | `FormPage` | 录入 |
| **`LIST`** | **`ListPage`** | **看板、列表、汇总** |
| `DETAIL` | `DetailPage` | 单条记录的详情 |

**根节点组件必须与该 `view_type` 匹配** —— 每个组件的 `viewTypes` 是白名单。
实测：根节点换成 `DetailPage`、或把 `view_type` 改成 `DETAIL`，
都报 `VIEW_COMPONENT_UNREGISTERED`，位置在 `componentsTree[0].componentName`。

> **为什么不新加一个「看板」`view_type`**：加值要改契约（走变更流程 + G2 登记），
> 而 `LIST` 已经能承载看板 —— **看板与列表的差别在放了什么组件，不在视图类型。**

---

# 四、口径怎么接进来

## 4.1 `queries[]` 声明口径

```jsonc
"queries": [
  {
    "query_code": "q_monthly_sales",
    "query": {
      "type": "DataQueryRef",
      "queryRef": {
        "scope_type": "PLATFORM_CONTROL", "scope_id": "kvvi-platform",
        "app_id": null, "module_id": null,
        "asset_type": "CAPABILITY",
        "capability_code": "caliber.monthly_sales",   // ★ 登记过的口径
        "version": 1,
        "digest": "sha256:…"                          // ★ 真实摘要
      },
      "params": {
        "businessSchemaRef": { … },
        "dataScope": ["COMPANY"]                      // ★ 见 4.3
      }
    }
  }
]
```

**要过四关**（都实测过）：

| 关 | 判据 | 失败报错 |
|---|---|---|
| 1 | `query_code` 在本 Spec 内唯一，且匹配 `^[a-z][a-z0-9_]{2,63}$` | `VIEW_DATA_SOURCE_FORBIDDEN` |
| 2 | 口径已登记在 `CAPABILITY_REGISTRY` 里，且摘要一致 | `VIEW_CAPABILITY_REF_INVALID` / `VIEW_CAPABILITY_DIGEST_MISMATCH` |
| 3 | 该口径的 `category` 是 `QUERY`（不是 `ACTION`） | `VIEW_DATA_SOURCE_FORBIDDEN` |
| 4 | `params` 符合该口径的 `inputSchema` | `VIEW_DATA_SOURCE_FORBIDDEN` |

⚠️ `query_code` **不含点号** —— `Code` 的 pattern 是 `^[a-z][a-z0-9_]{2,63}$`，
只允许小写字母、数字、下划线。写成 `caliber.monthly_sales` 是**结构错误**。

⚠️ 而 `capability_code` 在契约层只要求「非空字符串」（`StableId` 没有 pattern）——
**点号是平台登记时的命名惯例**（现有登记项 `records.list`、`form.submit` 皆如此）。
**两处规则不同，不要照抄**：`query_code` 是本地别名，`capability_code` 是登记标识。

⚠️ 每个 `queries[]` 条目的 `additionalProperties: false` —— 只能有
`query_code` 和 `query` 两个键。

## 4.2 图表节点绑定口径

```jsonc
{
  "id": "chart_monthly_sales",
  "componentName": "…",                     // 从注册表取
  "props": {
    "data": {
      "type": "DataBindingRef",
      "queryCode": "q_monthly_sales",       // ★ 必须是上面声明过的 query_code
      "itemKey": "month",                   // ★ 必须在该口径的 itemKeys 里
      "maxItems": 12                        // 1–200
    }
  }
}
```

**`DataBindingRef` 四个字段全必填。**

⚠️ `itemKey` 不是随便写的 —— 它必须出现在**该口径 capability 登记的 `itemKeys` 数组**里。
写错的报错是 `VIEW_DATA_SOURCE_FORBIDDEN`，位置在 `props.data.itemKey`。

## 4.3 `dataScope` 为什么必须写

`dataScope` 是**这次查询实际注入的数据范围**。它必须写，因为 §9.8.1 的不变量判定
需要这个量（见 §六）。

**规则**：`dataScope` 表达的范围**不得窄于**该口径可见性档位表达的范围。

| 口径可见性 | 允许的 `dataScope` | 结果 |
|---|---|---|
| `COMPANY`（全公司） | `["COMPANY"]` | ✅ |
| `COMPANY`（全公司） | `["SELF"]` | ❌ **拒绝发布**（L3） |
| `DEPARTMENT_AND_CHILDREN` | `["DEPARTMENT", "DEPARTMENT_AND_CHILDREN"]` | ✅ |
| `DEPARTMENT_AND_CHILDREN` | `["STORE"]` | ❌ 档位覆盖不了（L3 拒绝，实测） |

**「把查询范围改小一点更安全」是错的** —— 用户看得到汇总、看不到构成它的部分个体，
两次相减就能反推个体值。这正是 §9.8.1 要拦的攻击。

---

# 五、图表怎么接进来（⚠️ 依赖生产注册表）

**图表名必须从组件注册表里取，不能凭直觉猜。**

我核实的注册表（`vue_element_approved`，来自测试 fixture）里有 23 个组件，
**没有任何图表**：页面级 3、容器 2、字段类 10、展示类 5、按钮类 3。

**但这不足以断定生产注册表里也没有** —— fixture 是 `"fixture": true`、
`"implementation": "no-renderer"` 的测试替身。
**按已确认的决策 A**：生产注册表另有图表组件，本 Skill 据此开工。

## 5.1 选图表的通用规则（与组件名无关）

先定问题，再定图表。顺序不能反 —— 先问：**这个看板要支持什么决定？**

| 业务问题 | 图表 |
|---|---|
| 趋势如何 | 折线图（时间是 X 轴） |
| 谁多谁少 | 横向条形图（按值排序） |
| 构成占比 | 堆叠条形或环形图（**仅当 ≤5 类**） |
| 与目标差距 | 进度条 / 仪表 |
| 单值状态 | 指标卡（大数字 + 对比） |
| 相关性 | 散点图 |
| **明细排查** | **表格（不是图表）** |

**禁止**：用饼图表达超过 5 个分类；用 3D 或径向图；
用折线图画无序分类（折线意味着连续性，分类之间没有「之间」）。

## 5.2 挑组件时要看的四件事

从注册表里挑图表组件时，逐条核对（这四项决定了它能不能放进 `LIST` 看板）：

| 注册表字段 | 要求 | 不满足会怎样 |
|---|---|---|
| `state` | 必须是 `PUBLISHED` | 未发布组件不可用 |
| `viewTypes` | 必须**含 `LIST`** | 放进 LIST 会被拒 |
| `bindingPositions` | 必须有一个位置接受 `DataBindingRef`（或 `DataQueryRef`） | **数据接不进去** —— 图表画不出数 |
| `loopSupported` | 若要在节点上写 `loop`，必须为 `true` | `loop` 被拒 |

⚠️ **`bindingPositions` 是这里最容易忽略的一项** ——
`viewTypes` 对得上不代表数据绑得上。一个 `viewTypes` 含 `LIST` 但没有任何
位置接受 `DataBindingRef` 的组件，只能显示静态文字。

> **可绑定的位置长什么样**：现有注册表里 `Table` 的
> `bindingPositions` 是 `{"data": ["DataBindingRef", "DataQueryRef"]}` ——
> 要在 `props.data` 上写这两类引用。图表组件的接法由它自己的
> `bindingPositions` 决定，**必须现读注册表**。

## 5.3 生产注册表还没拿到时怎么办

**不要编组件名。** 编出来的名字会以 `VIEW_COMPONENT_UNREGISTERED` 被拒，
而且会让人以为是「产出物写错了」，而不是「组件还没登记」。

正确做法：**用注册表里已有的、能绑数据的组件占位**（例如 `Table`），
在交付说明里写明「此处应替换为生产注册表的图表组件，接法为
`props.data → DataBindingRef`」。**结构、口径、绑定都已经是对的，
换组件名即可。**

## 5.4 筛选器在 v1 里没有载体

当前注册表**没有筛选组件**，契约也没有「把控件状态传进查询参数」的表达。
结合冻结决策 Q8（口径在构建期固定、员工侧不可改），v1 的做法是：

**把筛选口径固化进口径本身**（每条口径自带时间窗与排除规则），
而不是让用户在看板上改 —— 否则「同一个数字」会因人因时不同，
争论就从「数字是多少」变成「你按什么筛的」。

## 5.5 小样本抑制不是权限手段

看板常见的「某组少于 N 人不显示」**不是**权限机制：

- 它只是**展示**策略，不改变谁能取到数据；
- 当同一看板还存在**总数**时，被抑制的分组可以**靠相减反推**；
- v1 **不实现聚合防差分**（§9.8.1 的明确取舍），机器判定的是**前置条件**。

所以：**宁可把一个不该给人看的分组整个不放进看板，也不要「显示一部分、隐藏一部分」。**
判断「该不该给人看」用的是 §六 的不变量，不是「看起来差不多就行」。

---

# 六、§9.8.1 不变量：口径登记单

口径的**可见性档位**与**图表的绑定**之间，必须满足一条不变量：

> **能查看某个聚合口径的用户，必须同样能访问构成该聚合的每一条个体数据。**
> 不满足则**拒绝发布**，不存在审批放行路径。

## 6.1 为什么要单独交一份登记单

判定这条不变量需要三个量，而它们**分别散在配置的不同位置**：

| 量 | 含义 | 来源 |
|---|---|---|
| `scopes` | 这个口径给哪些档位的人看 | `permission-spec` 的 `data_scopes` |
| `resource` | 这个口径统计的是哪一段数据 | 口径自身的聚合范围 |
| `inject` | 这次查询实际注入的数据范围 | `DataQueryRef.params.dataScope`（§4.3） |

**没有一个地方同时记着这三个量**，所以判定跑不起来。
登记单就是把它们**显式写在一处**，让判定有输入。

## 6.2 登记单格式

```json
{
  "org": {
    "tenants": ["t1"],
    "depts": { "sales": null, "sales-a": "sales", "sales-b": "sales" },
    "shops": ["store-1", "store-2"],
    "users": [{ "tenant": "t1", "dept": "sales-a", "shop": "store-1", "id": "u1" }]
  },
  "calibers": [
    { "aggregate": "caliber.monthly_sales",
      "scopes": ["COMPANY"],
      "resource": { "tenant": "t1" },
      "inject": ["COMPANY"] }
  ]
}
```

`org` 段是**必要的诚实**：档位能不能覆盖聚合范围，取决于
**店铺与部门的实际包含关系**（PRD §2.5.1 明确二者**可能交叉**，不可按档位编号比较）。
`org` 缺省时用判定器内置的组织模型 —— 那只适合验证判定器本身，
**真实部署必须填自己的组织模型**，否则结论是关于那个内置模型的，不是关于你的。

## 6.3 判定

```bash
python3 工具/check_invariant.py --input <你的口径登记单.json>
```

**退出码**：`0` = 全部口径成立 / `1` = 有口径违反（**拒绝发布**）/ `2` = 无法执行。

判定的层次是：

| 层 | 含义 |
|---|---|
| **L1** | 口径可用性：**存在**用户能看这个口径吗？没人能看 → 配置错误 |
| **L3** | 注入一致性：查询注入的范围**不窄于**可见性表达的范围吗？窄了 → 拒绝 |
| L2 | 不变量本体（防御性；实现正确时恒真） |

---

# 七、一份完整的、已验证的示例

## 7.1 看板 `Spec`（完整校验通过）

```json
{
  "view_code": "monthly_sales_dashboard",
  "name": "月度销售趋势看板",
  "view_type": "LIST",
  "businessSchemaRef": {
    "scope_type": "TENANT",
    "scope_id": "11111111-1111-4111-8111-111111111111",
    "app_id": "22222222-2222-4222-8222-222222222222",
    "module_id": "33333333-3333-4333-8333-333333333333",
    "asset_type": "BUSINESS_SCHEMA",
    "asset_id": "general_item",
    "version": 1,
    "digest": "sha256:518077baee491b8146bc740bfa84d23bb2ef7f4bc81929eadefb7fd1691c9433"
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
  "queries": [
    {
      "query_code": "q_monthly_sales",
      "query": {
        "type": "DataQueryRef",
        "queryRef": {
          "scope_type": "PLATFORM_CONTROL",
          "scope_id": "kvvi-platform",
          "app_id": null,
          "module_id": null,
          "asset_type": "CAPABILITY",
          "capability_code": "caliber.monthly_sales",
          "version": 1,
          "digest": "sha256:42771c2eff1f0cddf68dbe962413a002037154dd09dacd2229a76bc5a71f9c5c"
        },
        "params": {
          "businessSchemaRef": {
            "scope_type": "TENANT",
            "scope_id": "11111111-1111-4111-8111-111111111111",
            "app_id": "22222222-2222-4222-8222-222222222222",
            "module_id": "33333333-3333-4333-8333-333333333333",
            "asset_type": "BUSINESS_SCHEMA",
            "asset_id": "general_item",
            "version": 1,
            "digest": "sha256:518077baee491b8146bc740bfa84d23bb2ef7f4bc81929eadefb7fd1691c9433"
          },
          "dataScope": [
            "COMPANY"
          ]
        }
      }
    },
    {
      "query_code": "q_dept_completion",
      "query": {
        "type": "DataQueryRef",
        "queryRef": {
          "scope_type": "PLATFORM_CONTROL",
          "scope_id": "kvvi-platform",
          "app_id": null,
          "module_id": null,
          "asset_type": "CAPABILITY",
          "capability_code": "caliber.dept_completion",
          "version": 1,
          "digest": "sha256:2c2b9b654a3134f49f458047264002e554c6daba2bb8d3ba687f107c21e4c2ec"
        },
        "params": {
          "businessSchemaRef": {
            "scope_type": "TENANT",
            "scope_id": "11111111-1111-4111-8111-111111111111",
            "app_id": "22222222-2222-4222-8222-222222222222",
            "module_id": "33333333-3333-4333-8333-333333333333",
            "asset_type": "BUSINESS_SCHEMA",
            "asset_id": "general_item",
            "version": 1,
            "digest": "sha256:518077baee491b8146bc740bfa84d23bb2ef7f4bc81929eadefb7fd1691c9433"
          },
          "dataScope": [
            "DEPARTMENT",
            "DEPARTMENT_AND_CHILDREN"
          ]
        }
      }
    },
    {
      "query_code": "q_records",
      "query": {
        "type": "DataQueryRef",
        "queryRef": {
          "scope_type": "PLATFORM_CONTROL",
          "scope_id": "kvvi-platform",
          "app_id": null,
          "module_id": null,
          "asset_type": "CAPABILITY",
          "capability_code": "records.list",
          "version": 1,
          "digest": "sha256:82a4a0057bf0b83d5d79898c29940825ae5b5ce7d9442822078f4c983ef510b7"
        },
        "params": {
          "businessSchemaRef": {
            "scope_type": "TENANT",
            "scope_id": "11111111-1111-4111-8111-111111111111",
            "app_id": "22222222-2222-4222-8222-222222222222",
            "module_id": "33333333-3333-4333-8333-333333333333",
            "asset_type": "BUSINESS_SCHEMA",
            "asset_id": "general_item",
            "version": 1,
            "digest": "sha256:518077baee491b8146bc740bfa84d23bb2ef7f4bc81929eadefb7fd1691c9433"
          }
        }
      }
    }
  ],
  "componentsTree": [
    {
      "id": "page_root",
      "componentName": "ListPage",
      "props": {
        "title": "月度销售趋势看板"
      },
      "children": [
        {
          "id": "sec_trend",
          "componentName": "Section",
          "props": {
            "title": "近 12 个月销售趋势"
          },
          "children": [
            {
              "id": "chart_monthly_sales",
              "componentName": "Table",
              "props": {
                "text": "近 12 个月销售趋势",
                "data": {
                  "type": "DataBindingRef",
                  "queryCode": "q_monthly_sales",
                  "itemKey": "month",
                  "maxItems": 12
                }
              }
            }
          ]
        },
        {
          "id": "sec_dept",
          "componentName": "Section",
          "props": {
            "title": "各部门完成情况"
          },
          "children": [
            {
              "id": "chart_dept_completion",
              "componentName": "Table",
              "props": {
                "text": "各部门完成情况",
                "data": {
                  "type": "DataBindingRef",
                  "queryCode": "q_dept_completion",
                  "itemKey": "dept",
                  "maxItems": 20
                }
              }
            }
          ]
        },
        {
          "id": "sec_detail",
          "componentName": "Section",
          "props": {
            "title": "待处理明细"
          },
          "children": [
            {
              "id": "tbl_detail",
              "componentName": "Table",
              "props": {
                "text": "待处理明细",
                "data": {
                  "type": "DataBindingRef",
                  "queryCode": "q_records",
                  "itemKey": "id",
                  "maxItems": 50
                }
              }
            }
          ]
        }
      ]
    }
  ]
}
```

**这份示例就是 `样例/view-schema/月度销售看板.spec.json`**（3 条口径、7 个节点），
配 `样例/view-schema/context-看板.json` 已通过结构 + 语义 + 引用三层校验 ——
**从本文件提取后可直接跑**。

> ⚠️ 示例里的 `scope_id`、`asset_id`、`version`、`digest` 都是**本部署特有的值**。
> 照抄会让引用失效 —— 必须从平台侧取得真实值。
>
> ⚠️ 两处图表节点用的是 `Table` **占位**（原因见 §5.3）：
> 生产注册表拿到图表组件后，只需替换 `componentName`，
> **结构、口径、`props.data` 绑定都不用动**。

## 7.2 口径登记单（不变量判定通过）

见 `样例/view-schema/看板-口径登记.json`：

```bash
$ python3 工具/check_invariant.py --input 样例/view-schema/看板-口径登记.json
✓ caliber.monthly_sales              判定=成立
✓ caliber.dept_completion            判定=成立
✓ 2 条口径全部成立
```

**这份示例的反向验证也做了**（改坏就会被拒，不是恒绿）：

| 改动 | 结果 |
|---|---|
| 全公司口径只注入 `SELF` | ❌ 拒绝（L3） |
| 部门口径却声明 `STORE` 可见 | ❌ 拒绝（L1） |
| 口径指向不存在的租户 `t2` | ❌ 拒绝（L1） |
| 图表 `itemKey` 改成口径里没有的值 | ❌ 拒绝 |
| 口径引用摘要改一位 | ❌ 拒绝 |
| 绑定未声明的 `query_code` | ❌ 拒绝 |
| 根节点 `ListPage` 装进 `DETAIL` | ❌ 拒绝 |

---

# 八、自查

```bash
# 结构 + 语义 + 引用（这条契约有完整校验，跑绿就是真绿）
python3 工具/check_skill_output.py 你的看板.json \
  --contract view-schema/lce-safe-v1 --context 配套context.json

# §9.8.1 不变量
python3 工具/check_invariant.py --input 你的口径登记单.json
```

### 已知边界（必须向用户说明，不要当成已解决）

| 边界 | 说明 |
|---|---|
| **图表组件名** | 当前可用注册表（测试 fixture）里没有图表；按决策 A 等生产注册表。**在此之前用能绑数据的组件占位，不要编名字** |
| **口径的登记内容没有契约** | 13 份 MetaSchema 里没有定义 `CAPABILITY` 资产本身的契约（只有引用它的 `CapabilityRef`）。所以本 Skill 能保证「**引用**正确」，**不能**保证「登记内容合法」 |
| **筛选器无载体** | 当前注册表没有筛选组件，契约也没有「把控件状态传进查询参数」的表达。v1 的口径是**构建期固定**的（Q8），看板不提供改口径的筛选器 |
| **不变量是发布前检查** | `check_invariant.py` 判定的是**配置**；运行期是否真的按配置注入数据范围，是另一件事 |

跑之前先自己过一遍：

- [ ] `view_type` 是 `"LIST"`，根节点是 `ListPage`
- [ ] `componentsTree` **恰好 1 个**元素
- [ ] 每条 `queries[]` 只含 `query_code` 与 `query` 两个键
- [ ] 每个 `query_code` 唯一，且**不含点号**
- [ ] 每个口径的 `category` 是 `QUERY`，`state` 是 `PUBLISHED`，`digest` 是真实值
- [ ] 每个 `params` 符合口径的 `inputSchema`，**且含 `dataScope`**
- [ ] 每个 `DataBindingRef.itemKey` 都在该口径的 `itemKeys` 里
- [ ] 每个图表组件的 `viewTypes` 含 `LIST`，且 `bindingPositions` 能接 `DataBindingRef`
- [ ] **所有 `id` 唯一**，且没有沿用上下文里 `deleted_node_ids` 中的 id
- [ ] 没有把「小样本抑制」当成权限手段
- [ ] 口径登记单里的 `org` 是**真实部署**的组织模型，不是内置示例

---

## 常见错误

| 错误 | 后果 | 正确做法 |
|---|---|---|
| 先选图表再想问题 | 图表好看但无用 | 先定要支持的决定 |
| 口径没登记就直接引用 | `VIEW_CAPABILITY_REF_INVALID` | 先让平台登记口径，拿到真实 `digest` |
| 口径摘要写占位符 | `VIEW_CAPABILITY_DIGEST_MISMATCH` | 用平台返回的真实摘要 |
| `query_code` 写成 `caliber.xxx` | 结构错误（不允许点号） | `query_code` 用下划线；点号是 `capability_code` 的惯例 |
| `itemKey` 不在口径的 `itemKeys` 里 | `VIEW_DATA_SOURCE_FORBIDDEN` | 现读该口径的 `itemKeys` |
| 把查询范围改小当成「更安全」 | **拒绝发布**（§9.8.1） | `dataScope` 不得窄于可见性档位 |
| 口径改小 + 看板上还有总数 | 相减反推个体值 | 该分组整个不放，或提升可见性档位 |
| 图表组件名凭直觉猜 | `VIEW_COMPONENT_UNREGISTERED` | 从注册表取；没拿到就用占位组件 |
| 只看 `viewTypes` 不看 `bindingPositions` | 图表画不出数据 | 两个都要核对 |
| 用 `FormPage` 当看板根 | `VIEW_COMPONENT_UNREGISTERED` | 看板根是 `ListPage` |
| 口径指向别的租户 / 不存在的部门 | **L1 拒绝** | 口径范围必须在组织模型内 |
| 登记单不带 `org` | 结论是关于内置示例模型的 | 填真实部署的组织模型 |
| 饼图 12 个分类 | 无法比较 | 换横向条形图 |
| 一屏 15 个图 | 没人看 | 一屏 4–6 个 |
| 标题用字段名 | 业务看不懂 | 标题说**问题**，不说字段名 |

---

## 交接

- 看板发现异常要触发动作 → `workflow-builder`
- 看板字段来自模型 → `data-model`（模型不定不要开工）
- 看板要被外部系统拉取 → `api-spec`
- 口径的可见性档位 → `permission-spec`（**不是本 Skill 决定的**）
