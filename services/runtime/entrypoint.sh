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

# ── 绑定地址与受信任 authority（必须在首次使用之前定义）────────────────
#
# ⚠️ 这两个变量曾在脚本后段定义、却在前段被 echo 引用 —— 结果是启动日志里
#    打出空值，而进程本身照常工作。**日志里的空值比报错更难发现**，
#    因为它长得像「这个字段本来就没值」。故定义一律前置于使用点。
#
# 为什么绑容器内网地址、而不是 127.0.0.1：
#   上游两条约束夹击后只剩 loopback，而 loopback 在各容器内是隔离的，
#   平台服务进程因此够不到本进程，PRD §4.6.5 的请求分流无从落地。
#   已按 §4.1.1「若 DSH 与规则不同，修改 DSH，而不是改规则」让 webserver
#   支持显式 IPv4 监听（fork 改造点 DSH-B5）。同时保留原有两条语义：
#     · 0.0.0.0 仍被 startup 拒绝 —— 最危险的形态没有放开
#     · 未显式指定时仍是 127.0.0.1
#
# 本进程不映射宿主端口，只在 kvvi_control 网络内可达；对外只有平台服务进程。
BIND_IP=$(/usr/local/bin/kvvi-bind-ip) || { echo '{"event":"runtime-service-abort","reason":"no non-internal IPv4 address"}' >&2; exit 1; }

TRUSTED_NAME="${KVVI_TRUSTED_NAME:-runtime}"



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
echo "{\"event\":\"runtime-service-up\",\"profile\":\"$PROFILE\",\"pluginRows\":$ROWS,\"bind\":\"$BIND_IP:$PORT\",\"trustedName\":\"$TRUSTED_NAME\",\"tree\":\"$DSH_HOME/profile-tree.yml\"}"

# 插件行数为 0 说明 bundle 没解析上 —— 此时启动的是一个空壳，
# 静默跑起来会比直接失败更难查。
if [ "$ROWS" -eq 0 ]; then
  echo '{"event":"runtime-service-abort","reason":"profile composed to zero plugin rows"}' >&2
  exit 1
fi

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
exec node "$CLI" --profile "$PROFILE" --host "$BIND_IP" --port "$PORT" --no-open --trusted-host "$TRUSTED_NAME"
