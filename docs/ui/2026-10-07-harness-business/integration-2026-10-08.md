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
