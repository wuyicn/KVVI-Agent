# BusinessSchema 静态契约（Task 2）

Task4 更新：本文件保留静态接口的来源说明；引用与历史已接入 [CONTEXT.md](CONTEXT.md) 描述的完整工具流程。当前共享静态正例已绑定精确 Fake 资产并以 complete 成功验收，下文“待 Task4/引用阶段拒绝”的表述仅描述 Task2 交接时状态。

范围是 `business-schema/v1` 的十种 v1 字段类型、查询与索引、布局、记录规则、固定 Fake 历史差异分类。真实依赖解析和历史身份绑定仍由 Task 4 负责。有效静态例的 CLI `complete` 继续拒绝于引用阶段；不能将此结果称为三契约闭合、0A 完成或发布批准。

规范来源为冻结 PRD v1.11 §7.3–7.14、已批准方案 D02–D04/D08，及本次实施中的主控裁定。没有修改冻结源、旧机器证据或逻辑契约版本。

## 结构、值与纯比较

实际 Draft 2020-12 引擎执行结构验证。Field 以十个互斥 `if/then` 类型分支封闭 `constraints/type_config`；所有类型错误、未知键、必填项均来自引擎结果。`default: null` 的 nullable 冲突、真实日期和精确范围由静态阶段检查。动态属性路径使用 JSON 引号和控制字符转义。金额默认值内部未知属性仍报告具体属性路径；类型错误统一定位到 default。

十进制值保持字符串；比较按符号、整数位数、整数与补零小数顺序进行，绝不转为宿主浮点或依赖 Decimal 默认精度。precision/scale 缺省为 18/2，整数有效位数不超过 precision-scale；保留原小数位且不舍入。money 使用独立 Fake money_rules 的 precision/scale 和固定币种，不实现 money-core 运算。日期检查真实日历；datetime 接受带时区、秒和任意非空小数位的 RFC 3339 常用子集，拒绝闰秒和缺时区，不改写为 UTC。

`values.valid_typed_value(field, value, context, constraints=False)` / Node `validTypedValue(field, value, context, {constraints:false})` 为 Task 3 提供类型检查，`expressions.validate_operand(...)` / `validateOperand(...)` 为独立于 AST 键名的比较检查。默认值只能选 enabled 选项；纯读取谓词可以比较已登记但停用的选项，仍拒绝未知代码。`in/not_in` 的右值是同类型候选数组，多选字段的一个候选本身也是选项数组。

有序谓词允许 `short_text/boolean/integer/decimal/money/date/datetime/single_select`；long_text/multi_select 不允许。boolean 与整数不互转。此处只验证 AST 的类型，不执行记录规则或承诺运行时布尔排序结果。

规则每根深度从 1 计、上限 3，when+assert 共最多 20 叶。真实结构引擎之前先用显式栈检查预算，防止递归引擎资源异常替代协议拒绝；这是 `structure` 安全预算阶段。完整 AST 形状仍由 JSON Schema 检查。静态表达式模块也独立检查相同预算。CLI fixture 的 `expected_stage` 独立登记结构/静态/引用阶段；Task 4/5 将把实际阶段加入 CLI 并正式比较，目前测试不声称已验证不存在的实际阶段字段。

## 安全模式和布局具体选择

pattern 只接受 D03 的锚点、字面字符、字符类、常用转义和单原子量词；用户模式永不传给宿主正则引擎。解析器保留量词界限，匹配器按输入长度截断计数，使用前缀和求可达位置；时间上界为模式长度乘输入字符数，不展开巨大量词，不做回溯。`^/$` 是绝对首尾锚点。

经主控裁定，`\d/\w` 是 ASCII 数字/单词字符，反向大写转义为 Unicode 标量补集。`\s` 和 trim 固定采用以下 codepoints：U+0009..000D、U+0020、U+00A0、U+1680、U+2000..200A、U+2028/U+2029、U+202F、U+205F、U+3000、U+FEFF。明确排除 U+0085/U+200B；不依赖宿主 Unicode 数据或 trim/isspace 差异。该具体化参照 [ECMAScript WhiteSpace](https://tc39.es/ecma262/multipage/ecmascript-language-lexical-grammar.html#sec-white-space) 和 [CharacterClassEscape](https://tc39.es/ecma262/multipage/text-processing.html#sec-runtime-semantics-characterclassescape)，不表示支持完整 JavaScript 正则。

布局存在时 sections 必填；分组 section_code/title/columns/items 必填，description 可选；field item 的 kind/field_code/col_span 必填；description item 的 kind/text 必填。这是根据 §7.7 结构和缺省行为缺失所作的本次机器化选择，不声称 PRD 逐字列举了必填清单。未增加 sections/items 最小数量或未登记的布局文案长度上限。HTML 标签结构在说明/布局文本中拒绝；普通描述出现 SQL 等词不按可执行指令处理。

## 独立 Fake context 与 Task 4 接口

上下文只能由可信调用方独立传入；实例里增造同名属性会被结构引擎拒绝。当前工具内部结构（不是新的公共协议）如下：

```text
fixture: true
suite_revision: "0a-core-r1"
business:
  enabled_types: [十种基础类型]
  generators: [{schema_code, field_code, type}]
  index_capabilities: {各类型: [NORMAL/UNIQUE中本批已登记的模式]}
  money_rules: {CNY: {precision:38, scale:2}, JPY: {precision:38, scale:0}}
  history: null | {
    previous_spec,
    used_fields?, used_options,
    deleted_field_codes, value_samples,
    field_identity_changes?: [{previous_code, current_code}]
  }
fake_assets?: [{ref: 完整AssetRef, content: 固定Fake资产正文}]
```

Task 4 必须严格校验这些内部数据、确认引用的类型/作用域/版本/摘要，并把 Business 及历史绑定到当前精确资产和活动基线。这里的 history:null 仅表示静态模块没有提供历史，不证明“首次发布”，最终 references 阶段仍拒绝；不能使用部分上下文绕过完整检查。generator 必须匹配 schema_code/field_code/type，不在字段中增加绑定属性。

used_fields 属性存在时表示可信方提供的完整使用集合，空数组明确“已知没有字段被使用”；省略表示使用情况未知。逻辑移除已知有数据字段拒绝为 BREAKING_CHANGE_FORBIDDEN；明确未用或证据未知均为 MIGRATION_REQUIRED，不把逻辑遗漏混称物理删除。只有可信 field_identity_changes 才标识确切改码，不凭标签或结构相似猜身份。删除代码重用独立拒绝。使用中的枚举码删除拒绝；停用允许旧值读取。

缩长度/精度：Fake value_samples 中存在会截断的值才据此报告 BREAKING_CHANGE_FORBIDDEN；没有截断见证仍报 MIGRATION_REQUIRED，不能把样本通过当作完整数据扫描。扩大精度、新增必填、启用 UNIQUE、既有 required/nullable/default/write_policy 变化保守要求迁移；不执行迁移。label/说明/layout、可选新增、枚举新增、NORMAL 索引新增保持可兼容。有效缺省参数相同不制造迁移，例如 precision/scale 的 18/2、max_length 的 255/5000、min_length 的 0、trim 的 false、max_items 的 20。

## 固定样例与复验

本批固定 Fake FieldTypeRegistry 的索引能力为：long_text 仅 NORMAL，multi_select 的 NORMAL/UNIQUE 均未启用，其余八类型允许两种声明。集合索引拒绝来自本批未登记安全下推能力，不是公共 Meta-Schema 或 PRD 对一切集合索引的永久禁止。能力表缺项失败关闭；Task 4 须将此表绑定到精确 Registry 摘要。没有实现或验证 GIN/SQL 索引 Planner。layout 引用槽另允许已登记的系统列 id（两字符）；业务 fields[].field_code 仍保持三字符最小值和保留列禁止声明。

- `tests/meta-schema/business_cases.py` 独立编写输入和字面预期，不导入实现。
- `generate_business_fixtures.py` 仅物化这些输入/预期及 Fake 资产内容摘要；不运行校验器，也不从输出反推 expected。
- `inputs/business-prd-7-14-original.json` 是冻结 PRD §7.14 YAML 的逐值 JSON 转换，原演示摘要保留，只声称结构合法。
- `inputs/business-prd-7-14-fake.json` 只重绑注册表和单号策略到带 fixture 标记的实际 Fake 内容摘要，配套 `contexts/business-prd-7-14-fake.json`。单号策略不生成号码。其完整引用解析仍待 Task 4，当前只通过结构与静态检查。
- T1 原 Business false-Spec 用例改为真实正文四个必填属性的拒绝，并保留其登记外壳断言；没有把空正文改成合法。

```sh
PYTHONDONTWRITEBYTECODE=1 .venv/bin/python tests/meta-schema/generate_business_fixtures.py
PYTHONDONTWRITEBYTECODE=1 .venv/bin/python -m unittest discover -s tests/meta-schema -p test_business.py
PYTHONDONTWRITEBYTECODE=1 .venv/bin/python tests/meta-schema/test_conformance.py --suite 0a-core-r1 --group Business
```

测试对内存中的 spec/context 深拷贝做不变性比较，Node 同样比较调用前后的整个内存输入，且共享 CLI harness 检查原始 fixture 字节没有变化。B16 布局三态同步属于运行时交接，不计作本批已测行为。
