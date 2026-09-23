# Task4 固定引用与私有 Fake context

本文件说明 `tools/meta-schema/context.schema.json` 的工具私有格式。它不是 ArtifactManifest、Scope Spec 或真实注册服务，不表示审批、权限、部署或后续 Go 门禁通过。来源为冻结 PRD v1.11 §7.2/7.11/7.20/7.24/7.27 与批准设计 D01/D03/D05/D06/D08/D09。

## 传入与身份

complete 只从独立 `--context` 文件读取上下文。两语言分别以自己的冻结 c14n 实现严格解析原始 UTF-8，然后用自己的真实 Schema 引擎验证私有结构。重复键、非有限数、非法 UTF-8、非法数字域、缺项和未知属性为 `CONTEXT_INVALID`，退出 1；没有提供 context 为 `TRUSTED_CONTEXT_REQUIRED`，退出 2。受测实例不能提供或替代信任数据。

根必填 `fixture:true`、`suite_revision:"0a-core-r1"`、`current`、`business`、`fake_assets`、`snapshots`、`histories`、`grants`，`view` 可选。对象内部结构均见同一私有 Schema，不是请求端可以自报的生产权限。

| 字段 | 固定意义 |
| --- | --- |
| current | 六分量资产身份 scope_type/scope_id/app_id/module_id/asset_type/asset_id，加可信 stable_id、active_version、用途 purpose |
| fake_assets | `{ref,content}` 表；完整七分量身份唯一，digest 是单独第八个引用键。content 是实际 Spec 或明确 Fake 注册内容 |
| snapshots | `{ref,registered}`；引用对应的可信登记快照。其外壳闭合验证，Spec 留给公共契约校验，以免把无效依赖正文误报为 context 损坏 |
| histories | `{target,previous_ref,business_history,deleted_node_ids}`；按六分量 target 绑定，previous_ref 固定历史正文，business_history 使用 BUSINESS.md 结构 |
| business | enabled_types/generators/index_capabilities/money_rules/history；前四表须等于实际固定 FieldTypeRegistry 的同名内容（types 对应 enabled_types） |
| view | capability_registry_ref 与 deleted_node_ids；引用可显式为 null 表示缺少静态依赖，不能因此通过 complete |
| grants | side 为 source/target，source_app_id、完整 target 引用和 purpose 全匹配；缺任一方拒绝跨应用引用 |

`business.history`、`view.deleted_node_ids` 保留 Task2/3 的静态接口兼容投影。CLI 实际将 histories 中精确绑定的数据传给静态模块；没有绑定就不借用其他资产历史。引用依赖的旧登记正文不拿当前草案历史做迁移比较。used_fields 缺失表示未知，空数组表示可信 Fake 明确已知未用；样本不能证明生产数据全量无截断。

资产身份的所有分量都参与命中；null app/module 必须存在。内部稳定 UUID 来自该精确身份的 snapshot/current，一对一核对，不能把同名 code 当别名，也不采用 current/latest 版本代替 pinned version。根入口与递归依赖都在同一有效 scope/app/module/asset_type 中核验 code、稳定 UUID 与资产身份的一对一映射；同资产历史版本可复用原代码和 UUID，其他模块可合法同名。

## 内容、历史与作用域

AssetRef、Registered.checksum 均为冻结 c14n 对 **Spec** 复算的摘要。审计、生命周期或 trace 变化不改变此摘要，但仍必须与独立 trusted snapshot 一致。Fake FieldTypeRegistry/ComponentRegistry/CapabilityRegistry/Capability/SequencePolicy 使用其完整 `content` 为前像；其中的 fixture、规则、propsSchema/inputSchema 等也在摘要内。这些 Fake 内容没有生产运行时含义。

各语义模块先验证当前正文；引用阶段按依赖顺序解析正文。Business/View 依赖实际运行公共结构与静态校验，错误位于 `<引用路径>.spec...`，并保留 `references` 阶段。没有 Workflow/Permission 校验器时拒绝，不能以结构通过冒充依赖通过。精确身份重复是 context 配置错误；递归路径发现循环则以 `REFERENCE_INVALID` 拒绝。只缓存完整不可变内容或当前调用内已验证的精确身份，不用名称做跨 context 缓存。

View 从 businessSchemaRef/componentRegistryRef、声明为 ActionRef/DataQueryRef 的对应能力引用槽，以及调用 input/params 中由固定 Capability.inputSchema 明确声明的位置读取引用。引用意图来自标准 Common AssetRef/CapabilityRef 的 $ref，或可信 const 中完整八键引用绑定（包括嵌套对象/数组）；不依据实例字段组合或枚举词猜测引用。普通受控数据即使包含 asset_type/asset_id/capability_code 也不产生依赖。inputSchema 匹配不替代真实 Common 结构及统一身份、作用域、存在性、摘要、登记和依赖正文校验。

声明投影保留离线资源的本地 $defs/$ref、base URI、JSON Pointer 转义与循环防护；allOf 包装及对象/数组应用位置仍传递声明，anyOf/oneOf/if/contains 的适用性由锁定的真实 Schema 引擎判断。unevaluatedProperties 使用引擎求值信息，并排除当前关键词自身的标注：已求值普通数据不被重新解释，未求值且声明为引用的位置仍解析。Python 使用锁定 jsonschema 的求值辅助函数；Node 使用 Ajv evaluated 信息，在私有资源副本中去掉当前关键词。Node 完整注册定义先按原 strict 模式编译，固定版本的投影查询子片段仅关闭无法继承父级 type 的 strictTypes 编译提示（strictRequired 不变）；公共结构、私有 context、完整注册 Schema 仍 strict，未知 keyword/format/ref 仍失败关闭，且禁止输入修改。投影探针不承担当次输入最终合法性判断，不是全局放松 Schema 或新接受域。没有新增公开协议或私有声明关键字。

const 声明由同一真实 Schema 引擎先确认实例匹配后才展开位置，避免递归 View 尚未完成参数校验时读取不存在的成员或数组下标。不匹配不构成通过：既有完整 inputSchema 校验仍返回 VIEW_DATA_SOURCE_FORBIDDEN / VIEW_ACTION_FORBIDDEN；作为依赖时错误带 `<引用路径>.spec` 前缀并保持协议拒绝2。匹配 const 的引用仍须独立通过 Common 结构、精确身份、作用域、版本与摘要校验。

查询或动作参数按各自锁定版本解析，不要求等于 View 根 businessSchemaRef 或最新版本。i18n 文案容器仍完全不参与引用发现，正文保留原有文案结构和安全校验。

历史正文也在被差异比较消费前接受真实公共结构/静态校验。历史依赖错误在 CompiledDraft 使用 `base_version.spec...` 扩展路径；Spec 入口使用固定身份属性名 `schema_code.spec...`（其他契约对应固定 code 属性）定位该输入所绑定的历史资产。这里的 schema_code 是固定属性名，不是候选字段值；后缀描述解析后的历史正文，不表示输入的 code 字符串内有 spec 对象。普通依赖则以当前输入的实际引用槽为锚点；View 动态属性路径沿用 JSON 方括号转义，日志不插入任意 asset_id/code 值。

跨 tenant 一律拒绝；同 tenant 跨 app 需要 purpose 与两方精确授权；同 app 跨 module 仍须完整身份命中。PLATFORM_CONTROL 只允许本批固定 Registry/Capability/Sequence 等受控资源，app/module 为 null。Business.source_ref 可指向 TEMPLATE Business，递归检查其自身依赖，不让模板来源获得租户数据权限。

CompiledDraft.base_version 比较独立 current.active_version，已有活动基线时递归验证其精确引用及公共正文。已有基线的 Business 草案还必须提供与该 snapshot.ref 完全相同的 previous_ref 和非空 business_history；缺失或空历史在 base_version 报 REFERENCE_INVALID/退出2，不能当作新建而跳过兼容性检查，不填造 used_fields 或其他使用证据。Registered 比较其精确历史 snapshot 的身份/version/base/audit/lifecycle/source_ref/checksum，并核对 snapshot 外壳与 ref/current 身份，SUPERSEDED 可读取；根历史读取不套用依赖专用的 PUBLISHED/SUPERSEDED 限制，DRAFT 等仍须满足自身审计结构。Spec 入口不验证外壳/base，也不声称取得发布批准。兼容升版后的旧 Business 引用仍按原版本解析；组件/能力的停用定义则按已实现静态注册规则拒绝。

按批准 D05 的主控裁定，Spec 不要求当前活动 snapshot 仅因 active_version>0 而存在；CompiledDraft 仍要求该活动基线存在，Registered 仍读取自身历史 snapshot。Spec 真正消费的显式历史、精确依赖、作用域和代码唯一性检查仍保留。

PRD §7.27 已有 ASSET_* 错误码；本套件按批准 D08 的映射使用 REFERENCE_INVALID/REFERENCE_NOT_FOUND/REFERENCE_DIGEST_MISMATCH，作用域沿用 REFERENCE_OUT_OF_SCOPE，能力引用保留 VIEW_* 专用码，不声称这些规范错误码原先不存在。

## 配置失败与复验

已提供的 Component.propsSchema 和 Capability.input/output/errorSchema 用真实引擎装载，并检查未知关键字、format 和离线引用，包括未使用定义。无效注册 Schema 为 `REGISTRY_CONFIGURATION_INVALID`，退出 1。缺少某能力正文/Schema 属依赖不可用，不能用宽松 true 替代。公共 Business/View 正文非法则是协议拒绝 2。

原 PRD §7.14/7.25 `*-original.json` 保留演示 digest，只作结构样例。`*-fake.json` 和对应完整用例绑定实际 Fake 内容。生成器只物化独立输入/字面期望，不执行校验器、不由输出反推 expected；保留故意篡改的摘要。过去的 `static-valid-reference-stage-pending` 正例已转为 `complete-fixed-fake`，不再把“依赖不可用”统计为完整正例。

```sh
.venv/bin/python tests/meta-schema/generate_business_fixtures.py
.venv/bin/python tests/meta-schema/generate_view_fixtures.py
.venv/bin/python tests/meta-schema/generate_integration_fixtures.py
.venv/bin/python -m unittest discover -s tests/meta-schema -p test_integration.py
.venv/bin/python tests/meta-schema/test_conformance.py --suite 0a-core-r1
```

Task5 仍需完成真实主 bundle loader 对未引用错误定义的拒绝（独立 verify_bundle 已检查，但不是实际 loader 的全部保证），并生成与源码提交绑定的新证据及 CI。没有验证真实注册分配、认证/批准、权限运行时、渲染、迁移执行、发布四对象或部署。

## 最终整分支审查修复边界

FR-I1 对可信 Registry 独立路径补齐预检：Capability 的 inputSchema/outputSchema/errorSchema 和 Component propsSchema 都严格编译完整根及全部未使用、嵌套 `$defs`；完整 `$ref` fragment 按第一个 `#` 分割后保留剩余内容，并检查实际目标。非法 pattern 或不存在的完整目标即使没有实例消费，也以 `REGISTRY_CONFIGURATION_INVALID` / exit 1 失败；合法未使用定义与转义指针仍可装载。公开 bundle 的先前修复不替代此私有路径责任。

FR-I2 要求已有活动版本的 View CompiledDraft 提供同一完整资产身份、活动版本及摘要的删除历史；缺失或属于别的 View 时返回 references / `REFERENCE_INVALID` / `base_version`。绑定的空 `deleted_node_ids` 合法，绑定非空集合用于拒绝旧 ID 复用。内部投影以 null 表示未知或不适用，不将未知转换为“已经证明为空”；新草案不要求虚构旧历史。Spec 不强制未消费活动快照，历史 Registered 及固定依赖按自身快照验证，均不借用当前 View 的删除集合。

FR-I3 在单次同步 CLI 调用内按实际 inputSchema 对象身份保存独立投影引擎，不能按能力名称、`$id` 或上下文名称替代精确 Schema 身份。公共资源在该调用内复用核验结果；每个独立引擎仍先严格编译完整根，再仅对片段 probe 设置 `strictTypes:false`，主校验器和 `strictRequired` 保持严格。`unevaluatedProperties` 辅助引擎复用已编译检查，但每个实例重新计算适用性和已评估属性；const 仍先检验匹配再投影引用。调用结束丢弃所有此类缓存，下次重新核验资源，15 秒 CLI 与 10 秒内部 c14n 预算不变。

FR-I4 的独立词法裁定、Unicode 对照与适用位置完整列于 [VIEW.md](VIEW.md)。这些机制仍是无副作用的参考校验，不代表真实 Registry 签名、资产发布、能力执行或生产门禁验收。
