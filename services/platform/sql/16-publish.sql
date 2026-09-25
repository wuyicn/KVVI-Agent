-- KVVI 发布通道（PRD §9.6.3、§9.6.6）
--
-- ── 它堵的是什么 ────────────────────────────────────────────────────────
--
-- §9.6.3 的原话：搭建者绕过发布、直接改 MetaSchema 存储，
-- 使**未审批的权限策略**生效 —— 此时 §9.2 的唯一执行点会**忠实执行被篡改的策略**，
-- 审批形同虚设。
--
-- 所以「发布」不是一次部署动作，而是**业务权限策略唯一的生效通道**：
--
--     差异报告（§9.6.6） → 所有者审批（§9.6.1） → 发布
--
-- 跳过任何一环的直写都必须被拒。**这三步的顺序本身是设计的一部分**：
-- 先出报告是为了让审批人知道自己在批什么 —— 没有报告就审批，
-- 批的是一个「不知道会改什么」的东西。

CREATE TABLE IF NOT EXISTS publish_drafts (
  draft_id        uuid PRIMARY KEY,
  company_id      uuid NOT NULL REFERENCES companies(company_id),
  -- 提交人。与审批人必须是**不同的人**（§9.6.4.1：安全敏感变更不得自批）
  proposer_user_id uuid NOT NULL REFERENCES users(user_id),
  status          text NOT NULL CHECK (status IN ('DRAFT', 'AWAITING_APPROVAL',
                                                  'APPROVED', 'REJECTED', 'PUBLISHED')),
  -- 变更内容的摘要。审批**绑定**到它 —— 批的是「这一份」，不是「这类改动」
  change_digest   text NOT NULL,
  -- 差异报告（§9.6.6）。**没有它不得进入审批**。
  diff_report     jsonb,
  -- §9.8.1 聚合差分不变量的判定结果。违反即**拒绝发布，无审批放行路径**。
  invariant       jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  approved_by     uuid REFERENCES users(user_id),
  approved_at     timestamptz,
  approval_opinion text,
  published_at    timestamptz,
  reject_reason   text
);

CREATE INDEX IF NOT EXISTS publish_drafts_by_company
  ON publish_drafts (company_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS publish_drafts_one_open
  ON publish_drafts (company_id, change_digest)
  WHERE status IN ('DRAFT', 'AWAITING_APPROVAL');

-- 发布记录：每一次真正生效的发布都在这里。**只增不改**。
CREATE TABLE IF NOT EXISTS publish_records (
  record_id     bigserial PRIMARY KEY,
  draft_id      uuid NOT NULL REFERENCES publish_drafts(draft_id),
  company_id    uuid NOT NULL,
  change_digest text NOT NULL,
  approved_by   uuid NOT NULL,
  published_by  uuid NOT NULL,
  at            timestamptz NOT NULL DEFAULT now(),
  -- 发布时**重算**的差异报告摘要。与审批时不一致 = 批的不是这一份。
  diff_digest   text NOT NULL
);

-- 已发布业务系统。
--
-- ── 为什么要有这张表 ──────────────────────────────────────────────────────
--
-- 发布通道此前只记「发布动作」本身（草案 → 审批 → 发布记录），
-- 而**没有任何地方记「发布的是哪个业务系统」**。于是两件事都做不成：
--   1. 工作台的「我的系统」列不出东西 —— 不是缺一个端点，是没有这个事实；
--   2. 待办面板说不出「哪张单属于哪个系统」。
--
-- 这张表补的就是那条事实。它由 `publishDraft` 在发布成功时**同事务**写入，
-- 所以「已发布」这件事与它**同生共死**：不会出现「系统在列表里但没发布记录」
-- 或反过来。
--
-- ⚠️ 它记的是**系统的存在与代号**，不是系统的内容。
-- 系统自身的定义（业务模型、表单、流程）落在契约里，两者的读取接口是分开的 ——
-- 把内容也塞进来会让这张表变成第二份契约存储，而契约只能有一份。
CREATE TABLE IF NOT EXISTS systems (
  system_id        uuid PRIMARY KEY,
  company_id       uuid NOT NULL REFERENCES companies(company_id),
  -- 系统代号。同公司内唯一 —— 员工看到的就是它。
  asset_id         text NOT NULL,
  name             text NOT NULL,
  -- 业务模型的代号。待办与聚合要按它去查契约。
  schema_code      text NOT NULL,
  -- 生效的那次发布。删除发布记录时本表跟着走（外键），
  -- 因为「一个没有发布来源的系统」不是合法状态。
  published_record bigint NOT NULL REFERENCES publish_records(record_id),
  published_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, asset_id)
);

CREATE INDEX IF NOT EXISTS systems_by_company ON systems (company_id);

-- 已发布契约的**内容**。
--
-- ── 为什么需要它（这是四个功能共同的坑）────────────────────────────────────
--
-- 发布通道此前只记「发布了」这件事（草案、审批、发布记录、已发布系统名），
-- 而**契约内容本身没有被任何服务持有**。于是四件事同时做不成：
--   1. 工作台列得出系统名，但**打不开系统界面**（界面要 view-schema）；
--   2. 待办说不清「哪些单在我这一步」（要读 workflow-spec 的状态机）；
--   3. 聚合口径列不出来（口径随 business-schema 走）；
--   4. 员工客户端登录后**同步不到系统定义**（B 路线的断点）。
--
-- 不是四个问题，是同一个：**契约内容没有落点**。
--
-- ── 这张表刻意不做什么 ────────────────────────────────────────────────────
--
-- 它**不校验**契约是否合法 —— 那是官方验证器（tools/meta-schema）的事，
-- 在本服务里再判一遍就是第二份判据，而两份判据迟早分叉。
-- 它只做两件事：**原样存**（带内容指纹）与**按版本读**。
--
-- 它**不合并版本**。每次发布产生一行新版本，旧行保留 ——
-- §4.1.1 五要求「每次发布产生新的契约版本，版本号单调递增」，
-- 覆盖式写入会让「回滚」与「版本不符即拒绝」两条都失去依据。
CREATE TABLE IF NOT EXISTS published_contracts (
  contract_id   bigserial PRIMARY KEY,
  company_id    uuid NOT NULL REFERENCES companies(company_id),
  -- 契约类型。用契约自己的 `contract_version` 前缀，不另发明一套枚举。
  contract_type text NOT NULL,
  -- 系统代号。与 systems.asset_id 对齐；非系统级契约（如平台级配置）可为空。
  asset_id      text,
  -- 版本：同一 (公司, 类型, 代号) 内单调递增。
  version       integer NOT NULL,
  -- 内容指纹。**同版本不同内容 = 有人改过**，读取时据此拒绝。
  digest        text NOT NULL,
  content       jsonb NOT NULL,
  -- 它是哪一次发布带进来的。删除发布记录时本行跟着走。
  published_record bigint NOT NULL REFERENCES publish_records(record_id),
  published_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, contract_type, asset_id, version)
);

CREATE INDEX IF NOT EXISTS published_contracts_latest
  ON published_contracts (company_id, contract_type, asset_id, version DESC);
