# `business-schema` 产出样例

> **卡 1（`data-model`）的验收基准。** 本目录里这份 Spec **已通过与官方验证器完全相同的
> 校验路径**，可作为改写 `SKILL.md` 时的对照物。

## 文件

| 文件 | 用途 |
|---|---|
| `通用事项.spec.json` | 一份 `business-schema/v1` 的 `Spec`，**结构 + 语义 + 引用三层全通过** |
| `context-新建.json` | 配套上下文：`snapshots: []`、`histories: []` —— 「从零建一个模型」 |
| `context-修改.json` | 配套上下文：含 1 条已注册版本与历史 —— 「改已有的模型」 |

## 复现验收

```bash
# 结构校验（不需要 context）
node tools/meta-schema/node/cli.mjs \
  --contract business-schema/v1 --entry spec --checks structure \
  < 样例/business-schema/通用事项.spec.json

# 完整校验（结构 + 语义 + 引用）
node tools/meta-schema/node/cli.mjs \
  --contract business-schema/v1 --entry spec --checks complete \
  --context 样例/business-schema/context-新建.json \
  < 样例/business-schema/通用事项.spec.json
```

**退出码**：`0` = 有效 / `2` = 有校验错误 / `1` = 执行失败。

**当前实际输出**：两条都是 `"valid": true, "errors": []`，退出码 `0`。

## ⚠️ 「新建」与「修改」用不同的 context

同一份 Spec，两份 context 的结论**不同**：

| context | 判定 |
|---|---|
| `context-新建.json`（无已注册版本） | ✅ 通过 |
| `context-修改.json`（含已注册版本 + 历史） | ❌ `MIGRATION_REQUIRED` / `BREAKING_CHANGE_FORBIDDEN` 等 |

**这不是矛盾，而是两类不同的操作**：新建关注「产出物本身合法吗」，
修改还要关注「与已注册版本的变化是否被允许」。`SKILL.md` 必须让模型知道
自己处在哪一种场景里 —— 否则它会以为是自己的 Spec 写错了。
