# Unified Business Grouping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将已确认的分组原型接入 7500，使搭建者真实管理公司分组与表单归档，员工按原有权限使用记录。

**Architecture:** 在平台服务内增加业务目录模块，使用业务库保存分组、表单归属、归档状态及操作回执，使归档状态与记录写入能共享数据库锁和事务。保留平台库中的发布契约与原始资产标识，客户端复用 DSH 插件槽位、工作区、会话、表单和发布入口。目录与生命周期检查对界面及 Agent 共用，不复制原型数据或另造记录权限。

**Tech Stack:** Node.js ESM、PostgreSQL、React/TypeScript、DSH Cordis、node:test、Vitest、现有发行管理脚本；不新增前端框架或数据库产品。

**Spec:** [已确认设计](../specs/2026-10-09-grouped-business-integration-design.md)

## Global Constraints

- 分组属于公司，由搭建者统一管理。
- 写操作必须同时满足：有效会话、所属公司、当前 BUILDER 模式及仍有效的搭建资格。
- 删除分组保留表单及记录，移入「未分组」。
- 删除表单采用归档，可恢复，不清空历史数据。
- 分组是目录组织方式，不承担数据授权功能。
- 保留现有 assetId、systemId、schemaCode、契约版本、记录主键与审计引用。
- 原型中的 GAD、访客等示例不得导入正式数据库。
- 仅调整目录分组不修改契约，也不触发重新发布。
- 归档启用后不能直接回退到忽略归档状态的旧服务。
- UI 文案进入中英文 locale 字典，样式使用正式 DSH token；遵守 vendor/dsh 下 AGENTS.md 与相关架构文档。
- 不运行试点数据重置，不把 7500 的 DSN 注入测试，不修改冻结 PRD；7506 保留不覆盖。

## Review Focus

1. 测试装置 resetDatabase 会重建三个数据库；必须独立 PostgreSQL 集群，禁止误用试点连接。任务 1 验证拒绝不安全测试环境。
2. 归档与员工写入并发，不能检查时可用、提交时已归档。任务 3 验证事务锁的提交顺序。
3. 公司目录、发布信息和审计处在不同数据库，不能声称跨库原子提交。任务 2 验证操作回执、审计重试和故障恢复。
4. 员工只有 create 而没有 read 权限时，仍需看见可填写入口，但不能取得记录；空分组与隐藏表单名称不能泄露。任务 2 和 4 验证此组合。
5. 快速切换表单、会话绑定晚返回及撤权后重新登录，不得串用草稿、AI 上下文或上一个公司的目录。任务 4 验证过时响应和清理。

## 实施环境与文件组织

根目录为 `/Users/wuyi-macs/Documents/KVVI-Agent`。平台代码在 `services/platform`，DSH 开发源在 `vendor/dsh`，可重建镜像在 `forks/dsh/变更`。不直接编辑镜像代替开发源。正式部署配置须现场只读确认，不把记忆中的路径当作当前事实。

新增模块各自负责：`business-directory.mjs` 管目录查询与变更；`business-lifecycle.mjs` 管归档锁和状态；`business-directory-api.mjs` 仅做 HTTP 适配；`business-directory-audit.mjs` 负责持久操作回执的审计投递；客户端 `BusinessDirectory.tsx` 和 `BusinessDirectoryDialogs.tsx` 管分组展示及管理弹窗。现有 BusinessBody 继续负责记录，不重写整个组件。

执行前按 using-git-worktrees 流程确认隔离方式。根仓库与嵌套 DSH 仓库分别记录 Git 状态；不得覆盖未提交用户改动，不向远端推送。推荐一个实施者连续开发，完工后独立审查，避免多个实施者同时写同一仓库。

## Task 1 安全测试环境与增量数据结构

**Files:** 新建 `services/platform/sql/31-business-directory.sql`、`services/platform/tests/business-directory.test.mjs`、`services/platform/tests/test-target.test.mjs`、`services/platform/tests/test-target.mjs`；修改 `services/platform/src/sql-manifest.mjs`、`services/platform/src/migrate.mjs`、`services/platform/tests/harness.mjs`。

**Interfaces:** `assertTestTarget(dsns, marker): void` 在 resetDatabase 前核对专用测试集群标记及所有 DSN 的同一 loopback 端口，不匹配即拒绝；marker 来自执行前生成的临时测试集群，不复用试点配置。

数据结构全部新增到业务库：`business_groups(company_id, group_id UUID, name, position, version, created_at, updated_at)`；`business_form_directory(company_id, asset_id, group_id NULL, archived_at NULL, archived_by NULL, version)`；`business_directory_operations(company_id, operation_id UUID, actor_id, action, request_digest, result JSONB, audit_payload JSONB, audit_delivered_at NULL)`。组名修剪后 1 至 80 字符，同公司不允许重名；form 的复合外键引用同公司的 group。单层分组，不复制记录。

- [ ] 编写失败测试：不带测试集群标记或 DSN 端口不一致时 `assert.throws(() => assertTestTarget(dsns, marker))`；公司 B 的 group_id 不能关联 A 的表单；旧数据不迁移即表现为未分组、未归档。
- [ ] 在新建临时集群上运行 `node --test tests/test-target.test.mjs tests/business-directory.test.mjs`，记录因缺少目标能力而失败的结果。
- [ ] 实现测试保护、31 号迁移及 MIGRATIONS 业务库登记。采用复合主键、复合外键和版本约束；遵循既有数据库角色分工，不把管理员连接注入运行时。显式公司条件及业务库 RLS 保留，新增目录表使用匹配的公司上下文。
- [ ] 验证迁移重复执行不变、非 reset 迁移前后记录标识/数量/摘要一致，启动 schema 自检识别新增迁移。运行目标测试及 `tests/schema-guard.test.mjs`。
- [ ] 提交本任务文件，记录临时集群路径、端口和生命周期，不记录凭证。

## Task 2 公司目录服务与搭建者管理 API

**Files:** 新建 `services/platform/src/business-directory.mjs`、`business-directory-api.mjs`、`business-directory-audit.mjs`，以及 `tests/business-directory-api.test.mjs`、`tests/business-directory-audit.test.mjs`；修改 `src/api-router.mjs`、`src/request-refs.mjs`、`src/server.mjs`。扩充任务 1 的目录测试。

**Interfaces:** `readDirectory(ctx, {archived:boolean}): Promise<{groups,forms}>`；`mutateDirectory(ctx, {operationId,action,target,expectedVersion,payload}): Promise<{result,auditPending:boolean}>`；`directoryRoutes({method,path,payload,session,headers}): Promise<{status,body}>`；`flushDirectoryAudit({limit}): Promise<{delivered,pending}>`。`ctx` 仅由可信 session 转换；写入资格复用 `allowedGateways`，动作权限复用 `canAct`。

返回 `groups: [{groupId,name,position,version}]`；`forms: [{systemId,assetId,name,schemaCode,publishedAt,groupId,archived,version,actions:string[]}]`。员工 actions 由既有授权生成，至少一种 create/read/update 动作可进入相应表单入口；没有 read 时不返回记录。所有表单操作仍在执行点复核，目录 actions 不是授权凭证。

HTTP 路由固定为：

| 方法及路径 | 请求或结果 |
| --- | --- |
| GET `/api/v1/business-directory` | 普通目录；`?archived=true` 仅当前搭建者读取 |
| POST `/api/v1/business-groups` | `{name}`，Idempotency-Key 为 operationId |
| PATCH `/api/v1/business-groups/:groupId` | `{name,expectedVersion}` |
| DELETE `/api/v1/business-groups/:groupId` | `{expectedVersion}`，组内表单移至未分组 |
| PATCH `/api/v1/business-forms/:assetId/group` | `{groupId:string|null,expectedVersion}` |
| POST `/api/v1/business-forms/:assetId/archive` | `{expectedVersion,confirmed:true}` |
| POST `/api/v1/business-forms/:assetId/restore` | `{expectedVersion,confirmed:true}` |

所有写请求携带同一格式 Idempotency-Key。错误码：`KVVI_BUILDER_REQUIRED` 403、`KVVI_DIRECTORY_NOT_FOUND` 404（含跨公司目标）、`KVVI_DIRECTORY_VERSION_CONFLICT` 409、`KVVI_GROUP_NAME_EXISTS` 409、`KVVI_DIRECTORY_INVALID` 400、`KVVI_FORM_ARCHIVED` 409。鉴权先于目标细节；未知异常保持 500，数据库不可用不能伪装为空目录。

- [ ] 编写失败测试，断言 `USER + allowed BUILDER` 仍拒绝写、当前 BUILDER 撤权后拒绝、跨公司 group/form 均拒绝、员工隐藏不可用表单及空组、create-only 员工保留填写入口。
- [ ] 运行 `node --test --test-concurrency=1 tests/business-directory*.test.mjs`，确认新增行为未实现而失败。
- [ ] 实现单次业务库事务完成目录修改与操作回执。相同 operationId 和摘要返回原结果，不重复修改；同 ID 不同摘要拒绝。版本从 1 开始递增；未创建的旧表单元数据读取为版本 0，首次写入使用惰性创建及唯一键并发保护。
- [ ] 将审计事件与结果一起存入操作回执，再调用既有 `audit.append` 投递。投递失败保留待投递状态，后台有界重试并在 status 中暴露积压；不得将已提交操作报为未执行。审计采用至少一次投递，摘要包含稳定 operationId 供关联；不声称审计库与业务库是同一个事务，不修改审计写者权限。
- [ ] 验证断开审计库后目录写入仍有持久待投递记录、重启后可补投；网络重发不重复建组；归组与删除分组并发不会留下悬空引用。运行目标测试及 `tests/api-router.test.mjs`、`tests/identifier-gate.test.mjs`。
- [ ] 提交本任务文件，附路由与权限矩阵。

## Task 3 共用归档守卫和记录并发保护

**Files:** 新建 `services/platform/src/business-lifecycle.mjs`、`services/platform/tests/business-lifecycle.test.mjs`；修改 `src/refs.mjs`、`src/workflow.mjs`、`src/commands.mjs`、`src/system-api.mjs`、`src/runtime-projection.mjs` 及任务 2 模块。扩充 `tests/ui-agent-e2e.test.mjs`、`tests/system-fields.test.mjs`。

**Interfaces:** `lockFormLifecycle(client, companyId, assetId, mode:'read'|'write'|'archive'): Promise<void>` 使用业务库事务内锁；`assertFormActive(client,companyId,assetId): Promise<void>` 在同一事务读取归档状态。读写记录持共享生命周期锁，归档/恢复持排他锁；业务库 PostgreSQL transaction advisory lock 按 companyId+assetId 确定性键生成，散列碰撞最多引起额外等待，不得跨公司读取。

- [ ] 写失败测试：归档后 UI API、逻辑引用、Agent 所用 API、流程迁移及通用命令均拒绝；恢复不改变记录与权限。并发测试用数据库锁屏障控制顺序，不用随机 sleep。
- [ ] 运行 `node --test --test-concurrency=1 tests/business-lifecycle.test.mjs tests/ui-agent-e2e.test.mjs`，确认绕过路径复现。
- [ ] 审查并接入所有实际记录读写执行点。归档已取得排他锁后，新写入排队并在锁后检查时拒绝；若写入先取得共享锁，其事务必须先完成，归档才可提交。所有锁保持到业务事务提交，禁止在独立 pool 查询中检查后放锁。
- [ ] 旧 `/systems`、runtime、fields 及业务工具目录按新可见性和归档规则过滤，保留 API 返回结构兼容性；不要把 `publishedSystems(companyId)` 这个内部发布清单当成对外授权清单。已有发布/编译路径可保留内部原始清单，禁止自动恢复归档状态。
- [ ] 验证归档后旧链接不能写、恢复后仍遵守只读/字段隐藏权限、跨公司行为不泄露状态、目录或生命周期查询故障拒绝放行。运行目标测试及 `tests/system-api.test.mjs tests/permissions.test.mjs tests/workflow.test.mjs tests/publish-runtime-e2e.test.mjs`。
- [ ] 提交本任务文件；记录逐入口覆盖表，未覆盖入口不得部署。

## Task 4 正式分组工作台与安全导航

**Files:** 新建 `vendor/dsh/packages/client/kvvi-panel/src/client/business-directory-api.ts`、`BusinessDirectory.tsx`、`BusinessDirectoryDialogs.tsx`、`tests/business-directory.spec.tsx`；修改同包 `BusinessPage.tsx`、`business-store.ts`、`business.module.css`、`locales.ts`、`ReadFailure.tsx`、`tests/business-entry.spec.tsx` 和 `tests/business-assembly.spec.tsx`。

**Interfaces:** 客户端 `loadDirectory({archived,signal})` 返回任务 2 数据；`writeDirectory(action,input,{operationId,signal})` 返回 ApiResult，错误码原样保留。`BusinessDirectory` 接收服务端 groups/forms、selectedAssetId、query 和 onSelect/onManage；不传运行时服务对象。相互可见的交互状态使用注册 store，仅存选择、折叠和草稿，不在 localStorage 保存公司目录权威数据。

- [ ] 修改旧「进入业务」测试，新增自动进入首个可用真实表单、全目录分组、员工无管理按钮、无权限表单不显示、归档列表和恢复确认测试。断言快速切换时旧请求返回不能覆盖当前表单。
- [ ] 在 vendor/dsh 运行 `pnpm exec vitest run packages/client/kvvi-panel/tests/business-directory.spec.tsx packages/client/kvvi-panel/tests/business-entry.spec.tsx`，确认新行为红灯。
- [ ] 拆出目录及弹窗，替换业务系统列表/切换器；复用原 BusinessContent 与 BusinessSession，持续按 assetId 绑定记录、草稿和 AI。首个可用表单为空时显示真实空态；读失败显示重试，不显示示例数据。create-only 进入填写态，不请求记录列表。
- [ ] 接入新建/改名/解散分组、归组、归档和恢复；提交期间锁定按钮，失败不乐观删除，409 刷新目录并要求用户重核。重新认证及公司切换清理上个身份的交互状态；无效会话使用现有登录恢复路径。
- [ ] 运行 kvvi-panel 全部测试，检查中英文文案、默认 AI 收起、工作区会话及表单切换回归。用构建后的应用验证布局，不以源码截图替代。
- [ ] 在 DSH 仓库提交本任务文件；镜像统一在任务 6 导出。

## Task 5 新增编辑表单衔接真实搭建发布

**Files:** 修改 `vendor/dsh/packages/client/kvvi-panel/src/client/index.ts`、`BusinessPage.tsx`、`business-binding.ts`、`locales.ts`，以及 `services/platform/src/publish-api.mjs`；新增 `services/platform/src/business-build-intents.mjs`、`services/platform/sql/32-business-build-intents.sql`、`services/platform/tests/business-build-intents.test.mjs`、`vendor/dsh/packages/client/kvvi-panel/tests/business-build.spec.tsx`；登记迁移。

**Interfaces:** 平台库 `business_build_intents(company_id,intent_id,creator_id,group_id,asset_id NULL,state,version)`；`createBuildIntent(ctx,{groupId,operationId}): Promise<{intentId}>`，`attachBuildIntent(ctx,{intentId,draftId,expectedVersion}): Promise<void>`。分别对应 POST `/api/v1/business-build-intents` 与 POST `/api/v1/business-build-intents/:intentId/draft`。仅当前搭建者可调用，draft/intent 都校验同公司和权限，不接受任意资产覆盖。

`startBuilder(parent,name,purpose,intentId): Promise<void>` 在原有真实会话中记录 intentId；发布时从经过校验的 draft 推导 assetId，不能以名称匹配归组。发布成功后持久记录待归组状态，有界重试任务 2 的服务端归组逻辑；不声称发布库与业务目录跨库原子。原分组删除则进入未分组并标注原因；归组失败不可显示归组成功。已归档资产不因发布自动恢复。

- [ ] 写失败测试：新增表单调用真实搭建入口并携带服务端意图；同名工作区不能绑定错表单；发布拒绝不产生可用目录条目；发布完成后重试归组不重复；原分组被删除安全进入未分组。
- [ ] 分别运行平台 `tests/business-build-intents.test.mjs` 和 GUI `tests/business-build.spec.tsx`，确认失败来源为新增能力缺失。
- [ ] 实现 build-intent 的会话身份与 draft 绑定、发布后补偿，以及客户端真实入口；编辑表单绑定真实资产所在工作区，找不到时要求明确选择，不能静默打开同名工作区。保持现有审核职责分离，不能以搭建者身份自动批准发布。
- [ ] 验证编辑草稿不改变员工正在使用的已发布版本、仅归组不触发发布、归档期间新发布不自动恢复、生成或发布失败可重试。若 AI 产物缺少必要契约，显示真实错误，不能用假成功或自动授权补齐。
- [ ] 提交本任务文件，更新 kvvi-panel README 中的真实功能范围。

## Task 6 组合回归和可重建交付

**Files:** 修改 `vendor/dsh/apps/web/tests/kvvi-business.e2e.ts`、`vendor/dsh/packages/client/kvvi-panel/README.md`、`forks/dsh/改造点清单.md`；通过现有工具更新 `forks/dsh/变更` 和 `forks/dsh/改造点指纹.json`；新建 `交付/证据/统一业务分组接入-2026-10-09/验证.md`。

**Interfaces:** 复用任务 1 的独立测试集群和 apps/web 现有 scaffold，不启动连接试点数据库的测试服务。

- [ ] 更新 assembled 测试：无中间页、真实目录协议、分组持久化响应、归档恢复错误态、角色切换，以及会话模式/记录模式交互；截图使用测试装置数据并明确标为组合测试证据。
- [ ] 在独立数据库环境运行平台 `npm test`；在 vendor/dsh 运行 `pnpm run test:gui`、`pnpm run build`、`DSH_SNAPSHOT=replay pnpm run test:web`。失败逐项记录，不通过重跑掩盖首次失败，不把无数据库导致的取消记为通过。
- [ ] 执行最终独立审查，聚焦跨公司、模式资格、归档竞态、幂等、审计积压及旧工具路径。未关闭高风险问题不得进入部署。
- [ ] DSH 提交后登记准确改造文件，运行 `python3 工具/g2_改造点.py --manifest`、`python3 工具/fork.py --export`；以 `mktemp -d` 创建本次专用重建目录，运行 `python3 工具/fork.py --rebuild --into <本次目录> --upstream local` 和 `python3 工具/fork.py --verify --into <本次目录>`。
- [ ] 提交根仓库镜像及证据，核对仅包含本次相关文件，不夹带未跟踪的原型目录。不向远端推送或合并未经要求的分支。

## Task 7 备份后部署到 7500 并现场验收

**Files:** 更新 `docs/本地联测-Codex.md`、`交付/证据/统一业务分组接入-2026-10-09/验证.md`；不将口令、DSN 或敏感记录写入证据。

**Interfaces:** 使用当前已验证配置及 `distribution/bin/kvvi-admin`，不自行杀进程或重装。以下 `<配置路径>` 必须现场确认所属项目、home、平台端口 7500 和运行版本；不把历史配置直接用于写操作。

- [ ] 只读检查 `kvvi-admin status --config <配置路径> --json`，核实现有进程/端口、活动写入和后台任务。活动任务未完成时先协调维护窗口，不中断用户提交。
- [ ] 检查当前 backup 实现的保密性，先运行 `backup --plan --config <配置路径>`；确认产物不含明文凭证或不安全运行时打包内容后执行 `backup --yes --config <配置路径>`。在隔离环境验证可恢复与摘要一致；不能验证备份则停止部署，不触碰试点数据。
- [ ] 部署经测试的代码和 DSH 构建产物，记录主仓库与 DSH 提交、schema 版本。使用 `stop --apply --yes --config <配置路径>` 与 `start --apply --yes --config <配置路径>`，由 supervisor 跑非 reset 增量迁移；启动前确认没有 KVVI_RESET。
- [ ] 检查 health/status 后通过浏览器实际登录验收：搭建者分组/归组跨刷新保存；员工只读、可编辑和无权限视图；工作区与业务页切换；只使用明确的测试表单验证归档/恢复和新增发布，不归档用户现有业务做试验。
- [ ] 比对部署前后既有记录标识、数量和内容摘要；保存实际角色截图、服务端拒绝码及 Agent 同路拒绝结果。缺凭证时交由用户登录，不能另造高权限账号完成验收。
- [ ] 如失败，先停止新增写入并保留现场。回退必须保持归档守卫；禁止直接运行不识别归档的新旧混合版本。恢复备份属于单独确认的破坏性动作，不自动执行。
- [ ] 记录真实验收通过项与未完成项，只在全部必需项通过后报告「7500 接入完成」。提交非敏感联测文档，保留 7506 供对照。

## 计划自审与执行选择

设计的九项验收分别由任务 4、2/4、1/2、2/3、2/3/4、3、5、4、6/7 覆盖。五项 Review Focus 均有归属测试；目录和操作回执不跨数据库事务，归档状态与记录写入同库锁定。现有工作区会话和真实发布流程继续复用。

本计划尚未执行。请审阅并选择：由当前会话连续实施、最后独立审查；或按任务使用实施代理与独立审查代理。推荐前者，原因是服务端接口、归档事务和客户端绑定彼此依赖，保持一个实施者更容易维持一致性。执行前一并确认是否使用隔离 worktree。
