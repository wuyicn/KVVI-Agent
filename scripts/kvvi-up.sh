#!/usr/bin/env bash
#
# 一键启动 KVVI 两进程骨架（PRD §7.1 阶段一锚点 ②⑥）。
#
# 起两个容器：平台服务进程（不加载插件）与 Agent 运行时进程（加载插件）。
# 等的不是「容器起来了」，而是**两个健康检查都通过** —— 锚点②的判据是
# 「Docker 一键启动后健康检查通过」，容器 Running 不等于健康。
#
# 用法：
#   ./scripts/kvvi-up.sh              # 启动（必要时构建）并等健康
#   ./scripts/kvvi-up.sh --rebuild    # 强制重新构建镜像
#   ./scripts/kvvi-up.sh --down       # 停止并移除
#   ./scripts/kvvi-up.sh --status     # 只看状态
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT/docker-compose.kvvi.yml"
ENV_FILE="$ROOT/.kvvi-docker.env"

say() { printf '\033[36m▸\033[0m %s\n' "$*"; }
ok()  { printf '\033[32m✓\033[0m %s\n' "$*"; }
die() { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

MODE=up
for arg in "$@"; do
  case "$arg" in
    --rebuild) MODE=rebuild ;;
    --down)    MODE=down ;;
    --status)  MODE=status ;;
    -h|--help) sed -n '3,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "未知参数：$arg（用 --help 看用法）" ;;
  esac
done

command -v docker >/dev/null || die "找不到 docker"
docker info >/dev/null 2>&1 || die "Docker daemon 没在跑。先启动 Docker Desktop：
  open ~/Applications/Docker.app"

# 平台服务进程的受控接口需要调用方鉴别（PRD §4.6.5 部署基线）。
# 令牌每次生成并落在 gitignored 的 .kvvi-docker.env 里 —— 不写死进仓库，
# 也不从 compose 文件里的默认值取（默认值等于没有鉴别）。
# 一个随机值生成器：四处调用各得一个**不同**的值。
rand() { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

if [ ! -f "$ENV_FILE" ]; then
  say "生成进程间调用令牌与三个库口令 → $ENV_FILE"
  # 三个库各自的 superuser 口令（PRD §4.6.1「不共享 DBA」）。
  # 生成三个**不同**的值：共用口令会让「DBA 不共享」在配置层就不成立。
  printf '# KVVI 本地开发口令。**不要提交**（已在 .gitignore）。\nKVVI_INTERNAL_TOKEN=%s\nKVVI_PLATFORM_DB_PASSWORD=%s\nKVVI_BUSINESS_DB_PASSWORD=%s\nKVVI_AUDIT_DB_PASSWORD=%s\n' \
    "$(rand)" "$(rand)" "$(rand)" "$(rand)" > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
fi
# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a
[ -n "${KVVI_INTERNAL_TOKEN:-}" ] || die "$ENV_FILE 里没有 KVVI_INTERNAL_TOKEN"

dc() { docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }

case "$MODE" in
  down)
    say "停止并移除…"; dc down; ok "已停止"; exit 0 ;;
  status)
    dc ps; exit 0 ;;
esac

if [ "$MODE" = "rebuild" ]; then
  say "重新构建镜像…"
  dc build
fi

say "启动（等待健康检查，最长 240 秒）…"
# --wait 等的就是 Dockerfile 里的 HEALTHCHECK，不是容器 Running。
dc up -d --wait --wait-timeout 240 || {
  printf '\n\033[31m✗ 健康检查未通过。日志：\033[0m\n'
  dc ps
  dc logs --tail=40
  exit 1
}

printf '\n'
dc ps
printf '\n'
ok "两进程骨架已就绪"
printf '  平台服务进程  http://127.0.0.1:%s/healthz   （pluginsLoaded 应为 0）\n' "${KVVI_PLATFORM_PORT:-7400}"
printf '  Agent 运行时  仅在容器网络内（未映射宿主端口）\n'
printf '\n  取证：python3 工具/check_topology.py\n'
printf '  查看运行时日志：docker compose -f docker-compose.kvvi.yml logs runtime\n'
printf '  停止：%s --down\n' "$0"
