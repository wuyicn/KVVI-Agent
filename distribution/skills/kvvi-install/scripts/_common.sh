#!/bin/bash
# 三个包装脚本共用的一小段。**不叫它 lib 也不叫它 helper** ——
# 它是一个被显式 source 的文件，名字说明这一点就够了。
set -eu

# `distribution/` 目录：本文件在 distribution/skills/kvvi-install/scripts/ 下，
# 往上三层就是 distribution/。
#
# ⚠️ 第一版把它当成「发行版根目录」，于是往它下面又接了一次 `distribution/` ——
# 得到 `.../distribution/distribution/bin/kvvi-admin`，脚本一律报「找不到安装器」。
# **根与 distribution 是两层，不是一层**；`install.release_root_path()` 那边
# 同样为这件事吃过一次亏。
KVVI_DISTRIBUTION="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
KVVI_ADMIN="$KVVI_DISTRIBUTION/bin/kvvi-admin"

if [ ! -f "$KVVI_ADMIN" ]; then
  printf '找不到安装器：%s\n' "$KVVI_ADMIN" >&2
  printf '本脚本必须在解包出来的发行版目录里运行。\n' >&2
  exit 1
fi

# 配置文件：由 KVVI_CONFIG 指定（没有就不传）。
#
# ⚠️ **macOS 自带的 bash 是 3.2**，而它有两个坑叠在这里：
#
#   1. `set -u` 下展开**空数组**直接报 `unbound variable` ——
#      本脚本第一版就是 `KVVI_CONFIG_ARGS=()` 配 `${KVVI_CONFIG_ARGS[@]}`，
#      于是**不带 KVVI_CONFIG 时全部三个脚本都跑不起来**，
#      而带上配置反而正常。这种「有参数能用、没参数不能」最难查。
#   2. `${a[@]+"${a[@]}"}` 是 3.2 与 4+ **都**安全的写法：
#      数组未定义或为空时展开成空，非空时正常展开。
#
# 不改成 `--config ""` 那种绕法：那会把「我没有配置」变成一个空路径参数，
# 让下游去处理一个它不该看到的值。
KVVI_CONFIG_ARGS=()
if [ -n "${KVVI_CONFIG:-}" ]; then
  KVVI_CONFIG_ARGS=(--config "$KVVI_CONFIG")
fi

# 三处调用统一走它，**不要**在别处直接写 `${KVVI_CONFIG_ARGS[@]}`。
#
# ⚠️ 也别想着用 `$(config_args)` 那种「命令替换 + 词拆分」的绕法：
#    默认主目录是 `~/Library/Application Support/KVVI-Agent`，**路径里有空格**，
#    词拆分会把一个路径拆成两个参数。展开必须发生在引号里。
run_admin() {
  python3 "$KVVI_ADMIN" "$@" "${KVVI_CONFIG_ARGS[@]+"${KVVI_CONFIG_ARGS[@]}"}"
}
