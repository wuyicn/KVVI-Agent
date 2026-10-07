# 员工响应优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 当前业务背景进入第一次模型请求，断流等待及时收敛。
**Architecture:** 复用员工business工具与scoped prompt组装，后台精确匹配已发布系统并读取原fields；提供商增加可选输出进展控制，由KVVI组合设置15秒和一次重试。
**Tech Stack:** TypeScript / Cordis Loader / HTTP SSE / Vitest / Node24。
**Spec:** docs/superpowers/specs/2026-10-07-employee-response.md

## Global Constraints

- 原签名身份与平台权限判断不变；可见字段来源是已发布fields端点。
- 无跨员工缓存；目录提示不是身份、授权或必然唯一的系统绑定。
- 默认KVVI15秒无输出进展，最多重试一次；背景总等待2秒，支持取消。
- 唯一主实现者，实际试点仅读，保留员工测试会话。

## Review Focus

- 同名或名称/编码碰撞必须不绑定。
- 角色/发布变化在下一组装更新，背景刷新失败不能宣称旧资料当前有效。
- 持续心跳但无输出不能延长15秒进展计时。
- 分块一直有进展可超过15秒，不限制总生成时长。
- 中断前不完整工具参数不得执行；重试不得重做已执行写入。

## Task 1：业务背景

Files: packages/tool/kvvi-business/src/{index,client,system-context}.ts；tests/model-output.spec.ts；package.json/tsconfig.json/pnpm-lock.yaml；worker persona；包README/subsystem。
- [x] 写真实Loader组装反例：背景有精确系统/字段，刷新、拒绝、歧义、取消、卸载。
- [x] 看测试失败。
- [x] 以Agent.session.header.cwd及可选工作区显式标记提示+签名目录/fields构造动态上下文；2秒和取消，明确失败状态。
- [x] 新旧测试绿并更新合同文档。

## Task 2：等待策略

Files: packages/llm/llm-deepseek/src/config.ts、common/types.ts、两种协议adapter；tests/messages/adapter.spec.ts及adapter.spec.ts；KVVI cordis.patch.yml与组合测试；UI failure locale/MessageItem及测试。
- [x] 写进展中断、心跳、正常长流、取消及部署配置的反例并看失败。
- [x] 可选 streamProgressTimeoutMs 双协议 watchdog；KVVI设15000及maxRetries1。
- [x] 显示中文连接/超时结果；针对回归、Loader组合验证。

## Task 3：组合与交付

Files: snapshots/session/kvvi-record-read/*及headless.snapshot.ts；G2登记/指纹/镜像；本地联测/交接/问题清单；证据。
- [x] 更新当前scene夹具与owned金标准，built回放检查动态背景和实际数据。
- [ ] 完整构建，最终独立只读审查，必要补修red→green。
- [x] 提交fork、同步并构建原工作区；G2、导出/独立重建验证。
- [x] 在员工空闲时更新本地服务并用新会话只读测试；记录实际调用数/耗时/断流上限限制。

## Ledger

BASE：outer0cdcad4，fork6d0052f。复用前轮隔离clone；未提交的1204计时证据属于本任务上下文。
Ruling：业主“你都处理掉吧”授权完整实施前一条设计；方案与计划留存可审查，采用当前会话单实现，完成前不额外请求确认。

Ruling：现场 catalogue name 为 customer，而工作区为客户登记系统，精确目录匹配无法成立；加入工作区 `.kvvi-system.json` 显式编码提示，仍必须命中当前签名发布目录，不能授予权限。

Task 1/2：e1270be，真实Loader反例先红后绿；初始针对回归535/535，built CLI回放4/4，完整构建通过。新模块完整静态检查、提交时全部staged检查通过；全仓strict lint仍有既有模式路由/面板/测试错误，不作为全仓已绿。配置目录生成最初被模式secret无JSDoc阻断，补注释后生成与freshness检查通过。
Task 3：同步本地fork并导出164路径，156在场文件与8删除独立重建一致。最终复核与真实员工联测结果见证据，未推送、未合并main。

Review fix：实际独立复核指出业务名称中的{{变量}}被渲染器解析，反例先红后绿；af2d16d使用已有变量值单次替换不递归扫描的合同。最终536/536、4/4、完整构建通过。试点最终新会话字段零工具/2秒，回答结束无操作邀请；之前登记缺项零工具/2秒、记录一次工具/4秒。未执行业务写入。
