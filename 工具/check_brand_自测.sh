#!/usr/bin/env bash
# 品牌残留检查器的反向测试 —— 证明它在该红的时候真的会红。
#
# 为什么必须做：本项目已多次出现「工具报绿、实际不对」。一个从没失败过的
# 校验器不是证据；而且本检查器第一版就有过载体切分不互斥、重复计数的缺陷。
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DSH="$ROOT/vendor/dsh"
CHECK=(python3 "$ROOT/工具/check_brand.py")

MAN="$DSH/apps/web/public/manifest.webmanifest"
LOC="$DSH/packages/client/ui-plugin-manager/src/client/locales.ts"

TMP="$(mktemp -d)"
cp "$MAN" "$TMP/man"; cp "$LOC" "$TMP/loc"
restore() { cp "$TMP/man" "$MAN"; cp "$TMP/loc" "$LOC"; rm -rf "$TMP"; }
trap restore EXIT

pass=0; fail=0
T() {
  if [ "$2" = "$3" ]; then printf '  \033[32m✓\033[0m %-38s 退出码 %s（期望 %s）\n' "$1" "$3" "$2"; pass=$((pass+1))
  else printf '  \033[31m✗\033[0m %-38s 退出码 %s（期望 %s）\033[0m\n' "$1" "$3" "$2"; fail=$((fail+1)); fi
}

echo "=== 品牌残留检查器反向测试 ==="

echo
echo "[1] 当前干净状态"
"${CHECK[@]}" >/dev/null 2>&1; T "无残留 → 绿" 0 $?

echo
echo "[2] manifest 的 name 改回上游品牌"
python3 -c "
import json,io
d=json.load(io.open('$MAN',encoding='utf-8')); d['name']='DeepSeek Harness'
io.open('$MAN','w',encoding='utf-8').write(json.dumps(d,ensure_ascii=False,indent=2)+'\n')"
"${CHECK[@]}" >/dev/null 2>&1; T "manifest name 残留 → 红" 1 $?
cp "$TMP/man" "$MAN"

echo
echo "[3] manifest 的 short_name 改回 DSH"
python3 -c "
import json,io
d=json.load(io.open('$MAN',encoding='utf-8')); d['short_name']='DSH'
io.open('$MAN','w',encoding='utf-8').write(json.dumps(d,ensure_ascii=False,indent=2)+'\n')"
"${CHECK[@]}" >/dev/null 2>&1; T "short_name 残留 → 红" 1 $?
cp "$TMP/man" "$MAN"

echo
echo "[4] locale 文案里重新引入上游产品名"
python3 -c "
import io
p='$LOC'; s=io.open(p,encoding='utf-8').read()
io.open(p,'w',encoding='utf-8').write(s.replace('损坏本系统','损坏 DeepSeek Harness',1))"
"${CHECK[@]}" >/dev/null 2>&1; T "locale 残留 → 红" 1 $?
cp "$TMP/loc" "$LOC"

echo
echo "[5] 恢复后应重新变绿"
"${CHECK[@]}" >/dev/null 2>&1; T "恢复干净 → 绿" 0 $?

echo
printf '小计：\033[32m%d 通过\033[0m' "$pass"
[ "$fail" -gt 0 ] && printf '，\033[31m%d 失败\033[0m' "$fail"
echo
[ "$fail" -eq 0 ] || exit 1
