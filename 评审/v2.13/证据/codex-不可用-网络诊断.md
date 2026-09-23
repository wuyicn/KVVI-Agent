# Codex / GPT 不可用：网络层诊断记录

> 诊断时间：2026-09-23T08:26:37
> 目的：第七轮评审原计划包含 OpenAI 家族（填充第六轮因 Codex 挂死造成的缺口）。
> 本文件记录该缺口**无法填充的环境原因**，供冻结时如实披露。

## 一、症状

第六轮对抗验证原定 `gpt-5.6-sol`（Codex），进程运行 48 分钟无任何输出。
第七轮重试时，**连「回复两个字：收到」这种最小提示也挂住**——
说明问题与 PRD 大小、提示词内容无关。

## 二、排查过程

| 步骤 | 结果 |
|---|---|
| `codex --version` | `codex-cli 0.154.0`（正常）|
| 进程 CPU / TCP | CPU 0.0%，**无任何 TCP 连接**，卡在本地初始化 |
| 打开的 fd | sqlite（memories/queue/logs/goals）+ 一个 unix socket |
| unix socket 属主 | `~/.codex/ipc/ipc.sock`，由 **ChatGPT.app PID 66025** 占用 |
| 隔离 `CODEX_HOME=/tmp/codex-kvvi` 重试 | **仍然挂住**（排除 IPC 锁争用）|
| `codex doctor` | **退出码 0**，CLI 本身可用 |
| `codex doctor` 报告 | ⚠ websocket「Responses WebSocket failed」；✗ reachability「runtime CDN is unreachable」|

## 三、根因（网络层阻断）

```
chatgpt.com/backend-api                              → 000 (0.089554s)
api.openai.com/v1/models                             → 000 (0.402964s)
api.anthropic.com（对照）                                → 403 (0.527836s)
generativelanguage.googleapis.com（对照）                → 404 (0.905541s)
api.moonshot.cn（对照）                                  → 401 (0.478169s)
```

**`curl -v` 的关键输出**：

```
* Host chatgpt.com:443 was resolved.
*   Trying [2606:4700:4408::ac40:9bd1]:443...
* Connected to chatgpt.com (2606:4700:4408::ac40:9bd1) port 443
* LibreSSL: error:02FFF036:system library:func(4095):Connection reset by peer
```

**TCP 连接成功，TLS 握手被对端重置**——这是典型的基于 SNI 的连接阻断特征，
不是 DNS 失败、不是超时、不是本机配置问题。

## 四、结论

| 项 | 结论 |
|---|---|
| **Codex CLI 是否损坏** | ❌ 没有损坏。`codex doctor` 正常退出 |
| **是否本机配置问题** | ❌ 不是。隔离 CODEX_HOME 后仍然挂住 |
| **根因** | ✅ **`chatgpt.com` 与 `api.openai.com` 的 TLS 握手被网络层重置** |
| **可否修复** | ❌ 不可。非本机可控 |
| **后果** | **OpenAI 家族评审在当前环境下不可用** |

## 五、对冻结的影响（必须披露）

第六轮评审（v2.6）**已缺 OpenAI 家族**，第七轮（v2.7）**仍然缺失**。
因此：**连续两轮没有 OpenAI 家族参与评审。**

这与前五轮形成对比——第五轮的 v2.5 核心发现（§4.1.1 推理链不成立）
**正是 GPT-5.6 提出的**。该家族在**对抗性验证**上的能力已被本项目验证过，
**它的缺席是实质性的覆盖率缺口，不是形式问题**。

**冻结时必须写入已知局限**，不得因「评审通过了」而隐去。
