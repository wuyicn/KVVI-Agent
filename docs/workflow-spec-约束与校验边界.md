# `workflow-spec` 约束与校验边界

> **卡 3（`workflow-builder`）的配套文档。** `SKILL.md` 已自包含编排规范，
> 本文档只补两样它没展开的：**校验边界**与**字段级约束**。
>
> **来源**：`workflow-spec.v1alpha1.schema.json` + 43 条官方 `spec` 用例实测。

---

## 一、⚠️ 最关键的一条：这条契约**只有结构校验**

### 1.1 契约自己的声明

`Spec` 的 `$comment` 原文：

> Structure only: role directory resolution, per-step coverage/graph order,
> selector field matrix and 100-leaf total are **complete-check responsibilities**.

**翻译**：下列检查属「complete check」的职责，而 **`workflow-spec` 没有 complete check 实现**：

| 不会被自动检查的 | 含义 |
|---|---|
| role directory resolution | 角色能否解析出真实的人 |
| per-step coverage | 每个状态是否可达 |
| graph order | 迁移图的顺序与连通性 |
| selector field matrix | 条件选择器引用的字段是否存在 |
| 100-leaf total | 条件嵌套的总量上限 |

### 1.2 工具侧的印证

`tools/meta-schema/node/cli.mjs` 的 `CONTRACTS` 白名单**只有三个契约**
（`business-schema/v1`、`view-schema/lce-safe-v1`、`app-spec/v1alpha1`），
它的 bundle 是 `0a-core-r1`。

**`workflow-spec` 不在其中**，且 `tools/meta-schema/node/` 下
**没有 `workflow*.mjs`** —— 没有任何 workflow 专用的语义校验模块。

**两条独立证据指向同一结论** ✓

### 1.3 那我们能做什么

`contracts/meta-schemas/0a-full-r1/` 有**全量 14 个 schema**，
所以**结构校验可行**：

```bash
python3 工具/check_skill_output.py <你的Spec.json> --contract workflow-spec/v1alpha1
```

底层是 `工具/lib/full_bundle_check.mjs`（加载全量 schema + ajv）。

**它的输出会显式写明 `scope: structure_only`**，并附覆盖范围说明 ——
避免被读成「完整校验通过」。

### 1.4 实测判定能力

用 `w12-cases.json` 的全部 43 条 `workflow-spec/spec` 用例实测：

```
用例总数: 43
判定一致: 43
判定不符: 0
```

**判定器本身是可靠的**（能区分正负例），只是**判别范围窄于完整校验**。

### 1.5 这意味着什么

| | |
|---|---|
| 「结构通过」 | **必要**条件 |
| 「通过 MetaSchema 校验」 | 对这条契约**目前不可达** —— 没有实现 |

**所以 `SKILL.md` 里加了一份人肉自查清单**（§5），覆盖上面那四类不会被自动查出的问题。
**这不是补充说明，是必须做的一步。**

---

## 二、Spec 的字段级约束

### 2.1 五个字段全必填

```jsonc
{
  "businessSchemaRef": { … },   // AssetRef，asset_type = BUSINESS_SCHEMA
  "states":      [ … ],         // 1–100
  "transitions": [ … ],         // 0–500
  "actions":     [ … ],         // 0–100
  "approverRef": { … }
}
```

`additionalProperties: false`。

**注意 `transitions` 可以是 0 个** —— 一个只有状态没有迁移的流程结构上合法，
但业务上多半是错的（那正是 complete check 该管的）。

### 2.2 状态

```jsonc
{ "state_code": "draft", "name": "草稿", "initial": true, "terminal": false }
```

`state_code` 用 `MachineCode`（`^[a-z][a-z0-9_]{2,63}$`）。

**`initial` / `terminal` 是布尔**，结构上不限制「只能有一个 initial」——
那也属 complete check。

### 2.3 动作

```jsonc
{ "action_code": "submit", "kind": "SUBMIT", "capability_ref": { … } }
```

`capability_ref` 是 `CapabilityRef`，**`digest` 必须真实**。

### 2.4 迁移

```jsonc
{ "transition_code": "submit_flow", "from_state": "draft",
  "to_state": "submitted", "action_code": "submit" }
```

**结构上不校验 `from_state` / `to_state` / `action_code` 是否存在** ——
引用一致性属 complete check。

### 2.5 审批人

`approverRef` 是 `oneOf`：

| 形态 | 结构 |
|---|---|
| `SingleApprover` | `{"kind": "SINGLE", "role_ref": RoleRef}` |
| `FixedChain` | `{"kind": "FIXED_CHAIN", "steps": [ApprovalStep]}`，1–100 步 |

条件选链另见 `ChainSelection`（`kind: "REGISTERED_CHAIN_SELECTION"`，
含 `default_chain_ref` 与 `choices[]`），`Choice` 由 `Selector` 决定走哪条链。

`RoleRef` 内含 `permission_ref`（指向权限资产）与 `subresource`（角色码）。

---

## 三、本文档已知的不足

| # | 不足 | 影响 |
|---|---|---|
| 1 | **`Predicate` / `Selector` 的完整算子集未列出** | 只从 `$defs` 看到 `eq`/`ne`，未穷举 |
| 2 | **`ApprovalStep` 的完整字段未展开** | 只看到 `step_code`、`pending_state` |
| 3 | **`kind` 的取值枚举未列全** | 只确认了 `SUBMIT` / `APPROVE` |
| 4 | **「100-leaf total」的具体含义未查** | 契约只提到它是 complete check 的职责 |
| 5 | **未验证 complete check 是否存在于别处** | 结论基于本仓库现状；产品侧可能另有实现 |
| 6 | **未经第二人复核** | 由我一人从契约与用例读出 |
