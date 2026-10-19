# 固定 fork 完整源码核验

本批只做只读源码核验。固定基线全部Git blob/mode与已登记overlay合成预期清单，不把248个改造点匹配当作整棵树匹配。源码核验、依赖、构建产物、收据和发行资格分别取证；本工具不触发构建、清理或部署。

- [x] 新增工具/lib/runtime_source.py，固定指纹中的完整基线，Git读取禁用replace objects；核全部普通文件原始blob hash、overlay SHA256、15个原始symlink target与8个删除路径。普通文件及父目录不允许链接，删除用lexists。
- [x] 先核预期源码，再扫描额外项。仅从已核源码的package.json/tsconfig/prebuilds推导依赖与输出排除；根.git、声明项目lib、web dist、两个增量文件、精确构建环境JSON和声明native产物属于未鉴定排除项。不得泛用.gitignore或任意lib/dist放行源外文件。
- [x] 测未改动上游文件篡改、额外源码、同内容链接、等价但不同文本target、父目录外链、悬空删除残留、缺基线和replace ref；实际fixed-dsh完整核验，结果明确不覆盖排除项、可执行位、依赖或bundle。受控本地根，不声称对并发目录攻击者提供原子快照。
- [x] 定向测试与独立复核、最终日志退出后提交推送，再把此规则接入显式runtime-source打包和构建收据；本批不把源匹配称发行验收。

更正早期只读查找：忽略文件搜索漏看了fixed-dsh/.dsh-build/client-build-environment.json。直接读取并调用上游readClientBuildRecord已验证其252客户端产物摘要为e0f13ae686f10844d746733c9e06a877c81e9a036cc03bd0a98ee8baa9778f7b；registered-fork没有该记录。此核验尚未绑定本批完整源清单/host产物/目录与打包，不作为发行资格。


私有inventoryProfile为kvvi-declared-source/v1：按相对路径UTF-8字节排序，逐项[path, file或symlink, 原始文件/链接文本SHA256]数组，JSON无空白、ensure_ascii=false、UTF-8编码后SHA256。它不是公开spec c14n。失败报告中的inventoryDigest只覆盖已匹配项，不是合格整树摘要；必须先判断valid。可执行位和排除内容均未鉴定。

实际fixed-dsh仍拒绝：apps/desktop/scripts/node-bin/node.cmd及apps/desktop/scripts/windows-sign.cmd为CRLF，而固定blob为LF；packages/tool/kvvi-business/package.json的scripts与overlay不同。未改该目录或把字节规则改为换行归一。另用固定Git原始blob分批导出、当前overlay覆盖/删除构造独立canonical-source参考树，12196项匹配；它没有构建产物，不可替代原built树或发行资格。
