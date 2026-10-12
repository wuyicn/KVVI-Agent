# Prototype Instructions

2026-10-12 用户纠正此前口误，最终统一原则：全局导航保持最外侧；内容区的辅助内容固定放最右侧栏。会话区是左侧主会话、右侧业务预览；业务区是左侧业务表单与记录、右侧 AI 辅助。业务 AI 默认收起，点击「AI 协助」展开；辅助栏可收起、可调宽，不因收起而清空对话或表单。此条覆盖此前的左侧辅助方案，仅先调整 7506，7500 仍待正式接入验收。

2026-10-12 搭建体验：新增独立 `?builder-preview` 入口，左侧业务对话、右侧可试填表单、表单底部固定确认。后台过程不应形成会话空白占位。7506 此入口仅演示布局与列出的修改，不连接真实 AI、权限、记录或审批；保留原业务入口。新布局须经用户验收后再切换 7500，正式接入需要服务端草稿版本与确认提交，不得复制演示状态冒充真实流程。

2026-10-09 用户进一步确认：业务系统层级完全取消，不再显示业务系统切换器或新建业务系统。全体表单放在统一「业务」页，以左侧分组管理；支持新增、重命名、删除分组和表单归组。删除分组只解散分组，保留表单和记录到未分组。既有示例表单、记录保留，工作区仍以会话为主。此条覆盖下文系统列表和页头业务切换方案，修改范围仍仅 7506。

2026-10-09 业务直达：取消业务系统列表中间页，点击全局「业务」直接进入当前业务的表单/记录工作台，首次进入 GAD STUDIO 报货单。多个业务在页头切换，新增表单、编辑表单、删除表单在工作台直接操作，与新增记录区分；删除需确认。员工隐藏结构管理入口，切换身份时不能停留在草稿业务。仅修改 7506，保留现有业务数据；此条覆盖历史「业务首页采用系统列表」。

2026-10-09 最新范围：用户要求在 7506 上融合本任务四张 UI 原型与当前 7500 的布局，反复修改确认后才能接入 7500。本轮不得修改、部署或重启 7500，不得把原型数据、模拟 AI、审核状态或身份切换当作真实权限与发布。保留现有业务目录、记录列表、DSH 标签栏与工作区会话；融合模式提示、表单预览、大表单与旁侧 AI。此条覆盖下文历史上的直接接入授权。

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.

## 当前用户已确认的方向

基于用户2026-10-07提供的两张DeepSeek Harness截图增加业务功能，保留原有侧栏、会话、输入框和右侧面板的骨架，不采用前面生成的独立工作台方向。

顶部「对话」附近增加业务表单页与记录页；短操作用内置弹窗，右侧业务面板用于边聊边填。不同入口共用业务草稿和记录，不重填。按身份提供业务配置或管理入口；员工只看短结果。字体优先PingFang SC，正文输入16px、标签14px。现阶段为独立可操作原型，不修改7500正式服务，不接入真实AI、权限或发布。顶部身份切换条仅用于原型评审，正式产品身份仍由登录绑定。

2026-10-08侧栏调整：上方区间三为全局功能区，「业务」与「插件」同级，业务在前。底部改为个人信息区，常驻头像、姓名和右侧通知图标，设置放入点击个人信息展开的菜单。通知入口预留后续公司通知；当前仅做示例消息、未读和详情展示，不连接真实发送服务。参考图03的账号菜单结构，不引入套餐、积分等无关内容。7506为本轮原型，7505不是本轮修改目标。

2026-10-08右侧接入：用户要求按DSH源码规范接入。直接复用vendor/dsh的RightbarSeat、tab registry、session store、controller、tab-info、Guide与dockkit；新增业务内容按类型注册及槽位内容两阶段接入，不再使用单个panel字符串模拟标签。保留源码的两个水平栏上限、拖出浮窗、收回、全屏/收起、页面去重和记录资源去重规则。面板状态按原型身份/业务/会话隔离；不同详情必须绑定各自记录地址，聚焦详情时同步会话客户。表单仍与弹窗和完整页共用草稿。此轮仍在7506，仅连接DSH右侧前端源码；小型宿主适配不等同完整Cordis运行时、后台业务或正式权限接入，不修改vendor源码或7500。

2026-10-08右侧展示修正：用户认为最右侧同时显示两栏不合适。默认评审展示为一个右侧业务栏，表单、记录和详情通过顶部标签切换；默认外层宽度420px。DSH分栏能力保留为用户主动操作的选项，不把分栏测试结束状态留作默认展示。合并栏时保留已打开标签、业务记录和草稿。

2026-10-08业务页设计确认：业务首页采用系统列表，在页内新建、重命名和删除业务。进入业务后，在主区内组织表单、仪表盘、报表和分组；新建页面与新增记录是不同入口。以目录式方案为基础，AI协助与记录详情按需使用同一个DSH右侧面板，默认关闭，关闭后表格恢复宽度。全局侧栏允许手动收起并记住选择。搭建者、员工、所有者共用布局，通过原型身份切换展示操作差异。本轮在7506更新BusinessHub，示例GAD结构与数据不连接真实GAD，AI会话为即时示例规则，7500保持现状。合并设计图：/Users/wuyi-macs/.codex/generated_images/01a1140c-853b-7143-a29b-7dd868d55fc3/exec-75e2c042-8fba-400c-ae66-e8601eb03dda.png。


2026-10-08主次关系调整及正式接入授权：用户确认工作区以会话为主，保留工作区/会话原组织；最右侧按需展示当前业务的表单、记录列表与提交结果。业务区以表单和记录为主，AI仅在右侧辅助，默认关闭。不同入口共用同一业务数据，切换记录不能抹掉工作区会话。本轮用户明确授权「调整好了就修改到7500上」，覆盖此前不改7500的范围限制；7506仍为示例原型，真实集成在vendor/dsh的KVVI包中复用源码槽位、会话Factory、授权API，不能复制原型假数据和模拟AI。业务管理和多页面设计的原型交互不能标成已接入正式后台。
