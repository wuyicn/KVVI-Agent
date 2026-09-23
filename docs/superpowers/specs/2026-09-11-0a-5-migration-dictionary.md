# 0A-5 W3：MigrationPlan / MigrationRunEvent 候选字段字典 r1

日期：2026-09-11。作者：Codex 独立 W3 设计子任务。**待字段设计审查和负责人批准；不是已批准机器规范，不授权实现。** 本文只定义候选机器结构、Fake 注册资源和验收语义，不生成 JSON Schema、不执行代码、不连接数据库、不运行迁移。

依据：[冻结 PRD v1.11](../../PRD-AI无代码平台设计-v1.11.md) §7.2（637–703 行）、§7.11（933–993 行），以及 [0A-5 分工方案](2026-09-11-0a-5-meta-schemas-design.md) D04–D08 / W3。原文 SHA-256 为 `d517617a0c500713897e7d6c88b5894d4c802e6362ecf68631ba88776750993b`。参见 [原文审计](2026-09-11-0a-5-source-audit.md) MP/ME。本文所有新增英文键、数量上限、内部事件类别和操作目录均为下表 D 选择，不能声称 PRD 已逐字规定。

## 1. 待批准决定与边界

| 决定 | 本候选明确选择 | 原文与新增的界线 |
| --- | --- | --- |
| MD01 入口 | 两协议仅 `record` 入口，根为完整不可变记录；没有 `spec`、CompiledDraft、lifecycle 或 AI 写入入口 | PRD 已分计划/执行事件；具体入口和根字段划分为新增选择 |
| MD02 数据与限额 | 本批全部 Fake/合成；steps 6–256、每阶段至少一个登记步骤，可有多个；其它列表上限见下文 | 六阶段来自原文；数量预算是候选限制。六步骤仅最小样例，不把“一阶段一步”变成协议限制 |
| MD03 初始制品 | Plan.base_artifact_digest 必须为已有 Manifest 摘要，不允许 null；无历史制品且无迁移的首次发布使用 W4 空迁移清单 | PRD 未明确空基线；这是本版暂不接受 bootstrap 迁移的选择，需批准，不能暗中允许任意空计划 |
| MD04 操作身份 | 步骤使用 operation_code + version（正整数操作登记版）+ SchemaBinding；Schema 的接受域由可信版本化操作登记二次校验 | PRD 要求登记操作和类型化 args；具体字段及整数操作版本为新增选择，不与 ToolSpec 语义版本混用 |
| MD05 事件流 | 根增加 event_type、active_step_id、attempt、audit；完整历史前缀从 genesis 验证，不接受孤立 predecessor 作为完整证明 | PRD 固定 sequence/摘要链/状态机；事件细分与快照字段为新增选择 |
| MD06 状态推进 | 成功完成一个步骤后选择计划顺序中的下一个未完成步骤；最后一步结束才完成阶段；同状态阶段内/跨阶段进度记录不新增状态机出边 | PRD 规定阶段/状态分离，允许步骤组成计划；本条消除多步骤如何推进的歧义 |
| MD07 恢复 | 重试次数表示初次尝试以外的重试数；BACKFILL 失败后，进入等待/暂停前必须证明恢复至本步前检查点；否则进入 ROLLING_BACK | 原文规定回填失败停下并回滚检查点、重试同阶段；计数/证据字段为新增选择 |
| MD08 CLEANUP | 所有 CLEANUP 步骤只登记待清理项，逐步 DEFERRED；非空待清理记录齐备后另追加 FINALIZED 才 SUCCEEDED | 原文禁止破坏性清理且不许将 DEFERRED 当空操作；内部事件/集合条件为新增选择 |
| MD09 错误 | 六原文固定错误码不改；结构/引用/c14n 继续用公共诊断。合法失败事件可通过记录校验，不等于迁移成功 | 错误码来自 993；校验优先级与错误对象结构为新增选择 |
| MD10 计划资产 | MIGRATION_PLAN AssetRef.digest 精确等于 plan_digest；其整数 version 来自外部可信登记记录，根不重复携带业务登记版 | PRD 要求 Manifest 固定计划 AssetRef；映射规则为本候选与 W4 的显式接口 |
| MD11 正逆计划 | 同一不可变 Plan 的逐步 recovery 承载预批准逆向定义，全部进入 plan_digest；不向旧 Manifest 回填计划，也不把目标旧契约集的独立计划塞进新 Manifest | 与 W4 D06-R02 对齐；这是对 PRD §7.28“迁移/逆向计划”的新增组织选择。若评审认为覆盖不足则阻断设计，不得删除逆向验收 |
| MD12 成功后回滚 | Event 增加 run_mode 与 rollback_source_run_id；成功后另开 ROLLBACK run，复用原 Plan 的已批准 recovery；保持 PENDING→RUNNING→ROLLING_BACK→ROLLED_BACK/FAILED_FINAL | 新记录字段/用途是待批准选择；原 SUCCEEDED run 仍无出边，不增加状态枚举 |

所有对象包括 args、错误、上下文、注册资源都封闭未知键；除表内 `T/null` 外不接受 null。下列每个表格列出的键**全部必填**，没有隐式默认/自动补键；可空也必须写 null。数组保持原顺序；唯一性按所列稳定键检查，不以 JSON 整对象 uniqueItems 代替。缺失/额外键由 S 拒绝；历史、引用、跨字段和摘要由 L 验证。R（实际身份、签名、授权、事务和数据可恢复性）不由本字典宣称完成。

## 2. 标量、共享引用及有限值

| 类型 | 精确定义 |
| --- | --- |
| UUID | 与 core common UUID 格式一致的 UUID 字符串；不增造 v4-only 限制；服务端生成 |
| Code | ASCII `^[a-z][a-z0-9_]{0,63}$`；本地步骤、字段、规则、检查点、备份等稳定代码，不充当跨契约资产身份 |
| OpCode | ASCII `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,7}$`，总长 3–128；只接受精确注册项，不按名称猜测 |
| N / P | 分别为 0..9007199254740991 / 1..9007199254740991 的安全整数；JSON 浮点业务量不允许 |
| Digest | 共享 common.Digest：`^sha256:[0-9a-f]{64}$` |
| Time | core 已采用的有效 UTC RFC3339 子集，Z 结尾；拒绝闰秒和无时区值 |
| Phase | PREPARE / EXPAND / BACKFILL / VERIFY / ACTIVATE / CLEANUP，顺序固定 |
| Status | PENDING / RUNNING / PAUSED / RETRY_WAIT / ROLLING_BACK / SUCCEEDED / ROLLED_BACK / FAILED_FINAL |
| BusinessRef | 直接 `$ref` 唯一 common.AssetRef 后相交 asset_type=BUSINESS_SCHEMA；八键全部出现，app_id/module_id 可 null，version=P，digest=Digest |
| PlanRef | 同一 common.AssetRef，asset_type=MIGRATION_PLAN；完整作用域/身份/版本/摘要，不添加新资产枚举 |
| Text | 0–500 Unicode 字符纯说明；从不解释为 SQL、模板、命令或工具指令 |

`SchemaBinding` 逐字复用 [共享字典 F02](2026-09-11-0a-5-shared-dictionary.md)，仅两键：`schema_id`（非空字符串，精确存在于本地 manifest 的资源 ID）、`digest`（Digest，**原始 Schema 文件字节** SHA-256）。不在 W3 对共享 schema_id 另设长度或 URN 语法。它是机器 Schema 的内部资源身份，不是 AssetRef。digest 不能代替 operation_code/version；操作登记中的 binding 必须与步骤 binding 完全一致。拒绝网络读取、布尔 true Schema、未知 format、自定义执行关键字及未封闭的 args 根/分支。

`StaticValue` 是与已有 BusinessSchema 十种基础类型相容的有限联合：boolean；安全整数；字符串（≤20000）；互不重复的字符串数组（0–50，每项≤200）；或闭合 money 对象 `{amount,currency}`（amount 为 `^-?(0|[1-9][0-9]*)(\.[0-9]+)?$`，currency 为三个大写 ASCII 字母）。不接受 null、自由对象、对象数组。具体字段决定字符串是 decimal/date/datetime/文本/枚举；再使用 core 的精度、日期、长度、枚举及固定币种规则检查，不作类型强转。Backfill 的常量必须满足目标字段约束及写入策略；不是让字符串自报类型后绕过字段检查。

## 3. MigrationPlan 根字典

| 键 | 类型 / 空值 | 约束 / 来源 |
| --- | --- | --- |
| contract_version | 常量 migration-plan/v1alpha1 | MD01；原文版本 963 |
| migration_id | UUID | 原文 963；跨计划内容修订沿用身份，登记版递增，旧记录不改 |
| base_artifact_digest | Digest | 原文 963；MD03 不可 null，精确解析已有基线 |
| target_contract_set_digest | Digest | 原文 963/966；与 W4 的目标契约集合相同 |
| canonicalization_profile | 常量 kvvi-json-c14n/v1 | 原文 §7.2；可信输入 |
| field_diffs | FieldDiff[0..256] | 原文 948；按资源+field_code+change 唯一 |
| backfill_rules | BackfillRule[0..256] | 原文 948；rule_id 唯一 |
| index_changes | IndexChange[0..256] | 原文 948；资源+index_code 唯一 |
| impact | Impact | 原文影响数/风险；只允许合成样例数 |
| backup | Backup | 原文备份点；审批前固定恢复策略，不假造已执行备份结果 |
| verification_queries | VerifyQuery[1..256] | 原文验证查询；受限查询描述，无 SQL |
| rollback_conditions | Condition[1..32] | 原文回滚条件；不是自由布尔表达式 |
| steps | Step[6..256] | 每阶段≥1，计划顺序固定且阶段不倒退；step_id 全局唯一 |
| cleanup_policy | CleanupPolicy | 原文 963/980/984 |
| audit | PlanAudit | MD01：可信创建来源，冻结后不回填审批/发布时间 |
| plan_digest | Digest | 原文 696；按第 9 节重算 |

根禁止 `target_artifact_digest`、目标 `artifact_digest`、`spec`、`signature`、`lifecycle`、原始 SQL/DDL/令牌及未声明键。仅明确名为 `base_artifact_digest` 的历史摘要允许进入计划；args/备份策略/条件也不得藏目标 Manifest 摘要。所有引用必须解析到 base 或目标 contract_set 的固定资产；不能引用另一个无关制品。

### 3.1 根嵌套对象（全部键必填）

| 对象 | 键及类型 | 交叉约束 |
| --- | --- | --- |
| FieldDiff | base_schema_ref:BusinessRef；target_schema_ref:BusinessRef；field_code:Code；change:ADD_OPTIONAL_FIELD / ADD_REQUIRED_WITH_DEFAULT / WIDEN_DECIMAL / SET_CREATE_ONLY | base/target 同稳定对象和作用域且不同登记版；新增字段在 base 缺失/target 存在；其余两边存在，field_code 不变；收窄/删除/不兼容类型直接拒绝 |
| BackfillRule | rule_id:Code；target_schema_ref:BusinessRef；field_code:Code；selection:常量 MISSING_ONLY；value:StaticValue | 不覆盖已有值；字段允许登记的迁移写入；ADD_REQUIRED_WITH_DEFAULT 必须有相同目标的规则；实际数据检查属 R |
| IndexChange | base_schema_ref:BusinessRef；target_schema_ref:BusinessRef；index_code:Code；change:CREATE_NORMAL / CREATE_UNIQUE；build_mode:REGULAR / CONCURRENT | index_code 必须在 target 已定义；字段组合来自目标固定 BusinessSchema；不接受 SQL/物理索引名。并发索引单独标记，不假设全计划数据库单事务 |
| Impact | data_origin:常量 SYNTHETIC；affected_records:N；risk_flags:0..5 个互异枚举 BACKFILL / UNIQUE_CONSTRAINT / LOCKING / PRECISION_CHANGE / WRITE_POLICY_CHANGE；affected_schema_refs:BusinessRef[1..256] | 引用集合精确覆盖实际差异/回填/索引涉及目标对象；risk_flags 与操作推导结果一致，AI 不能少报；affected_records 是 Fake 输入，不外推生产 |
| Backup | backup_code:Code；base_artifact_digest:Digest；retention_versions:常量 2；restore_mode:常量 CHECKPOINT_PRESERVE_NEW_DATA | 摘要等于根 base；backup_code 是受控设施内部槽位，不能是路径/URL/凭据；这里是备份要求，真实 checkpoint 摘要在事件中产生 |
| VerifyQuery | query_id:Code；query_code:ROW_COUNT_EQUALS / FIELD_NON_NULL / INDEX_VALID / CONTRACT_SET_COMPATIBLE；resource_ref:BusinessRef/null；field_code:Code/null；index_code:Code/null；expected_count:N/null | ROW_COUNT_EQUALS：resource+count 非空其余 null；FIELD_NON_NULL：resource+field 非空其余 null；INDEX_VALID：resource+index 非空其余 null；CONTRACT_SET_COMPATIBLE：后三个局部值及 resource 全 null，目标从根契约集取得 |
| Condition | condition_code:BASE_ARTIFACT_MATCH / TARGET_CONTRACT_SET_MATCH / PRIOR_STEPS_COMPLETE / CHECKPOINT_AVAILABLE / NO_INDEX_CONFLICT / RESTORE_PRESERVES_NEW_DATA；resource_ref:BusinessRef/null；subresource_code:Code/null | NO_INDEX_CONFLICT 两者非空，subresource 为 index_code；其余两者 null。所有条件按 AND 解释；不可携带函数/SQL/任意表达式 |
| CleanupPolicy | mode:常量 DEFERRED；compatibility:常量 N_AND_N_MINUS_1；destructive_cleanup_allowed:常量 false；retention_versions:常量 2 | 至少保留 N/N-1；固定 2 是本 Fake 最低兼容策略，并不宣称两版后可自动删除；清理另经后续授权 |
| PlanAudit | created_by:UUID；created_at:Time；trace_id:1..128 字符非空字符串 | 与独立可信/Fake 创建上下文一致；不是审批记录；不允许动态 approved/published 元数据回填改变计划 |

`verification_queries` 与 Step.args 通过 query_id 连接，query_id 只在计划内有效。`rollback_conditions` 至少包含 CHECKPOINT_AVAILABLE 与 RESTORE_PRESERVES_NEW_DATA；各步骤前置条件检查失败时不执行其操作，若已发生前序副作用必须进入既定恢复路径。

### 3.2 Step 与恢复策略

| Step 键 | 类型 / 范围 | 语义 |
| --- | --- | --- |
| step_id | Code | 稳定且全计划唯一 |
| phase | Phase | 与可信操作登记的 allowed_phases 相容 |
| operation_code | OpCode | 精确注册，不是任意服务调用 |
| version | P | 操作登记版本，不是 PlanRef.version、工具语义版本或 contract_version |
| schema_binding | SchemaBinding | 精确等于该操作 args_schema_binding |
| args | 由登记 Schema 限定的封闭对象 | S 公共入口只识别对象；complete 必须二次应用注册 Schema，不得作为自由 JSON 通过 |
| preconditions | Condition[1..32] | AND；至少 PRIOR_STEPS_COMPLETE（首步表示空前缀满足）与 TARGET_CONTRACT_SET_MATCH |
| idempotency_key | Code | 全计划唯一的静态键；运行有效键为 migration_run_id + step_id + 此键，不由 AI 临时改变 |
| checkpoint | StepCheckpoint | 每步前后检查点描述 |
| timeout_ms | 整数 1..300000 | Fake 上限选择；不得出现无限/0超时 |
| max_retries | 整数 0..5 | 初次 attempt=1，不计在重试数内；允许最大 attempt=max_retries+1 |
| recovery | Recovery | 每步都必须有补偿或人工恢复，不以空对象表示无需恢复 |

StepCheckpoint 恰含 `before_code:Code`、`after_code:Code`；二者不同，全计划检查点代码各自唯一。它们只是声明受控保存点，实际内容摘要由运行事件引用。

Recovery 恰含 `mode:COMPENSATE/MANUAL`、`operation_code:OpCode`、`version:P`、`schema_binding:SchemaBinding`、`args:受登记 Schema 封闭的对象`、`timeout_ms:1..300000`。两种模式共用闭合键集合，操作注册类别必须为 RECOVERY；MANUAL 还要求受控恢复授权的外部上下文匹配。Recovery 不可嵌套 Recovery，不接收任意说明替代恢复操作；本候选补偿失败直接 FAILED_FINAL，不另加补偿重试状态。

## 4. 版本化操作登记与最小 Fake 集合

生产操作未被本文注册或执行。下表是拟交付固定 Fake 注册表的可测试集合；**协议的 operation_code 不写成只含此表的硬枚举**，其它操作只有在独立可信注册表存在固定版本、封闭参数 Schema、登记分类和恢复定义时才可能被完整校验接受。注册表的新增/替换须形成新的测试上下文/证据及相应审查，不能让输入对象自行补一条登记记录。

OperationEntry 全部必填：`operation_code:OpCode`、`version:P`、`kind:FORWARD/RECOVERY`、`allowed_phases:互异 Phase[1..6]`、`args_schema_binding:SchemaBinding`、`allowed_result_classes:互异 StepResult.result_class[1..8]`、`error_catalog:OperationError[0..16]`。OperationError 恰含 `operation_error_code:Code`、`result_class:RETRYABLE/MANUAL_REQUIRED/COMPENSATE_REQUIRED/FATAL/COMPENSATION_FAILED`；FORWARD 只可用前四种，RECOVERY 只可用 COMPENSATION_FAILED。错误分类取登记项，不能根据 AI 建议或错误文字猜测。成功类别和恢复类别按表固定；同 code/version 不可变。

所有 Fake operation.version=1；各参数 Schema 使用 manifest 固定本地资源 ID 和真正文件字节摘要，未来创建 fixture 时实际计算，不在本文用假摘要冒充已验证产物。operation_code/version 和 binding 全部进入计划摘要。

| Fake 操作 | 阶段 / 类别 | args 全部键及精确形状 |
| --- | --- | --- |
| fake.prepare.snapshot | PREPARE / FORWARD | `{backup_code:Code}`，等于根 backup.backup_code；建立首个可恢复快照要求 |
| fake.expand.add_field | EXPAND / FORWARD | `{target_schema_ref:BusinessRef,field_code:Code}`，对应 FieldDiff ADD_*；物理扩展先可空，再回填/验证，不把目标必填约束提前作用于旧数据 |
| fake.expand.widen_decimal | EXPAND / FORWARD | `{target_schema_ref:BusinessRef,field_code:Code}`，对应 WIDEN_DECIMAL；精度从目标契约读取，不允许在 args 另报更宽/更窄值 |
| fake.expand.create_index | EXPAND / FORWARD | `{target_schema_ref:BusinessRef,index_code:Code}`，对应根 IndexChange；CONCURRENT 失败须有登记恢复项处理残留无效索引，不允许假设事务自动清理 |
| fake.expand.set_create_only | EXPAND / FORWARD | `{target_schema_ref:BusinessRef,field_code:Code}`，对应 SET_CREATE_ONLY；真正新写策略在 ACTIVATE 后生效 |
| fake.phase.check_no_work | EXPAND 或 BACKFILL / FORWARD | `{phase:EXPAND/BACKFILL}`，等于 Step.phase；只能当该阶段无其它必要迁移工作且可信差异/样例检查证明无工作时使用。它执行阶段前置验证，不允许用于 CLEANUP |
| fake.backfill.static_default | BACKFILL / FORWARD | `{rule_id:Code}`，精确引用一个根 BackfillRule；无任意筛选条件/表达式 |
| fake.verify.check | VERIFY / FORWARD | `{query_ids:互异 Code[1..256]}`，均来自根 verification_queries；所有声明查询至少被某 VERIFY 步骤覆盖 |
| fake.activate.contract_set | ACTIVATE / FORWARD | `{target_contract_set_digest:Digest}`，等于根 target；禁止目标 artifact_digest；真正原子发布属 W4/R |
| fake.cleanup.defer | CLEANUP / FORWARD | `{items:PendingCleanup[1..256]}`，每项见第 5 节；只产生待清理记录，不执行删除 |
| fake.recovery.restore_checkpoint | 任一阶段 / RECOVERY | `{checkpoint_code:Code,preserve_new_data:常量 true}`，必须指向该步骤 before_code；恢复旧活动读写规则同时保留新版本产生数据 |
| fake.recovery.inspect_no_effect | 任一阶段 / RECOVERY | `{checkpoint_code:Code}`，必须指向该步骤 before_code；仅适用于可信操作/检查点证明未产生业务副作用的步骤，不是无条件成功桩 |
| fake.recovery.reconcile_index | EXPAND / RECOVERY | `{target_schema_ref:BusinessRef,index_code:Code,checkpoint_code:Code,policy:常量 RETAIN_AND_DISABLE_INVALID}`；处理并发索引失败残留，禁止 DROP/TRUNCATE，保留恢复证据 |

FORWARD 成功允许 SUCCESS（CLEANUP 仅 DEFERRED），失败按下面固定 Fake 错误目录。RECOVERY 允许 COMPENSATED / COMPENSATION_FAILED；后者不重新猜测为 RETRYABLE。

| operation_error_code | result_class | 允许来源及证据要求 |
| --- | --- | --- |
| simulated_lock_timeout | RETRYABLE | expand/create_index/backfill；只有 effect_state=NONE 或 REVERTED，检查点证实可重新尝试 |
| simulated_operator_required | MANUAL_REQUIRED | forward；BACKFILL 必须先 REVERTED 至本步前检查点；没有人工恢复凭据不接受恢复动作 |
| simulated_partial_write | COMPENSATE_REQUIRED | expand/backfill；部分业务效果必须恢复，不能推进 VERIFY/ACTIVATE |
| simulated_contract_conflict | FATAL | forward；进入 ROLLING_BACK |
| simulated_recovery_failure | COMPENSATION_FAILED | recovery 专用；OperationError 的恢复分支以此唯一 code/class 替代前述四种 forward 类别 |

每条登记仅带其允许的错误子集；Fake 场景先在外部固定步骤/尝试对应的 operation_error_code 与检查点事实，再冻结期望后继状态。禁止 candidate.error 自报 RETRYABLE 就让校验器相信。

## 5. 待清理记录与运行事件根

PendingCleanup 全部必填：`item_id:Code`、`resource_ref:BusinessRef`、`subresource_type:FIELD/INDEX/SCHEMA_VERSION`、`subresource_code:Code/null`、`deferred_action:RETAIN_PREVIOUS_FIELD/RETAIN_PREVIOUS_INDEX/RETAIN_PREVIOUS_SCHEMA`、`minimum_retained_versions:常量 2`、`release_condition:常量 SEPARATE_APPROVAL_AFTER_COMPATIBILITY_WINDOW`。SCHEMA_VERSION 的 code 为 null，另外两者非空且存在于固定 base 资产；action 与 type 一一对应。item_id 全计划唯一。即使没有待删除字段，至少登记保留旧 Schema 版本这一真实兼容责任，不能填空数组/虚构不存在资源。它没有执行时间、SQL 或“到期自动删除”标志。

| RunEvent 根键 | 类型 / 空值 | 约束 |
| --- | --- | --- |
| contract_version | 常量 migration-run-event/v1alpha1 | 独立 record |
| migration_run_id | UUID | 一个追加事件流的身份，执行重启沿用同一 run |
| run_mode | FORWARD / ROLLBACK | MD12；由独立可信运行上下文固定，不接受在同一流内变更 |
| rollback_source_run_id | UUID/null | FORWARD 必须 null；ROLLBACK 必须指另一已 SUCCEEDED 的 FORWARD run，不可等于本 run |
| migration_id | UUID | 等于精确 Plan.migration_id |
| artifact_digest | Digest | 执行中的目标 Manifest，包含精确 PlanRef |
| plan_digest | Digest | 等于 Manifest 固定计划的 plan_digest |
| canonicalization_profile | 常量 kvvi-json-c14n/v1 | 服务端写入 |
| sequence | P | 从 1 连续递增 |
| previous_record_digest | Digest/null | 仅 sequence=1 时 null |
| event_type | 第 7 节固定内部事件枚举 | 与来源/目标状态、payload 分支一致 |
| current_phase | Phase | 首事件 PREPARE；完成步骤才能有序推进 |
| run_status | Status | 阶段与状态分别保存 |
| active_step_id | Code/null | 当前可执行/重试/恢复步骤；全部 forward 完成后可 null；失败回滚期间仍保留触发失败步骤 |
| attempt | 整数 0..6 | 初始0；活动 forward 首次1；最高 max_retries+1；已完成全部 forward 时0；重试/人工恢复规则见第7节 |
| checkpoint_digest | Digest/null | 初始 null；开始执行起非空，解析到本 run 的内容已校验检查点 |
| step_results | StepResult[0..1] | 一个事件最多记录一个步骤结果；非结果事件空数组；不把执行中结果回填旧事件 |
| resume_token_digest | Digest/null | PAUSED/RETRY_WAIT 必须非空，其他状态 null；只保存受控恢复凭据摘要 |
| error | MigrationError/null | 失败/补偿失败事件非空；其它事件 null。旧失败信息由历史保留 |
| audit | EventAudit | 可信生成来源 |
| record_digest | Digest | 第9节精确前像 |

StepResult 全部必填：`step_id:Code`、`step_phase:Phase`、`attempt:1..6`、`execution:FORWARD/RECOVERY`、`result_class:SUCCESS/DEFERRED/RETRYABLE/MANUAL_REQUIRED/COMPENSATE_REQUIRED/FATAL/COMPENSATED/COMPENSATION_FAILED`、`phase_result:COMPLETED/DEFERRED/FAILED`、`effect_state:NONE/APPLIED/PARTIAL/REVERTED`、`checkpoint_before_digest:Digest`、`checkpoint_after_digest:Digest`、`pending_cleanup:PendingCleanup[0..256]`。其中 step_id 指本事件完成/失败的步骤，step_phase 必须等于 Plan 中该步的 phase，可能与推进后的根 active_step_id/current_phase 不同。RECOVERY 使用原 forward 步骤 ID，attempt 固定1，不能冒称又执行了一次 forward。补偿的 step_phase 可以倒序，不能据此把根 current_phase 倒退。

- SUCCESS→COMPLETED；DEFERRED→DEFERRED 且仅 CLEANUP；其它 forward 失败→FAILED。COMPENSATED→COMPLETED 且 effect_state=REVERTED/NONE；COMPENSATION_FAILED→FAILED。
- 普通成功/失败/恢复结果的 pending_cleanup 必须为空；DEFERRED 结果须与该步骤计划 args.items 完全一致且非空。DEFERRED 的 effect_state=NONE，表示未执行破坏性业务清理，不表示没写待清理记录。
- 每个 before/after 摘要精确解析到可信检查点内容，不能只比较两个任意哈希相等。成功不得重复标记已完成步骤；部分失败不能伪装为成功。BACKFILL 失败欲进入 RETRY_WAIT/PAUSED 时必须 effect_state=REVERTED 且 after 精确表示 before 恢复后的业务状态。

MigrationError 全部必填：`code:六个固定迁移错误码`、`result_class:RETRYABLE/MANUAL_REQUIRED/COMPENSATE_REQUIRED/FATAL/COMPENSATION_FAILED`、`operation_error_code:Code`、`step_id:Code`、`checkpoint_digest:Digest`。合法 STEP_FAILED 事件的 code 必须 MIGRATION_STEP_FAILED；合法 COMPENSATION_FAILED 事件必须 MIGRATION_ROLLBACK_FAILED；其余四种码用于拒绝非法候选/恢复请求，不写成一条“合法完成”的事件。错误类别必须等于 OperationEntry + 外部操作结果记录分类，error.step_id 与唯一 StepResult 一致。没有自由 message、stack、SQL 或原始参数，失败说明由受控错误目录呈现。

EventAudit 恰含 `actor_id:UUID`、`occurred_at:Time`、`trace_id:1..128 字符非空字符串`。真实性通过外部可信上下文比较；Time 不替代 sequence 排序。协议不允许原始恢复令牌、签名 sidecar 或主动凭据进入记录。

## 6. 外部可信/Fake 校验上下文

逐字采用 W0 F03 外壳 `{context_version:"0a-full-fake/v1",fixture_id:非空字符串,core_context:既有封闭core上下文,extension:本节对象}`。**本节表中全部键直接组成 W3 extension，全部必填**，不再套自由 migration 对象、不新增 extension.scope；作用域从 core_context 获取。Plan 与 RunEvent 均选该封闭分支并按表执行条件约束，不能由实例填写分支/信任开关。所有列表/对象由独立可信测试设施提供；AI candidate 不得写入、覆盖或追加其登记项。这里只允许合成登记记录，不能因此宣称已验证真实平台权限/签名。

| 子上下文键 | 类型 | 用途 |
| --- | --- | --- |
| plan_registration | PlanRegistration/null | 验 Plan 时可 null（登记前）；验 RunEvent 时必须存在 |
| plan_author | PlanAudit | 独立可信创建快照；与 Plan.audit 完全一致，不让 candidate 自证创建身份 |
| base_manifest | W4 精确 Manifest | base 摘要可解析并与 Plan 匹配 |
| target_contract_set | W4 冻结契约集合投影 | 用于 Plan 的无环验证；不必先有目标 Manifest |
| target_manifest | W4 精确 Manifest/null | 验 Plan 登记前可 null；验 RunEvent 必須有，防止为了算 plan 先要求 artifact |
| operations | OperationEntry[1..256] | 精确版本登记，code/version 唯一，SchemaBindings 指 manifest 本地资源 |
| schema_resources | SchemaBinding[1..512] | 列出本 extension 操作引用的已装载资源；定义正文只从 W0 已核验 Bundle 取，不收自由 JSON 代码 |
| history | 已登记 RunEvent[0..4096] | 本 run 完整 genesis→candidate.sequence-1 前缀；首条为空，无重复、缺口或其它 run 混入 |
| history_head | HistoryHead/null | Plan 校验为 null；事件校验必须有，独立可信最新前缀锚点，防止截去尾部重放旧分叉 |
| rollback_source | RollbackSource/null | 仅 ROLLBACK run 非空；完整成功原 run 及检查点，见下文 |
| checkpoints | CheckpointRecord[0..8192] | 实际 Fake 内容、摘要、所属 run 与已完成步骤；首条初始化允许空 |
| snapshot_resources | SnapshotResource[0..8192] | 检查点绑定的合成记录/索引快照，逐项检查内容摘要，不只有一个自报hash |
| operation_receipts | OperationReceipt[0..8192] | 独立 Fake 操作结果/错误分类，按触发事件精确核对 |
| resume_grants | ResumeGrant[0..4096] | 恢复凭据摘要/权限/绑定事件及是否已消费的证据 |
| action | CandidateAction/null | 验 Plan 可 null；事件候选须匹配本次可信动作 |
| permission_snapshot | MigrationPermissionSnapshot/null | Plan为null；事件为独立可信当前授权快照，不能把core的跨应用grants冒充运行恢复权限 |

辅助对象全部键必填：

- **PlanRegistration**：`asset_ref:PlanRef`、`plan:本字典完整Plan`。asset_ref.asset_id=migration_id，digest=plan_digest；version 正整数在外部登记分配，不能由根反向决定。作用域与基线/目标应用一致；不能引用第二个租户。
- **CheckpointRecord**：`checkpoint_code:Code`、`migration_run_id:UUID`、`step_id:Code`、`phase:Phase`、`snapshot_digest:Digest`、`completed_step_ids:Code[0..256]`、`pending_cleanup:PendingCleanup[0..256]`、`reverted_step_ids:Code[0..256]`、`checkpoint_digest:Digest`。snapshot_digest 绑定合成数据快照，checkpoint_digest 为本对象去掉自身键的 c14n 摘要；三个列表都按计划顺序，互异，completed 与 reverted 不交叉。快照不含真实记录/令牌。
- **SnapshotResource**：`snapshot_digest:Digest`、`snapshot:SyntheticSnapshot`；摘要为c14n(snapshot)内容hash。SyntheticSnapshot恰含 `data_origin:常量SYNTHETIC`、`active_artifact_digest:Digest`、`records:SyntheticRecord[0..1000]`、`indexes:SyntheticIndex[0..256]`。SyntheticRecord恰含 `record_id:UUID`、`schema_ref:BusinessRef`、`values:FieldValue[0..100]`；FieldValue恰含 `field_code:Code`、`value:StaticValue/null`，字段唯一、必须在已固定schema_ref内，null仅字段nullable允许，全部按目标字段类型/枚举/范围二次检查；不得引入任意额外字段/对象。SyntheticIndex恰含 `resource_ref:BusinessRef`、`index_code:Code`、`state:ABSENT/BUILDING/VALID/INVALID/DISABLED`；索引精确来自base或target已声明结构。records按record_id、values按field_code、indexes按资源完整元组+index_code预排序且唯一；排序只为这个新增快照格式，不改变协议其它数组。Fake检查比较快照实际内容以证明行/字段数据未静默丢弃，不能只接受preserve_new_data=true。超过合成快照预算不冒充真实规模验证。
- **OperationReceipt**：`receipt_id:UUID`、`migration_run_id:UUID`、`step_id:Code`、`execution:FORWARD/RECOVERY`、`attempt:1..6`、`operation_code:OpCode`、`version:P`、`result_class:StepResult.result_class`、`operation_error_code:Code/null`、`effect_state:StepResult.effect_state`、`checkpoint_before_digest:Digest`、`checkpoint_after_digest:Digest`。成功/DEFERRED/COMPENSATED error code=null；失败必须来自对应登记目录。一个 step/execution/attempt 的相同结果不会形成重复副作用证据；人工恢复同 attempt 的后续 receipt 必须在 history 中先有合法暂停/恢复事件，不接受同一次结果重放为新成功。
- **ResumeGrant**：`token_digest:Digest`、`migration_run_id:UUID`、`bound_sequence:P`、`bound_record_digest:Digest`、`step_id:Code`、`checkpoint_digest:Digest`、`permission_version:P`、`expires_at:Time`、`consumed_at_sequence:P/null`。由受控渠道登记，绑定最近 PAUSED/RETRY_WAIT 事件；consumed_at_sequence 从历史推导核对，candidate 不能说 false 即未用。
- **CandidateAction**：`event_type:第7节枚举`、`actor_id:UUID`、`permission_version:P`、`at:Time`、`supplied_resume_token_digest:Digest/null`、`receipt_id:UUID/null`。恢复动作必须提供匹配有效未消费 grant 的摘要，其余为 null；结果事件必须有 receipt，非结果事件为 null。MANUAL_RESUMED/人工 RECOVERY 额外通过下列MigrationPermissionSnapshot的明确动作，不能凭actor_id语法正确放行。
- **MigrationPermissionSnapshot**：`actor_id:UUID`、`permission_version:P`、`plan_ref:PlanRef`、`artifact_digest:Digest`、`allowed_actions:互异枚举MIGRATION_START/MIGRATION_RESUME/MIGRATION_ROLLBACK/MIGRATION_MANUAL_RECOVERY[1..4]`。与本次action主体/版本、固定Plan/Manifest精确相同。INITIALIZED/STARTED与forward结果要求START；RETRY_STARTED要求RESUME；MANUAL_RESUMED和MANUAL恢复要求RESUME+MANUAL_RECOVERY；ROLLBACK_REQUESTED和补偿/回滚完成要求ROLLBACK，MANUAL补偿还要求MANUAL_RECOVERY。此快照只用于Fake授权负例，不代表真实权限已实现。
- **HistoryHead**：`migration_run_id:UUID`、`run_mode:FORWARD/ROLLBACK`、`latest_sequence:N`、`latest_record_digest:Digest/null`；history 为空时序号0且摘要null；否则两值等于完整前缀最后一条。该锚点是可信调用方当前快照，不由待测事件给出。
- **RollbackSource**：`source_run_id:UUID`、`artifact_digest:Digest`、`plan_digest:Digest`、`history_head:HistoryHead`、`events:完整RunEvent[1..4096]`、`checkpoints:CheckpointRecord[1..8192]`、`authorization:RollbackAuthorization`。source 必须是同一 artifact/plan 的 FORWARD run，events 从1到其head完整，最终 SUCCEEDED，无后继；检查点全部属于 source。source_run_id 等于候选 rollback_source_run_id，且与本run不同。
- **RollbackAuthorization**：`actor_id:UUID`、`permission_version:P`、`source_artifact_digest:Digest`、`target_artifact_digest:Digest`、`approved_plan_ref:PlanRef`、`current_environment_artifact_digest:Digest`。source/current 等于原运行的新 Manifest，target 等于 Plan.base_artifact_digest，PlanRef 与原 Manifest 固定计划逐键相同；主体/版本与MigrationPermissionSnapshot一致且必须有MIGRATION_ROLLBACK。该对象是Fake治理授权快照，不当作真实审批密码学证明。

Plan 校验中 history/checkpoints/snapshot_resources/operation_receipts/resume_grants 必须空，history_head/rollback_source/action/permission_snapshot 为 null；target_manifest 可空，plan_registration 可空，plan_author 必有。FORWARD 事件 rollback_source 必 null。ROLLBACK 事件必须有上述source；根run_mode/rollback_source_run_id与可信head/source一致。permission_snapshot必有并匹配候选action，不能将只用于跨应用资源引用的core_context.grants扩义成运行授权。每条受信外部资源先校验结构/内容摘要；资源坏了属F03依赖故障exit1。资源有效而candidate指向不存在/错版本/错摘要资源属exit2。候选所需外部上下文完全未提供时使用TRUSTED_CONTEXT_REQUIRED/DEPENDENCY_VALIDATOR_UNAVAILABLE，不能假定空历史。

历史长度上限4096是本候选可复验资源预算，不是允许切掉早期事件。超限必须明确报受支持范围外的配置/输入失败；不得从中间抽取“看似连续”的尾部并称完整验证。更长流的锚点/压缩证明另行设计。本次不加深度截断去掩盖 M-4。

## 7. 确定性事件、阶段与重试表

以下主表适用于 run_mode=FORWARD（含本次正向失败的补偿）；独立成功后回滚按第7.1节。除首次声明外，run_mode/rollback_source_run_id/migration_run_id/artifact_digest/plan_digest/migration_id 在整条流中固定。

event_type 固定：`INITIALIZED/STARTED/STEP_SUCCEEDED/STEP_FAILED/RETRY_STARTED/MANUAL_RESUMED/ROLLBACK_REQUESTED/COMPENSATION_SUCCEEDED/COMPENSATION_FAILED/CLEANUP_DEFERRED/FINALIZED/ROLLBACK_COMPLETED`。这些是本候选事件枚举，不能当作新的 run_status。

| 前态 / 事件 | 后态 | 根指针、结果和前置条件 |
| --- | --- | --- |
| 无前条 / INITIALIZED | PENDING | sequence=1，previous=null，PREPARE，active=首step，attempt=0，checkpoint=null，results=[]，token/error=null；必须已精确绑定 Manifest/Plan |
| PENDING / STARTED | RUNNING | phase/active 不变，attempt=1，checkpoint=首步 before 的可恢复检查点；results=[]，token/error=null |
| RUNNING / STEP_SUCCEEDED | RUNNING | results 恰一 SUCCESS；完成 active，依计划选择下一未完成步骤，下一步骤 attempt=1；同阶段可保持 phase，仅本阶段全部完成才进入下一 phase；checkpoint 更新到已验证结果 after；CLEANUP 禁用本事件 |
| RUNNING / STEP_FAILED + RETRYABLE 且 attempt≤max_retries | RETRY_WAIT | active/phase/attempt 保持，登记未消费 token；一失败结果和 MIGRATION_STEP_FAILED；必须可恢复重试 |
| RUNNING / STEP_FAILED + RETRYABLE 且 attempt>max_retries | ROLLING_BACK | 同一失败 step/phase/attempt；token=null；不能额外再尝试 |
| RUNNING / STEP_FAILED + MANUAL_REQUIRED | PAUSED | 同一 step/phase/attempt；token 非空；BACKFILL 必须已经恢复至本步前检查点 |
| RUNNING / STEP_FAILED + COMPENSATE_REQUIRED 或 FATAL | ROLLING_BACK | 同一 step/phase/attempt；token=null；进入逆序恢复 |
| RETRY_WAIT / RETRY_STARTED | RUNNING | token 验证并消费，phase/active 不变，attempt 加1，results=[]，error/token=null；开始点须是已恢复检查点 |
| PAUSED / MANUAL_RESUMED | RUNNING | 当前权限/恢复授权和 token 有效；phase/active/attempt 不变，结果清空，token/error=null。这是同一逻辑尝试从检查点恢复，不凭此重做已完成步骤 |
| RUNNING、PAUSED、RETRY_WAIT / ROLLBACK_REQUESTED | ROLLING_BACK | active/phase 保持，token=null，results=[]，error=null；外部可信恢复决策满足计划 rollback_conditions；不是 AI 临时选路径 |
| ROLLING_BACK / COMPENSATION_SUCCEEDED | ROLLING_BACK | 一个 RECOVERY/COMPENSATED 结果，依逆序恢复栈消费一项，checkpoint 更新；active/phase 仍保留触发回滚的 forward 位置，不能被补偿步骤名污染 |
| ROLLING_BACK / COMPENSATION_FAILED | FAILED_FINAL | 一个 RECOVERY/COMPENSATION_FAILED 结果，error=MIGRATION_ROLLBACK_FAILED；token=null |
| RUNNING 且 CLEANUP / CLEANUP_DEFERRED | RUNNING | 一个 DEFERRED 结果及非空待清理 items；继续下一 CLEANUP step；最后一个后 active=null、attempt=0、phase 仍 CLEANUP；不能把该事件直接标 SUCCEEDED |
| RUNNING 且 CLEANUP / FINALIZED | SUCCEEDED | 所有步骤有成功/DEFERRED 记录，所有 cleanup items 与计划一致且在最终检查点累计存在，active=null、attempt=0、results=[]、error/token=null |
| ROLLING_BACK / ROLLBACK_COMPLETED | ROLLED_BACK | 所需逆序恢复栈已清空，检查点证明旧活动规则可读且新数据保留；results=[]，error/token=null，active/phase 仍保留触发位置 |
| SUCCEEDED、ROLLED_BACK、FAILED_FINAL / 任意事件 | 拒绝 | 终态无出边；不能通过新 event_type 复活同 run |

状态保持的 STEP_SUCCEEDED/CLEANUP_DEFERRED/COMPENSATION_SUCCEEDED 是当前状态内部的进度记录，不为 PRD 状态机增加新状态。相邻阶段只能按六阶段顺序推进，不接受跳阶段。结果所指步骤必须是前条 active；不能把下一步骤的结果塞进当前事件。

BACKFILL 的 RETRYABLE/MANUAL_REQUIRED 若缺少已恢复检查点，则拒绝该等待/暂停候选；可信操作事实应输出 COMPENSATE_REQUIRED 进入 ROLLING_BACK，不能在校验器里改写原错误类别。回填失败历史尚未成功恢复/重试完成，VERIFY/ACTIVATE 必须拒绝。

恢复栈由完整历史派生：先纳入当前失败操作尚有 PARTIAL/APPLIED 的步骤，再依计划逆序纳入已经产生 APPLIED 效果的成功步骤；没有业务效果的步骤仍按其 recovery 检查无副作用。每项只能消费一次。若手动回滚发生在 CLEANUP 完成但尚未 FINALIZED 的 active=null 窗口，触发位置取最后完成步骤，候选 ROLLBACK_REQUESTED 的 active 置为该步、attempt 置为该步已完成 attempt；这是本候选唯一允许回滚入口补回诊断指针的分支。

不允许把错误码当状态；同一前缀、检查点、登记错误类别和动作必须得到相同后继。若 token 错、权限版本过期或动作不合法，拒绝且不追加事件，不能生成 FAILED_FINAL 来掩盖非法请求。

### 7.1 SUCCEEDED 之后的独立逆向运行（MD12）

原 FORWARD run 处于 SUCCEEDED 后无出边。成功后需回滚时，创建新的 migration_run_id，run_mode=ROLLBACK、rollback_source_run_id=原成功run；复用同一 Plan 和其所在新 Manifest 的 artifact_digest，回滚目的为 Plan.base_artifact_digest。所有身份/批准来源由外部 RollbackSource 精确绑定，不允许用新模式字段绕过真实发布权限。

| 事件 / 状态 | 固定规则 |
| --- | --- |
| INITIALIZED / PENDING | sequence=1、previous=null；current_phase=PREPARE、active_step_id=null、attempt=0、checkpoint=null、results=[]、error/token=null；完整成功 source 与恢复授权先通过 |
| STARTED / RUNNING | current_phase 保持 PREPARE、active=null、attempt=0；登记新 run 的开始检查点（当前数据与旧 source 之后新增数据均保留），results=[] |
| ROLLBACK_REQUESTED / ROLLING_BACK | 仅控制事件，不能执行任何 forward 操作；phase=PREPARE/active=null/attempt=0不变；逆序栈由成功 source 的原 forward结果建立 |
| COMPENSATION_SUCCEEDED / ROLLING_BACK | 一个 RECOVERY结果，按 source步骤逆序消费；step_phase 取原步骤phase可倒序；根phase仍PREPARE表示本run未跑正向阶段，不将逆序映射成非法正向阶段推进 |
| COMPENSATION_FAILED / FAILED_FINAL | 一个失败 RECOVERY结果，error=MIGRATION_ROLLBACK_FAILED；保持原终态无出边 |
| ROLLBACK_COMPLETED / ROLLED_BACK | 逆序栈清空、旧活动规则恢复、新数据保留的检查点及 W4 回滚目标一致；results=[] |

新 ROLLBACK run 禁止 STEP_SUCCEEDED/STEP_FAILED/CLEANUP_DEFERRED/FINALIZED/RETRY_STARTED/MANUAL_RESUMED，以及任何 execution=FORWARD 的 receipt；不进入 SUCCEEDED，不重放 source 的正向副作用。MANUAL recovery 在执行前由可信恢复授权验证，不新增 PAUSED 分支。root.current_phase 固定 PREPARE 是本候选的“正向进度未开始”表达；真正补偿顺序记录在 StepResult.step_phase/step_id，若审查认为此表达会误导运行时，应修订候选字段设计，不能暗改原 Phase/Status 枚举。

恢复操作 args.checkpoint_code 指向 source 原步骤的 before 检查点作为恢复规则参考；新 StepResult.before/after 和根 checkpoint_digest 必须属于**新 run**，表示真实当前快照及恢复后保留新数据的快照。不能把原 source 的旧快照原样覆盖到当前数据。恢复完成后若同一新run再次收到事件，一律终态拒绝；再发新的逆向run还须重新验证 W4 当前环境确仍激活 source制品，不能重复恢复已回滚的环境。

## 8. 六固定错误码与阶段优先级

| 错误码 | 固定责任 / 定向负例 |
| --- | --- |
| MIGRATION_PLAN_MISMATCH | PlanRef/plan_digest/目标 contract_set/Manifest 关联不一致，操作 code/version/binding 与固定计划登记不一致；计划自身 plan_digest 篡改也属此码。真实 AssetRef 格式/不存在/越域/错误摘要先用共享引用码，不把所有引用错误吞成同一迁移码 |
| MIGRATION_EVENT_CHAIN_INVALID | candidate.sequence 非连续/重复、前序摘要错误、混 run 或与可信最新history_head不匹配；候选 event.record_digest 不符也属事件完整性错误。外部历史/锚点自身损坏则是依赖错误exit1，不把坏context当实例拒绝反例 |
| MIGRATION_STATE_TRANSITION_INVALID | 未登记事件/phase-status 组合、终态后续、跳步/跳阶段、非法重试次数、缺 CLEANUP DEFERRED、完成步骤再次执行；结构非法 enum 先由 S 拒绝 |
| MIGRATION_STEP_FAILED | 合法 forward 失败事件中的 error.code；或候选结果与固定操作 receipt/参数校验不符时的步骤语义诊断。失败记录结构/历史都有效可 exit0；其 run_status 仍是失败处理路径，不得报告迁移成功 |
| MIGRATION_RESUME_TOKEN_INVALID | 恢复凭据缺失、错摘要、过期、绑定错 step/run/checkpoint/sequence/权限版本、已消费；不读取或输出原始 token |
| MIGRATION_ROLLBACK_FAILED | 合法补偿失败事件中的 error.code；或声称恢复完成但恢复栈/检查点证据未满足的恢复语义拒绝 |

沿用公共流水：严格原始 JSON/c14n → S 结构 → 静态参数/阶段/重复项 → 引用/摘要/历史 → 本次范围内有效。静态先拒绝未知字段、非法数量/枚举及 SQL/DDL；资产错误保持公共格式。references/history 同层出现多种问题时候选优先级：PLAN_MISMATCH → EVENT_CHAIN_INVALID → RESUME_TOKEN_INVALID → STATE_TRANSITION_INVALID → STEP_FAILED → ROLLBACK_FAILED；同码按 UTF-8 JSON 路径排序。存在更早阶段错误时不继续依赖较后阶段假设。code/path 的最终 JSON Pointer 规则由 W0 错误字典统一；本候选根字段路径严格使用本文件键名，不生成第二套别名。

退出0/2/1分别是“记录在声明范围内有效/实例被拒绝/工具或配置故障”。合法 run_status=FAILED_FINAL 的记录可以校验有效；报告必须同时给出该状态并保持 release_approved=false。超时、宿主递归耗尽、缺少离线 Schema 等配置故障不算预期实例拒绝，M-4 不算一致性通过。

## 9. 精确摘要投影与无环验证

记 C(x) 为严格 `kvvi-json-c14n/v1` 最终 UTF-8 字节，H(b) 为 SHA-256 的 `sha256:` 小写形式；这只是文档数学记号，本任务未执行代码。

1. **计划前像 P**：第3节根所有键的完整值，**仅删除根 plan_digest**。因此 contract_version、migration_id、base_artifact_digest、target_contract_set_digest、profile、差异、回填、索引、影响、备份、验证查询、回滚条件、全部步骤与每个 operation SchemaBinding、cleanup_policy、audit 均包含。`plan_digest = H(C(P))`。不排序 steps、args 数组或其它计划数组，不递归删除嵌套 digest。外部签名从来不是根字段，故不在前像。
2. **事件前像 E**：第5节根所有键，**仅删除根 record_digest**；previous_record_digest、artifact_digest、plan_digest、checkpoint_digest、resume_token_digest 和所有结果/错误/audit 均保留。`record_digest = H(C(E))`。不得为了“排摘要字段”删除所有以 digest 结尾的字段。
3. **检查点前像 K**：CheckpointRecord 完整根，仅删 checkpoint_digest，包含 snapshot_digest、已完成/待清理/已恢复列表。`checkpoint_digest = H(C(K))`。snapshot_digest 绑定外部合成快照内容，不能靠自己循环引用。
4. **SchemaBinding.digest**：H(被绑定 Schema 原始文件字节)，不用 c14n 替换文件字节哈希；它和业务记录内容摘要分别验证。
5. **contract_set_digest**：逐字采用 [W4 §3](2026-09-11-0a-5-release-dictionary.md) 的唯一三键投影 `Pset={contract_set:M.contract_set,registry_refs:M.registry_refs,policy_ruleset_ref:M.policy_ruleset_ref}`，`target_contract_set_digest=H(C(Pset))`。contract_set 是 W4 ContractEntry 数组，每项严格为 asset_ref/contract_version/对应协议spec；registry_refs 恰为 field_type/component/material/capability 四个固定类型 AssetRef；policy_ruleset_ref 为 POLICY_RULESET AssetRef。Policy快照纳入集合是 W4 D06-R02新增选择，待共同批准。排除 Plan、app_ref、profile字段、图/SBOM、运行ToolSpec、兼容要求及所有根摘要字段/签名；profile用于选定 C。contract_set按 PRD695完整引用元组预排序且拒绝乱序输入，四Registry保持固定键对象不另造数组，spec内部数组不排序。W3直接引用这一类型/算法，不私造第二份projection。
6. **无环顺序**：W4 目标契约集及 Registry 固定 → 计算 contract_set_digest → W3 Plan 冻结并算 plan_digest → 外部登记生成 PlanRef → W4 Manifest 固定 PlanRef 后算 artifact_digest → W3 RunEvent 才能引用 artifact_digest。Plan 验证允许 target_manifest=null；RunEvent 验证则必须精确解析 Manifest 与 PlanRef。禁止让 Plan 的目标/验证查询/ACTIVATE args 反向依赖尚未生成的目标 Manifest 摘要。

计划签名/审计证明侧车不写进计划或事件；侧车验证接口只接受被签的 plan_digest/record_digest，真实算法/信任根由 W4/W0 单独审查。Fake 验证摘要绑定不宣称密码学验真或人工已批准。

## 10. 与 W4/W0 必须统一的接口和承诺样例

| 接口 | W3 的具体承诺 | 对方需落定的责任 |
| --- | --- | --- |
| ContractSetProjection | Plan.target_contract_set_digest 等于 W4 唯一投影摘要；Plan 验证不索取目标 artifact_digest | W4 给出投影键、集合内容、排序/去重及独立固定向量；W0禁止双份实现各自选键 |
| PlanRef | common八键；asset_type=MIGRATION_PLAN；asset_id=migration_id；version=P；digest=plan_digest | W4 的 migration 引用列表使用此精确身份；不把 plan整文件字节hash 当内容摘要 |
| Plan 与 Manifest | base 指旧 Manifest；target 指新契约集；RunEvent.artifact 指固定本计划的新 Manifest | W4 基线/目标同租户应用、清单唯一，不能用包含另一计划版本的 Manifest 通过 |
| 逆向恢复 | MD11：同一冻结Plan的每步recovery完整覆盖预批准逆向，纳入plan_digest；失败中回滚沿原run，成功后回滚另开MD12新run | W4 Promotion回滚目标是base旧Manifest，migration引用仍为原新Manifest计划清单的精确子集；不向旧Manifest回填、不临时生成逆向；是否充分覆盖PRD7.28由owner审查 |
| Evidence | 事件和检查点摘要可被 EvidenceBundle 引用；错误记录有效不等于测试/迁移成功 | W4 定义 MIGRATION 证据载荷/引用形状，禁止把事件复制进 ArtifactManifest |
| 注册Schema | operation登记版=P；SchemaBinding原始字节hash；动态args二次封闭校验 | W0离线loader/context/诊断格式与W2 SchemaBinding共享，不新建AssetType |

最低固定向量设计：多步骤同阶段成功（证明不限一阶段一步）；最小六阶段登记迁移；无数据阶段的登记验证；正常/并发索引及部分失败恢复；backfill恢复检查点后重试；max_retries=0与5边界；MANUAL恢复同一步；每种非法状态边与终态后继；首条sequence1/null与每种缺前缀/摘要篡改；同Plan错Manifest/错登记版/错schema binding；漏备份/查询/恢复方式；CLEANUP空items、结果不等于计划、无DEFERRED就FINALIZED；token失效/错绑定/重复消费；合法FAILED_FINAL记录仍可校验有效但不表示成功；每个根/嵌套键缺失、未知键与null分支。

另加MD12成对向量：原SUCCEEDED后追加回滚事件必须拒绝；新ROLLBACK run按PENDING→RUNNING→ROLLING_BACK→ROLLED_BACK通过；错source/错计划/旧数据覆盖/重复已回滚环境/新run尝试任何forward操作必须拒绝；补偿失败为合法FAILED_FINAL记录但不算恢复成功。

这些是待创建的向量设计，不是已存在 fixture 或测试通过结论。所有摘要示例须由后续已批准工具对实际 Fake 内容产生，并由双语言对照固定预期；不写假签名/固定重复字符摘要冒充真实证据。W4投影和双方注册接口需联合复核，MD01–MD12及各具体类型/预算需负责人对精确候选版本批准之后，才可进入单独实现PR。本轮只读取文档和写本候选，没有执行协议代码/测试或真实迁移。
