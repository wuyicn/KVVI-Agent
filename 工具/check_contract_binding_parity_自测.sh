#!/usr/bin/env bash
# 契约装订对拍闸的反例自测：把两侧**真的弄成不一致**，闸门必须报红。
#
# 一个只会在正确代码上报绿的闸门，和一个永远 return 0 的脚本没有区别。
# 这里逐个翻车方式各来一次，每一条都要看到闸门变红才算数。
#
# ⚠️ 自测自己也会骗人：第一版里扰动函数的参数用了 NUL 分隔，而 shell 变量存不了
#    NUL —— 三次扰动全解析失败，`&&` 短路又把三条反例**静默跳过**，最后报「0 项失败」。
#    所以这里每一条反例都走 `expect_red`，扰动失败一律记 FAIL，不再短路。
#
# 用法：bash 工具/check_contract_binding_parity_自测.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
GATE="$HERE/check_contract_binding_parity.py"
TS="$ROOT/vendor/dsh/packages/tool/kvvi-publish/src/index.ts"
HARNESS="$HERE/lib/契约装订对拍.mjs"
BACKUP="$(mktemp -d)"
export PATH="$HOME/.local/opt/node-v24.20.0/bin:$PATH"

cp "$TS" "$BACKUP/index.ts"
cp "$HARNESS" "$BACKUP/契约装订对拍.mjs"

restore() {
  cp "$BACKUP/index.ts" "$TS"
  cp "$BACKUP/契约装订对拍.mjs" "$HARNESS"
  rm -rf "$BACKUP"
}
trap restore EXIT

PASS=0
FAIL=0

# 把 TS 侧的一处文字换掉。换到 **1 次**才算扰动成功；0 次或多次都返回非 0，
# 由调用方记成失败 —— 扰动没生效时后面的「闸门没红」是无意义的。
perturb() {
  python3 - "$1" "$2" "$3" <<'PY'
import sys
from pathlib import Path
path, old, new = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
text = path.read_text(encoding='utf-8')
count = text.count(old)
if count != 1:
    print('  扰动源出现 %d 次（要求正好 1 次）' % count, file=sys.stderr)
    sys.exit(9)
path.write_text(text.replace(old, new), encoding='utf-8')
PY
}

# 跑一次闸门，期望它是红的（任何非 0 都算红，2 也说明闸门没被骗成绿）
expect_red() {
  local name="$1" want="$2"
  local out rc
  out="$(python3 "$GATE" 2>&1)"; rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "  ✗ $name —— 闸门报绿了，这条翻车方式没被挡住"
    FAIL=$((FAIL + 1))
  elif [ -n "$want" ] && ! printf '%s' "$out" | grep -q "$want"; then
    echo "  ✗ $name —— 红了，但红的地方不对（没看到「$want」）"
    printf '%s\n' "$out" | tail -6 | sed 's/^/      /'
    FAIL=$((FAIL + 1))
  else
    echo "  ✓ $name —— 闸门红了（退出码 $rc）"
    PASS=$((PASS + 1))
  fi
}

# 扰动 + 跑闸门 + 还原。扰动失败直接记 FAIL，不短路。
case_red() {
  local name="$1" want="$2" old="$3" new="$4"
  if ! perturb "$TS" "$old" "$new"; then
    echo "  ✗ $name —— 扰动没生效，这条反例无效"
    FAIL=$((FAIL + 1))
    cp "$BACKUP/index.ts" "$TS"
    return
  fi
  expect_red "$name" "$want"
  cp "$BACKUP/index.ts" "$TS"
}

echo "=== 有修复时：闸门应当是绿的 ==="
out="$(python3 "$GATE" 2>&1)"; rc=$?
if [ "$rc" -eq 0 ]; then
  echo "  ✓ 基线绿"; PASS=$((PASS + 1))
else
  echo "  ✗ 基线就是红的 —— 后面的反例没有意义"; printf '%s\n' "$out" | tail -8 | sed 's/^/      /'
  FAIL=$((FAIL + 1))
fi
echo

echo "=== 反例（每一条都必须让闸门变红）==="

# ① 两侧对「整目录跳过」判据分岔：工具侧不再跳过 schemas/
case_red \
  "① 工具侧不再跳过 schemas/（skipped 分岔）" "不一致" \
  "$(cat <<'OLD'
  if (entry === 'schemas') {
    return '工具契约引用的请求/响应体片段，它们本身不是契约'
  }
OLD
)" "  // 扰动：工具侧不再跳过 schemas/"

# ② 两侧对「认出哪些文件」分岔：工具侧丢掉 view-schema 的认法
case_red \
  "② 工具侧认不出 view-schema（candidates 分岔）" "不一致" \
  "  ['view-schema', 'view-schema']," "  // 扰动：工具侧认不出 view-schema"

# ③ 一侧跳过却不说：工具侧不再把跳过的目录写进注记
case_red \
  "③ 工具侧跳过却不在注记里说（漏报）" "漏报" \
  "$(cat <<'OLD'
    notes.push(`⚠ 整目录跳过：${dir.path}（${String(dir.files)} 个 .json）`
      + ` —— ${dir.reason}`)
OLD
)" "    // 扰动：跳过了但不说"

# ④ 扫描面塌了：对拍脚本没了 —— 必须是「无法执行」（2），不能当成通过
echo "--- ④ 对拍脚本缺失（无法执行）"
mv "$HARNESS" "$BACKUP/hidden.mjs"
expect_red "④ 对拍脚本缺失（无法执行）" "找不到对拍脚本"
cp "$BACKUP/契约装订对拍.mjs" "$HARNESS"

echo
echo "=== 自测结果：$PASS 项通过 / $FAIL 项失败 ==="
[ "$FAIL" -eq 0 ] || exit 1
