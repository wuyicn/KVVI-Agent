# View 静态契约与固定 Fake 资产

Task4 更新：本文件保留静态接口的来源说明；引用、作用域、历史与公共依赖正文已接入 [CONTEXT.md](CONTEXT.md) 的完整流程。当前静态正例改为 complete-fixed-fake；下文“引用阶段待 Task4”的语句仅描述 Task3 交接时状态。Common 日期格式与 Digest LF 差异也已由 Task4 定向测试关闭。

当前实现覆盖 PRD v1.11 §7.18–7.25、方案 D04/D05/D07/D08 与 V01–V14、V16。它验证结构、属性、资源预算、静态类型和指定 Fake 内容；没有渲染、权限运行时、能力执行或发布批准。V15 不计为已测行为。

## 入口与阶段

Python `view.validate_view(spec, context, prefix)` 与 Node `view.validateView(spec, context, prefix)` 返回诊断数组，`semantic` 同时导出它们。直接调用也先执行 View 结构预检。前缀为空表示 Spec 根；`spec` 表示草案/登记对象中的正文。两种实现不修改正文或上下文。

三个公共入口保持 `Spec`、`CompiledDraft`、`RegisteredContract`。结构阶段允许动态的 `props/input/params` 对象，但所有识别出的六类安全引用仍由同一份实际 Schema 封闭校验。结构通过不代表属性已获注册表批准。静态阶段进一步使用精确注册组件 `propsSchema` 和能力 `inputSchema`，分别交给 jsonschema / Ajv 验证；没有另写 JSON Schema 解释器。

当前通用 `references` 阶段仍返回 `DEPENDENCY_VALIDATOR_UNAVAILABLE`。因此有效静态样例在共享 CLI 的 `complete` 入口必须失败关闭，其记录明确标记 `static-valid-reference-stage-pending`。Task 4 必须完成组合/作用域/历史检查后才可更新独立的完整入口预期，不能把静态无错误当成完整 PASS。

## Task 4 上下文接口

上下文是工具私有 Fake 数据，不是 ArtifactManifest 公共协议；由独立文件提供，不从受测实例获取：

```text
fixture: true
suite_revision: "0a-core-r1"
business: 既有 BUSINESS.md 的类型/金额/生成器/索引规则与历史上下文
fake_assets: [
  {ref: 完整 AssetRef 或 CapabilityRef, content: 精确资产正文}, ...
]
view:
  capability_registry_ref: 完整 CAPABILITY_REGISTRY AssetRef
  deleted_node_ids: [曾删除、不可重用的节点稳定 ID, ...]
```

`view_registry.resolve_asset/resolveAsset` 按除 digest 外的全部引用字段做精确匹配，恰好一条记录才命中；然后同时比较记录 ref 的 digest 与冻结 c14n 参考实现对 content 复算的 digest。没有同名猜测、latest、别名或租户 ID 替换。返回 `(content, status)` / `[content, status]`，status 为 `ok/missing/digest`。Business 字段来自 `spec.businessSchemaRef` 精确对应的正文，允许上层最终验证器解析明确锁定的历史版本；本模块不改成当前活动版本。

Task 4 需要验证上下文本身、Fake 标记、全部引用形状、资产类型/作用域/授权、同一身份的唯一性及历史完整性；把 `business` 规则表绑定到精确 FieldTypeRegistry/money 规则，并把 `view.deleted_node_ids` 绑定到当前页面身份。需检查引用资产自身的 Business/View 语义及其依赖。这里的空删除列表不证明真实世界没有删除历史。

合法平台 Registry 与租户 Business 的 scope_id 本来就可以不同。此模块不以租户 scope_id 比较平台引用，也不代替 Task 4 的跨租户、跨应用双向授权及历史版本规则。

## 固定资产内容

可复算生成源为 `tests/meta-schema/view_fixtures.py`；`generate_view_fixtures.py` 只物化独立输入、字面预期及其上下文，不运行校验器，也不从输出生成 expected。

ComponentRegistry content 包含 `fixture/version/state/components`。每个 component 包含 `componentName/version/state/description/propsSchema/bindingPositions/allowedParents/allowedChildren/maxChildren/viewTypes/loopSupported/fieldTypes/events/adapter`。组件自己的版本由固定快照锁定，不要求等于快照版本号。该 Fake 资产定义了 23 个基础 v1 组件：三页、Section/Grid、十种基础字段、Table/Text/Description/StatusBadge、四种系统动作；未登记 v1.1 控件拒绝。

属性保留原例的 `fieldBinding/labelMode/colSpan`。允许的引用位置由 `bindingPositions` 限定，字段控件另检查实际字段类型。父子关系、单页类型、最大子数、事件与循环能力分别检查。事件只接受组件声明的能力代码，完整行为身份仍须由 CapabilityRef 与固定快照共同验证。

这些具体 props、布局列数、父子配置、文本属性、假输出结构和行为元数据是**固定 Fake 资产选择**。它们不是给公共 ViewSchema 永久增加 PRD 未定义的上限，也不是平台管理员已发布真实组件的证明。

CapabilityRegistry content 包含 `fixture/version/state/members`，members 为完整 CapabilityRef 列表。七个能力为 `form.save_draft/form.submit/form.cancel/navigation.open_record/records.list/records.get/options.list`。每份能力 content 含：

```text
fixture, capability_code, version, state, category
inputSchema, outputSchema, errorSchema
authorization, scope, sideEffects, idempotency, retry, runtimeDigest
timeoutMs, rateLimit, maxResults, itemKeys, recovery, auditEvents
```

三份 Schema 均实际存在、封闭并可由两引擎装载。动作只验证输入，不调用实现。所有 Fake 能力 `sideEffects:false`，运行摘要来自标注为 Fake 的内容，不代表可部署代码。查询固定当前精确 businessSchemaRef；列表 pageSize 为 1–200，get 使用假 recordId，options 使用 FieldRef。返回使用 `{items:[{id,title}]}`，登记稳定键 `id`；错误使用 `{code:"FAKE_REJECTED",retryable:false}`。这些只是可复验测试契约。缺能力定义、缺固定快照、缺成员、内容摘要错误或动作/查询错类都拒绝。

## 安全、预算和诊断

显式栈先检查组件 500 节点/20 层及表达式 20 谓词/3 层，再进入递归 Schema。表达式混合 AST、缺根 type、所有出现的 all/any/not 分支均纳入预检，不能让隐藏分支进入引擎后才发生递归失败。每个根 SafeExpression 有 type，内层没有 type。

1 MiB 按 c14n 后 Spec 的 UTF-8 字节数，和外壳/原始缩进无关。queries 最多 20，maxItems 为 1–200。全部预算均包含恰好与 +1 样例，ASCII 与 emoji 字节边界独立覆盖。i18n key 1–128、文案 0–5000 按 Unicode 字符数计。BCP 47 验证覆盖 [RFC 5646 §2.1 和 §2.2.9 的 well-formed 语法](https://www.rfc-editor.org/rfc/rfc5646.txt)，包括普通、私用、祖父标签及重复 variant/singleton 拒绝；不查询实时 IANA 注册有效性，不改写语言标签大小写或正文。

先报告危险执行/数据源结构，再报告预算，然后是通用形状，最后是静态注册与类型检查；同阶段按路径 UTF-8、错误码排序去重。props/actions/input/params/i18n 动态键使用 JSON 引号方括号，数字对象键与数组下标有明确区分。注册 Schema 错误定位到其直接受控属性或输入参数，避免各引擎 oneOf/anyOf 分支错误文本泄漏；公共安全引用的结构错误仍保留具体子字段位置。日志不回显受测值。

扫描器拒绝 JSExpression/JSFunction、HTML/脚本/CSS/生命周期、包实现和任意请求实现结构，并在解释位置拦截明确字符串化函数、eval/动态导入、SQL 查询与 URL 请求文本。普通说明中的 SQL、GraphQL、指令式句子以及 i18n 中同名文案键仍作为数据。该扫描辅助不能证明对所有字符串攻击免疫，也不代替真实通道隔离、无 eval 的运行时或权限门禁。

### 最终审查裁定：固定扫描词法

本节是控制者在 FR-I4 修复前批准的第 17 项具体化，内部表名为 `view-static-lexical-r1`；不改变三个公共契约版本或套件 `0a-core-r1`。依据为 PRD §7.15.7、§7.21、§7.22 与 D07。D03 的安全 pattern 规则本身不授权扫描器采用某个宿主的 Unicode 行为，本节单独固定如下规则。

| 项目 | 精确规则 |
|---|---|
| 空白 | U+0009–000D、0020、00A0、1680、2000–200A、2028、2029、202F、205F、3000、FEFF；不含 U+0085、001C–001F、200B。所有扫描形状使用此集合，无宿主 `\s`。 |
| 大小写 | HTML/脚本 URI/数据源识别仅把 ASCII A–Z 转为 a–z，不做 Unicode casefold 或规范化。调用 token 的 `function`、`eval`、`Function`、`import` 保持精确大小写；`=>` 保持原识别规则。 |
| 调用 token 左界 | 字符串开头、上述空白，或 ASCII 非标识符字符。ASCII 续字符固定为 A–Z/a–z/0–9/_/$。其他邻接非 ASCII 字符视作文案前缀，不能按宿主 `\b/\w` 推断；命名 function 只识别 ASCII 起始 `[A-Za-z_$]` 及续字符。 |
| 所有字符串值 | 检查以 ASCII 字母开始的 HTML 标记形状、`<!>`、`<?>`、`javascript` + 空白 + `:`、`data` + 空白 + `:` + 空白 + `text/html`。不把自然语言单词当执行命令。 |
| props/input/params/condition | 检查左界成立的 function/eval/Function/import 调用形状，以及箭头形状。该规则只识别有限禁止形状，不能当作完整 JavaScript 解析器。 |
| params | 另检查从固定空白后起始的 HTTP(S) URL、SELECT/INSERT/UPDATE/DELETE 加空白、query/mutation 加 `{` 或 `(`。说明位置及 input 不因 SQL 单词触发此规则。 |
| i18n | 文案值遵守所有字符串值的 HTML/URI 规则；不受调用/箭头或 params 规则影响。键始终是数据，键中即使出现 `.props[` 也不能改变文案的适用位置。 |

因此 `汉eval(`、`javascript` + U+0085 + `:`、`javaſcript:`、`<K>` 为惰性文案对照；`eval(`、`JAVASCRIPT:`、`javascript` + U+FEFF + `:`、`<SCRIPT>` 在对应位置拒绝。这里只判定静态接受域；没有证明任何对照可执行，也没有把通过解释为渲染安全或权限批准。共享字面 fixtures 和实际 CLI 回归记录在最终修复证据中。

## 样例及复验

`inputs/view-prd-7-25-original.json` 是冻结 §7.25 完整 YAML 的逐值 JSON 转换，保留三处原演示 digest，仅用于结构验证。`view-prd-7-25-fake.json` 只重绑其业务、组件与提交能力三个引用到实际 Fake 内容摘要；上下文的 Business 正文来自既有 §7.14 Fake 样例。批量类型测试另加十种字段和停用选项，不混入原例。

```sh
PYTHONDONTWRITEBYTECODE=1 .venv/bin/python tests/meta-schema/generate_view_fixtures.py
PYTHONDONTWRITEBYTECODE=1 .venv/bin/python -m unittest discover -s tests/meta-schema -p test_view.py
PYTHONDONTWRITEBYTECODE=1 .venv/bin/python tests/meta-schema/test_conformance.py --suite 0a-core-r1 --group View
```

方法检查真实两语言结果、内存 spec/context 不变性及共享原始文件不变性。冻结 12 文件与原 O1 6 方法/17 向量另行重放；缺失的 v1.10 历史材料不计为本次新鲜证据。

Task 4 另须关闭控制者已复现的 Common Audit `date-time` 校验器缺失与 Digest 末尾换行问题，本任务没有修改 Common 或声称登记外壳完整安全。
