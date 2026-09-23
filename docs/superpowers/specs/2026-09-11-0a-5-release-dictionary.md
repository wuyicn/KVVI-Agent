# 0A-5 发布四对象字段字典 r1（设计候选）

日期：2026-09-11。所属主方案：[D06/D07](2026-09-11-0a-5-meta-schemas-design.md)；来源核对：[AM/AA/PR/EB](2026-09-11-0a-5-source-audit.md)。依据为冻结 [PRD v1.11](../../PRD-AI无代码平台设计-v1.11.md) §7.2、§7.24、§7.28，摘要 `d517617a0c500713897e7d6c88b5894d4c802e6362ecf68631ba88776750993b`。本文件补充可审查的机器编码，所有 D06-R 编号均为**新增设计选择，待批准**；不是原文已经规定的键，也不是实现、签名验真、运行时发布或 0A 完成证据。

## 1. 通用读法与新增决定

四协议均只有 CLI `entry=record`，实际 JSON 根就是下列对象，不另套 `{record: ...}`。对象每个表列键均必现，除标记 `?` 的类型允许 JSON null 外一律不允许 null；本字典无可省略键。这里 `?` 只表示可 null，与共享字典 F02 表内用于表示可省略的记法不同；落地 Schema 必须按本段 required/null 规则，不能混读。每层对象均 `additionalProperties:false`，联合分支以鉴别键选择且不允许另一分支的键。数组不是集合通配符：下文分别规定顺序、唯一性和上下限。未另限长的 ID、文本沿用非空字符串；不在本字典暗设全局输入深度边界或改变冻结 c14n/M-4。

| 决定 | 本次选择及理由 |
| --- | --- |
| D06-R01 契约包 | `contract_set` 内嵌五种应用契约的规范化 spec，配完整 AssetRef 与协议版本；注册依赖和 ToolSpec 由固定引用离线解析。避免把可变审计外壳纳入内容身份 |
| D06-R02 两级摘要 | 精确投影包含 contract_set、四 Registry 与 Policy Ruleset；ToolSpec 作为运行依赖进入 artifact 摘要。集合排序规则见 §3；不改变 c14n 数组保序 |
| D06-R03 身份 | 审批人、审计主体和审批记录使用闭合内部引用；绝不增造 APPROVAL、USER、SBOM 等 AssetType |
| D06-R04 晋级流 | 每个环境/每次尝试分配新 promotion_id；失败后的新尝试从 PLANNED 开始。成功后允许追加回滚；失败回滚允许人工确认后重试，完整表见 §5 |
| D06-R05 首次发布 | DEVELOPMENT/TEST 首次发布可无旧制品，失败保持空环境；PRODUCTION 必须已有本环境验证过的旧制品，首次引导不在本候选的自动晋级接受域 |
| D06-R06 证据 | 九类证据封闭载荷，测试/dry-run 再按子类型区分；附件只用本地受控内容地址，不接受任意 URL。来源失败不得被其他来源通过覆盖 |
| D06-R07 签名 | sidecar 独立于四对象及其前像；本批只测 Fake 绑定与拒绝，真实 Ed25519 配置和验真另验；真实权限与人工意愿不能从 JSON 推断 |
| D06-R08 兼容与 SBOM | 兼容版本采用有限个精确 SemVer，不支持范围语言；轻量 SBOM 逐项固定文件摘要与许可证声明，不是许可证真实性或完整软件供应链验收 |

通用类型：`Id`=common StableId；`Uuid`=有效 UUID 字符串；`Digest`=common `^sha256:[0-9a-f]{64}$`；`UInt`=0..9007199254740991；`PosInt`=1..9007199254740991；`Time`=有效 UTC RFC3339（Z，秒及可选小数）；`Profile`=常量 `kvvi-json-c14n/v1`；`SemVer`=三个无前导零的非负整数点分文本，仅 `major.minor.patch`，无范围、前缀、预发布/构建段。`Text`=1..4096 Unicode 标量；`Code`=`^[A-Za-z][A-Za-z0-9_.-]{0,127}$`。长度/版本语法是新增选择。

`AssetRef` 八键及枚举逐字复用新 common：`scope_type`∈TENANT/TEMPLATE/PLATFORM_CONTROL、`scope_id:Id`、`app_id:Id?`、`module_id:Id?`、`asset_type` 为既有枚举、`asset_id:Id`、`version:PosInt`、`digest:Digest`。不得因为引用槽受限而省略任一键。CapabilityRef 仍保留 common 原定义；本字典没有直接 CapabilityRef 槽。

以下内部对象同样闭合，不是新增公开协议，不算第十四份，也不是可自行登记的新资产类型。

| 内部类型 | 完整键与约束 |
| --- | --- |
| PrincipalRef | `scope_id:Id, principal_id:Uuid`；仅可信主体登记表解析，不携带角色、权限或密钥 |
| AuditStamp | `actor:PrincipalRef, recorded_at:Time, trace_id:Id`；服务端注入；不复用 RegisteredContract 审批生命周期 |
| AttestationRef | `attestation_digest:Digest`；逐字采用共享 F02，精确按摘要查找，禁止仅 ID、latest 或 AssetRef 冒充 |
| EvidenceRef | `evidence_id:Uuid, record_digest:Digest`；精确查找，不以附件摘要代替记录摘要 |
| PromotionRef | `promotion_id:Uuid, sequence:PosInt, record_digest:Digest`；固定某一事件 |
| AttachmentRef | `content:ContentBinding, byte_length:UInt`；content 逐字采用共享 F02 三键 `content_id:Id,digest:Digest,media_type:enum`，media_type 仅 application/json、text/plain、application/pdf、image/png；digest 是原始附件字节 SHA-256，不做 JSON 重序列化 |
| StructuredError | `code:Code, category:enum(RETRYABLE,MANUAL_REQUIRED,FATAL), message:Text`；禁止原始堆栈、连接串、凭据或自由 details 对象 |

AttachmentRef 的内容由可信上下文按 digest 定位，拒绝路径穿越、远程抓取或根据实例指示读任意本地文件。缺内容、大小不符或摘要不符均拒绝 complete 检查。结构通过不能证明日志真实、无敏感内容或 PDF 展示正确；R 层另做受控采集和脱敏。

## 2. ArtifactManifest：完整根与嵌套字典

| 根键 | 类型 / 内容 | 来源 |
| --- | --- | --- |
| contract_version | 常量 artifact-manifest/v1alpha1 | PRD 协议号；键编码 D06-R01 |
| canonicalization_profile | Profile | PRD |
| app_ref | AssetRef，asset_type=APP_SPEC | D06-R01，固定唯一发布应用 |
| contract_set | ContractEntry[1..10000] | PRD 契约包；形状/数量 D06-R01 |
| registry_refs | RegistryRefs | PRD 四 Registry；键 D06-R02 |
| policy_ruleset_ref | AssetRef，asset_type=POLICY_RULESET | PRD；键 D06-R02 |
| contract_set_digest | Digest | PRD |
| compiler_requirements | Compatibility | PRD；编码 D06-R08 |
| runtime_requirements | Compatibility | PRD；编码 D06-R08 |
| app_context_graph | GraphSnapshot | PRD §7.28；编码 D06-R01 |
| runtime_tool_refs | AssetRef[0..10000]，asset_type=TOOL_SPEC | PRD §7.28；键 D06-R01 |
| migration_plan_refs | AssetRef[0..1000]，asset_type=MIGRATION_PLAN | PRD；键/数量 D06-R01 |
| sbom | SbomEntry[0..10000] | PRD §7.28；编码 D06-R08 |
| artifact_digest | Digest | PRD |

| 嵌套对象 | 完整键与分支 |
| --- | --- |
| ContractEntry | `asset_ref:AssetRef, contract_version:enum, spec:对应已有协议 Spec 入口`；配对只允许 BUSINESS_SCHEMA/business-schema/v1、VIEW_SCHEMA/view-schema/lce-safe-v1、APP_SPEC/app-spec/v1alpha1、WORKFLOW/workflow-spec/v1alpha1、PERMISSION/permission-spec/v1alpha1。spec 逐键完全复用相应协议，不能以自由 object/true 接收 |
| RegistryRefs | `field_type:AssetRef(FIELD_TYPE_REGISTRY), component:AssetRef(COMPONENT_REGISTRY), material:AssetRef(MATERIAL_REGISTRY), capability:AssetRef(CAPABILITY_REGISTRY)` |
| Compatibility | `implementation_code:Code, accepted_versions:SemVer[1..100]`；版本必须唯一且按 major/minor/patch 数值升序，运行时选择结果属于执行上下文，禁止回填 Manifest |
| GraphSnapshot | `snapshot_id:Uuid, digest:Digest`；digest 为受控 AppContextGraph 规范化快照正文摘要。该图按既有图规则重建及比对，不是新资产引用或第十四个协议 |
| SbomEntry | `component_id:Code, version:Text, content_digest:Digest, license:LicenseDeclaration`；唯一键 component_id+version，按两字符串 UTF-8 元组升序 |
| LicenseDeclaration | `kind:enum(SPDX,LICENSE_REF), identifier:Code, text_attachment:AttachmentRef?`；SPDX 时 text_attachment=null，identifier 在可信许可证 ID 登记表；LICENSE_REF 时 identifier 以 LicenseRef- 开头且附件非 null、content.media_type=text/plain |

数量上限是本修订设计预算，不是原 PRD 的既有产品限制。清单为空仅表示精确闭包没有此类依赖；不得用空数组绕过实际依赖扫描。SBOM 必须覆盖已解析运行材料、适配器和编译产物依赖；缺项即 complete 拒绝，不能以未接入扫描器为零依赖。运行依赖 ToolSpec 精确解析完整 W2 可信契约，运行工具只能来自可信登记为 USER_GATEWAY 的 ToolSpec；生成期 Builder 工具在 §6 溯源中。

`contract_set` 只包含当前应用的五类业务/组合契约正文。每条 `asset_ref.digest` 必须等于 c14n(spec) 摘要且精确解析到同版本已登记契约；`contract_version` 必须匹配该资产真实协议，不能只信资产类型。该选择不把 ToolSpec 正文与应用 spec 混合：运行 ToolSpec 固定依赖由 `runtime_tool_refs` 进入完整 artifact 摘要，生成工具不会改变制品身份。`app_ref` 在集合中恰好命中一条 APP_SPEC；跨应用受控外部资产允许进入依赖闭包，但不得造成第二个发布根。

引用闭包必须实际解析各 Spec、Registry、Policy、ToolSpec、图和迁移计划。AppSpec 的非空 Workflow/Permission 必须调用 W1 validator；资产作用域与固定引用的统一错误码沿用 §7.27。缺依赖正文/校验器是失败，不能把 Registry AssetRef 形式正确当成内容正确。图 snapshot_id 只是内部定位，图 digest 与按已固定输入重建的快照必须相等；快照包含的生成期审计信息不得偷偷成为改变应用语义的依赖。

## 3. 精确摘要算法与迁移接口

令 `H(x)="sha256:"+hex(SHA256(c14n_v1(x)))`。所有值从已通过 profile/结构检查的对象提取；不做 Unicode 归一化、trim、摘要大小写修正或填默认值。只对明确集合做下述排序，不能递归排序所有数组。

定义 AssetRef 元组 `K(r)=(asset_type,scope_type,scope_id,app_id,module_id,asset_id,version,digest)`。字符串按 UTF-8 字节比较，null 严格在字符串之前，version 数值比较；CapabilityRef 若被对应协议内部使用，身份分量为 capability_code，仍遵守 PRD 同元组规则。contract_set 按每条 asset_ref 的 K 升序；runtime_tool_refs/migration_plan_refs 按 K 升序。输入已经排序才接受，拒绝乱序而非在验证时静默改写输入；生成端在冻结前排序。

同一引用完整元组重复拒绝；同一身份 `(asset_type,scope_type,scope_id,app_id,module_id,asset_id)` 出现多个 version 或 digest 也拒绝，防止同包并存相互冲突版本。契约 spec 内的 states、transitions、子节点等数组保持其原有顺序，不套用集合规则。

**D06-R02 精确投影 P** 是且仅是三键对象：

```json
{
  "contract_set": "Manifest.contract_set 的已排序原数组（实际值是数组）",
  "registry_refs": "Manifest.registry_refs 的完整四键对象（实际值是对象）",
  "policy_ruleset_ref": "Manifest.policy_ruleset_ref 的完整 AssetRef（实际值是对象）"
}
```

上段仅为字段映射说明，字符串说明文字不是合法实例或前像值。机器定义是 `P={contract_set:M.contract_set,registry_refs:M.registry_refs,policy_ruleset_ref:M.policy_ruleset_ref}`，无其他键。Policy Ruleset 作为固定 PolicyRegistry 规则快照纳入 P，是本次明确选择；四个 Registry 不另转数组。`contract_set_digest=H(P)`。排除 app_ref、contract_set_digest、本身 profile 字段、迁移列表、运行 ToolSpec 引用、兼容要求、图、SBOM、artifact_digest、外签名；profile 用于选定 H。app_ref 已由 contract_set 的 APP_SPEC 锁定，其独立字段仍进入 artifact 前像。

`artifact_digest=H(M 删除且仅删除根 artifact_digest)`；该前像保留根 contract_version/profile、全部固定依赖以及计算好的 contract_set_digest。因此同样 contract_set 加入不同图/运行工具/计划将产生不同 artifact_digest，审批不得沿用旧 artifact 摘要。

与 W3 的接口固定如下，不依赖计划操作 args 的内部设计：

1. 先生成并校验目标五类契约、Registry/Policy，计算 P 和 contract_set_digest。
2. 每份正向 MigrationPlan 必须有 `plan.target_contract_set_digest=M.contract_set_digest`，`plan.base_artifact_digest` 非 null且指向精确前一制品，沿用 W3 的 MD03 新选择；首次空环境只能使用无需迁移且 migration_plan_refs=[] 的 Manifest，bootstrap 迁移未获此候选接受域支持；计划内禁止目标 artifact_digest。
3. `migration_plan_refs[i].asset_id=plan.migration_id`、`.digest=plan.plan_digest`，version 是可信迁移登记表正整数；不是计划 protocol_version/语义版本。scope/app/module 仍逐键核对登记来源；Ref 缺键不能补默认值。
4. 所有 Manifest 迁移引用均指向目标为该 Manifest.contract_set_digest 的计划。逆向恢复采用这些不可变计划内已登记、已批准的补偿/恢复步骤；不把 target 为旧包的独立计划混入新包清单，也不修改旧 Manifest 补计划。这是 D06-R02 的新增无环选择。
5. `plan_digest` 先于 artifact_digest；MigrationRunEvent 的 artifact_digest 始终绑定该计划所在的新 Manifest。回滚执行同计划内已批准逆向步骤，事件达到 ROLLED_BACK，表示恢复 base_artifact_digest，而不是新产生一份以旧 Manifest 为目标的正向运行。PromotionRecord 的回滚目标是旧 Manifest；其 migration_plan_refs 是原候选清单的精确子集。
6. Manifest 本身无环境/base_artifact 字段；执行前以目标环境当前激活摘要与正向 plan.base_artifact_digest 逐一核对。有迁移依赖但空 migration_plan_refs 不合法。无迁移时空数组合法且不产生虚构迁移事件。

同一 MIGRATION_PLAN AssetRef 的 plan_digest 同时锁定正向步骤及固定补偿/恢复（逆向）步骤；Manifest.migration_plan_refs 因而承载 PRD §7.28 的迁移/逆向计划内容，不把逆向要求删出验收范围。W3 必须证明该绑定完整覆盖数据变化的逆向定义、批准范围及 ROLLED_BACK 终态；如果独立审查认为“同一计划包含正逆步骤”不足以满足 §7.28，记为本设计阻断，补足无环的独立逆向计划引用方案后再批准，不能通过暗缩范围签收。真实发布遇到缺逆向内容或需临时生成/修改计划时失败关闭。

已成功迁移的原 migration_run_id 停在 SUCCEEDED 终态，不允许追加 ROLLING_BACK。成功发布后回滚须创建新 migration_run_id，由可信运行上下文将用途固定为仅执行该计划的已批准逆向步骤，禁止重新执行正向步骤；新流必须按 W3 的合法启动/恢复路径最终 ROLLED_BACK。晋级失败且原迁移尚非终态时，可按其已规定状态机恢复原流。W3 若没有定义新逆向运行的用途绑定和启动路径，本场景就是未关闭设计阻断，不能将终态出边或“假设执行成功”作为绕过。

## 4. ApprovalAttestation 与签名 sidecar

| 根键 | 类型 / 约束 |
| --- | --- |
| contract_version | 常量 approval-attestation/v1alpha1 |
| canonicalization_profile | Profile |
| attestation_id | Uuid，内部记录身份（D06-R03） |
| artifact_digest | Digest，精确解析被冻结 Manifest |
| approver | PrincipalRef |
| permission_version | PosInt，可信权限快照版本，不可由草稿自报 |
| approved_at | Time |
| decision | enum(APPROVE,REJECT)（D06-R03）；拒绝记录只能存档，不能满足批准前置条件 |
| opinion | Text?；null 表示没有补充意见，不等于默认批准 |
| presentation_ref | EvidenceRef；指向同一 artifact 的 APPROVAL_PRESENTATION 证据 |
| audit | AuditStamp；actor=approver，recorded_at>=approved_at |
| attestation_digest | Digest |

`attestation_digest=H(记录删除且仅删除根 attestation_digest)`，包括 contract_version/profile、展示证据和审计等新增不可变字段；签名位于外部，根不存在 signature 字段。同 attestation_id 内容改变拒绝；REJECT 后的 APPROVE 使用新的 attestation_id，不覆盖旧记录。

可信 complete 上下文需提供精确主体/权限版本/资产 scope 的审批资格、制品创建人和风险结论。高风险创建人不得审批；签名服务主体不替代人工 approver；presentation 证据必须由同 approver 观看同摘要 diff/impact/preview。过期、撤销、范围不符和拒绝审批不能因另有一条形式通过被忽略。审批时权限快照用于核对当时资格，晋级时还须 R 层重新确认当前发布权限；本对象不伪装实时权限结果。

**外部 sidecar 编码（D06-R07）**：闭合 `SignatureSidecar {subject_kind,subject_digest,signer,key_id,algorithm,signature_base64url,signed_at}`，全部必填非 null。subject_kind 为 ARTIFACT_MANIFEST/APPROVAL_ATTESTATION/PROMOTION_RECORD/EVIDENCE_BUNDLE；subject_digest:Digest；signer:PrincipalRef；key_id:Code（仅公钥登记号）；algorithm 常量 Ed25519；signature_base64url 是 64 字节签名的无 padding base64url（86 字符，解码再校验）；signed_at:Time。签名消息精确为 UTF-8 `KVVI-SIGNATURE-v1\n` + subject_kind + `\n` + subject_digest，不含尾随换行。信任根、公钥、吊销、用途和时效均由外部可信设施提供，不从被签对象或 sidecar 授权自己。

该 sidecar 是记录层外部传输约定，不占十三协议数，本次**不实现 Ed25519 或信任设施**。Fake 仅通过可信 context 的闭合登记项 `{subject_kind,subject_digest,signer,key_id,binding_valid:boolean}` 注入预置绑定结论，实例不得携带该布尔值，也不得选择信任模式。应分别输出 `signature_binding_checked=true, cryptographic_signature_verified=false, release_approved=false`；真实审批要求至少一条匹配审批人的有效真实签名，Fake 不能使真实审批通过。Manifest/事件/证据签名用途由各可信写入服务身份分别核验。

## 5. PromotionRecord：字段与完整状态机

| 根键 | 类型 / 约束 |
| --- | --- |
| contract_version | 常量 promotion-record/v1alpha1 |
| canonicalization_profile | Profile |
| promotion_id | Uuid，同一目标环境的一次晋级及其后续回滚流 |
| sequence | PosInt |
| previous_record_digest | Digest?；sequence=1 时 null，其他非 null |
| artifact_digest | Digest，原晋级候选身份，回滚事件仍保持它 |
| environment | enum(DEVELOPMENT,TEST,PRODUCTION) |
| config_binding | ConfigBinding |
| config_binding_digest | Digest |
| approval_attestation_refs | AttestationRef[1..100]；按 attestation_digest UTF-8 升序，摘要唯一 |
| predecessor_environment_ref | PromotionRef?；DEVELOPMENT=null，TEST/PRODUCTION 分别指向 DEVELOPMENT/TEST 的 SUCCEEDED 事件 |
| rollback_target | RollbackTarget?；在 PLANNED 固定，在后续事件不得改变 |
| event_type | enum(PLANNED,STARTED,SUCCEEDED,FAILED,ROLLBACK_STARTED,ROLLED_BACK,ROLLBACK_FAILED) |
| result | PromotionResult?；条件见下表 |
| error | StructuredError?；条件见下表 |
| audit | AuditStamp |
| record_digest | Digest |

| 嵌套对象 | 完整键与约束 |
| --- | --- |
| ConfigBinding | `bindings:ConfigRef[0..1000]`；按 binding_code UTF-8 升序且唯一。空数组须有可信环境无必需配置证据 |
| ConfigRef | `binding_code:Code, reference_code:Code, reference_version:PosInt`；全部是受控配置引用，禁止 value、URL、密钥值。只对引用配置登记快照做版本核对，不哈希密钥值 |
| RollbackTarget | `artifact_digest:Digest, verified_promotion_ref:PromotionRef, approval_attestation_refs:AttestationRef[1..100], config_binding:ConfigBinding, config_binding_digest:Digest, migration_plan_refs:AssetRef[0..1000](MIGRATION_PLAN)`；固定旧包、其已验证历史、恢复配置与已批准逆向步骤所依附的原候选计划。migration_plan_refs 必须是根 artifact 对应 Manifest 清单的精确子集，各计划 base_artifact_digest=本目标旧包；审批引用排序同根 |
| PromotionResult | `active_artifact_digest:Digest?, migration_run_refs:MigrationRunRef[0..1000]`；禁止测试 PASS、监控报告或任意 details |
| MigrationRunRef | `migration_run_id:Uuid, sequence:PosInt, record_digest:Digest`；精确绑定对应 W3 事件；成功/回滚成功所需终态见转换表，按 migration_run_id UTF-8 升序，ID 唯一 |

`config_binding_digest=H(config_binding)`（回滚 target 内同样计算）；`record_digest=H(记录删除且仅删除根 record_digest)`。同 promotion_id 的 profile、artifact、environment、config binding、审批引用、predecessor_environment_ref、rollback_target 均必须与首条完全相同；允许变化仅 sequence/previous/event/result/error/audit/record_digest。时间不得倒退。不同环境必须不同 promotion_id；一次 FAILED 后不能以同 ID 重开 STARTED。

表中 `old` 表示 rollback_target.artifact_digest；target=null 时 old=null，null 表示可信登记的空环境。目标必须是本环境在开始时当前活跃的前一制品，且曾验证成功；不能选择任意历史成功包、其他环境包、当前候选或重新生成的包。verified_promotion_ref 必须指向同环境 SUCCEEDED 且 artifact=old；context 的环境历史还必须证明当前仍为 old。回滚的审批引用批准 old，根审批引用批准候选，两者不可互换。PRODUCTION target=null 失败关闭。

| 当前事件 | 唯一允许后继 | 后继 result/error | 前置/结果约束 |
| --- | --- | --- | --- |
| 无（流起点） | PLANNED | null/null | sequence=1、previous=null；冻结、展示、批准已齐全；三环境顺序和当前 old 已核实 |
| PLANNED | STARTED | null/null | 序号/前链正确；受控配置可解析；仍满足审批/环境前置 |
| PLANNED | FAILED | 非 null/非 null | 启动前鉴权、配置等失败；active=old；migration_run_refs=[] |
| STARTED | SUCCEEDED | 非 null/null | active=候选；必要迁移全部 SUCCEEDED，清理 DEFERRED 证据满足 W3；无迁移 refs=[] |
| STARTED | FAILED | 非 null/非 null | 原子失败保持 old；迁移引用若存在固定最新已验证事件，可为需恢复的非终态，但不能证明部分新包已激活；FAILED 只证明晋级失败，不代表迁移恢复完成 |
| SUCCEEDED | ROLLBACK_STARTED | null/null | old 非 null，候选仍是本环境当前 active；旧包批准、配置与逆向步骤有效；监控失败只在 Evidence 中 |
| FAILED | ROLLBACK_STARTED | null/null | old 非 null，需执行已批准数据恢复或确认旧包激活；不能把 null 当虚构旧包 |
| ROLLBACK_STARTED | ROLLED_BACK | 非 null/null | active=old，必要原候选迁移运行终态 ROLLED_BACK（plan.base_artifact_digest=old，事件仍绑定原候选）；无逆向则 refs=[] |
| ROLLBACK_STARTED | ROLLBACK_FAILED | 非 null/非 null | active 必须等于可信环境激活历史的候选或 old；不得填第三包或在已有 old 时填 null；保留恢复失败事实 |
| ROLLBACK_FAILED | ROLLBACK_STARTED | null/null | 仅新的人工恢复授权已在可信 context 登记且旧目标不变；自动无限重试不在此契约内 |
| ROLLED_BACK | 无 | — | 终态，不得续写；再次晋级分配新 promotion_id |

表外全部组合拒绝，包括直接 PLANNED→SUCCEEDED、FAILED→STARTED、SUCCEEDED→FAILED、跨环境复用 ID、ROLLED_BACK→STARTED。SUCCEEDED 可无后继并作为成功结果；FAILED 可无后继并作为失败结果；ROLLED_BACK 为严格终态。ROLLBACK_FAILED 不能被改写为失败未发生；后续恢复必须保留其事件。PLANNED/STARTED/ROLLBACK_STARTED 都不得携带 result 或 error；只有失败三分支要求 error；其他 error=null。

TEST/PRODUCTION 的 predecessor_environment_ref 必须引用同 artifact、正确直接前环境的成功事件；同时完整上下文证明此前环境对该 artifact 所需证据已齐全、没有阻断且当前未被回滚/取代。仅有历史 SUCCEEDED 记录不足以证明仍满足前置。DEVELOPMENT/TEST 首次失败允许 active=null，此时无合法回滚目标，不能进入 ROLLBACK_STARTED；受控重新尝试用新 promotion_id。

并发控制、实际原子激活、租约/锁、真实密钥解析与批准逆向执行属于 R；Fake 仅核对预置当前环境/事件流/运行终态。不得以本表定义为已实现发布执行器。

## 6. EvidenceBundle：根、每类封闭载荷与附件

| 根键 | 类型 / 约束 |
| --- | --- |
| contract_version | 常量 evidence-bundle/v1alpha1 |
| canonicalization_profile | Profile |
| evidence_id | Uuid；同 ID 内容不可重写 |
| artifact_digest | Digest；每条均精确解析同一冻结 Manifest |
| evidence_type | enum(TEST_REPORT,DRY_RUN,POLICY_REPORT,IMPACT_REPORT,APPROVAL_PRESENTATION,LOG_REPORT,RECOVERY_DRILL,MONITOR_REPORT,GENERATION_PROVENANCE) |
| environment | enum(DEVELOPMENT,TEST,PRODUCTION)?；生成溯源/影响报告/审批展示允许 null，其余必须非 null |
| promotion_ref | PromotionRef?；非 null 必须同 artifact/environment，只定位证据来源，不能承载环境状态变更 |
| producer | Producer |
| observed_at | Time |
| payload | 对应 evidence_type 的唯一闭合对象，字段见下表 |
| attachments | AttachmentRef[1..1000]；按 content.content_id UTF-8 升序，ID 唯一 |
| audit | AuditStamp |
| record_digest | Digest |

Producer 全部键：`source_id:Code, run_id:Uuid, method_version:Text, execution_kind:enum(FAKE,REFERENCE,INTEGRATION), dataset_kind:enum(SYNTHETIC,NONE)`。phase 0 没有 REAL_CUSTOMER/PRODUCTION_DATA 分支；execution_kind 由可信上下文核对，实例自报不能升级证据级别。`record_digest=H(记录删除且仅删除根 record_digest)`，附件引用被纳入摘要，实际附件 bytes 以各自 digest 绑定。

下表所有载荷键必现；`AttachmentId` 是 content.content_id 的 Id，必须在根 attachments 中恰好解析一项；每个根附件必须被该 payload 引用，禁止夹带无关数据。每个类型必须附相应完整报告，不以汇总数代替来源文件；数字均为 UInt，不使用浮点。

| evidence_type | payload 的完整键、类型及闭合子项 |
| --- | --- |
| TEST_REPORT | `test_kind:enum(BASELINE,GOLDEN,SECURITY_NEGATIVE,INTEGRATION,PERMISSION_NEGATIVE,PERFORMANCE), suite_code:Code, suite_version:Text, passed:UInt, failed:UInt, skipped:UInt, outcome:enum(PASS,FAIL,INCOMPLETE), report_attachment_id:AttachmentId`；总数>=1；PASS 要求 failed=skipped=0；FAIL 要求 failed>0；INCOMPLETE 要求 failed=0 且 skipped>0 |
| DRY_RUN | `run_kind:enum(DATA_MIGRATION,PERMISSION,PERFORMANCE), migration_plan_ref:AssetRef(MIGRATION_PLAN)?, affected_record_count:UInt, outcome:enum(PASS,FAIL,INCOMPLETE), report_attachment_id:AttachmentId`；DATA_MIGRATION 引用非 null且在 Manifest 计划清单，其他 null；只有 DATA_MIGRATION 可有非零 affected_record_count；合成计数不能宣称生产预估 |
| POLICY_REPORT | `policy_ruleset_ref:AssetRef(POLICY_RULESET), findings:PolicyFinding[0..10000], outcome:enum(PASS,FAIL), report_attachment_id:AttachmentId`；引用与 Manifest 完全相同；存在 ERROR/BLOCKER 则 FAIL，否则 PASS |
| IMPACT_REPORT | `app_context_graph_digest:Digest, base_artifact_digest:Digest?, change_count:UInt, impacted_refs:AssetRef[0..10000], risk:enum(LOW,MEDIUM,HIGH), report_attachment_id:AttachmentId`；图摘要等于 Manifest；impacted_refs 按 K 排序唯一，base 非 null 必须精确解析；风险由可信差异规则核对 |
| APPROVAL_PRESENTATION | `presented_to:PrincipalRef, presented_at:Time, impact_report_ref:EvidenceRef, diff_attachment_id:AttachmentId, preview_attachment_id:AttachmentId, presentation_attachment_id:AttachmentId`；impact 证据同 artifact；表示服务端记录展示行为，不是批准/签名；三个附件 ID 互异 |
| LOG_REPORT | `log_kind:enum(BUILD,VALIDATION,MIGRATION,RECOVERY), started_at:Time, ended_at:Time, entry_count:UInt, report_attachment_id:AttachmentId`；end>=start；完整日志经受控脱敏，执行结果不在此任意增字段 |
| RECOVERY_DRILL | `scenario_code:Code, target_artifact_digest:Digest, outcome:enum(PASS,FAIL,INCOMPLETE), recovery_duration_ms:UInt?, report_attachment_id:AttachmentId`；PASS 时 duration 非 null，其他可 null；target 必须精确解析且为同环境曾验证旧包，非真实回滚事件 |
| MONITOR_REPORT | `window_start:Time, window_end:Time, checks:MonitorCheck[1..10000], outcome:enum(PASS,FAIL,INCOMPLETE), report_attachment_id:AttachmentId`；end>=start；任一 check FAIL 则 FAIL，无 FAIL但有 INCOMPLETE则 INCOMPLETE，全部 PASS才 PASS；必须非 null promotion_ref |
| GENERATION_PROVENANCE | `builder_tool_refs:AssetRef[0..1000](TOOL_SPEC), prompts:PromptProvenance[0..1000], models:ModelProvenance[0..1000], pipeline_code:Code, pipeline_version:Text, compiler_code:Code, compiler_version:SemVer, source_snapshot_digest:Digest, report_attachment_id:AttachmentId`；Builder ToolSpec 必须可信登记为 BUILDER_GATEWAY，按 K 排序唯一；人工来源可无模型/Prompt/Builder 工具；AI 来源声明见附件并与可信运行记录核对，不能以空列表隐藏真实使用 |

上表固定为九类，不接受其他 evidence_type 或任意报告 object。生成溯源环境固定 null且 promotion_ref=null；ImpactReport/ApprovalPresentation 可服务跨环境审批，但 promotion_ref 非 null 时 environment 必须非 null且匹配。无 promotion_ref 的非空 environment 只说明测试/采集环境，不证明发生晋级。

| 载荷子对象 | 完整键与约束 |
| --- | --- |
| PolicyFinding | `rule_code:Code, rule_version:PosInt, severity:enum(INFO,WARNING,ERROR,BLOCKER), subject_ref:AssetRef, message:Text`；规则/版本/严重性与 Manifest 指向可信 PolicyRegistry 对齐，不允许 AI 自降级；按 rule_code、rule_version、subject_ref 的 K 排序；同规则+目标不重复 |
| MonitorCheck | `check_code:Code, observed_value:UInt?, threshold_value:UInt?, unit:enum(COUNT,MILLISECONDS,BASIS_POINTS,BOOLEAN), outcome:enum(PASS,FAIL,INCOMPLETE)`；check_code 唯一且排序；INCOMPLETE 可空，否则数值均非 null；BOOLEAN 仅0/1，BASIS_POINTS仅0..10000；阈值判定规则由可信监控登记版本 producer.method_version 固定，不从实例选操作符 |
| PromptProvenance | `prompt_code:Code, version:Text, digest:Digest`；只存模板内容摘要，禁止真实输入正文；按 prompt_code/version UTF-8 排序唯一 |
| ModelProvenance | `provider_code:Code, model_code:Code, version:Text`；非浮动模型快照 ID，在可信运行源登记；按三字符串 UTF-8 排序唯一，不写令牌/供应商请求凭据 |

对于测试、dry-run 等附件，complete 至少核对内容可用、bytes/摘要、来源运行绑定；报告内部每个测试的真实性仍需测试系统独立证据，不以签名或摘要存在推导通过。Evidence 的 PASS、展示已发生、Policy 无阻断，均不能产生 ApprovalAttestation。相同 evidence_type 不同 producer 来源分别保存；只要当前要求的任一来源存在未关闭阻断/失败/缺项，另一个来源 PASS 不能抵销。

## 7. Fake 完整检查输入需求与验收矩阵

W0 统一 context 外壳，W4 不另发明文件路径、自动发现、网络读或实例自授权。逐字采用[共享 F03](2026-09-11-0a-5-shared-dictionary.md)的 `context_version/fixture_id/core_context/extension`；本节规定四对象 complete 的 `extension` 分支，以下所有字段必填，数组可以为空只表示可信快照确无对应项。缺数组不能默认为空；已有 core_context 的资产、作用域与登记权限规则仍完整运行。

| extension 键 | 类型 / 必需来源 |
| --- | --- |
| manifest_records | ArtifactManifest[]；按 artifact_digest 精确索引，须含本次待查包及引用旧包 |
| attestations | ApprovalAttestation[]；按 attestation_digest 索引，保留拒绝记录，不能覆盖旧版本 |
| evidence_records | EvidenceBundle[]；按 evidence_id+record_digest 索引，保留独立来源 |
| event_prefixes | PromotionPrefix[]；`{promotion_id:Uuid,records:PromotionRecord[]}`，连续全前缀，不能只给最后一条；新流也须有记录为空的明确条目 |
| content_resources | ContentResource[]；`{binding:ContentBinding,bytes_base64:string}`，规范 padded base64，解码后核验 binding.digest；仅合成附件。原始 bytes 损坏属 F03 工具依赖错误，实例错引属协议拒绝 |
| signature_bindings | §4 闭合 Fake 签名绑定项[]；信任模式由调用入口固定，实例不能选择 |
| environment_snapshots | EnvironmentSnapshot[]；见下方，要求实际目标应用的三环境显式快照，空环境使用 null |
| config_registry | EnvironmentConfig[]；`{environment:环境枚举,app_ref:AssetRef(APP_SPEC),bindings:ConfigRef[]}`，仅配置代码/版本登记，无密钥值 |
| approval_context | ApprovalContext；见下方，权限快照与制品风险/创建人来源 |
| graph_snapshots | GraphSource[]；`{snapshot_id:Uuid,content:ContentBinding,reconstructed_digest:Digest}`；content 指向快照原文，H(解析后的图正文)=Manifest 图 digest=可信重建摘要；内容 bytes 的摘要与图规范化摘要不混用 |
| generation_records | GenerationSource[]；`{artifact_digest:Digest,producer:Producer,payload:GENERATION_PROVENANCE对应载荷}`；独立生成运行来源，不能以待测 Evidence 自己证明自己 |
| required_evidence | EvidenceRequirement[]；见下方，必需类型/子类型/独立来源由 fixture 预先固定 |
| recovery_authorizations | RecoveryAuthorization[]；`{promotion_id:Uuid,after_sequence:PosInt,authorized_by:PrincipalRef,permission_version:PosInt,authorized_at:Time}`；ROLLBACK_FAILED 再次恢复必须有匹配序号的独立人工授权记录 |
| migration_context | W3 的完整受控迁移 context 分支；由 W3 字典定义逐键形状，不接收自由 object；含实际解析的计划、操作注册与事件前缀；无迁移仍使用 W3 明确的空来源表示 |
| tool_context | W2 的完整受控 ToolSpec context 分支；由 W2 字典定义逐键形状，不接收自由 object；需要核对 runtime/Builder 工具网关、版本和适配器摘要 |

`EnvironmentSnapshot` 全键：`{environment:环境枚举,app_ref:AssetRef(APP_SPEC),current_artifact_digest:Digest或null,observed_at:Time}`。快照必须与完整历史当前态一致；空数组或不存在的快照不等于首次部署。历史 SUCCEEDED 后若被回滚或取代，不能继续拿它满足跨环境前置。

`ApprovalContext` 全键：`{permission_snapshots:PermissionGrant[],artifact_policies:ArtifactPolicy[]}`。PermissionGrant 全键：`{principal:PrincipalRef,permission_version:PosInt,app_ref:AssetRef(APP_SPEC),actions:enum(APPROVE,PROMOTE,ROLLBACK)[],valid_from:Time,valid_until:Time或null,revoked:boolean}`；动作唯一，可信版本和时效按审批/晋级对应时间核对。ArtifactPolicy 全键：`{artifact_digest:Digest,created_by:PrincipalRef,risk:enum(LOW,MEDIUM,HIGH)}`；未提供风险结论不默认 LOW。

`EvidenceRequirement` 全键：`{environment:环境枚举,evidence_type:§6枚举,subtype:Code或null,source_id:Code,execution_kind:enum(FAKE,REFERENCE,INTEGRATION)}`。subtype 对 TEST_REPORT/DRY_RUN 是已登记 test_kind/run_kind，其他固定 null；同 requirement 元组唯一。phase 0 的合成测试 fixture 可以要求 FAKE，但不得由待测实例把 INTEGRATION 改成 FAKE。完整性检查必须涵盖 PRD 对应环境基础/集成/权限负向/迁移/恢复/Policy/展示要求；无迁移免除项由固定依赖事实决定，不能动态删要求。

数组均要求对应内部身份唯一；上下文顺序不是优先批准或覆盖规则。迁移与工具子上下文由各自包完整验证后注入，验证器缺失返回 DEPENDENCY_VALIDATOR_UNAVAILABLE；签收设计前 W0 必须与 W2/W3 物理 context 类型名称对齐，不能在实现时改为任意 JSON。该接口只声明资源来源，不实现可信服务或数据库存储。

新增诊断建议由 W0 集中编码后固定：摘要前像不符、集合乱序/重复、依赖正文缺失、审批记录不存在/拒绝/错包、事件断链/转移非法、环境前置不足、回滚目标未验证/非当前旧包、配置引用不符、附件缺失/摘要不符、证据来源不完整、签名绑定不符。这里不为同一种现有 AssetRef 错误另取别名；优先级遵循主方案 `c14n→structure→semantic→references/history`，同层遍历顺序由 W0 固定。

| 必需正例 | 对应反例/实际证明边界 |
| --- | --- |
| 五类契约含非空 Permission/Workflow 的 Manifest；无迁移合法包；有计划合法包 | 缺 W1 validator、未知嵌套键、错误 AssetType、引用缺任一键、假 spec 摘要、作用域外引用 |
| contract_set→plan→artifact 无环，各语言独立复算 | MigrationPlan 混入 P、自摘要入前像、profile 未知、排序 null/UTF-8/version 错、同身份双版本、图/SBOM/运行 ToolSpec 改动未改 artifact |
| APPROVE/REJECT 独立记录，Fake 有效绑定 | REJECT 用于晋级、APPROVAL AssetRef、审批错包/越权/创建人自审高风险、错展示证据、假的 binding 布尔写入实例 |
| 三环境不同 promotion_id 的完整成功链；首次空开发环境失败；有旧包回滚成功与失败恢复 | 同 ID 跨环境、sequence缺口/重复/错前链、PLANNED提前 result、成功跳步骤、首次null回滚、跨环境旧包、未验证旧包、PRODUCTION无旧目标、回滚后继续旧流 |
| 每种 evidence_type/子类型至少一例；摘要附件可复算 | 载荷类型错位、附件缺失/多余/错摘要、PASS与计数矛盾、Policy severity降级、Builder溯源写Manifest、Evidence混审批/晋级字段 |
| Fake 结果显式区分 structure/complete/signature binding | 不能宣称密码签名验真、当前人工批准、部署、日志真实或真实数据迁移 |

本次只新增设计文档，未创建机器 Schema、校验器、测试向量或执行器。冻结清单与参考套件复验由集成负责人统一记录；本文没有把历史测试计为本次执行结果。同一计划锁定正逆向内容对 §7.28 的充分性、首次 PRODUCTION 引导限制、ToolSpec 在 artifact 而不在契约集合投影、Policy Ruleset 纳入投影以及 sidecar 候选格式，均需与 W0/W3/W2 一起审查后才可实现。
