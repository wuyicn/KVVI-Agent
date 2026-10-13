# KVVI-Agent Three-loop Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or superpowers:dispatching-parallel-agents for the independent domains. Steps use checkbox syntax.

**Goal:** 将已获用户认可的发布完整性、Worker 重要操作确认及后台身份绑定落到实际调用路径。

**Architecture:** 保留契约和权限架构；拒绝装不下的发布内容；复用工具运行时确认闸；由受信会话恢复工具身份。

**Tech Stack:** TypeScript/DSH/Cordis/Vitest；Python CLI/unittest；Node test/PostgreSQL 平台。

**Spec:** `docs/superpowers/specs/2026-10-13-three-loop-execution.md`

## Global Constraints

- 不改当前服务进程或共享 vendor；源码在 `forks/dsh/变更` 修改，测试复制到独立 `/workspace/kvvi-loop-test-runtime`。
- 不升级依赖、契约存储和上游基线；不新增 MCP 或预设权限。
- 平台仍独立判断实时授权；用户确认不能替代权限和 rowVersion。
- 禁止模型身份字段；后台未知身份失败关闭。

## Review Focus

- Agent 与 CLI 重复契约行为必须一致；多工具完整保留。
- 确认必须通过真实运行时闸；无应答、取消和重复调用不能静默执行。
- 确认显示的参数必须等于执行参数，包含版本号和身份归属。
- 后台绑定不能把另一个会话的身份继承进当前工具；撤销会话仍被平台拒绝。
- 登记源码、指纹、重建产物必须一致；图中不能将尚未实现的多资产存储画成完成。

## Task 1: 发布完整性（独立任务）

**Files:** `forks/dsh/变更/packages/tool/kvvi-publish/{src/index.ts,tests/publish.spec.ts,README.md}`；`工具/发布脚手架.py` 及对应 Python 测试。

**Interfaces:** 保持 `readContracts(tree)` 与 `read_contracts(tree)` 的正常返回；多份非工具契约抛稳定错误码，调用方不得提交。

- [x] 写多视图、重复模型、工具多份、缺份及 Agent/CLI 行为一致测试；先确认失败。
- [x] 最小修改两侧绑定器，拒绝不可完整发布的输入，更新说明。
- [x] 跑完整 publish 工具与 CLI 套件，记录命令和结果。
- [x] 补平台发布摘要测试：相同内容复用，视图/模型/系统元信息变化不得复用旧草案；摘要绑定完整正文后跑平台完整套件。

## Task 2: Worker 确认闸

**Files:** `forks/dsh/变更/packages/tool/kvvi-business/{src/index.ts,tests/tools.spec.ts,README.md}`；必要时 Worker persona。

**Interfaces:** `workflow_act` 原参数不变；执行器直接请求一次 approval，其他工具原样；理由包含系统、记录、动作、rowVersion 与身份。

- [x] 用真实 Tools/Approval 服务写无应答、拒绝、批准一次、再次确认、参数被快照、读取不询问的测试；先确认失败。
- [x] 在执行器中接入既有确认闸，保持业务调用与授权不变。Ruling：不依赖可能被其他 allow hook 覆盖的前置 listener；代价是执行器需读取可选 approval 服务，但缺服务仍明确拒绝。
- [x] 跑完整 business 工具与平台相关套件，核对状态版本冲突及撤销行为。

## Task 3: 后台会话身份（独立任务）

**Files:** `forks/dsh/变更/packages/host/kvvi-mode-router/{src/index.ts,tests/mode-router.spec.ts,README.md}`，必要的既有 peer/host 配置。

**Interfaces:** `requireMode()` 不变；通过受信会话关联及工具 hook 恢复作用域；未知、跨命名空间、重启未认证均拒绝。

- [x] 先证明已创建/已认证会话在原请求结束后的工具调用失败；补无身份和跨身份负向测试。
- [x] 在最小现有 hook 上恢复可信上下文；不得解析命名 ID 来伪造完整身份。
- [x] 跑完整模式路由套件，检查 platform 每次操作的活跃会话校验未被绕过。
- [x] 在等待确认时销毁 Agent 或替换 Session，确认之后必须拒绝且无 HTTP；真实 Loader 和自动排队 Goal 续跑都恢复原身份。

## Task 4: 集成与交付

- [x] 审阅全部 diff，运行 platform suite、三个工具/路由套件与重建指纹检查。
- [x] 更新三闭环 PNG/SVG 和依据，标明多资产存储的实际边界。
- [x] 独立代码审查；修复影响正确性的发现并复验；提交隔离分支的可审阅结果。

## 验收记录

全部任务完成。平台 505 项、运行时 169 项、Python 13 项测试通过；类型构建、离线锁文件和重建指纹检查通过。独立审查发现的确认等待期间身份生命周期竞态已修复并回归。详见 `docs/三闭环执行修补-取证.md`。
