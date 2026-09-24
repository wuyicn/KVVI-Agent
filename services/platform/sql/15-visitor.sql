-- KVVI 访客路径（PRD §3.5）
--
-- ── 为什么访客相关的东西放在**平台库** ──────────────────────────────────
--
-- §3.5「吊销状态的传播」把吊销状态归为**平台数据**（§4.6.1），
-- 与撤销状态同一机制。业务系统独立部署，靠查询或短 TTL 缓存取得它 ——
-- 所以它必须与平台库里的会话/令牌撤销在同一个地方，才能有同一套
-- 「在线优先、离线降级」的语义（§9.4.4）。
--
-- ── 链接不是账号 ────────────────────────────────────────────────────────
--
-- 访客**没有账号**（§3.5.1），不进入账号体系、不占账号配额。
-- 所以下面这张表**没有** user_id 指向访客：有的只是 `issuer_user_id` ——
-- 链接的入口有主，而使用者可以匿名。这正是 §3.5.4 说的「受限落地形式」：
-- **保证每一次提交都能定位到为其提供入口的账号**，
-- **不承诺区分访客个体**。

CREATE TABLE IF NOT EXISTS visitor_links (
  link_id                uuid PRIMARY KEY,
  -- 存摘要不存原文：与委派令牌同一纪律（服务端只该能验证它，不该能重建它）
  token_digest           text NOT NULL UNIQUE,
  -- 防重放：不可预测随机量 + 签发时间（§3.5.1「链接签名的最小安全属性」）
  nonce                  text NOT NULL,

  -- ── 五项绑定 + 行范围（§3.5.1 v2.15/v2.16）──
  -- 由签发人的权限**派生**，不得由签发人自行扩大。
  company_id             uuid NOT NULL,
  schema_code            text NOT NULL,          -- 业务系统
  form_code              text NOT NULL,          -- 表单
  allowed_fields         text[] NOT NULL,        -- 允许写入的字段集
  allowed_actions        text[] NOT NULL,        -- 允许的动作
  -- 签发时确定的行范围约束。提交须**同时**满足它与
  -- **签发人提交时刻的有效权限** —— 两条都要，缺一条就是漏洞。
  row_scope              jsonb NOT NULL,

  -- ── 签发人：行范围与归属都以**他**为主体解释（v2.16 终审阻断 T1）──
  issuer_user_id         uuid NOT NULL REFERENCES users(user_id),
  issuer_dept_id         uuid,
  issuer_shop_id         uuid,
  -- 签发时的授权版本。签发人权限变了，链接按 §3.5.1 失效。
  issuer_authz_version   integer NOT NULL,

  one_time               boolean NOT NULL DEFAULT true,
  max_submissions        integer NOT NULL DEFAULT 1,
  submissions            integer NOT NULL DEFAULT 0,

  issued_at              timestamptz NOT NULL DEFAULT now(),
  expires_at             timestamptz NOT NULL,
  revoked_at             timestamptz,
  revoked_by             uuid,
  revoked_reason         text,
  used_at                timestamptz
);

CREATE INDEX IF NOT EXISTS visitor_links_by_issuer
  ON visitor_links (company_id, issuer_user_id);
CREATE INDEX IF NOT EXISTS visitor_links_live
  ON visitor_links (expires_at) WHERE revoked_at IS NULL;

-- ── 事件：生成 / 吊销 / 每次提交 均须留痕（§3.5.1）──────────────────
--
-- 「每次提交」单独一类，是因为 §3.5.4 要的是**提交记录完整可查**：
-- 同一链接被转发给多个访客时，多条提交记录都指向同一签发人 ——
-- 这正是「入口有主、个体可匿名」这条设计的可观测形式。
CREATE TABLE IF NOT EXISTS visitor_link_events (
  event_id       bigserial PRIMARY KEY,
  link_id        uuid NOT NULL,
  company_id     uuid NOT NULL,
  issuer_user_id uuid NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('ISSUED', 'REVOKED', 'SUBMITTED', 'REJECTED')),
  -- 来源只是**辅助信号**（§3.5.2 明说 NAT/代理下会共享、设备指纹可伪造）
  source_ip      text,
  at             timestamptz NOT NULL DEFAULT now(),
  detail         jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS visitor_events_by_link ON visitor_link_events (link_id, at);
CREATE INDEX IF NOT EXISTS visitor_events_by_company ON visitor_link_events (company_id, at);
CREATE INDEX IF NOT EXISTS visitor_events_by_source ON visitor_link_events (source_ip, at);
