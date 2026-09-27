---
name: workflow-builder
description: 审批流编排——状态、动作、迁移、审批人链，产出 workflow-spec 契约。适用于「审批金额超过5万需要总监审批」「提交后走三级审批」这类需求。前置依赖 data-model。
---

# 审批流编排（workflow-builder）

把业务里的「谁来批、按什么条件批、批完怎样」变成**可通过校验的**
`workflow-spec/v1alpha1` 契约。

审批流的本质是**状态机 + 人**：状态机定「能去哪」，人定「谁能推」。
两者分开建模，不要混成一张节点图。

## 先说产出是什么

产出**不是**一份「流程草案」，而是 `workflow-spec/v1alpha1` 的 **`Spec`**。

> **判定标准**：不能被 MetaSchema 校验的产出，不属于本产品的搭建产出。

**「写完了」的定义是通过校验**，不是「看起来对」。

## ⚠️ 先知道这条契约的校验边界

`workflow-spec` 目前**只能做结构校验**，没有完整校验实现。这不是工具的疏漏 ——
**契约自己写明了**：

> Structure only: role directory resolution, per-step coverage/graph order,
> selector field matrix and 100-leaf total are **complete-check responsibilities**.

意思是：**下面这些不会被自动检查，你必须自己确认**：

- 角色目录能否解析出真实的人
- 每个状态是否都有可达路径
- 迁移图是否连成一体、有无孤立节点
- 条件选择器引用的字段是否真的存在

**所以对这条契约，「结构通过」是必要条件而非充分条件。**
产出时要自己把上面四项过一遍 —— 没有工具替你查。

## 何时用

- 用户描述了审批规则：*「金额超过 5 万需要总监审批」*
- 用户描述了多级流转：*「提交后先主管、再财务、再总经理」*
- `data-model` 定出的状态机需要落到具体人

## 前置

状态机必须已由 `data-model` 定好。若没有，**先定状态机再编排审批人** ——
跳过状态机直接画审批节点，会做出无法表达「驳回后重新提交」的流程。

---

# 一、概念对照

契约用的名字和你脑子里的说法不一样，先对上：

| 你可能会说 | 契约里是 |
|---|---|
| 流程有哪些阶段 | `states[]` |
| 谁能做什么操作 | `actions[]` |
| 从 A 到 B 怎么走 | `transitions[]` |
| 谁来批 | `approverRef` |
| 条件分支 | `Selector` / `Predicate` / `ChainSelection` |
| 多级审批 | `FixedChain.steps[]` |
| 审批人写死一个人 | `RoleRef`（**不要真的写死人名**） |

**没有「开始节点」「结束节点」「抄送」这些独立概念** ——
入口是 `initial: true` 的状态，出口是 `terminal: true` 的状态。

---

# 二、Spec 骨架

**五个字段全部必填**：

```jsonc
{
  "businessSchemaRef": { … },   // AssetRef，asset_type = BUSINESS_SCHEMA
  "states":      [ … ],         // 1–100 个
  "transitions": [ … ],         // 0–500 个
  "actions":     [ … ],         // 0–100 个
  "approverRef": { … }          // SingleApprover 或 FixedChain
}
```

**`additionalProperties: false`** —— 多写一个键就报错。

### `states[]`

```jsonc
{ "state_code": "draft", "name": "草稿", "initial": true, "terminal": false }
```

- **`initial: true` 的状态是流程入口** —— 一个流程应当只有一个
- **`terminal: true` 的状态是收敛点**
- `state_code` 用 `MachineCode` 格式：小写字母开头，3–64 位

### `actions[]`

```jsonc
{
  "action_code": "submit",
  "kind": "SUBMIT",                   // SUBMIT | APPROVE | ...
  "capability_ref": { … }             // ★ 必须引用真实存在的 capability
}
```

**`capability_ref` 的 `digest` 必须是真实值** —— 写占位符会让引用失效。

### `transitions[]`

```jsonc
{
  "transition_code": "submit_flow",
  "from_state": "draft",
  "to_state": "submitted",
  "action_code": "submit"             // 必须引用已声明的动作
}
```

### `approverRef` 的两种形态

| 形态 | 何时用 |
|---|---|
| `SingleApprover` | 一级审批：`{"kind": "SINGLE", "role_ref": { … }}` |
| `FixedChain` | 多级固定链：`{"kind": "FIXED_CHAIN", "steps": [ … ]}`，1–100 步 |

条件选链用 `ChainSelection`（`kind: "REGISTERED_CHAIN_SELECTION"`），
按 `Selector` 选不同的链。

---

# 三、编排规范

## 1. 审批人不能写死人名

按策略选，`RoleRef` 指向角色目录：

| 策略 | 适用 |
|---|---|
| 发起人直属主管 | 日常审批，跟组织关系走 |
| 指定角色 | 职能审批，如「财务角色」 |
| 字段指定 | 表单里选了审批人 —— 表单必须有该 ref 字段 |
| 逐级上报 | 多级审批，指定起始层级与级数 |

**审批人解析失败必须有兜底**（转交管理员或挂起并告警），
不能静默卡住 —— 卡住的流程无人知道要处理。

> **注意**：兜底规则**契约里没有字段承载**（它属上面说的 complete-check 范围）。
> 所以在契约之外**向用户说明**兜底行为，不要以为不写就自动有了。

## 2. 条件分支

条件只允许引用表单字段与系统字段，**禁止任意代码**：

- **必须有一条默认分支**。条件都不命中时流程要有去处。
- 条件**互斥且有序**，从上往下第一个命中的生效。
- 金额比较用整数分，不要用浮点。
- 每个条件分支都要有测试示例（见下方）。

## 3. 多人审批的收敛方式

| 方式 | 语义 | 何时用 |
|---|---|---|
| 或签 | 任一人通过即通过 | 值班、候补审批人 |
| 会签 | 全部通过才通过 | 需要多方确认 |

**默认用或签**，会签必须显式声明 —— 会签会让流程卡在最后一个人那里。

## 4. 驳回、撤回、超时

**驳回目标态必须显式**：回草稿可改重提，还是直接终止？
最常见的设计缺陷是驳回后无处可去。

| 场景 | 要求 |
|---|---|
| 驳回 | 在 `transitions` 里**明确写出**回到哪个状态 |
| 撤回 | 发起人可否撤回、能撤到哪一步 —— 默认只能在首个审批节点前撤 |
| 超时 | 时长 + 动作（提醒 / 自动通过 / 升级）。**不设超时要有理由** |
| 转交 | 审批人可否转交，转交后原审批人的待办如何处理 |

> **超时与转交同样不在契约字段里** —— 见「校验边界」一节，
> 这些要么在流程外实现，要么需向用户说明当前不支持。

## 5. 权限与可见性

- 谁能发起这个流程
- 每个审批节点谁能操作（解析后的人，还是角色所有人）
- 非参与者能否看到进度（通常可看，不能操作）
- 审批意见谁可见

### 5.1 流程的权限策略怎么写（**照这四条写，别自己发明**）

流程权限在 `permission-spec` 里是 `dimension: "FLOW"` 的那些策略。
它们有四个坑，每一个都会让员工**点不动流程按钮**，而报错只说「没权限」：

| # | 写什么 | 别写成 | 为什么 |
|---|---|---|---|
| 1 | `resource_ref.asset_id` = **业务对象**的代号（与 `businessSchemaRef.asset_id` 同一个值） | 流程自己的名字（如 `customer_follow`） | **流程没有独立身份** —— 它就是这张表单的一个开关。平台注册、投影、判权限全都按业务对象走，写流程名会得到一条**永远匹配不上**的策略 |
| 2 | `actions` 写**类别**：`INITIATE` / `SUBMIT` / `WITHDRAW` / `APPROVE` / `REJECT` / `CLOSE` / `REOPEN` | `action_code`（如 `start_follow`） | `action_code` 是**业务名**，是给人看的；判权限用的是**类别**（`permission-spec` 的 schema 里这是闭枚举）。混用会永远不匹配 |
| 3 | `subresource.state` = 状态码，表示**只在这个状态下**成立；**不写**表示不限状态 | 忘了写却以为它生效 | 写了就只在那个状态下放行；「跟进中才能成交」这类规则靠它表达 |
| 4 | 记录**出生**在 `states[]` 里 `initial: true` 的那个状态 | 以为记录先当「草稿」 | 新记录的初始状态**来自这份契约**。想让记录先当草稿，就在 `states[]` 里声明一个 `initial: true` 的草稿态 —— 平台不会替你发明一个 |

**一个能用的例子**（销售能发起、跟进中能成交、主管任何状态都能看）：

```json
{
  "policy_code": "sales_flow_advance",
  "role_code": "sales",
  "role_ref": { "permission_ref": { "...": "指向角色目录" },
                "subresource": { "type": "ROLE", "code": "sales" } },
  "dimension": "FLOW",
  "resource_ref": { "asset_type": "WORKFLOW", "asset_id": "customer", "...": "与业务对象同一个 id" },
  "effect": "ALLOW",
  "subresource": { "type": "STATE", "code": "following" },
  "actions": ["SUBMIT", "CLOSE"],
  "capability_refs": []
}
```

⚠️ 上面第 1、2 条**在 v1 试点里真的写错过**，而症状是
「界面上一个流程按钮都没有」—— 那时它看起来像流程引擎坏了，
实际是策略里两个字段各写了一套自己的名字。

---

# 四、一份完整的、已验证的示例

```json
{
  "businessSchemaRef": {
    "scope_type": "TENANT",
    "scope_id": "fixture_tenant",
    "app_id": "11111111-1111-4111-8111-111111111111",
    "module_id": null,
    "asset_type": "BUSINESS_SCHEMA",
    "asset_id": "fixture_asset",
    "version": 1,
    "digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "states": [
    {
      "state_code": "draft",
      "name": "草稿",
      "initial": true,
      "terminal": false
    },
    {
      "state_code": "submitted",
      "name": "待审批",
      "initial": false,
      "terminal": false
    },
    {
      "state_code": "approved",
      "name": "已通过",
      "initial": false,
      "terminal": true
    },
    {
      "state_code": "rejected",
      "name": "已驳回",
      "initial": false,
      "terminal": false
    }
  ],
  "actions": [
    {
      "action_code": "submit",
      "kind": "SUBMIT",
      "capability_ref": {
        "scope_type": "TENANT",
        "scope_id": "fixture_tenant",
        "app_id": "11111111-1111-4111-8111-111111111111",
        "module_id": null,
        "asset_type": "CAPABILITY",
        "version": 1,
        "digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "capability_code": "fixture.action"
      }
    },
    {
      "action_code": "approve",
      "kind": "APPROVE",
      "capability_ref": {
        "scope_type": "TENANT",
        "scope_id": "fixture_tenant",
        "app_id": "11111111-1111-4111-8111-111111111111",
        "module_id": null,
        "asset_type": "CAPABILITY",
        "version": 1,
        "digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "capability_code": "fixture.action"
      }
    }
  ],
  "transitions": [
    {
      "transition_code": "submit_flow",
      "from_state": "draft",
      "to_state": "submitted",
      "action_code": "submit"
    },
    {
      "transition_code": "approve_done",
      "from_state": "submitted",
      "to_state": "approved",
      "action_code": "approve"
    },
    {
      "transition_code": "reject_back",
      "from_state": "submitted",
      "to_state": "rejected",
      "action_code": "approve"
    },
    {
      "transition_code": "resubmit",
      "from_state": "rejected",
      "to_state": "submitted",
      "action_code": "submit"
    }
  ],
  "approverRef": {
    "kind": "SINGLE",
    "role_ref": {
      "permission_ref": {
        "scope_type": "TENANT",
        "scope_id": "fixture_tenant",
        "app_id": "11111111-1111-4111-8111-111111111111",
        "module_id": null,
        "asset_type": "PERMISSION",
        "asset_id": "role_directory",
        "version": 1,
        "digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      },
      "subresource": {
        "type": "ROLE",
        "code": "manager"
      }
    }
  }
}
```

**这份示例是结构校验通过的状态** —— 从本文件提取后可直接跑：
依赖的 `capability_ref` 与 `businessSchemaRef` 都指向真实资产。

> ⚠️ **但那些 ref 里有本部署特有的值**（`scope_id`、`asset_id`、`version`、`digest`）。
> 上面这组只是让示例能跑起来，**照抄会让引用失效**。
> 必须从平台侧取得真实值 —— 拿不到就先问，不要用占位符蒙。

**注意这份示例里 `rejected` 不是终态** —— 它有一条回到 `submitted` 的迁移，
这正是「驳回后可以重新提交」。若业务上驳回即终止，把 `terminal` 改成 `true`
并删掉 `resubmit` 那条。

---

# 五、自查

```bash
python3 工具/check_skill_output.py <你的Spec.json> --contract workflow-spec/v1alpha1
```

**它的输出会带一条警告**：这只是结构校验。所以跑完**还要人肉过一遍**：

- [ ] 每个 `terminal: true` 的状态都真的可达
- [ ] 没有孤立状态（既非 initial，也没有入边）
- [ ] 每条 `transitions` 的 `action_code` 都在 `actions` 里
- [ ] 驳回目标态明确
- [ ] 每个条件分支有可达的测试输入，**边界值单列一条**
- [ ] 审批人解析失败的兜底已向用户说明

---

## 测试示例（必填）

每个条件分支给至少一条走通的样例，证明分支可达：

| 场景 | 输入 | 期望路径 |
|---|---|---|
| 小额 | 金额 = 10000 | draft → submitted → approved |
| 大额 | 金额 = 80000 | draft → submitted → approved（走总监链） |
| 大额被驳 | 金额 = 80000，驳回 | … → rejected → submitted（重提） |
| **边界** | 金额 = 50000 | **含等号规则要写清** |

**边界值必须有一条用例** —— `>` 还是 `>=` 是审批纠纷的常见来源。

## 常见错误

| 错误 | 后果 | 正确做法 |
|---|---|---|
| 审批人写死人名 | 人员变动后流程失效 | 用 `RoleRef` 指向角色 |
| 没有默认分支 | 条件不命中时流程悬空 | 必须有默认分支 |
| 驳回目标态未定 | 驳回后无处可去 | 显式写驳回的 `to_state` |
| 条件与状态机脱节 | 批完状态不对 | 先定状态机 |
| 默认会签 | 卡在最后一人 | 默认或签，会签显式声明 |
| 审批人解析无兜底 | 流程静默卡死 | 转交或告警，并**向用户说明** |
| 边界值无用例 | `>` / `>=` 争议 | 边界值单列用例 |
| 产出没跑校验 | 交付物过不了发布通道 | 必须跑结构校验 |
| 以为结构过了就完事 | 上面四类问题不会被自动查出 | 照 §5 自查清单人肉过一遍 |

## 交接

- 流程产生的数据要被统计 → `dashboard-builder`
- 流程要被外部系统触发或查询 → `api-spec`
