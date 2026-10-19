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
