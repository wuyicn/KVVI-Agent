# 0A 全部 13 份协议机器 Schema：结构交付候选

这里有 **13 个协议 + 1 个共享定义文件**，不把 common、多个入口或 ReleaseEnvelope 算作额外协议。依据冻结 PRD v1.11 及[本次交付边界](../../../docs/superpowers/specs/2026-09-15-0a-5-machine-delivery-scope.md)。旧 `0a-core-r1` 原文件、语义行为与证据保持不变。

## 协议清单

| 协议 / 文件 | 入口 | 结构责任 |
| --- | --- | --- |
| business-schema.v1.schema.json | CompiledDraft / Spec / RegisteredContract | 十类字段、规则/索引/布局外形；只迁移资源ID |
| view-schema.lce-safe-v1.schema.json | 同上 | 页面、节点、安全绑定外形；只迁移资源ID |
| app-spec.v1alpha1.schema.json | 同上 | 完整AssetRef组合、DISABLED空槽；只迁移资源ID |
| permission-spec.v1alpha1.schema.json | 同上 | 角色目录、四维策略封闭分支 |
| workflow-spec.v1alpha1.schema.json | 同上 | 单人、固定链、整链选择器、状态/动作外形 |
| app-model-command.v1alpha1.schema.json | command（根对象） | 14个命令的封闭target_ref/args |
| tool-spec.v1alpha1.schema.json | RegisteredContract（根登记入口） | 工具三类版本、双网关、风险、参数资源、限额/速率/审计 |
| migration-plan.v1alpha1.schema.json | record（根对象） | 计划、步骤、受限操作参数、恢复与DEFERRED清理声明 |
| migration-run-event.v1alpha1.schema.json | record（根对象） | 正向/逆向运行记录、阶段/状态、检查点/结果/错误形状 |
| artifact-manifest.v1alpha1.schema.json | record（根对象） | 契约集合、Registry/Policy/迁移/工具引用、图/兼容/SBOM |
| approval-attestation.v1alpha1.schema.json | record（根对象） | 审批记录、制品摘要、展示/审计引用 |
| promotion-record.v1alpha1.schema.json | record（根对象） | 环境、事件、结果/错误/回滚字段条件 |
| evidence-bundle.v1alpha1.schema.json | record（根对象） | 九类封闭证据载荷与结果分支 |

每份协议 `$defs.AssetRef` 均直接引用 common；使用 CapabilityRef 的位置复用同一共享定义。所有资源由本地manifest固定ID和字节摘要，不按业务名称猜版本、不联网解析 `$ref`。三个草案协议迁入的行为与新十协议不同，不能用同一协议的多个入口凑数。

## 可重放结构验证

依赖复用仓库已锁定版本，不引入新包：

```sh
npm ci --prefix tools/meta-schema/node --ignore-scripts
python3.11 -m venv .venv
.venv/bin/python -m pip install --require-hashes -r tools/meta-schema/python/requirements.lock
.venv/bin/python tests/meta-schema-full/0a-full-r1/test_structure.py
.venv/bin/python tools/meta-schema-full/0a-full-r1/verify.py --output /tmp/kvvi-full-structure-report.json
```

输出路径必须不存在，以免覆盖历史报告。报告绑定Schema、manifest、固定预期、设计来源、锁文件、校验代码与格式实现的SHA-256。source_commit同时记录worktree_dirty，不能拿脏工作区报告冒充已提交版本。

Python和Node真实引擎独立判断同一输入，分别与事先固定的valid预期比较；仅两个引擎互相一致不够。全部资源自校验，未被根引用的defs也由Ajv实际编译。禁强转、注入默认值、删除未知字段和输入修改。保留原core的480条固定结构用例，原预期不改；新用例按组保留原因和真假结果。合成样例中的摘要字符串只用于结构测试，不声称正文摘要已复算。

## 验证边界（必须和通过结果一起阅读）

本工具只提供 **structure**。`semantic_validation_complete:false`、`runtime_verified:false`、`release_approved:false` 始终明确输出。它不是新十协议的完整Linter，也不是Policy、真实运行时或发布批准。

| 组 | 仍需完整Linter/Fake集成或运行时验证的责任 |
| --- | --- |
| 全部引用 | 精确注册资产存在性、租户/应用授权、不可变版本/正文摘要、Capability与资源行为匹配、共享上下文信任 |
| Permission/Workflow | 按局部键唯一/资源归属、无环角色目录引用、权限代数、角色唯一解析、条件类型/实际值、固定链与状态关系 |
| Command/Tool | 幂等历史、base_revision、稳定节点/风险升级、组件属性和字段参数与实际登记关联、工具版本映射/权限/真实限流 |
| Migration | 稳定键唯一、步骤顺序、各摘要重算、已登记操作版本与参数Schema、完整历史链/终态、重试次数、检查点/令牌/回滚授权和数据恢复 |
| 发布四对象 | 跨对象摘要/身份相等、集合排序与按键唯一、完整事件链/环境前置、有效人工审批、签名验真、附件真实性与摘要、原子晋级/回滚 |

Command组件props与Migration args仅接受本版明示的有限静态结构；精确注册表二次校验仍是必需项。超出结构集合不能用自由JSON兜底。新增接受域须以新修订及测试审查。

原core的AppSpec完整入口仍会拒绝尚无实际Permission/Workflow依赖验证器的非空组合；这里增加结构文件不会放行它。后续必须真正接入依赖验证器才可宣称该组合完整闭合。

冻结c14n的M-4深嵌套差异继续独立OPEN。结构测试、c14n参考测试、真实集成、负责人验收分别报告，不把任何一个当作其他已完成。

## Kimi I-1/M-1 修复候选

本套件验证器现固定 [UUID剖面](../../../docs/superpowers/specs/2026-09-15-0a-5-uuid-profile-r1.md)：36字符、8-4-4-4-12 ASCII十六进制，允许大小写和nil，拒绝URN、花括号、空白和紧凑形式。第三方引擎也必须启用此格式断言；宿主默认uuid规则不能替代它。Schema迁入副本仍保持JSON约束不变，但本套件uuid格式行为已收紧。view.addNode组件名首字母改为大写，与ViewNode一致。

原core UUID分歧独立登记为 [Issue #8](https://github.com/wuyicn/KVVI-Builder/issues/8)，旧文件与证据未改。新增158固定用例后共1289条、6项验收测试；原Kimi结论保留，修复须由Kimi复验后关闭。
