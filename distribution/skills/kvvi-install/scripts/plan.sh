#!/bin/bash
# 只打印将要做什么。**不改动任何东西。**
#
# 用法：plan.sh [--backup|--restore <包>|--uninstall]
set -eu
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

case "${1:---install}" in
  --install)   run_admin install --plan ;;
  --backup)    run_admin backup --plan ;;
  --uninstall) run_admin uninstall --plan ;;
  --restore)
    # 恢复是**覆盖**动作，所以恢复的计划尤其要先给用户看。
    [ $# -ge 2 ] || { printf '用法：plan.sh --restore <备份包>\n' >&2; exit 1; }
    run_admin restore "$2" --plan
    ;;
  *) printf '未知选项：%s\n' "$1" >&2; exit 1 ;;
esac
