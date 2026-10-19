# 发行包安全续作

只在自有合成fixture操作包与源码；不运行旧self-test碰真实资产，不把源/构建通过当作发行验收。

## 第一批：失败保留旧输出与隔离自测

- [x] build先在同输出目录的私有candidate构造tar与manifest；扫描与写入使用同一次读取的body，缺文件/禁止内容/写包/写清单失败不改变旧pair。
- [x] 以OS文件锁串行化本工具build/check；发布前备份旧pair并写固定格式恢复日志，失败回滚，进程中断后下一次本工具调用先恢复。恢复先验证路径、类型、摘要与当前文件是否为旧/新预期，拒绝覆盖意外外部改动。日志与备份无法恢复时保留并拒绝，不删除唯一旧副本。不声称两独立文件对外部读取原子或已验证断电耐久。
- [x] self-test仅在合成最小仓库与包中做破坏测试，真实server/archive/manifest的bytes和mtime均不变；无真实包也可运行。
- [x] 先RED真实fixture含FORBIDDEN、tar/JSON/第二rename故障、symlink输出、进程退出后的恢复；定向与独立复核后提交。此批尚不修tar内容假绿或完成来源资格。

## 后续

- [x] v2逐tar成员核路径、唯一性、类型、链接与实际字节摘要/全集，内外typed rows与当前source一致，旧v1拒绝；必需文件严格regular，操作手册必须。正文/路径/链接/重复/缺多项/PAX/尾部/元数据反例闭环。复杂link先逐组件展开再处理..，真实系统tar安全正例通过；不可读目录拒绝而非漏源。此为当前源一致性，不是签名认证或完整来源/构建资格。
- [ ] 所有collect/count/main/check/self-test统一显式runtime-source，无vendor回退；固定完整源、完整host/native/client产物及目录/generated收据分别绑定，元数据只给实际资格。UI未消费正式目录、真实浏览器/模型/macOS等继续保留待办。


## 显式来源选择接线（尚不包含来源/构建资格）

- [x] build/check/API/CLI/collect/count/main统一RUNTIME_SOURCE显式绝对根；拒缺失、相对、末级link（含尾斜线）、bytes与不存在根，包内仍映射vendor/dsh，无旧树回退。self-test仅显式自有合成树；G9与证据collector全部传同一选择，不能隐式取仓库vendor。
- [x] workspace选包取根package.json.workspaces与pnpm当前顶层plain packages列表并集。仅支持当前固定源的简单路径/单段*，其他YAML/排除/递归/歧义模式固定拒绝；#仅空白引导才作注释。不实现通用YAML。所有已声明main后缀须为已入包相对路径，拒absolute/父级/排除node_modules realpath别名；不声称完整exports或依赖闭包。
- [x] 元数据必须已收录regular；源package.json顶层重复字段/深JSON拒绝，未使用的nested dependency映射沿Node语义（固定上游llm-retry有同值重复依赖）。这不放宽发行内外manifest的全层重复拒绝。目录含空格、node_modules字样、glob metachar均不可绕过。
- [x] G6-G9证据命令由shlex解析精确argv，仅解析不执行；新quote记录和G6-G8旧无quote记录均支持，G9新记录必须显式source。无真实collector执行、历史刷新或发行旅程。
- [ ] 下一批把固定Git完整source资格与完整host/native/client输出、目录/generated收据绑定到candidate和检查，source选择或入口存在本身不够。


## 固定源码资格接口

- [x] package_provenance.qualify_runtime_source读取仓库工具指定的可信manifest，绑定其原字节SHA256、固定Git基线与全部declared source清单；只在完整valid、count/profile/digest均符合时输出资格记录。失败仅固定码，无部分digest/count。
- [x] manifest普通文件稳定初读/复读，均在fd身份核对后拒超限size，读取最多16MiB+1；source workspace元数据同限制。CLI以-m运行，仅固定仓库manifest，不接受业务payload另选manifest。根为管理员控制，不声称原子树快照。
- [x] 7组Git夹具及双Python联合75项通过；实际新树12196项资格通过、旧built树拒绝。success仍releaseApproved:false，明确exec位/依赖/输出/client收据/目录消费/发行验收未鉴定。
- [x] v3将接口接入candidate前后、manifest内外绑定与G9必需校验；私有完整source表校验自身摘要后绑定candidate正文/链接与必收全集，阻断临时改动再恢复或漏收。main元数据核同表SHA，workspace由表枚举，最终candidate内main须解析到regular file。双Python92项及独立复核通过。
- [ ] 再接完整host/native/client构建与目录收据；v3现有source资格不代表输出来源或发行资格。

## 客户端收据完整性接口（批次49完成，待接候选）

先增加独立只读接口，不将现有source-only v3提升成构建资格。输入仍为显式runtime-source、Git对象及仓库固定G2。完整source资格成功后，从其表核对package.json原字节，并以同一G2原字节中的fork_head及固定package版本形成唯一允许的两个公开客户端环境值。未知公开变量、格式/重复键/深JSON/非regular收据固定拒绝，不输出原值。

收据固定为.dsh-build/client-build-environment.json。逐项收集上游五种模式的全部当前产物：web dist递归文件，以及packages两级包lib下client.js/client.js.map/client.*.js/client.*.js.map；按上游glob默认排除隐藏路径；web dist内匹配的node_modules也按上游计入，其他host输出不纳入。匹配文件、匹配目录及祖先link均拒绝；packages/CLAUDE.md这类未匹配文档link不读目标正文。按上游JavaScript UTF16排序与path字节长度/内容字节长度分帧重算digest及count，稳定初读/复读收据、完整source前后不变。成功API可显式返回私有typed artifact rows供下一批绑定candidate，失败不得留下部分资格。

测试使用真实自有Git基线及手工独立计算收据：缺/改/多产物、改环境、重复/超限JSON、路径link、校验中收据/source变化均拒绝；只读核实实际252产物。此接口只证明收据与当前产物完整性，不认证先前构建因果、依赖、host/native或目录消费；随后接v4候选及完整受控重建收据。

批次49实际17组与既有27组共44项双Python通过，独立Node glob/framing边界对照通过；新树252项收据匹配、旧built source拒绝。仅新增只读接口和CI；候选绑定及受控构建仍未完成。

## v4客户端候选绑定（批次50完成）

将客户端只读接口接build/check，不放宽源码资格。v4内外manifest同时绑定sourceQualification和clientQualification，后者source必须等于前者，收据和完整client typed rows以私有表摘要绑定。候选的五模式匹配集合须精确等于已验证表，类型/mode/bytes/SHA逐项相同，固定收据原bytes SHA也必须在候选中；不能临时换产物后还原，不能临时漏收某个chunk或receipt。候选完成前后均重新取得相同客户端资格并重新绑定；旧v3拒绝。

仅对.dsh-build这一目录放行遍历及精确client-build-environment.json，不附带其他元数据；G9源摘要加入新helper。自测与全部合成fixture生成自己的Git/source/client收据，不能借真实252产物假绿。不运行真实发行build/check/self-test。v4仍releaseApproved:false，完整host/native、构建因果、依赖、正式目录消费及产品旅程保持待办。

批次50双Python121项通过；目录型别名反例先RED，修复后两位独立闭环。typed候选图中匹配遍历目录的链接拒绝，文档filelink保留；实际只读16048行中12196固定源/252客户端/收据完整绑定，入口缺失0。未生成真实发行包；下一步完整host/native清单与受控重建凭证，再做目录消费及实际发行旅程。

## 全部声明输出清单（批次51完成，尚非构建凭证）

为受控重建先提供完整输出快照接口。只从已经完整鉴定source的excludedUnqualified中取已声明输出边界，精确排除.git、各node_modules及已验证为空的native/system/.release；不泛扫任意lib/dist。递归记录所有正文（包括types/map/增量文件）及发行规范化mode（0644/0755）/bytes/SHA；不鉴定完整原始文件权限，匹配客户端集合同时满足现有clientQualification。边界根/祖先/内部link与特殊文件均拒，目录不可读或遍历期间集合/正文变化拒绝。

两轮typed输出集合、完整source binding和clientQualification保持一致后，默认返回边界/count/完整typed digest及按路径划分的数量，私有全表仅显式请求。输出清单不是构建凭证；build causality、依赖和源码exec位等继续未鉴定。下一批在仅复制固定声明源的新自有工作区执行固定离线安装/完整构建，记录命令、工具身份及输入/输出清单，不在旧built树清理或重建。

批次51输出边界策略补充：声明输出目录内部若出现node_modules或.git命名空间，完整输出接口固定拒绝，不能当普通产物纳入，也不静默剪枝。即使web dist/node_modules当前匹配上游客户端收据，此更严格的全输出资格仍拒绝；客户端收据接口本身继续原五模式语义。第二轮输出遍历之后再复核完整source/client资格，以捕获末轮期间新增边界或源码变化。

批次51双Python55项通过，两位独立11项及APFS别名反例闭环；保留名按NFC+casefold拒绝。实际当前316边界9467文件完整typed digest04f8382c5ab5c4a8effc33441b003ee2c242b23eb851f1ea3848816bf5ab7f76。没有接入发行资格或运行新的构建；下一批先创建只含固定声明源的新工作区。

## 仅声明源码的新构建输入（批次52完成）

从已完整鉴定的显式runtime-source按可信私有sourceRows逐项读取，只复制固定正文/原始链接文本；每次读的type/SHA须匹配同一完整表，记录发行规范化mode及材料typed digest。依赖、旧lib/dist、增量、Git和构建收据均不因所在目录而被附带。普通文件独占创建，链接最后建立并核其包内目标，typed完整路径/别名/集合检查及完整固定source复验后才把私有stage发布到新或空目标。

拒绝非空/文件/链接/相对目标及输入源/Git对象根内的目标，失败保留旧目标，只清理自己的临时stage；源在复制前后完整资格和材料行相同。目标得到的固定源正文资格与材料摘要不是构建成功凭证；原始权限/预期exec策略、依赖及后续构建仍待受控runner，不删除或清理既有built目录。

批次52双Python68项通过、独立13项闭环；材料末读后完整复验、full stage qual后再核材料mode/body、最后实际全集严格闭包。实际clean-build-source-7faca1c02ae1仅12196固定源、0排除，未安装或build；输入材料摘要ecc7aa6df47e826d7d3bcf2f8df9923528c0be060fbd41a5ad45cf64c4fa8b09。下一批受控runner执行固定离线安装/完整构建，不能把此次复制称构建通过。

## 进程归属使用当前内核关系（批次53完成）

独立复核发现ps组/父子快照过期后，旧实现会把同PID当前无关进程加入owned表，再以其新起始身份误授权清理。group_members现在仅采纳当前内核PGID仍等于目标的行；descendants只将ps作候选关系，每条边要求子进程同次内核PPID匹配，并以已归属父进程前后相同起始身份夹住，最后再核root身份。关系变化或查询失败不作空集合成功。公开observe仍为原四字段，不把可重挂的PPID持久化为身份。

6项新回归含真实自有双session的过期组/父子快照、父/root身份变化及拒绝扩展无关孙进程；连既有身份/supervisor共46项双Python通过，独立复核真实对照闭环。只修共用归属发现，不声称WIP命令执行器异常清理已完成。

## macOS原生枚举与根退出确认（批次54完成）

持续worker/父查询实证短命setuid ps的内核身份读取可报EPERM，不能作为已退出忽略。Darwin改用libproc的proc_listpgrppids/proc_listchildpids，不再为归属发现创建ps后代；wrapper返回PID个数，buffersize是字节，每次清errno，零+errno/非法count/满容量无法完整读取均拒绝，满缓冲区扩容重读。返回语义按本机SDK及[Apple libproc源码](https://github.com/apple-oss-distributions/xnu/blob/main/libsyscall/wrappers/libproc/libproc.c)核实。Linux仍从ps取候选；两平台都保留内核当前关系与起始身份校验。

已确认为None的非root中间父不再扩展其旧候选边，身份变更/不可读/root退出仍失败。更快的原生枚举暴露了组已空但根子进程退出通知尚未到达的时窗；supervisor需同时确认根退出，不能只凭空组提前返回。6组新增测试连原身份/supervisor共52项双Python通过；真实自有进程及未知errno/扩容/截断边界验证，不是试点验收。

## 受控构建命令生命周期（批次55完成）

构建器先增加自有命令会话：父进程以结构化argv、显式cwd/env和新日志启动短小worker，worker创建独立session并在go握手前不启动命令。父进程先记录并核对worker内核起始身份；命令结束后worker保留session leader直到父进程确认组及已观测逃逸子进程退出，避免拿已回收PID做组信号。

超时/非零/遗留子进程不能变成构建通过。只在worker身份仍匹配时向该自有组发TERM/KILL；已观测到且换session的子进程逐个复核起始身份再发信号。身份不可读/变化时固定失败，不能凭端口或整数PID扩大清理。日志新建而非覆盖，命令不经shell，env无隐式继承；后续runner只提供最小公开构建环境。此为受控命令组及已观测后代的清理，不声称任意恶意进程逃逸/完整OS沙箱；未观测的脱离会话后代仍是显式限制。

父查询/身份故障或KeyboardInterrupt时，在control目录与leader仍存活期间请求worker协作停止。worker持续收集自身组/后代，可按当前内在session停止自己的组；父未知身份不授权数字组信号。worker提前退出时，父仍逐起始身份清理已在受核root下采纳的known children，禁止对旧组发信号，范围未知保持未确认；中断清理后重新抛出。控制父进程起始身份也被worker绑定，父死亡/变化/不可读触发worker自清。

正常result也携worker完整已观测身份表，父在root前后核对下合并；worker收到ack须再核自身known无活后代，有遗留转stop/失败。最终无存活组/已观测身份且discovery可确认，才给cleanupConfirmed；命令exit0和worker正常ack退出同时满足才valid。控制故障永不升级成valid，即使已清理。合作取消有界，超限只结束自有直接Popen worker并保持未知，不能声称已清空任意不受控后代。

14项新真实自有进程测试连既有membership/identity/supervisor共66项双Python通过；初缺模块、异常遗留、中断/worker crash、controller死亡、worker观测未合并及ack放行均有RED记录。独立14项及带worker观察日志的父漏报/延迟/误报空三场景均闭环，无存活后代；不执行安装/build或赋予发行资格。

## 新工作区离线完整构建执行器（批次56完成）

仅接受新的独占workspace、显式node/pnpm entrypoint/store；拒已存在目录或source/objects/store内部目标。完整固定源复制到workspace/source，日志、最小HOME/TMP/XDG及pnpm shim均在source外。新源packageManager/engines须匹配固定11.7.0和当前上游Node约束；工具普通文件稳定摘要、实际版本/Node host架构观察及固定离线install/full build命令通过自有会话执行，不继承调用环境/凭据。shim以绝对node/entrypoint带原argv exec，阻止子脚本落到全局pnpm。

成功收据绑定初始完整源码材料行、明确工具entrypoint字节、实际命令退出与完整日志摘要、最终相同source材料及完整输出清单/client收据。失败保留自己的workspace/日志和固定阶段状态，不产生成功收据，不重用或清理旧built目录。入口哈希不鉴定完整工具链/依赖闭包，offline不代表OS网络沙箱；没有工具来源认证、预期输出齐全或产品/目录消费/发行验收声明。


批次56收紧：policy package.json读取须等于初始固定材料行，防临时改读后恢复；表/命令metadata以精确canonical正文写后核对并绑定，原日志和pnpm shim最后仍须匹配。所有日志初读前限制16MiB，超限固定失败，不先分配无限正文。package/engines非mapping固定拒绝。

成功收据先写私有build-receipt.candidate.json；候选原正文、输入/工具/shim/记录/日志及第二轮完整输出资格和全rows相同后，最后以os.link独占发布build-receipt.json。候选保留为同inode别名；消费者只认最终路径和后续完整验证。发布是commit点，之后无验证/清理IO；提交点之后的进程中断与准备失败不同。此为单收据原子发布，不声称整文件树原子快照或断电耐久。

23新组及既有来源/材料/输出/进程边界共157项双Python通过，两位独立23项及原政策ABA、晚改输出/外置表/命令metadata/收据故障/中断/大日志等反例闭环。实际仅只读调用固定pnpm store path，确认--store-dir /Users/wuyi-macs/.pnpm-store得到实际/Users/wuyi-macs/.pnpm-store/v11；尚未通过此runner执行真实安装或构建。下一批独占新实际workspace做受控重建，失败原样保留。

## 实际首次失败及运行边界（批次57完成）

新实际controlled-build-1210fe5bfe6e的install由owned会话确认exit0/cleanup true；build日志tsx创建TMPDIR下Unix socket报EINVAL，实际路径超过本机SDK sun_path[104]。build会话却记控制失败/exit未知/cleanup未确认，其控制异常根因仍UNKNOWN，不能从另一个纯fixture推断。完整失败工作区及日志保留，无成功收据；不重用它重试。

runner增加固定tsx socket路径字节长度预检（Darwin104/Linux108，含最大PID后缀），过长在创建工作区/安装前拒；下一次使用新的持久短路径目录。另独立纯fixture证明已获非root中间父在候选query时退出并失败会误abort；现在query前及异常后复核，仅内核None的非root跳边，不给未知/复用/root失踪空集合成功。该边界修复不当作首次真实控制异常的已证根因。

命令控制记录补固定failurePhase/failureCode/cleanupFailureCode/workerFailureCode，只给显式码白名单及类型fallback，不回显任意异常文本，便于下一次实际控制失败归因。双Python163项及独立反例复核闭环；未有真实build成功收据或产品验收。


批次57诊断安全补充：不调用str(error)，只从BaseException原生args descriptor取得单个原生字符串并匹配白名单，其他固定fallback；实际不可格式化ValueError及覆写args属性反例不打断清理。新增build-input.json在所有命令之前保存工具、最小环境及材料观测，失败也保留，成功收据及最终行核验同时绑定；首次失败没有该新文件，不能事后回填当历史证据。
