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
#   ./scripts/kvvi-up.sh --reset-volumes  # 清掉容器与**数据卷**（数据可弃时用）
#   ./scripts/kvvi-up.sh --seed-dev       # 建开发演示账号（空库必备，否则登不进去）
#
# 启动后会打印**界面入口地址**（带一次性 token）。首次访问用带 token 的地址，
# 它会换成 Cookie 并跳回根路径；之后直接开根地址即可。
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
    --reset-volumes) MODE=reset-volumes ;;
    --seed-dev) MODE=seed-dev ;;
    -h|--help) sed -n '3,21p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
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
  #
  # 第五个是**审计读角色**的口令。它与审计写角色分开 ——
  # 共用一个口令时，读写分离只剩 SQL 授权那一半，凭据本身两者一样。
  printf '# KVVI 本地开发口令。**不要提交**（已在 .gitignore）。\nKVVI_INTERNAL_TOKEN=%s\nKVVI_PLATFORM_DB_PASSWORD=%s\nKVVI_BUSINESS_DB_PASSWORD=%s\nKVVI_AUDIT_DB_PASSWORD=%s\nKVVI_AUDIT_READ_DB_PASSWORD=%s\n' \
    "$(rand)" "$(rand)" "$(rand)" "$(rand)" "$(rand)" > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
fi

# ── 补齐缺失的键，而不是「文件在就跳过」 ─────────────────────────────────
#
# 只判「文件存不存在」是不够的：一个**存在但缺键**的文件会让 compose 报
# `required variable KVVI_PLATFORM_DB_PASSWORD is missing a value`。
# 那条报错说的是「配置缺失」，读起来却像「部署坏了」——
# 本项目就撞上过这个形态（文件里只有 KVVI_INTERNAL_TOKEN）。
#
# ⚠️ 补进去的是**新值**。若同名数据卷**已经存在**，库里的口令是旧值，
# 新值会让平台进程连不上库（表现为认证失败，而不是「口令不对」）。
# 这种情况**不能猜**，必须让人决定：要么找回旧口令，要么清卷重建。
MISSING_KEYS=""
for key in KVVI_INTERNAL_TOKEN KVVI_PLATFORM_DB_PASSWORD \
           KVVI_BUSINESS_DB_PASSWORD KVVI_AUDIT_DB_PASSWORD \
           KVVI_AUDIT_READ_DB_PASSWORD; do
  if ! grep -q "^${key}=" "$ENV_FILE"; then
    printf '%s=%s\n' "$key" "$(rand)" >> "$ENV_FILE"
    say "补齐缺失的 ${key}（新值）"
    MISSING_KEYS="${MISSING_KEYS} ${key}"
  fi
done

if [ -n "$MISSING_KEYS" ] && [ "$MODE" != "down" ] && [ "$MODE" != "status" ]; then
  if docker volume ls -q 2>/dev/null | grep -q 'platform-db-data'; then
    printf '\n\033[31m✗ 同名数据卷已存在，但本次补了新的库口令。\033[0m\n' >&2
    printf '  卷里的口令是旧的，新口令连不上 —— 表现为认证失败，不是「代码坏了」。两条路：\n' >&2
    printf '    1) 找回旧口令填回 %s（推荐：不动数据）\n' "$ENV_FILE" >&2
    printf '    2) 确认数据可弃，清卷重建：%s --reset-volumes\n' "$0" >&2
    exit 1
  fi
fi

# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a
[ -n "${KVVI_INTERNAL_TOKEN:-}" ] || die "$ENV_FILE 里没有 KVVI_INTERNAL_TOKEN"

# ⚠️ 用 `-f` 会**关掉** docker compose 对 `docker-compose.override.yml` 的自动合并
# —— 自动合并只发生在「不带任何 -f、直接用默认文件名」时。
# 所以这里显式带上：存在就叠加，不存在就照旧。
#
# 那个覆盖层是**本地开发专用**（补开发签名密钥），交付的
# `docker-compose.kvvi.yml` 一个字符都不改；部署到真实环境时不应带它。
dc() {
  if [ -f "$ROOT/docker-compose.override.yml" ]; then
    docker compose -f "$COMPOSE_FILE" -f "$ROOT/docker-compose.override.yml" \
      --env-file "$ENV_FILE" "$@"
  else
    docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
  fi
}

case "$MODE" in
  down)
    say "停止并移除…"; dc down; ok "已停止"; exit 0 ;;
  status)
    dc ps; exit 0 ;;
  reset-volumes)
    say "清掉本项目的容器与**数据卷**…"
    dc down -v
    ok "已清空（下一次 up 会从零建库）"
    exit 0 ;;
  seed-dev)
    # 建开发演示账号。**空库里没有账号时 `/auth/login` 一律回
    # KVVI_BAD_CREDENTIALS** —— 那看起来像「登录坏了」，其实是没有账号，
    # 而本仓库此前没有任何一条「怎么造一个账号」的路径。
    #
    # 走 migrate 服务跑：同一个镜像、同一份 pg 依赖，
    # 于是 `hashPassword` 只有一份实现（抄一份迟早漂移）。
    say "创建开发演示账号…"
    dc run --rm --no-deps --build migrate node dev/seed-dev.mjs
    exit $? ;;
esac

if [ "$MODE" = "rebuild" ]; then
  say "重新构建镜像…"
  dc build
fi

say "启动（等待健康检查，最长 240 秒）…"
# ⚠️ **默认带上 --build**，不是只在 --rebuild 时才构建。
#
# 不带 --build 时，改了 `services/platform/src/**` 却照常 `up`，
# compose 会认为镜像已存在、直接复用**旧镜像** ——
# 于是你改的代码一行都没跑，而症状是业务报错（如登录回 KVVI_BAD_GATEWAY），
# 看着完全像代码 bug。这个坑本会话真实踩过一次：
# 容器里的 migrate.mjs 是 114 行的旧版，主机上已经是 155 行。
#
# --build 在无变化时很快（全部命中缓存），远低于排查一次这种问题的时间。
#
# --wait 等的就是 Dockerfile 里的 HEALTHCHECK，不是容器 Running。
dc up -d --build --wait --wait-timeout 240 || {
  printf '\n\033[31m✗ 健康检查未通过。日志：\033[0m\n'
  dc ps
  dc logs --tail=40
  exit 1
}

printf '\n'
dc ps
printf '\n'
# 把**能点开的地址**打出来，而不是让人自己去翻日志。
#
# 界面走的是运行时进程的 DSH web，它有一道 token 鉴权栅栏；token 只在运行时
# 启动时打印一次，落在容器日志里。此前本脚本只打 healthz ——
# 那是**取证地址**，不是**入口地址**，照着它点开机只能看到一行 401。
#
# 首次访问带 `?token=` 会换成 Cookie 并 303 跳回 `/`，之后正常刷新即可。
ACCESS_URL="$(dc logs runtime 2>/dev/null \
  | grep -o 'http://127\.0\.0\.1:[0-9]*/?token=[A-Za-z0-9_-]*' \
  | tail -1 || true)"
# 容器内打印的是它自己的回环地址，宿主机要走映射出来的端口。
if [ -n "$ACCESS_URL" ]; then
  ACCESS_URL="$(printf '%s' "$ACCESS_URL" \
    | sed "s#http://127.0.0.1:[0-9]*/#http://127.0.0.1:${KVVI_PLATFORM_PORT:-7400}/#")"
fi

ok "两进程骨架已就绪"
if [ -n "$ACCESS_URL" ]; then
  printf '  \033[1m界面入口\033[0m      \033[36m%s\033[0m\n' "$ACCESS_URL"
  printf '                （首次访问会把 token 换成 Cookie，之后直接开 http://127.0.0.1:%s/ 即可）\n' "${KVVI_PLATFORM_PORT:-7400}"
else
  printf '  \033[33m⚠\033[0m 没从运行时日志里取到界面地址。手动取：\n'
  printf '      %s logs runtime | grep -o "http://[^ ]*token=[A-Za-z0-9_-]*"\n' "$0"
fi
printf '  平台服务进程  http://127.0.0.1:%s/healthz   （pluginsReady 应为 0）\n' "${KVVI_PLATFORM_PORT:-7400}"
printf '  平台服务进程  http://127.0.0.1:%s/topology  （运行期证据，无需凭据）\n' "${KVVI_PLATFORM_PORT:-7400}"
printf '  Agent 运行时  仅在容器网络内（未映射宿主端口；界面经平台进程转发）\n'
printf '\n  取证：python3 工具/check_topology.py\n'
printf '  停止：%s --down\n' "$0"
