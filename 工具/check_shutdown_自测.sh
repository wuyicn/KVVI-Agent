#!/usr/bin/env bash
# 关停判据检查器的反向测试 —— 证明它在该红的时候真的会红。
#
# 为什么必须做：本项目已多次出现「工具报绿、实际不对」。一个从没失败过的
# 校验器不是证据。
#
# 这里挖掉的是**真实文件里的真实片段**，跑完还原。挖的每一条都对应一个
# 具体后果（见 check_shutdown.py 的 MARKERS 表）。
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVER="$ROOT/services/platform/src/server.mjs"
SUP="$ROOT/distribution/lib/supervisor.py"
TEST="$ROOT/distribution/tests/test_supervisor.py"
CHECK=(python3 "$ROOT/工具/check_shutdown.py" --quiet)

TMP="$(mktemp -d)"
cp "$SERVER" "$TMP/server"; cp "$SUP" "$TMP/sup"; cp "$TEST" "$TMP/test"
restore() { cp "$TMP/server" "$SERVER"; cp "$TMP/sup" "$SUP"; cp "$TMP/test" "$TEST"; rm -rf "$TMP"; }
trap restore EXIT

pass=0; fail=0

# T <名称> <期望退出码> <挖改后应满足的条件>
T() {
  local name="$1" want="$2" got
  "${CHECK[@]}" >/dev/null 2>&1; got=$?
  if [ "$got" = "$want" ]; then
    printf '  \033[32m✓\033[0m %s\n' "$name"; pass=$((pass+1))
  else
    printf '  \033[31m✗\033[0m %s（期望退出码 %s，实际 %s）\n' "$name" "$want" "$got"; fail=$((fail+1))
  fi
}

echo "=== 关停判据检查器反向测试 ==="

T "正例：原样 → 通过" 0

# A：硬期限被删 —— 回到「放掉监听然后永远活着」
python3 - "$SERVER" <<'PY'
import sys, pathlib
p = pathlib.Path(sys.argv[1]); t = p.read_text(encoding='utf-8')
assert t.count('hardStop.unref()') == 1
p.write_text(t.replace('hardStop.unref()', '// 被反向测试挖掉'), encoding='utf-8')
PY
T "挖掉 hardStop.unref() → 红" 1
cp "$TMP/server" "$SERVER"
T "恢复后 → 通过" 0

# A：强制关闭被删
python3 - "$SERVER" <<'PY'
import sys, pathlib
p = pathlib.Path(sys.argv[1]); t = p.read_text(encoding='utf-8')
assert t.count('server.closeAllConnections()') == 1
p.write_text(t.replace('server.closeAllConnections()', '// 被反向测试挖掉'), encoding='utf-8')
PY
T "挖掉 closeAllConnections() → 红" 1
cp "$TMP/server" "$SERVER"

# B：SIGKILL 升级被删 —— 就是问题 24 的原样
python3 - "$SUP" <<'PY'
import sys, pathlib
p = pathlib.Path(sys.argv[1]); t = p.read_text(encoding='utf-8')
assert t.count('os.kill(pid, 9)') == 1
p.write_text(t.replace('os.kill(pid, 9)', 'pass  # 被反向测试挖掉'), encoding='utf-8')
PY
T "挖掉 SIGKILL 升级 → 红" 1
cp "$TMP/sup" "$SUP"

# C：僵尸判定被删
python3 - "$SUP" <<'PY'
import sys, pathlib
p = pathlib.Path(sys.argv[1]); t = p.read_text(encoding='utf-8')
assert t.count('os.waitpid(pid, os.WNOHANG)') == 1
p.write_text(t.replace('os.waitpid(pid, os.WNOHANG)', '(0, 0)'), encoding='utf-8')
PY
T "挖掉僵尸判定 → 红" 1
cp "$TMP/sup" "$SUP"

# D：负向用例的断言被删
python3 - "$TEST" <<'PY'
import sys, pathlib
p = pathlib.Path(sys.argv[1]); t = p.read_text(encoding='utf-8')
assert t.count("'SIGKILL'") == 1
p.write_text(t.replace("'SIGKILL'", "'被反向测试挖掉'"), encoding='utf-8')
PY
T "挖掉负向用例的断言 → 红" 1
cp "$TMP/test" "$TEST"

T "全部恢复后 → 通过" 0

printf '\n小计：%s 通过，%s 不符\n' "$pass" "$fail"
[ "$fail" = "0" ]
