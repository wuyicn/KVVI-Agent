-- 会话消息数据的保留策略与骨架（N4，PRD §4.6.1、§4.6.2）
--
-- ── 两层东西，寿命不同 ──────────────────────────────────────────────────
--
--   会话**消息体**（对话正文、工具结果明细）→ 运行时进程持久化，**有期限**
--   会话**骨架**（标识、时间、绑定、工具名、结果摘要）→ 本表，**与审计同寿命**
--
-- 「删内容留骨架」是这套设计的全部：删掉正文与明细之后，
-- 「谁在什么时候调用了什么工具、拿到多少条」仍然可查，
-- 而具体内容已经被时间收敛掉了。
--
-- ⚠️ **骨架必须留下**，否则删除作业会在审计链上开一个断点 ——
-- 审计记录的是「谁在何时做了什么」，它引用的会话标识不能因为消息体被删而失效。

CREATE TABLE IF NOT EXISTS retention_policies (
  company_id            uuid PRIMARY KEY REFERENCES companies(company_id),
  -- L1：工具调用结果（明细）—— 最敏感且一次性，默认最短
  tool_result_days      integer NOT NULL DEFAULT 30,
  -- L2：对话正文（可能含用户粘贴的业务数据）
  message_days          integer NOT NULL DEFAULT 90,
  updated_by            uuid REFERENCES users(user_id),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  default_tool_result_days integer NOT NULL DEFAULT 30,
  default_message_days     integer NOT NULL DEFAULT 90,
  -- 上限由代码校验；这里再兜一层，防止绕过代码直写
  CHECK (tool_result_days BETWEEN 1 AND 365),
  CHECK (message_days BETWEEN 1 AND 1825)
);

-- 会话骨架：**不随消息体删除**。与审计同寿命。
CREATE TABLE IF NOT EXISTS session_skeletons (
  session_id     uuid PRIMARY KEY,
  company_id     uuid NOT NULL,
  user_id        uuid NOT NULL,
  gateway        text,
  started_at     timestamptz NOT NULL,
  ended_at       timestamptz,
  -- 按工具聚合的调用事实：工具名 + 调用次数 + 最后一次结果摘要。
  -- **不含任何明细内容** —— 有明细就不是骨架了。
  tool_calls     jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- 到期时间由策略算出，删除作业据此执行
  message_expires_at  timestamptz,
  tool_expires_at     timestamptz,
  body_purged_at      timestamptz,
  tool_purged_at      timestamptz
);

CREATE INDEX IF NOT EXISTS skeletons_by_expiry
  ON session_skeletons (message_expires_at) WHERE body_purged_at IS NULL;
