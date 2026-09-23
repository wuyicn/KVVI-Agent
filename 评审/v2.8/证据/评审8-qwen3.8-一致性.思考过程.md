Let me carefully analyze this PRD v2.8 document from the perspective of an independent reviewer, focusing on:

**Task A: Consistency Check**
1. Review round numbers and counts
2. Numbering system (M1-M5, §4.6 subsections, §9 subsections)
3. Cross-references
4. Outdated expressions
5. §0.9 claims vs. actual content

**Task B: Audit the check_prd.py tool**
1. Blind spots
2. False positives
3. Self-verification concerns

Let me go through systematically.

## Task A: Consistency Check

### 1. Review round numbers and counts

The document header says: "七轮评审后修订，待第八轮验证"

Let me count the rounds:
- v2.1: 第一轮评审 (1st round)
- v2.2: 按第一轮结论修订
- v2.3: 按第二轮复评结论修订
- v2.4: 按第三轮复评结论修订
- v2.5: 按第四轮复评结论修订
- v2.6: 按第五轮复评结论修订
- v2.7: 按第六轮复评结论修订
- v2.8: 按第七轮复评结论修订

So v2.8 is the result of the 7th round of review. The current review (this one) would be the 8th round. The header says "七轮评审后修订，待第八轮验证" - this is correct.

Now let me check §0.9:
- §0.9 says "第七轮复评（冻结前最终验证）后修订" - correct, v2.8 is the result of the 7th round.
- §0.9 says "第八轮验证前不得冻结" - correct, this is the 8th round.

§9.12 says: "七轮评审的发现已全部处理" - Let me count the rounds listed in §9.12:
- v2.1 评审 (round 1)
- v2.2 复评 (round 2)
- v2.3 复评 (round 3)
- v2.4 复评 (round 4)
- v2.5 复评 (round 5)
- v2.6 复评 (round 6)
- v2.7 复评 (round 7)

That's 7 rounds. §9.12 says "七轮评审的发现已全部处理" - correct.

§10.4 says: "七轮评审的发现已全部处理，写入 §9 安全设计" - correct.

Now let me check the review count accumulation:
- Round 1 (v2.1): 5 models, 4 families, "2轮5份评审" - wait, this says "共 2 轮 5 份评审". Let me re-read.

Actually, looking at §0.3: "v2.1（指纹 59683326…b23ff9）经五个模型、四个家族独立评审（评审/v2.1/汇总.md），共 2 轮 5 份评审"

So round 1 had 5 reviews (2 rounds of 5? or 2 rounds total with 5 reviews?). The table shows 5 models. Let me interpret this as: the first review cycle had 5 independent reviews.

- Round 2 (v2.2): "v2.2 经两份独立复评" - 2 reviews
- Round 3 (v2.3): "v2.3 经两份独立复评" - 2 reviews
- Round 4 (v2.4): "v2.4 经 kimi-k3（Moonshot，第四个独立模型家族）以实现者视角评审" - 1 review
- Round 5 (v2.5): "v2.5 经四份独立评审" - 4 reviews
- Round 6 (v2.6): "v2.6 经两份独立评审" - 2 reviews
- Round 7 (v2.7): "v2.7 经三份评审" - 3 reviews

Total: 5 + 2 + 2 + 1 + 4 + 2 + 3 = 19 reviews

Now let me check §0.7's claim about "7份评审":
"此后 7 份评审（v2.3 复评 2 + v2.4 复评 1 + v2.5 复评 4）审的都是含此错误的版本"
2 + 1 + 4 = 7. Correct.

And §0.7 says "其中仅 qwen3.8（本地 27B，完整性交叉检查视角）发现" - this is consistent with the v2.5 round having 4 reviews including qwen3.8.

Wait, but §0.7 also says in the methodology section:
"此后 7 份评审（v2.3 复评 2 + v2.4 复评 1 + v2.5 复评 4）审的都是含此错误的版本，其中仅 qwen3.8（本地 27B，完整性交叉检查视角）发现。"

But then in §0.9, item 5 says:
"§0.7 自相矛盾：「7 份评审均未发现」与「由 qwen3.8 抓到」并存（qwen3.8 正是那 7 份之一）"
"改为「其中仅 qwen3.8 发现」"

So the fix was to change "7份评审均未发现" to "其中仅qwen3.8发现". Let me check what §0.7 actually says now:

Looking at §0.7: "此后 7 份评审（v2.3 复评 2 + v2.4 复评 1 + v2.5 复评 4）审的都是含此错误的版本，其中仅 qwen3.8（本地 27B，完整性交叉检查视角）发现。"

OK so it says "其中仅 qwen3.8 发现" - this is the corrected version. Good.

But wait - the §0.9 item 5 says the fix was "改为「其中仅 qwen3.8 发现」". Let me check if the original text in §0.7 had "7份评审均未发现" or something else. The §0.9 description says the problem was "「7 份评审均未发现」与「由 qwen3.8 抓到」并存". But looking at the current §0.7 text, it says "其中仅 qwen3.8（本地 27B，完整性交叉检查视角）发现" - so the fix has been applied. Good.

### 2. Numbering system

**M1-M5:**
- M1: 产出物格式统一以 MetaSchema 为准 (§0.2, §5.3, §10.3)
- M2: 金额一律采用 money 类型 (§0.2, §5.4, §10.3)
- M3: 两套路线图合并为一条 (§0.2, §7.2, §10.3)
- M4: 采用「公司即租户」组织模型 (§10.3, §4.5, §10.3.1)
- M5: 验证器引擎的运行时权威 (§4.6.3, §5.3, §10.3)

Let me check each reference:
- §0.2: M1, M2, M3 defined ✓
- §0.6: M5 mentioned ("M5：Node 为生产权威") ✓
- §0.9: M5 mentioned in item 14 ("M5 未列入 §10.3 决策表") ✓
- §4.6.3: "M5 新增，v2.5" ✓
- §5.3: "M1" in title, "M5" in the merge strategy section ✓
- §10.3: M1, M2, M3, M4, M5 all listed ✓

Wait, let me check §0.6 more carefully. It says:
"| 4 | 阻断 | **验证器引擎取舍**未定... | **M5**：Node 为生产权威..."

And §5.3 says: "并入策略（阶段一交付物之一，M5）"

And §10.3 has: "M5 | 验证器引擎的运行时权威：Node 为生产权威..."

These are consistent. M5 is about the validator engine authority.

But wait - in §0.6, item 5 says:
"| 5 | 重要 | MetaSchema 资产位置指向 git worktree... | 明确单仓库合并策略... | **§5.3** |"

And §5.3 says "并入策略（阶段一交付物之一，M5）" - this seems to conflate the MetaSchema merge strategy with M5 (validator engine). Let me re-read...

Actually, looking more carefully at §5.3:
"并入策略（阶段一交付物之一，M5）"

Hmm, this is confusing. M5 is defined as "验证器引擎的运行时权威" but the merge strategy in §5.3 is about moving MetaSchema assets into the KVVI-Agent repo. These seem like different things. Let me check if this is a mislabeling.

Wait, looking at §0.6 item 4: "M5：Node 为生产权威，Python 降级为开发期交叉验证；Docker 骨架不含 Python 运行时" - this is about the validator engine.

And §0.6 item 5: "MetaSchema 资产位置指向 git worktree" - this is about asset location.

In §5.3, the "并入策略" section is about moving assets. The title says "M5" but the content is about asset merging, not about validator engine authority. This seems like a labeling error - the asset merge strategy should not be labeled M5.

Actually wait, let me re-read §5.3 more carefully:

"**并入策略（阶段一交付物之一，M5）**："

Hmm, but M5 is defined as the validator engine decision. The merge strategy is a separate thing. This looks like a mislabeling. The merge strategy is related to M1 (MetaSchema as contract) but is not M5 itself.

Actually, I think I'm misreading this. Let me look again...

The §5.3 section is about "产出物格式：MetaSchema 为准（M1）" - so the section is about M1. Then within it, there's a subsection about "并入策略" which is labeled "M5". But M5 is about the validator engine authority, not about the merge strategy.

Wait, I think the "M5" in "并入策略（阶段一交付物之一，M5）" might be a typo or mislabeling. The merge strategy is a consequence of M1 (MetaSchema as the contract), not M5 (validator engine). Or perhaps it's saying that the merge strategy is a deliverable that includes M5 (the validator). Let me re-read...

Actually, I think the parenthetical "(阶段一交付物之一，M5)" is saying that this merge strategy is one of the stage-1 deliverables, and it's related to M5 (because the validator is part of what gets merged). But this is confusing because M5 is specifically about "which engine is authoritative" not about "where to put the assets."

I'll flag this as a potential confusion but it's not clearly wrong - the merge strategy does include the validator (which is M5's subject).

**§4.6 subsections:**
- §4.6.1: 四类数据，四个归属
- §4.6.2: 四条不可协商的规则
- §4.6.3: 验证器引擎的运行时权威（M5 新增，v2.5）
- §4.6.4: 平台库的安全边界（v2.6 新增）

Order: 4.6.1 → 4.6.2 → 4.6.3 → 4.6.4 ✓ (v2.8 fixed the order issue)

**§9 subsections:**
- §9.1: 地基
- §9.2: 唯一服务端策略执行点
- §9.3: 写操作的数据范围原子谓词
- §9.4: 委派身份与令牌
  - §9.4.1: 信任锚点与密钥管理
  - §9.4.2: 令牌失效的执行规则
  - §9.4.3: 契约版本协商
  - §9.4.4: 离线降级规则
  - §9.4.5: 拒绝原因的可区分性
- §9.5: 搭建者权限边界
- §9.6: 变更控制与高风险动作审批
  - §9.6.1 through §9.6.7
  - §9.6.4.1
- §9.7: 提示注入
- §9.8: A6, A7
- §9.9: 公司切换
- §9.10: 扩展通道安全边界
- §9.11: 运行与运维安全
- §9.12: 本章状态

§9.4.3, §9.4.4, §9.4.5 are consecutive. ✓

### 3. Cross-references

Let me check some key cross-references:

- §0.2 M1 references §5.3 ✓
- §0.2 M2 references §5.4 ✓
- §0.2 M3 references §7.2 ✓
- §0.5 references §0.6 and §9.12 ✓
- §0.6 references §4.1.1, §9.6.3, §9.4.3, §4.6.1-4.6.2, §4.6.3, §5.3, §7.1, §7.5.1, §3.5 ✓
- §0.7 references §4.1.1, §9.6.3, §5.6, §9.10, §9.2, §9.6, §4.6.1, §9.4.2, §9.4.4, §9.4.3, §3.5.1, §3.5.4, §10.1, §3.5.3, §9.7.1, §4.6.3, §5.7.3, §5.6, §4.6.2, §4.6.4, §3.5.2, §9.4.5, §10.3, §7.5.2, §9.1, §7.1 ✓
- §0.9 references §9.10.2, §9.6.2, §10.4, §9.12, §4.6, §0.7, §9.8.1, §10.1, §5.7.3, §9.4.4, §4.6.4, §9.6.3, §9.6.4, §9.4.2, §3.5.1, §4.1.1, §9.2, §7.1, §0.8 ✓

Let me check a specific one: §9.6.2 says "属高风险操作（§9.6.2 清单）" - wait, that's self-referential. Let me re-read...

Actually in §9.10.2: "插件安装、动态插件的定义与激活**属高风险操作**（§9.6.2 清单）" - this references §9.6.2, which now includes the plugin category (v2.8 added it). ✓

§9.6.3 references §9.6.5, §5.6, §9.10.2, §4.1.1, §7.5.2 ✓

Let me check: §9.4.4 says "与 §9.4.2 的短时令牌有效期、§3.5.1 的访客链接缓存 TTL 是同一个全局配置项" - let me verify §3.5.1 has this.

§3.5.1 says: "残留窗口 | 平台不可用时，已吊销链接在缓存有效期内可能仍被接受——已知残留窗口，上限 ≤ 5 分钟，与 §9.4.4 同一配置项、同一处置"

And §9.4.2 says: "有效期 ≤ 5 分钟（与 §9.4.4 的产品级上限同一配置项）"

And §9.4.4 says: "产品级上限：≤ 5 分钟" and "本值与 §9.4.2 的短时令牌有效期、§3.5.1 的访客链接缓存 TTL 是同一个全局配置项"

These three are consistent. ✓

### 4. Outdated expressions

Let me search for the listed expressions:

1. "技术上不可达" - Let me check:
   - §0.4: "绕过在技术上不可达（⚠️ 该强主张已于 v2.6 收窄，见 §0.7 与 §9.6.3）" - This is in a historical context with a warning. OK.
   - §0.6: "§9.6.3「技术上不可达」因此只是期望而非构造性保证" - Historical context. OK.
   - §0.7: "「任何绕过通道的写入或部署在技术上不可达」" - Historical context (describing what v2.5 said). OK.
   - §4.1.1 三: "「任何绕过通道的写入或部署在技术上不可达」 | ❌ 不成立，v2.6 已删除该表述" - Historical. OK.
   - §9.6.3: "v2.5 此处曾写「任何绕过通道的写入或部署在技术上不可达」。该表述已在 v2.6 删除。" - Historical. OK.
   - §9.12: "「绕过通道在技术上不可达」无构造性依据" - Historical (describing v2.4 review finding). OK.

   I don't see it used as a current claim. ✓

2. "构造性保证" - Let me check:
   - §0.6: "§9.6.3「技术上不可达」因此只是期望而非构造性保证" - Historical. OK.
   - §0.7: "把 §9.6.3...从「期望」升级为「构造性保证」" - Historical. OK.
   - §9.12: "「绕过通道在技术上不可达」无构造性依据" - Historical. OK.
   - §5.7.3 (v2.8 addition): "对搭建者与员工是构造性的" - This is a current claim but in a different sense (about the nature of the constraint, not a "guarantee"). Let me check if this is problematic...
   
   Actually, "构造性的" here means "structural/by construction" - i.e., the constraint is inherent to the architecture. This is different from "构造性保证" as a security guarantee. I think this is acceptable usage.

3. "插件不得绕过 §9.2" - Let me check:
   - §0.7: "可绕过 §9.2 的唯一执行点与 §9.6 的发布通道" - This is describing what §9.10 says (that plugins CAN bypass). OK.
   - §4.1.1 四: "§9.10 已承认其可绕过 §9.2 的唯一执行点与 §9.6 的发布通道" - Describing the fact. OK.
   - §9.2 范围声明: "§9.10 的引言自己写明插件「可绕过 §9.2 的唯一执行点」" - Quoting §9.10. OK.
   - §9.6.3 范围声明: "插件是进程内任意代码，可绕过 §9.2 的唯一执行点与本条发布通道" - Describing the fact. OK.
   - §9.10.2: "~~插件不得访问业务数据面~~ → 改为：插件运行在控制面" - Strikethrough, historical. OK.
   - §9.10.2 v2.7 correction: "「不得绕过 §9.2」「不得访问业务数据面」作为保证性条款被删除" - Historical. OK.
   - §9.12: "§9.10.2「插件不得绕过 §9.2」自我否定" - Historical (describing the problem). OK.

   I don't see it used as a current claim. ✓

4. "插件不得访问业务数据面" - Let me check:
   - §9.10.2: "~~插件不得访问业务数据面~~" - Strikethrough. OK.
   - §9.10.2 v2.7: "「不得访问业务数据面」作为保证性条款被删除" - Historical. OK.
   - §0.9 item 16: "§4.1.1 四 残留旧措辞「插件不得访问业务数据面」" - Describing the fix. Let me check §4.1.1 四...
   
   §4.1.1 四 says: "不承诺插件不触碰业务数据面" - This is the corrected version. ✓

5. "七项地基" - Let me check:
   - §0.7: "§5.7.3「七项」地基实为八项" - Historical (describing the error). OK.
   - §5.7.3: "此处原写「七项」并只列举七项" - Historical. OK.
   - §9.12: "§5.7.3「七项地基」实为八项" - Historical. OK.
   
   Current §5.7.3 says: "§9.1 所列全部地基项" - no number. ✓

6. "三类数据" - Let me check:
   - §0.6: "三类数据三个归属 + 三条不可协商规则" - This is describing v2.5's addition. But wait, v2.6 changed it to "四类数据四归属". Let me check if this is still used as a current claim...
   
   §0.6 is describing what v2.5 did. The current state is "四类数据四个归属" (§4.6.1). The §0.6 reference is historical (describing the v2.5 change). OK.

   Actually wait - §0.6 says "新增存储拓扑基线：三类数据三个归属 + 三条不可协商规则" - this is describing what v2.5 added. But v2.6 then changed it to four categories. Since §0.6 is a revision log entry describing what v2.5 did, this is historically accurate (v2.5 did add "three types"). The current state is four. This is fine as a historical record.

7. "三条规则" - Let me check:
   - §0.6: "三类数据三个归属 + 三条不可协商规则" - Historical (v2.5). But current §4.6.2 says "四条不可协商的规则". So v2.6 added a 4th rule. The §0.6 reference is historical. OK.

8. "绕不过" - Let me check:
   - §0.9 item 6: "§9.8.1「绕不过」未同步范围声明" - Describing the fix. Let me check §9.8.1...
   
   §9.8.1 says: "对搭建者与员工不存在产品接口内的绕过路径" - This is the corrected version. ✓
   
   Let me search for "绕不过" as a current claim... I don't see it used as a current claim anywhere. ✓

### 5. §0.9 claims 20 items - let me verify each

§0.9 lists 20 items. Let me check each one exists in the body:

1. §9.6.2 增列第五类「插件安装/注册/激活」- I can see in §9.6.2: "插件安装 / 注册 / 激活（v2.8 新增）" ✓
2. §10.4 改为「六轮」- Wait, §10.4 says "七轮评审的发现已全部处理". Let me re-read...

Actually, §0.9 item 2 says: "§10.4 残留「四轮」→ 改为「六轮」"

But looking at §10.4: "七轮评审的发现已全部处理，写入 §9 安全设计"

Wait, this is confusing. The item says it was changed to "六轮" but the actual text says "七轮". Let me re-read the item:

"| 2 | **阻断** | §10.4 残留「四轮」 | 改为「六轮」 | **§10.4** |"

But §10.4 currently says "七轮". So either:
- The fix was to change "四轮" to "六轮" (at the time of v2.7→v2.8 transition, when there were 6 rounds of review completed), and then... wait, no.

Let me think about this more carefully. The rounds are:
- Round 1: v2.1 review
- Round 2: v2.2 review
- Round 3: v2.3 review
- Round 4: v2.4 review
- Round 5: v2.5 review
- Round 6: v2.6 review
- Round 7: v2.7 review

So by the time v2.8 is being written (after round 7), there have been 7 rounds of review. §10.4 should say "七轮".

But §0.9 item 2 says the fix was "改为「六轮」". This is WRONG. At the time of v2.8, there have been 7 rounds of review (the 7th being the one that produced v2.8). So §10.4 should say "七轮", not "六轮".

Wait, let me re-read. The item says:
"| 2 | **阻断** | §10.4 残留「四轮」 | 改为「六轮」 | **§10.4** |"

And the actual §10.4 text says: "七轮评审的发现已全部处理"

So the actual text says "七轮" but the revision log says it was changed to "六轮". This is a contradiction! The revision log (item 2) says the fix was to change to "六轮", but the actual text says "七轮".

Hmm, wait. Let me reconsider. Maybe the timeline is:
- v2.7 was produced after round 6
- v2.8 is produced after round 7
- When v2.7 was being written, there had been 6 rounds of review, so §10.4 should have said "六轮"
- But v2.7 had "四轮" (a residual error)
- v2.8 fixes it

But wait, the §0.9 item is describing what v2.8 does. At the time v2.8 is written, there have been 7 rounds of review. So §10.4 should say "七轮".

Actually, I need to be more careful. Let me re-read the §0.9 item:
"| 2 | **阻断** | §10.4 残留「四轮」 | 改为「六轮」 | **§10.4** |"

This says the fix is to change "四轮" to "六轮". But the actual §10.4 text says "七轮". 

This is a genuine inconsistency! The revision log says the fix was to "六轮" but the actual text says "七轮". 

Wait, unless I'm miscounting. Let me recount:
- v2.1: first review (round 1)
- v2.2: second review (round 2)  
- v2.3: third review (round 3)
- v2.4: fourth review (round 4)
- v2.5: fifth review (round 5)
- v2.6: sixth review (round 6)
- v2.7: seventh review (round 7)

So after v2.7 (which is the result of round 7), there have been 7 rounds. v2.8 is the result of fixing round 7's findings. So §10.4 should say "七轮".

But the revision log item 2 says "改为「六轮」". This is wrong - it should be "七轮".

Actually wait, let me re-read more carefully. The §0.9 section is titled "v2.8：第七轮复评（冻结前最终验证）后修订". So v2.8 is the result of the 7th round. The 7th round found the error in §10.4 (which said "四轮"). The fix should be to "七轮" (since 7 rounds have now been completed).

But the revision log says "改为「六轮」". This is an error in the revision log itself! The actual text in §10.4 says "七轮" which is correct, but the revision log item 2 incorrectly describes the fix as "改为「六轮」".

This is a real inconsistency between the revision log (§0.9 item 2) and the actual text (§10.4).

Actually, wait. Let me re-read §10.4 one more time:

"七轮评审的发现已全部处理，写入 §9 安全设计（总览见 §9.12）"

Yes, it says "七轮". And the revision log says the fix was "改为「六轮」". This is a contradiction.

Hmm, but maybe I'm wrong about the counting. Let me look at it from another angle. The §9.12 section says "七轮评审的发现已全部处理" and lists rounds 1-7. So 7 rounds is correct.

The revision log item 2 in §0.9 says "改为「六轮」" - this is simply wrong. It should say "改为「七轮」".

This is a genuine error in the revision log. The actual text is correct ("七轮") but the description of the fix is wrong ("六轮").

3. §9.12 末段 - Let me check. §9.12 ends with: "故本版仍需独立验证（v2.6 已经第六轮复评，见 §0.8；当前版本状态见 §0.9）。"

The item says: "§9.12 末段残留「v2.6 仍需独立验证」→ 改为「本版仍需独立验证」并指向 §0.9"

Looking at the actual text: "故本版仍需独立验证（v2.6 已经第六轮复评，见 §0.8；当前版本状态见 §0.9）。"

This says "本版仍需独立验证" and references §0.9. ✓ (The fix has been applied.)

4. §4.6 小节顺序 - I verified above that 4.6.1→4.6.2→4.6.3→4.6.4 is correct. ✓

5. §0.7 自相矛盾 - I verified above that §0.7 now says "其中仅 qwen3.8 发现". ✓

6. §9.8.1「绕不过」- §9.8.1 says "对搭建者与员工不存在产品接口内的绕过路径" ✓

7. §10.1 红线总表 - I can see the v2.8 addition about plugin exceptions. ✓

8. §5.7.3 - I can see the v2.8 addition about plugin scope. ✓

9. §9.4.4 本地防篡改缓冲 - I can see the v2.8 addition about boundary. ✓

10. §4.6.4 防本地篡改 - I can see: "防存储介质被带外篡改；不防御进程内篡改" ✓

11. §9.6.3 接口清单 - I can see the rewritten version with 9 items (was 7, now 9 with two new ones). ✓

12. §9.6.4 预授权与离线 R3 - I can see: "离线窗口内预授权不生效——R3 一律阻塞" ✓

13. 三处 TTL 一致 - I verified above that §9.4.2, §3.5.1, and §9.4.4 all reference the same 5-minute value and same config item. ✓

14. M5 未列入 §10.3 - I can see M5 in §10.3. ✓

15. §9.4.4 补偿语义 - I can see the v2.8 correction about R2. ✓

16. §4.1.1 四 残留旧措辞 - §4.1.1 四 says "不承诺插件不触碰业务数据面" ✓

17. §9.2 依赖条款 - I can see the v2.8 correction: "包括但不限于 §9.3...§9.6...§9.7...§9.8.1...§9.9...§9.11.3...以及红线 1/2/4" ✓

18. §9.4.4 离线审计负向测试 - I can see: "缺失批次必须告警并标记该段不可验证、乱序或跨序回链被拒、本地缓冲不可写入时失败关闭、离线窗口内 R3 被拒。（后四项 v2.8 补充）" ✓

19. §9.12 第六轮表漏 §0.8 第 12 项 - Let me check §9.12's sixth round table...

Looking at §9.12's sixth round table, I see 12 items listed. Let me count:
1. §9.10.2 自我否定
2. §9.2 与红线 4 未同步
3. §9.4.4 离线窗口与审计链冲突
4. 补偿只能检测不能撤销
5. §4.6.4 服务接口契约未定义
6. 交付后无检测
7. §9.12 标题「四轮」
8. §5.7.3 引入版本
9. 无绕过缺可测试接口清单
10. 残留窗口无数值
11. 插件与交付指纹
12. 阶段五验收锚点

That's 12 items. And §0.8 lists 12 items. Let me verify they match...

§0.8 items:
1. §9.10.2 自我否定 ✓
2. §9.2 与红线 4 未同步 ✓
3. §9.4.4 离线窗口与审计链冲突 ✓
4. 补偿只能检测不能撤销 ✓
5. §4.6.4 服务接口契约未定义 ✓
6. 交付后无检测 ✓
7. §9.12 标题「四轮」 ✓
8. §5.7.3 引入版本 ✓
9. 无绕过缺可测试接口清单 ✓
10. 残留窗口无数值 ✓
11. 插件与交付指纹 ✓
12. 阶段五验收锚点 ✓

They match. ✓

20. §0.8 第 7 项描述 - §0.8 item 7 says: "§9.12 标题「四轮」但正文五轮 | 先改为「五轮」，再随本轮新增第六轮记录改为「六轮」"

The item 20 in §0.9 says: "§0.8 第 7 项描述（「改为五轮」）与最终结果（六轮）不符 | 更正描述"

Looking at §0.8 item 7: "先改为「五轮」，再随本轮新增第六轮记录改为「六轮」"

Hmm, this actually does say "六轮" as the final result. So the description in §0.8 item 7 already accounts for the final result being "六轮". But §0.9 item 20 says the description was wrong and needed correction. Let me re-read...

§0.9 item 20: "§0.8 第 7 项描述（「改为五轮」）与最终结果（六轮）不符 | 更正描述"

But §0.8 item 7 actually says: "先改为「五轮」，再随本轮新增第六轮记录改为「六轮」"

This seems to already be corrected (it mentions both "五轮" and "六轮"). So either:
- The correction has already been applied (the text now shows the corrected version), or
- The §0.9 item 20 description is slightly inaccurate about what the original error was.

I think the correction has been applied - the text now correctly shows the progression. ✓

Now let me look for other issues...

### Additional issues I've found:

**Issue 1: §0.9 item 2 says "改为「六轮」" but §10.4 says "七轮"**

This is a clear inconsistency. The revision log describes the fix as changing to "六轮" but the actual text says "七轮". One of them is wrong.

Given that 7 rounds of review have been completed (rounds 1-7), the correct number is "七轮". So the revision log item 2 is wrong - it should say "改为「七轮」" not "改为「六轮」".

**Issue 2: §9.12 says "七轮评审的发现已全部处理" but the last paragraph says "v2.6 已经第六轮复评，见 §0.8；当前版本状态见 §0.9"**

Wait, let me re-read the last paragraph of §9.12:
"故本版仍需独立验证（v2.6 已经第六轮复评，见 §0.8；当前版本状态见 §0.9）。"

This says "v2.6 已经第六轮复评" - but v2.6 is the result of the 5th round of review (v2.5 was reviewed in round 5, producing v2.6). Wait, no:

- v2.5 was produced after round 4
- v2.5 was reviewed in round 5, producing v2.6
- v2.6 was reviewed in round 6, producing v2.7
- v2.7 was reviewed in round 7, producing v2.8

So "v2.6 已经第六轮复评" means "v2.6 has already been through the 6th round of review" - this is correct (v2.6 was reviewed in round 6).

And "当前版本状态见 §0.9" - this points to the v2.8 section. ✓

Actually wait, I need to re-read this. The sentence is:
"故本版仍需独立验证（v2.6 已经第六轮复评，见 §0.8；当前版本状态见 §0.9）。"

"本版" refers to v2.8 (the current version). "v2.6 已经第六轮复评" is a parenthetical explaining that v2.6 (an earlier version) has already been through 6 rounds. This is a bit confusing but not wrong.

Actually, I think the sentence structure is: "This version still needs independent verification (v2.6 has already been through the 6th round of review, see §0.8; current version status see §0.9)."

This is saying: even though v2.6 went through 6 rounds, this version (v2.8) still needs verification. That makes sense. ✓

**Issue 3: Let me check the §9.12 header more carefully**

§9.12 says: "七轮评审的发现已全部处理（v2.1 对抗性 / v2.2 复评 / v2.3 复评 / v2.4 复评·实现者视角 / v2.5 修订验证 / v2.6 对抗验证＋一致性）。"

Wait, this lists 6 items in the parentheses: v2.1, v2.2, v2.3, v2.4, v2.5, v2.6. But it says "七轮". Where's the 7th?

Looking further down, there's a section "第七轮（v2.7 复评，冻结前最终验证，三份评审｜判定：不通过）" - so the 7th round IS listed in the body. But the header parenthetical only lists 6. This is a minor inconsistency - the header should list all 7 or just say "七轮" without the parenthetical.

Actually, re-reading: "七轮评审的发现已全部处理（v2.1 对抗性 / v2.2 复评 / v2.3 复评 / v2.4 复评·实现者视角 / v2.5 修订验证 / v2.6 对抗验证＋一致性）。"

The parenthetical lists 6 items (v2.1 through v2.6), but the text says "七轮". The 7th round (v2.7) is not in the parenthetical. This is an inconsistency - either the parenthetical is incomplete or the count is wrong.

Since the body of §9.12 does include the 7th round table, the count "七轮" is correct, but the parenthetical is incomplete (missing v2.7).

**Issue 4: Let me check the version table at the top**

The version table shows:
- v2.1: 第一轮评审基线
- v2.2: 按第一轮结论修订
- v2.3: 按第二轮复评结论修订
- v2.4: 按第三轮复评结论修订
- v2.5: 按第四轮复评结论修订
- v2.6: 按第五轮复评结论修订
- v2.7: 按第六轮复评结论修订
- v2.8: 按第七轮复评结论修订

This is consistent. 7 rounds of review, 8 versions. ✓

**Issue 5: Let me check §0.9's claim about the tool**

§0.9 says: "该工具已当场抓到 3 处人工漏掉的错误（§4.6 小节顺序、§9.12 版本残留、§10.4 轮次残留）"

These correspond to items 2, 3, and 4 in the v2.8 revision list. ✓

**Issue 6: Let me check if "四轮" appears anywhere as a current claim**

Searching... I don't find "四轮" used as a current claim. It appears in:
- §0.8 item 7: "§9.12 标题「四轮」但正文五轮" - historical
- §0.9 item 2: "§10.4 残留「四轮」" - describing the error
- §9.12: "§9.12 标题「四轮」与正文五轮不符" - historical (in the 6th round table)

These are all historical references. ✓

**Issue 7: Let me verify the §9.6.3 interface list**

The v2.8 version has 9 items (was 7 in v2.7, added items 8 and 9). Let me verify:
1. 搭建舱（Builder）API
2. 工作台（Workbench）API
3. 发布通道端点
4. 命令行工具（CLI）的写入面
5. 配置文件写入面
6. 身份层的账号/权限管理端点
7. 契约存储的直接读写面
8. 插件安装 / 注册 / 激活端点（v2.8 补）
9. 业务系统侧的契约激活端点（v2.8 补）

9 items. The text says "新增接口面须登记入本清单" - good.

But wait, in §0.9 item 11, it says: "重写为分项断言；补插件安装端点与契约激活端点；先分清两套权限体系"

And in §9.6.3, the text says: "⚠️ v2.8 重写原因：v2.7 版对全部 7 项用了同一条断言"

So v2.7 had 7 items, v2.8 has 9 items (added 2). ✓

**Issue 8: Let me check the "七轮" vs "六轮" issue more carefully**

The §0.9 revision log item 2 says: "§10.4 残留「四轮」 | 改为「六轮」"

But §10.4 actually says: "七轮评审的发现已全部处理"

And §9.12 says: "七轮评审的发现已全部处理"

So the actual text says "七轮" but the revision log says the fix was to "六轮". This is a clear error in the revision log.

The correct fix should have been "改为「七轮」" because by the time v2.8 is written, 7 rounds of review have been completed.

**Issue 9: Let me check if there are any TODO or placeholder items**

Searching for "TODO", "vX.Y", "待补充", "待定"...

I don't find any obvious TODOs or placeholders. The document seems complete.

**Issue 10: Let me check the §9.12 last paragraph more carefully**

"故本版仍需独立验证（v2.6 已经第六轮复评，见 §0.8；当前版本状态见 §0.9）。"

Wait, this is in §9.12 which is part of v2.8. "本版" = v2.8. "v2.6 已经第六轮复评" - this is saying v2.6 has been through 6 rounds of review. But v2.6 was produced after round 5, and then reviewed in round 6. So v2.6 has been through rounds 1-6 (6 rounds). That's correct.

But the sentence is a bit confusing. It's saying "this version (v2.8) still needs independent verification" and then parenthetically noting that v2.6 already went through 6 rounds. The implication is that even though previous versions went through many rounds, this one still needs verification. That's fine.

**Issue 11: Let me check the §0.9 "20 items" claim**

§0.9 says "v2.8 修改的 20 项" and then lists 20 items in a table. Let me count the rows: 1-20. ✓

**Issue 12: Let me check if the "9 类检查" claim for the tool is consistent**

§0.9 says: "共 9 类：小节编号顺序、交叉引用有效性、表格列数、转义管道符、评审轮次一致性、版本状态残留、废弃表述残留、自称条数与表行数、结构完整性。"

Let me count: 1. 小节编号顺序, 2. 交叉引用有效性, 3. 表格列数, 4. 转义管道符, 5. 评审轮次一致性, 6. 版本状态残留, 7. 废弃表述残留, 8. 自称条数与表行数, 9. 结构完整性. That's 9. ✓

But wait, the task description says the tool checks "9 类问题：小节编号顺序、交叉引用有效性、表格列数、版本状态残留、已废弃表述残留、自称条数与表行数、结构完整性、评审轮次一致性" - that's only 8 items listed in the task description. The PRD lists 9 (adding "转义管道符"). The task description might have just omitted one. I'll go with the PRD's list of 9.

**Issue 13: Let me check the §9.12 "七轮" parenthetical issue again**

§9.12 header: "七轮评审的发现已全部处理（v2.1 对抗性 / v2.2 复评 / v2.3 复评 / v2.4 复评·实现者视角 / v2.5 修订验证 / v2.6 对抗验证＋一致性）。"

The parenthetical lists: v2.1, v2.2, v2.3, v2.4, v2.5, v2.6 = 6 items.
But the text says "七轮".

The 7th round (v2.7 复评) is NOT in the parenthetical. This is an inconsistency.

However, looking at the body of §9.12, the 7th round IS included (there's a table for "第七轮（v2.7 复评...）"). So the content is correct, but the header parenthetical is incomplete.

**Issue 14: Let me check the review count in §0.7 methodology**

§0.7 says: "此后 7 份评审（v2.3 复评 2 + v2.4 复评 1 + v2.5 复评 4）审的都是含此错误的版本"

2 + 1 + 4 = 7. ✓

And: "其中仅 qwen3.8（本地 27B，完整性交叉检查视角）发现"

This is consistent with the v2.5 round having qwen3.8 as one of the 4 reviewers. ✓

**Issue 15: Let me check if there's a "M4" reference that's consistent**

M4 is defined in §10.3: "采用 KVVI-Builder 的「公司即租户」组织模型"

§4.5 references M4: "租户模型（v2.1 已修正，见 §10.3.1）"
§10.3.1 is titled "Q6 修正说明（M4）"

These are consistent. ✓

**Issue 16: Let me check the §0.6 reference to "M5"**

§0.6 item 4: "M5：Node 为生产权威，Python 降级为开发期交叉验证；Docker 骨架不含 Python 运行时"

And §4.6.3 title: "验证器引擎的运行时权威（M5 新增，v2.5）"

And §10.3: "M5 | 验证器引擎的运行时权威：Node 为生产权威..."

These are consistent. ✓

**Issue 17: Let me check the §5.3 "M5" reference**

§5.3: "并入策略（阶段一交付物之一，M5）"

This is where I'm confused. M5 is about the validator engine authority, but the "并入策略" is about moving MetaSchema assets into the repo. These are related (the validator is part of what gets moved) but not the same thing.

Actually, I think the parenthetical "(阶段一交付物之一，M5)" is saying that this merge strategy is a stage-1 deliverable that is related to M5 (because the validator is part of what gets merged). It's not saying the merge strategy IS M5. It's saying it's a deliverable associated with M5.

But this is confusing. The merge strategy is more naturally associated with M1 (MetaSchema as contract). I'll flag this as a minor clarity issue.

Actually, re-reading more carefully, I think the "M5" in the parenthetical might be a mistake. The merge strategy (moving assets into the repo) is a consequence of M1 (MetaSchema as the contract), not M5 (validator engine authority). The validator is just one of the assets being moved.

I'll flag this as a minor issue.

**Issue 18: Let me check the §9.4.4 "≤ 5 分钟" consistency**

§9.4.2: "有效期 ≤ 5 分钟（与 §9.4.4 的产品级上限同一配置项）"
§9.4.4: "产品级上限：≤ 5 分钟"
§3.5.1: "上限 ≤ 5 分钟，与 §9.4.4 同一配置项、同一处置"

All three say ≤ 5 minutes and reference the same config item. ✓

**Issue 19: Let me check the §9.6.3 "9 items" vs any other reference to the count**

§0.9 item 11 says: "重写为分项断言；补插件安装端点与契约激活端点"
§9.6.3 has 9 items.
§0.8 item 9 says: "列出 7 项产品接口面" (this was v2.7's version)

So v2.7 had 7, v2.8 has 9. The revision log correctly describes the change. ✓

**Issue 20: Let me check if "§9.12 第六轮表漏 §0.8 第 12 项" (item 19) is resolved**

§0.8 item 12: "阶段五验收锚点未含 §9.4.4 / §9.4.5 的负向测试 | 补入 | §7.1"

§9.12 sixth round table, last row: "阶段五验收锚点未含 §9.4.4 / §9.4.5 的负向测试 | ✅ 已补入 | §7.1"

Yes, it's there. ✓

Now let me move to **Task B: Auditing the check_prd.py tool**

### Task B Analysis

The tool checks 9 categories:
1. 小节编号顺序 (subsection numbering order)
2. 交叉引用有效性 (cross-reference validity)
3. 表格列数 (table column count)
4. 转义管道符 (escaped pipe characters)
5. 评审轮次一致性 (review round consistency)
6. 版本状态残留 (version status residuals)
7. 废弃表述残留 (deprecated expression residuals)
8. 自称条数与表行数 (self-claimed count vs. table row count)
9. 结构完整性 (structural integrity)

**Blind spots:**

1. **Semantic consistency between sections**: The tool can check if "§X" exists and if a cross-reference points to a real section, but it CANNOT check if the CONTENT of §X matches what §Y claims about it. For example:
   - §0.9 item 2 says the fix was "改为「六轮」" but §10.4 actually says "七轮". The tool would check that §10.4 exists and that "七轮" is a valid round number, but it cannot verify that the revision log's description matches the actual text.
   - §9.12's parenthetical lists 6 rounds but the text says "七轮". The tool might check that "七轮" appears, but it cannot verify that the parenthetical is complete.

2. **List counting within prose**: The tool checks "自称条数与表行数" (self-claimed count vs. table row count). But what about:
   - A sentence that says "以下 N 项" followed by a non-table list?
   - A claim like "三处须一致" where the "三处" refers to specific sections that need to be verified?
   - The §9.12 parenthetical listing 6 items when the text says "七轮" - this is a count mismatch within prose, not a table.

3. **Placeholder/TODO detection**: The tool doesn't seem to check for:
   - "TODO" markers
   - "vX.Y 新增" placeholders
   - "待定" or "待补充" markers
   - Empty table cells that should have content

4. **Logical consistency**: The tool cannot check:
   - Whether two sections make contradictory claims
   - Whether a "range declaration" in one section is properly reflected in all dependent sections
   - Whether the "two permission systems" distinction in §9.6.3 is consistently applied throughout

5. **Cross-section semantic alignment**: For example:
   - §9.2 says "包括但不限于 §9.3, §9.6, §9.7, §9.8.1, §9.9, §9.11.3, 以及红线 1/2/4" - the tool can check these sections exist, but cannot verify that each of those sections actually has a corresponding scope declaration for plugins.
   - §10.1 says "红线 1/2/4 的保证范围均为「搭建者与员工」" - the tool cannot verify that §9.2, §9.3, §2.5.3 all have matching scope declarations.

6. **The "same config item" claim**: §9.4.2, §3.5.1, and §9.4.4 all claim to reference "the same global config item" for the 5-minute TTL. The tool can check that all three mention "5 分钟" and "同一配置项", but it cannot verify that they're actually referring to the same logical entity (since the actual config item name isn't specified).

**False positive check:**

The tool reports "全部核查通过". Let me check a few things it claims to have verified:

1. **Subsection numbering order**: §4.6.1→4.6.2→4.6.3→4.6.4 is correct. §9.4.1→9.4.2→9.4.3→9.4.4→9.4.5 is correct. ✓

2. **Cross-reference validity**: I've checked many cross-references and they all point to existing sections. ✓

3. **Table column count**: I've checked several tables and they appear to have consistent column counts. ✓

4. **Review round consistency**: The tool would check that "七轮" appears consistently. But as I found, §0.9 item 2 says "改为「六轮」" while §10.4 says "七轮". If the tool checks for "轮次一致性", it should have caught this! Unless the tool only checks that the NUMBER "七" appears in the right places, not that the revision log's description matches.

Actually, this is a key finding: **the tool claims to check "评审轮次一致性" but it apparently did NOT catch the discrepancy between §0.9 item 2 ("改为「六轮」") and §10.4 ("七轮")**. This is either:
- A blind spot (the tool checks that "七轮" appears in §10.4 but doesn't cross-check the revision log's description), or
- The tool considers "六轮" in the revision log as a historical reference (describing what the fix was at the time) and doesn't flag it.

But wait - if the fix was to change "四轮" to "六轮", and the actual text says "七轮", then either:
- The fix was applied incorrectly (should have been "七轮" not "六轮"), or
- The revision log description is wrong (should say "改为「七轮」")

Either way, this is an inconsistency that the tool's "评审轮次一致性" check should have caught but didn't. This is a significant blind spot.

Actually, let me reconsider. Maybe the tool checks that all instances of "N轮" in the document are consistent with the total number of rounds. If the total is 7, then "七轮" is correct and "六轮" would be flagged. But the tool reports "全部核查通过" - so either:
- The tool doesn't check the revision log descriptions, or
- The tool considers "六轮" in the revision log as a valid historical reference (since at the time of the fix, maybe the author thought it was 6 rounds)

This is a genuine blind spot.

**Self-verification concern:**

The tool was written by the same author who wrote the document. This creates several concerns:

1. **The tool encodes the author's understanding of what to check**: If the author doesn't realize a type of error is possible, the tool won't check for it. For example, the "revision log description vs. actual text" mismatch is a type of error the author may not have considered.

2. **The tool's "all green" is necessary but not sufficient**: It can catch mechanical errors (wrong numbering, broken references) but cannot catch semantic errors (contradictory claims, incomplete scope declarations, logical gaps).

3. **The tool cannot verify its own completeness**: There's no meta-check that says "have we checked all possible types of errors?"

4. **The tool's value is real but bounded**: It catches the specific types of errors the author has made before (counting, version numbers, section references). It does NOT catch:
   - New types of errors introduced by new content
   - Semantic inconsistencies
   - Missing content that should be there
   - Logical contradictions between sections

**My assessment of "工具通过 ≠ 文档正确":**

The tool is a useful safety net for the specific mechanical errors the author has repeatedly made. However:
- It cannot replace independent review
- It cannot catch semantic inconsistencies
- It cannot verify that all required content is present
- It cannot check logical consistency across sections
- Its "all green" status gives false confidence if taken as proof of correctness

The boundary is: **the tool verifies structural and mechanical consistency; it does NOT verify semantic correctness, completeness, or logical consistency.**

### Summary of issues found:

**Blocking:**
1. §0.9 item 2 says "改为「六轮」" but §10.4 actually says "七轮" - the revision log description is wrong.

**Important:**
2. §9.12 header parenthetical lists only 6 rounds (v2.1-v2.6) but the text says "七轮" - the parenthetical is incomplete (missing v2.7).
3. The check_prd.py tool's "评审轮次一致性" check apparently did not catch the §0.9/§10.4 discrepancy - this is a blind spot.

**Suggestions:**
4. §5.3 "并入策略（阶段一交付物之一，M5）" - the M5 reference is confusing since M5 is about validator engine authority, not about asset merging.
5. The tool should add a check for "revision log description vs. actual text" consistency.

Let me also check if there are any other issues I might have missed...

**Issue 21: Let me check the §9.12 "七轮" count one more time**

The §9.12 section has tables for:
- v2.1 评审 (8 items: A1-A8)
- v2.2 复评 (12 items: S3-S12)
- v2.3 复评 (8 items)
- v2.4 复评 (5 items)
- v2.5 复评 (19 items)
- v2.6 复评 (12 items)
- v2.7 复评 (18 items)

Wait, let me recount the v2.7 table in §9.12:
1. 插件安装审批通道引用落空
2. §10.4 残留「四轮」
3. §9.12 末段残留
4. §4.6 小节顺序错乱
5. §0.7 自相矛盾
6. §9.8.1「绕不过」
7. §10.1 红线总表
8. §5.7.3
9. §9.4.4 本地防篡改
10. §4.6.4 防本地篡改
11. §9.6.3 接口清单
12. 预授权与离线 R3
13. 三处 TTL 一致
14. M5 未列入 §10.3
15. §9.4.4 补偿语义
16. §4.1.1 四 残留旧措辞
17. §9.2 依赖条款
18. §9.4.4 离线审计负向测试

That's 18 items. But §0.9 lists 20 items for v2.8. Let me check...

Oh wait, §9.12's v2.7 table lists the findings FROM the 7th round review (which produced v2.8). And §0.9 lists the 20 fixes made in v2.8. These should be the same set (or very close).

Let me compare:
§0.9 has 20 items. §9.12's v2.7 table has 18 items.

The difference: §0.9 items 19 and 20 are:
19. "§9.12 第六轮表漏 §0.8 第 12 项 | 补行 | §9.12"
20. "§0.8 第 7 项描述（「改为五轮」）与最终结果（六轮）不符 | 更正描述 | §0.8"

These two items are about fixing §9.12 and §0.8 themselves - they're meta-fixes (fixing the revision log). They wouldn't appear in §9.12's v2.7 table because they're about the revision log, not about the product content.

So 18 + 2 = 20. That makes sense. ✓

**Issue 22: Let me verify the §9.12 v2.7 table item 2**

§9.12 v2.7 table item 2: "§10.4 残留「四轮」 | ✅ 改为「七轮」 | §10.4"

Wait! This says "改为「七轮」"! But §0.9 item 2 says "改为「六轮」"!

So:
- §0.9 item 2: "§10.4 残留「四轮」 | 改为「六轮」"
- §9.12 v2.7 table item 2: "§10.4 残留「四轮」 | ✅ 改为「七轮」"
- §10.4 actual text: "七轮评审的发现已全部处理"

So §9.12 says the fix was to "七轮" (correct), §10.4 says "七轮" (correct), but §0.9 says the fix was to "六轮" (WRONG).

This confirms that §0.9 item 2 has an error. The correct description should be "改为「七轮」" not "改为「六轮」".

This is a clear, verifiable error in the revision log.

**Issue 23: Let me check if the tool would have caught this**

The tool checks "评审轮次一致性". If it checks that all mentions of round numbers are consistent, it should have flagged:
- §0.9 says "六轮"
- §9.12 says "七轮"
- §10.4 says "七轮"

The fact that it reported "全部核查通过" means either:
1. The tool doesn't check the revision log descriptions (§0.x sections), or
2. The tool only checks that the FINAL state is consistent (i.e., §10.4 says "七轮" which is correct) and doesn't cross-check the revision log's description of the fix, or
3. The tool has a bug.

This is a significant blind spot. The tool's "评审轮次一致性" check is not as comprehensive as claimed.

**Issue 24: One more check - the "9 类" vs the task description's "8 类"**

The task description says: "它检查 9 类问题：小节编号顺序、交叉引用有效性、表格列数、版本状态残留、已废弃表述残留、自称条数与表行数、结构完整性、评审轮次一致性。"

That's 8 items listed. But the PRD says 9 (adding "转义管道符"). The task description might have just omitted one. I'll go with the PRD's list of 9.

Actually, re-reading the task: "它检查 9 类问题：小节编号顺序、交叉引用有效性、表格列数、版本状态残留、已废弃表述残留、自称条数与表行数、结构完整性、评审轮次一致性。"

Let me count: 1. 小节编号顺序, 2. 交叉引用有效性, 3. 表格列数, 4. 版本状态残留, 5. 已废弃表述残留, 6. 自称条数与表行数, 7. 结构完整性, 8. 评审轮次一致性. That's 8.

But the PRD says 9: adding "转义管道符". So the task description lists 8 but says "9 类". This is a minor discrepancy in the task description, not in the PRD. I'll ignore it.

**Final assessment:**

The document is largely well-structured and consistent. The main issues I found are:

1. **Blocking**: §0.9 item 2 says "改为「六轮」" but should say "改为「七轮」" (confirmed by §9.12 which correctly says "七轮" and by §10.4 which correctly says "七轮").

2. **Important**: §9.12 header parenthetical is incomplete (lists 6 rounds, should list 7).

3. **Important (tool audit)**: The check_prd.py tool's "评审轮次一致性" check did not catch the §0.9/§9.12/§10.4 discrepancy, revealing a blind spot in the tool.

4. **Suggestion**: §5.3's "M5" reference in the merge strategy section is confusing.

5. **Tool audit**: The tool has significant blind spots for semantic consistency, revision log accuracy, and cross-section logical alignment.

Now let me also think about whether v2.8 can be frozen:

Given that:
- There's 1 blocking issue (the "六轮" vs "七轮" in §0.9)
- The tool has demonstrated blind spots
- OpenAI family has been absent for 2 consecutive rounds (a coverage gap)
- The document is otherwise well-structured

I would say: **v2.8 cannot be frozen yet** due to the blocking issue in §0.9, but it's very close. The fix is trivial (change "六轮" to "七轮" in §0.9 item 2).

Actually, wait. Let me reconsider whether this is truly "blocking" or "important". The error is in the revision log (§0.9), not in the product requirements themselves. The actual product content (§10.4, §9.12) is correct. So this is a documentation accuracy issue, not a product design issue.

However, the PRD's own standard is "全部评审零阻断" for freezing. And this is a factual error in the document. I'll classify it as "important" rather than "blocking" since it doesn't affect the product design, but it does affect the document's internal consistency.

Actually, re-reading the review criteria: "判定标准：全部评审零阻断。" The question is whether this error would be classified as "阻断" by a reviewer. I think it's borderline - it's a factual error in the revision log that contradicts another part of the same document. I'll put it as "important" since it's a documentation error, not a design error.

Let me finalize my response.