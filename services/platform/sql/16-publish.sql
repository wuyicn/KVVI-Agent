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
