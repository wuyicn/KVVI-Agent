#!/bin/bash
# 执行。**必须显式带 --confirm。**
#
# ⚠️ 这个判据写在脚本里，不写在 Skill 的文字里。
#    文字是给模型看的，脚本是被执行的 —— 两者都要有，
#    而「模型忘了确认」这件事只能由脚本挡。
set -eu
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

CONFIRMED=0
ACTION=''
RESTORE_ARCHIVE=''
START_AFTER=0

for arg in "$@"; do
  case "$arg" in
    --confirm)   CONFIRMED=1 ;;
    --start)     START_AFTER=1 ;;
    --backup)    ACTION='backup' ;;
    --uninstall) ACTION='uninstall' ;;
    --restore)   ACTION='restore' ;;
    *)           RESTORE_ARCHIVE="$arg" ;;
  esac
done

if [ "$CONFIRMED" -ne 1 ]; then
  printf '拒绝执行：缺少 --confirm。\n' >&2
  printf '任何会改动机器的动作都需要用户明确同意。先给他看 plan.sh 的输出，\n' >&2
  printf '他同意之后再加 --confirm 重跑。\n' >&2
  exit 1
fi

case "$ACTION" in
  backup)    run_admin backup --yes ;;
  uninstall) run_admin uninstall --yes ;;
  restore)
    [ -n "$RESTORE_ARCHIVE" ] || {
      printf '用法：apply.sh --confirm --restore <备份包>\n' >&2; exit 1; }
    run_admin restore "$RESTORE_ARCHIVE" --yes
    ;;
  *)
    run_admin install --apply --yes
    if [ "$START_AFTER" -eq 1 ]; then
      run_admin start --apply --yes
    fi
    ;;
esac
