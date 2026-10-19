# 固定 fork 完整源码核验

本批只做只读源码核验。固定基线全部Git blob/mode与已登记overlay合成预期清单，不把248个改造点匹配当作整棵树匹配。源码核验、依赖、构建产物、收据和发行资格分别取证；本工具不触发构建、清理或部署。

- [x] 新增工具/lib/runtime_source.py，固定指纹中的完整基线，Git读取禁用replace objects；核全部普通文件原始blob hash、overlay SHA256、15个原始symlink target与8个删除路径。普通文件及父目录不允许链接，删除用lexists。
- [x] 先核预期源码，再扫描额外项。仅从已核源码的package.json/tsconfig/prebuilds推导依赖与输出排除；根.git、声明项目lib、web dist、两个增量文件、精确构建环境JSON和声明native产物属于未鉴定排除项。不得泛用.gitignore或任意lib/dist放行源外文件。
- [x] 测未改动上游文件篡改、额外源码、同内容链接、等价但不同文本target、父目录外链、悬空删除残留、缺基线和replace ref；实际fixed-dsh完整核验，结果明确不覆盖排除项、可执行位、依赖或bundle。受控本地根，不声称对并发目录攻击者提供原子快照。
- [x] 定向测试与独立复核、最终日志退出后提交推送，再把此规则接入显式runtime-source打包和构建收据；本批不把源匹配称发行验收。

更正早期只读查找：忽略文件搜索漏看了fixed-dsh/.dsh-build/client-build-environment.json。直接读取并调用上游readClientBuildRecord已验证其252客户端产物摘要为e0f13ae686f10844d746733c9e06a877c81e9a036cc03bd0a98ee8baa9778f7b；registered-fork没有该记录。此核验尚未绑定本批完整源清单/host产物/目录与打包，不作为发行资格。


私有inventoryProfile为kvvi-declared-source/v1：按相对路径UTF-8字节排序，逐项[path, file或symlink, 原始文件/链接文本SHA256]数组，JSON无空白、ensure_ascii=false、UTF-8编码后SHA256。它不是公开spec c14n。失败报告中的inventoryDigest只覆盖已匹配项，不是合格整树摘要；必须先判断valid。可执行位和排除内容均未鉴定。

实际fixed-dsh仍拒绝：apps/desktop/scripts/node-bin/node.cmd及apps/desktop/scripts/windows-sign.cmd为CRLF，而固定blob为LF；packages/tool/kvvi-business/package.json的scripts与overlay不同。未改该目录或把字节规则改为换行归一。另用固定Git原始blob分批导出、当前overlay覆盖/删除构造独立canonical-source参考树，12196项匹配；它没有构建产物，不可替代原built树或发行资格。

## 下一批：重建导出保留固定blob原字节

- [x] raw_git_source.py从禁replace的固定基线分批cat-file导出；先验证路径/类型/链接目标与Git blob hash，在自有staging构造后替换空目标，拒绝非空/链接目标，错误不留下半套被宣称成功的源。
- [x] fork.py的local与git来源共用原字节导出，不走archive/checkout EOL转换；git来源在临时对象目录clone --no-checkout，仍仅使用固定基线。保留原overlay/删除规则，无现有built目录覆盖。
- [x] 先RED含eol=crlf、可执行源和链接的真实Git fixture，以及不空/外链目标、缺基线/replace；隔离新目录实际完整重建后跑12196项源核验。重建与构建/打包资格分别记录，复核后提交。

文件系统别名以O_EXCL/NOFOLLOW创建和staging实际路径/目录拼写集合核对拒绝，覆盖APFS大小写/Unicode合并；clone异常固定返回False并清理临时对象。最终新raw-rebuild-kb2jqs9a已12196项全部匹配。此树尚未安装依赖或构建，原fixed-dsh仍保留三处失败；网络分支本批只用本地clone夹具，不声称GitHub连通。
