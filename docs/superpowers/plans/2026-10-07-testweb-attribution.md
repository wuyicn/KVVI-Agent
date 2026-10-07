# 浏览器测试归因与本地联测 Implementation Plan

> **For agentic workers:** 使用 superpowers:executing-plans，由主实现者执行；最终独立只读审查。

**Goal:** 判定交接中的浏览器失败来源，修复本轮引入的问题，让业主有明确的本地测试步骤。

**Architecture:** 上游导入根 e6a559b 和 fork 0e52dcc 各用独立源码、依赖链接和构建产物运行同一浏览器测试参数。修复仅覆盖已复现并归因的测试/产品问题，更新 fork 镜像和交接记录。

**Tech Stack:** Node 24.20.0、pnpm、Vitest、Playwright、Python 交付检查器。

**Spec:** docs/交接-Codex.md，第三、五、八节；业主同意先处理并在可测试阶段进行本地联测。

## Global Constraints

- 基线 e6a559b；本轮起点 main 0ae8e21 / fork 0e52dcc。
- DSH_SNAPSHOT=replay，不批量刷新或放宽快照断言。
- 两轮均用 DSH_CLIENT_TITLE="KVVI 工作台"；品牌固有差异单独解释。
- 不把交接中的旧数字当成当前测试结果。
- 试点口令不写入代码、日志或交接；生产部署单独进行。
- 不向 vendor/dsh 的 origin 推送；我们的远端是 kvvi-shared。

## Review Focus

- 未匹配的 RemoteMock 请求是否真实回归；保留未声明请求拒绝能力。
- 品牌断言是否检验实际产品期望，而非读取待测产物生成期望。
- Hero 节点存活测试是否仍验证节点身份、颜色和交互。
- 快照差异是否有对应的明确产品行为变化。
- 两轮源码、依赖和产物是否隔离，防止误用当前 fork 构建冒充基线。

### Task 1: 复现并归因

**Files:** apps/web/tests/{assembled-remote.ts,assembled-boot.ts,*.e2e.ts}（在 vendor/dsh 中），交付/证据/上游/testweb失败清单.md。

**Interfaces:** 输入两套源码及相同环境；输出逐用例失败及错误分类，保留完整日志。

- [x] 独立导出 e6a559b，链接独立依赖，冻结锁文件安装并完整构建；记录源码 SHA。
- [x] 构建当前 fork 并在 replay 模式运行 test:web:built，收集 JSON 和文本日志。
- [x] 用相同命令运行上游，比较失败用例与实际错误。
- [x] 最小对照实验确认未匹配请求由哪一个改动导致，才决定修复位置。

### Task 2: 修复并验证

**Files:** 按 Task 1 的归因限定修改；旧品牌断言候选为 document-preview.e2e.ts、pwa-manifest.e2e.ts、startup-auto-selection.e2e.ts；模型请求候选为 assembled-remote.ts。

**Interfaces:** 输入归因结果；输出仍有判错能力的测试和必要产品修复。

- [x] 保存相关用例修复前的失败，检查实际 UI 与契约期望。
- [x] 按根因最小修改，先运行对应失败文件确认通过。
- [x] 做反例或局部变异验证，证明错误品牌、意外请求或生命周期回归会被拒绝。
- [x] 执行 test:gui 和完整 replay 浏览器测试；汇报所有剩余失败。

### Task 3: 交付与本地联测

**Files:** docs/交接-Codex.md、docs/试点测试-问题清单.md、交付/证据/上游/testweb失败清单.md、forks/dsh/改造点清单.md / 改造点指纹与镜像。

**Interfaces:** 输入最终验证结果；输出可复核交接与业主本地测试步骤。

- [x] 更新改造登记、指纹和镜像；独立 rebuild / verify，检查删除记录。
- [x] 修正过期状态和数字，区分源码测试与试点复验。
- [x] 核对试点运行状态，给出 owner / builder / staff 的明确测试步骤与预期。
- [x] 独立只读审查本轮差异；修重要问题并保留结果。

## 执行记录

- Pre-flight: Task 2 consumes Task 1 的逐用例归因；Task 3 consumes Task 2 的最终结果。接口一致。
- Ruling: 业主已同意上述处理顺序，直接执行，不重复请求计划确认。
- Ruling: 上游比较使用独立归档目录。Codex 托管 worktree 工具针对外层产品仓库，不能指定被忽略的独立 vendor/dsh 仓库；归档不改动其分支与工作区。
- Ruling: 上游构建读取 Git 元数据。给独立归档补上独立 clone 的 Git 元数据并 detached 到 e6a559b；源码与分支不改写原 fork，避免非 Git 目录引入假失败。
- Task 1: focused comparison — upstream 10 files / 18 passed; fork 9 failed files / 15 failed / 3 passed. 所有 15 个失败含 llm/listProviders 与 llm/listConfigurableProviders 未匹配请求。queue-actions 三条通过。
- Ruling: 启动页的 Into the Unknown 在实际失败截图里存在，不能按交接猜测换标语。新增 title slot 引入渲染锚点，须核对原 XPath 的节点关系。
- Task 1: counterfactual — 在上游仅移除欢迎提示的 slot 注册，两个 image-display 文件的 5 条测试全部出现相同的 llm/listProviders / llm/listConfigurableProviders 未匹配错误。构建因 unused 引用初次被 TypeScript 拒绝，添加两条无运行时行为的 void 引用后实验完成；随后恢复原源文件。
- Task 2: 模型夹具补齐两条显式响应后原 18 条全部通过；新增设置页用例先红，修正状态指示器的可访问性选择器（图标而非文本）后通过。
- Ruling: preview-boot 仍点击已删除欢迎提示的 Continue。非精确名称匹配误选到了禁用的 Save and continue，现场截图确认停在配置页；改为直接精确点击 Configure later，保留后续 Worker 启动、会话与设置/凭据验证。
- Ruling: Startup 的 title slot 使用 display:contents 锚点，原文本定位改变父节点且 isVisible 对锚点不是文本可见性。改为定位实际呈现的父 span 和品牌标记 slot 的 hitbox；原节点身份与交互断言全部保留。
- Task 2: focused gates — startup/PWA/document-preview 6/6、preview-boot 1/1、agent-preset 两文件 15/15。没有批量刷新快照；仅更新 Office 指引那一行已明确的品牌文案。
- Task 2: mutation gates — 将部署物 PWA name 改回上游名时 1/2 失败；删除两条供应商响应时新增 Models 用例失败并捕获两条未匹配请求。全部变异已恢复。
- Ruling: 修复在第三份隔离 clone 中进行，保留原 fork 和干净上游完整比较不受编辑干扰；最终只同步已验证的本轮差异。
- Task 1: original full browser run — 13 failed / 107 passed / 1 skipped files；20 failed / 410 passed / 15 skipped cases（445）。旧的 28 failed 附件不适用于当前 commit。
- Task 2: GUI — 444 passed files；6326 passed / 1 skipped。
- Ruling: 新用例的 Testing Library getByRole 不支持 Playwright 的 exact 选项；构建检查拒绝后移除这三处无效选项。保留准确的字符串名称匹配及文本/可访问性断言。
- Task 1: upstream full browser run — 1 failed / 120 passed / 1 skipped files；1 failed / 430 passed / 15 skipped cases（446），另 1 条 teardown fixture-consumption error。失败为未改动的 queue-actions 第一条，先前 focused comparison 中同一文件 3/3 通过；单独复跑 queue-actions 3/3 通过，保留上游全跑失败与时序问题记录。
- Review (test source): 独立只读审查无 Critical / Important / Minor；确认 strict unmatched、独立品牌期望、Hero 原文字/颜色/hover/五类节点身份、Worker 启动后联通与凭据断言全部保留；两份依赖工作区链接均只落在自己的 checkout 内。
- Review rulings: 真实模型与各角色业务闭环、部署状态不由夹具测试证明，留给业主联测；queue-actions 最终根因与稳定修法不在本轮；最终数字与镜像将在提交后交给同一审查员核对。
- Task 3: 联测说明已生成并请求在 Codex 打开；重新读取 status，platform/runtime pid 21012/21026 正常，健康检查和两个登录入口均 200。未重启或写业务数据。
- Ruling: 历史失败附件含一个截断 UTF-8 字节 0xe8；保留旧内容并将该字节显示为字面 \xe8，使 Markdown 可读，不改历史测试数字。
- Task 2: final full browser — exit 0；120 passed files / 1 skipped，431 passed / 0 failed / 15 skipped（446），604.89s。源码树 abc0bfe1052e2653cb5165fca9736076cf749d0b 保存为 fork 22407d2，提交前后树相同。
- Task 3: integration — 原 fork clean 0e52dcc 后从本地隔离 clone fetch 同一提交，切至 codex/testweb-attribution；fetch 退出 0，但现有坏 ref 对象产生诊断（历史压平已记录）；本轮 HEAD→e6 祖先可读，未修改无关旧 refs，未向远端推送。
- Deviation/ruling: --verify-manifest 误将 8 个正确删除当作缺失。补修删除分支，以 lexists 拒绝文件/目录/断链残留；新增隔离 7 用例先红（合法删除误拒 + 目录异常）后全绿，保留篡改/缺失/HEAD 变动拒绝。属于交付验证必需的小范围修补，未运行会清理真实 fork 的旧 shell 自测。
- Task 3: G2 137 paths / 34 entries 有效；manifest 相符；export 129 在场 + 8 删除；独立 rebuild 与 verify 均 exit 0，129/137 内容一致、8/8 删除已生效。
- Review (final delivery): 同一独立审查员核对所有紧凑证据 JSON/hash/文件计数、vendor/镜像/重建全量内容与8删除，G2检查及隔离7用例；无 Critical/Important。Minor：报告首句漏提指纹检查器补修，已核对实际差异并修正文案。真实角色/模型调用、部署、上游时序稳定修法仍明确留给后续，不计入本轮通过。
- Finish ruling: 业主本轮要求先修并开始本地联测，未要求主线集成/远端发布。保留本地 codex/testweb-attribution 分支和工作区，保存交接提交；不新增集成审批步骤，不合入 main，不推送，不删除隔离证据目录。相关 GUI/browser 全量及交付检查已经运行，不无故重复。
