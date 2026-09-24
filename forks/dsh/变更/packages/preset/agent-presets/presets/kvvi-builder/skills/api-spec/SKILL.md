---
name: api-spec
description: 接口与工具定义——资源设计、工具契约、类型化命令，产出 tool-spec 与 app-model-command。适用于「生成这些页面对应的 API 定义」「要跟外部系统对接」这类需求。前置依赖 data-model。
---

# 接口与工具定义（api-spec）

把模型和界面绑到一份**写明了的、可通过校验的**接口契约上。

## 先说产出是什么

本 Skill 产出**两份契约**，不是一份接口草案：

| 契约 | 是什么 | 给谁用 |
|---|---|---|
| **`tool-spec`** | **工具定义** —— 一个可被调用的能力 | Agent 经 Tool Gateway 调用 |
| **`app-model-command`** | **类型化命令** —— 一次改模型的操作 | 编辑器 / 搭建流程 |

> **判定标准**：不能被 MetaSchema 校验的产出，不属于本产品的搭建产出。

## ⚠️ 先理解「工具」不等于「REST 端点」

原来说的「设计一套 REST API」，在契约里落成的是**工具**。
两者的差别不是措辞：

| REST 直觉 | 契约里的对应 |
|---|---|
| 一个端点 | 一个 `tool-spec` |
| 路径与方法 | `tool_code` |
| 请求 / 响应体 | `input_schema` / `output_schema`（**引用** JSON Schema） |
| 挂在哪个服务上 | **`gateway`** —— 双网关，见下 |
| 权限 | `required_permissions` + `scope_policy` |
| 限流 | `rate_limit` |
| 幂等 | `reliability.idempotency` |
| 审计 | `audit_policy`（**强制开启，不可关**） |

**资源设计的智慧仍然适用**（名词资源、动作端点、不透明 id、统一错误体），
但它们落在 `input_schema` / `output_schema` 里，不是路径字符串。

## 何时用

- 用户要对接外部系统：*「生成这些页面对应的 API 定义」*
- 用户要把原型给开发团队实现
- 原型里有跨边界的数据流（浏览器 ↔ 服务端、本系统 ↔ 外部系统）

## 前置

模型未定**先跑 `data-model`**。接口形状由模型决定：
实体 → 资源，关系 → 子资源或查询参数，状态机 → 动作。

---

# 一、双网关是硬边界

`gateway` 只有两个取值，**它决定这个工具出现在哪一侧**：

| 取值 | 谁能用 | 典型工具 |
|---|---|---|
| **`BUILDER_GATEWAY`** | **搭建者**（搭建引擎模式） | 建实体、加字段、改流程、改权限 |
| **`USER_GATEWAY`** | **员工**（工作模式） | 查单据、提交申请、审批 |

> **PRD §5.2 原文**：「工具边界即双网关边界」——
> 工作模式的可用工具集，就是登记在 `USER_GATEWAY` 下的工具集。
> **这不是两处配置，是同一份契约。**

**所以**：给员工用的工具**绝不能**挂到 `BUILDER_GATEWAY`，
反之亦然。**这是红线 1（同一套校验）在接口层的落地**。

**最常见的错误**：把「改模型结构」的工具登记成 `USER_GATEWAY` ——
那等于给员工开了改结构的门。

## 配套的 `risk_level`

| 取值 | 含义 |
|---|---|
| `READ` | 只读 |
| `WRITE` | 写业务数据 |
| `STRUCTURE_CHANGE` | **改模型结构** |
| `RELEASE` | 发布 |

**`STRUCTURE_CHANGE` 与 `RELEASE` 只应出现在 `BUILDER_GATEWAY` 侧。**

## `data_access`

| 取值 | 含义 |
|---|---|
| `NONE` | 不碰数据 |
| `SYNTHETIC` | 只碰合成数据（搭建期预览） |
| `AUTHORIZED_BUSINESS` | **访问真实业务数据**（员工侧工具） |

---

# 二、`tool-spec` 的 16 个必填字段

```json
{
  "tool_code": "general_item.get",
  "tool_version": "1.0.0",
  "gateway": "USER_GATEWAY",
  "implementation_digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "input_schema": {
    "schema_id": "fixture.input",
    "digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "output_schema": {
    "schema_id": "fixture.output",
    "digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "error_codes": [
    "TOOL_RATE_LIMITED",
    "item_not_found",
    "permission_denied"
  ],
  "limits": {
    "timeout_ms": 1000,
    "max_input_bytes": 1024,
    "max_output_bytes": 2048,
    "max_items": 100
  },
  "rate_limit": {
    "algorithm": "SLIDING_WINDOW",
    "subject": "TENANT_ACTOR_TOOL",
    "window_ms": 60000,
    "max_requests": 60,
    "burst_policy": "WITHIN_QUOTA"
  },
  "required_permissions": {
    "builder_permissions": [],
    "form_actions": [],
    "field_filter": false,
    "data_scope": true,
    "flow_actions": []
  },
  "scope_policy": {
    "allowed_scope_types": [
      "TENANT"
    ],
    "app_refs": [],
    "module_codes": []
  },
  "risk_level": "READ",
  "data_access": "AUTHORIZED_BUSINESS",
  "confirmation": {
    "immediate": false,
    "human_approval": false,
    "dual_approval_declared": false,
    "dual_approval_enabled": false
  },
  "reliability": {
    "idempotency": "READ_ONLY",
    "max_retries": 2,
    "retry_on": [
      "TIMEOUT"
    ],
    "compensation_ref": null
  },
  "audit_policy": {
    "parameter_digest": true,
    "result": true,
    "rejection_reason": true,
    "trace_id": true,
    "retention_days": 30
  }
}
```

## 三条「不是随便填」的字段

### ① `error_codes` **必须包含 `TOOL_RATE_LIMITED`**

契约用的是 `contains: {const: "TOOL_RATE_LIMITED"}` ——
**少写它直接结构错误**。这保证每个工具都能表达被限流这件事。

### ② `confirmation.dual_approval_enabled` **固定为 `false`**

契约把它写成 `const: false` —— 双审批首版未启用。
其余三个字段（`immediate` / `human_approval` / `dual_approval_declared`）**必须显式写**，
不能省略。

**不可逆操作**（`WRITE` 且有副作用）应当 `human_approval: true`。

### ③ `audit_policy` **前四项固定 `true`**

```jsonc
{ "parameter_digest": true, "result": true,
  "rejection_reason": true, "trace_id": true, "retention_days": 365 }
```

**审计不可关**。只能选 `retention_days`。

---

# 三、资源设计的规则（落在 schema 里）

## 3.1 资源是名词，动作独立

**一个资源可以有几个工具**：

| 动作 | `tool_code` 示例 | `risk_level` |
|---|---|---|
| 列表 | `item.list` | `READ` |
| 详情 | `item.get` | `READ` |
| 创建 | `item.create` | `WRITE` |
| 更新若干字段 | `item.patch` | `WRITE` |
| 删除 | `item.delete` | `WRITE` |

## 3.2 ⚠️ 状态迁移必须是独立工具，不能用 `patch` 改状态

**这是最容易做错的地方。状态是结果，不是入参。**

```
❌ item.patch  { "status": "approved" }        ← 绕过审批规则
✅ item.approve { "comment": "…" }
✅ item.reject  { "comment": "…", "reason": "…" }
```

用 `patch` 直接改状态会**绕过审批人解析、权限校验和审计记录**。
**每个状态迁移一个工具，让服务端决定状态怎么变。**

## 3.3 请求与响应

| 规则 | 理由 |
|---|---|
| **金额一律整数分**，字段名或 `input_schema` 写明单位 | 浮点金额是对不平账的根因 |
| **时间一律 ISO 8601 带时区** | 本地化字符串有时区歧义 |
| **id 是不透明字符串**，客户端不得解析结构 | 解析 id 会在换 id 方案时全线崩 |
| 请求与响应**形状可以不同** | 响应带服务端生成字段 |
| 列表**包一层** `{items, page}`，不返回裸数组 | 裸数组以后加不了分页元信息 |

## 3.4 错误

统一错误体，一个形状覆盖所有失败：

```jsonc
{ "error_code": "validation_failed",   // 机器判定的稳定标识
  "message": "…",                       // 给人看，说清怎么改
  "field_errors": [ { "field": "amount", "reason": "必须大于0" } ],
  "trace_id": "…" }                     // ★ 必须返回，用于对日志
}
```

**状态码选择**：

| 码 | 何时用 |
|---|---|
| 400 | 体不是合法 JSON |
| 401 | 无凭据或凭据过期 |
| 403 | 认证通过但该操作不允许 |
| 404 | 不存在**或无权看到**（不区分） |
| 409 | 唯一约束、并发版本冲突 |
| 422 | 字段都合法但业务规则不满足 |
| 429 | 频率超限，带 `Retry-After` |
| 500 | 必须返回 `trace_id` |

**403 与 404 的选择很重要**：无权访问的资源返回 **404**，
避免通过状态码探测「这个 id 是否存在」。

## 3.5 幂等

**有副作用的工具必须幂等**：

```jsonc
"reliability": { "idempotency": "KEY_REQUIRED", … }
```

| 取值 | 何时用 |
|---|---|
| `READ_ONLY` | 只读工具 |
| `KEY_REQUIRED` | **创建/支付/发通知** —— 必须带幂等键 |

**重放导致重复扣款、重复下单是真实损失**，不是理论问题。

---

# 四、`app-model-command`：类型化命令

改模型的每个操作是一条**命令**，14 种，共 7 个必填字段：

```jsonc
{
  "command_version": "app-model-command/v1alpha1",
  "command_id": "…",
  "draft_id": "…",
  "base_revision": 0,                // 并发控制：基线版本
  "type": "field.add",               // 见下表
  "target_ref": { … },               // 改谁
  "args":         { … }              // 怎么改
}
```

**14 个 `type`**：

| 分类 | 取值 |
|---|---|
| 模块 | `app.createModule` |
| 实体 | `businessObject.create` |
| 字段 | `field.add`、`field.changeConstraint` |
| 视图 | `view.addNode`、`view.moveNode`、`view.bindField` |
| 导航 | `navigation.addRoute` |
| 流程 | `workflow.addTransition` |
| 权限 | `permission.changeRolePolicy` |
| 草稿 | `draft.undoCommand`、`draft.redoCommand`、`draft.compile`、`draft.submitForApproval` |

**一份完整的命令**（`field.add`，已通过结构校验）：

```json
{
  "command_version": "app-model-command/v1alpha1",
  "command_id": "11111111-1111-4111-8111-111111111111",
  "draft_id": "11111111-1111-4111-8111-111111111111",
  "base_revision": 0,
  "type": "field.add",
  "target_ref": {
    "business_object_id": "11111111-1111-4111-8111-111111111111"
  },
  "args": {
    "field_code": "expected_date",
    "field_type": "date",
    "label": "Expected date",
    "required": false
  }
}
```

**`base_revision` 是并发控制的载体** —— 两个人在同一草稿上改，
后提交的会因基线不符被拒，而不是静默覆盖。

> **`args` 的形状随 `type` 变**（如 `field.add` 用 `FieldAddArgs`）。
> 契约用 `oneOf` 表达这 14 种，写错 `type` 会被直接拒。

---

# 五、自查

```bash
# 工具定义（注册态有官方用例）
python3 工具/check_skill_output.py <你的ToolSpec.json> --contract tool-spec/v1alpha1

# 类型化命令
python3 工具/check_skill_output.py <你的Command.json> --contract app-model-command/v1alpha1
```

上面两份示例都是**结构校验通过**的状态，可作对照物。
⚠️ 它们含**本部署特有的值**（`implementation_digest`、`schema_id`、`digest`）——
照抄会让引用失效，必须从平台侧取得真实值。

⚠️ **这两条契约目前只有结构校验**（在 `cli.mjs` 白名单之外，且无语义模块）。
所以跑完**还要人肉过一遍**：

- [ ] **每个工具的 `gateway` 与它的使用者一致** —— 改结构的绝不在 `USER_GATEWAY`
- [ ] `risk_level` 与 `gateway` 相容（`STRUCTURE_CHANGE` / `RELEASE` 只在搭建侧）
- [ ] `error_codes` 含 `TOOL_RATE_LIMITED`
- [ ] `confirmation` 四个字段都写了
- [ ] `audit_policy` 五项都写了（前四项必须是 `true`）
- [ ] 有副作用的工具 `idempotency` 是 `KEY_REQUIRED`
- [ ] **状态迁移各自独立成工具**，没有用 `patch` 改状态
- [ ] `input_schema` / `output_schema` 的 `digest` 是真实值

---

## 常见错误

| 错误 | 后果 | 正确做法 |
|---|---|---|
| **改结构的工具挂 `USER_GATEWAY`** | **给员工开了改结构的门** | 挂 `BUILDER_GATEWAY` |
| 用 `patch` 改状态 | 绕过审批与权限 | 每迁移一个独立工具 |
| `error_codes` 漏 `TOOL_RATE_LIMITED` | **结构错误** | 必写 |
| `confirmation` 省略字段 | 结构错误 | 四个都写 |
| `audit_policy` 想关审计 | 契约固定为 true | 不可关 |
| 金额用浮点 | 对不平账 | 整数分 + 写明单位 |
| 列表返回裸数组 | 无法加分页 | 包 `{items, page}` |
| 无权返回 403 | 可探测 id | 无权也返回 404 |
| 副作用工具非幂等 | 重放导致重复扣款 | `KEY_REQUIRED` |
| 本地化时间字符串 | 时区歧义 | ISO 8601 带时区 |
| 错误体形状不一 | 客户端无法统一处理 | 统一错误体 + `trace_id` |
| 命令不带 `base_revision` | 静默覆盖他人修改 | 必带 |

## 交接

接口契约是可交付物，交付时**连同一份示例文件写入工作区**，
不要只在回复里贴一段 YAML —— 回复会随会话消失，文件不会。
