# 交接包：KVVI-Agent → Codex

> **这份文件是自足的。** 读它的人（或 agent）没有此前的对话上下文，下面所有事实都带可复核的依据。
> 生成时间：2026-10-07。仓库 HEAD：`main@084c173`、`vendor-dsh@0e52dcc`。

---

## 一、这是什么产品

**KVVI 智能生成式应用搭建平台 V1.0** —— 一个**独立产品**（不是 DSH 的一个模式）。

它做的事：**搭建者**用自然语言描述业务需求，Agent 生成含表单、审批流、数据看板与接口契约的业务系统；点发布之后**员工**在同一套界面里用自然语言查数据、办业务。

它建立在 **DSH**（DeepSeek Harness，`github.com/deepseek-ai/deepseek-harness`）之上，是它的 fork。

### 三个进程 / 三个身份

| | 是什么 | 端口 |
|---|---|---|
| **平台** `services/platform/` | 认证、公司/角色/权限、契约、发布通道、业务记录 API | 7500 |
| **运行时** `vendor/dsh/` | DSH 本体；承载会话、Agent、工具、界面 | 7401 |
| **PostgreSQL** | 三个库（平台/业务/审计），**同一实例** | 54330（试点） |

| 身份 | 从哪进 | 能做什么 |
|---|---|---|
| **所有者 owner** | `/kvvi/login` | 管人、管权限、审批发布、**配公司品牌** |
| **搭建者 builder** | `/kvvi/builder/login` | 用 Agent 搭系统、提交发布草案 |
| **员工 staff-*** | `/kvvi/login` | 在已发布系统里查数据、办业务 |

**模式在登录时绑定**（PRD §2.6）：走哪道门就是哪个 preset，界面上**没有模式选择器**（这是刻意的，见问题 12）。

---

## 二、两个仓库与远端

| 仓库 | 位置 | 远端 / 分支 | 说明 |
|---|---|---|---|
| **KVVI-Agent** | `/Users/wuyi-macs/Documents/KVVI-Agent` | `github.com/wuyicn/KVVI-Agent` · `main`（私有） | 产品本体 |
| **DSH fork** | `KVVI-Agent/vendor/dsh/` | **同一仓库** · `vendor-dsh` | 在 KVVI-Agent 里被 `.gitignore`，所以有自己独立的 git |

⚠️ **fork 的 `origin` 指向上游 `deepseek-ai/deepseek-harness`** —— **那是别人的仓库，永远不要往它推**。我们的远端在 fork 里叫 `kvvi-shared`。

```sh
# 推 fork（在 vendor/dsh 里）
git push kvvi-shared kvvi:vendor-dsh
```

---

## 三、当前已验证的状态

### ✅ 已修复、已部署、有真机证据

| 主题 | 关键证据 |
|---|---|
| **员工模式的字段读面** | 新增 `record_schema` 工具 + `GET /api/v1/systems/:assetId/fields`；真机 `GET …/fields` → 200，四个字段都在 |
| **标识符闸** | 非 uuid 路径段 → **404 `KVVI_RECORD_NOT_FOUND`**（原先 500）；真机验过 |
| **记录号解析** | `R-20261006-000003` 能直接读单条 → 200；改联系人 → 200 且读回确认 |
| **分发层传平台地址** | 运行时环境里现在有 `KVVI_PLATFORM_URL=http://127.0.0.1:7500` |
| **模式面收窄** | 员工屏幕的模式芯片元素不存在；设置页清单从六个只剩「KVVI 工作模式」 |
| **公司品牌可配置** | 真机：文档标题「KVVI 工作台」、侧栏公司名、hero 公司标语、「预览版」徽标消失 |
| **交付链** | `--export` → `--rebuild` → `--verify` 全通：**122/130 文件一致 + 8/8 删除已生效** |

测试基线（数字是**当时的**，改动后要重新取）：

```
平台        services/platform   501 通过 / 0 失败
工具包      kvvi-business        19 通过
GUI         test:gui            444 files / 6326 passed / 1 skipped
```

### ❌ 未修（按优先级，全部有依据）

#### 🔴 高

**1. `test:web` 20 条红** —— 清单在 `交付/证据/上游/testweb失败清单.md`

分两类，**没有一类与品牌有关**：
- **3 个文件测试代码写死旧标语**：`document-preview` / `pwa-manifest` / `startup-auto-selection` 里 `getByText('Into the Unknown')`（「探索未至之境」的英文）
- **10 个文件 `remote-mock: 2 unmatched request(s): llm/listProviders / llm/listConfigurableProviders`**

第二类的两个调用出自 `packages/client/ui-settings-models/src/client/store.ts:184-185` —— **我们改过的包**（删了 `WelcomeNotice` 欢迎提示）。**怀疑**是欢迎提示原先挡在模型设置前面、删掉后模型 store 提前加载，但**没有证实**。

**修法完全取决于结论**：若是**既有红**（上游快照本来就红）→ 记档即可；若是**我们改出来的** → 要在 mock 里补那两个。**要先做一次上游导入根 `e6a559b` 的对比来判定。**

⚠️ **不要一把 `DSH_SNAPSHOT=refresh`** —— 那正是把真回归和「要更新的期望」一起抹平。

**2. 子表（明细）能力缺失**

契约层 `business-schema` 只有 `fields`，**没有「一张单带明细」的概念**。

依据：氚云 `CreateBizObject` 的 `BizObject` 第 4 层就是子表 —— `D000024Fdetail123: [{…},{…}]`（对象数组）。参见 <https://help.h3yun.com/contents/1008/1634.html>。

客户登记不需要，但**订单 / 报销 / 验收 / 盘点必需**。**这不是接口形状问题，是契约层的能力边界** —— 要动 meta-schema。

#### 🟡 中

**3. 上游那笔账** —— 报告在 `交付/证据/上游/上游改造面.md`

我们改了 **130** 个文件（122 改动 + 8 删除），其中**上游自 2026-09-17 起也动过 42 个**（高风险 25）。

最尖锐的是 `packages/client/ui-plugin-manager/src/client/locales.ts`（上游改过 48 次，**且正在改我们改的同一个字符串** `installGuideSafety`）。其次是 4 个 tsconfig 的 `references`/`paths` 数组（我们插的行和上游反复增删的区间是同一块）。

⚠️ **报告自己标了三条限制**：只读了 commit 标题、**没比 diff**；`path=` 查询**不追重命名**；**没做 merge 试算**。所以 **25 个高风险 ≠ 25 个真冲突**，它只说明「值得先看」。下一步是**对那 25 个比 diff**。

**4. 上游已远远跑在前面**

| | 上游 | 我们 |
|---|---|---|
| 最新 | `dsh-v0.2.1-alpha.1`（2026-10-03） | 基线 `ddefc45f`（2026-09-17） |
| 差距 | — | 落后 **2,677 个提交** |

上游仓 **263 MB**。**不要试图 merge** —— 正解是按 `forks/dsh/改造点清单.md` 逐条重放。

#### 🟢 低（记录在案，别当没看见）

- 设置页的「允许切换 agent 模式」开关仍渲染（上游无条件渲染，`modeSelectionEnabled: false` 只让它显示为「关」）
- 员工仍可写全局设置 `agent-presets.modeSelectionEnabled`（影响有限，但是一次不该有的写）
- 侧栏「插件」入口（占 **list 槽**，占槽只能追加、盖不掉；业主裁定不做）
- 两条**既有红**：`verify-client-domain-graph` 38 条、`verify-package-dependencies` 1 条。**都不指向我们的改动，没静默修也没忽略**

### ⚪ 查不清（**不许猜，这三条是明确留白**）

| 事 | 为什么查不清 |
|---|---|
| Agent 说「列表接口只给条数，不给记录 ID 和行内容」—— 但工具声明里 `recordId`/`rowVersion` **都是 required**，实测端点也确实返回它们 | **和代码对不上**。可能它那次调用其实失败了，或拿到了没在意，或被截断。**没有那次会话日志** |
| `test:web` 那 10 条是既有红还是我们改出来的 | 要做上游导入根的对比，**没做** |
| `lifecycle.mjs` 的 `offboard` 也把 `recordId` 直接进 uuid 查询 | 它**没有 HTTP 调用方**，今天不是漏洞；**哪天给它加端点就会漏** |

---

## 四、开工前必须知道的九件事

**这些每一条都是真踩过的坑，不是预防性提醒。**

### 环境

1. **Node 24 不在 PATH 里**，要用绝对路径或先 export：
   ```sh
   export PATH="$HOME/.local/opt/node-v24.20.0/bin:$PATH"
   ```
2. **`kvvi-admin` 必须带 `--config`**。它的 `DEFAULT_HOME` 是 `~/Library/Application Support/KVVI-Agent`，而试点在 `KVVI-Agent-Pilot` —— **不带就对着另一套 home 操作**，症状是 `stop` 说「未运行」而进程明明活着（我差一点把这个记成产品缺陷）。
   ```sh
   CFG=~/KVVI-Pilot/kvvi-pilot.config.json
   python3 distribution/bin/kvvi-admin status --config "$CFG"
   python3 distribution/bin/kvvi-admin stop  --config "$CFG" --apply --yes
   python3 distribution/bin/kvvi-admin start --config "$CFG" --apply --yes
   ```
3. **试点口令不在仓库里**。按顺序读：环境变量 `KVVI_PILOT_PASSWORD` → `~/KVVI-Pilot/kvvi-pilot.secret` 第一行。
   账号：`owner` / `builder` / `staff-edit` / `staff-view` / `staff-none`。
   （它一度硬编码在四个文件里，已从**工作区、6 条历史提交、一个 Codex 检查点快照**三处清掉。**别再写回去**。）
4. **中文文件名有 Unicode 规范形式问题**：在 Python 里手写路径字符串打开 `变更/.删除的路径.json` 会报「文件不存在」而文件明明在。**用 `find` / `glob` 拿真实路径。**

### 纪律

5. **提交失败不会留下干净状态。** `git commit` 被 pre-commit 挡下时，**暂存区原样保留**。我在这一轮里三次把两个关注点混进同一条提交，根因都是这个假设。
   → **提交前看 `git status --porcelain`（看暂存区），提交失败后第一件事是确认暂存区。**
6. **部署产物要按「产物与源码一不一致」挑，不是按「源码变没变」挑。** 部署品牌时第一轮标题还是旧的 —— 因为 `ui-layout` / `ui-sidebar` 把产品名**内联**进了自己的 `lib/client.js`，而它们不在「最近改动」名单里。
   → 遍历 `vendor/dsh/packages/*/*/lib/client.js` 逐个比哈希。
7. **换端口或重装之后，先确认旧实例不在了。** 工具连错端口时**不报错**，只报一个别的错 —— 实测连到 7400 上一个 9 月 23 日的旧实例，它回 `303 + text/plain`，整条链路看起来像「系统没通」。
8. **同步产物和进程要对上**：加了 workspace 包之后，发行树要重新 `pnpm install`，**而且必须重启运行时**。不重启时界面完全正常（登录、翻会话、打字都行），**只有发消息没反应**，控制台**没有报错**。
9. **工具报绿 ≠ 事情对了；工具报红也可能是调用方的问题。** 这一轮里我写了两次错的自检（读了 JSON 的顶层而不是 `environment` 子对象、shell 变量存不了 NUL 导致三条反例被静默跳过），两次都差点把结论写反。

---

## 五、怎么验（判据优先于结论）

这个仓库不接受「我改好了」。**每条判据都要能变红**，做法是**把闸门拆掉、确认对应用例真的红了、再还原**。

`工具/` 下的检查器大多带一个 `_自测.sh`，它们就是这个模式的落地。参考 `工具/fork_自测.py`（13 条，含「导出中途失败不破坏已有镜像」）。

**验收的基本要求**：

- 声称「已修」→ 附**能重跑的验证命令及其实际输出**
- 声称「通过」→ 说明**这条判据拒绝什么样的无效输入**
- 部署过 → 在**部署物**上再验一次（不是只跑源码测试）
- 查不到 → 写「查不到」和**你查了什么**，不许猜

---

## 六、常用命令

```sh
cd /Users/wuyi-macs/Documents/KVVI-Agent
export PATH="$HOME/.local/opt/node-v24.20.0/bin:$PATH"   # 本机实际路径，按你的环境调整

# 平台测试（基线 501/0）
cd services/platform && KVVI_DEV_KEYS=1 KVVI_SIGNING_KEY_PATH=/tmp/kvvi-s11.key \
  node --test --test-concurrency=1 'tests/*.test.mjs'

# 工具包测试
cd vendor/dsh && pnpm --filter @deepseek-ai/dsh-tool-kvvi-business test

# GUI 测试（秒级，改动客户端就跑到这一档）
cd vendor/dsh && pnpm run test:gui

# 浏览器 e2e（约 15 分钟；先 build）
cd vendor/dsh && DSH_CLIENT_TITLE="KVVI 工作台" DSH_SNAPSHOT=replay pnpm run test:web

# 构建
cd vendor/dsh && DSH_CLIENT_TITLE="KVVI 工作台" pnpm build

# 改造点登记与交付链
python3 工具/g2_改造点.py --check
python3 工具/g2_改造点.py --manifest
python3 工具/fork.py --export
python3 工具/fork.py --rebuild --into /tmp/fork-rebuild
python3 工具/fork.py --verify  --into /tmp/fork-rebuild
```

---

## 七、这一轮做完的交货清单

| 提交 | 内容 |
|---|---|
| KVVI-Agent `44da3ed` | 员工侧修复的平台半边（字段读面端点、标识符闸、记录号解析、`KVVI_PLATFORM_URL`） |
| KVVI-Agent `e911d42` | 登记表补漏（新增 DSH-A17）+ 指纹重生成 + 问题 30–44 清单 |
| KVVI-Agent `084c173` | **`fork.py` 能表达「删除」** + 刷新后的镜像 + 交付文档数字 |
| fork `0e52dcc` | `record_schema` 工具、`RECORD_REF` 说明、`platformUrl` 兜底去掉 |

**问题清单在 `docs/试点测试-问题清单.md`（问题 30–44）** —— 那是这一轮所有现场问题的完整记录，分「已修并验证 / 未修（按优先级）/ 查不清」三块。

---

## 八、我的建议顺序

1. **先判定 `test:web` 那 10 条是既有红还是我们改出来的**（跑一次上游导入根 `e6a559b` 的 `test:web`）。**因为它的结论决定修法**，而现在没人知道。
2. **再修那 3 个写死旧标语的测试文件**（这部分没有歧义）。
3. **然后对上游那 25 个高风险文件比 diff**，把「碰撞面」变成「实际要改几处」。
4. **子表（明细）单独一轮** —— 它动 meta-schema，是最重的一件。

第 1 件最该先做：**不判它，后面所有关于「测试红不红」的结论都不可靠。**
