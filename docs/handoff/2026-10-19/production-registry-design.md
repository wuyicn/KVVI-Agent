# 正式组件目录与完整引用：执行设计

依据交接任务10与冻结协议，继续由主实现者编辑、独立复核只读；每个可验证批次提交推送。Fake样例不是正式目录，旧视图不会在启动时被补成latest或伪造app/module。本文描述后续分批接口，不表示已实现或已部署。

## 第一批：可导入的正式规范化基础

- [x] 新增tools/meta-schema/node/canonical.mjs：canonicalizeJson(rawText, profile)与canonicalizeBytes(bytes, profile)，返回既有协议的canonical、UTF-8 hex、sha256摘要；默认profile为kvvi-json-c14n/v1。直接复用独立Node参考算法，记录出处，冻结参考文件不改。
- [x] services/platform/tests/canonical.test.mjs先RED：冻结7正向/10反向向量；UTF-8与UTF-16键序差异；重复解码键、精度已经丢失前的非整数/超范围原始token；错误UTF-8/BOM、未知profile；导入不得读stdin或写stdout/exitCode。
- [x] Fake resolver的contentDigest改为调用同一模块，保持现有JSON对象输入及Fake隔离语义；不将它或contracts.mjs旧digest提升为正式AssetRef资格。
- [x] 定向测试、完整平台回归及既有双语言Meta-Schema语料都通过后保存最终日志摘要，复核、commit/push。不刷新历史证据快照。

## 后续批次的边界

### 第二批：目录文件与受控加载

- [x] 新增contracts/component-catalog/v1/catalog.json及catalog.schema.json，完整PLATFORM_CONTROL/kvvi-platform/kvvi_react_core/v1引用，内容使用kvvi-json-c14n/v1摘要。目录声明18个静态组件，props仅实际读取语义；源清单分别记录5个核心文件和3个接线见证，不称传递闭包，明确React/DSH依赖和source-only证据界限。
- [x] tools/meta-schema/node/component_catalog.mjs提供readInstalledComponentCatalog()、resolveComponentCatalog(ref)、validateCatalogDocument(bytes)及qualifyComponentAdapter(runtimeRoot)。前两者只读固定受控目录，拒绝未知版本、错误摘要及不完整/额外身份字段；validate仅判断文档完整性，不授上传文档信任。返回深冻结对象，不接受caller fake_assets。
- [x] tools/meta-schema/python/component_catalog.py按同一schema/参考c14n提供等价读取、引用解析、文档完整性与源码清单核验。受控读取逐级拒绝软链接、非普通文件、缺失与过大文件；源码资格只覆盖清单条目，返回不声称bundle身份。
- [x] 新增真实Node/Python互操作测试：正式ref与18组件集、Fake/未知版本/篡改/重复键、unsupported组件与props、调用者不能改已加载内容；自有重建源清单匹配及逐项改字节/丢失/链接反例。CI运行两种实现。平台完整回归、独立复核后提交推送；本批不改DSH，不声称renderer已消费目录。

中立权威JSON放contracts/component-catalog/v1；包含完整PLATFORM_CONTROL引用、真实React适配器身份/许可/源码闭包摘要与严格能力声明。现23个映射中Table不可用、表单按钮节点未执行；仅可登记实际实现的子集，loop/condition/queries/action/i18n等未实现能力明确拒绝。不能沿用vue_element_approved或no-renderer来声称满足冻结Vue适配器要求。

Node/Python直接读取同一目录，DSH内生成携带相同目录摘要的TS元数据并核对显式renderer集合；平台不加载DSH插件。生产resolver只信受控安装目录，不信上传者fake_assets或production自声明；保留现有Fake完整校验入口。正式目录、共享校验与各消费端分别先失败反例、再实现。

模型引用须有真实TENANT/company/app/module/asset/version/digest身份。目前published_contracts没有完整身份；另加不可变元数据及profile，不从schema_code猜app或回填旧摘要。view只可引用明确存在且内容摘要一致的版本；发布API prepare和最终publish事务均复验，runtime拒绝已升级模型与旧view错配，要求显式修订审批重发。

发行包须显式选择固定fork源，核完整源码inventory、生成目录、实际host/client输出及构建收据；解包和HTTP实服务摘要另验。源测试、Git提交、构建成功、发行和产品验收各自取证。目录摘要嵌入bundle，bundle摘要放独立manifest避免循环。当前仍缺这些实现，不勾选任务10/11。
