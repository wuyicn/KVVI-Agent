#!/bin/sh
# KVVI Agent 运行时进程入口。
#
# 归属（PRD §4.6.5）：Agent Loop、Skill 执行、插件宿主。**加载插件。**
#
# 与平台服务进程互为对照：那个进程一个插件都加载不了（镜像里没有 DSH 包），
# 这个进程加载 160+ 个。锚点⑥ 要的不是「两个容器」这个形状，
# 而是**这两条可独立复核的事实**。
set -eu

DSH_HOME="${DSH_HOME:-/data}"
PROFILE="${KVVI_PROFILE:-kvvi}"
PORT="${KVVI_RUNTIME_PORT:-7401}"
CLI=/dsh/apps/cli/lib/bin.js

mkdir -p "$DSH_HOME/profiles/$PROFILE"

# KVVI profile：在 dsh-base + dsh-web-app 之上叠加自己的 bundle。
# 不复制上游的行 —— 复制会让 Web 组合分叉，上游每次改动都要手工跟。
if [ ! -f "$DSH_HOME/profiles/$PROFILE/package.json" ]; then
  cat > "$DSH_HOME/profiles/$PROFILE/package.json" <<JSON
{
  "name": "dsh-profile-$PROFILE",
  "private": true,
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@deepseek-ai/dsh-kvvi-app"
      ]
    }
  }
}
JSON
fi

export DSH_HOME

# 启动配置取证：把组合后的插件树落盘。
#
# PRD §9.4.1 把「平台服务进程不加载任何插件」列为**可核验的启动配置**——
# 那么对照面「运行时进程加载了插件」也必须在启动配置层面可核验，
# 而不是靠读进程内部状态。`--dump-config` 给出的正是浏览器与 Loader
# 实际启动时用的那份组合结果。
node "$CLI" --profile "$PROFILE" --dump-config > "$DSH_HOME/profile-tree.yml" 2>&1 || {
  echo "{\"event\":\"dump-config-failed\"}" >&2
  cat "$DSH_HOME/profile-tree.yml" >&2
  exit 1
}
ROWS=$(grep -c '^- id:' "$DSH_HOME/profile-tree.yml" || true)
echo "{\"event\":\"runtime-service-up\",\"profile\":\"$PROFILE\",\"pluginRows\":$ROWS,\"listen\":\"0.0.0.0:$PORT\",\"tree\":\"$DSH_HOME/profile-tree.yml\"}"

# 插件行数为 0 说明 bundle 没解析上 —— 此时启动的是一个空壳，
# 静默跑起来会比直接失败更难查。
if [ "$ROWS" -eq 0 ]; then
  echo '{"event":"runtime-service-abort","reason":"profile composed to zero plugin rows"}' >&2
  exit 1
fi

# ── 绑定地址：为什么是 127.0.0.1（以及这带来的已知限制）──────────────────
#
# 这里**不是**随手写的默认值，而是 DSH 当前唯一可用的取值。两条约束夹击：
#
#   1. startup 拒绝通配符（packages/bundle/web-app/src/startup.ts:75）：
#        "--host 0.0.0.0 is intentionally not supported yet for safety:
#         it would expose remote code execution to the network"
#      理由是直接的：本进程加载插件、能执行代码，暴露到网络等于把 RCE 暴露出去。
#
#   2. webserver 插件的 Config schema 只接受两个字面量
#      （packages/host/webserver）："127.0.0.1" | "0.0.0.0"。
#      绑别的地址会以 ValidationError 直接启动失败：
#        $.host expected "127.0.0.1" | "0.0.0.0" but got "172.19.0.2"
#
#   1 排除了 0.0.0.0，2 排除了其它一切 —— **净结果只剩 127.0.0.1**。
#
# ⚠️ 由此产生的已知限制（阶段一不解决，须显式决策）：
#     容器化部署下，Web UI **无法从宿主访问**；容器内的健康检查仍可通过。
#     这不影响阶段一锚点 ②⑥ —— 那两条要求的是「两进程分离」与
#     「平台服务进程不加载插件」，都不含「宿主能访问 Web UI」。
#
#     要打通对外访问，按 PRD §4.1.1「若 DSH 与规则不同，**修改 DSH，而不是改规则**」，
#     须作为 fork 改造点处理：要么放宽 webserver 的 host 枚举，
#     要么改为「平台服务进程作唯一对外入口、本进程只在内网监听」。
#     二者都需要在 forks/dsh/改造点清单.md 登记后实施。
BIND_HOST=127.0.0.1

# ★ 不要在这里写 `web`。
#
#   `dsh web` 里的 `web` 是 **profile 名的简写**，不是 app 名。`--profile kvvi`
#   已经选定了 profile，再写一个 `web` 会变成多余的位置参数，被交给 app 自己解析，
#   于是启动失败：`too many arguments. Expected 0 arguments but got 1: web.`
#
#   验证方式（这条能证明 kvvi profile 的 app 就是 web）：
#       dsh --profile kvvi --help   →  打印的是 web app 的帮助
#
#   launcher 用 passThroughOptions：从第一个它不认识的 token 起，
#   后面的参数全部交给被启动的 app，所以 --host/--port/--no-open 这样传是对的。
exec node "$CLI" --profile "$PROFILE" --host "$BIND_HOST" --port "$PORT" --no-open
