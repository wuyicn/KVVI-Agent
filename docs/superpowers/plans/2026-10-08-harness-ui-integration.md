# 已确认原型接入 7500

用户已批准将 7506 已确认界面接入 7500；复用现有 fork 分支，不修改身份绑定、授权或业务契约。

- [x] 业务入口放到左侧全局功能区；保留现有管理能力与开始页。
- [x] 个人区使用实际登录信息，设置进入个人菜单，通知仅保留无示例消息入口。
- [x] 业务表单、记录列表及详情注册为 DSH 右侧资源；默认同一栏，保留原有浮窗、全屏及主动分栏能力。
- [x] 草稿按会话和业务隔离，弹窗/面板共用；失败、取消、只读及版本冲突不伪装成功。
- [x] 源码测试、构建、GUI/browser 回归、fork 导出重建；更新本地运行时并复核 7500。

## 记录

初始主仓与 fork 工作区干净（原型 docs/ui 未跟踪）。7500 平台 pid95176、运行时 pid95192；运行时直接加载本仓 vendor/dsh 的 built 产物。首条接入回归（从已发布系统进入边聊边填）初跑 1 failed /10 passed，因入口不存在失败。

接入后的 GUI 全量：445 files passed，6338 passed /1 skipped（2026-10-08）。第一轮发现已有错误短文案的旧断言、主题圆角与背景规则；已同步断言并修正样式。构建并行时 PDF 打包测试一次超过原 5 秒超时；在 Node24 PATH 下单独重跑全 GUI 通过。创建 pending remount、真实字段选项和 READONLY 保存先红后绿。更新 pending remount 独立先红（旧版本不重读），通过 session revision 修复。独立只读评审发现的问题均进入回归。

最终 fork `1cd1251`，本地 commit hooks（含 staged lint）全部通过。最终完整 build 成功、GUI 445 files /6338 passed /1 skipped。built browser 全量首跑 118 files passed /1 skipped /2 failed（终端等 shell 启动 3 秒轮询超时、workspace-recency 首屏 30 秒等待超时）；两文件在最终产物稳定后重跑 9/9 通过。没有刷新 golden 或放宽等待断言。G2 177 paths /44 entries 通过，169 在场文件逐字节一致，8 删除生效，重建与指纹复核通过。

7500 已重启加载最终构建，数据库与已有配置保持。staff-edit 通过真实页面创建 `R-20261008-000001` 并把联系人更新到「界面验收-已保存」，版本从 1 到 2；staff-view 使用完整联测值的 POST 被 KVVI_NOT_ALLOWED 拒绝，最终短提示与草稿保留实测。builder 专用入口登录成功；其账号没有客户表单 read 权限时仍被拒绝（未扩大授权）。通知暂无后台发送功能。设置窗打开/关闭及个人按钮焦点返回实测。当前页保持 builder 登录供搭建测试。

Agent Note 按上游 `.agents/notes/README.md` 的 local UI presentation/interaction 豁免执行，状态与权衡记录在 kvvi-panel README 中；没有新增未配对的 Note。运维 `stop --plan` 的既有 ProcessPlan.describe 缺失另记；已核对纯计划定义后使用既有 --apply 入口完成重启。
