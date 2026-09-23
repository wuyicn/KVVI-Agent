# `view-schema` 产出样例

> **卡 2（`form-builder`）与卡 4（`dashboard-builder`）的验收基准。**
> 两份产出**已通过与官方验证器完全相同的校验路径**，可作为改写 `SKILL.md` 时的对照物。

## 文件

| 文件 | 用途 | 校验 |
|---|---|---|
| `通用事项登记表单.spec.json` | 表单（卡 2）：`view_type: "FORM"`、9 个节点 | 结构 + 语义 + 引用**三层通过** |
| `context.json` | 上面那份表单的配套上下文 | — |
| `月度销售看板.spec.json` | 看板（卡 4）：`view_type: "LIST"`、3 条口径、7 个节点 | 结构 + 语义 + 引用**三层通过** |
| `context-看板.json` | 上面那份看板的配套上下文（比 `context.json` **多两条聚合口径**） | — |
| `看板-口径登记.json` | 看板口径的**不变量登记单**（§9.8.1） | `工具/check_invariant.py --input` **判定通过** |

## 复现验收

```bash
# 表单（完整校验）
python3 工具/check_skill_output.py 样例/view-schema/通用事项登记表单.spec.json \
  --contract view-schema/lce-safe-v1 --context 样例/view-schema/context.json

# 看板（完整校验）
python3 工具/check_skill_output.py 样例/view-schema/月度销售看板.spec.json \
  --contract view-schema/lce-safe-v1 --context 样例/view-schema/context-看板.json

# 看板口径的 §9.8.1 不变量判定
python3 工具/check_invariant.py --input 样例/view-schema/看板-口径登记.json
```

**退出码**：`0` = 通过 / `1` = 未通过 / `2` = 无法执行。

## ⚠️ 为什么看板要单独一份 context

`context-看板.json` 由 `工具/看板样例上下文.py` 生成，与 `context.json` 的差别**只有两条**：

| 资产 | 含义 | `itemKeys` |
|---|---|---|
| `caliber.monthly_sales` | 月度销售额 | `["month"]` |
| `caliber.dept_completion` | 部门完成率 | `["dept"]` |

**为什么必须新增**：`context.json` 里只有 `records.list` / `records.get` /
`options.list` 三个 QUERY 能力，**没有一个是聚合口径**。
不新增就只能拿「记录列表」冒充口径 —— 那样验出来的是「引用机制通」，**不是「口径通」**。

**为什么不手写**：每一项 `ref.digest` 都是内容经 `kvvi-json-c14n/v1` 规范化后的摘要，
链条是「口径内容 → 口径摘要 → 注册表 members → 注册表摘要 → `view.capability_registry_ref.digest`」。
手写必然在某个环节算错，而且校验只报「摘要不符」，**不告诉你是哪一环**。
生成脚本按正确顺序重算，并支持 `--check` 检出手改：

```bash
python3 工具/看板样例上下文.py            # 生成
python3 工具/看板样例上下文.py --check    # 校验现有文件是否与生成结果一致
```

## 看板样例的两处占位（必须知道）

| 占位 | 原因 | 何时替换 |
|---|---|---|
| 图表节点用 `Table` | 当前可用注册表是**测试 fixture**（`"fixture": true`、`"implementation": "no-renderer"`），23 个组件里**没有任何图表**。按**决策 A**，生产注册表另有图表组件 | 生产注册表到手后，只换 `componentName`；**结构、口径、`props.data` 绑定都不用动**（见 `SKILL.md` §5.3） |
| 口径 capability 的内容 | 13 份 MetaSchema 里**没有定义 `CAPABILITY` 资产本身**的契约（只有引用它的 `CapabilityRef`） | 平台侧补契约后（见 `进度.md` N10） |

**这两处都不影响已验的部分** —— 引用层与不变量层都是真跑的，不是构造出来的。

## 反向验证（证明这些样例不是恒绿）

改坏即被拒，逐项实测：

| 改动 | 结果 |
|---|---|
| `DataBindingRef.itemKey` 改成口径里没有的值 | ❌ 拒绝 |
| 口径 `params` 缺 `dataScope` | ❌ 拒绝 |
| 口径引用 `digest` 改一位 | ❌ 拒绝 |
| 引用未登记的口径 `code` | ❌ 拒绝 |
| 绑定未声明的 `query_code` | ❌ 拒绝 |
| 根节点 `ListPage` 装进 `DETAIL` | ❌ 拒绝 |
| 口径可见性 `COMPANY` 但只注入 `SELF` | ❌ 拒绝（L3） |
| 部门口径却声明 `STORE` 可见 | ❌ 拒绝（L1） |
| 口径指向不存在的租户 `t2` | ❌ 拒绝（L1） |
