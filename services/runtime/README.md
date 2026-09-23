# Agent 运行时进程

归属（PRD §4.6.5）：Agent Loop、Skill 执行、**插件宿主**。**加载插件。**

镜像：`kvvi/runtime:dev` · 启动：`scripts/kvvi-up.sh`

---

## 一、它加载什么（可核验）

启动时把组合后的 profile 树落盘到 `$DSH_HOME/profile-tree.yml`，
插件行数同时打进启动日志：

```
{"event":"runtime-service-up","profile":"kvvi","pluginRows":164,...}
```

对照：平台服务进程 `pluginsLoaded = 0`，且其容器内**没有 `@deepseek-ai/` 目录**。

取证命令：`python3 工具/check_topology.py`

> 插件行数为 0 时 entrypoint **主动退出**而不是继续跑。
> 空壳静默启动会比直接失败难查得多。

---

## 二、⚠️ 已知限制：Web UI 无法从宿主访问

**现象**：容器内 `dsh web` 正常服务（HTTP 401，见下），但宿主访问不到。

**根因**：DSH 的两条约束夹击，净结果只剩 `127.0.0.1` 一个可用值。

| # | 约束 | 位置 |
|---|---|---|
| 1 | startup 拒绝通配符 `0.0.0.0`：「it would expose remote code execution to the network」 | `packages/bundle/web-app/src/startup.ts:75` |
| 2 | `webserver` 的 Config schema 只接受 `"127.0.0.1" \| "0.0.0.0"`，绑其它地址直接 `ValidationError` 启动失败 | `packages/host/webserver` |

1 排除 `0.0.0.0`，2 排除其它一切 —— 只剩 `127.0.0.1`。
而每个容器有各自的 loopback，因此**平台服务进程也访问不到本进程**。

**这不影响阶段一锚点 ②⑥** —— 那两条要求的是「两进程分离」与
「平台服务进程不加载任何插件」，都不含「宿主能访问 Web UI」。

**要打通对外访问**，按 PRD §4.1.1「**若 DSH 与规则不同，修改 DSH，而不是改规则**」，
须作为 **fork 改造点**处理（登记进 `forks/dsh/改造点清单.md`）。两个候选方向：

| 方向 | 内容 | 代价 |
|---|---|---|
| A | 放宽 `webserver` 的 host 枚举，允许显式地址 | 改动小；但等于放开了 DSH 刻意关上的门 |
| B | **平台服务进程作唯一对外入口**，本进程只在容器内网监听 | 与 §4.6.5「认证端点归属平台服务进程」一致；需实现代理（含 WebSocket） |

**B 更符合 PRD 的既有设计**：§4.6.5 要求 Web 请求按类型分流、
认证请求直达平台服务进程而不经运行时进程。B 让那条分流**在架构上成立**，
A 只是让运行时进程重新直接面对网络。

---

## 三、DSH web 自带的访问控制

实测（无凭据）：

| 路径 | 响应 |
|---|---|
| `/`、`/index.html` | 401 `dsh web authentication required; reopen the URL printed by dsh web.` |
| `/api` | 401 `unauthorized` |

启动时打印带 token 的 URL：`dsh web: http://127.0.0.1:7401/?token=<随机>`。

**这是 DSH 已有的一层补偿控制**，但它**不满足 KVVI 的产品要求**：
它证明「持有 token 的人可以访问」，而 KVVI 要求的是
「**员工 A 在公司 X 的这次会话**能访问什么」—— 那需要 §9.4 的委派令牌体系。

---

## 四、本进程不承诺什么

与本进程同进程的插件，在**本进程持有的数据范围内不设防**（PRD §9.4.1 已列明：
插件可冒用活跃会话令牌；无归属到具体插件或自然人的机制）。
本 README 不主张任何超出 §9.4.1 保证表的性质。
