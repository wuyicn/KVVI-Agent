# KVVI-Agent

> 基于 DeepSeek Harness 构建的**智能生成式应用搭建平台**：搭建者用自然语言描述需求，AI 生成完整的业务系统（表单、审批流、看板、接口），发布后员工用自然语言办业务。

- 完整项目介绍（技术向）：[`docs/项目介绍.md`](docs/项目介绍.md)
- 对外口径（客户/投资人）：[`docs/项目介绍-对外.md`](docs/项目介绍-对外.md)
- 开发进度：[`进度.md`](进度.md)
- 安装部署：先读 [`安装手册.md`](安装手册.md)

## 三个身份

| 身份 | 入口 | 能做什么 |
|---|---|---|
| **owner 所有者** | `/kvvi/login` | 管人、管权限、审批发布、配品牌 |
| **builder 搭建者** | `/kvvi/builder/login` | 用自然语言搭系统、提交发布草案 |
| **staff 员工** | `/kvvi/login` | 在已发布的系统里查数据、办业务 |

## 仓库结构

| 目录 | 是什么 |
|---|---|
| `services/platform/` | 平台服务进程（身份、授权、契约、发布、会话、业务记录） |
| `vendor/dsh/` | Agent 运行时（KVVI 改过的 DSH，gitignored，经 `forks/dsh/` 可重建） |
| `forks/dsh/` | DSH 的改造点清单、指纹与变更文件 |
| `contracts/` | 13 份 MetaSchema 契约 |
| `distribution/` | 私有化发行版与运维入口 `kvvi-admin` |
| `工具/` | 校验器、检查器、进度/交付工具 |
| `样例/` | 蓝图样例、黄金样例、行业包样例 |
| `docs/` | 取证、进度、交付文档 |
| `protocol/` | `kvvi-json-c14n` 的双实现 |

## 快速上手（macOS 试点）

```bash
python3 distribution/bin/kvvi-admin preflight                 # 只读的环境检查
python3 distribution/bin/kvvi-admin install --plan            # 只打印将要做什么
python3 distribution/bin/kvvi-admin install --apply --yes     # 执行
python3 distribution/bin/kvvi-admin start  --apply --yes      # 起服务
python3 distribution/bin/kvvi-admin status                    # 状态与已知降级
```

## 这一版不承诺什么

- **Linux 部署** —— 第一版只做 macOS；
- **一个包装完就用** —— 要预装 Node 24 与 Homebrew `postgresql@17`，并跑一次 `pnpm install`；
- **三个独立数据库实例** —— 第一版是一个实例内的三个独立数据库（库/角色/RLS/审计规则保留，实例级隔离减弱）；
- **两个进程分属不同系统用户** —— 同用户运行；
- **备份 / 恢复 / 大版本升级 / 卸载** —— 备份/恢复/卸载已实现，大版本升级尚未实现。

逐条说明见 [`安装手册.md`](安装手册.md) §6。
