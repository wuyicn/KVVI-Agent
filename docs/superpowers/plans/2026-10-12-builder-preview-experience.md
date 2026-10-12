# KVVI 搭建预览体验 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 推荐当前主代理连续实现，结束后独立复审；待用户确认执行方式。

**Goal:** 消除后台空白消息，把普通登记表搭建接成可试填、可修改、可确认提交的真实闭环。

**Architecture:** 业务会话只呈现可见内容及必要交互；服务端负责固定草稿生成、验证与不可变版本，前端呈现左侧预览和右侧对话。提交复用现有发布通道，提交快照必须等于用户确认的预览，不改变所有者审批规则。

**Tech Stack:** 当前仓库 Node.js ESM、PostgreSQL、DSH Cordis、TypeScript、React、Vitest 与内置浏览器；不引入新 UI 框架或另一套验证标准。

**Spec:** `docs/superpowers/specs/2026-10-12-builder-preview-experience-design.md`

## Global Constraints

- 后台工具执行、推理及内部检查仍记录在受控诊断中，但不进入业务消息列表。
- 不得删除历史原始记录。原始自由文本历史不批量重写。
- 只处理已支持的表达；不允许任意代码、任意路径或任意数据库访问。
- 权限尚未确定时允许预览，但不默认赋予销售或其他角色全量访问。
- 试填使用独立的临时数据，不能调用正式记录写入、审批执行或外部连接。
- 所有者提交自己的修改仍遵守既有禁止自审批规则，不能借预览入口绕过。
- 先在 7506 确认工作台布局，再在隔离测试数据中跑真实预览和提交流程，最后接入 7500。
- 现有店铺草稿不自动提交、发布或覆盖。所有测试数据库由 `services/platform/tests/run-isolated.mjs` 创建。
- 在现有 `codex/grouped-business` worktree 工作；nested `vendor/dsh` 单独提交，再登记、导出 fork。禁止直接合并 main 或推送。

## Review Focus

1. 只有推理的步骤后来流入文字或图片：先不占位，再出现内容；对应 Task 1。
2. 用户输入本身包含 SQL、API 或产品代码：保留业务数据，不做关键词删改；对应 Task 2。
3. 生成中切换公司、身份或工作区，旧请求迟到：旧结果不能出现在新上下文；对应 Task 5。
4. 提交与修改并发，或服务器成功但网络超时：不提交未确认版本、不重复建单；对应 Task 6。
5. 验证器缺失、超时或版本不匹配：允许看已有内容，但不能假装检查通过；对应 Task 3。

## 接口与文件边界

以下为本计划新增接口，不代表当前已经存在。平台消息采用现有错误码到业务文案的映射，不将内部结果直接显示给用户。

`FormBlueprint` 是受控输入：`{name, fields, uniqueRules, permissions}`。每项字段为 `{code,label,type,required,options?}`，`type` 限 `text | single_select | date | multiline_text`；`options` 为单选值和名称列表；`uniqueRules` 为字段 code 数组的数组。`permissions` 为 `null` 或用户明确确认的公司角色与允许动作、数据范围，不为 null 时仍须服务端核验。经营状态以已有固定登记状态能力支持，不接受执行代码。

`BuildSnapshot`：`{intentId, revision, digest, state, blueprint, preview, issues, submission}`。`state` 限 `needs_input | preparing | invalid | ready | submitting | awaiting_approval | rejected | published`；`issues` 为 `{code,field?,messageKey}` 数组；`submission` 为 null 或 `{operationId,draftId,status}`。完整六份发布内容保存在服务端，不作为普通聊天文本展示。

平台对身份已认证的调用提供：`GET /api/v1/builder-drafts/:intentId`、`PUT /api/v1/builder-drafts/:intentId`、`POST /api/v1/builder-drafts/:intentId/submit`。PUT 输入 `{expectedRevision,operationId,blueprint}`；首次 revision 为 0。提交输入 `{revision,digest,operationId}`，只接受浏览器本人确认入口；不接受客户端替换已保存的契约。既有签名 runtime 通道可调用准备及读取，不可调用此浏览器提交入口。

## Task 1 消除后台步骤的空白占位

**Files:** 修改 `vendor/dsh/packages/client/ui-chat/src/client/chat/business-presentation.ts`、`ChatNodeSeat.tsx`、`AssistantNodeView.tsx`；测试 `vendor/dsh/packages/client/ui-chat/tests/chat-view.client.spec.tsx`，新增 `business-visible-content.client.spec.ts`；同步该包 README。

**Interfaces:** 新增 `businessVisibleBlocks(blocks: ChatNode<'assistant-step'>['data']['blocks'])`，返回实际可呈现的文字和图片块；新增 `hasBusinessVisibleContent(node: ChatNode): boolean`，供外层与内层共用同一判据。错误、交互及最终动作另按原语义保留。

- [ ] 写失败测试：102 个仅推理步骤生成 0 个 `[data-chat-flow-kind="assistant-step"]`；空白字符串不算内容，图片算内容；同 key 从推理变正文后出现 1 个节点；错误及待答问题仍可见；非业务模式不改变。
- [ ] 从 `vendor/dsh` 执行 `pnpm exec vitest run packages/client/ui-chat/tests/chat-view.client.spec.tsx packages/client/ui-chat/tests/business-visible-content.client.spec.ts`，确认因空消息外层而失败。
- [ ] 用共享判断在 `ChatNodeSeat` 返回空之前保留 Hook 调用顺序，在 `AssistantNodeView` 复用块过滤；不依赖 CSS 隐藏或 DOM 内容扫描。不更改持久事件。
- [ ] 重跑上述测试并通过浏览器读取 DOM 的占位数及间距；检查历史加载、流式更新、图片、复制和滚动锚点。
- [ ] nested 提交 `fix(chat): omit empty business process seats`，记录红绿测试和实机差异。

## Task 2 业务状态与交流约束

**Files:** 以下包路径均以 `vendor/dsh/packages/` 为根：修改 `client/ui-chat/src/client/chat/business-presentation.ts`、`client/ui-chat/src/client/chat/ChatNodeSeat.tsx`、`client/ui-chat/src/client/locale.ts`；修改 `preset/agent-presets/presets/kvvi-builder/agent.cordis.yml`、`preset/agent-presets/presets/kvvi-worker/agent.cordis.yml`、`client/kvvi-panel/src/client/builder-start.ts`；新增 `client/kvvi-panel/src/client/build-status.ts` 及 `client/kvvi-panel/tests/build-status.spec.ts`。目标摘要接入 `client/ui-goal/src/client/GoalBar.tsx`，回归 `client/ui-goal/tests/goalbar.client.spec.tsx`。

**Interfaces:** `buildStatusKey(snapshot: Pick<BuildSnapshot,'state'|'issues'>): KvviKey` 只映射服务端状态；执行中的重复诊断按同一运行与错误码合并。目标完整原文保留在日志，普通界面显示业务目标摘要，不能用正则改写用户输入。

- [ ] 写失败测试：同一后台阶段仅一个状态；权限拒绝与连接失败有不同文案；`ready` 以前不出现“预览已更新”；输入 `API 客户登记` 和产品编号原样保留；原始事件未变。
- [ ] 执行 `pnpm exec vitest run packages/client/kvvi-panel/tests/build-status.spec.ts packages/client/ui-chat/tests` 并记录失败。
- [ ] 实现状态映射与目标摘要呈现；让搭建 persona 将草稿交付给工作台而不是复述路径和技术校验。Task 4 的固定工具接通前，不把提示改为调用不存在的工具。既有提问失败显示可重试状态；固定提交不再依赖提问工具。
- [ ] 重跑测试，补充搭建者、所有者与员工新建/修改/失败回放。纯模型指令测试不能作为真人可见文案验收。
- [ ] nested 提交 `fix(builder): keep progress and handoff business-facing`。

## Task 3 固定登记表生成与验证

**Files:** 新增 `services/platform/src/builder-blueprint.mjs`、`builder-validation.mjs`、`builder-components.mjs` 与对应 `services/platform/tests/builder-blueprint.test.mjs`、`builder-validation.test.mjs`。读取既有 `tools/meta-schema/node/cli.mjs`、`tools/meta-schema-full/0a-full-r1/verify-node.mjs`、`runtime-projection.mjs`、`publish-api.mjs` 及 `kvvi-panel/src/client/registry.tsx`。

**Interfaces:** `compileBlueprint(blueprint, {assetId,roleCatalog}) -> {contracts,preview,issues}`；`validateBuildContracts({contracts,context,signal}) -> Promise<{valid,issues}>`。业务模型和视图调用权威完整检查，其余四份调用已有结构检查并复用发布编译与跨契约检查。不把结构通过等同全部语义通过。

- [ ] 写失败测试：八字段登记表可生成六份完整内容；单选、必填、日期及单字段/组合不重复映射正确；未知类型、重复 code、缺选项、跨公司角色、未知动作被拒；permissions=null 时可预览但不能 ready。
- [ ] 写验证失败测试：验证器缺失/超时/无效输出/版本不匹配返回 invalid，不能借 fixture 或成功默认值放行。对实际渲染器未支持的组件拒绝生成。
- [ ] 在 `services/platform` 执行 `node tests/run-isolated.mjs node --test tests/builder-blueprint.test.mjs tests/builder-validation.test.mjs`，确认红。
- [ ] 实现纯生成器、生产组件白名单和验证适配器。验证进程使用固定入口、无 shell 拼接、隔离临时目录与确定超时；启动时检查资源，不逐次安装依赖。规则只用既有协议表达，发现协议不能表达就返回业务问题。
- [ ] 重跑测试并验证同输入产生稳定输出；记录纯生成、验证耗时。测试要覆盖原八字段实例而非仅新造最小夹具。
- [ ] root 提交 `feat(builder): prepare validated registration blueprints`。

## Task 4 持久草稿版本与受控生成工具

**Files:** 新增 `services/platform/sql/34-builder-drafts.sql`、`src/builder-drafts.mjs`、`src/builder-draft-api.mjs`、`tests/builder-drafts.test.mjs`、`tests/builder-draft-api.test.mjs`；修改 `src/server.mjs`。在 `vendor/dsh/packages/tool/kvvi-publish/src/` 新增 `prepare.ts` 并在 `index.ts` 注册；新增 `tests/prepare.spec.ts`；更新 package README。

**Interfaces:** `readBuildSnapshot(ctx,intentId)`、`prepareBuildSnapshot(ctx,{intentId,expectedRevision,operationId,blueprint})` 返回 `Promise<BuildSnapshot>`。新增工具 `builder_prepare` 接受 PUT 同形输入，身份只来自 mode router，调用 Task 3 并返回业务摘要和 snapshot 定位，不返回数据库凭据或文件路径。

- [ ] 写失败测试：同公司同创建者的搭建资格检查、员工/跨公司/撤权/过期拒绝、版本冲突、并发修改一胜一败、相同 operationId 重放不重复生成。模型不能通过调用提交路由绕过浏览器确认。
- [ ] 按 Task 3 隔离命令运行新增测试，确认红；从 nested 执行 `pnpm exec vitest run packages/tool/kvvi-publish/tests/prepare.spec.ts`。
- [ ] 建立草稿头与不可变 revision 表，主键包含公司和意图；提交关联另存 receipt。长验证在事务外执行，保存时重新校验权限及 expectedRevision，失败不覆盖已完成版本。审计沿用现有受控写入入口。
- [ ] 注册工具并切换标准登记表的 persona/技能到固定能力；权限未确认保留 needs_input。旧草稿导入只读取 mode router 已授权当前工作区内明确归属的契约，路径穿越、符号链接逃逸和缺份全部拒绝，不遍历任意目录。
- [ ] 重跑服务、路由、工具测试；实录标准场景不得出现 bash 环境探查、安装依赖或直连数据库。提交 root 与 nested 各自改动。

## Task 5 左侧对话右侧预览

**Files:** 新增 `vendor/dsh/packages/client/kvvi-panel/src/client/BuilderWorkspace.tsx`、`BuilderPreview.tsx`、`builder-draft-api.ts`、`builder-workspace.module.css`；修改 `index.ts`、`locales.ts`，复用 `FormView.tsx` 与原会话 slot。新增 `tests/builder-preview.spec.tsx`、`builder-workspace-assembly.spec.tsx`。

**Interfaces:** `builder-draft-api` 提供 `read(intentId,signal)`、`prepare(intentId,input,signal)`，返回 Task 4 的 BuildSnapshot。`BuilderPreview` 只消费 preview 和本地试填状态，无正式 record 写入依赖。宽屏对话为主区，业务预览位于最右侧栏；不足 900px 改为页签切换。

- [ ] 写失败测试：真实 fixture 的八字段控件可试填；字段变更高亮；权限待确认阻止提交；非法组件显示错误而非空白。spy 验证试填不触发任何正式记录端点。
- [ ] 写迟到结果测试：加载 A 时切换 B，A 的结果不得出现；公司/账号切换清除预览与试填；失败保留旧草稿并标注检查未完成；刷新恢复服务端状态。
- [ ] 从 nested 执行 `pnpm exec vitest run packages/client/kvvi-panel/tests/builder-preview.spec.tsx packages/client/kvvi-panel/tests/builder-workspace-assembly.spec.tsx` 确认红。
- [ ] 按 Cordis slot/作用域订阅方式接入，不让 React 直接读取工作区文件或持有 runtime secret。工作区变更订阅使用取消信号；示例数据明确标为预览，唯一性试填仅对本地示例记录判断。
- [ ] 在 7506 提供隔离 UI 预览，保留对话内容与分组；请用户验收布局后才能切换 7500 工作台。原型不得提交真实审批单。
- [ ] 测试通过后 nested 提交 `feat(builder): add preview and conversation workspace`。

## Task 6 固定按钮提交当前快照

**Files:** 新增 `services/platform/src/builder-submit.mjs`、`tests/builder-submit.test.mjs`；修改 `builder-draft-api.mjs`、`publish.mjs`、`publish-api.mjs`；修改 `BuilderWorkspace.tsx`、`builder-draft-api.ts`，新增 `kvvi-panel/tests/builder-submit.spec.tsx`。

**Interfaces:** `submitBuildSnapshot(ctx,{intentId,revision,digest,operationId}) -> Promise<BuildSnapshot>`。客户端 `submit(intentId,{revision,digest,operationId})` 仅由明确点击调用。发布服务增加可共用现有 transaction client 的内部提交函数；原对外入口保持原检查及语义。

- [ ] 写失败测试：预览摘要不符和旧 revision 返回冲突；未 ready、权限未确认、员工、跨公司、签名 agent 直接调用均拒绝；页面点击不会触发模型重新生成。
- [ ] 写并发测试：双击同 operationId、不同 operationId 但同版本、成功后响应丢失重试均只一张审批单；修改与提交竞争不能发布未确认内容；撤权与提交竞争仍按当前资格裁决。
- [ ] 执行 `node tests/run-isolated.mjs node --test tests/builder-submit.test.mjs tests/publish-api.test.mjs tests/publish.test.mjs` 和 `pnpm exec vitest run packages/client/kvvi-panel/tests/builder-submit.spec.tsx`，确认失败原因符合预期。
- [ ] 同一平台事务锁定草稿头、核验 revision/digest/state、创建发布草案并写唯一 receipt，保留搭建意图绑定。事务内复用连接，避免连接池嵌套等待。真实浏览器身份与同源校验必需；请求体不能指定身份。原 publish_submit 工具人工审批闸保持不变。
- [ ] 前端仅在 ready 时启用按钮，点击后禁重入、刷新可恢复；显示“已提交，等待所有者审批”。再跑不能自审批、发布事务与分组投递回归。
- [ ] 提交 root 与 nested 各自改动，独立复审版本/权限/幂等边界后进入 Task 7。

## Task 7 完整验证与部署

**Files:** 更新 `forks/dsh/改造点清单.md`、由工具生成 `改造点指纹.json` 与 `变更/`；更新 `docs/本地联测-Codex.md`，新增 `交付/证据/搭建预览体验-2026-10-12/验证.md`。

- [ ] 从 `services/platform` 执行 `node tests/run-isolated.mjs npm test`；从 nested 执行 `pnpm run test:gui`、`pnpm run build`；再执行 `DSH_SNAPSHOT=replay pnpm run test:web:built`。完整构建不能与 built 浏览器测试同时运行。
- [ ] 独立只读复审，逐项关闭 blocker。检查全部测试结果，不能把取消运行或环境失败写成通过。
- [ ] nested 提交后执行 `python3 工具/g2_改造点.py --check --manifest`、`python3 工具/fork.py --export`、`python3 工具/g2_改造点.py --verify-manifest`，按实际改动登记路径与数量。
- [ ] 仅在布局已确认、权限与版本测试通过后，通过 `distribution/bin/kvvi-admin` 正式起停工具加载 7500；检查 healthz、schemaBehind、进程与实际资源。不要改变 LC_ALL、账号口令或系统服务隔离配置。
- [ ] 浏览器以已授权身份验收：空白消失、草稿预览、试填、修改及确认提交；提交只对隔离联测草稿执行，不使用用户现有店铺草稿。员工、无权限用户、所有者不可自审批分别实测。
- [ ] 记录分段耗时及真实调用数量，对比此前 111 次命令探查；展示真实结果，不承诺固定总秒数。保存关键截图并明确源测、原型、实际部署及发布验收的区别。
- [ ] root 提交验证记录，报告可用范围及未验证项；不自动合并 main 或推送。

## 计划自检

### 2026-10-12 实施检查点（非完成验收）

- 已提交 DSH 第一批展示修复：`11b1cd8` 移除业务空步骤外层；`2b226bb` 业务目标摘要与中断提示保留。界面回归 6412 通过、1 跳过，完整构建通过。
- 7506 新入口 `http://127.0.0.1:7506/?builder-preview` 是独立交互演示：左侧对话、右侧试填与固定确认（已按用户后续口误更正）。20 项原型测试及 4 项打包测试通过；浏览器已检查修改、确认、继续修改和窄屏页签。未连接真实 AI 或审批。
- 因现有完整检查的上下文仍要求 `fixture=true` 与测试资产，不能直接拿测试上下文证明生产草稿合格。先交付布局评审，正式验证适配、草稿版本和确认提交继续按 Tasks 3/4/6 实施，不能降级为结构检查后直接提交。
- Task 1 尚待 7500 实机验收；Task 2 部分完成；Task 5 仅布局演示。其余任务未完成，7500 未重启或切换，用户店铺草稿未提交或发布。布局确认前不启用正式新工作台。
- 独立切片复审提出中断提示不可消失，已先红后绿修正；全计划最终复审仍待后续实现完成。

- 规格覆盖：会话与业务文案 Task 1–2；固定生成及完整检查 Task 3–4；试填与修改 Task 5；版本、权限、幂等及审批 Task 6；各角色与部署 Task 7。
- Review Focus 的五个反例已分别纳入所属任务；所有新增接口名称在本计划统一。
- 界面、草稿准备及提交各自可独立回归，但新工作台不得在固定准备与快照提交未接通前宣称闭环完成。
- 执行前须读目标目录 AGENTS.md 与 DSH 对应架构/slot 文档；若实际接口或协议阻止实现，先报告具体缺口，不自行弱化规格。
