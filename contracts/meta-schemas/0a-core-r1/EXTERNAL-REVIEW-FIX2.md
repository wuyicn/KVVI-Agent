# 外部审查修复 FIX2：规则与采纳记录

性质：FIX2 规则记录，不是验收或合并批准。修复基点为 PR #3 的 `8d4247d2b63c4107c79490bc403ed0a55e2e704b`。用户在本任务核验两份审查后回复“好”，授权统一修复；不授权合并、部署或扩大 Go-0 范围。本轮实际验证与状态另见新增的日期化交付记录。

本文件新增 FIX2 修订记录，不修改 PRD v1.11、冻结 O1、19 条历史裁定或审查原文。PR #3 尚未合并，公开 `contract_version` 和试验包名 `0a-core-r1` 不变；新源码提交和独立证据 run 区分修复前后，不以旧 run 证明新源码通过。

两份外部原文位于主工作区 `评审/Deepseek 0A-MetaSchema 评审.md`（SHA-256 `73e0a3591114bad43a4a936c86e9fc5c816fd407413406bcaf5da9140a7bab41`）与 `评审/Kimi 0A-MetaSchema 评审.md`（`2efe4fd2df2f2a6b365e16c699f75626b34d39fa7ddfe70afd0c59be9a7cbeec`）。它们是用户未提交文件，本次不代为暂存或改写；本记录不冒充来源原文归档。

## 来源与处置

| 来源 / 编号 | 原严重性与结论 | 本轮处置 |
| --- | --- | --- |
| Deepseek | PASS，无阻断 | 保留独立结论；不能覆盖 Kimi 尚未关闭的重要问题。default 分支解释、data 布局边界与 CONTEXT 历史措辞在本文件澄清。 |
| Kimi I-1 | Important，密钥检测缺失 | 补最小辅助检测；不得用延期裁定免除密钥禁令。 |
| Kimi M-1 | Minor，编号标签长度无依据 | 移除 record_number.label 的 1–80 限制，只保留字符串类型；不放宽 fields[].label。 |
| Kimi M-2 | Minor，Business 描述 HTML 禁令范围 | 不采纳删除检测。§7.7 明文约束“描述和布局”；保留根/字段/布局说明的 HTML 拒绝，并登记 ARBITRARY_EXPRESSION_FORBIDDEN 为本批诊断映射。 |
| Kimi M-3 | Minor，平台字段可重复布局 | 依 §7.7 字面仅业务字段去重；平台列/受控编号可重复展示，绝不因此改变权限和写策略。新增更严限制须另审。 |
| Kimi M-4 | Minor，深嵌套执行类别分歧 | 保留已知缺口，不标已修复。冻结 O1 不可改；本批不得声称任意深度全域一致。后续 c14n 修订需单独定义输入域、资源失败及跨语言证据。 |
| Kimi M-5 | Minor，pattern 匹配语义缺文档 | 固定未锚定为搜索子串；`^`/`$` 为绝对起止，不受末尾换行宽松规则影响。 |
| Kimi M-6 | Minor，潜在 format 集合差异 | 已实际复现。可信 Registry 四种 Schema 槽统一固定格式名，不依赖可选依赖或引擎注册表扩大接受集。 |
| Kimi M-7 | Minor，专用权限错误码缺失 | Business 正文根层的明示授权/租户注入使用专用码；其他未登记属性仍走 UNKNOWN_PROPERTY，保留先结构后语义的次序。 |

## FIX2 的精确边界

1. 辅助 Secret 检测在三个正文的完整语义检查及被引用正文检查中执行；仅结构检查不据此承诺无密钥。扫描解码后的字符串值，固定识别 PEM 私钥头、含非空用户和密码的 URI、显式密码/Token/API key 赋值、Bearer 认证形状。仅作 ASCII 大小写折叠和显式 ASCII 空白处理；每个命中字符串只产生一个 `SECRET_DETECTED`。输出仅含固定错误类别、字段路径和通用提示，不包含命中值。名称、帮助文字、标签、静态默认值、i18n、props/input/params 均不豁免。扫描不验证凭据真伪，不访问网络，也不宣称能发现所有编码、拆分或混淆秘密；结构化通道、服务端权限和真实运行时验收责任不变。
2. 可信 Registry 的 propsSchema/inputSchema/outputSchema/errorSchema，包括未使用及嵌套定义，只允许 `date`、`date-time`、`uuid` 三个当前已有明确验证边界的格式名；前两者沿用 D03 日期 profile，uuid 由已锁定真实引擎校验。其他名字（包括空字符串、email、regex、int32、byte、idn-email）均为 `REGISTRY_CONFIGURATION_INVALID`，退出 1，不能算实例负向拒绝。此为私有 Fake 上下文的明确缩小与固定，不新增公开字段类型；扩展格式须另补共享向量与批准。不得只改 context.schema.json 而漏过四槽的实际加载器。
3. Business 正文根层 `tenant_id`、`role_permissions`、`user_permissions`、`authorization`、`data_scope`、`approvers` 的未知属性诊断映射为 `PERMISSION_DECLARATION_FORBIDDEN`；其他未知键仍拒绝。不按普通字符串值猜授权，不禁用合法布局的 `field_code: tenant_id`；未列形状仍由封闭 Schema 拒绝，不宣称任意未知键都能被语义分类。View 原有专用安全/UNKNOWN_PROPERTY 诊断不改写为 Business 专用码。
4. Field 的顶层 `default: true` 是组合 Schema 的宽松中间定义，不是实例默认值；最终类型由各字段分支约束。布局可引用十个固定平台列及实际声明的受控编号；`data` 容器与 `_platform_` 保留名称不是可展示字段。CONTEXT.md 的 Task5 待办文字为历史阶段记录，不是当前交付状态。

## 验证要求与剩余项

独立实现复核追加：不能通过再次匹配 JSON 转义后的路径来判定动态键是否需要脱敏。遍历时按原始键记录风险并向后代传播；命中值位于风险路径时，诊断路径回退到 `$`。引用正文的传入前缀若已经含字典键，因缺少原始键来源同样保守回退到 `$`。Tab 与双引号动态键必须有共享负向对照，并断言完整诊断不含虚构秘密标记；普通安全路径仍保留定位信息。

词法具体化：仅 `A–Z` 折叠为 `a–z`，赋值/Bearer 空白仅 U+0009/U+000A/U+000D/U+0020。PEM 头识别普通及 RSA/EC/DSA/OPENSSH/ENCRYPTED PRIVATE KEY，不把 PUBLIC KEY 误判为私钥。赋值键固定为 password、passwd、token、apikey/api_key/api-key、accesstoken/access_token/access-token、refreshtoken/refresh_token/refresh-token、clientsecret/client_secret/client-secret、secretkey/secret_key/secret-key；左界为开头或非 ASCII 字母/数字/下划线，键后可紧接一个单/双引号，再空白、冒号/等号、空白、可选引号及非空值。空赋值与仅讨论这些名称不拒绝。动态键自身不扫描为秘密值，但若命中值的诊断路径包含秘密形状，退回安全正文根路径，不回显该键。不可由可选引号两侧重复的空白匹配产生超线性回溯；实际 20 个长文本默认值的未完成赋值对照须在既有 CLI 预算内通过。

先运行新增失败测试，再修复；保留原 1005 条输入。M-1 的旧 0/81 标签预期因已确认规范纠错由拒绝改为结构通过，差异必须显式审查，不能为迁就实现批量重算预期。新增独立字面共享用例和四槽实际 CLI 格式故障测试；重放冻结 6 项 O1、完整共享套件、单元/工具故障，新增源码绑定证据。历史 run 和冻结清单不变。

M-4 仍未关闭：既有合法 JSON 深嵌套探针 D=400/800 时 Python 报执行失败，Node 报约束拒绝；D=10000 时 Node 的冻结实现兜底将资源异常记为 CANON_JSON_INVALID。它不是已通过的全输入域协议证据，不进入成功率。修复后需两来源定向复评与负责人新的明确合并批准。
