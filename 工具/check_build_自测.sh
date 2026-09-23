#!/usr/bin/env bash
# 构建配置检查器的反向测试。
#
# 为什么必须做：本检查器的第一版判据就是错的 —— 它把**正确的构建期折叠**
# 当成了错误，报了假红；而我又被一次 grep 匹配失败误导，得出了相反结论。
# 工具报红/报绿都必须先证明它在该红时会红。
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SH_FILE="$ROOT/scripts/kvvi-web.sh"
REC="$ROOT/vendor/dsh/.dsh-build/client-build-environment.json"
BUNDLE="$ROOT/vendor/dsh/packages/client/ui-brand-official/lib/client.js"
CHECK=(python3 "$ROOT/工具/check_build.py")

TMP="$(mktemp -d)"
cp "$SH_FILE" "$TMP/sh"; cp "$REC" "$TMP/rec"; cp "$BUNDLE" "$TMP/bundle"
restore() { cp "$TMP/sh" "$SH_FILE"; cp "$TMP/rec" "$REC"; cp "$TMP/bundle" "$BUNDLE"; rm -rf "$TMP"; }
trap restore EXIT

pass=0; fail=0
T() {
  if [ "$2" = "$3" ]; then printf '  \033[32m✓\033[0m %-40s 退出码 %s（期望 %s）\n' "$1" "$3" "$2"; pass=$((pass+1))
  else printf '  \033[31m✗\033[0m %-40s 退出码 %s（期望 %s）\033[0m\n' "$1" "$3" "$2"; fail=$((fail+1)); fi
}

echo "=== 构建配置检查器反向测试 ==="

echo
echo "[1] 当前正确状态"
"${CHECK[@]}" >/dev/null 2>&1; T "配置正确 → 绿" 0 $?

echo
echo "[2] 启动脚本把 profile 设回 official"
sed -i '' 's|( cd "\$DSH_SRC" \&\& DSH_CLIENT_TITLE=|( cd "$DSH_SRC" \&\& DSH_CLIENT_BUILD_PROFILE=official DSH_CLIENT_TITLE=|' "$SH_FILE"
"${CHECK[@]}" >/dev/null 2>&1; T "启动脚本设 official → 红" 1 $?
cp "$TMP/sh" "$SH_FILE"

echo
echo "[3] 构建记录里出现 official"
python3 -c "
import json
p='$REC'; d=json.load(open(p))
d['environment']['DSH_CLIENT_BUILD_PROFILE']='official'
json.dump(d, open(p,'w'), ensure_ascii=False, indent=2)"
"${CHECK[@]}" >/dev/null 2>&1; T "记录含 official → 红" 1 $?
cp "$TMP/rec" "$REC"

echo
echo "[4] 产物残留 process.env 读取（构建期没定死）"
printf 'function apply(ctx) {\n  if (process.env.DSH_CLIENT_BUILD_PROFILE !== "official") return;\n  ctx.slots.inject("sidebar.brand.mark", () => {});\n}\n' > "$BUNDLE"
"${CHECK[@]}" >/dev/null 2>&1; T "产物残留 process.env → 红" 1 $?
cp "$TMP/bundle" "$BUNDLE"

echo
echo "[5] 产物里门控整段消失（变量被嵌成 official）"
printf 'function apply(ctx) {\n  ctx.slots.inject("sidebar.brand.mark", () => {});\n}\n' > "$BUNDLE"
"${CHECK[@]}" >/dev/null 2>&1; T "门控消失 → 红" 1 $?
cp "$TMP/bundle" "$BUNDLE"

echo
echo "[6] 恢复后应重新变绿"
"${CHECK[@]}" >/dev/null 2>&1; T "恢复正确配置 → 绿" 0 $?

echo
printf '小计：\033[32m%d 通过\033[0m' "$pass"
[ "$fail" -gt 0 ] && printf '，\033[31m%d 失败\033[0m' "$fail"
echo
[ "$fail" -eq 0 ] || exit 1
