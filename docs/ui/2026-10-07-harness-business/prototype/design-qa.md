# 2026-10-09 融合原型 QA（本轮结论）

final result: passed

仅表示 7506 桌面融合原型可供设计评审，不表示真实权限、模型、审核、发布或 7500 集成完成。

## 来源与比较边界

- 视觉来源：`/Users/wuyi-macs/Documents/Codex/2026-09-25/new-chat/kvvi-ui-design/01-builder.png`、`03-form.png`。
- 现有产品骨架来源：`/Users/wuyi-macs/Documents/Codex/2026-09-25/new-chat/kvvi-ui-audit-2026-10-09/` 的 7500 现场截图，以及修改前的 BusinessHub 代码与页面。
- 实现：`http://127.0.0.1:7506/`，`evidence-fusion/05-builder-final.png`、`03-form-final.png`、`04-employee-records-ai.png`。
- 主比较 viewport：1487 × 1058 CSS px；参考图和最终截图均为 1487 × 1058 像素，1x，无缩放归一化。另测 1100 × 800：document clientWidth 与 scrollWidth 均为 1100，右栏内容独立滚动；浏览器覆盖尺寸已恢复。
- 两组参考与最终截图在同一个图像比较输入中查看。此任务为融合而非像素级复刻：保留 DSH 230px 侧栏、420px 搭建预览、360px 业务 AI 和标签栏；保留现有新增记录弹窗入口，把表单＋AI 布局放入 1120px 大弹窗，不直接换成原图整页。
- 状态差异明确：搭建原图是预置对话，实现截图为空会话；不比较虚构消息内容。填单原图为示例已填写状态，实现也填写模拟客户、联系人和备注。未伪造已连接 AI 的对话。

## 五项视觉检查

- 字体：PingFang SC / 系统无衬线；输入 16px，字段标签 14px，主要标题 23–28px，辅助说明 12px。长名称可在字段区换行，记录表允许内部水平滚动。
- 间距：沿用侧栏与 DSH dock；表单 22px 行间距、20px 列间距，固定底部操作区，未见主要按钮被裁切。
- 色彩：白主区、浅灰侧栏、蓝色主按钮与模式提示；辅助文案加深为 #697586；焦点环可见。
- 资产：继续使用既有 `/kvvi-mark.svg`、`/demo-avatar.png` 与已安装 Lucide 图标，没有新增手绘替代资产。
- 文案：明确 7506 独立原型、示例数据、刷新重置；发布按钮进入“待审核（模拟）”，不声称真实发布；原型所有者是角色而非第三模式。
- 重点区域检查：全尺寸截图中表单控件、中文标签、输入框、主次按钮和模式文字均可直接读清，无需额外放大截图。表单右侧输入最初有重复边框，已修正。

## 比较与修复记录

1. `02-form-draft.png`：发现 P2，弹窗通用 textarea 样式导致 AI 输入框出现双层边框；已用 `.fusion-dialog .hub-chat-input textarea` 限定修正。
2. 浏览器复现：填写备注后按 Esc，再次打开备注丢失。根因是 HubDialog 键盘事件持有挂载时 onClose，未读取最新 form；改为 closeRef 后用相同操作复测，最新备注恢复。
3. `03-form-final.png`：重新捕获，双边框消除，草稿数据存在，提交区完整；与参考图同输入比较，未见剩余阻断本轮桌面评审的 P0/P1/P2 问题。

## 交互验证

- 工作区 → 界面预览：字段与 DSH 标签栏显示；右栏可收起。
- 空表单提交：出现“请填写客户名称”，未新增记录。
- 保存草稿并关闭 → 再打开：客户、联系人保留。
- 填写新备注 → Esc → 再打开：最新备注保留。
- 提交登记：侧栏记录列表显示相同数据；切换业务区仍可看到这条记录。
- 员工身份：无新建业务、设计表单和提交发布入口；业务记录与 AI 可使用（仅模拟布局，不是安全验收）。
- AI 模拟查询记录数：返回 1 条客户记录，没有错误的金额汇总。
- 提交发布：仅将原型按钮改为“待审核（模拟）”，提示未发布到 7500。
- 页面重载：正常显示；所有示例记录与草稿按标注重置。
- 控制台：编辑过程中曾有两条缺失新增文件引起的 Vite 热更新错误；文件补齐、最终构建及重载后没有新增 error/warn，旧日志保留，不称历史日志为空。
- 最终 `npm test`：10 passed；`npm run build`：成功；`npm run test:sites`：4 passed。未部署 Sites。

## 剩余边界

- 待用户确认融合布局，暂未接入 7500。
- AI 自动填单、真实发布审批、成员权限后台不在本轮实现范围；原型身份按钮不构成真实授权。
- 桌面评审通过；移动端、屏幕阅读器和跨刷新草稿持久化未验收。
- 原文件备份于 `backups/2026-10-09-before-fusion/`；未提交 Git，未修改 vendor、后台或正式数据库。

---

# Business Hub visual QA（历史记录）

Source: /Users/wuyi-macs/.codex/generated_images/01a1140c-853b-7143-a29b-7dd868d55fc3/exec-75e2c042-8fba-400c-ae66-e8601eb03dda.png

Implementation: http://127.0.0.1:7506/

Current result: passed after recapture and comparison.

## First comparison

Evidence: evidence-business/home-comparison-after.jpg and workbench-comparison-after.jpg.
Source is a 1038x1515 two-state board. Home crop 1038x750; workbench crop 1038x749. Browser captures 1038x750 CSS px, density 1. The earlier 1440x1024 comparison enlarged the generated source typography and is superseded by native-pixel comparisons. The prototype adds a 32px identity/demo strip outside app content.

- P1: resource creation menu is clipped by the directory overflow. Move scrolling to the navigation list, allow toolbar popup to overflow.
- P2: compact workbench toolbar wraps and table rows consume excess height. Reduce minimum search width and compact row padding at this viewport.
- P2: business-home spacing exceeds the reference. Reduce header, search-to-table spacing and row padding.
- P2: earlier workspace rendering mirrored every business into the global workspace list. Preserve the existing workspace independently; add associations on creation/conversation only.
- P2: table columns were removed when AI opened. Preserve columns and permit horizontal scrolling.

## Final comparison and fixes

Evidence: evidence-business/home-comparison-final.jpg and workbench-comparison-final.jpg. Each comparison contains the reference crop and browser capture side by side at native pixels. Browser viewport 1038x750, density 1. Home source 1038x750; workbench source 1038x749, padded with one white row, without scaling. The 32px prototype identity strip is an intentional addition. A second desktop capture, evidence-business/preview.jpg, is 1440x1024 at density 1 and was captured after the upstream panel slide animation finished (transform none, x=1110).

All prior P1/P2 findings resolved:
- Popup scrolling moved from the whole directory to the resource navigation; all four creation items are now visible.
- Compact toolbar search can shrink; compact record rows keep all six records and the footer accessible.
- Home header, search spacing and row padding reduced. System descriptions add one deliberate secondary line.
- Workspaces are independent of the system catalogue. Existing customer workspace remains; new business/conversation associations are created explicitly.
- All six configured table columns remain in the table while AI opens; narrow widths use contained horizontal scrolling. Persistent controls stay visible.

## Required fidelity surfaces

- Typography: PingFang SC with system fallbacks; body and inputs 14px, data cells 13px, headings 20/23px. Same hierarchy as reference, no clipped titles. DSH native tab titles use the record number rather than the mock's generic record-detail title.
- Layout: global sidebar 230px expanded or 64px collapsed, local directory 180px (160px compact), optional right panel 330px (280px compact). One right pane. Source DSH panel begins at the frame top; this is intentional source reuse rather than reproducing mock-only header positioning. Narrow table scroll is intentional and preserves columns.
- Colors: white/light-gray DSH surfaces, pale-blue active rows and navigation, blue primary controls, green published/shipped state and amber pending state. Actual source theme controls the docking chrome.
- Assets: supplied KVVI SVG brand and supplied demo-avatar PNG, unmodified. Existing Lucide library supplies all standard UI icons. No CSS/SVG drawings or placeholder art replace source assets.
- Copy: Chinese labels throughout. Actual personal name appears in the profile area. Concise AI response uses current record values; mock wording was adjusted to avoid asserting a business confirmation requirement. Prototype strip identifies example data and conversation.

## Browser interaction evidence

Checked through the in-app browser:
- Business creation, automatic workspace association and empty-system first-form entry.
- Form creation, new-record required-value rejection, valid save reflected in the table.
- Field addition/renaming and saving the draft design.
- Employee home hides new-system controls and draft systems; employee workbench hides design and new-page controls. These are prototype presentation checks, not backend authorization tests.
- AI follows selected record B2026100801; switching to B2026100702 changes context and does not inherit the first record's messages.
- AI and record detail are separate tabs in exactly one DSH pane; closing the pane increases table space.
- Folder expansion, monthly report values derived from the example records, sidebar collapse/expand, and new-conversation entry.
- Console warnings/errors checked: none reported.

Local verification: final build passed; all 7 sidebar adapter tests passed, including AI tab deduplication and the single-pane constraint. The preview remains running on 7506; production files and 7500 were not changed.

## Follow-up polish

P3: library icon strokes and native DSH tab chips differ slightly from the generated concept. They deliberately follow existing source components. No actionable P0/P1/P2 issues remain in the two reviewed states.

final result: passed


## 2026-10-08 workspace / business emphasis follow-up

The latest approved feedback changes the workspace side of the previous concept: conversation remains the main surface; form/records occupy the single native right pane. Business retains the primary table with optional AI. This is a bounded follow-up to the selected design rather than a new visual direction.

Latest evidence: `evidence-business/workspace-chat-list.jpg` and `evidence-business/business-data-ai.jpg`, captured in the existing in-app browser at its native 1862x1704 viewport without override. The workspace source is the user's original Harness conversation screenshot in `reference/02-harness-conversation.png`; the selected merged concept remains the business reference. These captures verify hierarchy and interaction, not a matched-pixel comparison to the differently sized reference boards.

Checked: a workspace request opens the form; saving the example record keeps the conversation visible; the right table and business main table both contain 界面衔接测试; switching entry resets only the appropriate pane; AI is closed by default in business and opens as a single right pane. The conversation key now belongs to the workspace session instead of the selected record, fixing disappearance after save. Latest console errors: none. Prototype build and 7 adapter tests passed.

Production 7500 is now authorized for integration. Its live browser action was rejected by Browser Use policy; no alternate browser/CDP path was used. Source assembly, authorization/draft tests and service artifact checks are separate evidence and do not constitute live 7500 visual or business acceptance. Production visual QA remains awaiting the user's local test.

Follow-up result: prototype interaction passed; production visual QA unverified.
# 2026-10-09 业务直达工作台

- 按本轮两张用户截图，移除业务系统列表中间页，初始直接进入 GAD STUDIO 报货单；页头选择其他业务。
- 顶部直接提供新增表单、编辑表单、删除表单，保留表格工具栏的新增记录。删除先弹出确认。
- 浏览器实测：新增测试表单、修改名称和字段并保存、删除确认取消后表单保留、切换业务、从工作区会话点击业务直达当前表单、草稿业务切换员工后回到已发布业务且不显示管理按钮。测试结束刷新恢复原始示例；未执行最终删除。
- 视觉检查：保留参考图二的业务标题、左目录、中间记录表、按需 AI；新增顶部直接管理按钮以及小型业务切换器。正常视口无重叠，6 条原始报货记录保留。
- 证据：evidence-fusion/07-direct-business.png。最终浏览器错误/警告读取为空。
- 验证：14 项 Vitest、生产构建、4 项 Sites 打包测试通过。仅修改 7506 原型，未接入或改动 7500；员工模式只代表展示规则，不代表后端权限验收。

---
# 2026-10-09 统一业务与分组管理（覆盖上一轮业务切换方案）

- 用户确认取消业务系统层级，全部表单进入统一业务目录；移除页头系统选择器，保留既有表单、记录和工作区会话入口。
- 分组可新增、折叠、重命名；表单编辑中可选择分组。删除分组仅解散组织关系，子表单及其记录保留到未分组。
- 浏览器实测：新增分组、报货单移入新分组、改分组名，原有 6 条记录完整；模拟发布后切换员工，新分组与已发布报货单可见，管理按钮及草稿访客分组隐藏。
- 点测发现分组菜单向侧栏外溢出被裁剪，调整为向左对齐、宽度约束后重新截图确认菜单完整显示。
- 删除分组数据保留由单元测试验证，本次浏览器未执行最终删除；结束刷新还原默认示例布局。
- 17 项 Vitest、生产构建、4 项 Sites 打包测试通过。最终截图：evidence-fusion/08-grouped-business.png。
- 仅 7506 展示和交互原型，不代表生产迁移、真实权限、真实发布或 7500 集成完成。

---
