#!/usr/bin/env bash
# 0C-8 判定器的反向测试。
#
# 为什么必须做：本判定器是 G3 门禁的核心证据，而「判定器」这类工具最容易
# 退化成**恒真**或**恒假** —— 两种都表现为「跑得通、有输出」。
# 本测试直接验证它**在同一个组织模型上能同时给出成立与拒绝两种结论**：
# 只会输出一种结论的判定器不是判定器。
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INV=(python3 "$ROOT/工具/check_invariant.py")

pass=0; fail=0
T() {
  if [ "$2" = "$3" ]; then printf '  \033[32m✓\033[0m %-44s %s\n' "$1" "$3"; pass=$((pass+1))
  else printf '  \033[31m✗\033[0m %-44s 得到 %s，期望 %s\033[0m\n' "$1" "$3" "$2"; fail=$((fail+1)); fi
}

echo "=== 0C-8 判定器反向测试 ==="

echo
echo "[1] 全部用例与预期一致"
"${INV[@]}" >/dev/null 2>&1; T "12 个用例全过 → 退出码 0" 0 $?

echo
echo "[2] 判定器**不是恒真**：存在被判违反的用例"
n=$("${INV[@]}" 2>/dev/null | grep -c "判定=拒绝" || true)
if [ "$n" -ge 5 ]; then echo "  ✓ 判出拒绝 $n 例（≥5）"; pass=$((pass+1))
else echo "  ✗ 只判出拒绝 $n 例 —— 疑似恒真"; fail=$((fail+1)); fi

echo
echo "[3] 判定器**不是恒假**：存在被判成立的用例"
m=$("${INV[@]}" 2>/dev/null | grep -c "判定=成立" || true)
if [ "$m" -ge 5 ]; then echo "  ✓ 判出成立 $m 例（≥5）"; pass=$((pass+1))
else echo "  ✗ 只判出成立 $m 例 —— 疑似恒假"; fail=$((fail+1)); fi

echo
echo "[4] 判定区分层次：L1（口径可用性）与 L3（注入一致性）都出现过"
l1=$("${INV[@]}" 2>/dev/null | grep -c "［L1］" || true)
l3=$("${INV[@]}" 2>/dev/null | grep -c "［L3］" || true)
if [ "$l1" -ge 1 ] && [ "$l3" -ge 2 ]; then
  echo "  ✓ L1 命中 $l1 例，L3 命中 $l3 例"; pass=$((pass+1))
else echo "  ✗ L1=$l1 L3=$l3 —— 分层未生效"; fail=$((fail+1)); fi

echo
echo "[5] 关键性质：**去掉注入**必须被检出"
# 这正是 §9.8.1 攻击成立的条件，也是本判定器存在的理由。
python3 - <<'PY'
import sys
sys.path.insert(0, '工具')
import importlib.util
spec = importlib.util.spec_from_file_location('inv', '工具/check_invariant.py')
inv = importlib.util.module_from_spec(spec); spec.loader.exec_module(inv)
org = inv._org()
bad = inv.check(org, 'x', [inv.STORE], {'tenant': 't1', 'shop': 'store-1'}, None)
good = inv.check(org, 'x', [inv.STORE], {'tenant': 't1', 'shop': 'store-1'}, [inv.STORE])
sys.exit(0 if (bad['ok'] is False and bad['layer'] == 'L3' and good['ok'] is True) else 1)
PY
T "未注入被拒 / 正确注入被接受" 0 $?

echo
printf '小计：\033[32m%d 通过\033[0m' "$pass"
[ "$fail" -gt 0 ] && printf '，\033[31m%d 失败\033[0m' "$fail"
echo
[ "$fail" -eq 0 ] || exit 1
