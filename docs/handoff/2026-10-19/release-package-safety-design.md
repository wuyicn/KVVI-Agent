# 发行包安全续作

只在自有合成fixture操作包与源码；不运行旧self-test碰真实资产，不把源/构建通过当作发行验收。

## 第一批：失败保留旧输出与隔离自测

- [x] build先在同输出目录的私有candidate构造tar与manifest；扫描与写入使用同一次读取的body，缺文件/禁止内容/写包/写清单失败不改变旧pair。
- [x] 以OS文件锁串行化本工具build/check；发布前备份旧pair并写固定格式恢复日志，失败回滚，进程中断后下一次本工具调用先恢复。恢复先验证路径、类型、摘要与当前文件是否为旧/新预期，拒绝覆盖意外外部改动。日志与备份无法恢复时保留并拒绝，不删除唯一旧副本。不声称两独立文件对外部读取原子或已验证断电耐久。
- [x] self-test仅在合成最小仓库与包中做破坏测试，真实server/archive/manifest的bytes和mtime均不变；无真实包也可运行。
- [x] 先RED真实fixture含FORBIDDEN、tar/JSON/第二rename故障、symlink输出、进程退出后的恢复；定向与独立复核后提交。此批尚不修tar内容假绿或完成来源资格。

## 后续

- [ ] 逐tar成员核路径、唯一性、类型、链接与实际字节摘要/全集；不能只更新外部archiveSha256就篡改内容。新旧清单格式明确，必需文件类型严格；补正文篡改、../outside、绝对链接、重复与缺/多文件反例。
- [ ] 所有collect/count/main/check/self-test统一显式runtime-source，无vendor回退；固定完整源、完整host/native/client产物及目录/generated收据分别绑定，元数据只给实际资格。UI未消费正式目录、真实浏览器/模型/macOS等继续保留待办。
