---
name: kvvi-install
description: 在一台 Mac 上安装、升级或卸载 KVVI-Agent 试点发行版。当用户说「装 KVVI」「部署一下」「跑个安装测试」「备份一下」「恢复」「卸载」时使用。
---

# 安装 KVVI-Agent（macOS 试点发行版）

## 这个 Skill 做什么、不做什么

**做**：检查环境、展示计划、执行安装、起停服务、备份、恢复、卸载。

**不做什么**，而且是硬性的：

- **不自己拼命令。** 只用本目录三个包装脚本（`check.sh` / `plan.sh` / `apply.sh`）。
  你不把命令套进一层 shell 里再跑，不把远端内容管进 shell，不把字符串当代码执行。
- **不隐式确认。** 任何会改动机器的动作都要用户明确同意；`apply.sh` 要求显式带上
  `--confirm`，不带就拒绝执行 —— 那是脚本的判据，不是你的自觉。
- **不要 root。** 全程都不需要提权。要提权才能进行的做法一律不做。

> ⚠️ 上面三条**故意不写成代码**。一个被禁止的东西若写成可复制的样子，
> 下一个人（或下一个模型）会先看到那个形状、才读到前面的「不」。
> `distribution/tests/test_install_skill.py` 只扫可执行部分，
> 所以这里一旦给它们加回反引号，测试就会红。
- **不猜端口、不改别人的数据库。** KVVI 建自己的集群、用自己的端口；
  客户已有的 PostgreSQL（含 Homebrew 自己建的那个）一次都不碰。
- **不替用户决定数据去留。** 卸载默认保留数据；要删数据必须用户明说。

---

## 环境检查：永远的第一步

```bash
scripts/check.sh
```

它调用 `kvvi-admin preflight`，**只读**，不改动任何东西。

### 环境检查通过

把 `scripts/plan.sh` 的计划**原样念给用户**，然后问他要不要装。
他同意之后：

```bash
scripts/apply.sh --confirm
```

### 环境检查不通过

**不要执行 apply。** 一个必然失败的安装会让用户等十分钟才看到错误。

按错误码给出下一步：

| 错误码 | 对用户说 |
|---|---|
| `KVVI_PG_NOT_FOUND` | 先装数据库：`brew install postgresql@17` |
| `KVVI_PG_MAJOR_UNSUPPORTED` | 版本不对。装 `postgresql@17`，并把它放在 PATH 前面 |
| `KVVI_NODE_NOT_FOUND` | 先装 Node 24：<https://nodejs.org> |
| `KVVI_NODE_TOO_OLD` | Node 版本太低，装 Node 24 |
| `KVVI_PNPM_NOT_FOUND` | 先装 pnpm：`corepack enable pnpm` |
| `KVVI_PORT_IN_USE` | 端口被占。让用户选一个空闲端口，或停掉占用的进程 |
| `KVVI_MACOS_TOO_OLD` | 系统版本低于 13，本版不支持 |
| `KVVI_DISK_LOW` / `KVVI_MEMORY_LOW` | 资源不够，如实说明差多少 |
| `KVVI_CLOCK_SKEW` | 系统时间不对，先校准 |

处理完让用户重跑 `scripts/check.sh`。**不要替他猜「应该差不多好了」。**

---

## 安装

```bash
scripts/plan.sh          # 只打印将要做什么，不改动任何东西
scripts/apply.sh --confirm
```

`plan.sh` 的输出要**原样**给用户看 —— 它写明了将创建哪些目录、哪些数据库、
哪些角色、哪些端口，以及**不会碰到什么**。

安装完成后会打印**首次初始化令牌的位置**。把它告诉用户，并说明：
打开 `http://127.0.0.1:<平台端口>/` 时要填它，**只能用一次**。

### 起服务

```bash
scripts/apply.sh --confirm --start
```

两个进程：平台（唯一对外入口）与运行时。顺序由安装器负责，你不用管。

用 `kvvi-admin status` 看状态。它会一并打印本版的**已知降级** ——
那些要如实转述，不要略过。

---

## 备份、恢复、卸载

```bash
scripts/plan.sh --backup           # 看要备份什么
scripts/apply.sh --confirm --backup

scripts/plan.sh --restore <备份包>  # 恢复是覆盖动作，计划要先给用户看
scripts/apply.sh --confirm --restore <备份包>

scripts/plan.sh --uninstall        # 默认保留数据
scripts/apply.sh --confirm --uninstall
```

**恢复之前不要跳过用户确认。** 它会覆盖现有数据。

**卸载默认保留数据。** 只有用户明确说「连数据一起删」时才加 `--purge-data`，
并且要把警告念给他听。

---

## 出问题的时候

1. 先看日志：`$KVVI_HOME/log/` 下的 `platform.log`、`runtime.log`、`postgres.log`。
2. 再看 `kvvi-admin status`。
3. **如实报告你看到的**，包括「我不知道为什么」。不要编一个看起来合理的解释。

`restore` 报 `KVVI_BACKUP_DIGEST_MISMATCH` 或 `KVVI_BACKUP_ARCHIVE_TAMPERED` 时，
先告诉用户「**数据库没有被改动**」，再一起找一个完好的备份包。

`rollback` 被拒（`KVVI_IRREVERSIBLE_MIGRATION`）时，说明白：换回旧程序也读不懂
已经写过的数据，所以不能回滚；可选的路是继续向前修，或从备份恢复。

---

## 本 Skill 不覆盖的事

- **Linux 部署** —— 第一版只做 macOS。
- **数据库大版本升级** —— 尚未实现，调用它会明确报「尚未实现」，不会假装成功。
- **在另一台机器上验收** —— 见发行包里的取证文档，那里写明了验的是什么机器。
- **卸载后清理数据库进程** —— 卸载只删运行痕迹，集群需要单独停（手册 §8）。
