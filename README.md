# KVVI-Agent macOS 试点发行版

这是 **KVVI-Agent 的第一版发行包**：macOS 本机私有化部署。

**先读 [`安装手册.md`](安装手册.md)。** 它写明了要预装什么、每一步会改动什么、
以及这一版**不承诺**什么（有几条是硬性降级，不藏着）。

## 包里有什么

| 目录 | 是什么 |
|---|---|
| `distribution/` | 安装器与运维入口 `kvvi-admin`（前置检查、安装、起停、状态） |
| `services/platform/` | 平台服务进程（身份、授权、契约、发布、会话），**依赖已随包** |
| `vendor/dsh/` | Agent 运行时（KVVI 改过的 DSH）。**依赖不随包**，装前跑一次 `pnpm install` |
| `contracts/` | 13 份 MetaSchema 契约 |
| `protocol/` | `kvvi-json-c14n` 的双实现 |

顶层还有 `package.json`（运行时依赖的骨架）与 `发行包清单.json`（包里有什么，逐项）。

## 三条命令

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
- **备份 / 恢复 / 大版本升级 / 卸载** —— 尚未实现。

逐条说明见 `安装手册.md` §6。
