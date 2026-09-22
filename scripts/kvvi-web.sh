#!/usr/bin/env bash
#
# 从源码启动 KVVI Agent（搭建引擎）。
#
# KVVI 住在 vendor/dsh 这份源码里，不走发行版。因此本脚本：
#   * 用源码树里的 CLI 启动，而不是全局安装的 dsh
#   * 用一个独立的 DSH_HOME（.kvvi-home/），与你的 ~/.dsh 完全隔离
#   * 首次运行时自动创建 kvvi profile
#
# 用法：
#   ./scripts/kvvi-web.sh                 # 启动（构建产物缺失时才构建）
#   ./scripts/kvvi-web.sh --rebuild       # 强制重新构建后启动
#   ./scripts/kvvi-web.sh --port 7300     # 指定端口
#   ./scripts/kvvi-web.sh --help
#
set -euo pipefail

# ── 路径 ──────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
DSH_SRC="$PROJECT_ROOT/vendor/dsh"
KVVI_HOME="$PROJECT_ROOT/.kvvi-home"
PROFILE_NAME="kvvi"

# ── 参数 ──────────────────────────────────────────────────────────────
PORT="7200"
REBUILD=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --rebuild) REBUILD=1; shift ;;
    --port)
      [[ -n "${2:-}" ]] || { echo "--port 需要一个端口号" >&2; exit 2; }
      PORT="$2"; shift 2 ;;
    --help|-h)
      sed -n '3,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *)
      echo "未知参数：$1（用 --help 看用法）" >&2; exit 2 ;;
  esac
done

say() { printf '\033[36m▸\033[0m %s\n' "$*"; }
die() { printf '\033[31m✖\033[0m %s\n' "$*" >&2; exit 1; }

# ── 1. 源码树就位？ ───────────────────────────────────────────────────
[[ -d "$DSH_SRC" ]] || die "找不到源码树：$DSH_SRC
  vendor/dsh 被 .gitignore 排除，需要重新克隆：
    git clone --depth 1 https://github.com/deepseek-ai/deepseek-harness.git vendor/dsh"

# ── 2. 选定 Node ──────────────────────────────────────────────────────
# native 模块（darwin-arm64/system.node）的构建脚本按
# <execPath>/../include/node 推导头文件路径，因此**必须**用带 headers 的
# 完整 Node 发行版；IDE 或运行时自带的 Node 通常不含 headers，会在
# 原生模块编译阶段失败。这里优先使用已知完整的版本。
NODE_BIN=""
for candidate in \
  "$HOME/.local/opt/node-v24.20.0/bin/node" \
  "$(command -v node 2>/dev/null || true)"
do
  [[ -n "$candidate" && -x "$candidate" ]] || continue
  headers="$(dirname "$candidate")/../include/node/node_api.h"
  if [[ -f "$headers" ]]; then NODE_BIN="$candidate"; break; fi
done
[[ -n "$NODE_BIN" ]] || die "找不到带 include/node/ headers 的 Node。
  构建 native 模块需要它。可安装官方发行版：
    https://nodejs.org/dist/  （解压到 ~/.local/opt/ 即可）"

NODE_DIR="$(dirname "$NODE_BIN")"
export PATH="$NODE_DIR:$PATH"
say "Node：$("$NODE_BIN" --version)（含 headers）"

# ── 3. 依赖与构建 ─────────────────────────────────────────────────────
BUILD_MARK="$DSH_SRC/apps/web/dist/index.html"
if [[ ! -d "$DSH_SRC/node_modules" ]]; then
  say "安装依赖（首次运行，约 5 分钟）…"
  ( cd "$DSH_SRC" && pnpm install --no-frozen-lockfile )
fi

if [[ "$REBUILD" == "1" || ! -f "$BUILD_MARK" ]]; then
  if [[ "$REBUILD" == "1" ]]; then say "重新构建…"; else say "构建产物缺失，开始构建…"; fi
  # 品牌由 build-time 环境变量注入：DSH_CLIENT_TITLE 决定产品名，
  # DSH_CLIENT_BUILD_PROFILE 决定上游官方品牌是否占用插槽
  #（不设 official，KVVI 的 kvvi-brand 插件才能拿到那两个插槽）。
  ( cd "$DSH_SRC" && DSH_CLIENT_BUILD_PROFILE=official \
      DSH_CLIENT_TITLE="KVVI 搭建引擎" pnpm build )
  say "构建完成"
fi

# ── 4. 独立的 DSH_HOME 与 profile ─────────────────────────────────────
mkdir -p "$KVVI_HOME/profiles/$PROFILE_NAME"
PROFILE_JSON="$KVVI_HOME/profiles/$PROFILE_NAME/package.json"
if [[ ! -f "$PROFILE_JSON" ]]; then
  cat > "$PROFILE_JSON" << 'JSON'
{
  "name": "dsh-profile-kvvi",
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
  say "已创建 KVVI profile：$PROFILE_NAME"
fi
say "DSH_HOME：$KVVI_HOME（与 ~/.dsh 隔离）"

# ── 5. 启动 ───────────────────────────────────────────────────────────
say "启动 KVVI Agent，端口 $PORT"
say "预设：kvvi-builder（搭建引擎模式）/ kvvi-worker（工作模式）"
echo
cd "$DSH_SRC"
exec env DSH_HOME="$KVVI_HOME" "$NODE_BIN" apps/cli/lib/bin.js \
  --profile "$PROFILE_NAME" --port "$PORT"
