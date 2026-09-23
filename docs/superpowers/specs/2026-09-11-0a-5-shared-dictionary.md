# 0A-5 共享接口与验收字典 r1（候选）

本文为[主方案](2026-09-11-0a-5-meta-schemas-design.md)的 W0 候选接口；等待负责人设计批准，未实现。继承 PRD v1.11 与首批 common 的类型约束，新增决定均以 F 编号表示。

## F01 文件与调用入口

新 Schema 根目录 `contracts/meta-schemas/0a-full-r1/`，协议文件固定如下，common 之外恰好 13 个。

| 文件名 | --contract | --entry |
| --- | --- | --- |
| business-schema.v1.schema.json | business-schema/v1 | compiled-draft / spec / registered |
| view-schema.lce-safe-v1.schema.json | view-schema/lce-safe-v1 | compiled-draft / spec / registered |
| app-spec.v1alpha1.schema.json | app-spec/v1alpha1 | compiled-draft / spec / registered |
| permission-spec.v1alpha1.schema.json | permission-spec/v1alpha1 | compiled-draft / spec / registered |
| workflow-spec.v1alpha1.schema.json | workflow-spec/v1alpha1 | compiled-draft / spec / registered |
| app-model-command.v1alpha1.schema.json | app-model-command/v1alpha1 | command |
| tool-spec.v1alpha1.schema.json | tool-spec/v1alpha1（本次拟定） | registered |
| migration-plan.v1alpha1.schema.json | migration-plan/v1alpha1 | record |
| migration-run-event.v1alpha1.schema.json | migration-run-event/v1alpha1 | record |
| artifact-manifest.v1alpha1.schema.json | artifact-manifest/v1alpha1 | record |
| approval-attestation.v1alpha1.schema.json | approval-attestation/v1alpha1 | record |
| promotion-record.v1alpha1.schema.json | promotion-record/v1alpha1 | record |
| evidence-bundle.v1alpha1.schema.json | evidence-bundle/v1alpha1 | record |

两个新 CLI：`tools/meta-schema-full/0a-full-r1/python/cli.py` 与 `tools/meta-schema-full/0a-full-r1/node/cli.mjs`。参数保留 `--contract/--entry/--checks structure|complete/--context`，仅接受表中组合；不能用用户给出的任意 schema 路径或定义片段作公开入口。原始 UTF-8 从 stdin 读取，stdout 仅一个 JSON；0 有效、2 实例拒绝、1 执行故障。stage 取 canonicalization/structure/semantic/references/complete 或 execution；工具资源故障不得归为通过的协议反例。

每个语言独立提供以下纯函数；Python 名为 validate_structure/validate_semantic/validate_references，Node 为 validateStructure/validateSemantic/validateReferences，签名统一语义为 `(contract, entry, value, bundle[, context]) -> diagnostics[]`，其中 structure 不取 context，另两层必取。Bundle 已由本次调用加载器验证。dispatcher 顺序调用，在第一个有错误阶段停止。可变的缓存不能跨调用隐藏磁盘被篡改。

输出沿用 core-r1 的 suite_revision/entry/checks/input_sha256/validation/release_approved，新增协议统一 suite_revision=`0a-full-r1`；release_approved 恒 false。validation 中错误继续使用 code/severity/path/message/suggested_fix。任何 complete 成功只证明本套件承诺的结构及 Fake 静态/引用规则，不包含真实权限/审批/生产效果。

## F02 共享标量和封闭对象

AssetRef/CapabilityRef、整数、Digest、RegisteredBase、Audit 的约束从 core-r1 迁入而不放宽；只变更资源 URN。每个协议 `$defs.AssetRef` 直接引用 common 同名定义；每个使用动作/查询的协议也导出同样的 CapabilityRef 别名。八键完全必填，Digest 长度恰为71。

所有下列对象均关闭未知键；“?”表示可省略，其他键必填。null 只有明确写出的槽允许。字符串作为数据，不直接当 URL/SQL/JS/正则执行。日期/UUID 沿用 core-r1 的真实格式校验。新增候选公共定义：

| 定义 | 确切形状 | 语义 |
| --- | --- | --- |
| SchemaBinding | `{schema_id:非空字符串,digest:Digest}` | 仅 manifest 已登记本地 Schema ID；digest 对资源原始字节；不映射成 AssetRef |
| LocalRef | `{type:已登记局部类型,code:非空字符串}` | 必须由调用槽固定 type，并在已固定父资产内查 code |
| AttestationRef | `{attestation_digest:Digest}` | 审批记录以该摘要定位；非资产，不增加 AssetType |
| ContentBinding | `{content_id:非空字符串,digest:Digest,media_type:已登记媒体类型}` | 独立受控证据存储/Fake 内存资源；不接受远程 URL或系统路径 |

完整对象字典分别固定 LocalRef.type 与媒体类型枚举，不能运行时从待测对象声明一个新枚举；完整套件装载时核对未知 keyword/format/资源和所有未使用 `$defs`。F02 的定义是提案，若下游字典使用不同名字或形状，集中对齐后才可签收设计。

## F03 可信测试上下文

不让待测实例提供角色、审批身份、预期结果或 trust=true。`--context` 是调用方传入的独立 Fake 文件；新增协议层使用独立命名空间。共同必填外壳拟为 `{context_version:"0a-full-fake/v1",fixture_id:非空字符串,core_context:core-r1既有封闭上下文,extension:Extension}`。core_context 继续用既有格式校验，不复制/扩大其许可；迁入的首批检查使用该子对象。

Extension 按 contract 的 Schema 精确分支，包含下游字典实际使用的资源集合、历史前缀或草稿状态，不提供无类型自由对象。共享依赖项来自已核验文件/固定内存映射：assets、schema_resources、operations、attestations、manifest_records、event_prefixes、content_resources、draft_snapshot、permission_snapshot。**该名单是接口分区，不是“全部可任意缺省”的 context 定义**；每包字典须明确自己的字段及必需来源，资源内容二次按对应契约完整检查。

缺少本规则必需的历史/身份/注册表时不能假设首次发布、空历史或合法权限；返回既有 TRUSTED_CONTEXT_REQUIRED 或 DEPENDENCY_VALIDATOR_UNAVAILABLE。外部资源格式损坏/摘要不符属工具依赖错误退出1；实例的引用身份不匹配属协议拒绝退出2。Fake 可验证已登记签名绑定的摘要一致性，不证明签名密码学可信。

## F04 诊断与测试预期

原文固定码优先，复用旧码须保持旧含义。本次新码候选：`COMMAND_TYPE_INVALID`（未登记命令）、`COMMAND_ID_CONFLICT`（同ID不同规范化正文）、`DRAFT_REVISION_CONFLICT`（草稿版本不匹配）、`TOOL_SPEC_INVALID`（ToolSpec登记语义不合法）、`WORKFLOW_REFERENCE_INVALID`（局部状态/动作/固定链悬空）、`PERMISSION_POLICY_INVALID`（角色/四维声明非法）、`PROMOTION_EVENT_CHAIN_INVALID`（发布链断裂）、`PROMOTION_STATE_TRANSITION_INVALID`（事件次序非法）、`RELEASE_OBJECT_MISMATCH`（跨四对象摘要或归属不一致）。

六个迁移码按 PRD §7.11；ASSET_REF_INVALID/ASSET_TYPE_MISMATCH/ASSET_NOT_FOUND/ASSET_REF_OUT_OF_SCOPE/ASSET_DIGEST_MISMATCH 按 §7.27。未知属性沿用 UNKNOWN_PROPERTY，普通结构失败沿用 CONTRACT_SHAPE_INVALID；不能把模型草稿中的 SPEC_BODY_INVALID、ATTTESTATION_INVALID 等当冻结标准码。错误路径按 core-r1 规则排序并脱敏，不回显输入值。

每条 case 固定 id、protocol、entry、checks、input、context、expected_stage、expected_exit、expected_code/path。先由作者从规则写预期，独立评审后固定 inventory SHA-256，不能从任一 validator 的输出反推 expected。动态注册参数的 structure 通过不能替代 complete 反例。

## F05 三组回归不混用预期

1. **core原样回归**：旧Schema、入口、向量、预期和证据原字节；仍拒绝非空 Permission/Workflow 的未实现依赖。
2. **full迁入兼容回归**：对三份原契约的结构/其他既有规则验证；资源标识和 suite输出作显式映射，列出映射表。此组不得改旧预期源文件。
3. **full新增接受域**：独立新增测试证明真正合法的非空 Permission/Workflow 组合可通过；缺失/错误依赖仍拒绝。该有意扩展不能伪装成“全部与旧行为相同”。

本次设计阶段只实跑冻结清单与现有 c14n；上述全量工作是实现验收要求，尚未执行。M-4 继续独立开放，不用深度截断或错误改名回避。
