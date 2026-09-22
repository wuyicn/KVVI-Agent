Let me carefully analyze this PRD from the perspective of an implementer who needs to start work tomorrow. The review task is very specific: I'm the tech lead who received this PRD today, and I need to determine if it's sufficient to start implementation.

Let me go through the review questions systematically:

### 一、能不能直接开工

1. **First module to write?** According to §7.1, Phase 1 (基座就位): clone and build DSH source, run `pnpm build` / `pnpm build:web`, integrate 13 MetaSchemas and dual-engine validators, project skeleton + Docker one-click start (0B-1). 

But wait - the PRD says (§1.2, §6.2) that cloning, building, starting, and initial brand replacement are ALREADY DONE (本机实测, committed to vendor/dsh kvvi branch commit a9edf55). So Phase 1 is partially complete. The remaining Phase 1 work: MetaSchema integration, dual-engine validator integration, project skeleton, Docker.

Issues for Phase 1:
- "接入 13 份 MetaSchema 与双引擎验证器" - the MetaSchemas live in KVVI-Builder project at `.worktrees/0a-5-meta-schemas/contracts/meta-schemas/0a-full-r1/` (§5.3) - these are in ANOTHER project's worktree. How do they get into the KVVI project? Vendored? Git submodule? Copied? Not specified. Also the dual-engine validators are Python 17 modules + Node 13 modules at `tools/meta-schema/{python,node}/` in KVVI-Builder. The KVVI project is TypeScript/Node per §1.2. Is the Python validator runtime needed in the KVVI repo? Which engine is authoritative at runtime? The PRD doesn't say.
- Docker one-click start (0B-1) - this references KVVI-Builder task 0B-1 whose spec I can't see (external dependency, mark as such).

2. **§7 roadmap phases - which is insufficient?**

Phase 1: partially done, remaining items reference external assets - has the gap above but roughly actionable.

Phase 2 (品牌与外壳): replace brand elements, builder console shell online, confirm own pages accessible. Given Q5 (reuse DSH native shell), this is fairly actionable. Though "确认自有页面可访问" is a weak deliverable.

Phase 3 (搭建引擎模式): 5 Skills, command engine (0C-7), page compiler (0C-2), minimal form + compile preview (0A-13), de-industry check (0A-14), AI blueprint loop (0D-1). These reference KVVI-Builder task IDs whose specs are external. The PRD says Skills output MetaSchema-validated artifacts. But: what does "可用搭建舱" mean as acceptance? Not defined.

Phase 4 (身份与隔离): self-built account system, two-level authorization, 0B security foundation block (login/company selection, RLS multi-company isolation, form permission, field permission, five-tier data scope, flow permission, money precision, unique doc numbers, audit), account lifecycle, identity source adapter, dual-gateway isolation. This is 7 weeks (11-17). This is a HUGE phase. The deliverable "双模式可隔离运行" is a description not an acceptance criterion.

Key gap: the PRD never says what tech stack the self-built identity layer uses. DSH is TypeScript. The 0B tasks come from KVVI-Builder which used PostgreSQL RLS. But wait - KVVI-Agent is built on DSH (TypeScript), while KVVI-Builder is a different project (appears to be Python + PostgreSQL?). The dual-engine validators are "Python 17 模块 + Node 13 模块". What database does the KVVI runtime use? DSH's session persistence - what storage does it use? The PRD never states the database for the KVVI platform itself. RLS implies PostgreSQL for the business systems (from KVVI-Builder contract 0A-7). But where do KVVI accounts live? Where do audit logs live (append-only hash chain or WORM per §9.11.2)? This is a real blocker for Phase 4.

Actually, wait. Let me think about the deeper architectural issue. The architecture says: KVVI platform (forked DSH) + independently deployed business systems (produced by the builder engine). The business systems are generated from MetaSchema contracts. But WHO/WHAT materializes a business system from the contracts? There's `0C-1` BusinessSchema 数据运行时 (Phase 5), `0C-2` ViewSchema 编译器/页面运行时 (Phase 3), `0C-7` command engine (Phase 3). These tasks come from KVVI-Builder and are presumably meant to be built... in what language? As part of KVVI runtime? As standalone deployable? The PRD says business systems are independently deployed (Q1). So the runtime for business systems must be packaged and deployed per system. But the deployment architecture - is each business system a separate container with its own PostgreSQL? Does the publishing channel (§9.6.3) generate and deploy these? None of this is specified.

This is the elephant in the room for question 5: §9.2 requires "唯一服务端策略执行点" - the single server-side policy enforcement point. WHERE does this live? The business system is independently deployed. So the enforcement point must live in the business system (the data runtime 0C-1). But the KVVI PRD can't guarantee the generated business system implements it... unless the data runtime is a fixed, platform-provided component that all generated systems use. If so, the PRD should say: the business system runtime is a KVVI-provided immutable component, and generation only produces configuration/contracts, not code. Actually §5.6 says artifacts are declarative contracts, not executable code - good. So business systems = KVVI-provided runtime + contracts. But the PRD NEVER states this explicitly! It says "搭建产出的业务系统独立部署" without defining what the deployable unit is composed of. For an implementer: what do I deploy as "the business system"? A container image containing the data runtime + view runtime + contracts? This is a critical gap.

3. **Deliverables: descriptions or acceptance criteria?**

- Phase 1: "可构建、可启动、可校验的自有基座" - description, though partially verifiable (build passes, starts, validator runs). Moderately checkable.
- Phase 2: "KVVI 自有 Web 外壳" - pure description.
- Phase 3: "可用搭建舱" - description. "可用" undefined.
- Phase 4: "双模式可隔离运行" - description.
- Phase 5: "Agent 可安全操作独立部署系统" - description, though red lines and negative tests in §9 give some teeth (red line 8: acceptance by tests). But no phase-level test list.
- Phase 6: "可交付员工使用的系统" - description.
- Phase 7: "可交付客户的产品" - description.

Red line 8 says acceptance by tests, all green. But no test inventory per phase is defined. The 0B/0C/0D task specs presumably have acceptance criteria in KVVI-Builder (external, can't verify).

### 二、接口是否闭合

4. **Contract handoff from builder engine to worker-mode agent:**

The PRD says (§2.5.3 工程结论): api-spec Skill's product is the integration seam; agent doesn't touch DB, only reads/writes via this contract. §4.1 shows the seam: 接口契约 (api-spec 产物) with 鉴权/授权/If-Match/Idempotency-Key.

Gaps:
- FORM: what is the contract artifact? §5.1 says api-spec targets `tool-spec` + `app-model-command` MetaSchemas. OK so it's MetaSchema JSON files. But where do they live? How does the runtime get them?
- TIMING/PROTOCOL: when are they published? §9.6.3 says "发布是唯一生效通道" but the publish channel's mechanics (what it publishes, to where, how the business system receives and activates them) are... delegated to 技术设计文档? §9.12 lists "发布服务与运行时的读写边界" as transferred to tech design doc. Hmm, but that's about read/write boundaries of the publish service. The basic question "what does publishing mean for an independently deployed system" - is it deploy a new container? Push contract files to a running system? Hot reload? - is not a mere implementation detail; it's an architecture-level decision that determines what Phase 5 builds. Actually I need to be careful: is this PRD-level or tech-design-level? The PRD explicitly established the boundary (§0.5): PRD defines what, tech design defines how. But for an implementer starting tomorrow, "发布通道" mechanics matter at the architecture level: does the publish channel deploy/version business systems? The PRD says "任何绕过通道的写入或部署在技术上不可达" (§9.6.3) - which implies the publish channel controls deployment. But the deployment target is independently deployed business systems. So the publish channel must reach into independently deployed systems. For local deployments (Q7), this is all in one environment presumably. The interface contract for "独立部署" (question 4b): who defines the Agent↔business-system interface? The api-spec Skill generates it per system. Who implements the server side? The 0C-1 data runtime? Who validates? The PRD's answer is implicit: the contract is generated by the builder engine and consumed by both the agent (client side, 接口契约客户端 §4.3) and the business system runtime. But who VALIDATES that the deployed business system actually conforms to the contract (that the runtime correctly implements FieldPolicy etc.)? Red line 8 requires tests, but conformance testing of generated systems isn't specified anywhere. Actually §9.2's differential test (差分测试) covers UI vs Agent parity. But that tests the KVVI agent path against the UI path of the SAME business system - who builds the business system's UI? The 0C-2 page compiler. OK.

So the contract handoff: form = MetaSchema JSON (specified), timing = at publish (specified as the only channel), protocol = unspecified (file drop? registry? deploy artifact?). The "接口契约客户端" is listed as self-built in §4.3 but its counterpart (server side in business system) is 0C-1/0C-2 from KVVI-Builder - external specs.

5. **§9.2's enforcement point ownership:**

As analyzed above: the enforcement point must be in the business system (since agent doesn't touch DB, and the business system is independently deployed). The KVVI PRD guarantees it via... nothing explicit. The guarantee would be: the business system's server side is a KVVI-controlled runtime component (not generated code), and contracts are declarative. §5.6 supports this reading ("搭建产出物是声明式契约，不是可执行代码"), and "修改运行时的地基" is forbidden to builders. But nowhere does the PRD say "业务系统的服务端运行时由 KVVI 统一提供，不随搭建生成" - the closest is the foundation list (§9.1) which includes 权限校验 (authorization decision logic itself) as foundation that building can't modify. So implicitly the enforcement point is part of the KVVI-provided runtime. But for an implementer, this needs to be explicit because it determines what gets deployed. I'll flag it as 重要 (should-fix), arguing the architecture statement is missing: "每个独立部署的业务系统 = KVVI 提供的运行时 + 契约配置"。Without this sentence, an implementer might think each generated system includes generated server code - and then §9.2 is unenforceable.

Hmm wait, actually let me re-read §4.1: "业务系统（独立部署，由搭建引擎产出）数据层 │ 状态机 │ 权限与可见性 │ 读视图与聚合口径". So the business system has a data layer, state machine, permissions, views. "由搭建引擎产出" - produced by the builder engine. If the whole thing including data layer is produced by the builder... produced as what? Contracts + runtime? This is genuinely ambiguous. Given §5.6 says artifacts are declarative contracts not code, the runtime must come from somewhere - 0C-1 (BusinessSchema 数据运行时, Phase 5) and 0C-2 (page runtime, Phase 3). So the platform builds these runtimes once, and each business system deploy = runtime + contracts. I think this reading is right, but the PRD doesn't state the deployable composition. Flag it.

### 三、技术选型的空白

6. **Tech selection gaps:**

- Database for KVVI platform (accounts, sessions, audit): unspecified. DSH's session persistence - what storage does it use? (External, can't verify.) The PRD requires RLS → PostgreSQL for business data. Audit requires append-only + hash chain or WORM (§9.11.2). Where? Unspecified. For Phase 4 start (week 11), the DB decision is blocking. Actually is it blocking NOW (day 1)? Phase 1 is build DSH + integrate MetaSchema + skeleton + Docker. The skeleton (0B-1) presumably includes DB choices from KVVI-Builder. KVVI-Builder is a completed project (0A done, 0B-1 to be done in phase 1). Hmm, 0B-1 "项目骨架 + Docker 一键启动" is assigned to Phase 1 - so KVVI-Builder's skeleton hasn't been built yet. The KVVI-Agent repo and KVVI-Builder repo relationship: are they merging into one repo? §0.2 says KVVI-Builder is merged as existing assets. Are the deliverables two products or one? The MetaSchemas and validators live in KVVI-Builder's worktrees. Repo strategy (monorepo? vendor?) is unspecified. For day 1, the implementer needs to know: do I create a new repo that vendors DSH (already done at vendor/dsh) AND copies KVVI-Builder assets? Where do the 13 MetaSchemas live in the new project? Not specified - blocker for Phase 1 completion but easily fixed by a decision.

- Language consistency: DSH is TypeScript. KVVI-Builder validators exist in Python and Node. 0C-1/0C-2/0C-7 runtimes - what language? If KVVI-Builder was a Python project (the samples are YAML, the validator is Python-first?), then the business runtime might be Python/FastAPI with PostgreSQL. But the KVVI product is TypeScript. Two stacks in one product? The PRD doesn't say. This is a genuine "开工即卡住" for Phase 3/5 planning but maybe not day 1. Actually for an implementer planning the whole build, this is a big one: the dual-engine validator has both Python and Node implementations - which one does the platform use at runtime (§5.3 says dual-engine validators run in the validation pipeline)? Both? For what purpose (cross-validation)? c14n has "双实现" (0A-4) too. The PRD says validators are tested and pass - but integration into a TypeScript product is unspecified.

- "聚合口径" implementation: unspecified - config format is presumably in view-schema/聚合口径配置 (§5.1). OK contract-level, fine.

- Interface contract client: listed as self-built (§4.3), fine as a to-build item; but its auth mechanism is the delegation token (§9.4) - JWT-type, asymmetric. Token format "作为接口契约的一部分固定（JWT 类）" - "JWT 类" is vague but tech-design level. OK.

- 自建账号体系 tech: unspecified (session cookies? OIDC provider? password hashing?) - tech design level mostly, but password storage/session mechanism choices are routine. I'd say this can be decided during implementation - not a blocker.

7. **§9.6.3 "发布是唯一生效通道" under independent deployment:**

The publish channel must be the only way for permission policies, data scopes, tool enablement, aggregation calibers to take effect. But business systems are independently deployed - meaning the KVVI platform and business system are separate processes/services. So "publish" = pushing contracts to the business system through one channel. Questions: who hosts the publish channel (KVVI side? business system side?)? How does the business system receive new contract versions - pull or push? How is "通道外无路径" enforced technically (e.g., business system's contract store is read-only except via signed publish API)? §9.12 says "发布服务与运行时的读写边界" went to tech design doc. And "配置发布的签名绑定" also went to tech design. Hmm. So the PRD deliberately punted these. But the question asks "怎么落地" - as an implementer, the minimal PRD-level answer needed: the business system only activates contracts delivered through the publish channel, versioned, and the channel enforces diff report → approval → publish order. Actually the PRD does say this at the constraint level (§9.6.3 table). The mechanics (signed bundles, API endpoint, mTLS?) are tech design. I think this is defensible as-is, BUT there's a product-level hole: in local/offline deployment (Q7), the business system and KVVI platform are both on-premise - fine. But is the publish channel part of KVVI platform or part of each business system? If a customer has one KVVI instance and N business systems, publishing to each... The PRD doesn't define whether contracts are embedded at build time (system "generated" then deployed) or hot-published to running systems. "上线后" language in §1.1 suggests systems go live then employees use them; §9.6.3 requires publish channel for permission changes - implying post-deployment updates flow through publish. So hot-update of contracts must exist. This is architecture-relevant: the business system runtime must support contract versioning/hot reload. Not stated. I'd fold this into the enforcement-point/deployable-composition issue as one blocking gap: "业务系统的构成与发布通道的部署形态未定义".

Hmm, but I must be careful about the PRD's stated boundary: §0.5 says implementation-level requirements go to tech design doc. Is "business system composition" implementation-level or design-level? I'd argue it's architecture/design level (product structure), not code-level detail. The PRD defines Q1 (independent deployment) but doesn't define what the deployed unit is. For an implementer this is blocking because Phase 3 builds the page compiler/runtime and Phase 5 the data runtime - without knowing they form a standalone deployable, you can't scope them. I'll flag as blocking but acknowledge the tech-design-doc boundary for mechanics.

### 四、最先撞上的坑

8. **Three most likely problem spots:**

a) DSH改造的深度：身份层、模式路由、会话绑定要 fork 改造 DSH (TypeScript, 12k files, alpha quality 0.1.6-alpha.2). DSH has no multi-user concept (§2.3 confirmed: only dsh-anonymous-user-id). Injecting per-user auth, per-session company binding, per-mode tool assembly into an alpha-stage upstream fork = merge hell + upgrade pain. The PRD notes upstream churn risk (§10.2) and locks version. But the deeper risk: DSH's Agent Preset is a session-level snapshot (§2.6.1), which helps modes; but session persistence, tool registration etc. were designed single-user. Retrofitting multi-tenancy into session/persistence layers is the riskiest unknown. And nobody can estimate it from the PRD; phases 4-5 (12 weeks) may blow up.

b) 契约运行时的一致性（红线1的落地点）：§9.2 single enforcement point requires the business system server to uniformly enforce identity/tenant/row-scope/field-policy/action/state-machine. The differential test requires UI and agent paths to be identical. Building the data runtime (0C-1) + command engine (0C-7) + page runtime (0C-2) such that UI-generated requests and agent-generated requests converge on one endpoint - this is where red line 1 lives or dies. Also field-level MASKED/HIDDEN enforcement across read views and aggregations (data leak via aggregates - §9.8.1 invariant check). This is the most technically subtle part: five-tier data scope injection into every read view; 404 uniformity (§9.3); aggregate invariant checking (can't see aggregate unless can see individuals - this check is actually non-trivial to compute! §9.8.1 requires machine-checking "users who can view the aggregate can also access the constituent individuals" - given five-tier scopes and field policies, computing this is a real algorithm). Flag as risk: the A6 invariant check may be harder than expected and has no spec (went to tech design).

c) 工期与人力：30-31 weeks estimated. But for whom? The PRD mentions Q5 reuse to cut work. No team size stated anywhere! Round 1 review found "无人力假设" per §0.5 table ("第 1 轮 设计空洞：无人力假设、注入、越权") - wait, it says round 1 findings included 无人力假设 (no staffing assumption). Did v2.2+ fix that? Searching the PRD... I don't see any staffing assumption in v2.4. §7.1 gives weeks per phase but not headcount. So 30-31 周 is elapsed time with unspecified team size. For an implementer being asked to commit to this schedule: with how many people? The PRD fixed "无人力假设" how? Maybe they considered it out of scope. It's still missing. Also phase 4 is 7 weeks for an enormous scope (account system + two-level auth + RLS + 5-tier scope + field/mask + flow perms + money + doc numbers + audit + lifecycle + adapter + dual-gateway). That's the phase most likely to overrun.

d) Sample-driven validation: 家具「报货申请」样例 (0C-6) and 黄金样例 (0D-2) in phase 6 - the end-to-end proof. Also 去行业化自查 (0A-14) is in phase 3 but the 报货样例 is furniture industry - fine.

Let me pick three: (1) DSH fork multi-user retrofit + upstream alpha drift; (2) the single enforcement point / contract runtime (red lines 1/2/4 machine-enforcement, incl. the A6 invariant algorithm); (3) identity+security foundation phase 4 scope vs 7 weeks, plus no staffing assumption for the 30-31 week estimate. Also could mention: two-language stack (Python validators vs TypeScript product) integration cost; publish channel + contract hot-versioning in independent deployments.

9. **Reason to reject the schedule:**

If I were to reject: "阶段四+阶段五共13周承载了全部红线与安全机制，但 PRD 未定义业务系统运行时的部署形态与技术栈，0B/0C 任务的真实验收标准在外部文档，无法据此承诺 30-31 周。" Also: the PRD itself defers a list of mechanism designs (§9.12 transfer list: 确认凭证、发布读写边界、防呆、地基不变量判定、脱敏执行点、密钥轮换、配置签名绑定) to a tech design doc that doesn't exist yet - and red line 8 (acceptance by tests) can't be satisfied without those. The honest rejection: "在《技术设计文档》完成前，阶段四、五的工期不可承诺；且 PRD 未给出人力假设，30-31 周无法核算。"

### 五、最终判断

10. Is it ready? 

My judgment: This PRD is unusually thorough at the product-requirement and security-constraint level. But from the implementer's chair, there are a few architecture-level holes that block actual work:

Blocking (must fix before start):
1. 业务系统的构成未定义 (what is the independently-deployed unit; who provides its server runtime; consequently §9.2's enforcement point ownership is implicit, not guaranteed). Related: publish channel's deployment shape (how contracts reach and activate in an independently deployed system; contract versioning).
2. KVVI 平台自身的存储/技术栈未定义 (DB for accounts/audit; RLS implies PG for business data; but platform DB, audit WORM store, and the Python-vs-Node validator/runtime stack split are unstated). Plus repo strategy for merging KVVI-Builder assets (MetaSchema location, vendoring).
3. 0B/0C/0D 任务验收标准依赖外部文档 - the phase deliverables are descriptions, and the actual acceptance criteria live in KVVI-Builder task specs which are external. Red line 8 demands test-based acceptance; the PRD provides phase "deliverables" that are not acceptance conditions. For phases 1-2 you can start; but "明天开工" on the full roadmap requires those specs. Hmm - is this blocking for day 1? Day 1 is phase 1, whose tasks are largely verifiable (build passes, validator integrated, docker starts). The acceptance for phase 1 is OK-ish. But phases 3-6 are 24 weeks of the 30. Since the PRD says KVVI-Builder is "已签署 Go-0, PRD v1.11" - those task specs exist and are signed. As a reviewer I can't verify (external). So mark as "依赖外部资料，无法核实" rather than blocking? The instruction says: if judgment depends on external materials, mark it. The 0B/0C/0D tasks ARE part of this merged PRD's roadmap (M3), and their content is only referenced by ID. Whether that's blocking depends on whether implementers have access - they presumably do (same org). I'll mark it as 重要 with the external-dependency note, not blocking.

Also the staffing assumption: is that blocking? The question 9 asks for rejection reasons. A schedule without headcount is not committable. I'd put it as blocking for the schedule commitment specifically, or at minimum 重要. Hmm. Round 1 found it, §0.5's table lists it as round-1 finding... but I see no fix in v2.4. Actually wait - let me re-read: "第 1 轮 | 设计空洞 | 无人力假设、注入、越权". So round 1 found "no staffing assumption" as a design hole. Did v2.2/v2.3/v2.4 address it? §0.3 lists v2.2's revisions: internal consistency (8), concept ownership (6), §9 security (8), session binding (5). No staffing. §0.4 v2.3: security-focused. §0.5 v2.4: 8 design items. No staffing. So the PRD found the hole in round 1 and never fixed it (or decided it's out of scope silently). That's a legitimate finding: 工期有周数无人力. For an implementer asked to commit, this matters. But is it "blocking to start work"? You can start phase 1 regardless. It's blocking for committing to the 30-31 week schedule. I'll phrase carefully: blocking for排期承诺, not for phase 1.

Actually the prompt question 1 asks: "按 PRD 的描述，第一个要写的模块是什么？写它之前必须先确定哪些、而 PRD 没有确定的事？" First module: per §7.1 phase 1: DSH build (done), MetaSchema + dual-engine validator integration, project skeleton + Docker. Before writing: (a) repo strategy - where do MetaSchema/validators live in the KVVI repo (they're currently paths inside KVVI-Builder worktrees); (b) which validator engine (Python/Node) is authoritative in the pipeline, and whether Python runtime is a build dep; (c) what 0B-1 skeleton contains (external spec); (d) Docker target environment for 本地/云 both. Also: DSH fork strategy going forward - vendor branch kvvi exists; how do upstream updates flow (lock version noted, upgrade eval process "建立升级评估流程" is a to-do, fine).

Also for question 2, which phase is least actionable: I'd say Phase 5 (契约授权与运行时) because its core (data runtime 0C-1, ContextGraph/ImpactReport/Policy Checker 0C-8, AI 越权防护 0D-4) are all external task IDs + the enforcement-point architecture is undefined; and Phase 4 because "0B 安全地基整块" is 9 tasks from another project. But also Phase 3's five Skills: inputs natural language, outputs MetaSchema-valid contracts - the Skill engineering (prompt design, validation loop, blueprint loop 0D-1) is genuinely underspecified in the PRD, but is that PRD's job? The PRD defines capabilities; how to build the AI skills is implementation. Hmm, the acceptance ("可用搭建舱") is the weak part.

Let me also check some things the discipline section warns about: don't fabricate. Let me verify each claim I make against the text.

Claim: "PRD 未定义 KVVI 平台自身的数据库" - searching PRD for database mentions: "PostgreSQL RLS" (§4.5, §9.1 租户策略 mentions RLS 隔离规则, §10.3.1 "公司即租户 + PostgreSQL RLS 隔离"), DSH 会话持久化 (reused, storage unspecified). 审计防篡改存储 §9.11.2 "追加写 + 哈希链 或 WORM 存储；不得为可随意 UPDATE/DELETE 的普通表" - 普通表 implies a DB but doesn't say which. So yes: PG is named for tenant RLS (business data side), but the platform-side stores (accounts, sessions, audit) have no named technology. And whether the business runtime's data layer is PG for every generated system - implied by RLS but RLS is per-tenant; per-business-system DBs vs shared cluster? Unspecified. Good claim, verifiable.

Claim: "业务系统部署单元构成未定义" - §4.1 diagram, Q1 "搭建产出的业务系统独立部署". What is deployed is not stated. §5.6 says artifacts are declarative contracts. 0C-1/0C-2 runtimes exist as tasks. The composition statement is missing. Also "页面编译器" (0C-2) - compiles views to what? Vue prototype exists in KVVI-Builder (0a-13). Target framework for production page runtime: unspecified. That's tech design though.

Claim: "§9.2 执行点归属" - the PRD says "UI 与 Agent 必须调用同一个业务命令端点，由服务端统一执行全部校验" (§9.2). "服务端" here = the business system's server. The PRD's guarantee mechanism: foundation includes 权限校验 logic (§9.1) and building can't touch it; contracts are declarative. So implicitly the enforcement point is platform-provided. But "如何保证它被实现" - via red line 8 tests + differential tests §9.2(3). OK there IS an answer: differential testing. But the ownership statement (this endpoint is part of KVVI-provided runtime, present in every generated system by construction) is unstated. I'll frame as: PRD 靠差分测试兜底，但没有从架构上声明执行点由 KVVI 运行时提供——实现者可能把校验逻辑生成进各业务系统，导致 N 份实现。Actually more precisely: the risk is the implementer builds it in the data runtime (0C-1) - that's fine and singular. I think this is 重要 not 阻断. Hmm. But combined with the deployable-composition gap, the two together are blocking-ish. Let me structure: Blocking #1 = 业务系统部署单元与发布通道形态未定义（含 §9.2 执行点归属、契约如何到达并生效、版本化）。That bundles question 5 and 7.

Claim: "MetaSchema 资产路径在 KVVI-Builder 的 worktree 里" - §5.3: `.worktrees/0a-5-meta-schemas/contracts/meta-schemas/0a-full-r1/` - yes, a worktree path inside KVVI-Builder project (~/Documents/KVVI-Builder per §0.2). How these become part of KVVI-Agent repo/build: unspecified. True.

Claim: "无人力假设" - verified above; the 30-31 week number exists without headcount. Also single-person? The PRD tone suggests a solo/small team project ("你代部署", "我方"). No statement. True.

Claim about deliverables being descriptions: verified per phase. Phase 1's is semi-verifiable. Also note: even phase 1's "可校验" - validator runs against contracts, fine.

Claim re: §9.6.3 + independent deployment: §9.12 transfers "发布服务与运行时的读写边界" and "配置发布的签名绑定" to tech design. So the PRD consciously punted; the question is whether what remains is enough. What's missing at design level: whether contracts hot-update running systems or require redeploy; whether publish channel is a KVVI-side service with business-system-side receiver; version/rollback semantics (publish failures, version mismatch with delegation token's 授权版本?). Actually interesting: §9.4 token binds 授权版本; 授权版本 changes invalidate tokens. 授权版本 presumably bumps on publish. The linkage between publish and authorization version is not stated. Hmm, that's a decent detail: "授权版本"由谁维护、何时递增 - unstated. Is it PRD-level? It's a mechanism glue. I could mention in 重要 under token/publish linkage. Or leave to tech design. I'll mention briefly.

Claim: Phase 4 scope vs 7 weeks - §7.1 phase 4 weeks 11-17 = 7 weeks, includes自建账号体系+两级授权+0B-2~0B-10 整块+生命周期+适配器+双网关隔离. That's big; the PRD itself says 0B is "平台真实工作量，原先未纳入" and "最不能省". Flag as top schedule risk.

Claim: 双引擎 validator 的角色 - §5.3 "调用双引擎验证器" in §5.6 allowed tools; §5.3 says dual-engine validators (Python 17 + Node 13). Why two engines? KVVI-Builder presumably built both for cross-checking (0A-4 c14n 双实现). Which runs in KVVI's pipeline? Unspecified. Also the runtime enforcement (field policies etc.) is not the validator - validator is for contracts at build/publish time. Fine.

Also: what about the 工作台 (workbench)? §4.2: 工作台 is the business system's UI with embedded agent. The workbench UI is generated by the page compiler (0C-2) from view-schema. But wait - §7.3/Q5 says DSH native chat shell is reused for 搭建舱. What hosts the agent chat UI inside the generated business system? "Agent 对话区 两种模式共用组件" (§4.2). So the chat component must be embeddable into generated pages. The page compiler's component whitelist (0A-6 组件注册表) presumably includes it? External. Not blocking to note briefly? Maybe skip - getting deep into externals.

Another check - question 4b: "系统独立部署时，Agent 与业务系统之间的接口契约由谁定义、谁实现、谁验证？" PRD answers: defined by api-spec Skill (builder side, generated); implemented server-side by 0C-1/0C-7 (data runtime + command engine) - but those are KVVI-Builder tasks, so implemented as platform components; client side by 接口契约客户端 (§4.3 self-built); verified by 差分测试 (§9.2) + red line 8. So the PRD mostly answers this! The residual gap: conformance verification that a deployed business system matches its published contract version (version skew between agent's contract client and the deployed system). Version negotiation/handshake between agent and business system is not mentioned anywhere. If business system is at contract v3 and agent cached v2... The publish channel + contract versioning would handle, but unstated. Good concrete gap: 契约版本协商/兼容策略缺失. Add to the publish-channel blocking item.

Also Q11 (delivery method) is open - PRD says non-blocking for phases 1-6. Fine, agree.

Also: 访客/外部填写者 (§3): "仅表单，无 Agent 交互" - how do external visitors authenticate? Anonymous link? Token? Accountless? §3.1 table says 访客 can 填表. The identity layer must support unauthenticated form filling with some share-link mechanism. Not specified anywhere! §9 doesn't discuss visitor access security (form abuse, spam submissions, rate limits for anonymous). §9.11.3 rate limiting is per-account. Visitor submissions - the form's public endpoint security is unspecified. Is this blocking? It's a real product surface (external form filling is in the role table). For phases: forms exist in phase 3/6. The visitor access model (link + token? expiry? CAPTCHA?) is a product-level gap. I'd put as 重要. Hmm, actually is visitor in首版 scope? §3 role table includes 访客/外部填写者. §2.4/§5.2 don't mention. 0C tasks don't obviously include public forms. Might be out of首版 de facto. The PRD should state whether visitor form-filling is in首版 and its access model. 重要-level.

Let me also double-check "第一模块" answer: PRD §7.1 phase 1 first task - DSH clone/build already done (§1.2/§6.2 L4 note: "已完成的是取源、构建、启动与初步品牌替换的验证"). So the first thing to WRITE: MetaSchema + validator integration and project skeleton (0B-1). Good.

Now the 覆盖范围自述 must list things I checked and found OK, plus external-dependency items. Things OK:
- §9.3/§9.9 租户注入两层表述 - consistent now (model layer no tenant, server layer injected).
- §9.4.2 token invalidation rules - adequately specified at constraint level.
- §9.6.4.1 R1/R2/R3 closed list - closed, good.
- §3.3 离职交接 - thorough, including drafts' 归属接管人 (L6 closed).
- §2.6 session binding - clear.
- §9.7 A1 stance honest and enforceable at PRD level.
- Q4/Q12 vs M4 layering - clear three levels.
- Money type decision - clear.
- 五档数据范围封闭 - good for machine checks.
- Red line 8 test-based acceptance principle - good, but phase acceptance criteria missing.
- §7.4.4 consequences disclosure - honest.

External unverifiable: 0B-1~0B-10, 0C-1~0C-8, 0D-1~0D-8 task specs; KVVI-Builder PRD v1.11; MetaSchema 13 份内容; 验证器实测声明; DSH 仓库内容与插件机制实测声明; 组件注册表 0A-6.

Now let me also sanity-check a couple of "potential fabrications" I should avoid:
- Does §5.5 lack money? No, money is in the list (§5.5). Don't claim that.
- Does §3.3 handle unsubmitted drafts? Yes, extensively. Don't claim that.
- Is 审计防篡改 covered? Yes §9.11.2 at constraint level (hash chain or WORM). Implementation unspecified - but that's consciously tech-design. Careful not to demand it in PRD.
- 密钥管理: §9.4.1 covers asymmetric signing, trust anchor, rotation with dual-key period. Good at constraint level.

Now severity classification. The format: 阻断 (must fix or can't start), 重要 (should fix), 建议 (optional).

阻断 candidates:
1. 业务系统的部署单元与发布通道形态未定义（§9.2 执行点归属、契约下发/版本/生效机制、独立部署下的唯一通道落地）。Without this, phases 3/5/6 can't be scoped; and it's design-level (architecture), not tech-design-doc level. Actually can they "start" tomorrow? Phase 1-2 yes. But the question's standard is "这份文档是否足以让我直接动手" for the project. Hmm. I should be precise: it blocks phases 3+ planning and phase 5 implementation; phase 1 can start. I'll still class as 阻断 because it must be fixed before the relevant phases and it's architecture-level; PRD is the right place. Alternatively class as 重要 with note that phase 1 can start. The instructions: 阻断 = 必须修，否则不能开工. Given phases 1-2 (4 weeks) can proceed, strictly "不能开工" is too strong for the whole project... but the review's spirit: these are the gaps that will stop engineering. The publish/enforcement-point issue will stop phase 5 cold and retrofitting is expensive (the runtime built in phase 3 must be designed for it). Since phase 3 (page compiler/runtime) starts week 5 and the deployable composition affects phase 3's design, the decision is needed within ~4 weeks of start. I'll put it as 阻断 with the nuance stated (不阻塞第 1-4 周，阻塞阶段三设计与阶段五实现；属必须在开工初期补齐的架构决策). Hmm, but format-wise "阻断（必须修，否则不能开工）" - I'll define blocking as "不开工就能改，开工后返工代价大/直接卡住近期阶段". I think it's fine; I'll note nuance inside.

2. KVVI 平台侧存储与技术栈未决（账号/会话/审计存哪；业务数据侧 PG/RLS 与每系统独立部署的关系——单库多系统 or 每系统一库；Python/Node 双栈在 TS 产品中的取舍）。This blocks phase 4 concretely (7 weeks of identity/RLS work) and phase 1 skeleton choices (0B-1 Docker compose needs DB service). Actually 0B-1 skeleton is phase 1 - the Docker one-click start presumably includes the DB. KVVI-Builder chose PG (0A-7). So platform DB = PG? Likely, but PRD doesn't say KVVI 账号/审计 live in PG too. For the skeleton in phase 1 (first 2 weeks!), the DB decision is needed. That's genuinely "开工即卡住" for 0B-1. 阻断.

3. 资产归并与仓库策略未定义（MetaSchema/验证器/样例从 KVVI-Builder worktree 进入 KVVI 仓库的方式与权威位置）。Blocks phase 1's "接入 13 份 MetaSchema 与双引擎验证器" - well, you can copy them, but the authoritative-source question (single source of truth across two repos) matters for a PRD that makes a big deal of single truth source. This is small but truly day-1. Is it 阻断 or 重要? It's a decision, quick to make, but PRD should state it. I'd say 阻断-lite... Let me put as 重要? The instruction says 阻断 = 不修不能开工. You CAN copy the files and start; the risk is drift. Hmm. But phase 1's task IS "接入 13 份 MetaSchema 与双引擎验证器" - to do it you must decide how. Any decision works to start; so it's not strictly blocking. 重要.

4. 人力假设缺失 vs 30-31 周排期承诺. For "开工" itself not blocking; for committing schedule, blocking. The prompt Q9 asks for rejection reason; Q1/Q2 focus on ability to work. I'll put as 重要 (应修) but cite it in the final verdict as must-fill before committing the schedule. Hmm, the final verdict section asks: 列出必须在开工前补齐的项（而不是可以边做边定的项）. If I'm strict about "开工前": repo strategy + platform stack (for phase 1 skeleton) + business-system composition/publish architecture (needed by week 3-4 before phase 3 design; arguably "边做边定" within first month but must be deliberate). Staffing: before signing the schedule, not before writing code.

Let me reconsider: the deliverable acceptance criteria issue (phases' deliverables are descriptions; red line 8 requires test-based acceptance; the real criteria are in external task specs). For an implementer, "可用搭建舱" gives no Done definition. But if KVVI-Builder task specs have acceptance criteria (likely, given that project's rigor), then fine. I can't verify → mark 依赖外部资料. I'll make it 重要 with the external note: PRD 应至少把各阶段验收钩子指向具体任务/测试清单，或声明以 KVVI-Builder 任务验收为准.

Let me also reconsider question 3 demands: "逐阶段判断" deliverable as description vs acceptance condition - I should include this in the answer, maybe as a compact table inside the verdict or in one of the items. The output format is fixed (阻断/重要/建议 + 覆盖范围自述 + 总体判断). I can embed the per-phase table within a 重要 item about acceptance criteria. Good.

Also question 8's three pits and question 9's rejection reason need homes. I can put "最先撞上的坑" as... the format doesn't have a section for them. Hmm. The output format is strict: 总体判断, 阻断, 重要, 建议, 覆盖范围自述. The 10 questions must be answered through these sections. So: Q1→ answered within blocking items (first module + missing decisions). Q2/Q3 → 重要 item on phase actionability + per-phase deliverable table. Q4/Q5/Q7 → blocking item on contract/publish/enforcement. Q6 → blocking item on tech stack. Q8 → embed in relevant items or a 重要 "风险" item. Q9 → use in 总体判断 or a dedicated 重要 item? I could add to 覆盖范围自述? No. Better: make one 重要 item "排期不可承诺的理由" covering staffing + external acceptance + phase 4/5 concentration (answers Q9 and Q8c). Q10 → final 总体判断 sentence must carry the verdict; the "必须补齐" list = the 阻断 items. Good.

Now let me draft the items precisely with citations.

---

**总体判断** (≤60字): 契约与安全约束已足够细，但业务系统的部署形态、平台技术栈与阶段验收标准三处未闭合——第 1-2 周可开工，整体排期不可承诺。

Count: roughly 55 chars. OK.

---

**阻断 1: 业务系统的部署单元、契约下发与 §9.2 执行点归属未定义**

- 位置: §4.1、§2.5.3(工程结论)、§9.2、§9.6.3、Q1(§10.3)
- 原文: Q1「搭建产出的业务系统独立部署；Agent 通过接口契约按权限操作它」；§9.2「UI 与 Agent 必须调用同一个业务命令端点，由服务端统一执行全部校验」；§9.6.3「任何绕过通道的写入或部署在技术上不可达」
- 问题: PRD 说业务系统"独立部署、由搭建引擎产出"，但从未说明部署单元的构成——是"KVVI 统一提供的运行时（0C-1/0C-2/0C-7）＋声明式契约"，还是每个系统生成独立服务端代码？§5.6 只说了产出物是声明式契约，可推出前者，但没有一句架构声明。由此三个连锁缺口：(1) §9.2 的"唯一服务端策略执行点"落在业务系统侧，KVVI 拿什么保证每个产出系统都有且仅有这一个执行点——只能靠"运行时由平台统一提供"这一构造性保证，而 PRD 没写；(2) 契约从搭建舱到运行中业务系统的传递形式、时机、协议全部未定（§9.12 把"发布服务与运行时的读写边界"转给了技术设计文档，但"部署单元是什么、契约热更新还是重新部署"是架构决策不是实现细节）；(3) 契约版本与协商缺失——§9.4 令牌绑定"授权版本"，但授权版本由谁维护、何时随发布递增、Agent 端契约客户端与业务系统版本不一致时如何拒绝，全文无着落。
- 建议: 在 §4.1 增加架构声明："每个业务系统 = KVVI 平台提供的不可变运行时 + 经发布通道下发的契约包；搭建不产出服务端代码"，并定义发布的最小语义（契约包版本化、发布即授权版本递增、业务系统只激活经发布通道送达的契约、版本不一致拒绝服务）。机制细节（签名、端点）可留在技术设计文档。

**阻断 2: 平台侧技术栈未决，阶段一骨架（0B-1）与阶段四无法开工**

- 位置: §4.3、§4.5、§7.1 阶段一/四、§9.11.2、§10.3.1
- 原文: §4.3 列出"身份与账号✅必建"等自建项；§10.3.1「公司即租户 + PostgreSQL RLS 隔离」；§9.11.2 审计「追加写 + 哈希链 或 WORM 存储；不得为可随意 UPDATE/DELETE 的普通表」
- 问题: PRD 只明确业务数据侧用 PostgreSQL RLS，但 (1) KVVI 平台自身的账号、会话、审计、授权版本存什么库，全文没有；(2) "普通表"暗示有库但不指名——审计的 WORM/哈希链落在哪种存储上是阶段四的前置；(3) 业务系统独立部署后，是每个系统一个 PG 实例/库，还是共享集群按租户 RLS？两种选择直接决定 0B-1 的 Docker 骨架与 §9.4 公钥分发拓扑；(4) KVVI-Builder 的验证器是「Python 17 模块 + Node 13 模块」（§5.3），而产品是 TypeScript——验证管道用哪个引擎、Python 是否成为构建/部署依赖，未定。阶段一就要做 Docker 一键启动，这些不是能拖到阶段四再定的。
- 建议: 补一节"平台技术栈基线"：平台数据库选型、业务系统数据库存放拓扑（每系统独立库 or 共享集群）、审计存储形态、验证器引擎取舍（建议 Node 为运行时权威、Python 仅作交叉校验，或反之——但必须写明）。这些属技术选型而非实现细节，PRD 的"做什么/不做什么"边界管不到数据库是什么，但没有它骨架任务无的放矢。

Hmm wait - is "数据库选型" PRD's job? The PRD's own boundary (§0.5) says 怎么做属技术设计文档. Is DB selection "怎么做"? For a platform, the deployment topology (per-system DB vs shared) is architecture (product structure affecting isolation promises); the brand of DB is tech selection. RLS is already named (PG) for business data. I'll argue: 拓扑与"哪些数据落在哪个存储"是架构，具体选型可下放. Keep the item but scope it: 拓扑与存储归属必须 PRD 级定；引擎与具体选型可技术设计文档定. Actually for 开工 purposes, the implementer needs SOMETHING decided. I'll frame 建议 as: PRD 至少定义数据存放拓扑与权威存储清单；具体产品选型可授权技术设计文档.

**阻断 3? or 重要: 资产归并与仓库策略**

Actually let me reconsider whether to make it blocking. The first thing to write (Q1): 接入 MetaSchema + 验证器、项目骨架。Before that must decide: 这些资产的权威来源与落库方式（vendored copy? submodule? 单一仓库合并？）——目前它们位于另一个项目的 `.worktrees/` 路径下（§5.3），worktree 通常是临时分支工作区，不是稳定发布物。引用一个 worktree 路径作为"唯一真理源"的所在地，本身就与 §5.3 的单一真理源原则相悖。这是 day-1 缺口，但任何一个临时决定都能让工作继续——风险是后续漂移。I'll make it 阻断 but small, or 重要第一。Hmm. The review instruction says blocking = 不修不能开工。Strictly, copying files lets you start. But the "权威位置" decision is PRD-level (single truth source is a product principle here). I'll put it as 阻断 with narrow scope: 不是大改，是开工前必须写明的两句话。Actually you know what - I think it's cleaner: 阻断 items = 1 (architecture/publish), 2 (stack/topology). Item 3 (assets) I'll class 重要 but flag it as day-1. No wait... The question 1 explicitly asks "写它之前必须先确定哪些、而 PRD 没有确定的事" - assets location is exactly that. But "必须先确定" ≠ "PRD 必须写" - could be a kickoff decision. The verdict section asks for 必须开工前补齐项. I'll include assets + staffing? Let me finalize:

阻断:
1. 业务系统部署单元与发布/契约生效架构未定义 (covers Q4b, Q5, Q7)
2. 平台数据存储拓扑未定义 (covers Q6 partially) — blocks 0B-1 skeleton in week 1-2.

重要:
3. MetaSchema/验证器资产的权威落库位置（day-1，worktree 路径引用问题）
4. 各阶段交付物是描述不是验收条件（含逐阶段表）+ 验收标准实质在外部任务卡（依赖外部资料）
5. 人力假设缺失 → 30-31 周不可承诺（Q9 的拒排期理由也在这）
6. 访客/外部填写者的访问模型缺失（匿名表单的安全面）
7. 契约客户端↔业务系统的版本协商 — no wait, folded into 1. Skip.
7. Python/Node 双引擎的运行时取舍 — folded into 2. Skip separate.

建议:
8. 阶段四 7 周装载过满，建议拆分或设出口准则（或这是重要？）— phase 4 overload. Could be 建议.
9. DSH fork 升级策略只有"锁定版本+建立评估流程"，建议在阶段一产出补丁清单（品牌替换已做 commit a9edf55，后续改造面大）— 建议.
10. Q11 未定交付方式 — PRD 自己说不阻塞，agree, no item.

Q8's three pits need a home. I'll create a 重要 item? No—pits are risks, and the format has no risk section. I can weave: pit 1 (DSH fork multi-user retrofit) → 建议 item 9; pit 2 (enforcement point/A6 invariant algorithm) → part of 阻断 1's problem text; pit 3 (phase 4 overload + staffing) → 重要 5. Good, that covers Q8 implicitly. Actually let me explicitly name three pits somewhere so the answer to Q8 is findable. Maybe in 总体判断? No, 60-char limit. I could put a compact "最先撞上的三个坑" as a 建议-level item titled 实现阶段三大风险点. That works within format (同结构: 位置/原文/问题/建议). Let me do that as one 建议 item listing three pits with citations. Hmm, but pits overlap with blocking items; that's fine, they're the risk view of the same gaps plus DSH fork.

Actually, cleaner: 建议 item "阶段四范围与工期" and 建议 item "DSH fork 维护策略" + mention A6 invariant algorithm inside 阻断1? The A6 invariant check (§9.8.1) is a machine check at publish time: "可查看该聚合结果的用户同样可访问构成该聚合的个体数据" - computing this requires solving permission-set equivalence/containment over five-tier scopes + field policies + roles. Non-trivial, no spec, went to tech design (地基不变量判定条件). It's a risk that this check proves hard and slips. Mention in the pits item.

Let me also double check the visitor claim: §3 role table: 访客/外部填写者 | 外部 | 仅表单 | 填表，无 Agent 交互. §9.7 mentions 外部访客 writing into 业务数据文本 via forms - "外部访客或低权限员工可把指令写进业务数据文本（备注…）" and 负向测试 "访客在备注中写入指令". So visitors DO submit forms with free text. But how does a visitor access a form? Anonymous public link? Nothing in identity layer section (§3.2 self-built accounts are for employees; §3.4 IdP for employees). The anonymous access model, anti-abuse (§9.11.3 is per-account rate limits - 按账号与工具维度; visitors have no account!), form publish/share semantics - all absent. And is 访客 in 首版 scope? 0C tasks don't mention public forms; but role table + injection tests assume visitors exist in首版? The injection negative tests (§9.7.3) are首版-relevant (red lines are). If visitors exist at launch, their access path is a security surface with zero definition. Good 重要 finding. If not in首版, PRD should say so. Either way, gap.

Also check: 会话持久化 reused from DSH (§4.3). With multi-user retrofit, session storage becomes multi-tenant. Fine, folded in pit.

One more possible item: 阶段三 "五个搭建 Skill" 的工程化路径（prompt/blueprint loop 0D-1 AI 蓝图闭环）— acceptance "可用搭建舱". This is covered by item 4 (acceptance) and external specs. OK.

Also: §7.1 阶段一 says "接入 13 份 MetaSchema 与双引擎验证器" — from KVVI-Builder. And 0B-1 is KVVI-Builder's skeleton task — does the KVVI-Agent product reuse KVVI-Builder's repo/skeleton, or is there one repo? §0.2 says merged as assets; M3 merged roadmaps. But physically: one repo or two? DSH fork at vendor/dsh (in KVVI-Agent repo? "已提交至 vendor/dsh 的 kvvi 分支" — vendor/dsh suggests inside some repo). KVVI-Builder at ~/Documents/KVVI-Builder. The product's repo layout is undefined. Fold into item 3 (重要): 仓库与资产布局.

Now per-phase deliverable verdict (Q3) - table for item 4:

- 阶段一「可构建、可启动、可校验的自有基座」: 半可验收——构建/启动可机器判定，"可校验"需指明验证器跑哪份测试集。最接近验收条件的一项。
- 阶段二「KVVI 自有 Web 外壳」: 纯描述；§7.3 给了"仅品牌替换+persona 注入"的范围约束，可辅以"品牌元素检查清单"（§10.2 提到建立检查清单）勉强可判。
- 阶段三「可用搭建舱」: 纯描述——"可用"无定义；真实验收在 0A-13/0C-2/0C-7/0D-1 任务卡（外部）。
- 阶段四「双模式可隔离运行」: 纯描述；但 0B-2~0B-10 各自可能有验收（外部）。
- 阶段五「Agent 可安全操作独立部署系统」: 描述，但 §9 的负向测试清单（§9.2 差分、§9.3.1、§9.4.1/9.4.2、§9.7.3）给了实质验收钩子——是七个阶段里验收锚点最多的。
- 阶段六「可交付员工使用的系统」: 纯描述；验收实质寄托于 0C-6 报货样例与 0D-2 黄金样例（外部）。
- 阶段七「可交付客户的产品」: 纯描述；§7.4.3 列出交付包+手册+验收证据包三项实物。

And red line 8 (验收以测试为准) requires test inventories per phase; PRD 只有 §9 的负向测试与 §7.1 的任务 ID 引用. So the fix: PRD 应为每阶段列出验收测试锚点（或显式声明"以 KVVI-Builder 任务卡验收标准为准"并保证其可得）。Mark 依赖外部资料无法核实 for the task cards' content.

Q9 rejection reason: "阶段四+阶段五 13 周集中了全部红线落地与 9 项 0B 安全地基任务，但其验收标准在外部文档、平台栈未定、且 PRD 无人力假设——在补齐这三项前，30-31 周的总排期无法核算，我拒绝签字。" Put in 重要 item 5.

Final verdict (Q10): 不够格整体开工？My honest judgment: 第 1-2 周（阶段一）可以开工——DSH 已构建、验证器已实测、任务具体。但作为"明天开工、按 30-31 周交付"的整体承诺，不够格。必须开工前补齐: (1) 业务系统部署单元与发布通道架构声明（阻断1，最迟阶段三设计前，即第 3-4 周前——actually phase 2 is weeks 3-4; phase 3 design needs it by ~week 5; but I'd say before freezing PRD as 可冻结 since it claims "可冻结" status! The PRD header says 状态：设计稿（三轮评审后修订，可冻结）. If it's to be frozen, these must go in now.); (2) 平台存储拓扑基线（阻断2，阶段一骨架需要）; (3) 资产落库与仓库策略（day-1 决定，两句话）. And before committing schedule: (4) 人力假设; (5) 阶段验收锚点声明. Good.

总体判断 draft: 「契约与安全约束已达可实现的精度，但部署架构、平台栈、验收锚点三处未闭合：阶段一可开工，整体排期不可承诺，PRD 尚不可冻结。」~58 chars? Let me count roughly: 契约与安全约束已达可实现的精度(15)，但部署架构、平台栈、验收锚点三处未闭合(20)：阶段一可开工(7)，整体排期不可承诺(9)，PRD尚不可冻结(8)。 ≈ 59. OK, near limit; trim: 「契约与安全约束足够细，但部署架构、平台技术栈、阶段验收三处未闭合：阶段一可动手，整体排期不可承诺。」 ~48 chars. Good.

Now write the items with tight citations. Also 覆盖范围自述: list checked-and-OK areas + external-unverifiable list.

Checked OK (don't fabricate):
- §9.3.1/§9.9.2 租户两层表述一致性 — v2.4 已修，模型层不含租户、服务端注入，与 §9.4 令牌字段禁令一致，未发现残留矛盾。
- §9.4.2 令牌失效三触发 + 撤销查询必选（账号停用/会话结束）+ 降级拒绝 — 约束级足够。
- §9.6.4.1 R1-R3 封闭清单 — 封闭、可测。
- §3.3 离职交接含草稿接管人（L6）闭环 — 完整。
- §2.6 会话绑定（模式/公司/系统创建时绑定）与 §9.9.3 一致。
- §9.7 注入防护的诚实立场 + 执行前确认机制 — PRD 级充分。
- §2.5.1 五档封闭 + §9.8.1 不变量"违反即拒绝" — 机器可校验的前提已立（算法难度是风险不是矛盾）。
- §7.4 裁剪与条件性红线（5/6/7）逻辑自洽；§7.4.4 后果披露诚实。
- M1/M2 格式与金额决策明确；§5.5 十类字段封闭（含 money）。
- Q4/Q12 与 M4 三层级（账号/公司/系统）已分清，未发现把租户当多系统答案的残留。

External unverifiable:
- 0B-1~0B-10、0C-1~0C-8、0D-1~0D-8 任务卡的验收标准（KVVI-Builder PRD v1.11）
- 13 份 MetaSchema 的内容与冻结哈希；双引擎验证器"6 测试 OK"的实测声明
- DSH 仓库的插件机制、Preset 会话级快照语义、无账号体系的实测结论
- 组件注册表（0A-6）白名单内容
- 评审/汇总.md 系列文件

Now, one more scan for missed blockers... 

- 模型路由/脱敏执行点: §9.11.1 requires 发送前最小化与脱敏; 脱敏执行点转入技术设计 (§0.5). PRD-level OK.
- 组织关系默认补齐 (Q16) — clear.
- 单号唯一 (0B-9) — external.
- 页面编译器技术 (Vue prototype exists) — external/tech-design.
- 品牌替换 — done initially, checklist planned. OK.
- Docker 一键启动 0B-1 — external spec, but topology decision needed (item 2). OK.
- 会话绑定业务系统 (L5) — defined in §2.6. OK.
- 多系统数据结构保留 (Q12) — clear.
- 本地化部署约束 (Q7) — identity self-contained, contract transport configurable — stated. OK.
- 审计读权限独立 (§9.11.2) — stated. OK.
- 扩展通道安全 (§9.10) — owner-only install, dynamic plugins disabled in prod — stated. OK.

I think three more candidate 建议:
- 阶段四拆分的建议
- DSH fork 补丁管理（upstream alpha, 12k files; 建议阶段一产出改造点清单与升级冻结策略已经说了"锁定版本，建立升级评估流程" — so partial; suggest patch inventory）
- Q11 建议在阶段五前确定（影响契约传输拓扑?）— PRD says not blocking phases 1-6; delivery method affects publish channel topology (部署包交付 vs 托管 affects where publish channel lives). Hmm! Actually Q11 interacts with 阻断1: if 托管式, publish is central; if 部署包, publish happens on-prem. But in all three cases, one customer = one instance = KVVI + business systems in one environment. So publish channel is always intra-environment. Fine—no extra item.

Let me also reconsider: is there a contradiction I should catch? Quick scan for internal inconsistency:
- §9.6.2 清单 includes "系统创建：新建系统时的初始权限配置" needing approval; §9.6.3 "新建同样走通道". Consistent.
- Q9 says 普通口径修改不需要审批, exception noted. Consistent with §9.6.2 聚合口径 row (only 可识别个人粒度). Consistent.
- §3.1 搭建者配置员工业务权限 within owner's range; §9.6.7 不得把自己纳入. Consistent.
- 阶段六 5 周 vs §7.1 header says 24-28 周 = 5 weeks. Consistent. 总计 30-31: weeks 29-31 phase 7 = 3 weeks. 2+2+6+7+6+5+3=31. OK consistent.
- §7.2.2 warning banner about stale table — good.
- 阶段五 18-23 = 6 周: 0C-1 + 0C-8 + 契约读写 + 红线1-4 + 0D-4. Heavy too but phase 4 heavier.

Alright. One more possible 重要: 授权版本 (§9.4) 与发布通道的联动未定义 — folded in 阻断1 (iii). OK.

Also: 阶段二交付物 "KVVI 自有 Web 外壳" with Q5 reuse — fine.

Format compliance: each item needs 位置/原文/问题/建议. Keep 原文 quotes short. Write in Chinese. Be direct, implementer voice.

Count of items:
阻断: 2
- 1. 业务系统部署单元与发布/契约生效架构（含 §9.2 执行点归属、版本协商）
- 2. 平台与业务系统的数据存储拓扑未定（0B-1 骨架与阶段四的前置）

重要: 4
- 3. MetaSchema/验证器资产的权威位置与仓库归并策略（day-1）
- 4. 阶段交付物是描述而非验收条件（逐阶段表；真实验收在外部任务卡——依赖外部资料）
- 5. 无人力假设，30-31 周排期不可承诺（附拒签理由）
- 6. 访客/外部填写者访问模型缺失（匿名表单面）

建议: 3
- 7. 阶段四 7 周装载过满，建议预设拆分点/出口准则
- 8. DSH fork 的补丁清单与升级冻结流程宜在阶段一产出
- 9. 实现阶段三大风险点提示（其实和上面重复……）— hmm. If I do 9 as "三大坑" it duplicates 1/2/5. Better: fold DSH fork risk into 8, and put the "three pits" explicitly in 建议 as one item that answers Q8 crisply: (a) DSH 多用户改造面, (b) 唯一执行点/A6 不变量算法, (c) 阶段四工期. But that duplicates... The prompt explicitly asks Q8 and Q9; the output format constrains structure. I think it's acceptable to answer Q8 inside 建议 item "实现阶段最可能先撞上的三个坑" — even if overlapping, it directly answers. And Q9 inside 重要 5. Let me do that: 建议 item 7 = 三大坑（引用位置），item 8 = 阶段四拆分建议? No—阶段四 overload IS pit (c). Merge: 建议 7 = 三个坑与阶段四缓解建议. 建议 8 = DSH fork 补丁管理. Two 建议 items, clean.

Wait, also need to answer Q2 explicitly ("哪一阶段的描述不足以让工程师动手？给出具体缺什么") — answered in 重要 4's table (phases 3/4/6 worst, phase 5 has anchors but depends on 阻断1). And Q1 answered in 阻断 2 + 重要 3 (first module = 阶段一骨架/验证器接入; missing decisions). I'll make sure each item's 问题 text explicitly answers its mapped question. Maybe add a tiny mapping note? No, keep clean; the content answers them.

Also should I mention: 阶段一 "接入双引擎验证器" 缺"验证器跑在哪"（CI? 搭建时工具调用? 发布通道?）— §5.6 lists 调用双引擎验证器 as builder tool; §9.1 地基不变量检查纳入产出物验证管道. So validator runs (a) as builder-side tool and (b) in publish pipeline. Two integration points; phase 1 just needs it runnable in repo. Fine, fold into 重要 3.

Draft the final answer now. Keep it tight but complete. Use the exact format with ## 阻断 / ## 重要 / ## 建议 / ## 覆盖范围自述.

For 重要 4's per-phase table, make it compact.

Length: this will be long-ish but the task demands specificity. Aim for a thorough but non-bloated review.

Let me write it.