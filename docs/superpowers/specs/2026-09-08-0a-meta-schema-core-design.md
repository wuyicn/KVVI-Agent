# 0A 首批 Meta-Schema 技术方案 r1

| 项目 | 内容 |
| --- | --- |
| 状态 | 待方案评审；本文不构成实现验收或合并批准 |
| 日期 / 作者 | 2026-09-08 / Codex |
| 目标 | 将 BusinessSchema、ViewSchema、AppSpec 的约束转成版本化 JSON Schema、确定性语义校验和可重放用例 |
| 方案分支 | `design/0a-meta-schema-core`，起点 `684d00b6d6db3ae58df8d3f9814bd73a6fc9b472` |
| 权威基线 | [PRD v1.11](../../PRD-AI无代码平台设计-v1.11.md)，SHA-256 `d517617a0c500713897e7d6c88b5894d4c802e6362ecf68631ba88776750993b` |
| 授权边界 | [Go-0 签署第五节](<../../../评审/Codex v1.11 复评.md>)：允许进入 0A 契约试验 |
| 配套材料 | [条款与验收映射](2026-09-08-0a-meta-schema-core-traceability.md)、[本次验证记录](../../verification/2026-09-08-0a-meta-schema-design.md) |

## 1. 本次交付及范围

本方案拟交付三个逻辑契约的机器约束，版本保持 `business-schema/v1`、`view-schema/lce-safe-v1`、`app-spec/v1alpha1`。它们共同使用一份 AssetRef / CapabilityRef 定义，各自区分编译草案、正文和服务端登记快照的校验入口。

方案 PR 只增加本方案、条款映射及验证记录。方案审查完成、问题关闭并由项目负责人批准后，从最新 `main` 建立 `feat/0a-meta-schema-core` 实现分支。实现 PR 关联已经批准的方案提交；实现过程中的新增规范选择回到方案修订审查，不能通过改测试预期绕过。

首批实现包括：

- 共享引用定义及三份 JSON Schema；每份导出 `Spec`、`CompiledDraft`、`RegisteredContract`。
- Node 主校验器、Python 独立对照校验器，以及相同原始输入、固定预期和 Fake 上下文。
- 字段、页面、引用、默认值与表达式的静态语义检查；验证无副作用。
- schema 自校验、正反例、边界例、跨语言比较、新版证据生成和 CI 接入。

首批不实现 CRUD、DraftGraph 命令引擎、Vue 渲染器、权限运行时、发布系统或迁移执行器。Permission / Workflow 及发布四对象等剩余十份公开协议 Meta-Schema 仍属于后续 0A 交付；三个逻辑契约的不同入口不充当更多份已完成协议。v1.1 字段扩展仍按 PRD §7.8 留在 0C 按样例启用，本批只证明十种 v1 基础类型。

本方案沿用冻结 PRD。下文 D01–D09 是为机器落地提出的具体选择，均须随本方案批准；它们不能被表述为 PRD 原文已经逐字规定。若审查认定某项改变了已批准语义，须新增独立规范修订文件及相应证据，不能修改冻结 PRD、复评、索引或旧证据。

## 2. 方案选择

| 方案 | 收益 | 代价 / 结论 |
| --- | --- | --- |
| 三份 JSON Schema + 显式语义校验 + 固定 Fake 依赖 | 通用结构校验可复用；引用、注册表和历史规则有明确归属；两语言可独立执行 | 需要一份校验覆盖表；本方案采用 |
| 全部规则写入 JSON Schema 与校验器私有扩展 | 表面上只有一个入口 | 动态注册表、历史状态和摘要检查会依赖私有关键字，跨语言难以对照；不采用 |
| 先按 PRD 示例生成宽松 Schema | 生成速度快 | 未出现于示例的合法分支会遗漏，未知字段和越权输入可能被放行；不满足本次验收 |

格式拟固定为 JSON Schema Draft 2020-12：`$schema` 为 `https://json-schema.org/draft/2020-12/schema`。采用标准 `$defs`、`$ref`、条件分支和封闭对象；共享定义不手工复制。语义规则显式编码，不把 `uniqueItems` 当作“按 field_code 唯一”的实现。标准语义依据见 [JSON Schema Core](https://json-schema.org/draft/2020-12/json-schema-core) 和 [Validation](https://json-schema.org/draft/2020-12/json-schema-validation)。

Node 使用 Ajv 8 的 2020-12 入口；Python 使用 jsonschema 4 的 `Draft202012Validator`。实现 PR 固定实际依赖版本、锁文件和安装哈希，CI 使用 Node 22、Python 3.11；当前方案不宣称已安装这些依赖。两套引擎都读取同一份 Schema，Python 不是另抄一套 Schema。独立性来自校验引擎、语义实现和独立进程，结果必须与预先冻结的期望比较，不能只比较两边是否相同。[Ajv 方言说明](https://ajv.js.org/json-schema.html)、[Python 校验接口](https://python-jsonschema.readthedocs.io/en/stable/validate/)。

## 3. 文件及版本身份

以下均为拟新增的实现路径；本方案 PR 不创建这些机器文件：

| 路径 | 职责 |
| --- | --- |
| `contracts/meta-schemas/0a-core-r1/common.schema.json` | AssetRef、CapabilityRef、基本值与登记元数据共享定义 |
| `contracts/meta-schemas/0a-core-r1/business-schema.v1.schema.json` | BusinessSchema 的三个入口、字段分支、记录规则、布局和索引 |
| `contracts/meta-schemas/0a-core-r1/view-schema.lce-safe-v1.schema.json` | ViewSchema 的三个入口、节点树、六类安全引用 |
| `contracts/meta-schemas/0a-core-r1/app-spec.v1alpha1.schema.json` | AppSpec 的三个入口及版本化组合引用 |
| `contracts/meta-schemas/0a-core-r1/manifest.json` | 文件 `$id`、契约版本、依赖、本方案与基线摘要、每个文件 SHA-256 |
| `contracts/meta-schemas/0a-core-r1/README.md` | 安装、入口、验收命令、覆盖范围及版本规则 |
| `tools/meta-schema/node/`、`tools/meta-schema/python/` | `cli`、`structure`、`semantic`、`references`、`diagnostics` 模块与独立语义实现 |
| `tools/meta-schema/node/package.json`、`tools/meta-schema/node/package-lock.json` | Node 校验器及可复现依赖安装 |
| `tools/meta-schema/python/requirements.lock` | Python 校验器依赖，固定版本及分发包哈希 |
| `tests/meta-schema/0a-core-r1/cases.json` | 逐例登记原始字节文件、入口、Fake 上下文、预期阶段 / 错误码 / 路径 |
| `tests/meta-schema/0a-core-r1/inputs/`、`tests/meta-schema/0a-core-r1/contexts/` | 独立原始输入及 Fake 注册表、历史和作用域上下文 |
| `tests/meta-schema/test_conformance.py` | 黑盒运行两种校验器并比较结果、退出码和输入不变性 |
| `tools/meta-schema/verify_bundle.py`、`tools/meta-schema/record_evidence.py` | 核验所有本地引用与文件摘要；生成独立本次运行证据 |
| `evidence/meta-schema/0a-core-r1/` | 按 run ID 新建机器报告、绑定清单和验证输出摘要 |
| `docs/contracts/INDEX.md` | 后续契约版本索引；不覆盖冻结的 c14n 证据索引 |
| `.github/workflows/meta-schema-checks.yml` | 新增协议验收工作流；保留现有基线和敏感信息检查 |

`0a-core-r1` 是 Schema 套件修订号，不能混成业务对象发布 `version` 或 `contract_version`。首版批准后修改任何接受域、错误语义或共享定义，都创建新修订目录及新证据。证据登记生成它的源码提交和工具链，不使用浮动 `latest`。manifest 绑定四份 Schema 及其依赖的原始文件字节，不包含自身哈希；manifest 自身的哈希由外部运行证据绑定。

各文件 `$id` 使用不需要部署站点的绝对 URN，例如 `urn:kvvi:meta-schema:0a-core-r1:business-schema-v1`；其他三份分别以 `common`、`view-schema-lce-safe-v1`、`app-spec-v1alpha1` 结尾。URN 仅作 Schema 资源标识，不是业务 AssetRef 的资产 ID。加载器先核验 manifest，再把 `$id → 本地文件` 加入离线注册表；重复 `$id`、未知资源或摘要不符时终止。禁止网络拉取和猜测路径。[Python 离线引用注册表](https://python-jsonschema.readthedocs.io/en/stable/referencing/)。

## 4. 校验顺序与职责

```text
原始 UTF-8 JSON 字节 + 调用者指定的入口 + 独立可信/Fake 上下文
  → 严格解析与 kvvi-json-c14n/v1 输入域检查
  → 入口与 JSON Schema 结构校验
  → 静态语义、资源上限和注册表属性校验
  → 固定引用、摘要、基线版本与历史检查
  → 在本次校验范围内有效 / 带固定诊断的拒绝
  → 后续平台另行执行 Policy、编译、审批和发布门禁
```

“Meta-Schema 校验器即 Linter”沿用 PRD §7.13；本方案将其内部检查分层，不把 Policy Checker 改名为 Linter。标准 JSON Schema 负责类型、必填、枚举、对象封闭和局部数量范围。命名唯一性、两个属性之间的数值关系、真实日期、受限模式、表达式类型、节点总量、引用解析、历史差异和摘要一致性由 Linter 的语义部分负责。Policy、每次业务访问权限和发布批准仍是后续独立门禁。

Node 配置固定启用严格 Schema 检查；禁止类型强转、注入默认值和删除未知字段（`coerceTypes/useDefaults/removeAdditional` 均为 `false`）；不启用 `$data` 或自定义可执行关键字。Python 也不扩展出自动补值或宽松解析。未知 `format` 和 `$ref` 是装载失败，不能被静默忽略。字符串长度按 Unicode 字符而非 UTF-8 字节测量；UUID、日期和日期时间通过固定格式用例检验。[Ajv 配置](https://ajv.js.org/options.html)、[输入修改行为](https://ajv.js.org/guide/modifying-data.html)。

所有入口都接受原始字节，不能先用普通 JSON 解析丢掉重复键或舍入数值。首批工具只读调用冻结的 c14n 参考实现，再把已规范化结果交给结构引擎；同一公共向量仍须重放。此集成是参考校验工具消费 c14n 的证据，真实平台运行时仍需单独消费该向量并建立集成证据。

`spec` 摘要只覆盖最终生成的正文。业务字段的默认值、日期转换等运行时语义不能偷偷改变受测契约正文；规范化、校验、默认值应用是不同动作。注册元数据、签名和生命周期不得混入 `spec_digest`。

## 5. 需要随方案批准的机器化决定

### D01：草案入口与可信登记入口

三份文件的根入口均为 `CompiledDraft`：必须且只能包含 `contract_version`、`base_version`、`spec`，其中 `base_version` 为非负安全整数。另导出 `#/$defs/Spec` 和 `#/$defs/RegisteredContract`。不采用“草案或已发布对象二选一”的宽松根入口。工具命令行选择入口，实例内不能携带入口选择或信任开关；公开 Builder Gateway 仍只接收类型化命令。

拟将以下登记字段定为闭合结构：

| 字段 | 机器约束 / 来源 |
| --- | --- |
| `contract_version`、`spec` | 固定契约版本及对应 Spec |
| `schema_id` / `view_id` / `app_id` | 各自登记入口的 UUID 稳定 ID，由注册表分配；不得相互替代 |
| `scope_type`、`scope_id` | 三类作用域及非空可信 ID / 受控代码；服务端上下文决定 |
| `version`、`base_version` | 正 / 非负安全整数；登记分配与历史一致性由可信注册记录验证，草案当前基线检查见 D05 |
| `lifecycle` | `DRAFT/PENDING_APPROVAL/REJECTED/PUBLISHED/SUPERSEDED` |
| `canonicalization_profile` | 常量 `kvvi-json-c14n/v1` |
| `checksum` | `sha256:` 加 64 位小写十六进制；按 Spec 复算 |
| `audit` | 必填对象：`created_by/created_at/approved_by/approved_at/published_by/published_at/trace_id`，关闭未知字段 |
| `source_ref` | 仅 BusinessSchema 登记入口必填，可为 `null` 或 `scope_type: TEMPLATE` 的 `BUSINESS_SCHEMA` AssetRef；服务端记录模板来源 |

`audit.created_by` 为 UUID，`created_at` 为 UTC 日期时间，`trace_id` 为非空字符串；审批与发布的 ID/时间成对为空或成对出现，ID 为 UUID，时间为 UTC 日期时间。`PUBLISHED/SUPERSEDED` 要求审批和发布两对均非空；其他状态两对为 null。`REJECTED` 的拒绝事件由独立审计记录保留，不能把 approved 字段当作拒绝记录。这是登记快照形状，真实性仍须与独立可信上下文核对；语法合法不能证明身份真实或审批有效。

PRD 对审计元数据使用概念描述，AppSpec 未列全登记外壳；本节是明确补充，不声称逐字抽取。共同外壳放在共享定义，最终各入口以 `unevaluatedProperties: false` 关闭组合后的未知属性；不在可扩展中间定义过早使用 `additionalProperties: false`。

### D02：必填、默认值和十种字段分支

`query` 及其中三个布尔键均必填；缺失由结构校验拒绝。PRD 中“默认 false”由 Draft 编译器生成时补齐，不由 Linter 补齐。`required: true` 与 `nullable: true` 不可并存。`deprecated` 可省略，解释为 false；契约字节保持原样。

`fields` 按 `type` 做十个互斥分支，`constraints/type_config` 逐分支封闭。无参数的类型不接受任意配置字典。`default` 的允许类型与字段匹配，并在语义层检查其范围、精度、选项成员资格和 null 规则；新增记录时才应用默认值。显式 null 不等于缺失。

`SYSTEM` 保留为合法枚举，但本批只接受 Fake 注册表明确登记的字段生成器绑定；没有绑定就拒绝。不在字段上增造 `generator_code`。`record_number` 通过独立单号策略引用表达，不允许 `fields` 重复声明编号字段。

### D03：参数位置、精确值和安全模式

| 类型 | `constraints` 允许键 | `type_config` 允许键 |
| --- | --- | --- |
| short_text | `min_length/max_length/trim/pattern` | 无 |
| long_text | `max_length` | 无 |
| boolean | 无 | 无 |
| integer | `minimum/maximum`（安全整数） | 无 |
| decimal | `minimum/maximum`（十进制字符串） | `precision/scale` |
| money | `minimum/maximum`（amount 的十进制字符串） | `currency_mode/currency`，必填且模式为 FIXED |
| date | `minimum/maximum`（有效日历日期） | 无 |
| datetime | 无 | 无 |
| single_select | 无 | `options`，必填 |
| multi_select | `max_items` | `options`，必填 |

这是对 PRD 未逐一命名的日期边界和集合数量参数的具体化。字段未使用的配置对象可以省略；出现时只能含对应表格登记的键。decimal 的有效 precision/scale 取显式值或 PRD 默认 18/2，检查范围及 `scale ≤ precision`，不写回实例。枚举选项的四个键 `code/label/order/enabled` 必填；order 为安全整数，code 唯一，options 数量 1–200。multi_select 的 max_items 默认 20、范围 1–50。

十进制字符串采用 `^-?(0|[1-9][0-9]*)(\.[0-9]+)?$`：拒绝加号、前导零、指数和数值 token；保留字符串的小数位，不替使用者舍入。minimum ≤ maximum、默认值落界和精度比较使用精确十进制表示。money 不实现货币计算，币种及小数位来自固定 Fake money-core 规则表；缺少规则时不作“有效金额”的通过结论。

date 为真实 `YYYY-MM-DD`；datetime 值采用带时区的 RFC 3339 常用子集，明确拒绝闰秒，登记 audit 时间限定 `Z`；业务 Runtime 将值转换为 UTC 的动作属于后续实现。这一子集选择必须被审查，不能作为 PRD 对所有 ISO 日期时间的现成限制。

安全 `pattern` 只允许锚点、字面字符、字符类、常用字符转义及单原子量词 `?/*/+/{m}/{m,n}`；不接收分组、选择、前后视、反向引用、递归、内联标志或重复量词。长度沿用 200 字符。先按固定语法检查，再用线性匹配实现；禁止把用户模式直接交给宿主回溯引擎。该最小子集属于待审具体化，未来扩充须新增套件修订与用例。

### D04：两种表达式 AST 与计数

Business 记录规则使用 `{rule_code, when?, assert, message}`，assert 必填；`when` 缺失表示无条件检查。Expr 为以下互斥形状之一：`{field, operator, value}`、`{field, operator}`（仅 is_empty/not_empty）、`{all: [Expr, ...]}`、`{any: [Expr, ...]}`、`{not: Expr}`。all/any 不允许空数组。

View 顶层为 `{type: "SafeExpression", ...Body}`；Body 的谓词用 `left/operator/right`，left 仅为 FieldRef，right 为类型匹配的静态值；is_empty/not_empty 省略 right。内部组合节点和叶子不要求再次带 type，以兼容 §7.22 和 §7.25 的例子；其他多余键拒绝。all/any/not 不能与谓词分支同时出现。

每个表达式根深度为 1，经过一个组合边加 1，最多 3 层；谓词叶子最多 20 个。Business 一条记录规则的 when 与 assert 合计最多 20 个叶子，各自深度单独计算；View 每个 SafeExpression 单独计算。比较只在字段类型允许时执行：eq/ne 为同类型相等，gt/gte/lt/lte 限可排序标量，in/not_in 的右值为同类型候选数组，is_empty/not_empty 不接受右值。集合成员与字段值相等不能混用；详细期望逐例登记。

`loopArgs` 拟固定为数组 `["item", "index"]`，只可在有 loop 时出现；省略时使用同样固定别名。DataBindingRef 的 queryCode 必须存在于根 queries，itemKey 为查询结果中已登记的单层稳定键；不接受动态路径。

### D05：共享引用及可信上下文

AssetRef 必填八键原样取自 PRD §7.27。app_id/module_id 可 null 但不能缺失，非 null 时是非空稳定字符串；不得擅自要求所有 asset_id 都是 UUID，因为 PRD 示例使用稳定代码。CapabilityRef 仅以 capability_code 替换 asset_id，asset_type 固定 CAPABILITY。三个 Schema 的本地 `$defs.AssetRef` 引用 common 的同名定义；View 的 `$defs.CapabilityRef` 直接引用 common 同名定义，ActionRef.actionRef / DataQueryRef.queryRef 再直接 `$ref` 本地定义。

引用槽通过相交约束固定 asset_type，不产生宽松备选。注册表按完整 `(scope_type, scope_id, app_id, module_id, asset_type, asset_id或capability_code, version)` 解析，再核对 digest；不按名称猜测或获取 latest。样例中的 general_item 等 code 是 Fake 注册表明确登记的资产 ID，与内部 schema_id 的映射需一对一，不是失败时的别名兜底。

独立上下文提供当前作用域、登记快照、能力/组件/字段类型表、历史版本、已删除 ID 和显式跨应用用途/授权集合。默认拒绝跨租户；合法 PLATFORM_CONTROL 注册表引用及 TEMPLATE 来源不能被“scope_id 必须等于租户”误杀。跨应用引用要求双方授权，缺任一方即拒绝。

Fake 上下文使用明确的测试标记并绑定摘要，不能从待校验实例中的同名字段获取。CompiledDraft 的 base_version 必须匹配当前活动版本；RegisteredContract 是既存快照，检查其身份、登记版本、历史基线和内容摘要，不要求旧快照的 base_version 等于当前活动版本，否则会错误拒绝合法 SUPERSEDED 版本的读取。Spec 单独入口只验证正文及其引用，不宣称基线或外壳已验证。本批不实现密码学审批签名验证，也不把登记入口通过解释为真实发布批准。

### D06：AppSpec 闭合结构与内部路由

CompiledDraft 的 Spec 必填 `app_code/name/businessSchemaRefs/viewRefs/navigation/workflowRefs/permissionRefs/automationRefs/integrationRefs`；不接受其他键。app_code 采用同一稳定机器代码格式，name 长度 1–80。各数组可为空以支持初始组合草案；automationRefs/integrationRefs 始终为空。

引用槽固定为对应资产类型。navigation 每项必须且只能含 `route_code/path/viewRef`；route_code 使用机器代码规则。拟限定 path 为 `/` 或以 `/` 开头的 ASCII 字母、数字、下划线、连字符路径段；不允许尾斜线（根路径除外）、空路径段、点段、反斜线、百分号编码、查询串、片段及外部地址。此规则是对“内部受控路径”的待审具体化。

route_code 与 path 分别唯一，navigation.viewRef 必须与 viewRefs 中某条完整引用完全一致。每个 View 的业务契约必须出现在 businessSchemaRefs 中且版本与摘要一致；不按文件名、同名对象或业务 code 推断。同一资产同一版本重复引用拒绝，同一资产多版本组合未获明确语义前也拒绝。

Permission / Workflow 非空引用可以通过结构检查，但完整语义通过还需要对应契约校验器。首批没有这两个实现时返回 `DEPENDENCY_VALIDATOR_UNAVAILABLE`，不得用只返回 true 的桩声称组合闭合；首批通过样例使用空引用。结构通过和依赖未验证须分别记录。

### D07：组件与能力属性的二次闭合

ViewNode 自身封闭；props、actions、ActionRef.input、DataQueryRef.params 的键随已固定的 Registry 而变化，不能只用全局自由对象校验。语义检查解析 Registry 后，对每个属性/事件及参数应用闭合的对应 Schema，检查字段类型适配、允许父子关系、页面类型、loop 支持和动作/查询类别。

本批 Fake 资产覆盖三种页面、基础字段、布局、展示及四个系统动作；v1.1 专属组件只作为拒绝/未启用样例。能力 fixture 固定 PRD 的四个动作与三个查询名称，登记输入输出的测试结构和摘要，所有处理无副作用；不写真实 URL、认证头或数据库连接。

meta.description / preview_note 拟为纯字符串，tags 为纯字符串数组；i18n 为 locale 到文案字典，locale 按 BCP 47 语法校验，key 长度 1–128，文案长度 0–5000，至少支持 zh-CN。不要求所有页面必须包含 i18n 字典。文本始终作为数据，不按出现“SQL”或“忽略指令”等单词就推断为可执行代码；安全拒绝针对被禁止的结构、解释位置和 HTML/脚本内容，扫描器不能替代通道隔离。

结构检查允许动态键的位置必须标记其依赖校验责任。缺组件/能力定义或固定 CapabilityRegistry 快照一律拒绝；不提供“只要有 CapabilityRef 就通过”的捷径。Fake 的 manifest 依赖上下文是测试工具内部数据，不冒充尚未实现的 ArtifactManifest 公共契约。

### D08：限额与诊断的唯一口径

View 大小按经 c14n 规范化后的 `spec` UTF-8 字节数计，1 MiB = 1,048,576 字节；该计量选择须审查。根组件深度为 1，总节点最多 500，组件深度最多 20；maxItems 1–200。先按显式栈检查组件树与表达式预算，避免递归栈报错替代协议错误。

测试进程的超时、资源耗尽或工具异常作为执行失败退出 1，证据不得记成预期拒绝。通用传输大小保护只属于工具运行条件，不得悄悄改成 c14n 输入域的新限制。

诊断继续使用 PRD 的 `{valid, errors:[{code,severity,path,message,suggested_fix}]}`。按首个失败阶段停止后续检查；同阶段错误按 UTF-8 路径、错误码排序并去重；比较 `(code,severity,path)`，不比较宿主引擎的自由文本。路径沿用 `spec.fields[3].field_code`，动态属性以 JSON 引号方括号转义。错误和日志不回显输入值。

已登记错误码优先按 PRD §7.13、§7.25 映射；以下为拟新增、必须在实现前登记的缺口补全：

| 新代码 | 唯一用途 |
| --- | --- |
| `CONTRACT_SHAPE_INVALID` | 通用入口、必填、外壳或基础类型不合法，且无更专用代码 |
| `REFERENCE_INVALID` | 通用 AssetRef 结构不合法；CapabilityRef 使用已有 VIEW_CAPABILITY_REF_INVALID |
| `REFERENCE_NOT_FOUND` | 结构合法但精确通用引用不存在 |
| `DEPENDENCY_VALIDATOR_UNAVAILABLE` | 本批尚无所依赖协议的实际校验器 |
| `APPSPEC_INVALID` | 应用组合、路由唯一性或内部路径不合法 |
| `CONTRACT_CHECKSUM_MISMATCH` | RegisteredContract 的 checksum 与 Spec 复算结果不同 |
| `TRUSTED_CONTEXT_REQUIRED` | 完整语义入口缺少独立可信 / Fake 上下文 |

通用引用摘要不符沿用 `REFERENCE_DIGEST_MISMATCH`，能力摘要不符沿用 `VIEW_CAPABILITY_DIGEST_MISMATCH`；越作用域、基线冲突、未知字段也沿用原码。已识别的禁代码、禁数据源等安全结构先报专用码，不将未知属性静默移除。实现前在 cases 中加入同时触发多个规则的优先级样例。

### D09：验收证据与发布判断分离

拟提供两个 CLI：Node `tools/meta-schema/node/cli.mjs`、Python `tools/meta-schema/python/cli.py`；参数为 `--contract`（三个固定版本之一）、`--entry`（compiled-draft/spec/registered）、`--checks`（structure/complete）、`--context`（complete 必需，可信调用方传入测试文件）。输入从 stdin 读取，标准输出仅一个 JSON 结果。

输出包含工具包修订、入口、checks、input_sha256、`validation`（上一节的 PRD 结果结构），以及 `release_approved: false`。structure 成功只说明结构合法；complete 还要求本批所有语义和依赖检查通过。无权限或发布服务的证明不在该结果范围内。实例拒绝退出 2，成功退出 0，工具/上下文文件损坏等执行故障退出 1。

证据按 `evidence/meta-schema/0a-core-r1/<run-id>/` 新增。记录基线、方案及源码提交、Schema/manifest/输入/上下文/期望/工具链的路径与 SHA-256、安装锁文件、逐例两语言结果、命令退出码、测试数量及日志摘要。逐例清点无重复无缺失，两边结果相同且与独立预期相符才记 PASS；任一异常或未覆盖必要行都不得总体 PASS。报告不覆盖自己计算自身摘要；报告摘要保存在外部验证记录，避免循环。

## 6. 实现顺序与验收

方案批准后编写可执行的逐任务实施计划，并在实现 PR 中按以下顺序交付。每个任务的用例先来自条款映射和已批准 D01–D09，再写实现；增加未登记行为时先补审规范。

| 任务 | 可独立审查的产物 | 首先证明的失败 / 完成条件 |
| --- | --- | --- |
| T1 共享定义与入口 | common + 三份入口骨架、离线装载、自校验和两引擎测试环境 | 缺 app_id、外壳注入、未知 Schema 引用必须失败；固定合法完整引用通过 |
| T2 BusinessSchema | 十种字段分支、索引、布局、记录规则及独立语义校验 | 完整 PRD 示例结构通过；类型错配、重复代码、精度/日期/布局边界全部按预期拒绝 |
| T3 ViewSchema | 三类页面、六类安全引用、Fake 组件/能力及树检查 | §7.25 示例结构通过；未知组件/属性、伪能力摘要、21 层、501 节点、代码注入失败 |
| T4 AppSpec 与组合 | 完整固定引用、路由、Fake 作用域及跨契约解析 | 通用事项三契约闭合；陈旧摘要、缺 BusinessSchema、跨租户或缺授权失败 |
| T5 证据与 CI | 冻结 cases、逐例跨语言报告、安装锁、新工作流与运行说明 | 两语言接受/拒绝和诊断均匹配独立期望，全部必要映射行有用例，冻结清单不变 |

实现的预期复验命令如下；本次未运行这些尚未存在的工具，不能把预期结果登记为已通过：

```sh
npm ci --prefix tools/meta-schema/node
python3 -m venv .venv
.venv/bin/python -m pip install --require-hashes -r tools/meta-schema/python/requirements.lock
.venv/bin/python tools/meta-schema/verify_bundle.py --suite 0a-core-r1
.venv/bin/python tests/meta-schema/test_conformance.py --suite 0a-core-r1
.venv/bin/python tools/meta-schema/record_evidence.py --suite 0a-core-r1 --new-run
shasum -a 256 -c docs/baselines/prd-v1.11-go0.sha256
PYTHONDONTWRITEBYTECODE=1 python3 protocol/kvvi-json-c14n/v1/evidence-sets/prd-v1.11/tests/test_conformance.py
```

成功条件：至少覆盖配套映射的每个必要条款组、每种字段和页面的正例、每个封闭对象位置的未知字段、每个数量界限的边界内外、每个已实现错误码的定向负例及多错误优先级。没有确切期望的测试不得以“两实现一致”替代。新增 CI 工作流成功后再按仓库流程审查 required checks 是否需要更新，不能自动变更 GitHub 保护规则。

已有 O1 向量的成功只证明 c14n 参考套件；本批新测试成功只证明 Schema/Linter 的声明覆盖。Schema 通过、Policy 通过、真实权限校验、编译预览和正式发布应分别留存证据。

## 7. 审查、批准与回滚

Codex 负责方案及实现；建议 Deepseek 独立审查结构分支、表达式与对抗输入，Kimi 独立核对条款映射、遗漏及三契约引用一致性。该分工是建议，尚未派发；评审文件由实际评审者独立出具，作者自审不标成独立复评。

方案审查重点为 D01–D09 是否准确、需要另立规范修订的项是否已经处理、首批 scope 是否可独立验收。所有严于当前实现且未关闭的有效意见均保留，按来源、严重性、证据、采纳决定和关闭用例登记。负责人批准须指向具体 PR/提交；不得用绿色 CI 或模型票数替代。

合并前所需结果：方案自审完成、相关 PR 审查完成、必要问题关闭、项目负责人明确批准。方案批准只允许进入其实现；实现验收也不批准部署、真实数据或真实支付。

本次只新增文档，回滚可通过独立 PR 撤回这批新增文件；冻结基线始终不动。后续实现版本停止采用时从后续索引撤销活动指向，保留已引用的旧 Schema、向量和证据；不得原地改旧摘要。
