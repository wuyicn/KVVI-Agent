#!/usr/bin/env bash
# `0D-1` 蓝图闭环检查器的反向测试。
#
# 为什么必须做：「六段全过」这个结论，一个**永远报通过**的检查器同样给得出。
# 本测试逐段把闭环弄坏，要求检查器**在应该红的时候红**：
# 缺审批、批错东西、跳版本、乱序、陈旧的影响报告、手写的预览 ——
# 每一项都对应一种真实的失败方式（其中「影响报告陈旧」正是本项目反复出现的
# 「改一处、不传播」）。
#
# 做法：在**同一层级**复制一份蓝图（相对路径才继续有效），逐项破坏后运行检查器。
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/样例/蓝图/通用事项管理系统"
TMP="$ROOT/样例/蓝图/__selftest__"
CHECK=(python3 "$ROOT/工具/check_blueprint.py")

pass=0; fail=0
T() {
  if [ "$2" = "$3" ]; then printf '  \033[32m✓\033[0m %-50s 退出码 %s（期望 %s）\n' "$1" "$3" "$2"; pass=$((pass+1))
  else printf '  \033[31m✗\033[0m %-50s 退出码 %s（期望 %s）\033[0m\n' "$1" "$3" "$2"; fail=$((fail+1)); fi
}
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT
reset() { rm -rf "$TMP"; cp -R "$SRC" "$TMP"; }
run() { "${CHECK[@]}" "$TMP" >/dev/null 2>&1; echo $?; }

echo '=== `0D-1` 蓝图闭环检查器反向测试 ==='

echo
echo "[1] 正例"
reset; T "原样蓝图 → 闭环闭合" 0 "$(run)"

echo
echo "[2] 『你点通过』这一段必须真的拦人"
reset; rm -f "$TMP/审批.json"
T "缺 审批.json → 红" 1 "$(run)"

reset; python3 - "$TMP" <<'PY'
import json, sys
p = sys.argv[1] + '/审批.json'
d = json.load(open(p, encoding='utf-8')); d['decision'] = 'REJECT'
open(p, 'w', encoding='utf-8').write(json.dumps(d, ensure_ascii=False, indent=2))
PY
T "审批结果是 REJECT → 红" 1 "$(run)"

reset; python3 - "$TMP" <<'PY'
import json, sys
p = sys.argv[1] + '/审批.json'
d = json.load(open(p, encoding='utf-8'))
d['artifact_digest'] = 'sha256:' + '9' * 64
open(p, 'w', encoding='utf-8').write(json.dumps(d, ensure_ascii=False, indent=2))
PY
T "审批绑定到别的摘要（批的不是这一份）→ 红" 1 "$(run)"

echo
echo "[3] DraftGraph 重放必须真的在重放"
reset; python3 - "$TMP" <<'PY'
import glob, json, sys
p = sorted(glob.glob(sys.argv[1] + '/命令/*.json'))[5]
c = json.load(open(p, encoding='utf-8')); c['base_revision'] = 99
open(p, 'w', encoding='utf-8').write(json.dumps(c, ensure_ascii=False, indent=2))
PY
T "base_revision 跳版本 → 红" 1 "$(run)"

reset; python3 - "$TMP" <<'PY'
import json, sys
# 把「title 字段节点」的创建者改成**最后一条**命令 ——
# 于是早于它的 view.bindField 就指向了一个「还没创建」的节点：拓扑序不成立。
p = sys.argv[1] + '/蓝图.json'
d = json.load(open(p, encoding='utf-8'))
cmds = sorted(__import__('glob').glob(sys.argv[1] + '/命令/*.json'))
last = json.load(open(cmds[-1], encoding='utf-8'))['command_id']
for meta in d['ids'].values():
    if meta['kind'] == 'node' and meta['logical'].endswith('/title'):
        meta['created_by'] = last
open(p, 'w', encoding='utf-8').write(json.dumps(d, ensure_ascii=False, indent=2))
PY
T "目标节点在更晚的命令里才创建 → 红" 1 "$(run)"

echo
echo "[4] 影响报告必须与产出物同步（『改一处、不传播』）"
reset; python3 - "$TMP" <<'PY'
import json, sys
p = sys.argv[1] + '/影响.json'
d = json.load(open(p, encoding='utf-8'))
d['payload']['impacted_refs'][0]['digest'] = 'sha256:' + '7' * 64
open(p, 'w', encoding='utf-8').write(json.dumps(d, ensure_ascii=False, indent=2))
PY
T "影响报告与产出物摘要不符 → 红" 1 "$(run)"

echo
echo "[5] 预览必须是**推导**出来的，不是手写的"
reset; python3 - "$TMP" <<'PY'
import glob, sys
p = sorted(glob.glob(sys.argv[1] + '/预览/*.html'))[0]
open(p, 'a', encoding='utf-8').write('<p>手工补的一行</p>\n')
PY
T "预览被手改 → 红" 1 "$(run)"

echo
echo "[6] 产出物本身过不了契约校验时必须红"
reset; python3 - "$TMP" <<'PY'
import json, shutil, sys
src = sys.argv[1] + '/../../view-schema/通用事项登记表单.spec.json'
dst = sys.argv[1] + '/表单-坏的.json'
d = json.load(open(src, encoding='utf-8'))
d['componentsTree'][0]['children'][0]['children'][0]['props']['fieldBinding']['fieldRef'] = 'no_such_field'
open(dst, 'w', encoding='utf-8').write(json.dumps(d, ensure_ascii=False, indent=2))
p = sys.argv[1] + '/蓝图.json'
b = json.load(open(p, encoding='utf-8'))
for a in b['artifacts']:
    if a['part'] == '表单':
        a['path'] = '表单-坏的.json'
open(p, 'w', encoding='utf-8').write(json.dumps(b, ensure_ascii=False, indent=2))
PY
T "表单绑定了模型里不存在的字段 → 红" 1 "$(run)"

echo
echo "[7] 收口动作与五部分齐全"
reset; python3 - "$TMP" <<'PY'
import glob, json, os, sys
for p in sorted(glob.glob(sys.argv[1] + '/命令/*.json')):
    if json.load(open(p, encoding='utf-8'))['type'] == 'draft.compile':
        os.remove(p)
PY
T "删掉 draft.compile → 红" 1 "$(run)"

reset; python3 - "$TMP" <<'PY'
import json, sys
p = sys.argv[1] + '/蓝图.json'
d = json.load(open(p, encoding='utf-8'))
d['artifacts'] = [a for a in d['artifacts'] if a['part'] != '接口']
open(p, 'w', encoding='utf-8').write(json.dumps(d, ensure_ascii=False, indent=2))
PY
T "蓝图缺『接口』这一部分 → 红" 1 "$(run)"

reset; python3 - "$TMP" <<'PY'
import json, sys
p = sys.argv[1] + '/蓝图.json'
d = json.load(open(p, encoding='utf-8'))
for a in d['artifacts']:
    if a['part'] == '表单':
        a['via'] = []
        a.pop('via_note', None)
open(p, 'w', encoding='utf-8').write(json.dumps(d, ensure_ascii=False, indent=2))
PY
T "产出物没有命令溯源、也没说明原因 → 红" 1 "$(run)"

echo
echo "[8] 检查器自身：扫不到东西时必须报「无法执行」，不能报通过"
"${CHECK[@]}" "$ROOT/样例" >/dev/null 2>&1; T "指向非蓝图目录 → 退出码 2" 2 $?

echo
printf '小计：\033[32m%d 通过\033[0m' "$pass"
[ "$fail" -gt 0 ] && printf '，\033[31m%d 失败\033[0m' "$fail"
echo
[ "$fail" -eq 0 ] || exit 1
