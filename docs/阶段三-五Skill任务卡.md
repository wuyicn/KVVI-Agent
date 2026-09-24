# 阶段三 · 五个搭建 Skill 任务卡

> **阶段三锚点① 的工作分解**（PRD §7.1）：
> 「五个 Skill 的产出物**全部通过 MetaSchema 校验**。
> §5.6 判定标准：**不能被校验的产出不属本产品**」
>
> **为什么需要任务卡**：五个 Skill 是可并行的天然面（接口由契约层冻结）。但要并行，
> 每个面必须是**一个完整面**而非一个文件，且必须带**传播义务清单** ——
> 否则并行会制造新的不一致（PRD §7.5.1：加人收益有限，且引入新的不一致风险）。

---

## 一、先看现状：一个必须修掉的落差

五个 Skill 骨架已存在于 `packages/preset/agent-presets/presets/kvvi-builder/skills/`，
内容质量不低（推导流程、常见错误表、交接说明齐备）。**但它们有一个共同的根本落差：**

| Skill | 行数 | 提到 MetaSchema/契约 |
|---|---|---|
| `data-model` | 133 | ❌ **无** |
| `form-builder` | 127 | ❌ **无** |
| `workflow-builder` | 152 | ❌ **无** |
| `dashboard-builder` | 135 | ❌ **无** |
| `api-spec` | 168 | ❌ **无** |

`data-model` 的「输出格式」是一份**自定义的"模型草案 YAML"** ——
人类可读，但**过不了任何校验器**。

**按 §5.6 的判定标准，这份产出不属于本产品。**

**所以锚点① 的核心工作不是「写五个 Skill」，而是**：
**把每个 Skill 的产出物从「自定义草案」收敛到「MetaSchema 契约」，并让校验器能判它。**

---

## 二、共同约束（每张卡都适用，不重复写）

### 2.1 §5.6 的封闭范围

| 允许 | 不允许 |
|---|---|
| 生成 / 修改 MetaSchema 契约 | 编写**任意语言**的业务代码 |
| 生成 / 修改类型化命令载荷 | 执行任意脚本 / 命令 |
| 生成 YAML 视图（**非真理源**） | 安装依赖（npm / CDN / 任意 URL） |
| 调用验证器 | 修改运行时地基（状态机、金额精度、租户策略、权限校验） |
| 读取模板与样例（只读） | |

### 2.2 生产与开发两套验证器

- **生产**：**Node 引擎**是运行时权威（M5，§4.6.3）
- **开发期**：双引擎交叉验证（Python 与 Node 判定必须一致）

**每个 Skill 的产出物都必须能过 Node 引擎**。

### 2.3 契约的三层结构

五个目标契约都有 `Spec` / `CompiledDraft` / `RegisteredContract` 三层：

| 层 | 含义 | Skill 的产物是 |
|---|---|---|
| `Spec` | 声明式定义（人写） | ✅ **Skill 产出这一层** |
| `CompiledDraft` | 编译中间态 | 由编译器产出，不是 Skill 的职责 |
| `RegisteredContract` | 注册后的契约 | 由发布通道产出 |

### 2.4 去行业化（锚点② 的约束，同时约束本卡）

PRD `0A-14` 要求去行业化自查。**五个 Skill 的任何示例、模板、字段名
都不得内置行业家具**（「工单」「报货单」「病历」「报销单」等）。
示例应使用中性业务词汇，或明确标注为**用户场景的实例**而非原语。

---

## 三、依赖图

```
                    ┌──────────────┐
                    │ data-model   │  ← 前置：其余四者都消费它的产出
                    │ business-schema.v1
                    └──────┬───────┘
                           │  business-schema 契约
        ┌──────────┬───────┴────────┬──────────┐
        ▼          ▼                ▼          ▼
  form-builder  workflow-builder  dashboard  api-spec
  view-schema   workflow-spec     -builder   tool-spec
  .lce-safe-v1  .v1alpha1         view-schema +app-model-command
                                  （+聚合口径）
```

**PRD §5.1 原文**：「`data-model` 是其余四者的前置」。

**注意 `form-builder` 与 `dashboard-builder` 共享 `view-schema`** ——
这一对**不是完全独立**，见 §5 的并行方案。

---

## 四、五张任务卡

### 卡 1 · `data-model` —— 数据模型推导

| 项 | 内容 |
|---|---|
| **目标契约** | `business-schema.v1`（PRD §5.1） |
| **输入** | 用户的业务描述（自然语言） |
| **产出** | 一份 `business-schema.v1` 的 `Spec` |
| **前置** | 无。**它是其余四者的前置** |
| **可并行** | ❌ 必须**先**完成 |

**Spec 的 required 字段**（来自契约，不是自拟）：

```
schema_code, field_type_registry_ref, name, fields
```

**必须澄清的一点**：`field_type_registry_ref` 是 `AssetRef`，`asset_type = "FIELD_TYPE_REGISTRY"`。
它是**指向字段类型注册表的引用**（PRD `0A-6`「组件注册表白名单」，状态 **locked**）。

> **✅ 已确认（不再待定）：它是平台级静态资产，Skill 只引用、不生成。**
>
> 依据 `docs/PRD-AI无代码平台设计-v1.11.md`（G1 并入的 baseline）第 712、860 行：
> 「声明本契约**启用**的类型集……**校验器据此判断字段类型是否被允许**」，
> 且「类型注册表**按类型独立版本化**……**不得只靠「按样例启用」的隐式约定**」。
> 验证器确实解析该引用：`tools/meta-schema/node/references.mjs:20`。
>
> **Skill 要写的形状**（取自 baseline 第 1083–1092 行的完整示例）：
>
> ```yaml
> field_type_registry_ref:
>   scope_type: PLATFORM_CONTROL     # 平台级，非租户/应用级
>   scope_id: kvvi-platform
>   app_id: null
>   module_id: null
>   asset_type: FIELD_TYPE_REGISTRY
>   asset_id: business-field-types-core
>   version: 1
>   digest: sha256:…
> ```
>
> **对卡 1 的影响**：Skill 的职责是**正确引用**该资产（含版本与摘要），
> 并确保产出的字段类型**落在该注册表声明的类型集内**。
> 这与 PRD `0A-6` 标 locked 一致：注册表属已建成的资产。
>
> **⚠️ 遗留**：`asset_id` / `version` / `digest` 的**实际取值**须在卡 1 开工时
> 从平台侧取得 —— 本卡给出的是形状，不是当前部署的真实值。

**可选字段**（契约里非 required，但业务上常需）：
`description`、`record_number`、`indexes`、`record_rules`、`layout`

**验收判据（可机器验证）**：

| # | 判据 |
|---|---|
| V1 | 产出是合法 JSON，且 `$id` 指向 `business-schema-v1` |
| V2 | 通过 Node 验证器的**结构校验** |
| V3 | 通过 Node 验证器的**语义校验**（引用可解析、字段类型在注册表内） |
| V4 | Python 与 Node 双引擎判定**一致**（开发期） |
| V5 | 去行业化自查通过（无行业家具） |

**传播义务**：`data-model` 的产出是**其余四者的输入**。
改动 `business-schema` 的结构会影响全部四个下游 —— 故本卡**不应**在其余四卡开工后修改。

---

### 卡 2 · `form-builder` —— 表单搭建

| 项 | 内容 |
|---|---|
| **目标契约** | `view-schema.lce-safe-v1` |
| **输入** | `data-model` 产出的 `business-schema` + **已冻结的组件注册表约定** |
| **产出** | 一份 `view-schema` 的 `Spec` |
| **前置** | 卡 1 |
| **可并行** | ✅ **已无耦合**（B2 已冻结共同约定） |
| **结构约定** | **`docs/view-schema-结构约定.md`** —— 开工前必读，含 `ViewNode` 形状、组件注册表的作用、字段绑定写法 |

**职责范围**：字段类型映射、校验规则、条件显隐、分组布局。

**验收判据**：

| # | 判据 |
|---|---|
| V1 | 合法 JSON 且 `$id` 正确 |
| V2 | Node 结构校验通过 |
| V3 | Node 语义校验通过（**引用的字段在 business-schema 中确实存在**） |
| V4 | 双引擎一致 |
| V5 | 去行业化 |

**传播义务**：`view-schema` 的结构若变动，**卡 4（dashboard）同样受影响**。

---

### 卡 3 · `workflow-builder` —— 审批流搭建

| 项 | 内容 |
|---|---|
| **目标契约** | `workflow-spec.v1alpha1` |
| **输入** | `data-model` 产出的 `business-schema`（**状态机部分**） |
| **产出** | 一份 `workflow-spec` 的 `Spec` |
| **前置** | 卡 1 |
| **可并行** | ✅ **与其余三卡独立**（独占一个契约） |

**职责范围**：节点类型、条件分支、审批人解析、超时与撤回。

**验收判据**：V1–V5 同上，其中 V3 的语义校验重点为
**流程引用的状态迁移必须在 `business-schema` 的状态机中已声明**。

**传播义务**：**独占契约** —— 本卡的改动不外溢，是最干净的并行面。

---

### 卡 4 · `dashboard-builder` —— 看板搭建

| 项 | 内容 |
|---|---|
| **目标契约** | `view-schema` + **聚合口径**（PRD §5.1） |
| **输入** | `data-model` 产出的 `business-schema` + 已冻结的组件注册表约定 |
| **产出** | ① `view-schema` 的 `Spec`（`view_type: "LIST"`）② **口径登记单** |
| **前置** | 卡 1 |
| **可并行** | ✅ 已无耦合（B2 已冻结共同约定）；原「看板无载体」阻塞**已按决策 A 解除** |
| **结构约定** | `docs/view-schema-结构约定.md` |

**⚠️ 本卡与 `0C-8` 有直接接口**：
聚合口径正是 §9.8.1 不变量的判定对象。**卡 4 产出的每个聚合口径，
都必须能过 `工具/check_invariant.py` 的判定**（G3 已交付的判定器）。

**这是本卡独有的、最强的验收判据** —— 它把阶段三的产出与 G3 直接连起来。

### 阻塞的解除（以及为什么原判断过大）

原判断「看板在当前契约下没有载体，卡 4 开工前须向产品侧确认」。
**产品侧采用 A**（生产注册表另有图表组件），且核实后发现：

| 原判断 | 核实后 |
|---|---|
| 看板无载体 | ❌ **错** —— `view_type: "LIST"` 就是载体，`ListPage` 是其根组件 |
| 口径配置落在哪个 schema | ❌ **问错了** —— 口径是 `CAPABILITY` 资产，`queries[]` 引用它 |
| 真正缺的 | ✅ **只有图表组件的名字**，而名字来自注册表（决策 A 的范围） |

### V6 从「判不了」到「判得了」

原 V6 写的是「每个聚合口径通过 `check_invariant.py` 判定」，但当时
**判定器只有内置用例，没有输入通路** —— 判不了实际产出。

**本次补上了通路**：`工具/check_invariant.py --input <口径登记单.json>`。
登记单把判定所需的三个量（`scopes` / `resource` / `inject`）显式写在一处，
因为它们在配置里**分散在三处**：

| 量 | 来源 |
|---|---|
| `scopes` 可见性档位 | `permission-spec` 的 `data_scopes` |
| `resource` 聚合范围 | 口径自身定义的范围 |
| `inject` 注入档位 | `DataQueryRef.params.dataScope` |

**验收判据**：V1–V5 同上，**外加**：

| # | 判据 | 判据本身可执行吗 |
|---|---|---|
| **V6** | **每个聚合口径通过 `check_invariant.py --input` 判定**（L1 与 L3 均不违反） | ✅ 可执行（自测 9/9，含 4 项反向） |

### 产出物与已验证证据

| 产出 | 验证 |
|---|---|
| `样例/view-schema/月度销售看板.spec.json` + `context-看板.json` | 结构 + 语义 + 引用**三层通过**；6 项改坏全部被拒 |
| `样例/view-schema/看板-口径登记.json` | 不变量**判定通过**；3 项改坏全部被拒 |
| `SKILL.md` §7.1 内嵌示例 | **逐字**等于落盘样例，提取后直接跑 → 通过 |

**传播义务**：`view-schema` 结构变动影响卡 2。

---

### 卡 5 · `api-spec` —— 接口设计

| 项 | 内容 |
|---|---|
| **目标契约** | `tool-spec` + `app-model-command`（PRD §5.1） |
| **输入** | `data-model` 产出的 `business-schema` |
| **产出** | 一份 `tool-spec` 的 `Spec` + 类型化命令载荷 |
| **前置** | 卡 1 |
| **可并行** | ✅ **与其余三卡独立**（独占契约） |

**职责范围**：RESTful 资源设计、请求响应形状、错误码、分页与鉴权。

**验收判据**：V1–V5 同上。

**传播义务**：独占契约，改动不外溢。

---

## 五、并行方案与理由

按 PRD §7.5.1，任务边界必须是「**一个完整面 + 传播义务清单**」。
据此：

| 阶段 | 并行度 | 任务 | 依据 |
|---|---|---|---|
| **A** | **1** | 卡 1 `data-model` | **它是其余四者的前置**，且它的产出是四者的输入 —— 并行做其余四个会因输入未定而返工 |
| **B** | **4** | 卡 2 / 3 / 4 / 5 | 接口由**契约层**冻结，四者消费同一份 `business-schema` |

**但 B 阶段要留意卡 2 与卡 4 的耦合**：两者都产 `view-schema`。

**处理方式（二选一）**：

| 方案 | 做法 | 代价 |
|---|---|---|
| **B1** | 先由**卡 2** 与**卡 4** 各自独立起草 `view-schema` 的用法，**在 B 阶段中段合并一次**，冻结结构后再各自完成 | 一次同步点 |
| **B2** | 把 `view-schema` 的**结构约定**提到 A 阶段末尾一并冻结（作为卡 1 的附带产出） | A 阶段略长，但 B 阶段完全无耦合 |

> **✅ 已采用 B2**：`view-schema` 的结构约定已随卡 1 一并冻结，
> 见 **`docs/view-schema-结构约定.md`**（含已通过校验的样例）。
> **B 阶段的唯一耦合点已消除**，卡 2/3/4/5 现在真正可以并行。

---

## 六、验收矩阵（锚点① 的总判据）

| 卡 | 契约 | 结构校验 | 语义校验 | 双引擎 | 去行业化 | 额外 |
|---|---|---|---|---|---|---|
| 1 `data-model` | `business-schema.v1` | ✅ | ✅ | ✅ | ✅ | — |
| 2 `form-builder` | `view-schema.lce-safe-v1` | ✅ | ✅ | ✅ | ✅ | — |
| 3 `workflow-builder` | `workflow-spec.v1alpha1` | ✅ | ✅ | ✅ | ✅ | — |
| 4 `dashboard-builder` | `view-schema` + 聚合口径 | ✅ | ✅ | ✅ | ✅ | **聚合口径过 `check_invariant.py`** |
| 5 `api-spec` | `tool-spec` + `app-model-command` | ✅ | ✅ | ✅ | ✅ | — |

**锚点① 达成的机械判据**：**五行全部 ✅**。

---

## 七、本任务卡已知的不足

| # | 不足 | 影响 |
|---|---|---|
| 1 | ~~`field_type_registry_ref` 的资产来源未确认~~ → **已确认**（见卡 1）。但 `asset_id`/`version`/`digest` 的实际取值仍须开工时从平台侧取得 | 工作量已可估：Skill 只引用 |
| 2 | **未估算各卡工作量** | 本卡只定边界与判据，不排工期 |
| 3 | ~~看板在当前契约下没有载体~~ → **已解决**（卡 4） | 原判断过大。产品侧**采用 A**（生产注册表另有图表组件），且核实后：`view_type: "LIST"` **就是**看板载体（根组件 `ListPage`），口径经 `Spec.queries[]` → `DataQueryRef` → `CapabilityRef` 接入 —— **整条通路已端到端跑通并验证**。真正缺的只有**图表组件的名字**。详见 `docs/view-schema-结构约定.md` §5 与 `docs/阶段三-待澄清事项.md` 事项 1 |
| 4 | **`CAPABILITY` 资产本身没有契约**（卡 4 新发现） | 13 份 MetaSchema 只定义了引用它的 `CapabilityRef`，没有一份定义 `category`/`inputSchema`/`itemKeys` 等字段的合法形态。**引用层能验，登记内容层验不了** —— 已写进卡 4 SKILL.md 的「已知边界」，并记入待澄清事项 4 |
| 5 | **未定义 Skill 之间的交互协议** | 四张 B 卡如何把产出交给彼此（文件？工具调用？）未定 |
| 6 | **验收判据尚未实现为可跑的命令** | ✅ **已解决**：`check_skill_output.py`（逐份契约）+ `check_invariant.py --input`（§9.8.1）+ `check_industry_neutral.py`（`0A-14`，自测 8/8）+ `check_blueprint.py`（`0D-1` 六段闭环，自测 13/13）。**白名单外仍只有结构校验**（见不足 4 与 N9） |
| 7 | ~~`app-model-command` 用的不是 `Spec` 形态~~ → **已解决** | 它的根定义是 **`#/$defs/Command`**（`$ref` 指向它），不是 `Spec`。检查器已支持传入 entry 名，实测 **78 条用例判定一致 78/78**。**所以卡 5 两部分都有结构校验路径**（仅结构，无语义）——与卡 3 同类 |
