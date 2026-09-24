#!/usr/bin/env bash
# `0A-14` 去行业化自查器的反向测试。
#
# 为什么必须做：「扫描关键词」这类检查最容易退化成**恒绿** ——
# 扫描面塌了（没扫到文件）、词表空了（没词可命中）、路径写错了（永远 0 命中），
# 三种都表现为「跑得通、报通过」。本测试要求它在**应该红的时候真的红**，
# 并且在**无法判定的时候报「无法执行」而不是「通过」**。
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHECK=(python3 "$ROOT/工具/check_industry_neutral.py")
PROBE="$ROOT/样例/__industry_probe.md"

pass=0; fail=0
T() {
  if [ "$2" = "$3" ]; then printf '  \033[32m✓\033[0m %-46s 退出码 %s（期望 %s）\n' "$1" "$3" "$2"; pass=$((pass+1))
  else printf '  \033[31m✗\033[0m %-46s 退出码 %s（期望 %s）\033[0m\n' "$1" "$3" "$2"; fail=$((fail+1)); fi
}
cleanup() { rm -f "$PROBE"; }
trap cleanup EXIT

echo '=== `0A-14` 去行业化自查器反向测试 ==='

echo
echo "[1] 真实扫描面"
OUT="$("${CHECK[@]}" 2>&1)"; code=$?
T "当前仓库 → 通过" 0 $code
echo "$OUT" | grep -q "0 处违规" && { echo "  ✓ 负向判据：0 处违规"; pass=$((pass+1)); } \
  || { echo "  ✗ 负向判据未给出结论"; fail=$((fail+1)); }
echo "$OUT" | grep -q "可追加列表" && { echo "  ✓ 正向判据：扩展点存在"; pass=$((pass+1)); } \
  || { echo "  ✗ 正向判据未给出结论"; fail=$((fail+1)); }

echo
echo "[2] 词表非空且规模被打印（否则是「没词可命中」的恒绿）"
n="$(echo "$OUT" | grep -o '词表 [0-9]* 个词' | grep -o '[0-9]*')"
if [ -n "$n" ] && [ "$n" -ge 20 ]; then echo "  ✓ 词表 $n 个词（≥20）"; pass=$((pass+1))
else echo "  ✗ 词表规模异常：'$n'"; fail=$((fail+1)); fi

echo
echo "[3] 往扫描面注入行业词 —— 必须变红"
printf '# 家具行业探针\n\n报货单 与 量尺 是家具行业的词。\n' > "$PROBE"
"${CHECK[@]}" >/dev/null 2>&1; T "注入「报货单」→ 红" 1 $?

echo
echo "[4] 移走探针 —— 必须恢复绿"
rm -f "$PROBE"
"${CHECK[@]}" >/dev/null 2>&1; T "撤掉探针 → 通过" 0 $?

echo
echo "[5] 扫描面塌掉时必须报「无法执行」，不能报「通过」"
EMPTY="$(mktemp -d)"
"${CHECK[@]}" --paths "$EMPTY" >/dev/null 2>&1; T "扫不到文件 → 退出码 2" 2 $?
rmdir "$EMPTY"

echo
echo "[6] 豁免清单不是万能钥匙：无理由的豁免会被判为配置错误"
python3 - "$ROOT" <<'PY'
import importlib.util, sys
root = sys.argv[1]
spec = importlib.util.spec_from_file_location('ind', root + '/工具/check_industry_neutral.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.ALLOWED_MENTIONS[('随便/一个/文件.md', '报货单')] = ''
hits = [{'file': '随便/一个/文件.md', 'word': '报货单', 'allowed': ''}]
problems = m.audit_allowlist(hits)
sys.exit(0 if any('没有理由' in p for p in problems) else 1)
PY
T "空理由的豁免被拒" 0 $?

echo
printf '小计：\033[32m%d 通过\033[0m' "$pass"
[ "$fail" -gt 0 ] && printf '，\033[31m%d 失败\033[0m' "$fail"
echo
[ "$fail" -eq 0 ] || exit 1
