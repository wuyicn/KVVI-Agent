-- 26-record-workflow-version.sql —— 记录**钉住**它进入流程时的那一版流程。
--
-- ── 为什么要有这一列 ────────────────────────────────────────────────────
--
-- 氚云的流程介绍里有一条明确的不变量：
--
--     「流程修改**仅对新提交数据生效**，已有数据维持原流转规则。」
--
-- 我们此前没有这一条：发布一版新流程，**在途记录立刻改走新流程**。
-- 试点上已经看得到这个形状 —— 11 条老记录停在 `draft`，而新记录从
-- `not_followed` 起；一次发布就让在途的那几条跳到了新版流程上，
-- 而它们连自己当前那个状态在新版里还存不存在都没人问过。
--
-- 「发布」这个动作的语义是**面向未来**的：它改的是「下一条记录怎么走」，
-- 不是「已经在走的记录怎么走」。已经在走的那些，靠的是它们**开始时**的那一版。
--
-- ── 语义 ────────────────────────────────────────────────────────────────
--
--   workflow_version IS NULL  → 这条记录出生在「版本钉住」这件事之前
--                                （或它所属的系统没有流程）。运行时按**当前版**走，
--                                这是尽量接近原意的重建，不是一条规则。
--   workflow_version = N      → 走 `published_contracts` 里 workflow-spec 的第 N 版。
--
-- 已发布的历史版本一直留着（契约是追加的，从不覆盖），所以第 N 版**读得回来** ——
-- 这正是这一列能成立的前提。若哪一天历史版本会被清理，这一列就同时失效。
--
-- 不加外键：`published_contracts` 的主键是 (company_id, contract_type, asset_id, version)，
-- 而记录里只存版本号。加一条复合外键会把「同一公司同一系统的流程版本」这件事
-- 绑死在表结构上，而运行时要的那一版由 `contracts.mjs` 按同样的键去查 ——
-- 查不到就是查不到，会在调用点报出来（KVVI_WORKFLOW_VERSION_MISSING），
-- 比一条静默的 NULL 强。

ALTER TABLE business_records ADD COLUMN IF NOT EXISTS workflow_version integer;

-- 运行时要按 (记录 → 版本) 这一条路径取契约，而查的是主键
-- (company_id, contract_type, asset_id, version)。这里只加记录侧的索引就够：
-- 事务里先按 record_id 取记录，再按版本取契约。
COMMENT ON COLUMN business_records.workflow_version IS
  '该记录进入流程时钉住的 workflow-spec 版本；NULL = 钉住机制之前创建的记录';
