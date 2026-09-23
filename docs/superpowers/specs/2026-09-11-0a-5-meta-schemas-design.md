# 0A-5：13 份 Meta-Schema 补齐与 AI 分工方案 r1

状态：设计候选，待项目负责人审查；不构成实现验收或合并批准。日期：2026-09-11。

本次目标是完成 0A-5 的机器契约交付，不是完成整个 0A。依据为冻结 [PRD v1.11](../../PRD-AI无代码平台设计-v1.11.md)（SHA-256 `d517617a0c500713897e7d6c88b5894d4c802e6362ecf68631ba88776750993b`）、[Go-0 第五节](<../../../评审/Codex v1.11 复评.md>)和最新 `origin/main=a974ec72ed3c2491155be962745a50277008de6b`。

[首批方案 PR #2](https://github.com/wuyicn/KVVI-Builder/pull/2)及[实现 PR #3](https://github.com/wuyicn/KVVI-Builder/pull/3)均已合并。首批方案 §1 明确将其余十份留到后续；本文件是该后续方案，不能声称首批批准已覆盖本文新增机器化选择。原文逐项定位见[独立原文审计](2026-09-11-0a-5-source-audit.md)，调度及来源原文见[任务与 AI 台账](../../coordination/0a-5/README.md)。

本设计的候选字段附录：[W0 共享接口](2026-09-11-0a-5-shared-dictionary.md)、[W1 权限/流程](2026-09-11-0a-5-permission-workflow-dictionary.md)、[W2 命令/工具](2026-09-11-0a-5-command-tool-dictionary.md)、[W3 迁移](2026-09-11-0a-5-migration-dictionary.md)、[W4 发布四对象](2026-09-11-0a-5-release-dictionary.md)。这些附录具体化下文 D 决定；都是待审新设计，不是冻结 PRD 原文或机器文件。

## 1. 交付口径

**13 份指 13 个公开协议；common 是共享资源，不占协议名额。** 同一协议的 Spec、CompiledDraft、RegisteredContract 三个入口也只算一份。不存在 `release-envelope/*`、Automation 或 Integration 的额外协议。

| 编号 | 协议 | 当前代码状态 | 工作包 |
| --- | --- | --- | --- |
| 01 | `business-schema/v1` | core-r1 已合入，保留并回归 | W0 |
| 02 | `view-schema/lce-safe-v1` | core-r1 已合入，保留并回归 | W0 |
| 03 | `app-spec/v1alpha1` | core-r1 已合入；非空 Permission/Workflow 完整依赖尚不支持 | W0/W5 |
| 04 | `permission-spec/v1alpha1` | 待实现 | W1 |
| 05 | `workflow-spec/v1alpha1` | 待实现 | W1 |
| 06 | `app-model-command/v1alpha1` | 待实现 | W2 |
| 07 | ToolSpec（拟定 `tool-spec/v1alpha1`） | PRD 未固定版本字符串，须批准 D04 | W2 |
| 08 | `migration-plan/v1alpha1` | 待实现 | W3 |
| 09 | `migration-run-event/v1alpha1` | 待实现 | W3 |
| 10 | `artifact-manifest/v1alpha1` | 待实现 | W4 |
| 11 | `approval-attestation/v1alpha1` | 待实现 | W4 |
| 12 | `promotion-record/v1alpha1` | 待实现 | W4 |
| 13 | `evidence-bundle/v1alpha1` | 待实现 | W4 |

最终新套件为 13 份协议文件 + 1 份 common；manifest、注册表测试上下文、样例与机器证据另外计数。旧套件保持原字节，不以覆盖旧文件或改变旧证据补齐数量。

## 2. 方案比较与选用

| 方案 | 取舍 |
| --- | --- |
| 新完整套件 `0a-full-r1` + 共享引用 + 两语言独立校验 + 分包测试 | **推荐**。版本边界明确，可以接通 AppSpec 的两个非空依赖槽；保存 core-r1 原行为与证据 |
| 只另加十份孤立 JSON Schema | 文件能快速凑齐，但无法验证跨包引用、操作参数、摘要链及真实依赖；不足以关闭 0A-5 |
| 直接修改 `0a-core-r1` | 使首批证据与接受域漂移，不采用 |

复用现有 Draft 2020-12、Ajv 8.20.0、jsonschema 锁定依赖、诊断格式、原始字节输入和 c14n 参考套件。Python 不通过 Node 代验，Node 不通过 Python 代验；共享的是 Schema、合成 fixture 和事先固定的预期，不是语义函数执行结果。

## 3. 必须随设计审查的决定

### D01：新版本与共享资源

新目录 `contracts/meta-schemas/0a-full-r1/` 拥有独立 `$id` 命名空间 `urn:kvvi:meta-schema:0a-full-r1:*`、manifest 与证据。将已有三个 Schema 和 common 迁入新套件时，只调整套件 `$id/$ref`，保留内容约束；以删除标识差异后的结构比较与对应兼容向量证明既有规则未被意外改变。W0 F05明确分开core原样回归、full迁入兼容回归、full非空Permission/Workflow的有意扩展；不要求新行为继续返回旧DEPENDENCY_VALIDATOR_UNAVAILABLE。新功能只能在新套件接线。

所有协议导出 `$defs.AssetRef` 并直接引用唯一 common 定义；动作/查询引用导出并复用 `$defs.CapabilityRef`。八个键必现，空 app/module 使用 null；禁止新增 `SCHEMA`、`APPROVAL`、`USER` 等 AssetType。新通用内部结构可以放 common，但不能放宽 AssetRef。外部签名、审批记录身份、操作注册表内部 ID 不冒充 AssetRef。

### D02：Permission 与 Workflow 的最小外壳

两份契约沿用 core-r1 的三入口和 RegisteredBase/Audit，分别使用 `permission_id/workflow_id`。草案只能有 `contract_version/base_version/spec`；可信作用域、版本、审批字段不得从草案取得。

Permission 的 `roles/policies` 封闭到角色代码、目标 AssetRef、可空局部 `subresource {type,code}`、能力 CapabilityRef、允许/拒绝、四维权限固定枚举。字段策略冲突顺序与五档范围逐字遵循 PRD §3.5.3，不能使用 `DEPT` 等简称。角色必须存在，局部字段/节点必须存在于精确资源版本；无资源引用的权限策略拒绝。机器化字段名、数组上限与局部 type 枚举由 W1 的字段字典逐项列入本设计的补充审查，不能由代码作者暗定。

Workflow 的 states/transitions/approverRef/actions 对象逐层封闭；绑定 BusinessSchema AssetRef。单人审批与固定已登记审批链选择必须同时有合法例；未知状态、悬空动作、并行会签、动态拼接节点必须有反例。审批人/固定链是可信注册表内部身份，采用“固定资源引用 + 受限局部选择”的提案，不新增 AssetType。受限条件的字段、操作符、值类型及链身份格式需要 W1 字段字典明确后审查。运行时真正发审批、撤回和超时提醒不在本包执行。

### D03：Command 逐命令分支

根外壳固定为 PRD 示例的七键：`command_version/command_id/draft_id/base_revision/type/target_ref/args`。命令 ID、草稿 ID 沿用 UUID；revision 为非负安全整数。先覆盖 PRD §7.26 列出的 14 个命令：app.createModule、businessObject.create、field.add、field.changeConstraint、view.addNode、view.moveNode、view.bindField、navigation.addRoute、workflow.addTransition、permission.changeRolePolicy、draft.undoCommand、draft.redoCommand、draft.compile、draft.submitForApproval。

每个 type 必须有独立封闭 target_ref/args 分支；field.add 必须接收 PRD 原样示例中的 `field_type`，不能直接要求 BusinessSchema 的 `type` 字段。字段类型转换和正文生成属于后续编译器。复用 W1 的 transition/policy 参数定义，不重复发明另一种结构。禁止任意 JSON Patch、路径赋值、完整正式契约覆盖；即使无参数命令也要求 args 为封闭空对象。14 个分支逐一登记必填键、类型和正反例后才进入实现。

base_revision 冲突、command_id 内容不一致和相同命令重放可用 Fake 草稿上下文验证；事务原子性、真实命令日志写入与真正 undo/redo 执行仍另验。风险等级由可信注册语义得出，AI 不能靠传入 low 降低风险。

### D04：ToolSpec 及动态参数

拟定契约号 `tool-spec/v1alpha1`；PRD 未命名该协议版本字符串，该字符串是本次新增选择。ToolSpec 是平台可信登记契约，不是 Builder 可写的新增能力入口。除 §6.13 外必须落实 §7.29：语义工具版本与 AssetRef 正整数登记版本分层映射；gateway 仅 `USER_GATEWAY/BUILDER_GATEWAY`；风险仅 `READ/WRITE/STRUCTURE_CHANGE/RELEASE`；包含生命周期、实现适配器校验和、输入/输出 Meta-Schema 身份、错误码、超时、大小数量上限、所需权限/作用域、幂等重试、补偿恢复、速率、数据访问、确认/审批策略、审计事件和保留期。双人审批字段阶段 0 只记录不启用，不能新增执行能力。

工具输入/输出和迁移操作参数的 Schema 属于平台注册表内部机器资源，拟用闭合 `SchemaBinding {schema_id, digest}`，schema_id 只能解析到 manifest 登记的本地资源 ID，digest 绑定字节；禁止网络获取、自定义可执行关键字、未知 format、浮动版本。SchemaBinding 不替代跨契约 AssetRef，不是新资产类型。尚未绑定 Schema 的工具/操作一律失败，不允许 object/true 兜底。

User/Builder 工具分类必须由可信登记表核对，不能只验证实例自报 gateway。实际调用的 audience、三方身份绑定、重新鉴权和禁止网关互调属于独立运行时验收。本文不创建可执行工具或连接真实数据。

### D05：MigrationPlan 与 MigrationRunEvent

两种对象独立根入口 `record`，不用 Permission 的草案生命周期。计划包含 PRD §7.11 要求的所有字段及 step_id、phase、operation_code/version、args、前置条件、幂等键、检查点、超时、重试、补偿或人工恢复策略；登记操作 args 需二次应用绑定的封闭 Schema。只允许固定操作目录，无任意 SQL/DDL。计划字典还要覆盖 §7.11 的影响记录数、回填、索引、风险、备份点、验证查询和回滚条件，不能遗漏在正文摘要之外。

摘要顺序为 `contract_set_digest → plan_digest → artifact_digest`。target_contract_set_digest 覆盖目标契约及注册表，排除计划；计划禁止 target_artifact_digest。完整校验复算摘要并将计划与 Manifest 精确引用连接起来。不得把正确的摘要字符串格式当成摘要验证通过。

RunEvent 逐字段覆盖 PRD §7.11，第一条 sequence=1 且 previous_record_digest=null；后续连续递增并链接前条摘要。current_phase 与 run_status 分离；重试/暂停恢复不得跳阶段，三个终态无出边。CLEANUP 必须记录 DEFERRED 和待清理内容后才能 SUCCEEDED。原始恢复令牌不进入任何 fixture、日志或证据，只有虚构令牌摘要。

六个迁移错误码沿用原文。计划/事件状态、重试上限、补偿结果和摘要链以 Fake 历史验证；不运行 DDL、真实回填或迁移执行器。

### D06：发布四对象

四种对象独立 `record` 入口，均强制 `canonicalization_profile: kvvi-json-c14n/v1`；对象内部身份字段和签名绑定结构须在 W4 字典明确，不复用 AssetType 伪造审批资产。

ArtifactManifest 固定契约集合、contract_set_digest、编译器/Runtime 要求、四种 Registry AssetRef、Policy Ruleset AssetRef、MigrationPlan AssetRef 列表及 artifact_digest；无迁移可为空，不能把所有迁移引用永久固定为空。§7.28 追加要求 AppContextGraph 快照校验和、应用运行时依赖 ToolSpec 的完整 AssetRef、依赖/许可证轻量 SBOM。与 Registry 有关的跨对象引用必须使用完整 AssetRef。contract_set_digest 的完整投影和集合排序应逐项按 §7.2 落表，不得只说“哈希整个 JSON”。

ApprovalAttestation 固定被批准 artifact_digest、审批人、permission_version、时间、意见与 attestation_digest；签名作为独立 sidecar 绑定同一摘要。PromotionRecord 固定 PRD 的 promotion_id、sequence、previous_record_digest、目标环境、配置绑定摘要、approval_attestation_refs、event_type、结果/错误、回滚目标及 record_digest。PLANNED 不允许提前填执行结果，回滚事件必须引用实际目标 Manifest。EvidenceBundle 按 evidence_id 保存受限类型的测试/日志/恢复/监控证据及 record_digest；证据内容用闭合、可复核的摘要引用，禁止真实敏感日志与任意资源 URL。

EvidenceBundle 还承载 §7.28 的 Policy 结果、ImpactReport 及审批展示记录、dry-run、黄金样例、安全负向结果，以及生成期 Builder ToolSpec/Prompt/模型/生成链路版本溯源。生成溯源不能进入 Manifest 改变制品身份。Promotion 的环境只取 DEVELOPMENT/TEST/PRODUCTION；同摘要顺序晋级与回滚到本环境曾验证旧制品需要 Fake 历史证据，配置引用不能转入 Manifest。

四对象互相放错字段必须拒绝；Approval/Promotion/Evidence 必须解析同一 artifact_digest；Promotion 的每条审批引用也必须签该摘要。Fixture 可以有假的签名登记记录并验证摘要绑定，但不能冒称做了密码学签名验真、人工权限审批或生产发布验收。完整签名验真若要求纳入本次，需要另列具体算法、信任根和测试范围再审查。

### D07：校验层与接口

保持 `raw bytes → c14n → structure → semantic → references/history`。成功/实例拒绝/工具故障分别退出 0/2/1；工具超时和资源耗尽不能计为合法拒绝。结果恒含 `release_approved:false`。

新公开 CLI 保留 `--contract/--entry/--checks/--context` 形状，但从独立 full 套件入口调用；core CLI 不接受新增协议。Node/Python 分别导出同职责的纯验证函数，只有集成人能改公共 dispatcher。精确接口和 context 格式由 W0 固定，输入使用外部可信/Fake 上下文，实例不能自选信任模式或预期结果。

`structure` 只说明静态 Schema 合法。对动态 args、资产解析、状态/摘要、审批关联负责的 `complete` 检查，缺少注册表、前序事件、权限版本或依赖校验器就拒绝；不以 true 桩补洞。新 AppSpec complete 必须真正调用 Permission/Workflow validator。新协议专用错误码映射单列字典，不能沿用本地模型临时发明的代码。

### D08：已知边界与计数

冻结 c14n 继续只读调用，消费原共享向量，不在此改输入域。[M-4 issue #4](https://github.com/wuyicn/KVVI-Builder/issues/4)继续 OPEN；深嵌套差异不得计入一致性通过率或被新 suite 静默截断掩盖。结构自校验、Linter/Fake 完整检查、真实运行时验收必须分栏报告。

0A-5 完成要求为：13 协议机器文件和共享定义齐备、Schema 自校验、承诺的 Linter/Fake 覆盖、13×协议清单与测试/证据逐项绑定、独立审查无未关闭本次阻断、负责人批准。整个 0A 的 CRUD、权限运行时、编译预览等依然按其他任务验收。

## 4. 工作包、文件范围与依赖

| 包 | 作者 / 独立复核 | 拟独占文件范围 | 前置 / 验收 |
| --- | --- | --- | --- |
| W0 共享基础与接口 | Codex 集成；Qwen 9B 清单检查 | full/common、manifest、完整字段/错误码字典、full CLI/loader、context 契约、CI | 设计批准；14 资源唯一、全部本地引用可解析、旧套件字节不变 |
| W1 Permission + Workflow | Qwen 27B；Gemma 26B | full/permission-spec*、workflow-spec*；两语言 permission/workflow 模块；对应 tests/w1 | W0；角色/资源/局部引用、固定链和禁止复杂编排正反例 |
| W2 Command + ToolSpec | Qwen 27B；Gemma 26B | full/app-model-command*、tool-spec*；两语言 command/tool 模块；tests/w2 | W0 + W1 参数定义；14 命令逐分支、双网关分类和未登记 Schema 反例 |
| W3 迁移二对象 | Qwen 27B；独立 Codex 审查 | full/migration-plan*、migration-run-event*；两语言 migration 模块；tests/w3 | W0，联测等待 W4；无环摘要、断链、非法转移、重试/清理/补偿反例 |
| W4 发布四对象 | Qwen 27B；Gemma 26B + Codex | full/artifact-manifest*、approval-attestation*、promotion-record*、evidence-bundle*；两语言 release 模块；tests/w4 | W0，联测等待 W3；四对象错位/摘要/审批错包/回滚/链反例 |
| W5 AppSpec 与整包验收 | Codex 集成；独立 Codex 审查 | full 中三份迁入 Schema、app 接线、跨包 vectors、inventory、证据与新索引 | W1–W4；非空 Permission/Workflow 正例、全套双语言复验和来源绑定 |

`full/` 表格缩写指 `contracts/meta-schemas/0a-full-r1/`；代码拟位于 `tools/meta-schema-full/0a-full-r1/{python,node}/`，用例位于 `tests/meta-schema-full/0a-full-r1/`。不允许作者修改另一个工作包、冻结 PRD、旧 suites、旧证据、公共 dispatcher 或他人评审报告。

执行顺序：先 W0；W1/W3/W4 可分文件准备；W2 等 W1 参数合同；最后 W5。**本地模型推理默认串行排队**，避免多个大模型争用内存；不把四个包误当成四个可无限并发的 GPU 作业。独立人工式代码审查和主控制者测试可以并行。

## 5. 每包交付和拒收标准

每包必须提交：协议 Schema、字段字典（原文/新增选择分列）、两语言独立语义实现、手写固定预期向量、Fake 注册上下文、PRD→规则→正例/负例映射、验证输出和本地模型来源摘要。

共同最低测试：每个合法分支至少一正例；每个必填键缺失、每个封闭层未知键、引用八键缺失/错误枚举/错误版本/错误摘要、整数边界、null 与省略差别、重复身份、错误 profile、输入不变性。数量/长度只在设计明确限定处测等于边界及超一，不随意发明产品限额。

W3 必须覆盖计划/制品摘要无环、事件 sequence=1/null 与后继断链、终态禁止出边、重试同阶段、缺 DEFERRED 清理记录不能成功。W4 必须覆盖每类对象错位字段、审批指向其他制品、缺审批/配置绑定、PLANNED 提前结果、回滚目标不匹配、前序链断裂。测试既比较两语言，也比较独立预期；不能只证明“两边同样通过”。

拒收：只有文件数、所有 args 放任意 JSON、新增长期未校验依赖、样例替代规范、单语言实现、把模型自报 PASS 当测试、按多数票关闭严格问题、重写旧证据、越权合并、将 Fake 结果宣称真实部署。

## 6. 执行门禁与回滚

当前先交付设计 PR 和字段缺口/本地 AI 审查，不提交产品实现。W1–W4 在补充字段字典时必须把 D02–D07 未由 PRD 定义的具体结构纳入可审查材料；审批不能授权作者以后随意决定契约接受域。最终实现分支从已包含已审设计的最新 main 建立，使用 `feat/0a-5-meta-schemas`，单独实现 PR；不直接推 main，不自动合并。

后续修改已批准 full 接受域时创建新套件修订及新证据；回滚以保留 core-r1、停止接入未批准 full 套件为边界，不改任何已发布资产或冻结标签。所有 Schema/Linter 输出不产生真实写入，无生产回滚动作。
