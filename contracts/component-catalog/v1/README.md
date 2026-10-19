# KVVI React 静态组件目录 v1

catalog.json 是独立于 Fake 样例的受控目录资产；完整引用为 PLATFORM_CONTROL / kvvi-platform / COMPONENT_REGISTRY / kvvi_react_core / version 1，app_id/module_id 必须为 null。ref.digest 对 content 按 kvvi-json-c14n/v1 计算，文件字节 SHA 与此摘要不是同一个概念。catalog.schema.json 规定本版本的身份、组件集合与离线属性 schema 子集。

18项包含3个页面根、Section/Grid、10类字段控件及3个值组件。只声明现源码真正读取的属性：Section 的字面 title、字段的 FieldRef、Text 的字面 text 或 value、Description/StatusBadge 的 value。字段标签、选项和权限来自模型及平台上下文；表单草稿是文本，原生十类型转换由调用方 values.ts 完成。ListPage 仅表示静态容器，不表示已有列表查询实现。未执行能力列在 unsupported，不因历史 Fake 允许就放行。

adapter 使用真实 React 身份，不沿用 vue_element_approved。当前 DSH 锁文件解析 React 18.3.1；kvvi-panel/package.json 与 vendor/dsh/LICENSE 声明 MIT，上游固定基线见 upstreamBase，KVVI overlay 另见 forks/dsh/改造点清单.md 及指纹。FormView 固有提交区仍依赖 DSH ui-primitives；主题依赖宿主 DSH CSS 变量。这不是第三方传递依赖许可审计结果。

sourceFiles 是5个核心文件，integrationWitnesses 是3个实际创建/详情接线文件，路径均相对选定DSH根。它们是显式源码清单，**不是完整传递闭包**，也不包含生成元数据，避免目录与生成副本摘要循环。qualifyComponentAdapter / qualify_component_adapter 核对8个文件，不生成 bundle 资格或发行资格。生成副本、依赖锁、构建输入、输出chunk、发行与实际HTTP服务摘要仍须另取证。

Node/Python 的 readInstalledComponentCatalog / read_installed_component_catalog 只从固定安装目录读取；resolve接口完整比较8字段及官方摘要。validateCatalogDocument / validate_catalog_document 仅判断输入文档完整性，不会将上传者文档登记为可信来源。目录/文件的软链接、非普通文件与过大文件拒绝；这以管理员控制安装根为前提，不声称能抵御有权限并发替换安装目录的本机攻击者。

PUBLISHED 是本目录内容的注册状态，不代表所有消费者或产品已迁移。本批客户端、发布API、runtime与Python蓝图尚未消费本目录；后续须共享树/模型引用判据、生成客户端映射并验证构建产物。旧视图不会自动改引用；同版本内容不得由更新流程覆盖，需新版本、明确迁移和重新发布。现有冻结样例与历史摘要保持原含义。
