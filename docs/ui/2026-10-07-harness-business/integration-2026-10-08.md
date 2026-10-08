# 工作区与业务区主次调整 — 7500 接入

用户授权：2026-10-08「好 你调整吧 调整好了就修改到7500上」。

## 已确认的体验

- 工作区保留原DSH会话、目录与会话组织；右侧单栏承载表单/记录/真实提交结果。
- 业务区主区承载已发布表单与记录；AI按需在右侧辅助，使用原会话能力。
- 表单草稿、pending写入、成功刷新共用同一会话store；历史回放不自动开栏。

## 接入顺序与范围

1. 7506原型调整并验证跨入口的示例记录与会话保留。
2. KVVI客户端新增业务session槽，提取原授权表单/记录renderer共用。
3. 通过DSH原conversation.content Factory嵌入AI；保持原main.conversation的唯一声明。
4. 新增整客户端组合测试，验证声明、绑定、AI输入区；补充历史回放、拒绝提交与迟到结果不跳转检查。
5. GUI、类型、构建、源码边框规范与相关browser replay检查。
6. 本地fork提交、G2指纹与完整导出/重建校验，再用受管服务更新7500。

当前已发布系统API只有一张schema及其表单/记录，原型GAD的多表单、报表、分组、业务创建/重命名/删除与表单设计仍属原型。正式本轮接入不拷贝其示例数据/身份切换/假AI。管理能力沿用原有后台入口。

## 验证边界

7506原型browser已验证：登记请求、弹窗保存、右侧记录列表、主会话保留、业务主表同一记录、AI开关；console无error。截图在prototype/evidence-business/workspace-chat-list.jpg及business-data-ai.jpg。

7500的自动browser操作此前被工具URL策略明确拒绝；本轮未重试或换浏览器/CDP绕行。客户端源码组合、GUI、service与静态bundle检查不等同真实7500视觉/业务验收，须用户在现有7500本地页测试。

## 本轮最终结果

- fork本地提交：`bbb671c63732b339d7a04b1a45e9f582711c854e`，未推送。
- 完整GUI：447文件全部通过，6345项通过、1项跳过；KVVI定向与整客户端组合包含133项。本轮先出现重复main.conversation声明，再改为conversation.content Factory并验证通过。
- 类型检查与完整构建通过。提交范围staged lint通过；新BusinessPage/BusinessActivity的type-aware lint通过。
- 浏览器完整回归：119文件通过、1失败、1跳过，430项通过、1失败、15跳过。失败为queue-actions的sending快照缺少`partial`段；定向复查仍1失败/2通过。这份测试仅装配base/web-app，没有KVVI包；源码不在本轮修改范围。未刷新golden以掩盖差异，整套浏览器回归不能称为全绿。
- G2：184路径、45登记；导出176文件及8删除；独立重建与指纹逐字节一致，删除校验8/8通过。
- 受管stop/start完成；platform PID15798、runtime PID15808，旧68764/68786已替换。数据库已在运行，schema最新，未重建数据库。
- 7500 /healthz：HTTP200、签名与运行时凭据可用、schemaBehind=0/schemaExtra=0/schemaReadable=true。
- 匿名请求客户端资源被登录门重定向至/kvvi/login，因此没有用该响应冒充新bundle校验。当前运行时使用本仓库刚构建的apps/cli/lib/bin.js；实际已登录页面是否加载新UI仍待用户refresh验证。

日志：`/tmp/kvvi-business-gui-final.log`、`/tmp/kvvi-business-typecheck-final.log`、`/tmp/kvvi-business-build-final.log`、`/tmp/kvvi-business-web.log`、`/tmp/kvvi-business-web-retry.log`、`/tmp/kvvi-business-service-start.log`、`/tmp/kvvi-business-verify.log`。这些临时日志可能被后续清理，不是持久归档证据。

## 用户本地测试

刷新现有7500页：工作区打开客户会话，发起登记，核对右侧记录列表；业务入口进入已发布客户登记，核对主区记录及右侧AI开/关；在同一业务会话范围验证草稿与保存刷新；权限不足仍应保留草稿并给出短拒绝结果。已有会话选择不应插入其它工作区。

AI需唯一对应工作区（当前按发布名称/assetId/名称+系统匹配）；缺失/重名会显示说明并禁用AI，仍能通过既有授权独立表单处理记录。真实7500截图及业务验收未完成，不能将7506截图标成正式服务。

## 7500「没有更新」复查与修复（2026-10-08 16:09）

用户反馈后按实际配置排查，未执行被策略禁止的7500浏览器操作。

- 同一安装锚点、profile和home的只读解析结果将kvvi-panel解析到本仓库，构建文件包含新business session。不是另一份旧安装包覆盖。
- 平台只读系统元数据为`name=customer, assetId=customer, schemaCode=customer`；现有工作区标题/目录为「客户登记系统」。原自动名称匹配返回零项，业务页进入旧KvviSystemShell回退；旧壳默认填单、外部记录/表单导航未接入。这是当前数据触发的真实布局缺陷；此前只测了名称吻合的组合路径。
- 修复：无关联时也使用BusinessContent显示记录优先的新布局，外部导航正常；根store与session store分别绑定，遵守一个handle一个scope；可明确选择工作区后通过原connectWorkspace/retain接入原AI会话。未猜测映射、改名或重写业务/工作区数据。
- 注意：独立业务草稿与关联会话草稿属于不同scope；选择工作区后使用所选会话草稿。关联选择本轮不持久化。
- 新增失败先行的无匹配布局测试，以及实际客户端装配的`customer`对「客户登记系统」显式选择/AI输入区测试。定向8项通过；完整GUI447文件、6347项通过、1跳过；类型、完整构建、提交范围lint通过。
- fork修复提交：`458fa871`；G2登记184路径，导出176文件、8删除，独立重建逐字节校验通过。
- 7500受管服务已重启：platform PID24385，runtime PID24509；healthz HTTP200、ok=true、签名/运行时凭据可用、schemaBehind=0/schemaExtra=0/schemaReadable=true。
- 新build在本次启动前完成；bundle sha256为`749d5cee0bacc3b0c12b7b2cb8ba088e6c80ccd1835590635876053bd0fb29f5`，含新布局与AI工作区选择，已无旧initialSystem回退。服务不涉及数据库重建或业务数据修改。真实7500页面点击/截图仍被浏览器工具URL策略阻止，以上不是浏览器验收。

用户验证入口：刷新7500 → 左侧「业务」→ customer「进入业务」。应默认显示记录列表；没有自动关联时选择「AI会话工作区」中的「客户登记系统」，再点「AI协助」开启右侧原会话。工作区主会话按已确认方向保持原样。

本轮日志：`/tmp/kvvi-no-update-{focused,gui,types,build,lint,start,manifest-verify,verify,web}.log`。

本轮完整浏览器replay最终结果：`DSH_SNAPSHOT=replay pnpm run test:web:built` exit 0；120文件通过、1文件跳过；431项通过、15项跳过。耗时609.77秒。此前queue-actions快照失败本次未重现，未改写golden。这个回归使用测试夹具与测试服务，不是7500已登录页面验收。最后再次检查7500 healthz为HTTP200/ok=true。

## 7506 原型的实际布局迁移（2026-10-08 17:08）

依据用户再次明确授权，将当前7506的业务目录表格与业务工作台移入正式客户端；此次不再仅迁移“主表单、右侧AI”的大框架。

- 首页：业务名称/内容/状态/操作四列，业务搜索和进入业务；数据来自已发布 systems，未复制原型中的 GAD/访客示例。
- 业务内：面包屑、左侧真实表单目录与搜索，中间业务记录及操作栏，右侧按需打开原 Conversation；工作区原会话布局保持。
- 新增记录：弹出经平台字段授权的表单，真实创建接口成功后留在列表并刷新。隐藏列从表头、单元格、搜索中排除；筛选使用有权限的枚举字段，MASKED不能充当筛选字段；显示加载/匹配数，不冒充全量统计。接口目前最多返回50条，尚未添加全量分页。
- 新建业务：仅实际BUILDER入口显示；填写名称/需求，选择保存父目录，通过原 Host目录、Workspace和Session API开始真实搭建会话。发布成功前不伪造已发布业务。设计表单转到已明确关联工作区的全新搭建会话。
- 尚未接入的平台能力：多个asset归组为同一应用、仪表盘/报表、直接重命名/删除业务。没有将原型的本地状态操作当成正式API或伪造成功按钮。公司的通知仍按原有明确占位，未冒充已实现发送。

验证：

- 失败先行的目录布局/隐藏字段搜索及列对齐测试，随后新增搭建入口填写和主区弹窗提交测试；KVVI定向139项通过。
- 最终整套GUI447文件通过、6351项通过、1跳过。完整构建（包含Host与Client类型检查）、提交范围lint通过。
- 新增 `apps/web/tests/kvvi-business.e2e.ts`：真正编译客户端+原DSH装配，在独立临时服务上以夹具API验证目录、隐藏列、弹窗提交一次及列表刷新，单独回归1项通过。截图位于 `reference/compiled-fixture-{home,records}-20261008.png`，只表示测试夹具，**不是7500截图或真实业务验收**。
- 检查修复了深色主题滚动条token重绑定；没有通过改写golden或放宽权限绕过失败。
- fork提交 `3f8138c6`。G2登记185路径、46条；导出177文件、8删除；独立重建逐字节验证与manifest验证通过。
- 受管stop/start已完成，platform PID44398、runtime PID44440；数据库保持运行、schema已最新，未重建数据库、未修改真实业务记录。
- 7500 healthz ok=true、schemaBehind=0/schemaExtra=0/schemaReadable=true。
- 同一实际profile/home/installAnchor解析kvvi-panel到仓库源码包；启动后的解析bundle sha256 `8329d30ad37b2f6f20f23f241e151b2be69e45027259a3bc8ca45b4cf82db14b`，包含directoryTable/recordToolbar/startBuilder及真实入口身份读取。实际新包已进入运行时解析，不是只更新7506的样例页面。
- 7500已登录页面的工具点击/截图仍受此前浏览器URL策略明确拒绝；未换浏览器、端口或CDP绕过，未把匿名页面/测试夹具当成真实登录验收。用户可刷新7500进行本地验收。

完整浏览器回归运行中，最终结果另附；临时日志 `/tmp/kvvi-prototype-{focused-final,gui-final,build-final,lint-final,web-focused,web-final,start,verify,manifest}.log`。中途Host浏览器用例误归Client program引起的构建失败已按原项目分层规范修复，产生的56个临时源旁输出已清理；中止的回归不算通过。

最终回归结果（17:15）：完整浏览器replay结束，120文件通过、1文件失败、1跳过；431项通过、1失败、15跳过。唯一失败是原 `queue-actions` 的sending快照在客户端`partial`段落尚未绘制时采样；队列测试未加载KVVI overlay。单独复跑复现同一缺失段落，之后对测试补充“已显示partial”里程碑等待，**未修改预期快照、未跳过断言、未修改会话运行逻辑**。修复后同文件3项全部通过、无未处理错误。首次整套运行仍记为失败；其他120文件与新增KVVI编译浏览器检查通过，不冒充修复后的全套单次exit0。

队列测试修复fork提交 `47541074`，最终G2为186路径/46条登记；导出178文件/8删除、独立重建逐字节验证和manifest验证通过。这项修复只有测试文件，不改变已部署的客户端bundle（sha256仍为`8329d30ad37b2f6f20f23f241e151b2be69e45027259a3bc8ca45b4cf82db14b`）。队列复查日志 `/tmp/kvvi-prototype-queue-{repeat,fixed,lint,commit}.log`。

## 新建业务入口缺失修复（2026-10-08）

用户提供的7500截图确认业务目录已更新，但builder账号没有「新建业务」。受管平台只读查询确认该账号当前活跃会话gateway为USER，服务端允许的入口为USER、BUILDER。此前按钮只按活跃gateway显示，导致有搭建资格但进入使用模式的账号无法发现搭建入口。

- `/auth/session`增加服务端判定的allowedGateways，当前gateway及对应tools不变。账号姓名不参与授权。
- 有搭建资格的账号在业务页右上角显示「新建业务」。当前为USER时，点击进入原`/kvvi/builder/login`登录流程；完成BUILDER登录后才可打开新建对话框。USER模式点击不创建目录、工作区或会话。实际搭建回调继续检查BUILDER，普通员工不显示入口。
- 失败先行验证缺失入口与身份返回值，再验证修复。平台身份/模式测试19项通过，KVVI定向140项通过，完整GUI447文件、6352项通过、1跳过；完整构建和提交范围lint通过。编译客户端浏览器夹具验证USER有资格时按钮可见并跳转正式搭建登录、无创建，BUILDER模式可打开新建弹窗，1项通过。夹具不是7500真实登录验收。
- fork提交`ce216c432372980eb596dfe707177c393aebcc87`；G2为186路径/46条，导出178文件/8删除，独立重建逐字节校验及manifest验证通过。
- 7500受管stop/start已完成，platform PID53717、runtime PID53738。healthz ok=true、schemaBehind=0/schemaExtra=0/schemaReadable=true；数据库保持运行，未改业务记录或账号授权。
- 同一实际profile/home/installAnchor解析到仓库kvvi-panel，bundle sha256为`1db1facdb16ac62d4eb6d74ca4470227546da5ae59bff0a7fea9c94926bd03eb`，包含allowedGateways和正式搭建登录跳转。7500工具浏览器访问仍受此前URL策略拒绝，未绕过，未声称完成真实页面点击验收。

用户验证：刷新7500 →「业务」→ 右上角「新建业务」→ 搭建者登录 →「业务」→「新建业务」。临时日志`/tmp/kvvi-builder-{auth-green,entry-focused,gui,build,web,lint,stop,start,fork-commit}.log`。
