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
