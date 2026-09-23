# W1 Permission / Workflow 字段候选 r2

2026-09-15 定向修订：回应独立审查 F-02/F-03/F-05/F-06；本文仍为待批准设计，不构成机器实现验收。

控制者根据完整 PRD 收口，参考本地 Qwen 的[候选原文](../../coordination/0a-5/local-ai/qwen27-permission-workflow.md)但不采用其重写的 AssetRef、FORM 资产类型、通用权限条件、DAG 限制或生命周期。本文所有新字段编码为 **PW 新设计选择，待批准**，不声称是 PRD 原字，也不代表机器实现完成。

共同规则见[W0](2026-09-11-0a-5-shared-dictionary.md)。下文所有对象关闭未知字段，表内列出的键必填；可空/可省略会明确写出。code 使用 core 机器代码规则；display 为1–80字符。计数上限为本次候选资源预算：roles≤100、policies≤1000、states≤100、transitions≤500、actions≤100、choices≤20；不是PRD已有数字。上限若不采纳必须在设计阶段调整，不以工具内存错误替代实例拒绝。

## PW01 Permission

外壳不重新定义：CompiledDraft 三键、Spec 根、RegisteredContract + permission_id，共同 RegisteredBase/Audit 按 core-r1。Spec 只有 roles 和 policies。roles 为0–100数组，项 `{role_code:code,name:display}`；初始草案允许两个空数组。roles 的角色代码唯一，policies 不能引用不存在的角色。

**PW01a 无环角色身份（新增选择）**：角色目录 R 与授权策略 P 是不同稳定 permission_id 的 PERMISSION 资产，不新增 AssetType。R 的 `policies=[]`，只登记角色；P 的非空 policies 每项必须携带闭合 `role_ref:{permission_ref:AssetRef(PERMISSION),subresource:{type:ROLE,code:code}}`。role_ref.permission_ref 必须精确解析到 R 的已固定版本，R.policies 必须为空；禁止指向 P 自身或任何有策略的 Permission。P.roles 只是本策略声明的本地代码/显示名清单，不是新的成员身份来源。每条 policy.role_code 必须同时等于 role_ref.subresource.code 且在 P.roles 和 R.roles 中存在；同一 P 的同一 role_code 只能映射一个完整 role_ref，不得跨目录猜同名。P 中每个角色至少被一条策略使用。空草案保留合法；作为目录被引用的 R 必须至少有一个角色。

成员角色身份按完整 `role_ref` 解释，不能仅按 role_code 并集；不同 R 的同名角色不互授。Workflow 的所有审批角色同样只能引用 R，不能引用带 FLOW 策略的 P。R 无引用，W→R，P→R/W，AppSpec→R/P/W，因此先算 R.spec 摘要，再 W，再 P，最后 AppSpec/Manifest；所有依赖照常计入制品闭包。角色目录与策略资产职责由登记历史锁定，同一 permission_id 不得在后续版本改成另一职责，目录版本只能新增/更新角色声明，不能加入授权策略。

首次创建可先冻结/登记 R，再冻结 W，再冻结含 FLOW 的 P，不依赖任何不存在的旧版本。角色变更与流程策略同时修改时顺序是 R v2→W v2→P v2→新 AppSpec，旧 R/W/P 原字节保留。同一制品内同一目录资产只允许一个固定版本；R升版时，该包所有引用R的W/P必须更新，不能把新版成员角色身份自动映射到旧版。其他无关资产可继续锁旧版。单独更改 FLOW 策略只升 P，不强迫 W 升版。登记/冻结与运行时激活分离，最终仍必须整包批准并原子激活；不能把目录已登记解释为成员已获权限。

所有 policy 必有 `policy_code:code, role_code:code, role_ref:上述RoleRef, dimension:枚举, resource_ref:AssetRef`；policy_code唯一。按dimension增加如下字段，未列字段不允许：

| dimension | resource_ref类型 | 本分支字段 | 静态含义 |
| --- | --- | --- | --- |
| FORM | BUSINESS_SCHEMA | `effect:ALLOW或DENY, actions:非空去重数组, capability_refs:CapabilityRef数组` | actions固定read/create/update/delete/import/export/approve/admin；能力引用只列调用能力绑定，不代替表单动作授权 |
| FIELD | BUSINESS_SCHEMA | `subresource:{type:FIELD,code}, field_mode:DENY或HIDDEN或MASKED或READ_ONLY或EDITABLE` | 字段必须存在于固定业务Schema；模式优先序即原文拒绝>隐藏>脱敏>只读>可编辑 |
| DATA | BUSINESS_SCHEMA | `data_scopes:非空去重数组` | 仅SELF/STORE/DEPARTMENT/DEPARTMENT_AND_CHILDREN/COMPANY；以并集表达允许范围；显式资源动作拒绝在FORM/FLOW层剔除，不新增数据范围差集语言 |
| FLOW | WORKFLOW | `effect:ALLOW或DENY, subresource:{type:STATE,code}, actions:非空去重数组, capability_refs:CapabilityRef数组` | actions候选INITIATE/SUBMIT/WITHDRAW/APPROVE/REJECT/CLOSE/REOPEN；同时受该Workflow状态机和Business表单授权约束 |

capability_refs 可空；非空时必须解析到与本策略动作匹配的固定能力注册项，不能把代码字符串充当 CapabilityRef。DATA/FIELD 分支不另引入 condition/自定义授权表达式。单字段局部code不是AssetRef，但始终与父resource_ref一起解释，不能全局查找。

Fake权限代数的纯验证样例：先确认同tenant和有效角色，按角色并集聚合FORM/FLOW允许项，再剔除任意显式拒绝；DATA各范围并集，SELF仅owner OR creator OR assignee；FIELD按五档优先序。无匹配表单/流程允许项默认拒绝，字段缺声明默认不可见/不可写，数据缺声明为空集。字段MASKED如何实际脱敏是运行时职责，不在Schema注入自定义模板。

例：来自同一已固定目录的 role_a允许read、role_b拒绝同资源read，双角色结果拒绝；STORE与DEPARTMENT合并为集合并集；同名字段处于不同业务Schema不能相互授权。两份目录中同名 role_a 的完整角色身份不同。该纯Fake计算不是实时鉴权服务。

## PW02 Workflow

沿用三入口与 workflow_id。Spec 必有 `businessSchemaRef,states,transitions,approverRef,actions`。businessSchemaRef是BUSINESS_SCHEMA AssetRef。除引用本身，不嵌入其他契约正文。

| 对象 | 确切键/类型 | 关系约束 |
| --- | --- | --- |
| State | `state_code:code,name:display,initial:boolean,terminal:boolean` | SINGLE/FIXED_CHAIN 的 states至少1，code唯一，恰好一个initial；terminal可无以支持未完成草案，但complete要求至少一个可达terminal；selector根的空数组规则见下 |
| Action | `action_code:code,kind:SUBMIT或APPROVE或REJECT或WITHDRAW或TIMEOUT_REMINDER或CLOSE或REOPEN,capability_ref:CapabilityRef` | action_code唯一，能力固定匹配kind；超时提醒通过预登记能力表达，不允许输入脚本/URL |
| Transition | `transition_code:code,from_state:code,to_state:code,action_code:code` | 两端与动作必须存在；同from+action仅一个目标；不限制任意业务码必须叫DRAFT/SUBMITTED |
| SingleApprover | `kind:SINGLE,role_ref:PW01a RoleRef` | 只引用角色目录R；全部审批动作使用该固定角色，可信上下文选定恰好一位合格审批人，不能猜人 |
| FixedChain | `kind:FIXED_CHAIN,steps:ApprovalStep非空数组` | 1–100步，顺序就是冻结审批顺序，禁止动态插入、会签或脚本；每步固定自己的角色 |
| ApprovalStep | `step_code:code,pending_state:code,role_ref:PW01a RoleRef` | step_code/pending_state各自唯一；pending_state是本Workflow的非初始非终态审批等待节点，角色只引用R |
| ChainSelection | `kind:REGISTERED_CHAIN_SELECTION,default_chain_ref:WORKFLOW AssetRef,choices:Choice数组` | 候选是整份已登记固定审批链Workflow；不传节点数组、不拼装新链 |
| Choice | `when:Selector,chain_ref:WORKFLOW AssetRef` | 数组顺序为显式优先顺序，首个匹配选择整链；无匹配取default；选择只读、确定性 |

approverRef在SingleApprover/FixedChain/ChainSelection之间oneOf，互斥且封闭。条件仅在Choice.when出现，不在transitions上允许任意业务分支编排。完整检查拒绝从terminal出边，但REOPEN可显式从已登记关闭终态回到非终态，这是有审计的业务动作，不把整个Workflow强制成DAG。非REOPEN终态出边拒绝；声明自环仅允许TIMEOUT_REMINDER且不改变状态。拒绝/撤回可以回到已有状态，不能按“图有回边”误拒。

**PW02a 固定链步骤（新增选择）**：FIXED_CHAIN 的初始状态恰有一条 SUBMIT 边进入 steps[0].pending_state；每一步恰有一条 APPROVE 边进入下一步，最后一步进入成功终态。每个有 APPROVE/REJECT 出边的等待状态必须且只能映射一条 step，不能留未绑定审批人状态。REJECT/WITHDRAW 仅退回初始状态或进入终态，TIMEOUT_REMINDER 仅当前步自环，CLOSE 可进入终态，REOPEN 只能从终态回初始；其余跨步、跳步、并行分叉拒绝。APPROVE/REJECT 的 actor 必须属于当前 step.role_ref 对应且可信唯一解析的合格成员，不得因为属于前一步或任意同名角色而审批。

例：目录 R.roles 含 manager/finance；W.steps 固定 `manager_review→R.manager`、`finance_review→R.finance`，路径 draft→manager_review→finance_review→approved；策略 P 的 FLOW 项以 role_ref 分别授予相应等待状态的 APPROVE。manager 不能在 finance_review 审批；换绑定必须产生新 W 摘要并更新 P 的资源引用。该映射属于完整 W.spec 摘要，不是运行时从 probe 临时拼出的名单。

**PW02b 整链选择（新增选择）**：ChainSelection 的 states/transitions/actions 必须为封闭空数组，表示仅作固定链选择的入口，不提供第二份相互冲突的状态机。default/choices 只能指向已发布、精确固定、同一BusinessSchemaRef、approverRef=FIXED_CHAIN 的 WORKFLOW。在进入审批实例时选择一次完整链，可信实例快照固定 selected_chain_ref，后续全部状态、步骤、动作与权限资源均取该固定链；业务值后来变化不重新选链。链可以有不同长度，但不能把多个目标链节点拼接。选择器不能指向自身、祖先或另一个selector；选择前无 current_state，选择后 probe 的 current_state 属于目标链，不属于入口的空 states。选择是只读决策，不授予权限；创建实例或执行动作前仍必须核对选定链的FORM/FLOW授权，不能仅凭有权读取selector就发起其目标链。此分支保留 PRD 五个必有 spec 键，不增加公开协议或动态编排能力。

## PW03 Selector固定语法

Selector为四个封闭分支：`{all:[Selector...]}`、`{any:[Selector...]}`、`{not:Selector}`，或谓词 `{field:{type:FIELD,code},operator:eq|ne|gt|gte|lt|lte|in|not_in,value:Literal}`。每个对象只能命中一分支；all/any项数1–20、深度≤5、总谓词≤100是候选预算。Literal仅null/boolean/安全整数/string，in/not_in使用1–200项去重Literal数组；其余禁止数组和对象。不得接受函数调用、变量路径、JSONPath、脚本或任意表达式字符串。

**PW03a 十类型接受域（新增选择）**：字段均从businessSchemaRef精确解析；下表覆盖非 null 操作数，未列组合拒绝。E=`eq/ne/in/not_in`，O=`gt/gte/lt/lte`；E中eq/ne的value是单值，in/not_in的value是同一类型单值数组，禁止混型。

| 字段类型 | 非null操作符 | value单值格式 / 比较语义 |
| --- | --- | --- |
| short_text | E | string；按Unicode标量序列精确相等，不trim/大小写折叠，不提供大小比较 |
| long_text | E | string；同上，不提供排序/子串/正则运算 |
| boolean | E | boolean；true/false，不接受0/1或字符串 |
| integer | E+O | 安全整数；数值比较 |
| decimal | E+O | core DecimalValue十进制字符串；精确十进制数值比较，1.0与1.00相等，禁止二进制浮点 |
| money | E+O | value仅core DecimalValue金额字符串；读取业务值amount，币种必须等于字段FIXED type_config.currency；不能在Selector传currency或money对象 |
| date | E+O | 严格有效YYYY-MM-DD；日历日期比较，不做时区转换 |
| datetime | E+O | 有显式时区的有效ISO时间，沿用core格式；按同一UTC时刻比较，精确保留合法小数秒，禁止宿主毫秒截断 |
| single_select | E | 该固定字段已登记option code；按代码相等，允许用仍登记的停用选项匹配历史记录，不允许未知码 |
| multi_select | in/not_in | value为该固定字段1–200项已登记option code数组；in表示记录集合与value有交集，not_in表示无交集；记录空数组的结果分别false/true；无标量eq/ne或大小比较 |

选择器常量只验证本表格式、字段的固定币种/枚举身份和core不可突破的精度硬边界，不要求落在字段当前minimum/maximum等可变业务范围内；例如受约束integer≤100的字段与阈值200比较是合法且确定的表达式。合法记录先按精确BusinessSchema另验，查询比较不再次应用default、trim或数值转换。decimal/money的in去重按精确数值等价，datetime按UTC时刻等价，其余按相应类型相等；`["1.0","1.00"]` 在decimal分支拒绝为重复。

**PW03b 缺失/null/布尔合成（新增选择）**：missing与JSON null分开。字段缺失时该叶子结果为 UNKNOWN，包括eq null；仅当字段nullable=true时允许eq/ne的value=null（对十种类型均适用，是上表multi_select非null限制的唯一补充分支）。字段值显式null时eq null=true、ne null=false；value非null时，显式null对全部叶子操作返回UNKNOWN，不能让ne/not_in将空值视为匹配。in/not_in数组中禁止null；nullable=false的null常量或业务值拒绝。

复合结果取TRUE/FALSE/UNKNOWN：not(UNKNOWN)=UNKNOWN；all有FALSE即FALSE，否则有UNKNOWN即UNKNOWN，否则TRUE；any有TRUE即TRUE，否则有UNKNOWN即UNKNOWN，否则FALSE。只有最终TRUE匹配Choice，FALSE/UNKNOWN继续下一条，最后取default_chain_ref。这不是执行异常吞错：未知字段/非法格式/不支持的组合是拒绝，不能转UNKNOWN；先验证整个Selector及全部叶子，不能借短路隐藏错误。记录缺失一个required字段仍由BusinessSchema拒绝，不能进入UNKNOWN分支。

固定预期：缺失可选integer时eq 5及not(eq 5)均UNKNOWN；显式null时eq null=true；可空值5与null常量eq=false/ne=true。停用但已登记的single_select旧值可用于匹配，未知code拒绝；multi_select=[a,b]与in[b,c]为true、not_in[b,c]为false。money CNY 10.00与阈值10.0相等，错误币种记录拒绝，不发生隐式换汇。

## PW04 W1 extension与验收接口

Extension确切顶层键为 `assets,permission_probe,workflow_probe`。assets采用core上下文已登记资产快照格式并扩展PERMISSION/WORKFLOW正文验证器，每项内容必须按固定摘要解析，无通配对象。permission_probe可null，非null为封闭 `{tenant_id:稳定ID,active_role_refs:RoleRef去重数组,owner_id:稳定ID或null,creator_id:稳定ID或null,assignee_ids:稳定ID数组,actor_id:稳定ID,store_ids:稳定ID数组,current_department_id:稳定ID或null,descendant_department_ids:稳定ID去重数组,record_store_id:稳定ID或null,record_department_id:稳定ID或null}`。active_role_refs必须由该tenant有效成员登记提供，不能通过待测策略声明获得。此探针只用于固定代数演算，不替代实例的结构检查；验收预期放cases，不能放context指示通过。

**PW04a 部门范围（新增选择）**：current_department_id是成员当前唯一部门；descendant_department_ids是可信组织快照预先展开的严格后代，不含自身、不含其他tenant，null当前部门只允许空后代。DEPARTMENT仅匹配record_department_id=current_department_id且双方非null；DEPARTMENT_AND_CHILDREN匹配当前部门或后代；record_department_id=null对这两范围均不匹配。没有组织来源不能把后代默认为空；本Fake入口消费外部可信集合，不宣称验证真实组织数据库。固定预期：当前dept_a、后代[dept_b]时，记录a/b/c对DEPARTMENT为true/false/false，对DEPARTMENT_AND_CHILDREN为true/true/false。COMPANY、STORE、SELF的原语义不变。

workflow_probe可null，非null为 `{selected_chain_ref:WORKFLOW AssetRef或null,selection_record_fixture:固定BusinessSchema合成记录或null,selected_actor_id:稳定ID,eligible_roles:RoleEligibility数组,current_state:code,action_code:code,record_fixture:固定BusinessSchema合成记录}`。RoleEligibility全键为`{role_ref:PW01a RoleRef,eligible_actor_ids:稳定ID去重数组}`，角色引用唯一。SINGLE/FIXED_CHAIN时selected_chain_ref和selection_record_fixture均null；ChainSelection时两者必非null，链必须等于在不可变selection_record_fixture上首次选择的结果，后续record_fixture改变不得重选。两份记录均按精确BusinessSchema另验，不是任意自由JSON。

当动作kind为APPROVE/REJECT时，FIXED_CHAIN或selector已选定链从current_state解析当前步唯一role_ref，SINGLE直接取根role_ref，再取对应eligible_roles；该集合必须恰含selected_actor_id一人，缺映射/0人/多人均拒绝。不能把其他步骤或目录的人员当当前步候选。SUBMIT/WITHDRAW/CLOSE/REOPEN按各自FORM/FLOW授权和状态机校验，不强制发起人/撤回人等于审批人。契约完整引用检查不因probe为null跳过；要求演算某个权限/流转用例时缺probe按TRUSTED_CONTEXT_REQUIRED拒绝。动作能力匹配与FORM/FLOW授权照常检查，角色唯一性不替代授权。

应拒绝的边界：未知角色/局部字段、裸名称能力、跨tenant/未授权跨app、条件中任意对象或脚本、角色不唯一解析、动态节点链、chain递归、未知状态/动作和真终态非法出边。应接受：空权限草案、合法四维声明、单人审批、从预登记整链条件选择、明确撤回/驳回/重新打开。

实现前需要W0集中确认core资产上下文扩展方式以及各probe的调用入口；上述可审查候选不能被当成现有实现能力。
