# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.

## 用户要求（2026-10-07）

先提供可操作 UI 原型，确认后才修改正式界面。业务和会话必须相互关联，操作简单。员工主要看结果，避免技术术语与冗长解释。依据用户提供的四张 KVVI UI 图沿用白底、浅蓝侧栏及蓝色主操作。搭建资格与业务数据权限分开呈现，原型不得变更真实权限或发布业务。

用户追加要求：优化全局字体与字号。统一中文字体、字号、行距和字重；业务正文与输入文字保持16px，按钮/标签14px，辅助说明13px，状态与原型工具栏12px。窄窗口优先调整排布，避免把主要业务文字缩小。

用户同意下一轮先精简顶部标题和重复说明，并增加字段直接编辑。字段可修改名称、必填及单选选项，保存后在搭建会话中简短反馈结果；员工填写界面不显示搭建编辑入口。当前授权仍为原型迭代。
