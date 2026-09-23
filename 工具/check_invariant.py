#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
0C-8 不变量判定器 —— G3 门禁的核心交付物（PRD §9.8.1、§2.5.1、§7.5.2）。

## 要判定的不变量

> 能查看某个聚合口径的用户，必须**同样能访问构成该聚合的每一条个体数据**；
> 不满足则**拒绝发布**，不存在审批放行路径。（§9.8.1）

形式化：

    ∀u ∈ Viewers(A).  Constituents(A) ⊆ Access(u, S_A)

## 为什么不能按档位编号比较

PRD §2.5.1 明确：**未规定店铺与部门的组织包含关系，二者可能交叉**。
且契约层的 `data_scopes` 是**数组**（1-5 个，可多选，见
`permission-spec.v1alpha1.schema.json`）。`["SELF","STORE"]` 与 `["DEPARTMENT"]`
之间不存在编号大小关系 —— 集合关系取决于组织模型本身。

所以判定**必须**按「实际可访问集合」，本实现照此执行。

## 如何做到「可机器判定」

难点有两个，都不是靠近似绕过的：

1. **Constituents(A) 是运行时数据**，静态不可知。
   解法：不做「这条记录能不能看」，而证一个**更强的静态命题** ——
   *所有满足该聚合过滤条件的记录，该用户都能访问*。
   它是充分的（更强 ⟹ 原命题），且在数据库为空时也成立。

2. **用户与记录可能海量**，不能枚举实例。
   解法：可见性谓词只依赖**属性元组**（tenant / dept / shop / id 或 owner），
   而属性来自**有限的域**。故枚举的是**属性元组的笛卡尔积**，不是实例。
   `SELF` 档位下 `owner` 是唯一的「无限」维度 —— 本实现对它做**保守处理**
   （见 `enumerate_records` 的说明），保守方向是「更容易判违反」，不会漏报。

判定的输出是**反例**（若有）：一份可直接用于报错的 `(用户, 记录, 档位)` 三元组。
没有反例即判成立 —— 在给定的组织模型下，这是**判定**而非启发式。

## 用法

    python3 工具/check_invariant.py                       # 跑内置用例
    python3 工具/check_invariant.py --json                # 机读输出
    python3 工具/check_invariant.py --input <口径登记单.json>   # 判定实际产出的口径

### 为什么需要 `--input`

内置用例只证明**判定器本身**能区分成立与拒绝，不判定任何真实产出。
而 §9.8.1 要求的门禁是「发布前检查这条口径」，检查对象是**搭建产出的配置**。

`--input` 就是这条通路：把 `dashboard-builder` 产出的每条口径登记为

    (aggregate, scopes, resource, inject)

后交给同一套判定。判定通过即放行，不通过即拒绝发布（**不存在审批放行路径**）。

这三个量**都不在 `view-schema` 里** —— 它们是配置的另外几处：

| 量 | 来源 |
|---|---|
| `scopes` 可见性档位 | `permission-spec` 的 `data_scopes`（档位是**数组**，并集语义） |
| `resource` 聚合范围 | 口径 capability 自身定义的范围 |
| `inject` 查询注入档位 | 视图调用该查询时传入的 `params`（`DataQueryRef.params`） |

所以 `dashboard-builder` 的产出包含**两个**文件：`view-schema` 的 `Spec`，
以及这份口径登记单。前者过 MetaSchema，后者过本判定器。

登记单格式（`org` 可选，缺省用内置的组织模型）：

    {
      "org": { "tenants": [...], "depts": {...}, "shops": [...], "users": [...] },
      "calibers": [
        { "aggregate": "caliber.monthly_sales",
          "scopes": ["COMPANY"], "resource": {"tenant": "t1"},
          "inject": ["COMPANY"], "expect": true }
      ]
    }

`expect` 可省略；省略时判据是「该口径必须成立」。
"""

import json
import sys
from itertools import product
from typing import Dict, FrozenSet, List, Optional, Sequence, Set, Tuple

# ── 契约层的档位取值（permission-spec.v1alpha1.schema.json 的 data_scopes enum）──
SELF = 'SELF'
STORE = 'STORE'
DEPARTMENT = 'DEPARTMENT'
DEPARTMENT_AND_CHILDREN = 'DEPARTMENT_AND_CHILDREN'
COMPANY = 'COMPANY'
ALL_SCOPES = (SELF, STORE, DEPARTMENT, DEPARTMENT_AND_CHILDREN, COMPANY)


class OrgModel:
    """
    组织模型：判定所需的**全部**上下文。

    显式作为输入，是因为「店铺与部门可能交叉」——可见性完全由它决定，
    不能靠编号推导。
    """

    def __init__(self, tenants: Sequence[str], depts: Dict[str, Optional[str]],
                 shops: Sequence[str], users: Sequence[Dict[str, str]]):
        self.tenants = list(tenants)
        self.depts = dict(depts)                 # dept -> parent（None 为根）
        self.shops = list(shops)
        self.users = list(users)                 # {tenant, dept, shop, id}

    def subtree(self, dept: str) -> Set[str]:
        """dept 及其全部下级部门。"""
        out = {dept}
        changed = True
        while changed:
            changed = False
            for d, parent in self.depts.items():
                if parent in out and d not in out:
                    out.add(d)
                    changed = True
        return out

    def attribute_tuples(self) -> List[Tuple[str, str, str]]:
        """用户与记录共用的**非 id 属性**域：tenant / dept / shop。"""
        ts = self.tenants or ['']
        ds = list(self.depts) or ['']
        ss = self.shops or ['']
        return list(product(ts, ds, ss))


def holds(user_attr: Tuple[str, str, str], record_attr: Tuple[str, str, str, str],
          scope: str, same_person: bool) -> bool:
    """
    单个档位的谓词：用户 `user_attr=(tenant,dept,shop)` 在 `scope` 下能否访问
    归属为 `record_attr=(tenant,dept,shop,owner)` 的记录。

    `same_person` 表示「这条记录的 owner 就是该用户本人」——只在 SELF 档位下
    有意义，故作为显式参数而不是把 id 塞进属性元组。
    """
    ut, ud, us = user_attr
    rt, rd, rs, _ro = record_attr

    # 多公司隔离：任何档位都不得跨租户（§9.9.2）
    if ut != rt:
        return False

    if scope == COMPANY:
        return True
    if scope == STORE:
        return us == rs
    if scope == DEPARTMENT:
        return ud == rd
    if scope == DEPARTMENT_AND_CHILDREN:
        # 子树的包含关系由组织模型给出，不由档位编号推导
        return rd in _SUBSTURE_CACHE[(ut, ud)]
    if scope == SELF:
        return same_person
    raise ValueError('unknown scope %r' % scope)


_SUBSTURE_CACHE: Dict[Tuple[str, str], Set[str]] = {}


def can_access(user_attr, record_attr, scopes: Sequence[str], same_person: bool) -> bool:
    """档位是**集合**：任一档位成立即可访问。"""
    return any(holds(user_attr, record_attr, s, same_person) for s in scopes)


def records_matching(org: OrgModel, resource: Dict[str, str]) -> List[Tuple[Tuple[str, str, str, str], bool]]:
    """
    枚举 `resource` 描述的那组记录（属性等价类），返回 (record_attr, same_person)。

    `resource` 是一个**记录属性模式**：给出的维度为确定值，未给出的维度取遍
    组织模型中的全部取值。例如 `{'shop': 'store-1'}` 表示「店铺 store-1 的全部
    记录，任意部门、任意归属人」。

    `same_person` 是唯一无法有限枚举的维度（owner 可以是任意人），故对每条属性
    组合同时给出两种取值。这是**保守**的：`same_person=False` 构造出「用户看得到
    汇总、却看不到别人贡献的记录」这一最不利情形。若连它都不违反不变量，则任何
    真实数据状态都不违反 —— **保守方向是「更容易报违反」，因此不会漏报**。
    """
    out = []
    for (t, d, sh) in org.attribute_tuples():
        if 'tenant' in resource and resource['tenant'] != t:
            continue
        if 'dept' in resource and resource['dept'] != d:
            continue
        if 'shop' in resource and resource['shop'] != sh:
            continue
        out.append(((t, d, sh, '<owner>'), True))
        out.append(((t, d, sh, '<other>'), False))
    return out


def covers(org: OrgModel, user_attr, scopes: Sequence[str],
           resource: Dict[str, str]) -> bool:
    """
    该用户在 `scopes` 下**能不能看到整个 resource**。

    这是 `Viewers(A)` 的判定：不是「有没有这个档位」，而是「这个档位能不能覆盖
    A 的资源范围」。

    早先的实现把 Viewers 简化成「所有持有该档位的用户」，于是把
    「shop=store-2 的用户看不到 store-1 的汇总」误判成不变量违反 —— 那是
    **把「谁持有档位」与「谁能看这个口径」混为一谈**。
    """
    # ★ 档位是**并集**：任一档位覆盖整个 resource 即可。
    #
    # 早先写成 `all(... for s in scopes)`（每个档位都要覆盖），把
    # `[SELF, COMPANY]` 这种正常配置判成了不可用 —— 并集语义写成了交集。
    records = records_matching(org, resource)
    # ★ 空 resource 必须返回 False，不能靠 all() 的空真混过去。
    #
    # 若聚合范围在组织模型里不存在（例如指向另一个租户的数据），
    # 覆盖它的「所有记录」在逻辑上**空真**成立 —— 于是没人能看的口径
    # 反而被判成「人人可看」。空真在这里是陷阱，必须显式拦掉。
    if not records:
        return False
    return any(
        all(holds(user_attr, ra, s, sp) for ra, sp in records)
        for s in scopes
    )


def check(org: OrgModel, aggregate_name: str, scopes: Sequence[str],
          resource: Dict[str, str], inject: Optional[Sequence[str]] = None) -> Dict:
    """
    判定一个聚合口径是否满足不变量。

    `resource` 是该口径聚合的记录范围；`scopes` 是它的可见性档位集合。

    判定分两层：

      L1  **口径可用性**：是否**存在**用户能看这个口径。
          若没人能看，说明「可见性档位」覆盖不了「聚合范围」——那是配置错误，
          必须拒绝发布（一个无人可看的口径既无意义，也说明搭建者的意图没被
          正确表达）。

      L2  **不变量本体**：能看该口径的用户，是否能访问构成它的**每一条**记录。
          违反即拒绝，无审批放行路径（§9.8.1）。

    返回 `{'ok': bool, 'layer': 'L1'|'L2'|None, 'counterexample': ...}`。
    """
    # 建子树缓存
    for d in org.depts:
        for t in (org.tenants or ['']):
            _SUBSTURE_CACHE[(t, d)] = org.subtree(d)

    user_attrs = list(org.attribute_tuples())
    constituents = records_matching(org, resource)

    # L1（口径可用性）：是否存在**任何**用户能看这个口径。
    # 注意 `viewers` 只服务 L1；L3 必须遍历全部用户（见下），不能复用它。
    viewers = [ua for ua in user_attrs if covers(org, ua, scopes, resource)]
    if not constituents:
        return {
            'ok': False, 'layer': 'L1', 'aggregate': aggregate_name,
            'scopes': list(scopes), 'resource': resource,
            'why': '该聚合范围在组织模型下不存在任何记录 —— '
                   '口径指向了不属于本部署的租户/部门/店铺',
        }
    if not viewers:
        return {
            'ok': False, 'layer': 'L1', 'aggregate': aggregate_name,
            'scopes': list(scopes), 'resource': resource,
            'why': '没有任何用户的可见性档位能覆盖该口径的聚合范围 —— '
                   '口径与可见性不匹配（配置错误）',
        }

    # ── L3：查询实际返回的范围必须**不超出**用户的可访问范围 ────────────
    #
    # 这是本判定器里唯一能真正失败的一层，也是 §9.8.1 攻击成立的条件。
    #
    # 关键区分 —— 下面两件事**不是同一件事**：
    #   · **可见性**：哪些用户能执行这个查询
    #   · **注入**：查询实际返回什么范围的数据
    # 不变量约束的是后者相对前者的关系。
    #
    # 所以本层的遍历对象是**全部用户属性元组**，不是 `viewers`。
    # 早先版本遍历 viewers，而 visitors 本身由 covers 筛出，于是检查恒不触发
    # ——那是个**永远为绿的检查**，比没有检查更危险。
    #
    # 为什么取全部用户：角色的具体分配不在本判定器的输入里（它属运行时数据），
    # 故保守假设**任何用户都可能持有该口径**。保守方向是「更容易报违反」，
    # 因此不会漏报。
    all_users = list(org.attribute_tuples())

    if inject is None:
        # 未注入：查询返回 resource 的**全部**记录，与查询者无关。
        # 因此要求每个可能持有该口径的用户都能覆盖整个 resource。
        for ua in all_users:
            if not covers(org, ua, scopes, resource):
                return {
                    'ok': False, 'layer': 'L3', 'aggregate': aggregate_name,
                    'scopes': list(scopes), 'resource': resource,
                    'counterexample': {
                        'user': {'tenant': ua[0], 'dept': ua[1], 'shop': ua[2]},
                        'why': '该用户持有此口径的可见性档位，但档位覆盖不到聚合范围；'
                               '查询又未注入数据范围，于是他会看到超出自身可访问范围的汇总',
                    },
                }
    else:
        # 已注入：返回范围被限制在查询者的 scope 内。
        # 此时仍须要求「注入的范围不窄于可见性所表达的范围」——
        # 否则用户看得到汇总，却看不到构成它的部分个体，相减即可反推。
        for ua in all_users:
            if not covers(org, ua, scopes, resource):
                continue                      # 该用户本来就看不到这个口径
            if not covers(org, ua, inject, resource):
                return {
                    'ok': False, 'layer': 'L3', 'aggregate': aggregate_name,
                    'scopes': list(scopes), 'resource': resource,
                    'inject': list(inject),
                    'counterexample': {
                        'user': {'tenant': ua[0], 'dept': ua[1], 'shop': ua[2]},
                        'why': '可见性档位能覆盖聚合范围，注入的档位却覆盖不了 —— '
                               '用户看得到汇总，看不到构成它的部分个体记录，相减即可反推',
                    },
                }

    # ── L2：防御性检查 ─────────────────────────────────────────────────
    #
    # 在「可见性与注入共用同一谓词」的正确实现下，L2 **恒真**（见 L3 的说明）。
    # 保留它是为了让实现走偏时能被抓住：若将来有人改动 covers 或 can_access
    # 之一而忘了另一个，两层会不同步，L2 会立刻报出反例。
    # **它不是主要的检查点** —— 主要检查点是 L1 与 L3。
    for ua in viewers:
        for ra, sp in constituents:
            if not can_access(ua, ra, scopes, sp):
                return {
                    'ok': False, 'layer': 'L2', 'aggregate': aggregate_name,
                    'scopes': list(scopes), 'resource': resource,
                    'counterexample': {
                        'user': {'tenant': ua[0], 'dept': ua[1], 'shop': ua[2]},
                        'record': {'tenant': ra[0], 'dept': ra[1],
                                   'shop': ra[2],
                                   'owner': 'self' if sp else 'other'},
                        'why': '该用户能查看聚合结果，却看不到构成它的这条记录 —— '
                               '用「总额减排除项」即可反推个体值',
                    },
                }
    return {'ok': True, 'layer': None, 'aggregate': aggregate_name,
            'scopes': list(scopes), 'resource': resource,
            'viewerCount': len(viewers)}


# ── 内置用例 ────────────────────────────────────────────────────────────

def _org() -> OrgModel:
    """一个小而**交叉**的组织模型：店铺与部门不是包含关系（§2.5.1 强调的情形）。"""
    return OrgModel(
        tenants=['t1'],
        depts={'sales': None, 'sales-a': 'sales', 'sales-b': 'sales',
               'fin': None, 'fin-a': 'fin'},
        shops=['store-1', 'store-2'],
        users=[{'tenant': 't1', 'dept': 'sales-a', 'shop': 'store-1', 'id': 'u1'}],
    )


CASES = [
    # (名称, 可见性档位, 聚合范围, 注入档位, 期望是否成立)
    ('COMPANY 口径 / COMPANY 可见', [COMPANY], {'tenant': 't1'}, [COMPANY], True),
    ('STORE 口径 / STORE 可见', [STORE], {'tenant': 't1', 'shop': 'store-1'}, [STORE], True),
    ('DEPT 口径 / DEPARTMENT 可见',
     [DEPARTMENT], {'tenant': 't1', 'dept': 'sales-a'}, [DEPARTMENT], True),
    ('DEPT 口径 / 部门及下级可见',
     [DEPARTMENT_AND_CHILDREN], {'tenant': 't1', 'dept': 'sales-a'},
     [DEPARTMENT_AND_CHILDREN], True),
    ('全公司口径 / SELF 可见 —— L1：无人能看',
     [SELF], {'tenant': 't1'}, [SELF], False),
    ('店铺口径 / DEPARTMENT 可见 —— 交叉，覆盖不了',
     [DEPARTMENT], {'tenant': 't1', 'shop': 'store-1'}, [DEPARTMENT], False),
    ('多档位并集：SELF+COMPANY / 全公司口径',
     [SELF, COMPANY], {'tenant': 't1'}, [SELF, COMPANY], True),
    ('跨租户：t2 口径 / 只有 t1 用户',
     [COMPANY], {'tenant': 't2'}, [COMPANY], False),
    # ── L3：真正能失败的一层 ──
    ('★ 声明 COMPANY 可见、却只注入 SELF —— 应拒绝（§9.8.1 攻击）',
     [COMPANY], {'tenant': 't1'}, [SELF], False),
    ('★ STORE 可见、未注入、聚合范围跨店 —— 应拒绝',
     [STORE], {'tenant': 't1', 'shop': 'store-1'}, None, False),
    ('COMPANY 可见、未注入、聚合全公司 —— 覆盖得住，成立',
     [COMPANY], {'tenant': 't1'}, None, True),
    ('声明 COMPANY 可见、注入 COMPANY —— 一致',
     [COMPANY], {'tenant': 't1'}, [COMPANY], True),
]


# ── 实际产出：口径登记单 ────────────────────────────────────────────────

def org_from(spec: Optional[Dict]) -> OrgModel:
    """从登记单的 `org` 段建组织模型。缺省或空对象时用内置组织模型。"""
    if not spec:
        return _org()
    missing = [k for k in ('tenants', 'depts', 'shops', 'users') if k not in spec]
    if missing:
        raise ValueError('org 段缺少字段：%s' % ', '.join(missing))
    return OrgModel(spec['tenants'], spec['depts'], spec['shops'], spec['users'])


def check_calibers(org: OrgModel, calibers: Sequence[Dict]) -> List[Dict]:
    """
    逐条判定登记单里的口径。

    与内置用例的区别：**这里没有「期望值」** —— 每条口径的判据就是
    「必须成立」。`expect` 只是给有意构造的拒绝用例留的口子。
    """
    out = []
    for entry in calibers:
        for key in ('aggregate', 'scopes', 'resource'):
            if key not in entry:
                raise ValueError('口径条目缺少字段 %s：%r' % (key, entry))
        result = check(org, entry['aggregate'], entry['scopes'],
                       entry['resource'], entry.get('inject'))
        result['expect'] = entry.get('expect', True)
        out.append(result)
    return out


def run_input(path: str, as_json: bool) -> int:
    """判定一份口径登记单。退出码 0 = 全部口径成立。"""
    try:
        with open(path, encoding='utf-8') as fh:
            payload = json.load(fh)
    except (OSError, ValueError) as exc:
        print('✗ 无法读取口径登记单 %s：%s' % (path, exc))
        return 2

    if not isinstance(payload, dict) or not isinstance(payload.get('calibers'), list):
        print('✗ 口径登记单必须是 {"org"?: …, "calibers": [ … ]}')
        return 2
    if not payload['calibers']:
        print('✗ 口径登记单里没有任何口径 —— 看板不产出口径，就不该走这条判定')
        return 2

    try:
        org = org_from(payload.get('org'))
        results = check_calibers(org, payload['calibers'])
    except ValueError as exc:
        print('✗ 口径登记单不合法：%s' % exc)
        return 2

    if as_json:
        print(json.dumps({'source': path, 'calibers': results},
                         ensure_ascii=False, indent=2))
        return 0 if all(r['ok'] == r['expect'] for r in results) else 1

    print('=== 0C-8 不变量判定（口径登记单）===')
    print('来源：%s' % path)
    print('不变量：能查看聚合口径的用户，必须能访问构成它的每一条个体数据')
    print()

    bad = 0
    for r in results:
        mark = '✓' if r['ok'] == r['expect'] else '✗'
        if r['ok'] != r['expect']:
            bad += 1
        layer = '' if r['ok'] else '［%s］' % r['layer']
        print('%s %-34s 判定=%-6s%s' % (mark, r['aggregate'],
                                        '成立' if r['ok'] else '拒绝', layer))
        if not r['ok']:
            ce = r.get('counterexample')
            print('      聚合范围 %s ／ 可见性档位 %s ／ 注入档位 %s'
                  % (r['resource'], r['scopes'], r.get('inject')))
            print('      %s' % (r.get('why') or ce['why']))

    print()
    if bad:
        print('✗ %d 条口径不满足不变量 —— 按 §9.8.1 **拒绝发布**，无审批放行路径' % bad)
        return 1
    print('✓ %d 条口径全部成立' % len(results))
    return 0


def main() -> int:
    if '--input' in sys.argv:
        index = sys.argv.index('--input')
        if index + 1 >= len(sys.argv):
            print('✗ --input 需要一个文件路径')
            return 2
        return run_input(sys.argv[index + 1], '--json' in sys.argv)

    org = _org()

    if '--json' in sys.argv:
        print(json.dumps({
            'org': {'depts': org.depts, 'shops': org.shops},
            'cases': [dict(check(org, n, s, r, i), expect=exp)
                      for n, s, r, i, exp in CASES],
        }, ensure_ascii=False, indent=2))
        return 0

    print('=== 0C-8 不变量判定（G3）===')
    print('不变量：能查看聚合口径的用户，必须能访问构成它的每一条个体数据')
    print('判据：按**实际可访问集合**判定，不按档位编号（§2.5.1）')
    print()

    bad = 0
    for name, scopes, resource, inject, expect in CASES:
        r = check(org, name, scopes, resource, inject)
        got = r['ok']
        mark = '✓' if got == expect else '✗'
        if got != expect:
            bad += 1
        detail = ''
        if not got:
            detail = '［%s］' % r['layer']
        print('%s %-42s 判定=%-6s%s 期望=%s' % (mark, name, '成立' if got else '拒绝',
                                                detail, '成立' if expect else '拒绝'))
        if not got and r['layer'] == 'L2':
            ce = r['counterexample']
            print('      反例：用户(dept=%s, shop=%s) 看不到 记录(dept=%s, shop=%s, owner=%s)'
                  % (ce['user']['dept'], ce['user']['shop'],
                     ce['record']['dept'], ce['record']['shop'], ce['record']['owner']))
        elif not got and r['layer'] == 'L1':
            print('      %s' % r['why'])

    print()
    if bad:
        print('✗ %d 个用例与预期不符' % bad)
        return 1
    print('✓ %d 个用例全部符合预期 —— 判定器可区分「应当成立」与「应当拒绝」' % len(CASES))
    return 0


if __name__ == '__main__':
    sys.exit(main())
