# W2 Command / ToolSpec 字段候选 r2

2026-09-15 定向修订：回应独立审查 F-01/F-04，并复用W1 r2的无环RoleRef/固定审批链/策略形状；仍为待批准设计。

本文由控制者根据 PRD §7.26、§7.29、§3.5.8形成机器化候选；字段映射为 **CT 新设计选择，待批准**。参考本地模型建议但以本文裁定为准，未生成任何实现。共同类型与诊断见[W0](2026-09-11-0a-5-shared-dictionary.md)，transition/policy定义见[W1](2026-09-11-0a-5-permission-workflow-dictionary.md)。

全部对象封闭；表内字段必填，?表示允许省略。UID沿用UUID，code沿用core机器码，位置为非负安全整数。公共命令外壳七键严格保持PRD：command_version常量app-model-command/v1alpha1、command_id/draft_id为UID、base_revision非负安全整数、type/target_ref/args按下表。

## CT01 十四个命令的参数边界

| type | target_ref 的完整键 | args 的完整键 | 静态规则 |
| --- | --- | --- | --- |
| app.createModule | app_id:UID | module_code:code,name:1–80字符串 | app必须为该草稿所属应用，新模块ID由服务端生成 |
| businessObject.create | module_id:UID | schema_code:code,name:1–80字符串,field_type_registry_ref:AssetRef(FIELD_TYPE_REGISTRY) | 创建空草稿对象不代表能编译空BusinessSchema；后续field.add补齐字段 |
| field.add | business_object_id:UID | field_code:code,field_type:十种v1枚举,label:1–80字符串,required:boolean；可选nullable?,write_policy?,query?,constraints?,type_config?,default?,description? | field_type映射最终Field.type；其余属性按core对应类型定义，nullable缺省由编译器写false，query缺省三个false，write_policy缺省MUTABLE；SYSTEM仍需可信生成器绑定 |
| field.changeConstraint | business_object_id:UID,field_id:UID | constraints:该类型封闭约束；type_config? | 替换本字段约束组；不得传新字段类型/任意路径；收窄/唯一规则需报告结构变更风险与迁移要求 |
| view.addNode | view_id:UID,parent_node_id:UID或null | componentName:已登记组件名,props:绑定组件Schema,position:位置 | null表示唯一根；ID由服务端生成；props二次封闭，不能任意JSON；无直接children树覆盖 |
| view.moveNode | view_id:UID,node_id:UID | parent_node_id:UID或null,position:位置 | 不可形成环或第二根，不能复用已删节点ID |
| view.bindField | view_id:UID,node_id:UID | business_object_id:UID,field_id:UID | 两ID是同一DraftGraph内局部目标；已发布跨契约引用由编译器生成AssetRef，不能猜名称 |
| navigation.addRoute | app_id:UID | route_code:code,path:core内部路径,view_id:UID | 草稿内view必须存在，route/path不重复，外链拒绝 |
| workflow.addTransition | workflow_id:UID | transition:W1 Transition | 两状态/动作属于同一草稿workflow；命令不能增加条件脚本字段 |
| permission.changeRolePolicy | permission_id:UID | policy:W1 Policy（含必填role_ref） | 仅作用于策略Permission P，不能给角色目录R加入policy；role_ref必须指向另一已固定角色目录，role_code与目录和本地声明一致；按policy_code替换或增加一条草稿策略，不是实时授权 |
| draft.undoCommand | 空对象 | target_command_id:UID | 目标必须是本草稿已完成且可补偿命令，追加补偿；不修改历史 |
| draft.redoCommand | 空对象 | target_command_id:UID | 引用已撤销的本草稿命令，追加新执行；无对应undo拒绝 |
| draft.compile | 空对象 | 空对象 | 模拟入口，不发布，不允许传完整正式契约或可信身份 |
| draft.submitForApproval | 空对象 | 空对象 | 只提交草稿，不允许携带批准人、批准结果或晋级参数 |

field.add不自动把不合法值转换成合法值；PRD的field_type=date四个args原样例必须通过结构校验。默认补值属于未来Draft编译器，Linter只读。十种类型的具体允许参数仍受core分支收紧，不能因command层可选而允许money/select缺必须配置。

**CT01a 幂等优先（新增选择）**：原始解析/规范化→封闭外壳与命令分支结构→可信调用者与所属draft边界→按(draft_id,command_id)查询不可变命令历史。命令摘要是 `sha256(c14n(完整七键命令根))`，包含原base_revision，不填默认值、不改写args。同ID且摘要相同必须直接给出原执行结果的Fake预期；不再检查当前图节点存在、字段代码唯一、当前位置、最新参数绑定或base_revision，也不追加命令/副作用。当前图后来改变、目标被撤销或原命令派生状态为UNDONE，均不改变这份已记录结果。同ID不同摘要固定COMMAND_ID_CONFLICT。

只有历史未命中的新ID继续：base_revision与当前revision→局部目标及当前类型化参数/组件绑定→风险/精确引用。新ID旧revision固定DRAFT_REVISION_CONFLICT，不先按已变化的节点报告目标缺失；缺可信历史不是未命中，必须TRUSTED_CONTEXT_REQUIRED。结构检查仅做本协议无需当前图的静态分支，不能把组件登记/目标存在等可变检查偷偷提前。可信身份、当前授权和受保护历史结果可见性仍须校验；幂等命中不能绕过权限撤销、tenant隔离或网关限流。真实结果保管、原子执行、日志持久化与返回前实时鉴权另验，本Schema不新增atomicity开关。

定向固定预期：field.add成功后同ID/原七键重放，即使当前已含field_code也返回原结果摘要；view.addNode的根已经存在、目标后来被undo撤销均同样重放；将原base_revision或任一args改写后重用ID则COMMAND_ID_CONFLICT；新ID旧revision仍冲突。未知字段/未知type/非法原始JSON在历史查询前拒绝，恶意重复ID不扩大结构接受域。

## CT02 ToolSpec 三种版本与可信外壳

仅registered入口，外壳采用RegisteredBase/Audit，加`contract_version:tool-spec/v1alpha1,tool_id:UID,spec:ToolSpecBody`；scope_type固定PLATFORM_CONTROL。spec的完整字段如下：

| 键 | 类型 / 约束 |
| --- | --- |
| tool_code | 非空点分已登记代码，例draft.applyCommand，不能由AI新增能力 |
| tool_version | 严格三段数字语义版本major.minor.patch，各段无前导零；候选子集不接受范围/latest/prerelease |
| gateway | USER_GATEWAY或BUILDER_GATEWAY |
| implementation_digest | Digest，可信适配器实现摘要 |
| input_schema / output_schema | SchemaBinding；两者各为独立封闭本地机器资源 |
| error_codes | 非空去重非空字符串数组；错误返回按固定output/error资源校验，未登记码拒绝 |
| limits | `{timeout_ms:正安全整数,max_input_bytes:正安全整数,max_output_bytes:正安全整数,max_items:正安全整数}` |
| rate_limit | `{algorithm:SLIDING_WINDOW,subject:TENANT_TOOL或TENANT_ACTOR_TOOL,window_ms:1..86400000整数,max_requests:1..1000000整数,burst_policy:WITHIN_QUOTA}`；全部必填，封闭，非null；语义见CT02a |
| required_permissions | `{builder_permissions:登记代码数组,form_actions:固定八动作数组,field_filter:boolean,data_scope:boolean,flow_actions:W1流程动作数组}`；无通配符 |
| scope_policy | `{allowed_scope_types:ScopeType非空数组,app_refs:APP_SPEC AssetRef数组,module_codes:code数组}`；空app/module仅指继承当前可信委派上下文，不授予全局访问 |
| risk_level | READ/WRITE/STRUCTURE_CHANGE/RELEASE |
| data_access | NONE/SYNTHETIC/AUTHORIZED_BUSINESS；Builder只可NONE/SYNTHETIC；真实业务读必须独立User调用 |
| confirmation | `{immediate:boolean,human_approval:boolean,dual_approval_declared:boolean,dual_approval_enabled:false}` |
| reliability | `{idempotency:READ_ONLY或KEY_REQUIRED,max_retries:非负安全整数,retry_on:已登记错误码数组,compensation_ref:CapabilityRef或null}` |
| audit_policy | `{parameter_digest:true,result:true,rejection_reason:true,trace_id:true,retention_days:正安全整数}` |

protocol contract_version标识这份元协议；外壳version为AssetRef固定的正整数登记修订；spec.tool_version是工具行为语义版本。三者不得混用。注册表固定 `(tool_code,tool_version)` 到唯一整数version和spec摘要，改变gateway/input/output/权限/副作用/实现等语义必须升工具版本并生成新登记修订，不能原地覆盖。与旧不可变快照的差异由Fake历史验证。

**CT02a 固定速率语义（新增选择）**：SLIDING_WINDOW按受控服务端时钟，在时刻t统计 `(t-window_ms,t]` 已准入调用次数，本次准入后不得超过max_requests。TENANT_TOOL的计数键为(可信tenant_id,tool_code)，TENANT_ACTOR_TOOL再含可信actor_id；tool_version不进入计数键，防止换版本绕过额度，网关取该工具唯一登记gateway。WITHIN_QUOTA表示允许同一时刻消耗剩余额度，突发最多max_requests，没有额外突发池/跨窗结转；窗口左端恰好到期的请求不计，右端计入。所有经身份确认的请求（包括自动重试、幂等缓存重放）在执行或返回历史结果前消费一次准入额度，限流拒绝不再增加已准入计数；max_retries不能替代或抬高速率额度。

配置整体进入ToolSpec.spec摘要，必须与可信tool_registry.expected_rate_limit完全一致；未知算法/主体、缺键、0/越界、未登记配置或试图传入计数tenant/actor均拒绝。可信登记更新必须产生新的工具语义版本/登记修订并经过治理，不能由AI通过正文抬高额度。本批验证闭合配置、精确绑定与边界预期，不实现共享计数器/真实限流服务；运行时限流拒绝码必须在该工具error_codes登记为TOOL_RATE_LIMITED（本次新增码），不得自动换网关/身份/版本重试。

固定预期：60秒/10次、空历史时同一计数键连续准入10次，第11次拒绝；恰位于t-60000的旧请求退出窗口；其他actor只在TENANT_ACTOR_TOOL下使用不同计数键；TENANT_TOOL下换actor不获得新额度。该预期约束设计含义，不能将尚未运行的用例写成实际通过证据。

User最小集合与Builder最小集合按PRD §7.29逐项在可信工具目录登记；公开AI允许目录不包含release.approve/promote/rollback。risk_level=RELEASE可表示平台治理工具登记，但不得进入AI允许调用清单；registry中的AI资格是可信属性，实例不能自报可用。STRUCTURE_CHANGE与写入确认策略使用可信注册表固定规则，不能只信工具正文布尔值。READ工具若有副作用/KEY_REQUIRED规则与实现登记冲突也拒绝。

所有输入Schema必须拒绝委派上下文可信键（actor_id、tenant_id、permission_version、audience等）；不能通过嵌套字段覆盖。需区别合法command.args目标app_id与服务端注入上下文的app_id，检查针对输入接口登记的上下文位置，不扫所有同名字段一概拒绝。SchemaBinding元资源的哈希与业务AssetRef摘要不是同一身份类型。

## CT03 W2 extension 与用例

命令extension必有`draft_snapshot,command_history,assets,component_registry`。draft_snapshot为封闭`{draft_id:UID,app_id:UID,revision:非负整数,nodes:节点数组,deleted_ids:UID数组}`；节点由`node_kind`分APP/MODULE/BUSINESS_OBJECT/FIELD/VIEW/VIEW_NODE/WORKFLOW/PERMISSION，分别只能含该种类的已登记ID、父ID和本契约草稿正文，禁止自由payload。具体节点字段需从已有DraftGraph技术方案复用并作为W0接口复核项，不从正式资产登记ID猜映射。

command_history项固定`{command_id:UID,command_digest:Digest,status:APPLIED或UNDONE,result_digest:Digest,compensates:UID或null}`；同ID唯一、链目标属于当前draft。command_digest/result_digest是原始不可变记录，status是从追加式补偿历史派生的当前状态，不允许改写原结果；此数组为可信历史查询快照，不冒充完整持久化审计日志。schema资源/组件属性从可信登记表取，待测命令不能替换定义。上述上下文只支持静态/Fake历史检查，不创建DraftGraph执行器。

工具extension必有`tool_registry,schema_resources,asset_registry,tool_history`。tool_registry每项固定`{tool_code,tool_version,registered_ref:AssetRef(TOOL_SPEC),ai_callable:boolean,allowed_gateway:固定枚举,expected_risk:固定枚举,implementation_digest,expected_rate_limit:CT02闭合rate_limit对象}`；schema_resources逐项`{binding:SchemaBinding,schema:已通过完整Schema自检的受控资源}`；tool_history保存先前完整登记快照，均与现有登记摘要复核。asset_registry沿用W0引用记录格式。

最低负例：14分支各缺键/加键/目标错型；同ID异内容；revision冲突；节点成环；私自降低风险；User/Builder串工具；伪造SchemaBinding摘要；工具版本范围或整数/语义版本混用；Builder records.*；AI可用release.approve；任意JSON Patch/SQL。正例包括PRD field.add原样输入、同ID同内容Fake重放、所有14命令和两网关已登记工具。

本字段字典的DraftGraph节点与Fake注册表的最终闭合映射仍须W0接口复核，不能因已有表格就声称可直接进入全部实现。

## STRUCTURE_SCOPE：本次机器结构候选接受域

2026-09-15由主控制者确认：view.addNode的公开静态Schema使用有限`SafeComponentProps`闭合集，精确允许键为`title,columns,fieldBinding,labelMode,colSpan,text,value,data,disabled`，均可省略，未知键拒绝。title/text为字符串或core I18nRef；columns/colSpan为1–4整数；fieldBinding/value为core FieldRef；labelMode固定BUSINESS_SCHEMA；data为core DataBindingRef或受限DataQueryRef；disabled为受限SafeExpression。componentName仍须完整登记解析，结构接受某属性不代表该具体组件允许它。

受限DataQueryRef仅允许`type,queryRef,params`，params可省略或封闭空对象，非空动态参数尚不属于此命令结构候选。受限SafeExpression保留core的外层`type:SafeExpression`以及all/any/not/left/operator/right封闭分支；子表达式不携带type，all/any为1–20项，in/not_in为1–200项标量数组，right只接受null/boolean/安全整数/string及对应数组，禁止任意对象。复杂数据绑定参数或此闭合集之外的新组件属性须另作接受域修订，不能因为“已登记”就跳过当前Schema。

field.add按显式field_type复用十类型core字段分支并保持字典规定的可选默认字段；field.changeConstraint没有字段类型鉴别键，结构只用十类型封闭constraints/type_config组合的anyOf，不新增type键或自由对象。目标字段精确类型、参数关联、收窄风险、金额币种匹配、Schema资源摘要、幂等历史、RoleRef目录身份、组件必填props与实际允许槽均是L/complete责任；结构通过不会设置complete或release_approved为真。上述有限接受域是本次候选的明确限制，不等于支持任意动态Registry。
