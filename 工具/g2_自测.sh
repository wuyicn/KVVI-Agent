#!/usr/bin/env bash
# G2 校验器的反向测试 —— 证明它真的会红。
#
# 为什么需要：一个从没失败过的校验器不是证据。
# 本项目已连续四次出现「工具报绿、实际不对」（v2.11/2.12/2.13/2.16 的假绿），
# 所以每个校验器都必须先证明它在**应该红的时候会红**。
#
# 用法：bash 工具/g2_自测.sh      （会临时改动 vendor/dsh，结束时自动恢复）
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DSH="$ROOT/vendor/dsh"
REG="$ROOT/forks/dsh/改造点清单.md"
CHECK=(python3 "$ROOT/工具/g2_改造点.py" --check)

# ⚠️ 守卫必须在 `trap ... EXIT` **之前**。
#
# 本测试靠 `git reset --hard` / `git clean -fd` 撤销自己制造的探针改动，
# 而这两个命令**不区分「探针改动」与「你自己的未提交改动」** —— 一起删。
#
# 已经发生过两次：一份写了两百多行的 SKILL.md 被这里的 restore 抹掉。
# 第一次修的时候把守卫放在了 trap **之后** —— 于是 `exit 2` 照样触发 EXIT trap，
# 照样 `reset --hard`，**守卫形同虚设**。这正是它要防的那类错误：
# 一个看起来在场、实际不生效的检查。
if [ -n "$(git -C "$DSH" status --porcelain)" ]; then
  printf '\033[31m✗ vendor/dsh 工作区不干净 —— 拒绝运行\033[0m\n'
  echo "  本自测会执行 git reset --hard 与 git clean -fd，"
  echo "  **会删掉你尚未提交的改动**（不只是它自己的探针）。"
  echo "  先提交或 git stash，再跑。当前改动："
  git -C "$DSH" status --short
  exit 2
fi

HEAD0="$(git -C "$DSH" rev-parse HEAD)"
RESULT="$(mktemp)"
cp "$REG" "$RESULT"
restore() { git -C "$DSH" reset -q --hard "$HEAD0"; git -C "$DSH" clean -qfd; cp "$RESULT" "$REG"; rm -f "$RESULT"; }
trap restore EXIT

pass=0; fail=0
T() {  # T <用例名> <期望退出码> <实际退出码>
  if [ "$2" = "$3" ]; then printf '  \033[32m✓\033[0m %-42s 退出码 %s（期望 %s）\n' "$1" "$3" "$2"; pass=$((pass+1))
  else printf '  \033[31m✗\033[0m %-42s 退出码 %s（期望 %s）\033[0m\n' "$1" "$3" "$2"; fail=$((fail+1)); fi
}

echo "=== G2 校验器反向测试 ==="

echo
echo "[1] 干净状态"
"${CHECK[@]}" >/dev/null 2>&1; T "无任何改动 → 通过" 0 $?

echo
echo "[2] 改了文件但没提交"
echo "// x" >> "$DSH/packages/bundle/kvvi-app/src/index.ts"
"${CHECK[@]}" >/dev/null 2>&1; T "已修改未提交 → 红" 1 $?
git -C "$DSH" checkout -q -- .

echo
echo "[3] 加了新文件但没提交（untracked）"
echo "// 新文件" > "$DSH/packages/bundle/kvvi-app/src/ghost.ts"
"${CHECK[@]}" >/dev/null 2>&1; T "新文件未提交 → 红" 1 $?
git -C "$DSH" clean -qfd

echo
echo "[4] 提交了一处未登记的改动"
echo "// 未登记" > "$DSH/UNREGISTERED-PROBE.md"
git -C "$DSH" add UNREGISTERED-PROBE.md
git -C "$DSH" -c core.hooksPath=/dev/null commit -q -m "probe: 未登记改动"
"${CHECK[@]}" >/dev/null 2>&1; T "已提交但未登记 → 红" 1 $?
git -C "$DSH" reset -q --hard "$HEAD0"

echo
echo "[5] 清单里的文件数与代码不符"
sed -i '' 's|kvvi-builder/`（8 个文件）|kvvi-builder/`（9 个文件）|' "$REG"
"${CHECK[@]}" >/dev/null 2>&1; T "数字写错 → 红" 1 $?
cp "$RESULT" "$REG"

echo
echo "[6] 登记了一个代码里不存在的路径"
sed -i '' 's|`tsconfig.host.json`（1 个文件，+1 行）|`tsconfig.ghost.json`（1 个文件，+1 行）|' "$REG"
"${CHECK[@]}" >/dev/null 2>&1; T "登记失效 → 红" 1 $?
cp "$RESULT" "$REG"

echo
echo "[7] 篡改 fork 里一个已登记文件（指纹校验）"
V=(python3 "$ROOT/工具/g2_改造点.py" --verify-manifest)
echo "// 篡改" >> "$DSH/packages/client/kvvi-brand/src/index.ts"
"${V[@]}" >/dev/null 2>&1; T "内容偏离登记 → 红" 1 $?
git -C "$DSH" checkout -q -- .

echo
echo "[8] 撤销后指纹恢复"
"${V[@]}" >/dev/null 2>&1; T "指纹恢复相符 → 通过" 0 $?

echo
echo "[9] 全部撤销后恢复绿"
"${CHECK[@]}" >/dev/null 2>&1; T "恢复干净 → 通过" 0 $?

echo
printf '小计：\033[32m%d 通过\033[0m' "$pass"
[ "$fail" -gt 0 ] && printf '，\033[31m%d 失败\033[0m' "$fail"
echo
[ "$fail" -eq 0 ] || exit 1
