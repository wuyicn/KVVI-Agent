# 正式组件目录与完整引用：执行设计

依据交接任务10与冻结协议，继续由主实现者编辑、独立复核只读；每个可验证批次提交推送。Fake样例不是正式目录，旧视图不会在启动时被补成latest或伪造app/module。本文描述后续分批接口，不表示已实现或已部署。

## 第一批：可导入的正式规范化基础

- [x] 新增tools/meta-schema/node/canonical.mjs：canonicalizeJson(rawText, profile)与canonicalizeBytes(bytes, profile)，返回既有协议的canonical、UTF-8 hex、sha256摘要；默认profile为kvvi-json-c14n/v1。直接复用独立Node参考算法，记录出处，冻结参考文件不改。
- [x] services/platform/tests/canonical.test.mjs先RED：冻结7正向/10反向向量；UTF-8与UTF-16键序差异；重复解码键、精度已经丢失前的非整数/超范围原始token；错误UTF-8/BOM、未知profile；导入不得读stdin或写stdout/exitCode。
- [x] Fake resolver的contentDigest改为调用同一模块，保持现有JSON对象输入及Fake隔离语义；不将它或contracts.mjs旧digest提升为正式AssetRef资格。
- [x] 定向测试、完整平台回归及既有双语言Meta-Schema语料都通过后保存最终日志摘要，复核、commit/push。不刷新历史证据快照。

## 后续批次的边界

中立权威JSON放contracts/component-catalog/v1；包含完整PLATFORM_CONTROL引用、真实React适配器身份/许可/源码闭包摘要与严格能力声明。现23个映射中Table不可用、表单按钮节点未执行；仅可登记实际实现的子集，loop/condition/queries/action/i18n等未实现能力明确拒绝。不能沿用vue_element_approved或no-renderer来声称满足冻结Vue适配器要求。

Node/Python直接读取同一目录，DSH内生成携带相同目录摘要的TS元数据并核对显式renderer集合；平台不加载DSH插件。生产resolver只信受控安装目录，不信上传者fake_assets或production自声明；保留现有Fake完整校验入口。正式目录、共享校验与各消费端分别先失败反例、再实现。

模型引用须有真实TENANT/company/app/module/asset/version/digest身份。目前published_contracts没有完整身份；另加不可变元数据及profile，不从schema_code猜app或回填旧摘要。view只可引用明确存在且内容摘要一致的版本；发布API prepare和最终publish事务均复验，runtime拒绝已升级模型与旧view错配，要求显式修订审批重发。

发行包须显式选择固定fork源，核完整源码inventory、生成目录、实际host/client输出及构建收据；解包和HTTP实服务摘要另验。源测试、Git提交、构建成功、发行和产品验收各自取证。目录摘要嵌入bundle，bundle摘要放独立manifest避免循环。当前仍缺这些实现，不勾选任务10/11。
