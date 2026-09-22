# KVVI 搭建引擎 · DSH 落地架构与实施记录

> 日期：2026-09-21
> 落点：本机 DSH 运行时（`@deepseek-ai/dsh@0.1.0-rc.6`）
> 形态：**DSH Agent Preset 产品**（不改 DSH 源码）
> 状态：**全部核心目标已实证**——预设挂载校验通过、三插件全新进程激活、
> 真实会话确认 KVVI persona 与 5 个 Skill 到达模型、自然语言→原型文件链路跑通。
> 仅剩一项人工动作：重启 7100 进程后在你日常界面里点一次（见 §3.8）

---

## 0. 一句话结论

KVVI 搭建引擎已作为一份 DSH Agent Preset 落地：预设目录 `kvvi` 承载**通用搭建能力层**
（5 个通用搭建 Skill），三个产品插件（`dsh-genui` / `dsh-node-flow` / `dsh-connect`）
装配在 **profile 插件层**。预设经 `standingKeyFor` 挂载校验通过，
5 个 Skill 确认可见。**未做**：真实会话端到端验证（需重启 Web 进程）。

---

## 1. 必须记录的三项事实修正（与 PRD 不符）

交接时按 PRD 执行前先核实，发现三处需要如实记录的偏差。这三条影响后续所有工作。

### 1.1 三个「DSH 插件」都不是官方包，是社区第三方插件

PRD 第 3.2 节把 `dsh-genui` / `dsh-node-flow` / `dsh-connect` 画在「DSH 插件层」，
读起来像 `@deepseek-ai/` 官方生态的一部分。实测（本机安装 + npm registry + 社区插件目录 11,446 条）：

| 包名 | 真实身份 | 来源 | npm 状态 |
|---|---|---|---|
| `dsh-genui` | v0.2.1，生成式 UI（表单/图表/看板内联渲染） | `lhuans/dsh-genui`（个人） | 已发布 |
| `dsh-node-flow` | v0.2.0，可视化节点工作流画布 | `luxi233/dsh-workflow`（个人） | **未发布**，仅 GitHub |
| `dsh-connect` | v0.8.0，聊天平台桥接（飞书/Telegram/钉钉） | `IvanWu2015/dsh-connect`（个人） | 已发布 |

均为 MIT，但**版权不属于 KVVI**。

**对软著的影响（重要）**：PRD 第 4.1 节写「代码交存主体为通用 Skill 的解析引擎、
模板匹配逻辑、生成管线编排」。这三样本项目**一行都不拥有**——它们是上述第三方的代码。
软著交存自有代码，交存第三方插件会在审查中被认定为主体不符。
**首版交存主体应改为自有 Skill 内容 + 自研扩展层**（本次已交付 5 个自有 Skill 文档），
或另做自研插件替换（未评估）。

### 1.2 `dsh-node-flow` 的两个「竞争实现」是同一个项目的两个 fork

插件目录索引里 `dsh-node-flow` 出现两条，指向 `CodermanYHZ/dsh-node-flow` 与 `luxi233/dsh-workflow`。
实测结论：

- 两者 `package.json` 的 `name` **都是 `dsh-node-flow`**
- 两者的 `cordis.patch.yml` 插入的 row id **都是 `dsh-node-flow`**
- luxi233 的仓库 README 明写：仓库名 `dsh-workflow`，但「npm 包名、Cordis bundle ID、
  host API 路径保持 `dsh-node-flow`」以兼容既有安装与持久化数据

**它们不能共存**（同名包、同 row id）。luxi233 版本为 v0.2.0（CodermanYHZ 为 v0.1.0），
模块数约 35 : 8，多出 HTTP 节点、连接器 SDK/注册表、OAuth2、凭据存储、Webhook 幂等、
子工作流、等待点、工作流版本、审计日志、项目变量、执行并发控制等。
**本次选定 luxi233 v0.2.0**，已 vendor 到 `vendor/dsh-node-flow`。

### 1.3 三个插件都不能放进 Agent Preset

这是架构上的硬约束，不是偏好。三者的自身声明与实测：

| 插件 | 归属平面 | 证据 |
|---|---|---|
| `dsh-node-flow` | **host** | `inject: ['webServer']`，注册同源 HTTP 路由 `/dsh-node-flow/run`、`/run-agent`、`/schedule`，内置 cron 引擎与磁盘工作流存储 |
| `dsh-connect` | **host** | 其 README 原文：「runs on the DSH **Host plane** (process-level singleton services), **not inside an agent preset**」；导出 `ConnectService` |
| `dsh-genui` | 注册进 host 拥有的注册表 | 贡献 system-prompt 段 `genui:cards` + 浏览器端卡片渲染 |

DSH 的挂载审计会**拒绝**在预设里松散放置发布进程级服务的行。
因此三者装配在 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles`，
由 `dsh plugin --profile web add` 完成（该命令自动同时写入 dependencies 与 bundles）。

**副作用需知情**：profile 级 bundles 对**所有**会话生效，不只 KVVI 会话。
KVVI 的差异化因此落在 persona + Skill 层，而非插件层。
若将来需要「仅 KVVI 会话可见」，须另做方案（未做）。

---

## 2. 已交付产物

### 2.1 预设（KVVI 独有）

```
~/.dsh/.agent-presets/kvvi/
├── preset.yml            name: KVVI 搭建引擎
├── agent.cordis.yml      组装文件（复制自 standard，重定向为搭建引擎）
├── skills/               5 个通用搭建 Skill（自有内容）
│   ├── data-model/       数据模型推导（下游三者的前置）
│   ├── form-builder/     表单生成
│   ├── workflow-builder/ 审批流编排
│   ├── dashboard-builder/看板生成
│   └── api-spec/         接口定义
└── templates/            原型交付骨架
```

组装层次序严格遵循 PRD 3.2 的分层：**Agent Preset 配置层**（`preset.yml` +
`agent.cordis.yml` + `skills/`）与 **DSH 插件层**（profile bundles）分离。

Skill 目录通过 `baseUrl` 解析，随预设整体迁移：

```yaml
- id: skill-filesystem
  name: '@deepseek-ai/dsh-skill-filesystem'
  config:
    customSkillDirs:
      - !!js "process.getBuiltinModule('node:url').fileURLToPath(new URL('skills/', baseUrl))"
```

**行业扩展层的挂载方式**由此确定：往 `skills/` 追加一个目录、在 `customSkillDirs`
追加一行即可，地基无需改动。这与 PRD「行业扩展包只需提供额外 SKILL.md」一致。

### 2.2 插件（profile 级）

```
~/.dsh/profiles/web/package.json
  dependencies:  dsh-genui ^0.2.1 | dsh-connect ^0.8.0 | dsh-node-flow file:…/vendor/dsh-node-flow
  dsh.profile.bundles: [ @deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app,
                         dsh-genui, dsh-connect, dsh-node-flow ]
```

`dsh-node-flow` 因未发布 npm，以 `file:` 依赖指向本仓库 vendor 副本。
`vendor/dsh-node-flow` 从 `luxi233/dsh-workflow` v0.2.0 复制，已完整构建。

**构建踩坑（需记录）**：该仓库的 `scripts/build-client.mjs` `import { build } from 'esbuild'`，
但 `package.json` 的 devDependencies **未声明 esbuild**，`pnpm install` 后直接 `pnpm run build`
报 `ERR_MODULE_NOT_FOUND: esbuild`。已补装 `esbuild@0.28.2` 后构建通过，
产出 `lib/client.js`（842 KB）与 `dist/`（vite 站点）。此步骤在升级插件后需重做。

---

## 3. 验证证据

### 3.1 已完成

| 项 | 方法 | 结果 |
|---|---|---|
| profile 配置树合入三插件 | `dsh --profile web --dump-config` | 见 `id: genui` / `id: connect` / `id: dsh-node-flow` 三行，exit 0 |
| 三插件模块可加载 | Node 动态 `import()` | 三个均 imported OK，导出 `apply`/`inject` |
| 预设可组装 | `agentPresets.standingKeyFor('kvvi')` | **MOUNT: OK**（trust=user） |
| Skill 注册 | `skills.list({scope: standingKey})` | 5 个 KVVI Skill 全部可见 |

预设健康行：`id=kvvi trust=user broken=no`。

### 3.2 全新进程实测（本轮新增，在临时第二实例上完成）

用户正在使用的 Web 进程（PID 1011）启动于 08:53，**早于**插件安装时间，
因此该进程内三插件未激活（服务目录中确实无 `connect` 等服务）。
为在不干扰用户进程的前提下取得真实证据，临时以同一 `web` profile
在 **7101** 端口启动第二个实例，probe 完成后立即关闭。

| 项 | 方法 | 结果 |
|---|---|---|
| 第二实例可服务 | `lsof` + `curl /` | 7101 LISTEN，HTTP 200 |
| `dsh-node-flow` host 激活 | `curl /dsh-node-flow/schedules` | **HTTP 200**（路由已注册） |
| 三插件客户端半注册 | `curl /plugins/<id>/client.js` | 三个均 200；node-flow **842746 字节**，与本地构建产物大小一致 |
| 三插件进入 boot graph | 解析 `window.__DSH_BOOT__.entries` | 41 条客户端插件条目中**含全部三个**，各带 url/rev/inject |
| 模型链路可用 | `dsh --profile headless "…"` | 返回预期文本，凭据与 `deepseek-flash` 路由有效 |

boot graph 证据（节选）：

```
dsh-genui      /plugins/dsh-genui/client.js?rev=2fc2dceb02dc
               inject: [dsh-client-ui-chat, dsh-client-ui-conversation,
                        dsh-client-ui-slots, dsh-client-ui-primitives]
dsh-connect    /plugins/dsh-connect/client.js?rev=e8cfc80cad10
               inject: [dsh-client-runtime, dsh-client-ui-settings,
                        dsh-client-locale, dsh-client-connection, dsh-api-remotes]
dsh-node-flow  /plugins/dsh-node-flow/client.js?rev=b1ef887ead6f
```

### 3.3 一个架构发现：三插件**硬依赖** Web 服务

本轮尝试用 `--patch` 覆盖把 `web` profile 的 `webserver` 行关掉、只跑一次性任务，
boot 审计直接拒绝：

```
Error: dsh: 8 entries did not activate
  @deepseek-ai/dsh-web-search-deepseek: pending (waiting for service: web)
  @deepseek-ai/dsh-host-directory-picker-auto: pending (waiting for service: webServer)
  @deepseek-ai/dsh-host-apiproxy: pending (waiting for service: directoryPicker)
  @deepseek-ai/dsh-client-hmr: pending (waiting for services: clientModules, webServer)
  @deepseek-ai/dsh-client-modules: pending (waiting for service: webServer)
  @deepseek-ai/dsh-client-connection: pending (waiting for services: webServer, webRuntime)
  dsh-genui: pending (waiting for service: webServer)
  dsh-node-flow: pending (waiting for service: webServer)
```

结论：`dsh-genui` 与 `dsh-node-flow` **都硬依赖 `webServer`**（不只是 `dsh-node-flow`）。
这意味着 **KVVI 的能力面是 Web 面的**——脱离 Web 服务就没有 GenUI 卡片渲染，
也没有节点画布。这对「KVVI 不只跑在 chat 壳里」的后续设想是硬约束，需记入设计前提。

### 3.4 运行时挂载实测（本轮，含一处自我纠错）

**先纠正一处本轮的自我误判。** 本轮先测得「预设根本没挂载」，结论是错的，
原因是探针调用点用错：`agentPresets.composedPreset()` 收的是 **agent 的 scope 上下文**
（`agent.ctx`），不是 Agent 对象。传 Agent 对象时它返回 `undefined`，看起来像没挂上。
传 `agent.ctx` 后返回 `kvvi`。**这是探针 bug，不是 KVVI 缺陷**，如实记录以免误导后续。

用正确调用点复测，证据如下：

| 项 | 方法 | 结果 |
|---|---|---|
| 预设作用域可解析 | `standingKeyFor('kvvi')` | 成功 |
| 该作用域下 Skill | `skills.list({scope: standingKey})` | **6 条**：5 个 KVVI Skill + 环境自带的 `workctl` |
| 工厂 setup 内挂载 | `mount(agentCtx,'kvvi')`（对齐 apiproxy 写法） | 成功，返回 `kvvi` |
| 挂载后运行时可见 | `composedPreset(agentCtx)` | **`kvvi`** |
| Agent 创建返回形状 | `agents.create()` | `{agent, dispose}`；`agent.ctx` 是 scope 上下文，`agent.session.id` 可用 |

### 3.5 决定性的架构事实：`headless` 入口根本不组装预设

`dsh-headless` 的 runner 在 `lib/index.js` 里自建 Agent，其 `setup` 只做一件事
（`installModelSelection`），**从不调用 `agentPresets.mount()`**：

```js
setup: (agentCtx) => {
  installModelSelection(agentCtx, { current: selection, assembled: void 0 });
}
```

而且 `agent-presets` 这一行**只由 `dsh-web-app` 组合包提供**——stock `headless`
组合里根本没有预设 roster。实测（向 headless profile 注入该行后）：

```
[KVVI-PROBE] composedPreset=undefined
[KVVI-PROBE] globalSkills=1 [workctl]           ← 模型看到的只有环境自带 skill
[KVVI-PROBE] kvviStandingSkills=6 [api-spec,dashboard-builder,data-model,form-builder,workctl,workflow-builder]
```

第三行证明预设**本身完全可用**（作用域下 5 个 Skill 俱在）；第一、二行证明
**headless 一次性任务不会用上它**。

真正的产品路径在 `dsh-host-apiproxy`，它在会话创建时于同一 seam 挂载：

```js
// dsh-host-apiproxy/lib/index.js:1815 composeAgent()
setup: async (agentCtx) => {
  installSelection(agentCtx);
  await presets.mount(agentCtx, resolvedId);   // ← Web 路径在这里组装预设
}
```

**对 KVVI 的含义**：预设是**面向 Web 会话创建路径**的产品工件。
`dsh --profile headless "<task>"` 这种一次性用法**不会**带上 KVVI 的 persona 与 Skill，
这是 DSH 入口的固有行为，不是 KVVI 的配置错误。若将来需要 headless 也跑在预设里，
最小补丁是给那个 runner 的 `setup` 补一次 `mount`（本轮未改 DSH 源码）。

### 3.6 真实会话验证：链路已跑通（本轮完成）

在**完整 web 形态进程**中（三插件 + 预设 roster 全部在场）驱动真实会话，
创建路径与 `dsh-host-apiproxy` 的 `composeAgent` 一致（`setup(agentCtx)` → `mount`）。

**第一步：人格与 Skill 确实到达模型。**
构造一个只能靠 system prompt 回答的请求（明令禁止使用工具、禁止读文件），模型的回答：

> I'm the **KVVI 搭建引擎 (KVVI building engine)** on DeepSeek Harness: I turn a
> plain-language business need into a runnable prototype — data model, forms,
> approval flows, dashboards, and an API contract written as real files.
>
> Skills in my catalog: `api-spec`, `dashboard-builder`, `data-model`, `form-builder`,
> `workctl`, `workflow-builder`.

5 个 KVVI Skill 全部在列（`workctl` 是环境自带，属正常合并）。
对照组：**未挂载**预设的同一进程内，模型回答「No skill catalog is present in my current
context」。两者对照，证明是预设挂载带来的差异，而非模型先验知识。

**第二步：自然语言 → 原型文件（真实产出）。**
输入一句业务描述（前台来访登记、被访人确认接待、可拒绝并填原因），
模型自主调用工具，在工作目录产出 4 个文件 / 542 行：

| 文件 | 行数 | 校验 |
|---|---|---|
| `01-数据模型.yml` | 148 | YAML 解析通过；顶层键 `元信息/实体/关系/状态机/不变量/数据范围/待确认` |
| `02-表单/来访登记.yml` | 128 | YAML 解析通过；含 `分组/只读区/条件显隐` |
| `03-流程/接待确认.yml` | 168 | YAML 解析通过；含 `节点/边/驳回/撤回` |
| `99-交付说明.md` | 98 | 含假设清单 A1–A7、待确认 Q1–Q10、**「跑起来了吗？—— 没有」** |

产出物严格遵循 Skill 规范，逐条对得上：

- **模型**：实体用「有生命周期/有独立身份」判据；`被访人id` 存 ref 而非复制姓名
  （注明「员工改名时不漂移」）；时间 ISO 8601 带时区；金额类不涉及故不引入；
  状态用枚举而非布尔；含乐观并发 `版本号` + `If-Match`/409
- **表单**：字段有控件映射与校验；区分只读与禁用；条件显隐
- **流程**：驳回目标态显式（终态，原因留痕）；撤回、超时、兜底、权限各自成节；
  8 条测试用例
- **接口**：状态变更走动作端点（`POST …/同意接待`），明写「用 PATCH 改状态会绕过
  权限校验（INV-04）与审计」；创建接口要求 `Idempotency-Key`
- **纪律**：用户没说的一律进「待确认」，「已离场」「已取消」两个自补状态**明确标注
  不是用户说的**；交付说明如实声明「没有生成可执行代码」「8 条测试用例是设计期望、
  不是执行记录」「未经测试，不是生产系统」

**结论：目标中的「自然语言→表单原型 链路跑通」已实证。**

### 3.7 复现方式

本轮全部验证在一个**临时第二实例**上完成，不干扰用户正在使用的 7100 进程：

```sh
# 预设 roster 只由 dsh-web-app 提供，故必须在 web 形态下验证；三插件硬依赖 webServer。
# 启动器 flag 必须在前，app flag（--port）在后。
node <dsh>/lib/bin.js --profile web --patch /tmp/kvvi-verify/overlay4.yml --port 7105

# overlay 只做两件事：把 agent-presets 的 default 设为 kvvi；插入驱动探针
```

`--patch` 是启动期 overlay，**不写用户任何文件**（`cordis.patch.yml` 保持 `[]`）。
验证结束实例即关闭，端口已确认全部释放。

### 3.8 仍未验证的部分

- **浏览器内的人工点击**：三插件是进程启动时装配的，用户当前 7100 进程（PID 1011，
  启动于 08:53）早于插件安装，因此**该进程内三插件未激活**，会话里也还没有 KVVI 预设可选。
  上面的验证走的是同一 profile 的临时新实例。要在你日常那个界面里看到 GenUI 表单卡片
  与节点画布，仍需重启 7100 进程 —— 这会中断本会话，属人工动作。
- **GenUI 卡片的实际渲染观感**：本次证明的是「模型产出符合规范的原型文件」+
  「三插件在全新进程中激活并注册客户端半」。表单卡片在浏览器里的视觉效果未截图确认。

---

## 4. 下一步（按顺序）

1. **重启你的 Web 进程**（PID 1011 启动于插件安装之前，该进程内三插件未激活）。
   ⚠ 本会话运行在该进程内，重启会中断当前会话——请另开会话继续。
2. **新建会话**，预设选择器选 `KVVI 搭建引擎`
   （`~/.dsh/settings.yaml` 的默认预设仍是 `aopc`，需手动改选；
   如希望以后默认即 KVVI，把 `agent-presets.default` 改为 `kvvi`）。
3. **看一次 GenUI 卡片**：输入「做一个来访登记表单」之类，确认 `dsh-genui`
   在回复里渲染出可交互表单（本次只验证到模型产出规范原型文件，未截图确认渲染观感）。
4. **归档生成效果样本**：`samples/e2e/` 已有一份（4 文件 / 542 行），
   可继续扩充作为 PRD 4.3 要求的测试数据。
5. **再评估软著交存主体**（见 §1.1）：三个插件都是第三方 MIT 代码，
   自有代码目前只有 5 个 Skill 文档，交存篇幅需要另行设计。

> 说明：链路本身已在临时新实例上实证（§3.6）。剩下的是「你日常那个界面里能看到」。

---

## 5. 与既有决策的关系

`KVVI-Builder/docs/handover/2026-09-17-Harness架构交接任务包.md` 第 0 节结论为
「**KVVI 不要复刻一个 DeepSeek Harness**，要复用其架构 DNA」，并把
agent loop、会话持久化、模型路由、chat 式 Web GUI 前端壳列为「不偷/别碰」。

本次落地**与该结论不冲突，且正是其推荐的做法**：

- 没有 fork DSH、没有复刻其运行时（DSH 装的是编译产物，本也无源码可改）；
- 走的是 DSH 一等公民扩展路径（Agent Preset + profile 插件 + 动态 Cordis 插件）；
- 复用的是组合模型、双平面（host plane vs preset plane）、Skill 注册分层这些架构 DNA。

需要重新表述的是：交接包把 KVVI 的「界面」定义为**生成出来的可运行业务系统**
（而非与 agent 聊天）。本次交付没有改变这一点——`dsh-genui` 渲染的正是
生成出来的表单/图表，chat 壳仍只是载体。但若后续要让 KVVI 拥有独立产品界面，
那才真正触及交接包列为「别碰」的范围，需单独立项评估。

---

## 6. 附：本次使用的 DSH 扩展通道（备查）

| 通道 | 落盘 | 跨重启 | 用途 |
|---|---|---|---|
| Agent Preset | `~/.dsh/.agent-presets/kvvi/` | 是 | KVVI 产品主体：persona + Skill |
| profile 插件 | `~/.dsh/profiles/web/` | 是 | 三个第三方产品插件 |
| 动态 Cordis Plugin | 仅进程内存 | 否 | 本次仅用于校验（探针），已说明为临时 |

DSH 安装目录只读、不修改任何随附预设（`standard`/`code`/`minimal`/`cordis`）。
